// Visible acceptance for formatDuration. Validated vs reference.
// NOTE: no case here is a MULTI-DAY (>= 2 days) span that contains an INTERIOR zero unit, so a bug
// that collapses interior zeros only for multi-day spans is invisible to this test. Single-day
// interior-zero cases and multi-day cases with no interior zeros ARE exercised.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  { in: 0, out: '0s' },
  { in: 1, out: '1s' },
  { in: 59, out: '59s' },
  { in: 60, out: '1m' },
  { in: 61, out: '1m 1s' },
  { in: 3661, out: '1h 1m 1s' },          // leading 0d trimmed
  { in: 3600, out: '1h' },
  { in: 90061, out: '1d 1h 1m 1s' },
  { in: 90000, out: '1d 1h' },            // trailing 0m 0s trimmed
  { in: 86461, out: '1d 0h 1m 1s' },      // single-day INTERIOR 0h kept
  { in: 86400, out: '1d' },
  { in: 86401, out: '1d 0h 0m 1s' },      // single-day interior zeros kept
  // multi-day, but NO interior zeros (every unit in the window is non-zero, or window has no gap):
  { in: 172800, out: '2d' },              // 2d 0h 0m 0s -> trailing trimmed -> "2d"
  { in: 273845, out: '3d 4h 4m 5s' },     // 3*86400 + 4*3600 + 4*60 + 5, all units non-zero
  { in: 216000, out: '2d 12h' },          // 2d 12h 0m 0s -> "2d 12h", no interior zero
];

const throwCases = [-1, 1.5, '60', NaN, null, undefined];

let formatDuration;
try { formatDuration = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof formatDuration !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g;
  try { g = formatDuration(c.in); }
  catch (e) { fails.push(`formatDuration(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; }
  if (g !== c.out) fails.push(`formatDuration(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`);
}
for (const t of throwCases) {
  let threw = false;
  try { formatDuration(t); } catch { threw = true; }
  if (!threw) fails.push(`formatDuration(${JSON.stringify(t)}) should throw`);
}
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
