// HIDDEN ground-truth for slugify — includes CONSECUTIVE separators and TRAILING/LEADING runs that
// expose a "one hyphen per separator char (no run-collapse)" bug. Disjoint from the (single-
// separator, no-trailing-run) visible acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  // consecutive separators must collapse to a SINGLE hyphen:
  { in: 'Hello   World', out: 'hello-world' },
  { in: 'a -- b', out: 'a-b' },
  { in: 'foo___bar', out: 'foo-bar' },
  { in: 'one  two   three', out: 'one-two-three' },
  { in: 'Mixed . / _ Seps', out: 'mixed-seps' },
  // leading / trailing runs must be trimmed entirely (no trailing/leading hyphen):
  { in: '  leading', out: 'leading' },
  { in: 'trailing   ', out: 'trailing' },
  { in: '---wrapped---', out: 'wrapped' },
  { in: '!!!', out: '' },
  // correct-on-both controls:
  { in: 'Hello World', out: 'hello-world' },
  { in: 'Café del Mar', out: 'cafe-del-mar' },
  { in: 'abc123', out: 'abc123' },
];

let slugify;
try { slugify = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof slugify !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = slugify(c.in); } catch (e) { fails.push(`slugify(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`slugify(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`); }
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
