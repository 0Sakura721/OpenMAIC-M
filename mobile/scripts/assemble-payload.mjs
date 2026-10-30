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
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
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

/** Dangling symlinks met while copying; reported rather than failing the build. */
const dangling = [];

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
 *
 * Symlinks are dereferenced: pnpm's store is a wall of them, and a link that
 * survived into the payload would point outside the app's private storage on
 * the phone. A *dangling* link is skipped rather than fatal — pnpm leaves those
 * behind for optional dependencies it did not install (the standalone tracer
 * copies `node_modules/.pnpm/node_modules/<name>` entries that only exist on
 * some platforms), and none of them is reachable at runtime.
 */
async function copyTree(from, to, options = {}) {
  const { skip } = options;
  if (skip?.(from)) return;

  let info;
  try {
    info = await stat(from);
  } catch (error) {
    if (error.code === 'ENOENT') {
      dangling.push(path.relative(standalone, from));
      return;
    }
    throw error;
  }

  if (!info.isDirectory()) {
    if (DROP_EXTENSIONS.has(path.extname(from))) return;
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { dereference: true });
    return;
  }
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    await copyTree(path.join(from, entry), path.join(to, entry), options);
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
        // sharp's native builds are per-platform and there is no Android one;
        // the payload ships mobile/sharp-shim.cjs in the package's place.
        if (relative === 'node_modules/sharp') return true;
        if (relative.startsWith('node_modules/.pnpm/') && /(^|\/)sharp@/.test(relative)) return true;
        if (/(^|\/)@img\//.test(relative)) return true;
        // node-postgres is replaced by the PGlite stand-in. Every copy goes —
        // the top-level one, pnpm's real one under .pnpm/, and the virtual
        // node_modules/.pnpm/node_modules/pg link that pnpm keeps for packages
        // whose dependencies are not hoisted. Missing one of those is what let
        // the server resolve real node-postgres and die on `pg-types`.
        if (relative === 'node_modules/pg') return true;
        if (/(^|\/)node_modules\/pg$/.test(relative)) return true;
        if (/node_modules\/\.pnpm\/(pg|pg-pool|pg-protocol|pg-types|pgpass|pg-connection-string)@/.test(relative)) {
          return true;
        }
        return false;
      },
    });

    // ---- static assets Next does not copy into standalone ----
    await copyTree(path.join(root, '.next', 'static'), path.join(payload, '.next', 'static'));

    // ---- the mobile runtime: bootstrap + shims ----
    await copyTree(path.join(here, '..', 'runtime'), path.join(payload, 'mobile'));

    // ---- replace Turbopack's physical copies of external packages ----
    // For a `serverExternalPackages` entry, Turbopack does not emit a
    // `require('pg')` at runtime: it *copies the real package* into
    // `.next/node_modules/pg-<hash>/` and requires that path directly. So no
    // resolver hook can stand in for it — the fix is to make the copy be the
    // stand-in.
    await replaceTurbopackExternalCopy(payload, 'pg', 'pg-pglite.cjs');
    await replaceTurbopackExternalCopy(payload, 'sharp', 'sharp-shim.cjs');

    // ---- give every remaining copy its own dependencies ----
    // The copies are not isolated: a package only works if its own
    // `dependencies` are resolvable from where the copy sits. Turbopack's
    // tracer does not walk them, so `postcss`'s copy died on `picocolors`,
    // and the next copy would die on the next missing name. Copying each
    // copy's declared dependencies in is what makes them all loadable.
    await satisfyExternalCopyDependencies(payload);

    // ---- Next's own runtime dependencies ----
    // The standalone tracer follows what the *application* imports. Next's own
    // published dependencies (`@swc/helpers`, `styled-jsx`, …) are loaded by
    // Next at runtime through paths the tracer does not model, so they are
    // absent from the standalone tree and the server dies on the first
    // `@swc/helpers/_/_interop_require_default`. Copy each one that is
    // declared and resolvable, and skip anything already present.
    const nextPkg = JSON.parse(readFileSync(require.resolve('next/package.json'), 'utf8'));
    const copied = [];
    for (const dependency of Object.keys(nextPkg.dependencies ?? {})) {
      const target = path.join(payload, 'node_modules', ...dependency.split('/'));
      if (await exists(target)) continue;
      let source;
      try {
        source = resolvePackageDir(dependency);
      } catch {
        continue; // Not installed (an optional or bundled dependency).
      }
      await copyTree(source, target);
      copied.push(dependency);
    }
    if (copied.length > 0) console.log(`[payload] added Next runtime deps: ${copied.join(', ')}`);

    // ---- PGlite, which is not part of the Next bundle ----
    // Resolved through the package's own entry point rather than
    // `<pkg>/package.json`: its `exports` map does not publish the manifest, so
    // `require.resolve` on it throws.
    const pgliteDir = resolvePackageDir('@electric-sql/pglite');
    await copyTree(pgliteDir, path.join(payload, 'node_modules', '@electric-sql', 'pglite'), {
      // Keep the WASM engines and the JS; the source maps are 8 MB of nothing.
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
    if (dangling.length > 0) {
      // Reported, not fatal: these are optional dependencies pnpm never
      // installed on this platform. If one were reachable at runtime, the
      // payload boot check that runs next would fail on the missing module.
      console.log(`[payload] skipped ${dangling.length} dangling symlink(s), e.g.:`);
      for (const entry of dangling.slice(0, 5)) console.log(`[payload]   ${entry}`);
    }

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

/** The directory a bare package specifier resolves to.
 *
 * Tries, in order: a plain resolution from the repository root, then pnpm's
 * content-addressed store (`.pnpm/<escaped-name>@<version>/node_modules/<name>`).
 * The second is what makes this work for Next's own dependencies: under pnpm's
 * default layout they are not hoisted to the top-level `node_modules`, so
 * `require.resolve` cannot see them from the repository root even though they
 * are installed — which is exactly how `@swc/helpers` went missing from the
 * payload while being a hard Next runtime dependency.
 */
function resolvePackageDir(specifier) {
  const fromRoot = createRequire(path.join(root, 'package.json'));
  try {
    let resolved;
    try {
      resolved = fromRoot.resolve(specifier);
    } catch {
      // Some packages only expose an ESM entry, which require.resolve cannot see.
      resolved = fromRoot.resolve(`${specifier}/`).replace(/\/$/, '');
    }
    let directory = path.dirname(resolved);
    for (let depth = 0; depth < 6; depth++) {
      if (existsSync(path.join(directory, 'package.json'))) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // Fall through to the store lookup.
  }

  // pnpm store layout, where `+` stands in for `/` in the scoped name and a
  // peer-dependency hash may follow the version.
  const escaped = specifier.replace('/', '+');
  const storeDir = path.join(root, 'node_modules', '.pnpm');
  if (existsSync(storeDir)) {
    const prefix = `${escaped}@`;
    const candidates = readdirSync(storeDir)
      .filter((entry) => entry.startsWith(prefix))
      .sort()
      .reverse();
    for (const candidate of candidates) {
      const directory = path.join(storeDir, candidate, 'node_modules', ...specifier.split('/'));
      if (existsSync(path.join(directory, 'package.json'))) return directory;
    }
  }

  throw new Error(`could not locate ${specifier} in the repository or its pnpm store`);
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

/**
 * Replace a Turbopack external-package copy with one of this payload's shims.
 *
 * A `serverExternalPackages` entry is emitted by Turbopack as a *physical copy*
 * of the installed package under `.next/node_modules/<name>-<hash>/`, required
 * by that literal path. So the package cannot be substituted by resolution —
 * the copy itself has to be replaced. Each copy is removed and rewritten as a
 * one-file package that re-exports the shim from `mobile/`.
 *
 * Returns the number of copies replaced; zero is not an error, because a build
 * that inlined the package instead leaves nothing to replace (the resolver hook
 * in `mobile/runtime/pg-hook.mjs` covers that case).
 */
async function replaceTurbopackExternalCopy(payload, packageName, shimFile) {
  const externalsDir = path.join(payload, '.next', 'node_modules');
  if (!(await exists(externalsDir))) return 0;

  const prefix = `${packageName}-`;
  const copies = (await readdir(externalsDir)).filter((entry) => entry.startsWith(prefix));
  for (const copy of copies) {
    const directory = path.join(externalsDir, copy);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify(
        {
          name: copy,
          version: '0.0.0-mobile-shim',
          private: true,
          main: './index.cjs',
        },
        null,
        2,
      ) + '\n',
    );
    // Resolved relative to the copy, so the depth of `.next/node_modules/<copy>/`
    // never has to be counted by hand.
    const shimPath = path.join(payload, 'mobile', shimFile);
    const relativeShim = path
      .relative(directory, shimPath)
      .split(path.sep)
      .join('/');
    await writeFile(
      path.join(directory, 'index.cjs'),
      [
        "'use strict';",
        `module.exports = require(${JSON.stringify(relativeShim)});`,
        '',
      ].join('\n'),
    );
    console.log(`[payload] replaced external copy ${copy} -> ${relativeShim}`);
  }
  return copies.length;
}

/**
 * Make each Turbopack external copy able to load its own dependencies.
 *
 * A copy at `.next/node_modules/<name>-<hash>/` resolves its `require`s
 * relative to itself, so it sees `.next/node_modules/` before the payload's
 * top-level `node_modules/`. Turbopack copies the package but not its
 * dependency tree, which is why `postcss`'s copy failed on `picocolors` even
 * though `picocolors` is installed.
 *
 * The fix walks each copy's `dependencies` (and `optionalDependencies`, which
 * are skipped when absent) and copies them into `.next/node_modules/` next to
 * the copy, recursively, so a dependency's own dependencies come with it.
 * Existing entries are left alone: the payload's top-level `node_modules/` is
 * already the right answer for anything the tracer did keep.
 */
async function satisfyExternalCopyDependencies(payload) {
  const externalsDir = path.join(payload, '.next', 'node_modules');
  if (!(await exists(externalsDir))) return;

  /** Packages whose dependencies have been installed; guards cycles. */
  const done = new Set();
  let copied = 0;

  const install = async (specifier) => {
    if (done.has(specifier)) return;
    done.add(specifier);

    const target = path.join(externalsDir, ...specifier.split('/'));
    if (!(await exists(target))) {
      let source;
      try {
        source = resolvePackageDir(specifier);
      } catch {
        return; // Not installed here: an optional dependency, or a peer.
      }
      await copyTree(source, target, {
        skip: (candidate) => {
          const relative = path
            .relative(source, candidate)
            .split(path.sep)
            .join('/');
          // Native builds and source maps are dead weight on a phone.
          if (/(^|\/)@img\//.test(relative)) return true;
          return false;
        },
      });
      copied++;
    }

    // Recurse through this package's own declared dependencies.
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
    } catch {
      return;
    }
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const dependency of Object.keys(declared)) {
      await install(dependency);
    }
  };

  for (const entry of await readdir(externalsDir)) {
    const manifestPath = path.join(externalsDir, entry, 'package.json');
    if (!(await exists(manifestPath))) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    // The copy's own name is not its dependency; install what it needs.
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await install(dependency);
    }
  }
  if (copied > 0) {
    console.log(`[payload] installed ${copied} dependency package(s) for Turbopack externals`);
  }
}

await main();
