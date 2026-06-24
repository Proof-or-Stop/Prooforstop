// Visible acceptance for slugify. Validated vs reference.
// NOTE: every separator here is a SINGLE character (one space / one symbol), and no input has a
// trailing run of separators, so a "one hyphen per separator char" bug stays invisible to it.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  { in: 'Hello World', out: 'hello-world' },
  { in: 'hello', out: 'hello' },
  { in: 'Hello World Again', out: 'hello-world-again' },
  { in: 'Foo_Bar', out: 'foo-bar' },
  { in: 'a.b.c', out: 'a-b-c' },
  { in: 'Node/Path', out: 'node-path' },
  { in: 'Version 2 Point 0', out: 'version-2-point-0' },
  { in: 'Café del Mar', out: 'cafe-del-mar' },
  { in: 'JOSÉ', out: 'jose' },
  { in: 'ABC123', out: 'abc123' },
  { in: 'mix-it-up', out: 'mix-it-up' },
  { in: 'piña', out: 'pina' },
  { in: '12345', out: '12345' },
  { in: 'one two three four', out: 'one-two-three-four' },
];

let slugify;
try { slugify = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof slugify !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = slugify(c.in); } catch (e) { fails.push(`slugify(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`slugify(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`); }
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + cases.length + ' checks');
process.exit(0);
