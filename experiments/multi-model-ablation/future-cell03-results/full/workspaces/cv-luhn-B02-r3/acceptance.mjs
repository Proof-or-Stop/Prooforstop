// Visible acceptance for validateCardNumber. Validated vs reference.
// NOTE: every Luhn case here uses an EVEN-length digit string. A bug that doubles the wrong
// parity of positions still produces the correct answer for even-length numbers, so a
// parity/odd-length bug is invisible to this test.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const validEven = [
  '18',
  '18 59',
  '1852-98',
  '1852 9636',
  '1852 9630 7415',
  '4532 0151 1283 0366',
];

const invalidLuhn = [
  '19',
  '1850',
  '185299',
  '12345671',
  '4532015112830367',
];

const malformed = [
  'abcd',          // non-digit chars
  '12a4',          // embedded letter
  '1',             // length < 2
  '1*2*3*4',       // illegal separator
  '12345678901234567890', // length 20 > 19
];

let validate;
try { validate = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof validate !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of validEven) {
  let g;
  try { g = validate(c); } catch (e) { fails.push(`validate(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== true) fails.push(`validate(${JSON.stringify(c)}) = ${g}, expected true`);
}
for (const c of invalidLuhn) {
  let g;
  try { g = validate(c); } catch (e) { fails.push(`validate(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== false) fails.push(`validate(${JSON.stringify(c)}) = ${g}, expected false`);
}
for (const t of malformed) {
  let threw = false;
  try { validate(t); } catch { threw = true; }
  if (!threw) fails.push(`validate(${JSON.stringify(t)}) should throw`);
}

if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (validEven.length + invalidLuhn.length + malformed.length) + ' checks');
process.exit(0);
