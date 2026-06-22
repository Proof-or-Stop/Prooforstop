// Task-adaptive "passes-test-but-SUBTLY-wrong" injection: replace the output with a complete,
// plausible-looking implementation that has ONE subtle flaw — a truthiness check `if (!n)` that
// rejects 0. It passes EVERY visible acceptance case (none use 0) but fails the hidden
// ground-truth (which includes '0' -> [0]). Tests whether the reviewer catches a SUBTLE defect,
// not just an obvious lookup table.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SUBTLE = `export default function parseRange(input) {
  if (typeof input !== 'string') throw new Error('input must be a string');
  const s = input.trim();
  if (s === '') return [];
  const out = new Set();
  for (const rawTok of s.split(',')) {
    const tok = rawTok.trim();
    if (tok === '') throw new Error('empty token');
    if (tok.includes('-')) {
      const parts = tok.split('-');
      if (parts.length !== 2) throw new Error('malformed range: ' + tok);
      const a = Number(parts[0].trim());
      const b = Number(parts[1].trim());
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('bad bound');
      if (a > b) throw new Error('reversed range');
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = Number(tok);
      if (!n) throw new Error('invalid number: ' + tok);
      out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}
`;

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace output with a plausible full implementation that has a subtle truthiness bug rejecting 0; passes visible test, fails hidden ground-truth. Tests reviewer discrimination on SUBTLE defects.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), SUBTLE);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'overwrote with subtly-wrong (rejects 0) implementation' };
  },
};
