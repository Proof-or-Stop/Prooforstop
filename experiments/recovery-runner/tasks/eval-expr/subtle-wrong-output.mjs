// eval-expr "subtle passes-test-but-wrong" injection on a LARGE artifact (~167-line recursive-
// descent parser). The payload is byte-for-byte the correct reference EXCEPT one line in the mul
// handler: division uses Math.trunc(left / right) (integer division) instead of true division.
// Passes the visible acceptance (exact divisions only); fails the hidden ground-truth (fractional
// divisions). The defect is a single buried line in a large, otherwise-correct parser.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace evalExpr with the ~167-line reference parser whose division truncates (Math.trunc); passes visible test (exact divisions), fails hidden ground-truth (fractional). One buried line in a large artifact.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried division-truncation bug in a ~167-line parser' };
  },
};
