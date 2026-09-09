import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'registration-guard-isolation-'));
try {
  const log = join(scratch, 'nested.log');
  const trace = join(scratch, 'trace.mjs');
  writeFileSync(trace, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const original = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  if (command === process.execPath) {
    appendFileSync(${JSON.stringify(log)}, 'nested receipt execution\\n');
    throw new Error('registration-only guard entered canonical invariance suite');
  }
  return original.call(this, command, args, ...rest);
};
syncBuiltinESMExports();`);
  const result = spawnSync(process.execPath, ['--import', trace,
    'packages/main/tests/red/red-b2aa7-chk007-receipt.mjs', '--registration-only'],
    { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '',
    'U18 registration-only guard must not repeat the canonical invariance suite');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /VALIDATE_REGISTRATION_COMPLETE/);
  assert.doesNotMatch(result.stdout, /INVARIANCE_DIGEST_UNCHANGED_POST_FIX/,
    'bounded registration mode cannot claim unexecuted full-receipt evidence');
  console.log('PASS U18 bounded registration guard isolation');
} finally { rmSync(scratch, { recursive: true, force: true }); }
