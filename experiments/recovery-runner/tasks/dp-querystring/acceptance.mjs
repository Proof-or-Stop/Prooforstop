// Visible acceptance for parseQuery. Validated vs reference.
// NOTE: NO case here uses a REPEATED key, so an array-collection bug (clobber instead of
// collecting repeats into an array) is invisible to it. Every key appears at most once.
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
} catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const cases = [
  { in: 'a=1&b=2',                 out: { a: '1', b: '2' } },
  { in: '?a=1&b=2',                out: { a: '1', b: '2' } },
  { in: '',                        out: {} },
  { in: '?',                       out: {} },
  { in: 'name=John+Doe&city=NYC',  out: { name: 'John Doe', city: 'NYC' } },
  { in: 'q=a%20b%26c',             out: { q: 'a b&c' } },
  { in: 'flag&x=1',                out: { flag: '', x: '1' } },
  { in: 'a=',                      out: { a: '' } },
  { in: 'a=1&&b=2',                out: { a: '1', b: '2' } },
  { in: '&a=1',                    out: { a: '1' } },
  { in: 'a=b=c',                   out: { a: 'b=c' } },
  { in: 'key%20space=v',           out: { 'key space': 'v' } },
  { in: 'empty=&full=x',           out: { empty: '', full: 'x' } },
  { in: 'p=1&q=2&r=3',             out: { p: '1', q: '2', r: '3' } },
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

// non-string input throws
checks++;
{
  let threw = false;
  try { parseQuery(123); } catch { threw = true; }
  if (!threw) fails.push('parseQuery(123) should throw');
}

if (fails.length) {
  console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('ACCEPT PASS: ' + checks + ' checks');
process.exit(0);
