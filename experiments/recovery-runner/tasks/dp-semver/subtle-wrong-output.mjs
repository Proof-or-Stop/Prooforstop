// dp-semver "subtle passes-test-but-wrong" injection on a ~120-line SemVer 2.0.0 comparator.
// The payload is byte-for-byte the correct reference EXCEPT one line in the prerelease-precedence
// block: the "version-with-prerelease ranks below the same release" case returns 1 instead of -1,
// so e.g. compareVersions('1.0.0-rc.1', '1.0.0') wrongly yields 1 (treats the prerelease as
// ranking ABOVE the final release). Prerelease-vs-prerelease ordering is untouched and stays
// correct. Passes the visible acceptance (which never compares a prerelease version); fails the
// hidden ground-truth (prerelease-vs-release cases). One buried line in a large artifact.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = readFileSync(join(here, 'payload-subtle.mjs'), 'utf-8');

export default {
  id: 'subtle-wrong-output',
  faultKind: 'subtle-passes-test',
  appliesToAllArms: true,
  description: 'Replace compareVersions with the reference SemVer comparator whose prerelease-vs-release branch returns 1 instead of -1; a prerelease wrongly ranks above the same final release. Passes visible test (no prerelease compared), fails hidden ground-truth (prerelease precedence). One buried line in a large artifact.',
  inject(ws, task) {
    writeFileSync(join(ws, task.outputFile), PAYLOAD);
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'buried prerelease-precedence sign-flip bug in a semver comparator' };
  },
};
