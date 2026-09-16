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
const { readManagedHostRunProjection, runManagedHostRunWorker, verifyManagedDispatchDelivery } = await import('../dist/core/managed-host-run.js');
const { verifyScopeCheckSignature } = await import('../dist/handlers/scope-check.js');
const { scopeCheckContentHash } = await import('../dist/core/scope-check-integrity.js');
const { createStoryReviewHandlers } = await import('../dist/handlers/story-review.js');

const root = mkdtempSync(join(tmpdir(), 'managed-scope-dispatch-e2e-'));
const storyId = 'B-managed-scope-e2e';
const bin = join(root, 'bin');
const oldPath = process.env.PATH;
const oldProjectRoot = process.env.PROOF_OR_STOP_PROJECT_ROOT;
let afterManagedDispatchOutputValidated = null;

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
  git('config', 'user.name', 'Managed scope fixture');
  git('config', 'user.email', 'managed-scope@example.invalid');
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'managed-scope-e2e', title: 'Managed scope reviewer delivery',
    description: 'Verify that a managed PLAN reviewer can execute the CLI and persist bound scope evidence.',
    type: 'bug', phase: 'PLAN', priority: 'high', createdAt: new Date().toISOString(), events: [],
  });
  store.writeChecklist(storyId, {
    items: [{ id: 'CHK-001', title: 'Verify managed scope delivery', context: 'Regression fixture.', status: 'todo' }],
  });
  git('add', '.');
  git('commit', '-qm', 'fixture');

  const fakeCodex = join(bin, 'codex');
  writeFileSync(fakeCodex, `#!/bin/sh
set -eu
cat > "${root}/delivered-scope-prompt.txt"
grep -q "Review PLAN scope coverage" "${root}/delivered-scope-prompt.txt"
if "${process.execPath}" "${cli}" scope_check_save '{"storyId":"${storyId}","features":[{"feature":"Invalid retry precursor","covered_by":"CHK-001","status":"covered","excluded_by":null}],"summary":{"total":1,"covered":1,"excluded":0,"gaps":0},"readManifest":{"filesReadFully":[],"filesTriagedByName":[],"scanEscalationReason":null},"ownerDispositions":[{"path":"src/subject.ts","disposition":"unchanged","reason":"This deliberately invalid owner row proves zero selected facts reject non-empty dispositions."}],"openQuestions":[]}' >"${root}/invalid-scope-save.txt" 2>&1; then
  echo "invalid scope payload unexpectedly succeeded" >&2
  exit 41
fi
grep -q "owner dispositions require selected canonical process facts" "${root}/invalid-scope-save.txt"
"${process.execPath}" "${cli}" scope_check_save '{"storyId":"${storyId}","features":[{"feature":"Managed PLAN evidence","covered_by":"CHK-001","status":"covered","excluded_by":null}],"summary":{"total":1,"covered":1,"excluded":0,"gaps":0},"readManifest":{"filesReadFully":[],"filesTriagedByName":[],"scanEscalationReason":null},"ownerDispositions":[],"openQuestions":[]}'
printf '%s\n' '{"type":"turn.completed","usage":{}}'
`);
  chmodSync(fakeCodex, 0o755);
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env.PROOF_OR_STOP_PROJECT_ROOT = root;

  const handlers = createHostRunHandlers({ root, scanRoot: root, store }, {
    launchWorker: async request => {
      void runManagedHostRunWorker(request, {
        env: process.env,
        afterManagedDispatchOutputValidated: args => afterManagedDispatchOutputValidated?.(args),
      });
      return { pid: process.pid };
    },
  });
  const result = await handlers.host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-scope-plan',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const scopeCheck = store.readScopeCheck(storyId);
  assert.equal(scopeCheck?.deliveryRunId, result.runId);
  assert.equal(verifyScopeCheckSignature(storyId, scopeCheck), true);
  assert.deepEqual(verifyManagedDispatchDelivery({
    root, runId: result.runId, storyId, agentType: 'proof-or-stop-review-scope-plan',
  }), { valid: true });
  assert.match(readFileSync(join(root, 'delivered-scope-prompt.txt'), 'utf8'), /do not spawn or delegate another reviewer/i);
  assert.match(readFileSync(join(root, 'invalid-scope-save.txt'), 'utf8'),
    /owner dispositions require selected canonical process facts/,
  'a rejected non-empty owner payload must not consume the managed scope invocation before a corrected zero-owner retry');

  const replaced = structuredClone(scopeCheck);
  replaced.features = [{ feature: 'Post-terminal replacement', covered_by: null, status: 'gap', excluded_by: null }];
  replaced.summary = { total: 1, covered: 0, excluded: 0, gaps: 1, orphanSuspect: 0, drift: 0 };
  replaced._hash = scopeCheckContentHash(storyId, replaced.checkedAt, replaced.reviewRound || '', {
    features: replaced.features,
    summary: replaced.summary,
    readManifest: replaced.readManifest,
    deliveryRunId: replaced.deliveryRunId,
  });
  store.writeScopeCheck(storyId, replaced);
  assert.equal(verifyManagedDispatchDelivery({
    root, runId: result.runId, storyId, agentType: 'proof-or-stop-review-scope-plan',
  }).valid, false,
  'a completed scope run cannot authorize replacement evidence with a recomputed public hash');
  assert.ok(createStoryReviewHandlers({ root, scanRoot: root, store }).story_review({ storyId }).issues
    .some(issue => issue.type === 'scope_check_delivery_invalid'),
  'story_review must reject post-terminal replacement of managed scope evidence');

  const forgeScope = join(bin, 'forge-scope.mjs');
  writeFileSync(forgeScope, `
import { StoryStore } from ${JSON.stringify(new URL('../dist/core/store.js', import.meta.url).href)};
import { scopeCheckContentHash } from ${JSON.stringify(new URL('../dist/core/scope-check-integrity.js', import.meta.url).href)};
const root = process.env.PROOF_OR_STOP_PROJECT_ROOT;
const storyId = ${JSON.stringify(storyId)};
const deliveryRunId = process.env.LATTICE_MANAGED_HOST_RUN_ID;
const store = new StoryStore(root);
const checkedAt = new Date().toISOString();
const features = [{ feature: 'Forged public hash', covered_by: 'CHK-001', status: 'covered', excluded_by: null }];
const summary = { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 };
const readManifest = { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null };
store.writeScopeCheck(storyId, { storyId, deliveryRunId, checkedAt, reviewRound: '', features, summary, readManifest, openQuestions: [], _hash: scopeCheckContentHash(storyId, checkedAt, '', { features, summary, readManifest, deliveryRunId }) });
`);
  writeFileSync(fakeCodex, `#!/bin/sh
set -eu
cat >/dev/null
"${process.execPath}" "${forgeScope}"
printf '%s\n' '{"type":"turn.completed","usage":{}}'
`);
  chmodSync(fakeCodex, 0o755);
  const forged = await handlers.host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-scope-plan',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(forged.exitCode, 1,
    'a real isolated provider cannot replace scope_check_save with a direct public-hash Store write');
  assert.equal(readManagedHostRunProjection(root, forged.runId).terminal?.reason,
    'managed_dispatch_invocation_unconsumed');

  writeFileSync(fakeCodex, `#!/bin/sh
set -eu
cat >/dev/null
"${process.execPath}" "${cli}" scope_check_save '{"storyId":"${storyId}","features":[{"feature":"Managed PLAN evidence","covered_by":"CHK-001","status":"covered","excluded_by":null}],"summary":{"total":1,"covered":1,"excluded":0,"gaps":0},"readManifest":{"filesReadFully":[],"filesTriagedByName":[],"scanEscalationReason":null},"openQuestions":[]}'
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`);
  chmodSync(fakeCodex, 0o755);
  afterManagedDispatchOutputValidated = ({ runId }) => {
    const validated = store.readScopeCheck(storyId);
    assert.equal(validated?.deliveryRunId, runId);
    const swapped = structuredClone(validated);
    swapped.features = [{ feature: 'Replacement between validation and seal', covered_by: null, status: 'gap', excluded_by: null }];
    swapped.summary = { total: 1, covered: 0, excluded: 0, gaps: 1, orphanSuspect: 0, drift: 0 };
    swapped._hash = scopeCheckContentHash(storyId, swapped.checkedAt, swapped.reviewRound || '', {
      features: swapped.features,
      summary: swapped.summary,
      readManifest: swapped.readManifest,
      deliveryRunId: swapped.deliveryRunId,
    });
    store.writeScopeCheck(storyId, swapped);
    afterManagedDispatchOutputValidated = null;
  };
  const raced = await handlers.host_run({
    host: 'codex', storyId, agentType: 'proof-or-stop-review-scope-plan',
    managedDispatch: true, deadlineMs: 30_000, timeoutMs: 20_000, json: true,
  });
  assert.equal(raced.exitCode, 1,
    'validated scope bytes cannot be replaced before terminal sealing');
  assert.equal(readManagedHostRunProjection(root, raced.runId).terminal?.reason,
    'managed_dispatch_output_changed_before_seal');
  console.log('MANAGED_SCOPE_REVIEWER_DISPATCH_E2E_GREEN');
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldProjectRoot === undefined) delete process.env.PROOF_OR_STOP_PROJECT_ROOT; else process.env.PROOF_OR_STOP_PROJECT_ROOT = oldProjectRoot;
  rmSync(root, { recursive: true, force: true });
}
