// Visible acceptance for deepMerge. Validated vs reference.
// NOTE: NO case here merges an array that is present in BOTH target and source at the
// same key, so an array-merge bug (clobber instead of concat) is invisible to it.
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
} catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
let checks = 0;

function expect(desc, got, want) {
  checks++;
  if (!deepEqual(got, want)) {
    fails.push(`${desc}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}

// 1. recursive object merge
expect('nested object merge',
  deepMerge({ a: 1, b: { x: 1 } }, { b: { y: 2 }, c: 3 }),
  { a: 1, b: { x: 1, y: 2 }, c: 3 });

// 2. scalar source wins
expect('scalar overwrite',
  deepMerge({ a: 1, b: 2 }, { b: 9 }),
  { a: 1, b: 9 });

// 3. undefined source skipped
expect('undefined skipped',
  deepMerge({ a: 1 }, { a: undefined, b: 2 }),
  { a: 1, b: 2 });

// 4. explicit null overwrites
expect('null overwrites',
  deepMerge({ a: 1 }, { a: null }),
  { a: null });

// 5. deeply nested object recursion
expect('deep nested',
  deepMerge({ a: { b: { c: 1 } } }, { a: { b: { d: 2 }, e: 3 } }),
  { a: { b: { c: 1, d: 2 }, e: 3 } });

// 6. type mismatch object vs scalar -> source wins
expect('object replaced by scalar',
  deepMerge({ a: { x: 1 } }, { a: 5 }),
  { a: 5 });

// 7. array present only in SOURCE (no merge path) -> carried over
expect('source-only array',
  deepMerge({ a: 1 }, { tags: [1, 2, 3] }),
  { a: 1, tags: [1, 2, 3] });

// 8. array present only in TARGET (no merge path) -> carried over
expect('target-only array',
  deepMerge({ tags: ['a', 'b'] }, { a: 1 }),
  { tags: ['a', 'b'], a: 1 });

// 9. array vs scalar at same key -> source (scalar) wins, no concat path
expect('array replaced by scalar',
  deepMerge({ a: [1, 2] }, { a: 'x' }),
  { a: 'x' });

// 10. scalar vs array at same key -> source (array) wins, no concat path
expect('scalar replaced by array',
  deepMerge({ a: 1 }, { a: [9] }),
  { a: [9] });

// 11. immutability: inputs untouched
{
  const t = { a: 1, b: { x: 1 } };
  const s = { b: { y: 2 } };
  const tCopy = JSON.parse(JSON.stringify(t));
  const sCopy = JSON.parse(JSON.stringify(s));
  deepMerge(t, s);
  expect('target not mutated', t, tCopy);
  expect('source not mutated', s, sCopy);
}

// 12. result independent of nested source object (no shared ref on merged container)
{
  const t = { a: { x: 1 } };
  const s = { a: { y: 2 } };
  const r = deepMerge(t, s);
  r.a.x = 999;
  checks++;
  if (t.a.x !== 1) fails.push('mutating result leaked into target nested object');
}

if (fails.length) {
  console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('ACCEPT PASS: ' + checks + ' checks');
process.exit(0);
