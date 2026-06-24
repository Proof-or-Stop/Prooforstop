// HIDDEN ground-truth for roundMoney() — includes EVEN-floor exact .5 ties under half-even
// (0.5, 2.5, 4.5, ...), which must round DOWN to the even neighbour. These expose the
// "ties round up instead of to-even" bug. Disjoint from the visible acceptance (which uses only
// non-ties and odd-floor ties under half-even), plus correct-on-both controls.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

const cases = [
  // EXPOSING: even-floor exact ties -> round to even (down)
  { args: [0.5, 0, 'half-even'], out: 0 },   // bug -> 1
  { args: [2.5, 0, 'half-even'], out: 2 },   // bug -> 3
  { args: [4.5, 0, 'half-even'], out: 4 },   // bug -> 5
  { args: [-0.5, 0, 'half-even'], out: 0 },  // bug -> -1 (well, -0)
  { args: [-2.5, 0, 'half-even'], out: -2 }, // bug -> -3
  { args: [12.5, 0, 'half-even'], out: 12 }, // bug -> 13
  // EXPOSING at places=1: 0.25 is exactly representable -> scaled 2.5 -> even -> 0.2
  { args: [0.25, 1, 'half-even'], out: 0.2 },// bug -> 0.3

  // correct-on-both controls (non-ties and odd-floor ties)
  { args: [1.5, 0, 'half-even'], out: 2 },
  { args: [3.5, 0, 'half-even'], out: 4 },
  { args: [2.3, 0, 'half-even'], out: 2 },
  { args: [2.5, 0, 'half-up'], out: 3 },
  { args: [2.5, 0, 'floor'], out: 2 },
];

let roundMoney;
try { roundMoney = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof roundMoney !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }

const fails = [];
for (const c of cases) {
  let g; try { g = roundMoney(...c.args); } catch (e) { fails.push(`roundMoney(${JSON.stringify(c.args)}) threw: ${e.message}`); continue; }
  if (!close(g, c.out)) fails.push(`roundMoney(${JSON.stringify(c.args)}) = ${g}, expected ${c.out}`);
}
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
