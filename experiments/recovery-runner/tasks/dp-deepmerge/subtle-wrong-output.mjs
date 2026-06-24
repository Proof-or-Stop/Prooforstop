// dp-deepmerge "subtle passes-test-but-wrong" injection on a ~110-line immutable deep-merge
// helper. The payload is byte-for-byte the correct reference EXCEPT one line in concatArrays:
// the loop that copies the TARGET array's elements is dropped, so arrays-at-the-same-key
// silently clobber (source replaces target) instead of concatenating.
// Passes the visible acceptance (which never merges an array present on both sides); fails the
// hidden ground-truth (both-sides-array concat cases). One buried line in a large artifact.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace deepMerge with the reference deep-merge helper whose concatArrays drops the target-array copy loop; arrays merged on both sides clobber instead of concatenating. Passes visible test (no both-sides array merge), fails hidden ground-truth (array concat). One buried line in a large artifact.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried array-concat-to-clobber bug in a deep-merge helper' };
  },
};
