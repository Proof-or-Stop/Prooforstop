// Deterministic acceptance check for the parse-range task.
// Authored independently of the solver arms; validated against reference-solution.mjs (S4).
// Usage: node acceptance.mjs <workspaceDir>   → exit 0 if accepted, 1 otherwise.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const ws = resolve(process.argv[2] || '.');

function eq(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

const cases = [
  { in: '1,4,9', out: [1, 4, 9] },
  { in: '11-13', out: [11, 12, 13] },
  { in: '1-5,8,11-13', out: [1, 2, 3, 4, 5, 8, 11, 12, 13] },
  { in: ' 1 , 4 ', out: [1, 4] },
  { in: '3,1,2,2', out: [1, 2, 3] },
  { in: '', out: [] },
  { in: '7', out: [7] },
];
const throwCases = ['1-', 'a', '1-2-3', '5-1'];

const fails = [];
let parseRange;
try {
  const mod = await import(pathToFileURL(join(ws, 'solution.mjs')).href);
  parseRange = mod.default;
  if (typeof parseRange !== 'function') throw new Error('default export is not a function');
} catch (e) {
  console.error('ACCEPT FAIL: cannot load solution.mjs default export: ' + e.message);
  process.exit(1);
}

for (const c of cases) {
  let got;
  try { got = parseRange(c.in); } catch (e) { fails.push(`parseRange(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (!eq(got, c.out)) fails.push(`parseRange(${JSON.stringify(c.in)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(c.out)}`);
}
for (const t of throwCases) {
  let threw = false;
  try { parseRange(t); } catch { threw = true; }
  if (!threw) fails.push(`parseRange(${JSON.stringify(t)}) should have thrown but did not`);
}

if (fails.length) {
  console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
