// Diagnostic 31: does a smaller package.json with the required fields work?
//
// Established: Node's simdjson-based package.json reader fails above ~190 bytes
// on this runtime (190 OK, 197 fails). Every real package.json in the payload
// is far larger, so every bare-specifier resolution fails.
//
// The fix has to be structural: the payload cannot contain package.json files
// the reader cannot parse. This checks whether the fields Node actually needs
// fit under the limit, using next's own metadata.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const here = path.dirname(new URL(import.meta.url).pathname);
const projectDir = path.resolve(here, '..');
const pkgPath = path.join(projectDir, 'node_modules', 'react', 'package.json');

// The minimum a resolver needs: a name, a version, and an entry point.
// `exports` is what routes subpaths, but react's main entry is enough for the
// server, which imports react and react-dom by their bare names.
const minimal = '{"name":"react","version":"19.2.3","main":"index.js"}';
fs.writeFileSync(pkgPath, minimal);

const require = createRequire(import.meta.url);
const results = [];
try {
  results.push('resolve(react) -> ' + require.resolve('react'));
} catch (e) {
  results.push('resolve(react) FAILED ' + (e.code ?? ''));
}
try {
  const react = require('react');
  results.push('require(react) OK, keys=' + Object.keys(react).slice(0, 4).join(','));
} catch (e) {
  results.push('require(react) FAILED ' + (e.code ?? '') + ' ' + e.message.slice(0, 60));
}
console.log(`DIAG minimal bytes=${Buffer.byteLength(minimal)}`);
for (const line of results) console.log('DIAG ' + line);
console.log('DIAG done');
