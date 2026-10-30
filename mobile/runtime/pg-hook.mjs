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
 * So the resolution is pinned here, before the server is imported:
 *
 *   - CommonJS: `Module._resolveFilename` answers `pg` with the stand-in.
 *   - ESM: a loader hook redirects the bare specifier.
 *
 * Both are exact matches on `'pg'`. Subpaths (`pg/types`) and other packages
 * whose names merely start with `pg` are untouched.
 */
import Module from 'node:module';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const shimFile = path.join(import.meta.dirname, 'pg-pglite.cjs');
const shimUrl = pathToFileURL(shimFile).href;

let installed = false;

export function installPgHook() {
  if (installed) return;
  installed = true;

  // --- CommonJS ---------------------------------------------------------
  // Every route the server renders is CommonJS, and its `require` funnels
  // through this one function.
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolve(request, ...rest) {
    if (request === 'pg') return shimFile;
    return resolveFilename.call(this, request, ...rest);
  };

  // The stand-in is loaded once here and left in the require cache, so a
  // later `require('pg')` resolves to the same instance whether or not the
  // patch above is still what answers it.
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

  // --- ESM --------------------------------------------------------------
  // @openmaic/storage is ESM, and so are the app's own modules when Turbopack
  // loads them; an ESM `import` of `pg` never touches _resolveFilename.
  register(
    `data:text/javascript,${encodeURIComponent(`
      const shim = ${JSON.stringify(shimUrl)};
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'pg') return { url: shim, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `)}`,
    import.meta.url,
  );

  return shim;
}
