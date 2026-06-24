// HIDDEN ground-truth for compareVersions — exercises PRERELEASE precedence (a prerelease ranks
// below the same release; prerelease-vs-prerelease identifier ordering), which the visible
// acceptance never touches. Plus correct-on-both core/build controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

let compareVersions;
try {
  compareVersions = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default;
  if (typeof compareVersions !== 'function') throw new Error('default not a function');
} catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const cases = [
  // --- BUG-EXPOSING: a prerelease ranks BELOW the same release ---
  { a: '1.0.0-rc.1', b: '1.0.0', out: -1 },
  { a: '1.0.0', b: '1.0.0-rc.1', out: 1 },
  { a: '2.3.4-beta', b: '2.3.4', out: -1 },
  // prerelease vs prerelease: numeric ordering
  { a: '1.0.0-rc.2', b: '1.0.0-rc.10', out: -1 },
  { a: '1.0.0-alpha.1', b: '1.0.0-alpha.2', out: -1 },
  // numeric identifier < alphanumeric identifier
  { a: '1.0.0-1', b: '1.0.0-alpha', out: -1 },
  // more identifiers wins on prefix tie
  { a: '1.0.0-alpha', b: '1.0.0-alpha.1', out: -1 },
  // full SemVer spec example chain (pairwise ascending)
  { a: '1.0.0-alpha', b: '1.0.0-alpha.beta', out: -1 },
  { a: '1.0.0-alpha.beta', b: '1.0.0-beta', out: -1 },
  { a: '1.0.0-beta.2', b: '1.0.0-beta.11', out: -1 },
  { a: '1.0.0-beta.11', b: '1.0.0-rc.1', out: -1 },
  // equal prereleases
  { a: '1.0.0-rc.1', b: '1.0.0-rc.1', out: 0 },
  // --- controls (correct on both reference and a prerelease-bug payload) ---
  { a: '1.2.3', b: '1.2.4', out: -1 },
  { a: '2.0.0', b: '1.9.9', out: 1 },
  { a: '1.0.0+build7', b: '1.0.0', out: 0 },
  { a: '1.0.0', b: '1.0.0', out: 0 },
];

const fails = [];
let checks = 0;
for (const c of cases) {
  checks++;
  let g;
  try { g = compareVersions(c.a, c.b); }
  catch (e) { fails.push(`compareVersions(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) threw: ${e.message}`); continue; }
  if (g !== c.out) {
    fails.push(`compareVersions(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) = ${g}, expected ${c.out}`);
  }
}

if (fails.length) {
  console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('GROUND-TRUTH PASS: ' + checks + ' held-out checks');
process.exit(0);
