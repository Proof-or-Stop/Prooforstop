// HIDDEN ground-truth for interpolate — includes the `\{` (escaped-open-brace) case that exposes a
// bug where \{ keeps the backslash instead of emitting a bare literal '{'. Disjoint from the
// visible acceptance (which never uses \{), plus correct-on-both controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  // EXPOSING: \{ must emit a single literal '{', no backslash.
  { tmpl: 'a \\{ b', ctx: {}, out: 'a { b' },
  { tmpl: '\\{name\\}', ctx: {}, out: '{name}' },                 // escaped braces, NOT a placeholder
  { tmpl: 'json: \\{ "k": {v} \\}', ctx: { v: 1 }, out: 'json: { "k": 1 }' },
  { tmpl: '\\{{x}\\}', ctx: { x: 'Z' }, out: '{Z}' },             // literal { then placeholder then literal }
  { tmpl: 'set := \\{1, 2, 3\\}', ctx: {}, out: 'set := {1, 2, 3}' },

  // correct-on-both controls:
  { tmpl: 'Hello, {name}!', ctx: { name: 'Ada' }, out: 'Hello, Ada!' },
  { tmpl: 'path\\\\to', ctx: {}, out: 'path\\to' },               // \\ control
  { tmpl: 'close \\}', ctx: {}, out: 'close }' },                 // \} control
  { tmpl: '{a}+{b}={c}', ctx: { a: 2, b: 3, c: 5 }, out: '2+3=5' },
];

let interpolate;
try { interpolate = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof interpolate !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g;
  try { g = interpolate(c.tmpl, c.ctx); }
  catch (e) { fails.push(`interpolate(${JSON.stringify(c.tmpl)}) threw: ${e.message}`); continue; }
  if (g !== c.out) fails.push(`interpolate(${JSON.stringify(c.tmpl)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
