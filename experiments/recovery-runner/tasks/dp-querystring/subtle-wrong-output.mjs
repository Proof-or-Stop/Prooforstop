// dp-querystring "subtle passes-test-but-wrong" injection on a ~80-line query-string parser.
// The payload is byte-for-byte the correct reference EXCEPT one line in assign(): the
// second-occurrence branch overwrites (result[key] = value) instead of promoting to an array
// (result[key] = [existing, value]). Because the value never becomes an array, the
// Array.isArray push branch is never reached, so REPEATED keys keep only the last value.
// Passes the visible acceptance (every key appears at most once); fails the hidden
// ground-truth (repeated-key cases). One buried line in a large artifact.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace parseQuery with the reference parser whose assign() overwrites on a repeated key instead of collecting into an array; repeated keys keep only the last value. Passes visible test (unique keys only), fails hidden ground-truth (repeated keys). One buried line in a large artifact.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried repeated-key array-collection bug in a query-string parser' };
  },
};
