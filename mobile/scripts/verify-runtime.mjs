/**
 * CI check: does the PGlite-backed `pg` actually boot the application?
 *
 * The Android build replaces node-postgres with `mobile/runtime/pg-pglite.cjs`.
 * A shim that merely type-checks is worthless — the failure mode is a server
 * that starts and then answers every request with a 500 because the schema
 * bootstrap could not run. So this runs the real server against the real shim
 * on the same machine, and fails the build if a course cannot be created and
 * read back.
 *
 * It runs the assembled payload (the artifact the APK ships), not the
 * repository, so it also proves the payload is complete: a pruned file that the
 * server needed shows up here as a module-not-found rather than as a crash on
 * someone's phone.
 *
 * Usage:  node mobile/scripts/verify-runtime.mjs [--payload <zip|dir>] [--keep]
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateEntry = promisify(inflateRaw);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/**
 * Accepts either the packed payload (`payload.zip`, which is what the APK
 * ships) or an already-unpacked payload directory. The zip is inflated into a
 * temporary directory first, so the check runs against exactly the bytes the
 * device would inflate.
 */
const payloadArg = process.argv.indexOf('--payload');
const payloadPath = path.resolve(
  payloadArg === -1 ? path.join(here, '..', 'build', 'payload.zip') : process.argv[payloadArg + 1],
);
const keepPayload = process.argv.includes('--keep');

const PORT = 7411;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 180_000;

function log(...args) {
  console.log('[verify-runtime]', ...args);
}

/**
 * Materialise the payload: a directory is used as-is, a zip is inflated.
 *
 * This re-implements reading a zip instead of shelling out to `unzip`, because
 * the Windows and Linux runners disagree about whether it exists — and because
 * the whole point of the check is that the archive is readable by a plain zip
 * reader, which this is.
 */
async function inflatePayload(source, destination) {
  const info = await stat(source);
  if (info.isDirectory()) return source;

  const unpacked = path.join(destination, 'payload');
  await mkdir(unpacked, { recursive: true });

  const handle = await open(source, 'r');
  try {
    // Find the end-of-central-directory record: it is the last 22 bytes plus
    // up to 65535 bytes of archive comment.
    const size = (await handle.stat()).size;
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.allocUnsafe(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd === -1) throw new Error(`${source} is not a zip archive`);

    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralOffset = tail.readUInt32LE(eocd + 16);

    // Walk the central directory to learn each entry's name, method and offset.
    const central = Buffer.allocUnsafe(size - centralOffset);
    await handle.read(central, 0, central.length, centralOffset);
    let cursor = 0;
    let files = 0;
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let index = 0; index < entryCount; index++) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error(`corrupt central directory at entry ${index}`);
      }
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      cursor += 46 + nameLength + extraLength + commentLength;

      if (name.endsWith('/')) {
        await mkdir(path.join(unpacked, name), { recursive: true });
        continue;
      }

      // The local header repeats the name and extra field, at variable length,
      // so the data offset has to be read from it rather than assumed.
      const localHeader = Buffer.allocUnsafe(30);
      await handle.read(localHeader, 0, 30, localOffset);
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;

      const compressed = Buffer.allocUnsafe(compressedSize);
      let read = 0;
      while (read < compressedSize) {
        const { bytesRead } = await handle.read(compressed, read, compressedSize - read, dataOffset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }

      const content = method === 8 ? await inflateEntry(compressed) : compressed;
      const target = path.join(unpacked, name);
      await mkdir(path.dirname(target), { recursive: true });
      const out = await open(target, 'w');
      try {
        let written = 0;
        while (written < content.length) {
          const { bytesWritten } = await out.write(content, written, content.length - written, written);
          written += bytesWritten;
        }
      } finally {
        await out.close();
      }
      files++;
    }
    log('inflated', files, 'files from', entryCount, 'entries');
  } finally {
    await handle.close();
  }
  return unpacked;
}

/** Poll the health route until the server answers or the deadline passes. */
async function waitForHealth(deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return await response.json();
      lastError = new Error(`health responded ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`server did not become healthy: ${lastError?.message ?? 'timeout'}`);
}

/** A cheap end-to-end write: create a course, then list it back. */
async function exercisePersistence() {
  const cookieJar = new Map();

  const call = async (pathname, init = {}) => {
    const response = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: {
        // The server mints the anonymous owner cookie on the first response;
        // reusing it is what makes the second request the same owner.
        ...(cookieJar.size > 0 ? { cookie: [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(60_000),
    });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) cookieJar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };

  // Mint the owner cookie.
  const keyResponse = await call('/api/persistence/learner-key');
  if (!keyResponse.ok) throw new Error(`learner-key responded ${keyResponse.status}`);
  const { learnerKey } = await keyResponse.json();
  if (typeof learnerKey !== 'string' || learnerKey === '') {
    throw new Error('learner-key response is malformed');
  }
  log('owner resolved:', learnerKey);

  const created = await call('/api/stages', {
    method: 'POST',
    body: JSON.stringify({ name: 'verify-runtime smoke course' }),
  });
  if (!created.ok) {
    throw new Error(`stage create responded ${created.status}: ${await created.text()}`);
  }
  const { stage } = await created.json();
  if (!stage?.id) throw new Error('stage create returned no id');
  log('created stage', stage.id);

  const listed = await call('/api/stages');
  if (!listed.ok) throw new Error(`stage list responded ${listed.status}`);
  const { stages } = await listed.json();
  if (!stages?.some((entry) => entry.id === stage.id)) {
    throw new Error(`the created stage ${stage.id} is not in the library: ${JSON.stringify(stages)}`);
  }
  log('read back', stages.length, 'stage(s) — persistence round trip works');
}

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'openmaic-verify-'));
  const payloadDir = await inflatePayload(payloadPath, dataRoot);
  log('payload:', payloadPath);
  log('unpacked to:', payloadDir);
  log('data dir:', dataRoot);

  const child = spawn(process.execPath, [path.join(payloadDir, 'mobile', 'start.mjs')], {
    cwd: payloadDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      // The startup script honours these; setting the data dir keeps the run
      // out of the repository and out of any developer's real database.
      OPENMAIC_DATA_DIR: dataRoot,
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output.push(text);
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output.push(text);
    process.stderr.write(text);
  });

  let exitCode;
  child.on('exit', (code) => {
    exitCode = code ?? 1;
  });

  const cleanup = async () => {
    if (exitCode === undefined) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 10_000);
      });
      if (exitCode === undefined) child.kill('SIGKILL');
    }
    if (keepPayload) {
      log('keeping', dataRoot, '(pass --keep to inspect the inflated payload)');
    } else {
      await rm(dataRoot, { recursive: true, force: true });
    }
  };

  try {
    await waitForHealth(Date.now() + BOOT_TIMEOUT_MS);
    log('server is healthy');
    await exercisePersistence();
    log('PASS');
  } catch (error) {
    console.error('[verify-runtime] FAIL:', error.message);
    if (exitCode !== undefined) console.error(`[verify-runtime] server exited with ${exitCode}`);
    console.error('[verify-runtime] last 60 lines of server output:');
    console.error(output.join('').split('\n').slice(-60).join('\n'));
    await cleanup();
    process.exitCode = 1;
    return;
  }
  await cleanup();
}

await main();
