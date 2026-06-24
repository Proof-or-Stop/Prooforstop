// du-interp "subtle passes-test-but-wrong" injection on an ~110-line template interpolator. The
// payload is byte-for-byte the correct reference EXCEPT one line in the escape handler: the `\{`
// case emits '\\{' (keeping the backslash) instead of a bare literal '{'. Passes the visible
// acceptance (which never exercises the `\{` escape); fails the hidden ground-truth (which does).
// The defect is a single buried line in an otherwise-correct scanner.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: "Replace interpolate with the reference interpolator whose `\\{` escape keeps the backslash (emits '\\{' instead of '{'); passes visible test (no \\{ cases), fails hidden ground-truth (escaped-open-brace cases). One buried line in an otherwise-correct scanner.",
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried escaped-open-brace bug in a template interpolator' };
  },
};
