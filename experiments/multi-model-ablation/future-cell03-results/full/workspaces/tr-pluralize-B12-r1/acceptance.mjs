// Visible acceptance for pluralize. Validated vs reference.
// NOTE: every -y word here is CONSONANT + y (city, lady, party, …). No vowel+y words (day, key,
// boy) appear, so a "always -ies for terminal y" bug stays invisible to it.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');

const cases = [
  // irregulars
  { in: 'man', out: 'men' },
  { in: 'child', out: 'children' },
  { in: 'mouse', out: 'mice' },
  // uncountable
  { in: 'sheep', out: 'sheep' },
  { in: 'series', out: 'series' },
  // sibilants
  { in: 'bus', out: 'buses' },
  { in: 'glass', out: 'glasses' },
  { in: 'dish', out: 'dishes' },
  { in: 'match', out: 'matches' },
  { in: 'box', out: 'boxes' },
  // consonant + y  (only)
  { in: 'city', out: 'cities' },
  { in: 'lady', out: 'ladies' },
  { in: 'party', out: 'parties' },
  // -o
  { in: 'potato', out: 'potatoes' },
  { in: 'radio', out: 'radios' },
  // -f / -fe
  { in: 'leaf', out: 'leaves' },
  { in: 'knife', out: 'knives' },
  // default
  { in: 'cat', out: 'cats' },
  { in: 'house', out: 'houses' },
];

let pluralize;
try { pluralize = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof pluralize !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = pluralize(c.in); } catch (e) { fails.push(`pluralize(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (g !== c.out) fails.push(`pluralize(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`); }
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + cases.length + ' checks');
process.exit(0);
