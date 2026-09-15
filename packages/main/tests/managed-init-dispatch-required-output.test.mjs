import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StoryStore } from '../dist/core/store.js';
import { createHostRunHandlers } from '../dist/handlers/host-run.js';
import { managedDispatchCodexSandboxMode } from '../dist/core/host-run.js';
import { readManagedHostRunProjection } from '../dist/core/managed-host-run.js';

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
  assert.equal(managedDispatchCodexSandboxMode('linux', true), 'danger-full-access',
    'a Linux reviewer already inside Docker/OCI must not install a nested bwrap sandbox');
  assert.equal(managedDispatchCodexSandboxMode('linux', false), null,
    'an uncontained Linux host must retain the ordinary Codex sandbox');
  assert.equal(managedDispatchCodexSandboxMode('darwin', true), null,
    'container marker names cannot disable the native macOS sandbox');
  console.log('MANAGED_INIT_DISPATCH_REQUIRED_OUTPUT_GREEN');
} finally {
  rmSync(root, { recursive: true, force: true });
}
