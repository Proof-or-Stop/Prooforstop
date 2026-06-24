// HIDDEN ground-truth for roman() — includes ENCODE of the tens/hundreds subtractive magnitudes
// (40, 90, 400, 900 and numbers containing them), which expose the missing-subtractive-pairs bug.
// Disjoint from the visible acceptance (whose encode cases avoid those magnitudes), plus
// correct-on-both controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const encodeCases = [
  // EXPOSING: the four tens/hundreds subtractive forms
  [40, 'XL'],       // bug -> "XXXX"
  [90, 'XC'],       // bug -> "LXXXX"
  [400, 'CD'],      // bug -> "CCCC"
  [900, 'CM'],      // bug -> "DCCCC"
  [49, 'XLIX'],     // bug -> "XXXXIX"
  [99, 'XCIX'],     // bug -> "LXXXXIX"
  [1994, 'MCMXCIV'],// bug -> "MDCCCCLXXXXIV"
  [444, 'CDXLIV'],  // bug -> "CCCCXXXXIV"
  [3888, 'MMMDCCCLXXXVIII'], // control: no 4/9 tens or hundreds -> correct on both

  // correct-on-both controls
  [3, 'III'],
  [2023, 'MMXXIII'],
  [8, 'VIII'],
];

// validate must reject additive forms; with the bug, validate(canonical XL) returns false.
const validateCases = [
  ['XL', true],     // bug: decode->40, encode(40)->"XXXX" != "XL" -> false
  ['MCMXCIV', true],// bug -> false
  ['CD', true],     // bug -> false
];

let roman;
try { roman = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof roman !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const [n, exp] of encodeCases) {
  let g; try { g = roman('encode', n); } catch (e) { fails.push(`encode(${n}) threw: ${e.message}`); continue; }
  if (g !== exp) fails.push(`encode(${n}) = ${JSON.stringify(g)}, expected ${JSON.stringify(exp)}`);
}
for (const [s, exp] of validateCases) {
  let g; try { g = roman('validate', s); } catch (e) { fails.push(`validate(${JSON.stringify(s)}) threw: ${e.message}`); continue; }
  if (g !== exp) fails.push(`validate(${JSON.stringify(s)}) = ${g}, expected ${exp}`);
}
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + (encodeCases.length + validateCases.length) + ' held-out checks');
process.exit(0);
