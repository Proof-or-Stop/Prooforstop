// HIDDEN ground-truth for convert() — includes sub-zero Celsius conversions TO Fahrenheit,
// which expose a dropped freezing-point offset. Disjoint from the visible acceptance
// (which only converts non-negative Celsius to Fahrenheit), plus correct-on-both controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  // EXPOSING: negative Celsius -> Fahrenheit (offset must still apply)
  { args: [-40, 'c', 'f'], out: -40 },     // famous crossover; with bug -> -72
  { args: [-10, 'c', 'f'], out: 14 },      // with bug -> -18
  { args: [-1, 'c', 'f'], out: 30.2 },     // with bug -> -1.8
  // EXPOSING via K -> F where Celsius goes sub-zero
  { args: [250, 'k', 'f'], out: 250 - 273.15, _viaC: true },

  // correct-on-both controls
  { args: [0, 'c', 'f'], out: 32 },
  { args: [100, 'c', 'f'], out: 212 },
  { args: [1, 'm', 'cm'], out: 100 },
  { args: [1, 'lb', 'g'], out: 453.59237 },
];

// fix the K->F expected value (Celsius = -23.15 -> F = -23.15*9/5+32 = -9.67)
cases[3] = { args: [250, 'k', 'f'], out: (250 - 273.15) * 9 / 5 + 32 };

let convert;
try { convert = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof convert !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g;
  try { g = convert(...c.args); } catch (e) { fails.push(`convert(${JSON.stringify(c.args)}) threw: ${e.message}`); continue; }
  if (!close(g, c.out)) fails.push(`convert(${JSON.stringify(c.args)}) = ${g}, expected ${c.out}`);
}
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
