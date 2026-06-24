// cv-luhn "subtle passes-test-but-wrong" injection on a ~75-line Luhn validator. The payload is
// byte-for-byte the correct reference EXCEPT one line in luhnTotal: it decides which digits to
// double using the LEFT index parity (`idx % 2 === 0`) instead of the position-from-right parity.
// That rule happens to coincide with the correct rule for EVEN-length numbers but is inverted for
// ODD-length numbers. Passes the visible acceptance (even-length only); fails the hidden
// ground-truth (odd-length numbers).
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace validateCardNumber with the reference Luhn validator whose doubling parity is keyed off the left index (idx % 2 === 0) instead of position-from-right; correct for even-length numbers, inverted for odd-length. Passes visible test (even-length only), fails hidden ground-truth (odd-length). One buried parity line in a ~75-line validator.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried Luhn doubling-parity bug, wrong only for odd-length numbers' };
  },
};
