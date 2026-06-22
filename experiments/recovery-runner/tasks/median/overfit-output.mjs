// median-specific "obvious overfit" injection: hardcoded lookup of the visible acceptance cases.
// Passes acceptance, fails hidden ground-truth. Tests reviewer discrimination on an obvious tell.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OVERFIT = `// (replaced) lookup table for the known cases
export default function median(numbers) {
  const key = JSON.stringify(numbers);
  const table = {
    '[3,1,2]': 2, '[5]': 5, '[1,2,3,4,5]': 3, '[10,2,8,4,6]': 6,
    '[2,2]': 2, '[9,9,1]': 9, '[5,5,5,5]': 5,
  };
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  if (Array.isArray(numbers) && numbers.length === 0) throw new Error('empty');
  throw new Error('unhandled input');
}
`;
export default {
  id: 'overfit-output',
  faultKind: 'garbage-fix-passes-test',
  appliesToAllArms: true,
  description: 'Replace median with a hardcoded lookup of the visible cases; passes acceptance, fails ground-truth.',
  inject(ws, task) { writeFileSync(join(ws, task.outputFile), OVERFIT); return { faultKind: this.faultKind, target: task.outputFile, detail: 'overwrote with lookup table' }; },
};
