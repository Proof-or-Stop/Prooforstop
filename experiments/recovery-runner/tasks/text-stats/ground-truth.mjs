// HIDDEN ground-truth for text-stats — includes texts with case VARIANTS where the correct
// (case-insensitive) topWord differs from a case-sensitive computation. Disjoint from acceptance.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const eqObj = (g, e) => g && close(g.words, e.words) && close(g.sentences, e.sentences) && close(g.avgWordLen, e.avgWordLen) && g.topWord === e.topWord;

const cases = [
  { in: 'Sun sun sun moon Moon Moon Moon', out: { words: 7, sentences: 1, avgWordLen: 3.6, topWord: 'moon' } },
  { in: 'Red red blue Blue Blue Blue', out: { words: 6, sentences: 1, avgWordLen: 3.7, topWord: 'blue' } },
  { in: 'Wow! Amazing. Wow wow.', out: { words: 4, sentences: 3, avgWordLen: 4.0, topWord: 'wow' } },
  { in: 'x y x y x', out: { words: 5, sentences: 1, avgWordLen: 1.0, topWord: 'x' } },
  { in: 'alpha beta alpha gamma', out: { words: 4, sentences: 1, avgWordLen: 4.8, topWord: 'alpha' } },
];
let analyze;
try { analyze = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof analyze !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('GROUND-TRUTH FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = analyze(c.in); } catch (e) { fails.push(`analyze(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (!eqObj(g, c.out)) fails.push(`analyze(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`); }
if (fails.length) { console.error('GROUND-TRUTH FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GROUND-TRUTH PASS: ' + cases.length + ' held-out checks');
process.exit(0);
