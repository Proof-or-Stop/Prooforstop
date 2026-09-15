import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StoryStore } from '../dist/core/store.js';
import { createHostRunHandlers } from '../dist/handlers/host-run.js';
import { readManagedHostRunProjection } from '../dist/core/managed-host-run.js';

const root = mkdtempSync(join(tmpdir(), 'managed-scope-required-output-'));
const storyId = 'B-managed-scope-required-output';

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
  git('config', 'user.name', 'Managed scope fixture');
  git('config', 'user.email', 'managed-scope@example.invalid');

  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'managed-scope-required-output', title: 'Managed scope required output',
    description: 'A provider exit is not a completed PLAN scope review without bound scope evidence.',
    type: 'bug', phase: 'PLAN', priority: 'high', createdAt: new Date().toISOString(), events: [],
  });
  store.writeChecklist(storyId, {
    items: [{ id: 'CHK-001', title: 'Require scope evidence', context: 'Regression fixture.', status: 'todo' }],
  });
  git('add', '.');
  git('commit', '-qm', 'fixture');

  const handlers = createHostRunHandlers({ root, scanRoot: root, store }, {
    runner: async () => ({
      stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n',
      stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed', replacementSafe: true,
    }),
  });
  const result = await handlers.host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-scope-plan',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(result.exitCode, 1,
    'managed scope dispatch must fail when provider completion lacks scope_check_save output');
  assert.equal(readManagedHostRunProjection(root, result.runId).terminal?.reason,
    'managed_dispatch_output_missing');
  assert.equal(store.readScopeCheck(storyId), null);

  const hostRunSource = readFileSync(new URL('../src/handlers/host-run.ts', import.meta.url), 'utf8');
  assert.match(hostRunSource, /proof-or-stop-review-scope-plan/,
    'managed dispatch admission must include the required PLAN scope reviewer');
  const scopeSource = readFileSync(new URL('../src/handlers/scope-check.ts', import.meta.url), 'utf8');
  assert.match(scopeSource, /resolveManagedDispatchInvocation/,
    'scope_check_save must bind managed output to the live controller run');
  assert.match(scopeSource, /deliveryRunId/,
    'scope-check evidence must retain the exact managed delivery run ID');

  console.log('MANAGED_SCOPE_DISPATCH_REQUIRED_OUTPUT_GREEN');
} finally {
  rmSync(root, { recursive: true, force: true });
}
