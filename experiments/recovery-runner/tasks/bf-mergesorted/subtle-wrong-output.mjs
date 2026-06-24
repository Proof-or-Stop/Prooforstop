// bf-mergesorted "subtle passes-test-but-wrong" injection on a ~75-line merge utility. The
// payload is byte-for-byte the correct reference EXCEPT one extra line in the merge loop:
// after emitting the `a` record on a `<=` comparison it also advances `j` when keys are equal
// (`if (ra.key === rb.key) j++;`), silently DROPPING the matching `b` record. Passes the visible
// acceptance (cross-array key sets are disjoint, so no tie ever occurs at the frontier); fails
// the hidden ground-truth (cross-array equal keys). One buried line in an otherwise-correct merge.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace mergeSorted with the reference merge whose tie branch also advances j on equal keys (drops the matching b record); passes visible test (disjoint cross-array keys), fails hidden ground-truth (cross-array key ties). One buried line in a ~75-line utility.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried duplicate-drop bug on cross-array key ties' };
  },
};
