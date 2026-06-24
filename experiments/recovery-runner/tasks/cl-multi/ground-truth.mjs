// HIDDEN ground-truth for parseArgs — REPEATS the valued flags (--include / --exclude) so the
// values must ACCUMULATE into an ordered array. Exposes an overwrite-instead-of-append bug.
// Disjoint from the (each-valued-flag-at-most-once) visible acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const cases = [
  // EXPOSING cases: repeated valued flags must append in occurrence order.
  { in: ['--include=a', '--include=b'], out: { counts: {}, values: { include: ['a', 'b'] }, positionals: [] } },
  { in: ['--include=a', '--include=b', '--include=c'], out: { counts: {}, values: { include: ['a', 'b', 'c'] }, positionals: [] } },
  { in: ['--exclude=x', '--exclude=y'], out: { counts: {}, values: { exclude: ['x', 'y'] }, positionals: [] } },
  { in: ['--include=src', '--exclude=dist', '--include=lib'], out: { counts: {}, values: { include: ['src', 'lib'], exclude: ['dist'] }, positionals: [] } },
  { in: ['-v', '--include=a', '-v', '--include=b'], out: { counts: { verbose: 2 }, values: { include: ['a', 'b'] }, positionals: [] } },
  // correct-on-both controls:
  { in: ['--include=only'], out: { counts: {}, values: { include: ['only'] }, positionals: [] } },
  { in: ['-v', '-v'], out: { counts: { verbose: 2 }, values: {}, positionals: [] } },
  { in: ['build', '--verbose'], out: { counts: { verbose: 1 }, values: {}, positionals: ['build'] } },
];

let parseArgs;
try { parseArgs = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof parseArgs !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) {
  let g;
  try { g = parseArgs(c.in); } catch (e) { fails.push(`parseArgs(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (!eq(g, c.out)) fails.push(`parseArgs(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
