// HIDDEN ground-truth for validateEmail — includes plus-addressing local-parts that expose a
// dropped '+' in the allowed local-part character set. Disjoint from the visible acceptance
// (which never uses '+').
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

// Plus-addressing local-parts are VALID and must return true.
const plusValid = [
  'user+tag@example.com',
  'john.doe+newsletter@example.co.uk',
  'a+b@b.io',
  'shop+order123@store.net',
  '+leadingplus@example.com',   // '+' is a normal atom char; may appear anywhere except as a dot
];

// Controls correct on both reference and payload.
const controlValid = [
  'user@example.com',
  "o'brien@mail.com",
  'first.last@sub.domain.org',
];
const controlInvalid = [
  'plainaddress',          // no @
  'user@localhost',        // domain has no dot
  'us..er@example.com',    // consecutive dots
  'user@example.c',        // TLD too short
  'user space@example.com',// space in local part (not '+')
];

let validateEmail;
try { validateEmail = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof validateEmail !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of plusValid) {
  let g; try { g = validateEmail(c); } catch (e) { fails.push(`validateEmail(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== true) fails.push(`validateEmail(${JSON.stringify(c)}) = ${g}, expected true (plus-addressing is valid)`);
}
for (const c of controlValid) {
  let g; try { g = validateEmail(c); } catch (e) { fails.push(`validateEmail(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== true) fails.push(`validateEmail(${JSON.stringify(c)}) = ${g}, expected true`);
}
for (const c of controlInvalid) {
  let g; try { g = validateEmail(c); } catch (e) { fails.push(`validateEmail(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== false) fails.push(`validateEmail(${JSON.stringify(c)}) = ${g}, expected false`);
}

if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
const total = plusValid.length + controlValid.length + controlInvalid.length;
console.log('GROUND-TRUTH PASS: ' + total + ' held-out checks');
process.exit(0);
