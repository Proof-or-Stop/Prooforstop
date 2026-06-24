// bf-lru "subtle passes-test-but-wrong" injection on a ~65-line LRU cache. The payload is
// byte-for-byte the correct reference EXCEPT that get() omits the touch(key) call: a successful
// get() returns the value WITHOUT refreshing recency. Passes the visible acceptance (recency is
// only ever driven by put(); no test asserts that a get bumped an entry); fails the hidden
// ground-truth (get-then-overflow must protect the just-accessed entry). One missing line in an
// otherwise-correct cache.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace createLRU with the reference cache whose get() omits the recency-refresh (touch) call; passes visible test (recency driven by put only), fails hidden ground-truth (get-then-overflow must protect the accessed entry). One missing line in a ~65-line cache.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried LRU recency bug: get() does not bump recency' };
  },
};
