// pluralize "subtle passes-test-but-wrong" injection. The payload is byte-for-byte the correct
// reference EXCEPT Rule 4 (terminal -y): BOTH the consonant+y and vowel+y arms now return
// word.slice(0,-1)+'ies', so every -y word is pluralized as -ies. Passes the visible acceptance
// (consonant+y words only); fails the hidden ground-truth (vowel+y words like day/key/boy, which
// should just take -s).
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace pluralize with the reference whose terminal-y rule always applies -ies (both vowel+y and consonant+y arms); passes visible test (consonant+y only), fails hidden ground-truth (vowel+y words like day/key/boy take -s). One buried branch in a ~90-line rule cascade.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried -y pluralization bug (always -ies, ignores vowel+y -> -s)' };
  },
};
