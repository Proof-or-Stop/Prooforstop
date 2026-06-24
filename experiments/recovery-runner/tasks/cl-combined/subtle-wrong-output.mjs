// cl-combined "subtle passes-test-but-wrong" injection on a ~90-line argument parser.
// The payload is byte-for-byte the correct reference EXCEPT one line in parseShort: instead of
// `const ch = letters[k]` (one boolean per letter) it uses `const ch = letters` — so a combined
// short cluster like `-abc` registers a single flag `abc=true` instead of a/b/c each true.
// Passes the visible acceptance (single short flags only); fails the hidden ground-truth
// (combined `-abc` clusters). The defect is a single buried line in an otherwise-correct parser.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace parseArgs with the reference parser whose short-flag loop registers the whole letter-run as one flag instead of one boolean per letter; passes visible test (single short flags), fails hidden ground-truth (combined -abc). One buried line.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried combined-short-flag bug in a ~90-line arg parser' };
  },
};
