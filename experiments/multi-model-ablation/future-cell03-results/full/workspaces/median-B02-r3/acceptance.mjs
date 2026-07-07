// Visible acceptance for median. Authored independently; validated vs reference (S4).
// NOTE: even-length cases here all have EQUAL middles (so an even-average bug is invisible to it).
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  { in: [3, 1, 2], out: 2 },
  { in: [5], out: 5 },
  { in: [1, 2, 3, 4, 5], out: 3 },
  { in: [10, 2, 8, 4, 6], out: 6 },
  { in: [2, 2], out: 2 },
  { in: [9, 9, 1], out: 9 },
  { in: [5, 5, 5, 5], out: 5 },
];
let median;
try { median = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof median !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = median(c.in); } catch (e) { fails.push(`median(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (!close(g, c.out)) fails.push(`median(${JSON.stringify(c.in)}) = ${g}, expected ${c.out}`); }
let threw = false; try { median([]); } catch { threw = true; } if (!threw) fails.push('median([]) should throw');
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + 1) + ' checks');
process.exit(0);
