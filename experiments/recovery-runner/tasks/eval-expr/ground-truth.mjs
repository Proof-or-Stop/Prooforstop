// HIDDEN ground-truth for evalExpr — includes FRACTIONAL divisions that expose a division-
// truncation bug. Disjoint from the (exact-division-only) visible acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  { in: '7 / 2', out: 3.5 },
  { in: '1 / 4', out: 0.25 },
  { in: '10 / 3', out: 10 / 3 },
  { in: '(1 + 2) / 4', out: 0.75 },
  { in: '9 / 2 + 1', out: 5.5 },
  // correct-on-both controls:
  { in: '3*3 + 1', out: 10 },
  { in: '2^10', out: 1024 },
  { in: 'ceil(2.1)', out: 3 },
  { in: 'max(1, 4, 2) - min(3, 1)', out: 3 },
];
let evalExpr;
try { evalExpr = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof evalExpr !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = evalExpr(c.in); } catch (e) { fails.push(`evalExpr(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (!close(g, c.out)) fails.push(`evalExpr(${JSON.stringify(c.in)}) = ${g}, expected ${c.out}`); }
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
