/**
 * Guarantee that every `require('pg')` in the server reaches the PGlite
 * stand-in, no matter which copy of node-postgres the bundler recorded.
 *
 * Why this is needed at all: `next.config.ts` lists `pg` in
 * `serverExternalPackages`, so Next compiles each import into a runtime
 * `require('pg')` — resolved from the *server bundle's* directory when the
 * route first loads. The payload also installs the stand-in as
 * `node_modules/pg`, which is where that resolution normally lands. But pnpm
 * keeps a second, virtual copy at `node_modules/.pnpm/node_modules/pg`, and a
 * build whose tracing followed that path resolves there instead, loading real
 * node-postgres and failing on its own `pg-types` dependency — while the
 * database it would have talked to does not exist on the device anyway.
 *
 * The interception is an exact match on the bare specifier `'pg'`. Subpaths
 * (`pg/types`) and packages whose names merely start with `pg` are untouched.
 *
 * **CommonJS only, deliberately.** An earlier version also registered an ESM
 * loader hook (`module.register` with a `data:` URL). That hook runs in a
 * separate loader worker, and on a device it failed the very first ESM
 * resolution with
 *
 *     Invalid package config .../payload/package.json
 *
 * even though that file is valid JSON: the worker resolves the hook's own
 * `parentURL` in a context where the package scope could not be read. The hook
 * was also unnecessary — the Next server bundle is CommonJS, so every route's
 * `import … from 'pg'` has already become `require('pg')`, and the physical
 * `.next/node_modules/pg-<hash>` replacement covers the rest. Removing it
 * removed the failure.
 */
import Module from 'node:module';
import path from 'node:path';

const shimFile = path.join(import.meta.dirname, 'pg-pglite.cjs');

let installed = false;

export function installPgHook() {
  if (installed) return undefined;
  installed = true;

  // Every route the server renders is CommonJS, and its `require` funnels
  // through this one function.
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolve(request, ...rest) {
    if (request === 'pg') return shimFile;
    return resolveFilename.call(this, request, ...rest);
  };

  // Load the stand-in once and leave it in the require cache, so a later
  // `require('pg')` gets the same instance whether or not the patch above is
  // still what answers it.
  const shim = Module.createRequire(import.meta.url)(shimFile);
  Module._cache[shimFile] = {
    id: shimFile,
    filename: shimFile,
    path: path.dirname(shimFile),
    loaded: true,
    exports: shim,
    children: [],
    paths: [],
  };

  return shim;
}
