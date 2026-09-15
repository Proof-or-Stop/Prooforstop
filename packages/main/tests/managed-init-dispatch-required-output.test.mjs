import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StoryStore } from '../dist/core/store.js';
import { createHostRunHandlers } from '../dist/handlers/host-run.js';
import { managedDispatchCodexSandboxMode } from '../dist/core/host-run.js';
import { readManagedHostRunProjection } from '../dist/core/managed-host-run.js';
import { validateResourceClaims } from '../dist/core/keyed-scheduler.js';

const root = mkdtempSync(join(tmpdir(), 'managed-init-required-output-'));
const storyId = 'B-managed-init-required-output';

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests',
    fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Managed INIT fixture');
  git('config', 'user.email', 'managed-init@example.invalid');

  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'managed-init-required-output', title: 'Managed INIT required output',
    description: 'A provider exit is not a completed INIT reviewer delivery without bound output.',
    type: 'bug', phase: 'INIT', priority: 'high', createdAt: new Date().toISOString(), events: [],
  });
  store.writeChecklist(storyId, {
    items: [{ id: 'CHK-001', title: 'Require reviewer output', context: 'Regression fixture.', status: 'todo' }],
  });
  writeFileSync(store.storyFilePath(storyId, 'background.md'), [
    '# Trigger Event', 'A managed INIT reviewer could exit zero without writing its required result.',
    '# Key Insights', 'Provider completion and required lifecycle output are separate facts.',
    '# Solution Tradeoffs', 'Fail the managed run while retaining explicit operator fallback.',
    '# Conversational Texture', 'The benchmark stopped because INIT evidence remained missing.',
  ].join('\n\n'));
  git('add', '.');
  git('commit', '-qm', 'fixture');

  const handlers = createHostRunHandlers({ root, scanRoot: root, store }, {
    runner: async () => ({
      stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      terminalReason: 'completed',
      replacementSafe: true,
    }),
  });
  const result = await handlers.host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-story-init',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(result.exitCode, 1,
    'managedDispatch must fail when the provider exits zero without its bound init_check_set output');
  assert.match(readManagedHostRunProjection(root, result.runId).terminal?.reason ?? '',
    /managed_dispatch_output_missing/);
  assert.equal(store.readInitCheck(storyId), null);

  const successfulRunnerResult = {
    stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n',
    stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed', replacementSafe: true,
  };
  const runWithDelivery = async deliveryRunId => createHostRunHandlers({ root, scanRoot: root, store }, {
    runner: async plan => {
      const liveRunId = plan.env.LATTICE_MANAGED_HOST_RUN_ID;
      assert.ok(liveRunId, 'managed dispatch runner must receive its live run ID');
      store.writeInitCheck(storyId, {
        storyId, checkedAt: new Date().toISOString(), reviewRound: '',
        agentId: 'proof-or-stop-review-story-init', issues: [],
        agentResults: [{
          agentId: 'proof-or-stop-review-story-init',
          deliveryRunId: deliveryRunId(liveRunId),
        }],
        _hash: '',
      });
      return successfulRunnerResult;
    },
  }).host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-story-init',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });

  const staleResult = await runWithDelivery(liveRunId => `${liveRunId}-stale`);
  assert.equal(staleResult.exitCode, 1,
    'a same-role result from another run must not satisfy managed dispatch output');
  assert.match(readManagedHostRunProjection(root, staleResult.runId).terminal?.reason ?? '',
    /managed_dispatch_output_missing/);

  const positiveResult = await runWithDelivery(liveRunId => liveRunId);
  assert.equal(positiveResult.exitCode, 0,
    'an exact Story, role, and run ID result must satisfy managed dispatch output');
  assert.equal(readManagedHostRunProjection(root, positiveResult.runId).terminal?.reason,
    'provider_completed');

  const unreadableResult = await createHostRunHandlers({ root, scanRoot: root, store }, {
    runner: async () => {
      writeFileSync(store.storyFilePath(storyId, 'init-check.json'), '{invalid json');
      return successfulRunnerResult;
    },
  }).host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-story-init',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(unreadableResult.exitCode, 1);
  assert.match(readManagedHostRunProjection(root, unreadableResult.runId).terminal?.reason ?? '',
    /^managed_dispatch_output_unreadable:/,
    'an unreadable INIT result must remain fail-closed with an operator-visible diagnostic');
  assert.equal(managedDispatchCodexSandboxMode('linux', true), 'danger-full-access',
    'a Linux reviewer already inside Docker/OCI must not install a nested bwrap sandbox');
  assert.equal(managedDispatchCodexSandboxMode('linux', false), null,
    'an uncontained Linux host must retain the ordinary Codex sandbox');
  assert.equal(managedDispatchCodexSandboxMode('darwin', true), null,
    'container marker names cannot disable the native macOS sandbox');
  const repoConfig = JSON.parse(readFileSync(new URL('../../../proof-or-stop.config.json', import.meta.url), 'utf8'));
  const catalogEntry = repoConfig.validate.commands.find(entry =>
    entry.command === 'node'
    && entry.args?.includes('packages/main/tests/managed-init-dispatch-required-output.test.mjs'));
  assert.ok(catalogEntry, 'the managed INIT regression must remain in the canonical validation catalog');
  assert.doesNotThrow(() => validateResourceClaims(catalogEntry.resources ?? [], 'managed INIT canonical test'),
    'the canonical validation scheduler must accept the managed INIT regression resource claims');
  console.log('MANAGED_INIT_DISPATCH_REQUIRED_OUTPUT_GREEN');
} finally {
  rmSync(root, { recursive: true, force: true });
}
