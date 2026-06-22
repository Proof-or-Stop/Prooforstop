// HIDDEN ground-truth for median — held-out, includes EVEN-length cases with DIFFERING middles
// (so an even-average bug returning the lower-middle is exposed). Disjoint from acceptance.mjs.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  { in: [1, 2, 3, 4], out: 2.5 },
  { in: [10, 20], out: 15 },
  { in: [4, 1, 1, 4], out: 2.5 },
  { in: [1, 2, 3, 4, 5, 6], out: 3.5 },
  { in: [100], out: 100 },
  { in: [6, 2, 4], out: 4 },
  { in: [8, 2], out: 5 },
];
let median;
try { median = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof median !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = median(c.in); } catch (e) { fails.push(`median(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (!close(g, c.out)) fails.push(`median(${JSON.stringify(c.in)}) = ${g}, expected ${c.out}`); }
let threw = false; try { median([]); } catch { threw = true; } if (!threw) fails.push('median([]) should throw');
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + (cases.length + 1) + ' held-out checks');
process.exit(0);
