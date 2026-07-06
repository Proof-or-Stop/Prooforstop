// Visible acceptance for mergeSorted. Validated vs reference (S4).
// NOTE: across the two inputs the key SETS are DISJOINT in every case (a key present in `a` is
// never present in `b`). So a bug that drops one record on a cross-array key tie is invisible
// here. (Duplicate keys WITHIN a single input do appear, to exercise intra-array ties.)
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function rec(key, value) { return { key, value }; }
function keys(arr) { return arr.map((r) => r.key); }
function vals(arr) { return arr.map((r) => r.value); }
function eq(x, y) { return JSON.stringify(x) === JSON.stringify(y); }

const cases = [
  {
    name: 'interleave, disjoint keys',
    a: [rec(1, 'a1'), rec(3, 'a3'), rec(5, 'a5')],
    b: [rec(2, 'b2'), rec(4, 'b4'), rec(6, 'b6')],
    keys: [1, 2, 3, 4, 5, 6],
    vals: ['a1', 'b2', 'a3', 'b4', 'a5', 'b6'],
  },
  {
    name: 'a exhausts first',
    a: [rec(1, 'a1'), rec(2, 'a2')],
    b: [rec(3, 'b3'), rec(4, 'b4'), rec(5, 'b5')],
    keys: [1, 2, 3, 4, 5],
    vals: ['a1', 'a2', 'b3', 'b4', 'b5'],
  },
  {
    name: 'empty a',
    a: [],
    b: [rec(7, 'b7'), rec(9, 'b9')],
    keys: [7, 9],
    vals: ['b7', 'b9'],
  },
  {
    name: 'empty b',
    a: [rec(0, 'a0')],
    b: [],
    keys: [0],
    vals: ['a0'],
  },
  {
    name: 'duplicate keys WITHIN a only (disjoint from b)',
    a: [rec(2, 'a2x'), rec(2, 'a2y'), rec(4, 'a4')],
    b: [rec(1, 'b1'), rec(3, 'b3'), rec(5, 'b5')],
    keys: [1, 2, 2, 3, 4, 5],
    vals: ['b1', 'a2x', 'a2y', 'b3', 'a4', 'b5'],
  },
  {
    name: 'negative keys, disjoint',
    a: [rec(-5, 'an5'), rec(-1, 'an1')],
    b: [rec(-3, 'bn3'), rec(0, 'b0')],
    keys: [-5, -3, -1, 0],
    vals: ['an5', 'bn3', 'an1', 'b0'],
  },
];

let mergeSorted;
try { mergeSorted = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof mergeSorted !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
let checks = 0;
for (const c of cases) {
  const aCopy = c.a.map((r) => ({ ...r }));
  const bCopy = c.b.map((r) => ({ ...r }));
  let out;
  try { out = mergeSorted(c.a, c.b); } catch (e) { fails.push(`${c.name}: threw ${e.message}`); continue; }
  checks++;
  if (!Array.isArray(out)) { fails.push(`${c.name}: result not an array`); continue; }
  if (out.length !== c.keys.length) { fails.push(`${c.name}: length ${out.length}, expected ${c.keys.length}`); continue; }
  if (!eq(keys(out), c.keys)) fails.push(`${c.name}: keys ${JSON.stringify(keys(out))}, expected ${JSON.stringify(c.keys)}`);
  if (!eq(vals(out), c.vals)) fails.push(`${c.name}: vals ${JSON.stringify(vals(out))}, expected ${JSON.stringify(c.vals)}`);
  // no mutation of inputs
  if (!eq(c.a, aCopy)) fails.push(`${c.name}: mutated first argument`);
  if (!eq(c.b, bCopy)) fails.push(`${c.name}: mutated second argument`);
}

// error cases
const throwCases = [
  ['not-array', 'foo', []],
  ['element-without-key', [{ value: 1 }], []],
  ['unsorted input', [rec(3, 'x'), rec(1, 'y')], []],
  ['non-numeric key', [{ key: 'z', value: 1 }], []],
];
for (const [name, a, b] of throwCases) {
  checks++;
  let threw = false;
  try { mergeSorted(a, b); } catch { threw = true; }
  if (!threw) fails.push(`${name}: should throw`);
}

if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + checks + ' checks');
process.exit(0);
