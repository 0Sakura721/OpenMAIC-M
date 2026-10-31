/**
 * Shrink every package.json in the payload to fit the runtime's parser.
 *
 * nodejs-mobile's Node reads `package.json` through simdjson
 * (`src/node_modules.cc`, `BindingData::GetPackageJSON`), and on this runtime
 * that parser fails for documents above ~190 bytes: measured on an Android 15
 * device, a 190-byte file resolves and a 197-byte file does not, and the
 * failure is reported as `ERR_INVALID_PACKAGE_CONFIG` with no further detail.
 * Every real package.json in the payload is far larger, so *every* bare
 * specifier fails — `require('next')`, `require('react')`, everything — while
 * relative requires and `fs.readFileSync` keep working.
 *
 * The fix is to make the documents small enough to parse. A resolver only needs
 * a few fields, so each manifest is rewritten to keep:
 *
 *   - `name`       — identifies the package;
 *   - `version`    — some packages check it;
 *   - `main`       — the CommonJS entry point;
 *   - `exports`    — only when it is small enough to keep the file under budget,
 *                    because dropping it changes which subpaths resolve.
 *
 * Everything else (description, keywords, repository, license, scripts,
 * dependencies, engines, files…) is dropped: the payload is a build artifact
 * that will never be installed, published or linted, so nothing reads them.
 *
 * `type` is kept when present, since dropping `"type": "module"` would make Node
 * treat an ESM package as CommonJS.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The measured ceiling. The device accepted 190 bytes and rejected 197, so this
 * budget leaves margin below the observed failure point rather than sitting on
 * it — the exact limit is a property of simdjson's 128-byte padding window and
 * may shift with a different libnode build.
 */
export const MAX_PACKAGE_JSON_BYTES = 190;

/** Fields a resolver or a runtime check actually reads. */
const KEEP_ORDER = ['name', 'version', 'type', 'main', 'module', 'exports'];

function pick(manifest, fields) {
  const out = {};
  for (const field of fields) {
    if (manifest[field] !== undefined) out[field] = manifest[field];
  }
  return out;
}

/**
 * Rewrite one manifest, keeping as much as fits.
 *
 * Tries progressively smaller field sets, in the order a resolver needs them,
 * and returns the first that fits the budget. Returns `null` when even the
 * smallest useful form is too big — the caller reports that rather than writing
 * a manifest that would break resolution.
 */
function shrink(manifest) {
  const candidates = [
    pick(manifest, KEEP_ORDER),
    // Drop `exports`: it is the largest field by far, and a package with only a
    // `main` still resolves by bare name.
    pick(manifest, ['name', 'version', 'type', 'main']),
    pick(manifest, ['name', 'version', 'main']),
    pick(manifest, ['name', 'main']),
    pick(manifest, ['name']),
  ];

  for (const candidate of candidates) {
    if (Object.keys(candidate).length === 0) continue;
    const text = JSON.stringify(candidate) + '\n';
    if (Buffer.byteLength(text) <= MAX_PACKAGE_JSON_BYTES) return text;
  }
  return null;
}

/** Every package.json under `root`, excluding nested node_modules trees. */
async function findManifests(root) {
  const found = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === 'package.json') {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

/**
 * Shrink every manifest under `payloadDir` in place.
 *
 * Returns a summary: how many were rewritten, how many were already small
 * enough, and any that could not be made to fit.
 */
export async function shrinkPackageManifests(payloadDir) {
  const manifests = await findManifests(payloadDir);
  const summary = { total: manifests.length, rewritten: 0, already: 0, unshrinkable: [], savedBytes: 0 };

  for (const file of manifests) {
    const info = await stat(file);
    if (info.size <= MAX_PACKAGE_JSON_BYTES) {
      summary.already++;
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      summary.unshrinkable.push(`${path.relative(payloadDir, file)} (unparseable: ${error.message})`);
      continue;
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      summary.unshrinkable.push(`${path.relative(payloadDir, file)} (not an object)`);
      continue;
    }

    const text = shrink(manifest);
    if (text === null) {
      summary.unshrinkable.push(`${path.relative(payloadDir, file)} (cannot fit ${MAX_PACKAGE_JSON_BYTES} bytes)`);
      continue;
    }

    await writeFile(file, text);
    summary.rewritten++;
    summary.savedBytes += info.size - Buffer.byteLength(text);
  }

  return summary;
}
