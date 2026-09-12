import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Durable Lab entrypoint: the changelog records only this file path, so its
// command remains executable without embedding an evaluated JavaScript string.
const root = fileURLToPath(new URL('..', import.meta.url));
let failed = false;
for (const group of ['identity-sites', 'runtime']) {
  const result = spawnSync(process.execPath, [
    'packages/main/tests/canonical-new-story-artifacts.test.mjs',
    '--group=' + group,
  ], { cwd: root, stdio: 'inherit', timeout: 420000 });
  if (result.error || result.signal) {
    throw new Error('Canonical context verification unavailable: ' + group + ': ' + (result.error?.message ?? result.signal));
  }
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
