// HIDDEN ground-truth for pluralize — includes VOWEL + y words (day, key, boy, guy, …) that expose
// an "always -ies for terminal y" bug. Disjoint from the (consonant-y-only) visible acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  // vowel + y  ->  just add -s  (the exposed class)
  { in: 'day', out: 'days' },
  { in: 'key', out: 'keys' },
  { in: 'boy', out: 'boys' },
  { in: 'guy', out: 'guys' },
  { in: 'tray', out: 'trays' },
  { in: 'monkey', out: 'monkeys' },
  { in: 'toy', out: 'toys' },
  // correct-on-both controls:
  { in: 'city', out: 'cities' },     // consonant + y still -ies
  { in: 'lady', out: 'ladies' },
  { in: 'box', out: 'boxes' },
  { in: 'leaf', out: 'leaves' },
  { in: 'cat', out: 'cats' },
  { in: 'goose', out: 'geese' },
];

let pluralize;
try { pluralize = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof pluralize !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = pluralize(c.in); } catch (e) { fails.push(`pluralize(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`pluralize(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`); }
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
