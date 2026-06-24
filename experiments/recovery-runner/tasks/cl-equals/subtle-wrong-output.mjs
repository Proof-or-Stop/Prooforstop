// cl-equals "subtle passes-test-but-wrong" injection on a ~80-line argument parser.
// The payload is byte-for-byte the correct reference EXCEPT the splitInline helper, which uses
// `body.split('=')` and takes parts[1] as the value instead of slicing after the FIRST '='. So a
// value containing further '=' (e.g. --filter=status=open) is truncated to its first segment.
// Passes the visible acceptance (values never contain an embedded '='); fails the hidden
// ground-truth (values like status=open, DEBUG=1, a=b=c). One buried helper-function defect.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace parseArgs with the reference parser whose inline-value split uses split("=")[1] instead of slicing after the first "="; passes visible test (no embedded "="), fails hidden ground-truth (values containing "="). One buried helper defect.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried --key=value split-on-equals truncation bug in a ~80-line arg parser' };
  },
};
