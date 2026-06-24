// Visible acceptance for mapRange. Validated vs reference.
// NOTE: every output range here is SMALL (|outMax| <= 1000), so a 32-bit-truncation rounding bug
// (e.g. `Math.round(x) | 0`) stays invisible to it — the bug only bites when the rounded result
// exceeds the signed-32-bit range (~2.1e9).
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  { args: [5, 0, 10, 0, 100], out: 50 },
  { args: [0, 0, 10, 0, 100], out: 0 },
  { args: [10, 0, 10, 0, 100], out: 100 },
  { args: [-3, 0, 10, 0, 100], out: 0 },     // clamp low
  { args: [99, 0, 10, 0, 100], out: 100 },   // clamp high
  { args: [2.5, 0, 10, 0, 100], out: 25 },
  { args: [3, 0, 9, 0, 90], out: 30 },
  { args: [128, 0, 255, 0, 1000], out: 502 },// rounding (502.0 -> 502)
  { args: [1, 0, 3, 0, 100], out: 33 },      // 33.33 -> 33
  { args: [2, 0, 3, 0, 100], out: 67 },      // 66.67 -> 67
  // decreasing output range
  { args: [0, 0, 10, 100, 0], out: 100 },
  { args: [10, 0, 10, 100, 0], out: 0 },
  { args: [5, 0, 10, 100, 0], out: 50 },
];
const throwCases = [
  [NaN, 0, 10, 0, 100],
  [5, 0, 10, 0, Infinity],
  [5, 5, 5, 0, 100],         // inMin === inMax
  ['x', 0, 10, 0, 100],
];

let mapRange;
try { mapRange = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof mapRange !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = mapRange(...c.args); } catch (e) { fails.push(`mapRange(${c.args.join(', ')}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`mapRange(${c.args.join(', ')}) = ${g}, expected ${c.out}`); }
for (const a of throwCases) { let threw = false; try { mapRange(...a); } catch { threw = true; } if (!threw) fails.push(`mapRange(${a.join(', ')}) should throw`); }
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
