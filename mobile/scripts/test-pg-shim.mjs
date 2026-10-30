/**
 * Direct test of the PGlite `pg` shim against the real storage package.
 * Cheap: no Next.js build needed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shim = require('../../mobile/runtime/pg-pglite.cjs');

const dataDir = await mkdtemp(path.join(tmpdir(), 'pgt-'));
await shim.openDatabase(path.join(dataDir, 'db'));

const { Pool } = shim;
const pool = new Pool('postgres://pglite@localhost/openmaic');

const storage = await import('../../packages/@openmaic/storage/dist/runtime/pg.js');
const docPg = await import('../../packages/@openmaic/storage/dist/document/pg.js');
const { nodePostgresTransaction } = await import('../../packages/@openmaic/storage/dist/server/reference.js');

console.log('--- schema bootstrap (advisory locks + migrations) ---');
const t0 = Date.now();
await storage.ensureSchema(pool);
await docPg.ensureDocumentSchema(pool);
console.log('schemas ready in', Date.now() - t0, 'ms');

const tables = await pool.query("select tablename from pg_tables where schemaname='public' order by 1");
console.log('tables:', tables.rows.map((r) => r.tablename).join(','));
console.log('rowCount for select:', tables.rowCount, 'command:', tables.command);

console.log('--- transactions ---');
const withTransaction = nodePostgresTransaction(pool);
await withTransaction(async (tx) => {
  await tx.query('create table if not exists smoke(a int, b text)');
  await tx.query('insert into smoke values ($1,$2)', [1, 'one']);
});
const after = await pool.query('select count(*)::int as c from smoke');
console.log('committed rows:', after.rows[0].c);

// rollback
let threw = false;
try {
  await withTransaction(async (tx) => {
    await tx.query('insert into smoke values ($1,$2)', [2, 'two']);
    throw new Error('deliberate rollback');
  });
} catch {
  threw = true;
}
const afterRollback = await pool.query('select count(*)::int as c from smoke');
console.log('threw:', threw, 'rows after rollback:', afterRollback.rows[0].c, '(want 1)');

console.log('--- concurrent transaction vs plain query ---');
const txPromise = withTransaction(async (tx) => {
  await tx.query('insert into smoke values ($1,$2)', [3, 'three']);
  // A plain pool query must not deadlock while this transaction is open.
  const inside = await pool.query('select 1 as x');
  if (inside.rows[0].x !== 1) throw new Error('bad concurrent read');
  await new Promise((r) => setTimeout(r, 200));
});
await txPromise;
const final = await pool.query('select count(*)::int as c from smoke');
console.log('rows after concurrent tx:', final.rows[0].c, '(want 2)');

console.log('--- type mapping ---');
await pool.query('create table if not exists types(i8 bigint, n numeric, by bytea, js jsonb)');
await pool.query('insert into types values ($1,$2,$3,$4)', ['9007199254740993', '3.14', Buffer.from('hi'), { a: 1 }]);
const typed = await pool.query('select * from types');
const row = typed.rows[0];
console.log('int8:', typeof row.i8, row.i8, '| numeric:', typeof row.n, row.n, '| bytea:', Buffer.isBuffer(row.by), '| jsonb:', JSON.stringify(row.js));

await pool.end();
await shim.closeDatabase();
await rm(dataDir, { recursive: true, force: true });
console.log('PASS');
