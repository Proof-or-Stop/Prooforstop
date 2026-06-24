// HIDDEN ground-truth for mapRange — includes LARGE output ranges whose mapped integer exceeds the
// signed-32-bit range (~2.1e9), exposing a `Math.round(x) | 0` (or `~~x`) truncation bug that wraps
// large results to a wrong (often negative) value. Disjoint from the (small-range) visible
// acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  // map a fraction of a multi-gigabyte byte budget — results exceed 2^31:
  { args: [5, 0, 10, 0, 4000000000], out: 2000000000 },   // 2e9 (still < 2^31, control-ish)
  { args: [9, 0, 10, 0, 4000000000], out: 3600000000 },   // 3.6e9 > 2^31  -> exposes wrap
  { args: [3, 0, 4, 0, 4000000000], out: 3000000000 },    // 3e9 > 2^31
  { args: [1, 0, 1000000, 0, 3000000000], out: 3000 },    // small result, large outMax
  { args: [999999, 0, 1000000, 0, 3000000000], out: 2999997000 }, // ~3e9 > 2^31
  { args: [7, 0, 10, 0, 5000000000], out: 3500000000 },   // 3.5e9 > 2^31
  // correct-on-both small controls:
  { args: [5, 0, 10, 0, 100], out: 50 },
  { args: [10, 0, 10, 0, 100], out: 100 },
  { args: [-3, 0, 10, 0, 100], out: 0 },
  { args: [2.5, 0, 10, 0, 100], out: 25 },
];

let mapRange;
try { mapRange = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof mapRange !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = mapRange(...c.args); } catch (e) { fails.push(`mapRange(${c.args.join(', ')}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`mapRange(${c.args.join(', ')}) = ${g}, expected ${c.out}`); }
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
