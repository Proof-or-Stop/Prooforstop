// Visible acceptance for roman(). Validated vs reference.
// NOTE: every ENCODE case avoids the tens/hundreds subtractive magnitudes (40, 90, 400, 900),
// so an "additive XXXX/DCCCC instead of XL/CM" bug in encode is invisible here. Decode is exercised
// (decode is letter-driven and unaffected by the bug). validate cases avoid those magnitudes too.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const encodeCases = [
  [1, 'I'], [2, 'II'], [3, 'III'], [4, 'IV'], [5, 'V'],
  [8, 'VIII'], [9, 'IX'], [13, 'XIII'], [14, 'XIV'], [23, 'XXIII'],
  [38, 'XXXVIII'], [69, 'LXIX'], [100, 'C'], [101, 'CI'], [500, 'D'],
  [666, 'DCLXVI'], [1000, 'M'], [1888, 'MDCCCLXXXVIII'], [2023, 'MMXXIII'],
  [3, 'III'], [37, 'XXXVII'],
];

// decode is letter-driven and unaffected by the bug; safe to test subtractive forms here.
const decodeCases = [
  ['IV', 4], ['ix', 9], ['XL', 40], ['XC', 90], ['CD', 400], ['CM', 900],
  ['MCMXCIV', 1994], ['MMXXIII', 2023], ['III', 3],
];

const validateCases = [
  ['III', true], ['MMXXIII', true], ['IIII', false], ['IC', false], ['', false],
  ['MDCCCLXXXVIII', true], ['ABC', false],
];

const throwCases = [
  ['encode', 0], ['encode', 4000], ['encode', 3.5],
  ['decode', ''], ['decode', 'IZ'],
  ['bogus', 5],
];

let roman;
try { roman = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof roman !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const [n, exp] of encodeCases) {
  let g; try { g = roman('encode', n); } catch (e) { fails.push(`encode(${n}) threw: ${e.message}`); continue; }
  if (g !== exp) fails.push(`encode(${n}) = ${JSON.stringify(g)}, expected ${JSON.stringify(exp)}`);
}
for (const [s, exp] of decodeCases) {
  let g; try { g = roman('decode', s); } catch (e) { fails.push(`decode(${JSON.stringify(s)}) threw: ${e.message}`); continue; }
  if (g !== exp) fails.push(`decode(${JSON.stringify(s)}) = ${g}, expected ${exp}`);
}
for (const [s, exp] of validateCases) {
  let g; try { g = roman('validate', s); } catch (e) { fails.push(`validate(${JSON.stringify(s)}) threw: ${e.message}`); continue; }
  if (g !== exp) fails.push(`validate(${JSON.stringify(s)}) = ${g}, expected ${exp}`);
}
for (const [m, inp] of throwCases) {
  let threw = false; try { roman(m, inp); } catch { threw = true; }
  if (!threw) fails.push(`roman(${JSON.stringify(m)}, ${JSON.stringify(inp)}) should throw`);
}
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
const total = encodeCases.length + decodeCases.length + validateCases.length + throwCases.length;
console.log('ACCEPT PASS: ' + total + ' checks');
process.exit(0);
