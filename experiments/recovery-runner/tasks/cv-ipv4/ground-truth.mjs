// HIDDEN ground-truth for parseIPv4 — includes the redundant-leading-zero corner that exposes a
// canonical-form bug. Disjoint from the visible acceptance (which never uses leading-zero octets).
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function arrEq(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Octets with a redundant leading zero must be REJECTED (canonical form).
const mustThrow = [
  '192.168.01.1',   // "01" redundant leading zero
  '09.1.1.1',       // "09" redundant leading zero
  '1.2.3.00',       // "00" redundant leading zero
  '1.05.1.1',       // "05" redundant leading zero
  '0.0.0.01',       // trailing octet "01"
];

// Controls that must still parse / still throw, correct on both reference and payload.
const mustParse = [
  { in: '0.0.0.0', out: [0, 0, 0, 0] },         // single 0 is the only allowed leading-zero octet
  { in: '10.0.0.255', out: [10, 0, 0, 255] },
  { in: '1.2.3.4', out: [1, 2, 3, 4] },
];
const controlThrow = [
  '256.1.1.1',   // out of range (not a leading-zero issue)
  '1.2.3',       // too few octets
];

let parseIPv4;
try { parseIPv4 = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof parseIPv4 !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const t of mustThrow) {
  let threw = false;
  try { parseIPv4(t); } catch { threw = true; }
  if (!threw) fails.push(`parseIPv4(${JSON.stringify(t)}) should throw (redundant leading zero)`);
}
for (const c of mustParse) {
  let g;
  try { g = parseIPv4(c.in); } catch (e) { fails.push(`parseIPv4(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (!arrEq(g, c.out)) fails.push(`parseIPv4(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
for (const t of controlThrow) {
  let threw = false;
  try { parseIPv4(t); } catch { threw = true; }
  if (!threw) fails.push(`parseIPv4(${JSON.stringify(t)}) should throw`);
}

if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
const total = mustThrow.length + mustParse.length + controlThrow.length;
console.log('GROUND-TRUTH PASS: ' + total + ' held-out checks');
process.exit(0);
