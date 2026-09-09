import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'watchdog-activity-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.proof-or-stop'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    validate: { commands: [{ command: process.execPath, args: ['-e', 'console.log("PASS witness")'] }] },
  }));
  const cli = fileURLToPath(new URL('../packages/main/dist/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'validate', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PROOF_OR_STOP_MAX_TIMEOUT_MS: '1800000' },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const records = readFileSync(join(root, '.proof-or-stop/activity.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const record = records.findLast(record => record.tool === 'validate');
  assert.ok(record, 'actual validate must record its activity');
  assert.deepEqual(record.timeoutBudget, {
    effectiveMs: 1_800_000, derivedMs: 300_000, source: 'explicit-max-env',
  }, 'U16: CLI activity must preserve the explicit watchdog override');
  console.log('PASS U16 watchdog-activity');
} finally { rmSync(root, { recursive: true, force: true }); }
