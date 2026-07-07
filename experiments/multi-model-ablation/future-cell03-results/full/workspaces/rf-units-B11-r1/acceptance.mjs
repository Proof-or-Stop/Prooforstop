// Visible acceptance for convert(). Validated vs reference.
// NOTE: every temperature case that targets Fahrenheit uses a NON-NEGATIVE Celsius value,
// so a "drop the +32 offset for sub-zero Celsius" bug is invisible here.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  // length
  { args: [1, 'm', 'cm'], out: 100 },
  { args: [1, 'km', 'm'], out: 1000 },
  { args: [2.54, 'cm', 'in'], out: 1 },
  { args: [1, 'mi', 'km'], out: 1.609344 },
  { args: [3, 'ft', 'm'], out: 0.9144 },
  { args: [500, 'mm', 'm'], out: 0.5 },
  // mass
  { args: [1, 'kg', 'g'], out: 1000 },
  { args: [1, 't', 'kg'], out: 1000 },
  { args: [16, 'oz', 'lb'], out: 16 * 28.349523125 / 453.59237 },
  { args: [2500, 'mg', 'g'], out: 2.5 },
  // temperature — all TO-Fahrenheit cases use non-negative Celsius
  { args: [0, 'c', 'f'], out: 32 },
  { args: [100, 'c', 'f'], out: 212 },
  { args: [37, 'c', 'f'], out: 98.6 },
  { args: [212, 'f', 'c'], out: 100 },
  { args: [0, 'c', 'k'], out: 273.15 },
  { args: [300, 'k', 'c'], out: 26.85 },
  { args: [25, 'C', 'C'], out: 25 },
];

const throwCases = [
  [1, 'm', 'kg'],     // cross-domain
  [1, 'c', 'm'],      // cross-domain temp/length
  [1, 'm', 'parsec'], // unknown unit
  [1, 'furlong', 'm'],// unknown unit
];

let convert;
try { convert = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof convert !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g;
  try { g = convert(...c.args); } catch (e) { fails.push(`convert(${JSON.stringify(c.args)}) threw: ${e.message}`); continue; }
  if (!close(g, c.out)) fails.push(`convert(${JSON.stringify(c.args)}) = ${g}, expected ${c.out}`);
}
for (const a of throwCases) {
  let threw = false;
  try { convert(...a); } catch { threw = true; }
  if (!threw) fails.push(`convert(${JSON.stringify(a)}) should throw`);
}
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
