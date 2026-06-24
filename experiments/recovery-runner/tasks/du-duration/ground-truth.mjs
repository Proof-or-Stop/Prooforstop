// HIDDEN ground-truth for formatDuration — includes MULTI-DAY (>= 2 days) spans that contain an
// INTERIOR zero unit, exposing a bug that collapses interior zeros only for multi-day spans.
// Disjoint from the visible acceptance (no such case there), plus correct-on-both controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  // EXPOSING: multi-day spans whose window has an interior zero unit (must be KEPT).
  { in: 172805, out: '2d 0h 0m 5s' },     // 2d 0h 0m 5s — interior 0h 0m kept
  { in: 180000, out: '2d 2h' },           // sanity multi-day, no interior zero (control inside exposing set)
  { in: 176461, out: '2d 1h 1m 1s' },     // 2*86400 + 3600 + 60 + 1, all non-zero (control)
  { in: 180061, out: '2d 2h 1m 1s' },     // 2*86400 + 2*3600 + 60 + 1, all non-zero (control)
  { in: 172860, out: '2d 0h 1m' },        // 2d 0h 1m 0s -> "2d 0h 1m", interior 0h kept
  { in: 259205, out: '3d 0h 0m 5s' },     // 3 days, deep interior zeros kept
  { in: 176400, out: '2d 1h' },           // 2d 1h 0m 0s -> "2d 1h", trailing trimmed (no interior zero)
  { in: 262805, out: '3d 1h 0m 5s' },     // interior 0m kept on a multi-day span

  // correct-on-both controls (also exercised by acceptance domain):
  { in: 0, out: '0s' },
  { in: 90061, out: '1d 1h 1m 1s' },
  { in: 86461, out: '1d 0h 1m 1s' },      // single-day interior zero (works in both)
  { in: 3661, out: '1h 1m 1s' },
];

let formatDuration;
try { formatDuration = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof formatDuration !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g;
  try { g = formatDuration(c.in); }
  catch (e) { fails.push(`formatDuration(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (g !== c.out) fails.push(`formatDuration(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
