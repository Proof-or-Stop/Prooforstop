// median-specific "subtle passes-test-but-wrong" injection: a plausible full implementation whose
// ONLY flaw is returning the LOWER of the two middles for even-length arrays instead of their
// average. Passes every visible case (all even cases there have equal middles) but fails the hidden
// ground-truth (even-length with differing middles). Tests reviewer discrimination on a SUBTLE bug.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SUBTLE = `export default function median(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) throw new Error('empty array');
  const s = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid];
  return s[mid - 1];
}
`;
export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace median with a plausible impl that returns the lower middle for even arrays (no averaging); passes visible, fails ground-truth.',
  inject(ws, task) { writeFileSync(join(ws, task.outputFile), SUBTLE); return { faultKind: this.faultKind, target: task.outputFile, detail: 'overwrote with even-length lower-middle bug' }; },
};
