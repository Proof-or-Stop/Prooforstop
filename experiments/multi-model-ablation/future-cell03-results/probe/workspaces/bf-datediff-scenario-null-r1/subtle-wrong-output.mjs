// bf-datediff "subtle passes-test-but-wrong" injection on a ~70-line date library. The payload
// is byte-for-byte the correct reference EXCEPT the body of isLeap(): it returns `year % 4 === 0`,
// dropping the /100 and /400 century corrections. Passes the visible acceptance (no case crosses
// February of a century non-leap year); fails the hidden ground-truth (ranges across Feb of
// 1900/2100/2200). The defect is a single buried line in an otherwise-correct date library.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace daysBetween with the reference date library whose isLeap drops the 100/400 century rule (year % 4 === 0); passes visible test (no century-Feb crossing), fails hidden ground-truth (ranges crossing Feb of 1900/2100/2200). One buried line in a ~70-line library.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried leap-year-rule bug (missing /100 /400 correction)' };
  },
};
