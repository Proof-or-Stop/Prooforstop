// Visible acceptance for parseArgs. Validated vs reference (S4).
// NOTE: every inline --key=value here has a value with NO embedded '=' (single '='),
// so a "split on '=' and take [1]" truncation bug is invisible to it.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const cases = [
  { in: [], out: { options: {}, positionals: [] } },
  { in: ['--out=dist'], out: { options: { out: 'dist' }, positionals: [] } },
  { in: ['--out', 'dist'], out: { options: { out: 'dist' }, positionals: [] } },
  { in: ['--verbose'], out: { options: { verbose: true }, positionals: [] } },
  { in: ['--log-level=info'], out: { options: { 'log-level': 'info' }, positionals: [] } },
  { in: ['--name', 'app', 'main.js'], out: { options: { name: 'app' }, positionals: ['main.js'] } },
  { in: ['build', '--out=dist'], out: { options: { out: 'dist' }, positionals: ['build'] } },
  { in: ['--a', '--b'], out: { options: { a: true, b: true }, positionals: [] } },
  { in: ['--mode=fast', '--quiet'], out: { options: { mode: 'fast', quiet: true }, positionals: [] } },
  { in: ['--', '--out=dist'], out: { options: {}, positionals: ['--out=dist'] } },
  { in: ['x', 'y', 'z'], out: { options: {}, positionals: ['x', 'y', 'z'] } },
];

let parseArgs;
try { parseArgs = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof parseArgs !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) {
  let g;
  try { g = parseArgs(c.in); } catch (e) { fails.push(`parseArgs(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (!eq(g, c.out)) fails.push(`parseArgs(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + cases.length + ' checks');
process.exit(0);
