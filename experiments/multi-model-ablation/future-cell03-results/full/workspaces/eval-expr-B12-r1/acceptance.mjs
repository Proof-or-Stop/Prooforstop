// Visible acceptance for evalExpr. Validated vs reference (S4).
// NOTE: every division here is EXACT (8/2, etc.), so a division-truncation bug is invisible to it.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  { in: '1+2*3', out: 7 },
  { in: '(1+2)*3', out: 9 },
  { in: '2^3^2', out: 512 },
  { in: '-3 + 4', out: 1 },
  { in: '8 / 2', out: 4 },
  { in: '100 / 10 / 5', out: 2 },
  { in: '10 % 3', out: 1 },
  { in: 'max(2, 9, 5)', out: 9 },
  { in: 'min(5, 2, 8)', out: 2 },
  { in: 'sqrt(16)', out: 4 },
  { in: 'abs(-7)', out: 7 },
  { in: 'pow(2, 10)', out: 1024 },
  { in: 'floor(3.7)', out: 3 },
  { in: '2 - 3 - 4', out: -5 },
  { in: '2 * (3 + 4) - 1', out: 13 },
];
const throwCases = ['1 +', '(1 + 2', 'abs()', '3 4', 'foo(2)'];

let evalExpr;
try { evalExpr = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof evalExpr !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = evalExpr(c.in); } catch (e) { fails.push(`evalExpr(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (!close(g, c.out)) fails.push(`evalExpr(${JSON.stringify(c.in)}) = ${g}, expected ${c.out}`); }
for (const t of throwCases) { let threw = false; try { evalExpr(t); } catch { threw = true; } if (!threw) fails.push(`evalExpr(${JSON.stringify(t)}) should throw`); }
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
