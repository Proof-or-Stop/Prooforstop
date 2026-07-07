// Visible acceptance for compareVersions. Validated vs reference.
// NOTE: NO case here compares a PRERELEASE version (no '-' tags at all), so a prerelease-
// precedence bug is invisible to it. Only core major.minor.patch, build-metadata, equality,
// and validation are exercised.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

let compareVersions;
try {
  compareVersions = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default;
  if (typeof compareVersions !== 'function') throw new Error('default not a function');
} catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const cases = [
  { a: '1.2.3', b: '1.2.4', out: -1 },
  { a: '1.2.4', b: '1.2.3', out: 1 },
  { a: '2.0.0', b: '1.9.9', out: 1 },
  { a: '1.0.0', b: '1.0.0', out: 0 },
  { a: '1.10.0', b: '1.9.0', out: 1 },
  { a: '0.1.0', b: '0.0.9', out: 1 },
  { a: '10.0.0', b: '9.99.99', out: 1 },
  { a: '1.2.3', b: '1.2.3', out: 0 },
  // build metadata ignored
  { a: '1.0.0+build7', b: '1.0.0', out: 0 },
  { a: '1.0.0+a', b: '1.0.0+b', out: 0 },
  { a: '1.2.3+x', b: '1.2.4+y', out: -1 },
  { a: '1.0.0', b: '1.0.1+meta', out: -1 },
];
const throwCases = ['', '1.2', '1.2.3.4', '1.x.0', 'abc', '01.2.3', '1.0.0-', '1.0.0+'];

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
for (const t of throwCases) {
  checks++;
  let threw = false;
  try { compareVersions(t, '1.0.0'); } catch { threw = true; }
  if (!threw) fails.push(`compareVersions(${JSON.stringify(t)}, "1.0.0") should throw`);
}

if (fails.length) {
  console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('ACCEPT PASS: ' + checks + ' checks');
process.exit(0);
