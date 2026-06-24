// Visible acceptance for parseArgs. Validated vs reference (S4).
// NOTE: every repeatable VALUED flag (--include / --exclude) appears AT MOST ONCE here, so an
// "overwrite-instead-of-append" bug on repeats is invisible to it. (Count flags may repeat;
// the count path is exercised, the value-accumulation path on repeats is not.)
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const cases = [
  { in: [], out: { counts: {}, values: {}, positionals: [] } },
  { in: ['--verbose'], out: { counts: { verbose: 1 }, values: {}, positionals: [] } },
  { in: ['-v'], out: { counts: { verbose: 1 }, values: {}, positionals: [] } },
  { in: ['-v', '-v', '-v'], out: { counts: { verbose: 3 }, values: {}, positionals: [] } },
  { in: ['--verbose', '-v'], out: { counts: { verbose: 2 }, values: {}, positionals: [] } },
  { in: ['--include=src'], out: { counts: {}, values: { include: ['src'] }, positionals: [] } },
  { in: ['--exclude=node_modules'], out: { counts: {}, values: { exclude: ['node_modules'] }, positionals: [] } },
  { in: ['--include=src', '--exclude=dist'], out: { counts: {}, values: { include: ['src'], exclude: ['dist'] }, positionals: [] } },
  { in: ['build', '--verbose'], out: { counts: { verbose: 1 }, values: {}, positionals: ['build'] } },
  { in: ['--include=src', '-v', 'main'], out: { counts: { verbose: 1 }, values: { include: ['src'] }, positionals: ['main'] } },
  { in: ['--unknown', 'x'], out: { counts: {}, values: {}, positionals: ['--unknown', 'x'] } },
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
