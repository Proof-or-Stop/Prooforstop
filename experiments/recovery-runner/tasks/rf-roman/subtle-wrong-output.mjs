// rf-roman "subtle passes-test-but-wrong" injection. The payload is byte-for-byte the correct
// reference Roman codec EXCEPT the encode value/symbol table is missing the four tens/hundreds
// subtractive pairs (CM=900, CD=400, XC=90, XL=40), so those magnitudes encode additively
// (40 -> "XXXX", 900 -> "DCCCC"). The units pairs IV/IX remain, so small cases look right.
// Passes the visible acceptance (encode cases avoid 40/90/400/900); fails the hidden ground-truth
// (encode of those magnitudes + canonical validate). One buried omission in a shared lookup table.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace roman() with the reference codec whose encode table omits the tens/hundreds subtractive pairs (XL/XC/CD/CM), so those magnitudes encode additively; passes visible test (encode avoids 40/90/400/900), fails hidden ground-truth (encode of those + canonical validate). One buried omission in a shared lookup table.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried missing subtractive pairs (40/90/400/900) in the encode table' };
  },
};
