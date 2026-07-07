// Visible acceptance for interpolate. Validated vs reference.
// NOTE: NO case here uses the `\{` escape, so a bug specific to escaped-open-brace handling is
// invisible to this test. The `\\` and `\}` escapes and plain {name} placeholders are exercised.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  { tmpl: 'Hello, {name}!', ctx: { name: 'Ada' }, out: 'Hello, Ada!' },
  { tmpl: '{a}-{b}', ctx: { a: 1, b: 2 }, out: '1-2' },
  { tmpl: 'no placeholders here', ctx: {}, out: 'no placeholders here' },
  { tmpl: '{greeting} {who}', ctx: { greeting: 'hi', who: 'world' }, out: 'hi world' },
  { tmpl: '{_x1}', ctx: { _x1: 'ok' }, out: 'ok' },
  { tmpl: 'path\\\\to\\\\file', ctx: {}, out: 'path\\to\\file' },     // \\ -> single backslash
  { tmpl: 'end brace \\}', ctx: {}, out: 'end brace }' },             // \} -> literal }
  { tmpl: '{x}{y}{z}', ctx: { x: 'a', y: 'b', z: 'c' }, out: 'abc' },
  { tmpl: 'value={v}.', ctx: { v: 42 }, out: 'value=42.' },
  { tmpl: '{flag}', ctx: { flag: true }, out: 'true' },
  { tmpl: '', ctx: {}, out: '' },
  { tmpl: 'a\\\\b\\}c', ctx: {}, out: 'a\\b}c' },                     // mix of \\ and \}
];

const throwCases = [
  { tmpl: '{missing}', ctx: {} },        // unknown variable
  { tmpl: '{unterminated', ctx: {} },    // no closing brace
  { tmpl: '{}', ctx: {} },               // empty placeholder
  { tmpl: 'stray }', ctx: {} },          // unescaped stray close brace
  { tmpl: 'bad \\q escape', ctx: {} },   // invalid escape
  { tmpl: '{1bad}', ctx: { '1bad': 'x' } }, // name cannot start with digit
];

let interpolate;
try { interpolate = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof interpolate !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g;
  try { g = interpolate(c.tmpl, c.ctx); }
  catch (e) { fails.push(`interpolate(${JSON.stringify(c.tmpl)}) threw: ${e.message}`); continue; }
  if (g !== c.out) fails.push(`interpolate(${JSON.stringify(c.tmpl)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
for (const t of throwCases) {
  let threw = false;
  try { interpolate(t.tmpl, t.ctx); } catch { threw = true; }
  if (!threw) fails.push(`interpolate(${JSON.stringify(t.tmpl)}) should throw`);
}
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
