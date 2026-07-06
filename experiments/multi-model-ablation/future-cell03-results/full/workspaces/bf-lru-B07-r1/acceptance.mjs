// Visible acceptance for createLRU. Validated vs reference (S4).
// NOTE: recency here is driven ONLY by put() (and update-via-put). No test asserts that a
// get() refreshed recency: gets are used purely to read values, and no eviction or keys()-order
// assertion follows a get() that would have moved an entry. So a bug where get() fails to bump
// recency is invisible here.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
function eq(x, y) { return JSON.stringify(x) === JSON.stringify(y); }

let createLRU;
try { createLRU = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof createLRU !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
let checks = 0;
function check(name, cond) { checks++; if (!cond) fails.push(name); }

// basic put/get
{
  const c = createLRU(3);
  c.put('a', 1); c.put('b', 2); c.put('c', 3);
  check('get a', c.get('a') === 1);
  check('get b', c.get('b') === 2);
  check('get missing', c.get('zzz') === undefined);
  check('size 3', c.size === 3);
  check('has a', c.has('a') === true);
  check('has missing', c.has('zzz') === false);
}

// put-driven eviction (no get involved): inserting d evicts a (the oldest by insertion).
{
  const c = createLRU(3);
  c.put('a', 1); c.put('b', 2); c.put('c', 3);
  c.put('d', 4); // overflow -> evict 'a'
  check('evicted a', c.has('a') === false);
  check('kept b c d', c.has('b') && c.has('c') && c.has('d'));
  check('size still 3', c.size === 3);
  check('keys lru order after puts', eq(c.keys(), ['b', 'c', 'd']));
}

// put on existing key refreshes recency (no eviction), and never grows past capacity.
{
  const c = createLRU(3);
  c.put('a', 1); c.put('b', 2); c.put('c', 3);
  c.put('a', 11); // update + bump 'a' to MRU
  check('updated value', c.get('a') === 11);
  check('size after update', c.size === 3);
  // now 'b' is LRU; inserting 'd' should evict 'b'
  c.put('d', 4);
  check('update protected a, evicted b', c.has('a') && !c.has('b') && c.has('c') && c.has('d'));
}

// capacity 1
{
  const c = createLRU(1);
  c.put('x', 1);
  c.put('y', 2); // evict x
  check('cap1 evicted x', !c.has('x') && c.has('y'));
  check('cap1 size', c.size === 1);
}

// error cases
for (const bad of [0, -1, 2.5, 'three', null, undefined]) {
  checks++;
  let threw = false;
  try { createLRU(bad); } catch { threw = true; }
  if (!threw) fails.push(`createLRU(${JSON.stringify(bad)}) should throw`);
}

if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + checks + ' checks');
process.exit(0);
