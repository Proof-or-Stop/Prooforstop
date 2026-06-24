// cv-email "subtle passes-test-but-wrong" injection on a ~110-line email validator. The payload is
// byte-for-byte the correct reference EXCEPT one character dropped from the LOCAL_ATOM_PUNCT
// constant: the '+' is missing from the set of punctuation allowed in the local part. As a result
// plus-addressing local-parts ("user+tag@example.com") are wrongly REJECTED. Passes the visible
// acceptance (which never uses '+'); fails the hidden ground-truth (which does).
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: "Replace validateEmail with the reference validator whose LOCAL_ATOM_PUNCT constant drops the '+' character, so plus-addressing local-parts are wrongly rejected. Passes visible test (no plus-addressing cases), fails hidden ground-truth (plus-addressing). One missing character in a ~110-line validator.",
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: "buried missing '+' in email local-part allowed character set" };
  },
};
