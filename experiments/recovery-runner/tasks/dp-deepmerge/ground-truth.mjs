// HIDDEN ground-truth for deepMerge — exercises the BOTH-SIDES-ARRAY merge path (arrays must
// CONCATENATE), which the visible acceptance never touches. Plus correct-on-both controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

let deepMerge;
try {
  deepMerge = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default;
  if (typeof deepMerge !== 'function') throw new Error('default not a function');
} catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
let checks = 0;

function expect(desc, got, want) {
  checks++;
  if (!deepEqual(got, want)) {
    fails.push(`${desc}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}

// --- BUG-EXPOSING: arrays at the same key must CONCATENATE (target ++ source) ---
expect('both arrays concat',
  deepMerge({ tags: ['a', 'b'] }, { tags: ['c'] }),
  { tags: ['a', 'b', 'c'] });

expect('numeric arrays concat',
  deepMerge({ xs: [1, 2] }, { xs: [3, 4] }),
  { xs: [1, 2, 3, 4] });

expect('nested array concat',
  deepMerge({ a: { list: [1] } }, { a: { list: [2, 3] } }),
  { a: { list: [1, 2, 3] } });

expect('array concat alongside object merge',
  deepMerge({ a: { x: 1 }, items: ['p'] }, { a: { y: 2 }, items: ['q', 'r'] }),
  { a: { x: 1, y: 2 }, items: ['p', 'q', 'r'] });

// --- controls (correct on both reference and a clobber-bug payload) ---
expect('control: nested object merge',
  deepMerge({ a: 1, b: { x: 1 } }, { b: { y: 2 }, c: 3 }),
  { a: 1, b: { x: 1, y: 2 }, c: 3 });

expect('control: scalar overwrite',
  deepMerge({ a: 1 }, { a: 9 }),
  { a: 9 });

expect('control: source-only array carried',
  deepMerge({ a: 1 }, { tags: [1, 2] }),
  { a: 1, tags: [1, 2] });

if (fails.length) {
  console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('GROUND-TRUTH PASS: ' + checks + ' held-out checks');
process.exit(0);
