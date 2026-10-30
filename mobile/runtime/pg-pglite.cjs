/**
 * PGlite-backed stand-in for node-postgres (CommonJS).
 *
 * The mobile build runs the whole Next.js server inside one nodejs-mobile
 * process. There is no PostgreSQL server on an Android phone, so the database
 * is PGlite — PostgreSQL compiled to WebAssembly, running in this same process.
 *
 * Why not PGlite's own TCP listener (`@electric-sql/pglite-socket`)? It
 * serializes statements through one query queue, and once a connection is
 * inside a transaction only that connection's statements are taken from the
 * queue. This application opens a second pooled connection while the first is
 * mid-transaction — the schema bootstrap's advisory lock, the asset collector,
 * the generation runner, every `withTransaction` racing a plain `pool.query` —
 * so the queue head blocks on a statement that cannot run until the transaction
 * ends, and the transaction cannot end until the queue drains. It deadlocks.
 *
 * So this module implements the slice of the `pg` API this repository uses,
 * directly on PGlite, keeping node-postgres' semantics:
 *
 *   - `query(text, params)` -> `{ rows, rowCount, fields, command, oid }`
 *   - `Pool` with `query`, `connect`, `end`, `on('error')`
 *   - `Client` with `connect`, `query`, `end`, `on('notification'|'error'|'end')`
 *
 * Concurrency: PGlite has exactly one session, so a transaction is a global
 * critical section. `PGlite.transaction()` holds PGlite's internal mutex for
 * the transaction's whole lifetime, which makes every other statement — from
 * any client — wait instead of interleaving. Clients therefore carry no
 * transaction state of their own: whoever holds that lock is the transaction's
 * session, and a `BEGIN` issued by another client queues behind it exactly as
 * it would against a server with one backend. That is also what makes the
 * schema bootstrap's *session* advisory lock work, since the "connection" that
 * holds it is really this lock.
 *
 * Type mapping matches node-postgres rather than PGlite's defaults: `int8`
 * arrives as a string (JavaScript numbers lose precision past 2^53), `numeric`
 * as a string, `bytea` as a Buffer.
 */
'use strict';

/** node-postgres' own defaults for the types this application reads. */
const TYPE_PARSERS = {
  20: (value) => value, // int8 -> string, as node-postgres does
  1700: (value) => value, // numeric -> string
  17: (value) =>
    value.startsWith('\\x') ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'utf8'), // bytea
};

/** The verbs node-postgres reports in `result.command`. */
const ROW_COUNT_COMMANDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'FETCH',
  'SHOW',
  'MOVE',
  'COPY',
]);

/**
 * The leading keyword of a statement, skipping whitespace and comments — what
 * node-postgres reads to fill `result.command`. Callers here compare it against
 * 'INSERT'/'UPDATE'/'DELETE' or ignore it.
 */
function commandOf(text) {
  let rest = text;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      rest = newline === -1 ? '' : rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end === -1 ? '' : rest.slice(end + 2);
      continue;
    }
    break;
  }
  return (/^[A-Za-z]+/.exec(rest)?.[0] ?? 'SELECT').toUpperCase();
}

function normalise(text, values) {
  if (typeof text === 'string') return { text, values: values ?? [] };
  return { text: text.text, values: values ?? text.values ?? [] };
}

/** PGlite's result, reshaped the way node-postgres callers read it. */
function toResult(rows, fields, command) {
  const mapped = (fields ?? []).map((field, index) => ({
    name: field.name ?? `column${index + 1}`,
    tableID: 0,
    columnID: index + 1,
    dataTypeID: field.dataTypeID ?? 0,
    dataTypeSize: 0,
    dataTypeModifier: 0,
    format: 'text',
  }));
  return {
    command,
    // node-postgres counts returned rows for row-returning statements and
    // affected rows for DML; PGlite does not surface the tag, and every caller
    // here reads `rowCount ?? 0` or compares it to 0, so returned rows are the
    // correct answer for both.
    rowCount: ROW_COUNT_COMMANDS.has(command) ? rows.length : 0,
    oid: 0,
    rows,
    fields: mapped,
  };
}

/** The process's one PGlite instance, opened by the mobile bootstrap. */
let database;

function getDatabase() {
  if (!database) {
    throw new Error(
      'The PGlite database is not open. The mobile bootstrap must call openDatabase() before the server serves a request.',
    );
  }
  return database;
}

/**
 * Open (or return) the process's PGlite instance.
 *
 * `relaxedDurability` skips the fsync per commit: a phone's flash storage turns
 * a course save into a multi-second stall otherwise. The cost is a window of at
 * most the browser's flush interval if the process is killed mid-write.
 */
async function openDatabase(dataDir) {
  if (database) return database;
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite({ dataDir, parsers: TYPE_PARSERS, relaxedDurability: true });
  await db.waitReady;
  database = db;
  return db;
}

async function closeDatabase() {
  const db = database;
  database = undefined;
  if (db) await db.close();
}

/** One session, presented as a node-postgres `Client`. */
class PGliteClient {
  constructor(db) {
    this._db = db;
    this._listeners = new Map();
    this._ended = false;
  }

  async connect() {
    if (this._ended) throw new Error('Client has already been closed');
  }

  on(event, listener) {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event, listener) {
    this._listeners.get(event)?.delete(listener);
    return this;
  }

  off(event, listener) {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
    return this;
  }

  _emit(event, ...args) {
    for (const listener of this._listeners.get(event) ?? []) {
      try {
        listener(...args);
      } catch {
        // A throwing listener must not break the query that emitted it.
      }
    }
  }

  async query(text, values) {
    if (this._ended) throw new Error('Client has already been closed');
    const statement = normalise(text, values);
    const command = commandOf(statement.text);
    // PGlite's errors already carry the PostgreSQL fields (`code`, `detail`,
    // `constraint`, …) that callers branch on, so they propagate unchanged.
    const result = await this._db.query(statement.text, statement.values);
    return toResult(result.rows, result.fields, command);
  }

  async end() {
    if (this._ended) return;
    this._ended = true;
    this._emit('end');
  }

  release() {
    // Present because node-postgres clients from a pool are released rather
    // than ended; there is nothing to hand back here.
  }
}

/**
 * A node-postgres-shaped pool over the one PGlite session.
 *
 * `end()` deliberately does not close the database: several pools exist in one
 * process (the schema boot check, the asset collector, the persistence
 * provider), and PGlite cannot reopen a closed data directory.
 */
class Pool extends PGliteClient {
  constructor(config) {
    super(getDatabase());
    // node-postgres accepts a connection string or a config object. Both are
    // ignored: there is exactly one database, opened from the app's storage.
    void config;
  }

  async connect() {
    const client = new PGliteClient(getDatabase());
    await client.connect();
    return client;
  }

  async end() {}
}

/** node-postgres' `Client`, used by the LISTEN/NOTIFY wakeup bus. */
class Client extends PGliteClient {
  constructor(config) {
    super(getDatabase());
    void config;
  }
}

module.exports = { Pool, Client, openDatabase, closeDatabase, getDatabase, default: { Pool, Client } };
