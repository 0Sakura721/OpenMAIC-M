/**
 * Assemble the Node payload the Android app ships, as one zip.
 *
 * Input:  the Next.js standalone build in `.next/standalone`, plus `.next/static`
 *         (which Next does not copy into standalone itself).
 * Output: a single `payload.zip` written to `--out`.
 *
 * A zip rather than a directory of assets, for two reasons that both matter on
 * a phone:
 *
 *   - **Packaging cost.** The payload is tens of thousands of files. AAPT
 *     compresses each asset individually, so shipping them raw turns a build
 *     into an hours-long step and inflates the APK's central directory.
 *   - **First-launch cost.** The app has to copy every asset out of the APK
 *     before the runtime can execute from it (an APK is a zip the platform only
 *     reads through its index). Copying one file and inflating it is far faster
 *     than opening tens of thousands of asset streams.
 *
 * The archive is stored with the payload pruned first, because it is also what
 * the user pays for in download size:
 *
 *   - server source maps (~90 MB of `.map` files) are not needed at runtime;
 *   - the repository's docs, tests, eval and marketing media are traced into
 *     standalone by `outputFileTracingIncludes` but never imported;
 *   - native `@img/sharp-*` builds are dropped — see `sharp-shim.cjs`.
 *
 * Usage:  node mobile/scripts/assemble-payload.mjs --out <path/to/payload.zip>
 */
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zip } from './lib/zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const standalone = path.join(root, '.next', 'standalone');
const require = createRequire(import.meta.url);

const outArg = process.argv.indexOf('--out');
const outFile = path.resolve(
  outArg === -1
    ? path.join(here, '..', 'build', 'payload.zip')
    : process.argv[outArg + 1],
);

/** Directories at the standalone root that are build metadata, not runtime code. */
const DROP_ROOT_DIRS = new Set([
  '.git',
  '.github',
  'e2e',
  'eval',
  'tests',
  'assets',
  'render-service',
  'community',
  'configs',
  'scripts',
  'docs',
  'skills',
]);

/** Extensions never needed at runtime. */
const DROP_EXTENSIONS = new Set(['.map', '.tsbuildinfo', '.md']);

/** Files at the standalone root that only exist for contributors. */
const DROP_ROOT_FILES = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'README.md',
  'README-zh.md',
  'SECURITY.md',
  'comfyui-setup-instructions.md',
  'eslint.config.mjs',
  'playwright.config.ts',
  'vitest.config.ts',
  'vitest.eval.config.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.build.json',
  '.prettierrc',
  '.prettierignore',
  '.dockerignore',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.nvmrc',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.db.yml',
  'docker-compose.defaults.env',
  'openmaic.example.yml',
  'postcss.config.mjs',
  'components.json',
  'middleware.ts',
]);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function sizeOf(target) {
  const info = await stat(target);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target)) total += await sizeOf(path.join(target, entry));
  return total;
}

/**
 * Copy a tree, skipping build artefacts and anything the caller excludes.
 * Symlinks are followed: pnpm's store uses them, and a link that survived into
 * the payload would point outside the app's private storage on the phone.
 */
async function copyTree(from, to, options = {}) {
  const { skip } = options;
  const info = await stat(from);
  if (!info.isDirectory()) {
    if (DROP_EXTENSIONS.has(path.extname(from))) return;
    if (skip?.(from)) return;
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { dereference: true });
    return;
  }
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const source = path.join(from, entry);
    if (skip?.(source)) continue;
    await copyTree(source, path.join(to, entry), options);
  }
}

async function main() {
  if (!(await exists(standalone))) {
    throw new Error(`No standalone build at ${standalone}. Run \`pnpm build\` first.`);
  }

  const staging = await mkdtemp(path.join(tmpdir(), 'openmaic-payload-'));
  const payload = path.join(staging, 'nodejs-project');
  const dropped = [];
  const note = (what, bytes) => dropped.push([what, bytes]);

  try {
    // ---- standalone root: keep only what the server resolves ----
    for (const entry of await readdir(standalone)) {
      const source = path.join(standalone, entry);
      const info = await stat(source);
      if (info.isDirectory()) {
        if (DROP_ROOT_DIRS.has(entry)) {
          note(entry + '/', await sizeOf(source));
          continue;
        }
        if (entry === 'node_modules' || entry === 'packages') continue; // handled below
        await copyTree(source, path.join(payload, entry));
        continue;
      }
      if (DROP_ROOT_FILES.has(entry)) {
        note(entry, info.size);
        continue;
      }
      if (DROP_EXTENSIONS.has(path.extname(entry))) continue;
      await cp(source, path.join(payload, entry));
    }

    // ---- node_modules: everything the standalone tracer kept, minus natives ----
    await copyTree(path.join(standalone, 'node_modules'), path.join(payload, 'node_modules'), {
      skip: (source) => {
        const relative = path.relative(standalone, source).split(path.sep).join('/');
        // sharp's native builds are per-platform and there is no Android one.
        if (relative === 'node_modules/sharp') return true;
        if (relative.startsWith('node_modules/.pnpm/') && /(^|\/)sharp@/.test(relative)) return true;
        if (/(^|\/)@img\//.test(relative)) return true;
        // node-postgres is replaced by the PGlite shim; its own sources are dead
        // weight, and keeping them would shadow the replacement's entry points.
        if (relative === 'node_modules/pg') return true;
        if (relative.startsWith('node_modules/.pnpm/pg@') || relative.startsWith('node_modules/.pnpm/pg-pool@')) {
          return true;
        }
        if (relative.startsWith('node_modules/.pnpm/pg-protocol@') || relative.startsWith('node_modules/.pnpm/pg-types@')) {
          return true;
        }
        return false;
      },
    });

    // ---- static assets Next does not copy into standalone ----
    await copyTree(path.join(root, '.next', 'static'), path.join(payload, '.next', 'static'));

    // ---- the mobile runtime: bootstrap + shims ----
    await copyTree(path.join(here, '..', 'runtime'), path.join(payload, 'mobile'));

    // ---- PGlite, which is not part of the Next bundle ----
    const pgliteDir = path.dirname(require.resolve('@electric-sql/pglite/package.json'));
    await copyTree(pgliteDir, path.join(payload, 'node_modules', '@electric-sql', 'pglite'), {
      // Keep the WASM engines and the JS; drop the source maps and CJS duplicates
      // of the same build (the server is ESM).
      skip: (source) => path.basename(source).endsWith('.map'),
    });

    // ---- `pg`: the PGlite stand-in, resolvable as a bare specifier ----
    await writePackage(payload, 'pg', 'pg', [
      "'use strict';",
      '// Resolved by the Next.js server via a bare `pg` import; the real',
      '// implementation is mobile/pg-pglite.cjs, which answers every query from',
      '// the on-device PGlite database.',
      'module.exports = require("../../mobile/pg-pglite.cjs");',
      '',
    ]);

    // ---- `sharp`: a shim, because libvips has no Android build ----
    await writePackage(payload, 'sharp', 'sharp', [
      "'use strict';",
      'module.exports = require("../../mobile/sharp-shim.cjs");',
      '',
    ]);

    // ---- the Node project's entry point ----
    await writeFile(
      path.join(payload, 'package.json'),
      JSON.stringify(
        {
          name: 'openmaic-mobile-node',
          version: '1.0.0',
          private: true,
          description: 'The OpenMAIC server, running on nodejs-mobile inside the Android app.',
          type: 'module',
          main: 'mobile/start.mjs',
        },
        null,
        2,
      ) + '\n',
    );

    const unpacked = await sizeOf(payload);
    console.log(`[payload] ${(unpacked / 1048576).toFixed(1)} MB unpacked`);

    await mkdir(path.dirname(outFile), { recursive: true });
    const written = await zip(payload, outFile, (progress) => {
      if (progress.files % 5000 === 0) {
        console.log(`[payload] packed ${progress.files} files, ${(progress.bytes / 1048576).toFixed(1)} MB`);
      }
    });
    const compressedSize = await sizeOf(outFile);
    console.log(
      `[payload] ${path.relative(root, outFile)}: ` +
        `${(compressedSize / 1048576).toFixed(1)} MB from ${written.files} files ` +
        `(${((compressedSize / unpacked) * 100).toFixed(0)}%)`,
    );

    if (dropped.length > 0) {
      const reclaimed = dropped.reduce((sum, [, bytes]) => sum + bytes, 0);
      console.log(`[payload] pruned ${(reclaimed / 1048576).toFixed(1)} MB:`);
      for (const [what, bytes] of dropped.sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`[payload]   ${(bytes / 1048576).toFixed(1).padStart(7)} MB  ${what}`);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Write a one-file package whose entry re-exports a module from mobile/. */
async function writePackage(payload, dirName, packageName, entryLines) {
  const dir = path.join(payload, 'node_modules', dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.0.0-mobile-shim',
        private: true,
        description: `Stand-in for ${packageName}, for the Android build.`,
        main: './index.cjs',
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(path.join(dir, 'index.cjs'), entryLines.join('\n'));
}

await main();
