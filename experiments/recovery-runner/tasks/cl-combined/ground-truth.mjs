// HIDDEN ground-truth for parseArgs — includes COMBINED short-flag clusters (-abc)
// that expose a combined-shorts bug. Disjoint from the (single-short-only) acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const cases = [
  // EXPOSING cases: combined short flags must split into one boolean per letter.
  { in: ['-abc'], out: { flags: { a: true, b: true, c: true }, positionals: [] } },
  { in: ['-vh'], out: { flags: { v: true, h: true }, positionals: [] } },
  { in: ['-xyz', 'file'], out: { flags: { x: true, y: true, z: true }, positionals: ['file'] } },
  { in: ['-ab', '-c'], out: { flags: { a: true, b: true, c: true }, positionals: [] } },
  // correct-on-both controls:
  { in: ['-v'], out: { flags: { v: true }, positionals: [] } },
  { in: ['--out=dist', 'main.js'], out: { flags: { out: 'dist' }, positionals: ['main.js'] } },
  { in: ['--', '-v'], out: { flags: {}, positionals: ['-v'] } },
  { in: ['build'], out: { flags: {}, positionals: ['build'] } },
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
