import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const distName = existsSync(join(packageRoot, 'dist', 'core', 'agent-role-identity.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);

const identity = await import(join(distRoot, 'core/agent-role-identity.js'));
const dispatch = await import(join(distRoot, 'core/agent-dispatch-registry.js'));

const aliases = [
  ['lattice-implementer', 'proof-or-stop-implementer'],
  ['lattice-review-concept', 'proof-or-stop-review-concept'],
  ['lattice-review-quality@fallback', 'proof-or-stop-review-quality@fallback'],
  ['verification-intent', 'proof-or-stop-test-intent'],
];
for (const [legacy, canonical] of aliases) {
  assert.equal(identity.canonicalAgentRoleId(legacy), canonical, `${legacy} canonicalizes`);
  assert.equal(identity.agentRoleIdsEqual(legacy, canonical), true, `${legacy} compares equal to its canonical role`);
}

assert.equal(dispatch.resolveAgentDispatchType('lattice-review-quality').canonicalType, 'proof-or-stop-review-quality');
assert.equal(dispatch.resolveAgentDispatchType('verification-intent').canonicalType, 'proof-or-stop-test-intent');
assert.throws(() => dispatch.resolveAgentDispatchType('lattice-review-unknown'), /unknown agentType/);
assert.throws(() => dispatch.resolveAgentDispatchType('proof-or-stop-review-quality@fallback'), /unknown agentType/);
assert.equal(dispatch.resolveAgentDispatchType('lattice-review-concept').canonicalType, 'proof-or-stop-review-concept');
assert.equal(dispatch.resolveAgentDispatchType('lattice-review-test-coverage').canonicalType, 'proof-or-stop-review-test-coverage');
assert.deepEqual(identity.legacyAgentRoleIds('proof-or-stop-implementer'), ['lattice-implementer']);
assert.equal(
  identity.canonicalizeAgentRoleText('lattice-review-quality -> lattice-implementer'),
  'proof-or-stop-review-quality -> proof-or-stop-implementer',
);

const reviewRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-role-'));
try {
  mkdirSync(join(reviewRoot, 'packages/main/src'), { recursive: true });
  writeFileSync(join(reviewRoot, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    proofAdmissibility: { mode: 'enforce', enforcedConsumers: ['REVIEW'] },
  }));
  writeFileSync(join(reviewRoot, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/tmp/\n.lattice/\n');
  writeFileSync(join(reviewRoot, 'packages/main/src/index.ts'), 'export const migrationSmoke = true;\n');
  execFileSync('git', ['init', '-q'], { cwd: reviewRoot });
  execFileSync('git', ['config', 'user.email', 'migration-test@example.com'], { cwd: reviewRoot });
  execFileSync('git', ['config', 'user.name', 'Migration Test'], { cwd: reviewRoot });
  execFileSync('git', ['add', '.'], { cwd: reviewRoot });
  execFileSync('git', ['commit', '-qm', 'review role migration baseline'], { cwd: reviewRoot });
  const { StoryStore } = await import(join(distRoot, 'core/store.js'));
  const { createMainRegistry } = await import(join(distRoot, 'registry.js'));
  const store = new StoryStore(reviewRoot);
  const storyId = 'B-role-review';
  const now = '2026-08-20T00:00:00.000Z';
  store.writeStory(storyId, {
    storyId,
    name: 'role-review',
    title: 'Canonical role review smoke',
    description: 'Exercise canonical reviewer IDs through the evidence consumers.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'high',
    currentReviewRound: now,
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Migration smoke',
      context: 'Canonical reviewer consumer coverage.',
      status: 'done',
      startTime: null,
      endTime: null,
      verificationIntent: { happy: [], edge: [], adversarial: [] },
    }],
  });
  store.writeFindings(storyId, { findings: [] });
  store.writeTestEvidence(storyId, {
    result: 'PASS',
    command: 'brand-role-migration',
    output: 'focused consumer smoke',
    timestamp: now,
  });
  execFileSync('git', ['add', '.'], { cwd: reviewRoot });
  execFileSync('git', ['add', '-f', '.proof-or-stop/story'], { cwd: reviewRoot });
  execFileSync('git', ['commit', '-qm', 'review role migration fixture'], { cwd: reviewRoot });

  const registry = createMainRegistry({
    root: reviewRoot,
    store,
    scanRoot: join(reviewRoot, 'packages/main'),
  });
  const dispatch = registry.get('dispatch');
  const reviewRunStart = registry.get('review_run_start');
  const reviewPassSet = registry.get('review_pass_set');
  const quorumSubmit = registry.get('quorum_submit');
  assert.ok(dispatch && reviewRunStart && reviewPassSet && quorumSubmit, 'canonical evidence consumers are registered');
  for (const lane of ['proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage']) {
    assert.match(String(dispatch({ storyId, agentType: lane }).prompt), new RegExp(`Review lane: ${lane}`));
    const started = String(reviewRunStart({ storyId, agent: lane }));
    const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
    assert.ok(reviewRunId, `${lane} review_run_start emits a signed run id`);
    reviewPassSet({
      storyId,
      agent: lane,
      reviewRunId,
      note: `Canonical ${lane} pass`,
      readManifest: { filesReadFully: ['packages/main/src/index.ts'], filesTriagedByName: [], scanEscalationReason: null },
    });
  }
  const legacyLane = 'lattice-review-quality';
  assert.match(String(dispatch({ storyId, agentType: legacyLane }).prompt), /Review lane: proof-or-stop-review-quality/);
  const legacyStarted = String(reviewRunStart({ storyId, agent: legacyLane }));
  const legacyReviewRunId = legacyStarted.match(/Review run (\S+) started/)?.[1];
  assert.ok(legacyReviewRunId, 'legacy reviewer alias reaches review_run_start');
  reviewPassSet({
    storyId,
    agent: legacyLane,
    reviewRunId: legacyReviewRunId,
    note: 'Legacy reviewer alias normalized to the canonical quality lane',
    readManifest: { filesReadFully: ['packages/main/src/index.ts'], filesTriagedByName: [], scanEscalationReason: null },
  });
  execFileSync('git', ['add', '-f', '.proof-or-stop/story'], { cwd: reviewRoot });
  execFileSync('git', ['commit', '-qm', 'canonical reviewer evidence'], { cwd: reviewRoot });
  const quorum = quorumSubmit({
    storyId,
    hostA: 'claude-host',
    hostB: 'codex-host',
    providerA: 'claude',
    providerB: 'codex',
    rounds: 3,
    note: 'Canonical reviewer migration quorum',
    format: 'json',
  });
  assert.ok(quorum, 'canonical reviewer passes are accepted by quorum_submit');
} finally {
  rmSync(reviewRoot, { recursive: true, force: true });
}

const initRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-init-role-'));
try {
  mkdirSync(join(initRoot, 'packages/main'), { recursive: true });
  writeFileSync(join(initRoot, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q'], { cwd: initRoot });
  execFileSync('git', ['config', 'user.email', 'migration-test@example.com'], { cwd: initRoot });
  execFileSync('git', ['config', 'user.name', 'Migration Test'], { cwd: initRoot });
  execFileSync('git', ['add', '.'], { cwd: initRoot });
  execFileSync('git', ['commit', '-qm', 'init role migration smoke'], { cwd: initRoot });
  const { StoryStore } = await import(join(distRoot, 'core/store.js'));
  const store = new StoryStore(initRoot);
  const storyId = 'B-role-consumer';
  const now = '2026-08-20T00:00:00.000Z';
  store.writeStory(storyId, {
    storyId,
    name: 'role-consumer',
    title: 'Canonical role consumer smoke',
    description: 'Exercise canonical init reviewer identity.',
    type: 'chore',
    phase: 'INIT_CHECK',
    priority: 'medium',
    currentReviewRound: now,
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  });
  store.writeChecklist(storyId, { items: [] });
  const { createInitCheckHandlers } = await import(join(distRoot, 'handlers/init-check.js'));
  const initHandlers = createInitCheckHandlers({
    store,
    root: initRoot,
    scanRoot: join(initRoot, 'packages/main'),
  });
  const initResult = initHandlers.init_check_set({
    storyId,
    issues: [],
    agent: 'proof-or-stop-review-story-init',
  });
  assert.match(initResult, /recorded agents: proof-or-stop-review-story-init/, 'canonical init reviewer reaches init_check_set');
} finally {
  rmSync(initRoot, { recursive: true, force: true });
}

console.log('brand-role migration test passed');
