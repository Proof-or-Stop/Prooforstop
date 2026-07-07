// Visible acceptance for validateEmail. Validated vs reference.
// NOTE: none of the VALID local-parts here use plus-addressing ('+'), and none of the INVALID
// cases hinge on whether '+' is allowed. So a bug that drops '+' from the allowed local-part
// character set is invisible to this test.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const validCases = [
  'user@example.com',
  'john.doe@example.co.uk',
  'a@b.io',
  'first.last@sub.domain.org',
  "o'brien@mail.com",
  'user_name@example.com',
  'user-name@example-host.com',
  'x1y2z3@numbers123.net',
  'a.b.c@d.e.fg',
];

const invalidCases = [
  'plainaddress',           // no @
  'two@@example.com',       // two @
  '@example.com',           // empty local
  'user@',                  // empty domain
  'user@localhost',         // domain has no dot
  '.user@example.com',      // leading dot in local
  'user.@example.com',      // trailing dot in local
  'us..er@example.com',     // consecutive dots in local
  'user@exam ple.com',      // space in domain
  'user@example.c',         // TLD too short
  'user@example.123',       // numeric TLD
  'user@-example.com',      // label starts with hyphen
  'user@example-.com',      // label ends with hyphen
];

let validateEmail;
try { validateEmail = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof validateEmail !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of validCases) {
  let g; try { g = validateEmail(c); } catch (e) { fails.push(`validateEmail(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== true) fails.push(`validateEmail(${JSON.stringify(c)}) = ${g}, expected true`);
}
for (const c of invalidCases) {
  let g; try { g = validateEmail(c); } catch (e) { fails.push(`validateEmail(${JSON.stringify(c)}) threw: ${e.message}`); continue; }
  if (g !== false) fails.push(`validateEmail(${JSON.stringify(c)}) = ${g}, expected false`);
}

if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (validCases.length + invalidCases.length) + ' checks');
process.exit(0);
