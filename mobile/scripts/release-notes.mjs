#!/usr/bin/env node
/**
 * Print the changelog section for one version, for a release body.
 *
 * `gh release create --notes '<a fixed sentence>'` was used for every tag, so
 * every release said the same thing and none of them said what changed. The
 * changelog in this repository already has one section per tag; this extracts
 * the one that matches a given tag so the release body is the entry itself.
 *
 * Usage: node mobile/scripts/release-notes.mjs v1.0.0-m11
 *
 * Exits non-zero when the section is missing, so a tag published without a
 * changelog entry fails the release step loudly instead of quietly shipping the
 * generic sentence again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const changelog = path.join(here, '..', 'CHANGELOG.md');

const tag = process.argv[2];
if (!tag) {
  console.error('usage: release-notes.mjs <tag>');
  process.exit(2);
}

const text = readFileSync(changelog, 'utf8');

// A section starts at `## [tag]` (the version may be followed by anything, such
// as a date) and ends at the next `## [` heading or the horizontal rule that
// separates entries.
const lines = text.split('\n');
const start = lines.findIndex((line) => {
  const match = /^##\s+\[([^\]]+)\]/.exec(line);
  return match?.[1] === tag;
});

if (start === -1) {
  console.error(`release-notes: no section for ${tag} in mobile/CHANGELOG.md`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s+\[/.test(lines[i]) || /^---\s*$/.test(lines[i])) {
    end = i;
    break;
  }
}

// The heading itself becomes the release title, so the body starts after it.
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();

if (!body) {
  console.error(`release-notes: section for ${tag} is empty`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
