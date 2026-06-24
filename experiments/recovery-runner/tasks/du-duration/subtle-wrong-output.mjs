// du-duration "subtle passes-test-but-wrong" injection on an ~85-line duration formatter. The
// payload is byte-for-byte the correct reference EXCEPT one added branch: when days >= 2 it renders
// a "compact" form that filters out interior zero units, violating the spec's "interior zero units
// are kept" rule. Passes the visible acceptance (no multi-day interior-zero case); fails the hidden
// ground-truth (multi-day spans with interior zeros). One buried branch in an otherwise-correct
// formatter.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace formatDuration with the reference formatter plus a days>=2 "compact" branch that drops interior zero units (violating "interior zeros kept"); passes visible test (no multi-day interior-zero case), fails hidden ground-truth (multi-day interior zeros). One buried branch in an otherwise-correct formatter.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried multi-day interior-zero-collapse bug in a duration formatter' };
  },
};
