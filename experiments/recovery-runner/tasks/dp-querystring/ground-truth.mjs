// HIDDEN ground-truth for parseQuery — exercises REPEATED keys (must collect into an array in
// order of appearance), which the visible acceptance never touches. Plus correct-on-both controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

let parseQuery;
try {
  parseQuery = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default;
  if (typeof parseQuery !== 'function') throw new Error('default not a function');
} catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const cases = [
  // --- BUG-EXPOSING: repeated keys collect into an array in order ---
  { in: 'a=1&a=2',           out: { a: ['1', '2'] } },
  { in: 'tag=a&tag=b&tag=c', out: { tag: ['a', 'b', 'c'] } },
  { in: 'x=1&y=9&x=2',       out: { x: ['1', '2'], y: '9' } },
  { in: 'k=a&k=&k=c',        out: { k: ['a', '', 'c'] } },
  { in: 'id=1&id=2&id=3&id=4', out: { id: ['1', '2', '3', '4'] } },
  // --- controls (correct on both reference and a clobber-bug payload) ---
  { in: 'a=1&b=2',           out: { a: '1', b: '2' } },
  { in: 'name=John+Doe',     out: { name: 'John Doe' } },
  { in: 'flag&x=1',          out: { flag: '', x: '1' } },
];

const fails = [];
let checks = 0;
for (const c of cases) {
  checks++;
  let g;
  try { g = parseQuery(c.in); }
  catch (e) { fails.push(`parseQuery(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (!deepEqual(g, c.out)) {
    fails.push(`parseQuery(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
  }
}

if (fails.length) {
  console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('GROUND-TRUTH PASS: ' + checks + ' held-out checks');
process.exit(0);
