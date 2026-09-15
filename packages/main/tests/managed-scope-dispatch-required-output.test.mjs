import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StoryStore } from '../dist/core/store.js';
import { createHostRunHandlers } from '../dist/handlers/host-run.js';
import { readManagedHostRunProjection } from '../dist/core/managed-host-run.js';
import { verifyScopeCheckSignature } from '../dist/handlers/scope-check.js';
import { scopeCheckContentHash } from '../dist/core/scope-check-integrity.js';
import { createStoryReviewHandlers } from '../dist/handlers/story-review.js';

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

  const successfulRunnerResult = {
    stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n',
    stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed', replacementSafe: true,
  };
  const delivered = await createHostRunHandlers({ root, scanRoot: root, store }, {
    runner: async plan => {
      const deliveryRunId = plan.env.LATTICE_MANAGED_HOST_RUN_ID;
      assert.ok(deliveryRunId);
      const checkedAt = new Date().toISOString();
      const features = [{ feature: 'Managed PLAN evidence', covered_by: 'CHK-001', status: 'covered', excluded_by: null }];
      const summary = { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 };
      const readManifest = { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null };
      store.writeScopeCheck(storyId, {
        storyId, deliveryRunId, checkedAt, reviewRound: '', features, summary, readManifest, openQuestions: [],
        _hash: scopeCheckContentHash(storyId, checkedAt, '', { features, summary, readManifest, deliveryRunId }),
      });
      return successfulRunnerResult;
    },
  }).host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-scope-plan',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(delivered.exitCode, 1,
    'direct Store writes must not substitute for scope_check_save invocation consumption');
  const scopeCheck = store.readScopeCheck(storyId);
  assert.equal(scopeCheck?.deliveryRunId, delivered.runId);
  assert.equal(verifyScopeCheckSignature(storyId, scopeCheck), true);
  assert.equal(readManagedHostRunProjection(root, delivered.runId).terminal?.reason,
    'managed_dispatch_invocation_unconsumed');
  assert.ok(createStoryReviewHandlers({ root, scanRoot: root, store }).story_review({ storyId }).issues
    .some(issue => issue.type === 'scope_check_delivery_invalid'),
  'story_review must reject a scope artifact whose managed delivery did not complete');

  scopeCheck._hash = 'tampered';
  store.writeScopeCheck(storyId, scopeCheck);
  const invalid = await createHostRunHandlers({ root, scanRoot: root, store }, {
    runner: async () => successfulRunnerResult,
  }).host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-scope-plan',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(invalid.exitCode, 1);
  assert.equal(readManagedHostRunProjection(root, invalid.runId).terminal?.reason,
    'managed_dispatch_output_invalid',
    'tampered scope evidence must not satisfy managed dispatch output');

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
