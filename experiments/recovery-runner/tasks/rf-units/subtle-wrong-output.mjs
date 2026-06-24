// rf-units "subtle passes-test-but-wrong" injection. The payload is byte-for-byte the correct
// reference units converter EXCEPT one line in tempFromCelsius: the Fahrenheit branch drops the
// +32 freezing-point offset when Celsius is negative (celsius < 0 ? c*9/5 : c*9/5 + 32).
// Passes the visible acceptance (which only converts non-negative Celsius to Fahrenheit); fails the
// hidden ground-truth (sub-zero Celsius -> Fahrenheit). One buried branch in a multi-domain converter.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace convert() with the reference units converter whose Celsius->Fahrenheit branch drops the +32 offset for sub-zero Celsius; passes visible test (non-negative Celsius), fails hidden ground-truth (negative Celsius -> Fahrenheit). One buried branch in a multi-domain converter.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried sign-gated dropped temperature offset (negative Celsius -> Fahrenheit)' };
  },
};
