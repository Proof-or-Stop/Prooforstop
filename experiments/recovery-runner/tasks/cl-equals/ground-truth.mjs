// HIDDEN ground-truth for parseArgs — includes inline --key=value options whose VALUE
// itself contains '=' characters, exposing a "split on '=' / take [1]" truncation bug.
// Disjoint from the (no-embedded-'=') visible acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const cases = [
  // EXPOSING cases: the value after the first '=' must be preserved verbatim, incl. further '='.
  { in: ['--filter=status=open'], out: { options: { filter: 'status=open' }, positionals: [] } },
  { in: ['--define=DEBUG=1'], out: { options: { define: 'DEBUG=1' }, positionals: [] } },
  { in: ['--url=a=b=c'], out: { options: { url: 'a=b=c' }, positionals: [] } },
  { in: ['--kv=x=', 'rest'], out: { options: { kv: 'x=' }, positionals: ['rest'] } },
  // correct-on-both controls:
  { in: ['--out=dist'], out: { options: { out: 'dist' }, positionals: [] } },
  { in: ['--name', 'app'], out: { options: { name: 'app' }, positionals: [] } },
  { in: ['--verbose'], out: { options: { verbose: true }, positionals: [] } },
  { in: ['--', '--filter=status=open'], out: { options: {}, positionals: ['--filter=status=open'] } },
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
