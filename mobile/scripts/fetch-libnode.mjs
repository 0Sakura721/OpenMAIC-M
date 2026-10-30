/**
 * Download and unpack the nodejs-mobile Android runtime.
 *
 * nodejs-mobile publishes a per-Android-ABI build of libnode.so plus the node
 * headers. The Gradle project links against them, so they have to be on disk
 * before Gradle runs.
 *
 * The upstream project (nodejs-mobile/nodejs-mobile) stopped at Node 18, which
 * this application cannot use — Next.js 16 requires Node >= 20.9 and its server
 * uses `Promise.withResolvers` and `Array.prototype.toSorted`. The maintained
 * fork `digidem/nodejs-mobile` tracks the current Node line and publishes
 * Node 24 builds, which is what this pins.
 *
 * Usage:  node mobile/scripts/fetch-libnode.mjs [--dest <dir>]
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pinned release. `sha256` is published in the release's asset digest; verify
 * it so a silently replaced asset cannot end up inside an APK.
 */
const LIBNODE = {
  version: '24.20.0-0',
  url: 'https://github.com/digidem/nodejs-mobile/releases/download/v24.20.0-0/nodejs-mobile-android-24.20.0-0.zip',
  sha256: 'f5ffbaf4f2679fa9180b0758c637c2f8fc8828300f95129badf213a028fb37bb',
  /** The zip's single top-level directory after unpacking. */
  zipRoot: '',
};

const args = process.argv.slice(2);
const destArg = args.indexOf('--dest');
const dest = path.resolve(
  destArg !== -1 ? args[destArg + 1] : path.join(here, '..', 'build', 'libnode'),
);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256Of(file) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, target) {
  console.log(`[libnode] downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(response.body, createWriteStream(target));
}

async function main() {
  const marker = path.join(dest, 'bin', 'arm64-v8a', 'libnode.so');
  if (await exists(marker)) {
    console.log(`[libnode] already present at ${dest}`);
    return;
  }

  const cacheDir = path.join(here, '..', 'build');
  const zipPath = path.join(cacheDir, `nodejs-mobile-android-${LIBNODE.version}.zip`);
  await mkdir(cacheDir, { recursive: true });

  if (!(await exists(zipPath))) {
    await download(LIBNODE.url, zipPath);
  } else {
    console.log(`[libnode] reusing cached ${zipPath}`);
  }

  const digest = await sha256Of(zipPath);
  if (digest !== LIBNODE.sha256) {
    await rm(zipPath, { force: true });
    throw new Error(
      `[libnode] checksum mismatch for ${zipPath}\n  expected ${LIBNODE.sha256}\n  got      ${digest}`,
    );
  }
  console.log('[libnode] checksum verified');

  // The release zip has no wrapper directory: bin/ and include/ are at its root.
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const unzip = path.join(cacheDir, 'unzip');
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest], { stdio: 'inherit' });
  } catch (error) {
    // Windows runners have no `unzip`; Node's zlib cannot read a zip, so fall
    // back to PowerShell, which every Windows image has.
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`],
        { stdio: 'inherit' },
      );
    } else {
      throw error;
    }
  }

  if (!(await exists(marker))) {
    throw new Error(`[libnode] unpacked archive has no ${marker}`);
  }
  const version = await readFile(path.join(dest, 'include', 'node', 'node_version.h'), 'utf8')
    .then((text) => /NODE_MAJOR_VERSION\s+(\d+)/.exec(text)?.[1] ?? '?')
    .catch(() => '?');
  console.log(`[libnode] ready at ${dest} (Node ${version}.x)`);

  // The header tree is only needed to compile the JNI shim; the .so files are
  // what the APK carries.
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
    const so = path.join(dest, 'bin', abi, 'libnode.so');
    if (!(await exists(so))) console.warn(`[libnode] warning: ${abi} build missing`);
  }
}

await main();
