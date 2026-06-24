// Visible acceptance for parseArgs. Validated vs reference (S4).
// NOTE: every short-flag case here uses a SINGLE letter (-v, -h), never a combined
// cluster like -abc, so a "combined-shorts" bug is invisible to it.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const cases = [
  { in: [], out: { flags: {}, positionals: [] } },
  { in: ['file.txt'], out: { flags: {}, positionals: ['file.txt'] } },
  { in: ['--verbose'], out: { flags: { verbose: true }, positionals: [] } },
  { in: ['--out=dist'], out: { flags: { out: 'dist' }, positionals: [] } },
  { in: ['-v'], out: { flags: { v: true }, positionals: [] } },
  { in: ['-h'], out: { flags: { h: true }, positionals: [] } },
  { in: ['-v', '-h'], out: { flags: { v: true, h: true }, positionals: [] } },
  { in: ['build', '-v'], out: { flags: { v: true }, positionals: ['build'] } },
  { in: ['--out=dist', 'main.js'], out: { flags: { out: 'dist' }, positionals: ['main.js'] } },
  { in: ['--', '--verbose', '-v'], out: { flags: {}, positionals: ['--verbose', '-v'] } },
  { in: ['-'], out: { flags: {}, positionals: ['-'] } },
  { in: ['--out-dir=build'], out: { flags: { 'out-dir': 'build' }, positionals: [] } },
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
