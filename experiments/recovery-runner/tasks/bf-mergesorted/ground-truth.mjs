// HIDDEN ground-truth for mergeSorted — includes CROSS-ARRAY equal keys (a key present in both
// `a` and `b`), which expose a bug that drops one record when keys tie across the inputs. Also
// checks total length === a.length + b.length and stability (a-before-b on ties). Disjoint from
// the (disjoint-key-set) visible acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function rec(key, value) { return { key, value }; }
function keys(arr) { return arr.map((r) => r.key); }
function vals(arr) { return arr.map((r) => r.value); }
function eq(x, y) { return JSON.stringify(x) === JSON.stringify(y); }

const cases = [
  {
    name: 'single cross-array tie',
    a: [rec(1, 'a1'), rec(2, 'a2')],
    b: [rec(2, 'b2'), rec(3, 'b3')],
    keys: [1, 2, 2, 3],
    vals: ['a1', 'a2', 'b2', 'b3'], // stable: a's 2 before b's 2
  },
  {
    name: 'tie at the very start',
    a: [rec(5, 'a5')],
    b: [rec(5, 'b5')],
    keys: [5, 5],
    vals: ['a5', 'b5'],
  },
  {
    name: 'multiple cross-array ties',
    a: [rec(1, 'a1'), rec(2, 'a2'), rec(2, 'a2b'), rec(4, 'a4')],
    b: [rec(2, 'b2'), rec(2, 'b2b'), rec(4, 'b4'), rec(5, 'b5')],
    keys: [1, 2, 2, 2, 2, 4, 4, 5],
    vals: ['a1', 'a2', 'a2b', 'b2', 'b2b', 'a4', 'b4', 'b5'],
  },
  {
    name: 'tie at the boundary tail',
    a: [rec(1, 'a1'), rec(9, 'a9')],
    b: [rec(0, 'b0'), rec(9, 'b9')],
    keys: [0, 1, 9, 9],
    vals: ['b0', 'a1', 'a9', 'b9'],
  },
  // correct-on-both controls (disjoint key sets — match acceptance behavior):
  {
    name: 'control: disjoint interleave',
    a: [rec(1, 'a1'), rec(3, 'a3')],
    b: [rec(2, 'b2'), rec(4, 'b4')],
    keys: [1, 2, 3, 4],
    vals: ['a1', 'b2', 'a3', 'b4'],
  },
  {
    name: 'control: empty b',
    a: [rec(7, 'a7')],
    b: [],
    keys: [7],
    vals: ['a7'],
  },
];

let mergeSorted;
try { mergeSorted = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof mergeSorted !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let out;
  try { out = mergeSorted(c.a, c.b); } catch (e) { fails.push(`${c.name}: threw ${e.message}`); continue; }
  const expectedLen = c.a.length + c.b.length;
  if (!Array.isArray(out)) { fails.push(`${c.name}: result not an array`); continue; }
  if (out.length !== expectedLen) { fails.push(`${c.name}: length ${out.length}, expected a.length+b.length = ${expectedLen}`); continue; }
  if (!eq(keys(out), c.keys)) fails.push(`${c.name}: keys ${JSON.stringify(keys(out))}, expected ${JSON.stringify(c.keys)}`);
  if (!eq(vals(out), c.vals)) fails.push(`${c.name}: vals ${JSON.stringify(vals(out))}, expected ${JSON.stringify(c.vals)}`);
}

if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
