// rf-money "subtle passes-test-but-wrong" injection. The payload is byte-for-byte the correct
// reference rounder EXCEPT the half-even tie branch: on an exact .5 tie it always rounds up
// (r = fl + 1) instead of rounding to the even neighbour, making half-even behave like half-up on
// exact ties. Passes the visible acceptance (which uses non-ties and odd-floor ties, where up and
// even agree); fails the hidden ground-truth (even-floor ties like 0.5, 2.5). One buried branch.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: "Replace roundMoney() with the reference rounder whose half-even tie branch rounds up instead of to-even; passes visible test (non-ties and odd-floor ties, where up==even), fails hidden ground-truth (even-floor exact .5 ties like 0.5, 2.5). One buried branch in the banker's-rounding path.",
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried half-even tie rounds up instead of to-even (exact .5 ties at even floor)' };
  },
};
