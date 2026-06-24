// HIDDEN ground-truth for createLRU — exercises the case where a get() must refresh recency:
// access the oldest entry, then overflow; the just-accessed entry must be PROTECTED and the
// next-oldest evicted. Also checks keys() ordering after a get(). Disjoint from the (put-only-
// recency) visible acceptance. Includes correct-on-both controls (put-driven recency only).
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
function eq(x, y) { return JSON.stringify(x) === JSON.stringify(y); }

let createLRU;
try { createLRU = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof createLRU !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
let checks = 0;
function check(name, cond) { checks++; if (!cond) fails.push(name); }

// Core exposing case: get() on the oldest must bump it so a later overflow evicts the NEXT oldest.
{
  const c = createLRU(3);
  c.put('a', 1); c.put('b', 2); c.put('c', 3); // LRU..MRU: a, b, c
  const v = c.get('a');                         // a becomes MRU -> LRU..MRU: b, c, a
  check('get returns a', v === 1);
  c.put('d', 4);                                // overflow -> evict LRU = 'b'
  check('get bumped a (a kept)', c.has('a') === true);
  check('next-oldest b evicted', c.has('b') === false);
  check('c and d kept', c.has('c') && c.has('d'));
}

// keys() ordering must reflect a get()-driven bump.
{
  const c = createLRU(3);
  c.put('x', 1); c.put('y', 2); c.put('z', 3); // x, y, z
  c.get('x');                                   // -> y, z, x
  check('keys reflect get bump', eq(c.keys(), ['y', 'z', 'x']));
}

// Repeated get keeps a hot entry alive across several overflows.
{
  const c = createLRU(2);
  c.put('p', 1); c.put('q', 2); // p, q
  c.get('p');                   // -> q, p
  c.put('r', 3);                // evict q -> p, r
  check('hot p survived overflow', c.has('p') === true);
  check('cold q evicted', c.has('q') === false);
  c.get('p');                   // -> r, p
  c.put('s', 4);                // evict r -> p, s
  check('hot p survived again', c.has('p') === true);
  check('cold r evicted', c.has('r') === false);
}

// correct-on-both controls (recency driven by put only — same as acceptance):
{
  const c = createLRU(3);
  c.put('a', 1); c.put('b', 2); c.put('c', 3);
  c.put('d', 4); // evict a (no get involved)
  check('control: evict a', !c.has('a') && c.has('b') && c.has('c') && c.has('d'));
  check('control: keys order', eq(c.keys(), ['b', 'c', 'd']));
}

if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + checks + ' held-out checks');
process.exit(0);
