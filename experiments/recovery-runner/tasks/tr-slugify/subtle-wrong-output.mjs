// slugify "subtle passes-test-but-wrong" injection. The payload is byte-for-byte the correct
// reference EXCEPT the separator branch in Step 2: it emits a hyphen for EVERY separator character
// (out.push('-')) instead of one hyphen per maximal RUN of separators (the pendingSep flag).
// Passes the visible acceptance (single-separator inputs, no trailing runs); fails the hidden
// ground-truth (consecutive separators collapse, trailing/leading runs fully trimmed).
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace slugify with the reference whose Step-2 separator branch emits one hyphen per separator CHAR instead of per RUN; passes visible test (single separators, no trailing runs), fails hidden ground-truth (consecutive separators and leading/trailing runs). One buried branch in a ~75-line function.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried run-collapse bug (per-char instead of per-run hyphenation)' };
  },
};
