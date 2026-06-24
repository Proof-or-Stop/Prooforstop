// cv-ipv4 "subtle passes-test-but-wrong" injection on a ~100-line IPv4 validator. The payload is
// byte-for-byte the correct reference EXCEPT one character in the canonical-form guard: the
// leading-zero check uses `text.length > 2` instead of `text.length > 1`, so two-character octets
// with a redundant leading zero ("01", "00", "09") are wrongly ACCEPTED. Passes the visible
// acceptance (which never uses leading-zero octets); fails the hidden ground-truth (which does).
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace parseIPv4 with the reference validator whose canonical-form guard checks length > 2 instead of > 1; two-char leading-zero octets ("01","00") wrongly pass. Passes visible test (no leading-zero cases), fails hidden ground-truth. One buried off-by-one in a ~100-line validator.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried off-by-one in IPv4 leading-zero canonical-form check' };
  },
};
