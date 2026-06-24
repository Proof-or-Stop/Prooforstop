// Visible acceptance for daysBetween. Validated vs reference (S4).
// NOTE: every case here uses ordinary years (incl. regular leap years like 2020 that ARE
// divisible by 4). NONE crosses February of a century-non-leap year (e.g. 1900/2100), so a
// leap-rule bug that drops the /100 /400 correction is invisible here.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  { a: '2021-03-14', b: '2021-03-14', out: 0 },
  { a: '2021-03-01', b: '2021-03-31', out: 30 },
  { a: '2021-01-01', b: '2021-12-31', out: 364 },
  { a: '2021-03-31', b: '2021-03-01', out: -30 },
  { a: '2020-01-01', b: '2021-01-01', out: 366 }, // 2020 is a (regular) leap year
  { a: '2019-01-01', b: '2020-01-01', out: 365 },
  { a: '2020-02-28', b: '2020-03-01', out: 2 },   // crosses Feb 29 of a regular leap year
  { a: '2021-02-28', b: '2021-03-01', out: 1 },   // non-leap Feb, common year
  { a: '2021-06-15', b: '2021-07-15', out: 30 },
  { a: '2000-06-01', b: '2000-06-30', out: 29 },  // same month, no Feb crossing
  { a: '2022-01-15', b: '2024-01-15', out: 730 }, // spans 2023 (365) + 2022 tail; no century Feb
];
const throwCases = [
  ['2021-02-30', '2021-03-01'],
  ['2021-13-01', '2021-03-01'],
  ['2021-04-31', '2021-03-01'],
  ['2021/03/01', '2021-03-02'],
  [42, '2021-03-02'],
  ['2021-03-01', 'nope'],
];

let daysBetween;
try { daysBetween = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof daysBetween !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = daysBetween(c.a, c.b); } catch (e) { fails.push(`daysBetween(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`daysBetween(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) = ${g}, expected ${c.out}`); }
for (const [a, b] of throwCases) { let threw = false; try { daysBetween(a, b); } catch { threw = true; } if (!threw) fails.push(`daysBetween(${JSON.stringify(a)}, ${JSON.stringify(b)}) should throw`); }
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
