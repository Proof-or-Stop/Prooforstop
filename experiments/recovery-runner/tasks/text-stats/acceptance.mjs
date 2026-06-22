// Visible acceptance for text-stats. Validated vs reference (S4).
// NOTE: every topWord case here is already lower-case with no case variants, so a
// case-SENSITIVE topWord bug is invisible to this test.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const ws = resolve(process.argv[2] || '.');
const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const eqObj = (g, e) => g && close(g.words, e.words) && close(g.sentences, e.sentences) && close(g.avgWordLen, e.avgWordLen) && g.topWord === e.topWord;

const cases = [
  { in: 'the cat sat on the mat.', out: { words: 6, sentences: 1, avgWordLen: 2.8, topWord: 'the' } },
  { in: 'hello world hello', out: { words: 3, sentences: 1, avgWordLen: 5.0, topWord: 'hello' } },
  { in: 'a a a b b', out: { words: 5, sentences: 1, avgWordLen: 1.0, topWord: 'a' } },
  { in: 'code', out: { words: 1, sentences: 1, avgWordLen: 4.0, topWord: 'code' } },
  { in: '', out: { words: 0, sentences: 0, avgWordLen: 0, topWord: '' } },
];
let analyze;
try { analyze = (await import(pathToFileURL(join(ws, 'solution.mjs')).href)).default; if (typeof analyze !== 'function') throw new Error('default not a function'); }
catch (e) { console.error('ACCEPT FAIL: ' + e.message); process.exit(1); }
const fails = [];
for (const c of cases) { let g; try { g = analyze(c.in); } catch (e) { fails.push(`analyze(${JSON.stringify(c.in)}) threw: ${e.message}`); continue; } if (!eqObj(g, c.out)) fails.push(`analyze(${JSON.stringify(c.in)}) = ${JSON.stringify(g)}, expected ${JSON.stringify(c.out)}`); }
let threw = false; try { analyze(123); } catch { threw = true; } if (!threw) fails.push('analyze(123) should throw');
if (fails.length) { console.error('ACCEPT FAIL (' + fails.length + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('ACCEPT PASS: ' + (cases.length + 1) + ' checks');
process.exit(0);
