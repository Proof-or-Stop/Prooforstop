// HIDDEN ground-truth for validateCardNumber — includes ODD-length digit strings that expose a
// position-parity bug in the Luhn doubling. Disjoint from the visible acceptance (even-length only).
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

// Odd-length numbers that are genuinely Luhn-VALID (must return true).
const oddValid = [
  '182',
  '18523',
  '185296308',
  '1852963074185',
  '109',
  '125',
];

// Odd-length numbers that are genuinely Luhn-INVALID (must return false).
const oddInvalid = [
  '104',
  '118',
  '123',
  '142',
  '183',
];

// Controls correct on both reference and payload (even length / malformed).
const controlValidEven = ['18', '4532015112830366'];
const controlInvalidEven = ['19', '4532015112830367'];
const controlThrow = ['12a4', '1', '1*2*3'];

let validate;
try { validate = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof validate !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of oddValid) {
  let g; try { g = validate(c); } catch (e) { fails.push(`validate(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== true) fails.push(`validate(${JSON.stringify(c)}) = ${g}, expected true (odd-length valid)`);
}
for (const c of oddInvalid) {
  let g; try { g = validate(c); } catch (e) { fails.push(`validate(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== false) fails.push(`validate(${JSON.stringify(c)}) = ${g}, expected false (odd-length invalid)`);
}
for (const c of controlValidEven) {
  let g; try { g = validate(c); } catch (e) { fails.push(`validate(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== true) fails.push(`validate(${JSON.stringify(c)}) = ${g}, expected true`);
}
for (const c of controlInvalidEven) {
  let g; try { g = validate(c); } catch (e) { fails.push(`validate(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== false) fails.push(`validate(${JSON.stringify(c)}) = ${g}, expected false`);
}
for (const t of controlThrow) {
  let threw = false; try { validate(t); } catch { threw = true; }
  if (!threw) fails.push(`validate(${JSON.stringify(t)}) should throw`);
}

if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
const total = oddValid.length + oddInvalid.length + controlValidEven.length + controlInvalidEven.length + controlThrow.length;
console.log('GROUND-TRUTH PASS: ' + total + ' held-out checks');
process.exit(0);
