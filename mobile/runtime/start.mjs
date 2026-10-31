/**
 * The OpenMAIC server, running inside the Android app.
 *
 * Entry point of the Node project the APK ships (see `assemble-payload.mjs`).
 * nodejs-mobile gives us a Node 24 runtime in a background thread of the app
 * process; this file turns it into a working OpenMAIC server:
 *
 *   1. open the on-device database (PGlite — PostgreSQL compiled to WebAssembly)
 *   2. point the application's persistence layer at it
 *   3. start the Next.js server on loopback
 *   4. tell the app it is ready, so its WebView can load the URL
 *
 * Two things differ from `server.js`, the entry Next generates for standalone
 * builds, and both are forced by the platform:
 *
 *   - **No `start-server`.** `next/dist/server/lib/start-server` requires
 *     `node:child_process` (it shells out to `lsof`/`netstat` when a port is
 *     taken), and nodejs-mobile has no process spawning. The server is started
 *     through Next's programmatic API instead, which is the same code path
 *     minus the process management.
 *   - **No PostgreSQL server.** `DATABASE_URL` is set to a placeholder that
 *     only has to be non-empty — the application gates on its presence — and
 *     `pg` is replaced by `mobile/pg-pglite.cjs`, which answers every query
 *     from the embedded database.
 *
 * The app's bridge (`@capawesome/capacitor-nodejs`'s `bridge` module) is
 * optional: under plain Node, as in CI, the server starts and logs its URL
 * without it.
 */
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

/** Where the app keeps writable state; falls back to the project dir under Node. */
async function resolveDataDir() {
  // Set by the Android shell to the app's private files directory, and by the
  // CI smoke test to a throwaway directory. Honoured first so the app never
  // writes into the unpacked payload, which an update replaces wholesale.
  const configured = process.env.OPENMAIC_DATA_DIR?.trim();
  if (configured) return path.join(configured, 'openmaic');
  try {
    const bridge = await import('bridge');
    const dir = bridge.app?.datadir?.() ?? bridge.datadir?.();
    if (typeof dir === 'string' && dir.length > 0) return path.join(dir, 'openmaic');
  } catch {
    // Not running inside the Android app: no bridge module.
  }
  return path.join(projectDir, '.data');
}

/**
 * The port the WebView loads. Fixed rather than ephemeral: the app needs the
 * URL before the server is up, and the value is baked into its assets.
 */
const PORT = Number(process.env.PORT ?? 7010);
const HOST = '127.0.0.1';

function log(...args) {
  // nodejs-mobile redirects this to logcat, which is where a phone-side
  // failure has to be readable.
  console.log('[openmaic-mobile]', ...args);
}

async function main() {
  const dataDir = await resolveDataDir();
  log('data directory:', dataDir);

  // --- 0. route every `pg` import to the embedded database --------------
  // Installed before anything imports the server, because Next resolves its
  // externalized `pg` import the first time a route module loads, and caches
  // the result. See mobile/runtime/pg-hook.mjs.
  const { installPgHook } = await import('./pg-hook.mjs');
  installPgHook();

  // --- 1. the database ---------------------------------------------------
  const { openDatabase } = await import('./pg-pglite.cjs');
  const startedAt = Date.now();
  // PGlite creates its own data directory but not its parents, and on a fresh
  // install none of them exist yet.
  await mkdir(dataDir, { recursive: true });
  await openDatabase(path.join(dataDir, 'pg'));
  log('database ready in', Date.now() - startedAt, 'ms');

  // The application gates every persistence feature on this being non-empty;
  // the value itself is never dialled, because `pg` is the PGlite shim.
  process.env.DATABASE_URL ||= 'postgres://pglite@localhost/openmaic';

  // --- 2. application environment ---------------------------------------
  // The WebView loads http://127.0.0.1, and a `Secure` cookie is not sent over
  // plain HTTP. Without this the browser mints a fresh anonymous owner on
  // every request and no course stays visible.
  process.env.COOKIE_SECURE ??= '0';
  // One user, one device: the owner is the anonymous cookie, and the
  // access-code gate has nothing to protect against.
  delete process.env.ACCESS_CODE;
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(PORT);
  process.env.HOSTNAME = HOST;

  process.chdir(projectDir);

  // --- 3. the Next.js server --------------------------------------------
  const required = JSON.parse(
    readFileSync(path.join(projectDir, '.next', 'required-server-files.json'), 'utf8'),
  );
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(required.config);

  // Loaded through `require`, not `import`.
  //
  // An ESM `import('next')` makes Node's ESM loader read
  // `node_modules/next/package.json` while resolving the package scope, and on
  // Android that read can fail in a way this runtime wraps as
  //
  //     Invalid package config …/node_modules/next/package.json
  //
  // even though the file is valid JSON (checked byte-for-byte on device). Node
  // reports every non-ENOENT read failure under that name, so the message
  // describes the symptom, not the cause — and the cause is on the ESM loader's
  // path specifically. `require` takes the CommonJS resolver, which needs no
  // package-scope read for a directory it can already see.
  //
  // `next` resolves to its CJS entry (`next/dist/...`), which is the same code
  // the standalone server uses.
  const nextModule = createRequire(import.meta.url)('next');
  const next = nextModule.default ?? nextModule;
  const app = next({ dev: false, dir: projectDir, hostname: HOST, port: PORT, conf: required.config });
  await app.prepare();
  const handle = app.getRequestHandler();

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      log('request failed:', request.url, error);
      if (!response.headersSent) response.statusCode = 500;
      response.end('Internal error');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  log(`listening on http://${HOST}:${PORT}`);

  // --- 4. tell the app it can load the page -----------------------------
  await announceReady(`http://${HOST}:${PORT}`);

  const shutdown = async () => {
    log('shutting down');
    await new Promise((resolve) => server.close(resolve));
    const { closeDatabase } = await import('./pg-pglite.cjs');
    await closeDatabase().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * Hand the URL to the Android shell.
 *
 * Two channels, because the app listens on whichever it has: the Capacitor
 * plugin's bridge event, and stdout, which the shell also tails (that is what
 * makes `adb logcat` enough to debug a build without the plugin wired up).
 */
async function announceReady(url) {
  console.log(`OPENMAIC_READY ${url}`);
  try {
    const bridge = await import('bridge');
    bridge.sendMessage?.('openmaic-ready', JSON.stringify({ url }));
  } catch {
    // Not running inside the Android app.
  }
}

main().catch((error) => {
  console.error('[openmaic-mobile] fatal:', error?.stack ?? error);
  console.log('OPENMAIC_FAILED');
  process.exitCode = 1;
});
