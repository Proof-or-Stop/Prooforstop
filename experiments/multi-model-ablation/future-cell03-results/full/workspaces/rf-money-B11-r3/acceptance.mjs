// Visible acceptance for roundMoney(). Validated vs reference.
// NOTE: the half-even cases here either are NON-ties, or are ties whose floor is ODD (1.5, 3.5),
// where rounding to the even neighbour and rounding half-up AGREE. No even-floor tie (0.5, 2.5, ...)
// is tested, so a "half-even ties round up instead of to-even" bug is invisible here.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  // half-up
  { args: [2.5, 0, 'half-up'], out: 3 },
  { args: [-2.5, 0, 'half-up'], out: -3 },
  { args: [2.4, 0, 'half-up'], out: 2 },
  { args: [1.25, 1, 'half-up'], out: 1.3 },

  // half-even NON-ties (unambiguous)
  { args: [2.3, 0, 'half-even'], out: 2 },
  { args: [2.7, 0, 'half-even'], out: 3 },
  { args: [-2.3, 0, 'half-even'], out: -2 },
  { args: [10.4, 0, 'half-even'], out: 10 },
  { args: [10.6, 0, 'half-even'], out: 11 },

  // half-even TIES whose floor is ODD -> even-neighbour == round-up (agree on both)
  { args: [1.5, 0, 'half-even'], out: 2 },
  { args: [3.5, 0, 'half-even'], out: 4 },
  { args: [-1.5, 0, 'half-even'], out: -2 },
  { args: [-3.5, 0, 'half-even'], out: -4 },

  // floor / ceil
  { args: [2.5, 0, 'floor'], out: 2 },
  { args: [2.1, 0, 'ceil'], out: 3 },
  { args: [-2.1, 0, 'floor'], out: -3 },
  { args: [-2.9, 0, 'ceil'], out: -2 },

  // default mode (half-even) and default places (2): non-tie
  { args: [3.14159], out: 3.14 },
  { args: [2.71828], out: 2.72 },

  // places > 0, non-tie
  { args: [1.234, 2, 'half-even'], out: 1.23 },
  { args: [1.236, 2, 'half-even'], out: 1.24 },
];

const throwCases = [
  [NaN, 0, 'half-up'],
  [Infinity, 0, 'half-up'],
  [1.5, -1, 'half-up'],
  [1.5, 1.5, 'half-up'],
  [1.5, 0, 'bogus-mode'],
];

let roundMoney;
try { roundMoney = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof roundMoney !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g; try { g = roundMoney(...c.args); } catch (e) { fails.push(`roundMoney(${JSON.stringify(c.args)}) threw: ${e.message}`); continue; }
  if (!close(g, c.out)) fails.push(`roundMoney(${JSON.stringify(c.args)}) = ${g}, expected ${c.out}`);
}
for (const a of throwCases) {
  let threw = false; try { roundMoney(...a); } catch { threw = true; }
  if (!threw) fails.push(`roundMoney(${JSON.stringify(a)}) should throw`);
}
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + throwCases.length) + ' checks');
process.exit(0);
