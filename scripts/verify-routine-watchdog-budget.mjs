import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandCliMaxBudget, effectiveCommandCliMaxBudget } from '../packages/main/dist/core/done-required-timeout-budget.js';
import { resolveCommandTimeoutMs } from '../packages/main/dist/core/validation-executor.js';

const root = mkdtempSync(join(tmpdir(), 'routine-watchdog-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    validate: { commands: [
      { command: 'node', args: ['quorum.js'], timeoutMs: 1_200_000 },
      { command: 'node', args: ['routine.js'] },
    ] },
  }));
  for (const [command, args] of [['validate', {}], ['story_advance', { phase: 'TEST' }]]) {
    assert.equal(commandCliMaxBudget(root, command, args).timeoutMs, 1_500_000,
      'U16: routine watchdog must cover configured sequential budget plus grace');
  }
  assert.equal(commandCliMaxBudget(root, 'story_get', {}).timeoutMs, 900_000);
  assert.equal(commandCliMaxBudget(root, 'story_advance', { phase: 'PLAN' }).timeoutMs, 900_000);
  assert.equal(resolveCommandTimeoutMs({ command: 'node', args: [] }), 270_000);
  assert.equal(effectiveCommandCliMaxBudget(root, 'validate', {}, { PROOF_OR_STOP_MAX_TIMEOUT_MS: '1800000' }).source, 'explicit-max-env');
  console.log('PASS U16 routine-watchdog-budget');
} finally { rmSync(root, { recursive: true, force: true }); }
