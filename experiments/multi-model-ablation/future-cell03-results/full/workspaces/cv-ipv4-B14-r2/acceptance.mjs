// Visible acceptance for parseIPv4. Validated vs reference.
// NOTE: every VALID case uses octets with no leading zero, and every INVALID case fails for a
// reason OTHER than a redundant leading zero (range, octet count, non-digit, empty octet). So a
// bug that accepts redundant-leading-zero octets is invisible to this test.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function arrEq(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const validCases = [
  { in: '192.168.0.1', out: [192, 168, 0, 1] },
  { in: '0.0.0.0', out: [0, 0, 0, 0] },
  { in: '255.255.255.255', out: [255, 255, 255, 255] },
  { in: '10.20.30.40', out: [10, 20, 30, 40] },
  { in: '8.8.8.8', out: [8, 8, 8, 8] },
  { in: '1.2.3.4', out: [1, 2, 3, 4] },
  { in: '127.0.0.1', out: [127, 0, 0, 1] },
];

const invalidCases = [
  '256.1.1.1',      // out of range
  '1.2.3.4.5',      // too many octets
  '1.2.3',          // too few octets
  '1.2.3.',         // trailing dot -> empty octet
  '1..2.3',         // doubled dot -> empty octet
  'a.b.c.d',        // non-digit
  '1.2.3.999',      // out of range
  '300.1.1.1',      // out of range
  '1.2.3.4 ',       // interior/trailing whitespace
];

let parseIPv4;
try { parseIPv4 = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof parseIPv4 !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of validCases) {
  let g;
  try { g = parseIPv4(c.in); } catch (e) { fails.push(`parseIPv4(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (!arrEq(g, c.out)) fails.push(`parseIPv4(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
for (const t of invalidCases) {
  let threw = false;
  try { parseIPv4(t); } catch { threw = true; }
  if (!threw) fails.push(`parseIPv4(${JSON.stringify(t)}) should throw`);
}

if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (validCases.length + invalidCases.length) + ' checks');
process.exit(0);
