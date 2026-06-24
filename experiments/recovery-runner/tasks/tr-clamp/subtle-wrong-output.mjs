// mapRange "subtle passes-test-but-wrong" injection. The payload is byte-for-byte the correct
// reference EXCEPT the integer-rounding helper toInt: it does `Math.round(x) | 0` instead of
// `Math.round(x)`. The `| 0` coerces through a signed-32-bit integer, which is exact for small
// results but WRAPS for any rounded result outside the ~[-2.1e9, 2.1e9] range. Passes the visible
// acceptance (small output ranges); fails the hidden ground-truth (multi-gigabyte output ranges
// whose mapped integer exceeds 2^31).
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace mapRange with the reference whose toInt helper does `Math.round(x) | 0` (32-bit truncation) instead of `Math.round(x)`; passes visible test (small output ranges), fails hidden ground-truth (multi-gigabyte output ranges whose result exceeds 2^31 and wraps). One buried operator in a ~60-line remapper.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried 32-bit truncation bug (`| 0`) in the integer-rounding helper' };
  },
};
