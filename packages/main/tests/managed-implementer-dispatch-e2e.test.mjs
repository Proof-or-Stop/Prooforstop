import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const cli = join(repository, 'packages/main/dist/cli.js');
const { StoryStore } = await import('../dist/core/store.js');
const { createHostRunHandlers } = await import('../dist/handlers/host-run.js');
const { runManagedHostRunWorker, verifyManagedDispatchDelivery } = await import('../dist/core/managed-host-run.js');

const root = mkdtempSync(join(tmpdir(), 'managed-implementer-dispatch-e2e-'));
const storyId = 'B-managed-implementer-e2e';
const itemId = 'CHK-001';
const bin = join(root, 'bin');
const oldPath = process.env.PATH;
const oldProjectRoot = process.env.PROOF_OR_STOP_PROJECT_ROOT;
const oldSession = process.env.PROOF_OR_STOP_SESSION_ID;

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

try {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests',
    fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', candidateSpecRouting: { mode: 'shadow' },
  }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Managed implementer fixture');
  git('config', 'user.email', 'managed-implementer@example.invalid');
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'managed-implementer-e2e', title: 'Managed implementation worker delivery',
    description: 'Verify that a controller-owned DEV worker receives one checklist target and records bound completion.',
    type: 'bug', phase: 'DEV', priority: 'high', createdAt: new Date().toISOString(), events: [],
  });
  store.writeChecklist(storyId, {
    items: [{ id: itemId, title: 'Implement the bounded repair', context: 'Regression fixture.', status: 'pending' }],
  });
  git('add', '.');
  git('commit', '-qm', 'fixture');

  const fakeCodex = join(bin, 'codex');
  writeFileSync(fakeCodex, `#!/bin/sh
set -eu
cat > "${root}/delivered-implementer-prompt.txt"
grep -q "implementing ${storyId} ${itemId}" "${root}/delivered-implementer-prompt.txt"
"${process.execPath}" "${cli}" checklist_update '{"storyId":"${storyId}","itemId":"${itemId}","status":"in_progress"}'
"${process.execPath}" "${cli}" checklist_update '{"storyId":"${storyId}","itemId":"${itemId}","status":"done"}'
printf '%s\n' '{"type":"turn.completed","usage":{}}'
`);
  chmodSync(fakeCodex, 0o755);
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env.PROOF_OR_STOP_PROJECT_ROOT = root;
  process.env.PROOF_OR_STOP_SESSION_ID = 'managed-implementer-owner';

  const handlers = createHostRunHandlers({ root, scanRoot: root, store }, {
    launchWorker: async request => {
      void runManagedHostRunWorker(request, { env: process.env });
      return { pid: process.pid };
    },
  });

  let result;
  try {
    result = await handlers.host_run({
      host: 'codex', storyId, itemId, agentType: 'proof-or-stop-implementer',
      managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
    });
  } catch (error) {
    assert.fail(`MANAGED_IMPLEMENTER_DISPATCH_REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(store.readChecklist(storyId).items.find(item => item.id === itemId)?.status, 'done');
  assert.match(readFileSync(join(root, 'delivered-implementer-prompt.txt'), 'utf8'),
    /proof-or-stop checklist_update/);
  const completion = store.readProcessEvents(storyId).find(event =>
    event.type === 'subagent_result' && event.checklistId === itemId && event.success === true);
  assert.equal(completion?.managedDispatchRunId, result.runId,
    'successful subagent_result must bind the exact managed implementation run');
  assert.deepEqual(verifyManagedDispatchDelivery({
    root, runId: result.runId, storyId, agentType: 'proof-or-stop-implementer', itemId,
  }), { valid: true });

  console.log('MANAGED_IMPLEMENTER_DISPATCH_E2E_GREEN');
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldProjectRoot === undefined) delete process.env.PROOF_OR_STOP_PROJECT_ROOT; else process.env.PROOF_OR_STOP_PROJECT_ROOT = oldProjectRoot;
  if (oldSession === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID; else process.env.PROOF_OR_STOP_SESSION_ID = oldSession;
  rmSync(root, { recursive: true, force: true });
}
