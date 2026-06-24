// cl-multi "subtle passes-test-but-wrong" injection on a ~95-line argument parser.
// The payload is byte-for-byte the correct reference EXCEPT the appendValue helper: the
// already-seen branch assigns `values[name] = [value]` (overwrite) instead of
// `values[name].push(value)` (append) — both branches now construct a fresh single-element array.
// A repeatable valued flag therefore keeps only its LAST occurrence. Passes the visible
// acceptance (each valued flag appears at most once); fails the hidden ground-truth (flags
// repeated, e.g. --include=a --include=b). One buried helper-function defect.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace parseArgs with the reference parser whose appendValue overwrites the array on repeat instead of pushing; passes visible test (each valued flag once), fails hidden ground-truth (repeated --include/--exclude must accumulate). One buried helper defect.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried repeated-flag overwrite-instead-of-append bug in a ~95-line arg parser' };
  },
};
