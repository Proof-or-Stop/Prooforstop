// HIDDEN ground-truth for daysBetween — includes ranges that cross February of a
// CENTURY non-leap year (1900, 2100, 2200 — divisible by 100 but not 400, so NOT leap),
// which expose a leap-rule bug that treats every %4==0 year as leap. Disjoint from the
// (no-century-Feb) visible acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  // 1900 is divisible by 4 and 100 but not 400 => NOT a leap year. Feb 1900 has 28 days.
  { a: '1900-02-28', b: '1900-03-01', out: 1 },
  { a: '1900-01-01', b: '1900-12-31', out: 364 },
  { a: '1899-12-31', b: '1900-03-01', out: 60 },  // 31(rest of Dec=1) ... crosses 28-day Feb
  // 2100 also century-non-leap.
  { a: '2100-02-28', b: '2100-03-01', out: 1 },
  { a: '2099-02-15', b: '2100-02-15', out: 365 }, // 2099 common; spans across to non-leap 2100 Feb
  // 2200 century-non-leap.
  { a: '2200-02-01', b: '2200-04-01', out: 59 },  // Feb(28) + Mar(31) = 59
  // correct-on-both controls (no century Feb crossing):
  { a: '2000-02-28', b: '2000-03-01', out: 2 },   // 2000 divisible by 400 => IS leap
  { a: '2021-03-01', b: '2021-03-31', out: 30 },
  { a: '2020-01-01', b: '2021-01-01', out: 366 },
];

let daysBetween;
try { daysBetween = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof daysBetween !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = daysBetween(c.a, c.b); } catch (e) { fails.push(`daysBetween(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`daysBetween(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) = ${g}, expected ${c.out}`); }
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
