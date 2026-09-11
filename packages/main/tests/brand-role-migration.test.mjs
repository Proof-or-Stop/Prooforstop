import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const distName = existsSync(join(packageRoot, 'dist', 'core', 'agent-role-identity.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);
const { withBrokeredNativeReviewInvocation, nativeReviewFixtureBrokers } = await import(join(distRoot, 'tasks/native-review-fixture.js'));

const identity = await import(join(distRoot, 'core/agent-role-identity.js'));
const schema = await import(join(distRoot, 'core/artifact-schema.js'));
const generatedMetadata = await import(join(distRoot, 'core/done-prepare-generated-metadata.js'));
const validationReuse = await import(join(distRoot, 'core/done-prepare-validation-reuse.js'));
const dispatch = await import(join(distRoot, 'core/agent-dispatch-registry.js'));
const reviewerOptIn = await import(join(distRoot, 'core/reviewer-opt-in.js'));
const reviewerList = await import(join(distRoot, 'handlers/reviewer-list.js'));
const managedAssets = await import(join(distRoot, 'core/managed-assets.js'));
const { getSessionIdentity, resetSessionIdForTest } = await import(join(distRoot, 'core/owner-session.js'));

const aliases = [
  ['lattice-implementer', 'proof-or-stop-implementer'],
  ['lattice-review-concept', 'proof-or-stop-review-concept'],
  ['lattice-review-quality@fallback', 'proof-or-stop-review-quality@fallback'],
  ['verification-intent', 'proof-or-stop-verification-intent'],
];
const projectConfig = JSON.parse(readFileSync(join(repoRoot, 'proof-or-stop.config.json'), 'utf8'));
const globalLabProbe = execFileSync(process.execPath, [
  join(repoRoot, 'scripts/verify-global-lab-entrypoint.mjs'),
  'lab-help',
], { cwd: repoRoot, encoding: 'utf8' });
assert.match(globalLabProbe, /global core bin should show lab_create help|ok lab-help/, 'global lab entrypoint resolves through the canonical core wrapper');
const configuredPromptRoles = projectConfig.promptEnvelope?.roles ?? {};
for (const relativePath of [
  '.claude/agents/proof-or-stop-product-reviewer.md',
  '.claude/agents/proof-or-stop-implementation-reviewer.md',
  '.proof-or-stop-codex/agents/proof-or-stop-product-reviewer.md',
  '.proof-or-stop-codex/agents/proof-or-stop-implementation-reviewer.md',
]) {
  assert.equal(existsSync(join(repoRoot, relativePath)), true, `${relativePath} uses the canonical role basename`);
}
assert.deepEqual(
  Object.keys(configuredPromptRoles).sort(),
  [
    'proof-or-stop-implementer',
    'proof-or-stop-review-behavior',
    'proof-or-stop-review-concept',
    'proof-or-stop-review-delivery',
    'proof-or-stop-review-docs',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-scope-plan',
    'proof-or-stop-review-story-init',
    'proof-or-stop-review-test-coverage',
    'proof-or-stop-review-topology-critic',
    'proof-or-stop-evaluator',
  ].sort(),
  'active prompt-envelope roles use the canonical configured role IDs',
);
assert.equal(
  Object.keys(configuredPromptRoles).some(roleId => roleId.startsWith('lattice-')),
  false,
  'retired role IDs cannot appear in active configuration keys',
);
for (const [legacy, canonical] of aliases) {
  assert.equal(identity.canonicalAgentRoleId(legacy), legacy, `${legacy} is not silently rewritten`);
  assert.equal(identity.agentRoleIdsEqual(legacy, canonical), false, `${legacy} cannot satisfy a canonical role`);
}

for (const [retired, canonical] of aliases) {
  assert.throws(() => dispatch.resolveAgentDispatchType(retired), /unknown agentType/);
  assert.equal(identity.isCanonicalAgentRoleId(retired), false);
  assert.equal(identity.canonicalAgentRoleId(canonical), canonical);
}
assert.equal(dispatch.resolveAgentDispatchType('proof-or-stop-verification-intent').canonicalType, 'proof-or-stop-verification-intent');
for (const legacyType of ['proof-or-stop-test-intent', 'proof-or-stop-test-case-reviewer', 'test-intent', 'test-case-reviewer']) {
  assert.throws(
    () => dispatch.resolveAgentDispatchType(legacyType),
    legacyType.startsWith('proof-or-stop-') ? /legacy read-side identity.*proof-or-stop-verification-intent/ : /unknown agentType/,
    `${legacyType} cannot authorize new dispatch`,
  );
}
assert.throws(() => dispatch.resolveAgentDispatchType('lattice-review-unknown'), /unknown agentType/);
assert.throws(() => dispatch.resolveAgentDispatchType('proof-or-stop-review-quality@fallback'), /unknown agentType/);
assert.equal(
  reviewerOptIn.reviewerIdentitiesEqual('proof-or-stop-review-unknown', 'proof-or-stop-review-unknown'),
  false,
  'unregistered reviewer identities cannot satisfy self-matching checks',
);
assert.equal(
  reviewerOptIn.reviewerIdentitiesEqual('proof-or-stop-review-quality', 'lattice-review-quality'),
  false,
  'retired reviewer identity cannot satisfy a canonical lane',
);
assert.equal(
  reviewerOptIn.reviewerIdentitiesEqual('proof-or-stop-review-quality@fallback', 'lattice-review-quality@fallback'),
  false,
  'retired scoped identity cannot satisfy a canonical lane',
);
assert.equal(dispatch.resolveAgentDispatchType('proof-or-stop-review-concept').canonicalType, 'proof-or-stop-review-concept');
assert.equal(dispatch.resolveAgentDispatchType('proof-or-stop-review-test-coverage').canonicalType, 'proof-or-stop-review-test-coverage');
assert.deepEqual(identity.legacyAgentRoleIds('proof-or-stop-implementer'), []);
assert.deepEqual(
  identity.legacyAgentRoleIds('proof-or-stop-review-quality@fallback'),
  [],
  'canonical fallback roles expose no retired alias',
);
assert.deepEqual(
  identity.legacyAgentRoleIds('lattice-review-quality@fallback'),
  [],
  'retired fallback roles expose no registered alias',
);
assert.deepEqual(identity.legacyAgentRoleIds('proof-or-stop-unknown@fallback'), []);
assert.equal(
  identity.agentRoleIdsEqual('lattice-review-quality@fallback', 'proof-or-stop-review-quality@fallback'),
  false,
  'retired fallback roles cannot satisfy canonical roles',
);
assert.equal(schema.DONE_REQUIRED_EVIDENCE_SCHEMA, 'proof-or-stop.done-required-evidence');
assert.equal(schema.isDoneRequiredEvidenceSchema('proof-or-stop.done-required-evidence'), true);
assert.equal(schema.isDoneRequiredEvidenceSchema('lattice.done-required-evidence'), false);
assert.equal(schema.isDoneRequiredEvidenceSchema('lattice.done-required-evidence.v99'), false);
assert.equal(schema.DONE_REQUIRED_COMMAND_SPEC_SCHEMA, 'proof-or-stop.command-spec.v2');
assert.equal(schema.isDoneRequiredCommandSpecV2Schema('proof-or-stop.command-spec.v2'), true);
assert.equal(schema.isDoneRequiredCommandSpecSchema('lattice.command-spec.v2'), false);
assert.equal(schema.isDoneRequiredCommandSpecSchema('lattice.command-spec.v1'), false);
assert.equal(schema.isDoneRequiredCommandSpecSchema('proof-or-stop.command-spec.v99'), false);
assert.equal(schema.DONE_PREPARE_GENERATED_METADATA_SCHEMA, 'proof-or-stop.done-prepare-generated-metadata.v1');
assert.equal(schema.isDonePrepareGeneratedMetadataSchema('proof-or-stop.done-prepare-generated-metadata.v1'), true);
assert.equal(schema.isDonePrepareGeneratedMetadataSchema('lattice.done-prepare-generated-metadata.v1'), false);
assert.equal(schema.isDonePrepareGeneratedMetadataSchema('lattice.done-prepare-generated-metadata.v99'), false);
assert.equal(schema.DONE_PREPARE_VALIDATION_REUSE_SCHEMA, 'proof-or-stop.done-prepare-validation-reuse.v1');
assert.equal(schema.isDonePrepareValidationReuseSchema('proof-or-stop.done-prepare-validation-reuse.v1'), true);
assert.equal(schema.isDonePrepareValidationReuseSchema('lattice.done-prepare-validation-reuse.v1'), false);
assert.equal(schema.isDonePrepareValidationReuseSchema('lattice.done-prepare-validation-reuse.v99'), false);
assert.equal(
  generatedMetadata.DONE_PREPARE_GENERATED_METADATA_SCHEMA,
  schema.DONE_PREPARE_GENERATED_METADATA_SCHEMA,
  'done_prepare generated-metadata writer uses the canonical schema registry literal',
);
assert.equal(
  validationReuse.DONE_PREPARE_VALIDATION_REUSE_SCHEMA,
  schema.DONE_PREPARE_VALIDATION_REUSE_SCHEMA,
  'done_prepare validation-reuse writer uses the canonical schema registry literal',
);
assert.equal(
  identity.canonicalizeAgentRoleText('lattice-review-quality -> lattice-implementer'),
  'lattice-review-quality -> lattice-implementer',
);
assert.deepEqual(
  reviewerList.parseForceReviewers('proof-or-stop-review-quality,quality'),
  ['quality'],
  'canonical and short reviewer names deduplicate before mounting',
);
const forcedQuality = reviewerList.computeActiveReviewers(
  { riskSignals: [] },
  { items: [] },
  null,
  [],
  ['proof-or-stop-review-quality', 'quality'],
);
assert.equal(
  forcedQuality.filter((reviewer) => reviewer.name === 'quality').length,
  1,
  'canonical and short reviewer identities produce one logical roster entry',
);
assert.equal(forcedQuality.some((reviewer) => reviewer.name === 'proof-or-stop-review-quality'), false);
assert.equal(forcedQuality.some((reviewer) => reviewer.name === 'lattice-review-quality'), false);
const qualityReviewer = forcedQuality.find((reviewer) => reviewer.name === 'quality');
assert.ok(qualityReviewer);
assert.equal(qualityReviewer.lane, 'proof-or-stop-review-quality', 'forced short names keep canonical reviewer lanes');
assert.equal(qualityReviewer.forced, true, 'deduplicated logical reviewer remains forced');
const reviewerText = reviewerList.renderActiveReviewersText(
  reviewerList.computeActiveReviewers(
    { riskSignals: [{ category: 'gate' }] },
    { items: [] },
    null,
    ['docs/README.md'],
  ),
);
assert.match(reviewerText, /proof-or-stop-review-concept/);
assert.doesNotMatch(reviewerText, /lattice-|proofbound-/);
assert.throws(() => reviewerList.parseForceReviewers('lattice-review-quality'), /not supported/);
assert.throws(() => reviewerList.parseForceReviewers('proofbound-review-quality'), /not supported/);
assert.match(reviewerText, /proof-or-stop-review-quality/);
assert.match(reviewerText, /proof-or-stop-review-test-coverage/);
assert.match(reviewerText, /proof-or-stop-review-behavior/);
assert.doesNotMatch(reviewerText, /Active reviewers: concept, quality, test-coverage/);

const localAgentsRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-local-agent-migration-'));
try {
  const agentsDir = join(localAgentsRoot, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'lattice-review-quality.md'), 'legacy managed role\n');
  writeFileSync(join(agentsDir, 'proof-or-stop-review-quality.md'), 'canonical managed role\n');
  writeFileSync(join(agentsDir, 'my-personal-agent.md'), 'user-authored role\n');
  const templateDir = join(packageRoot, 'templates', 'agents');
  const scan = managedAssets.scanProjectLocalManagedAgents(localAgentsRoot, templateDir);
  assert.ok(scan.managedFiles.includes('proof-or-stop-review-quality.md'), 'canonical role is managed');
  assert.ok(!scan.managedFiles.includes('lattice-review-quality.md'), 'retired role is not a managed alias');
  assert.deepEqual(scan.userFiles.sort(), ['lattice-review-quality.md', 'my-personal-agent.md'], 'unrecognized files remain outside the managed set');
  const migration = managedAssets.migrateProjectLocalManagedAgents(localAgentsRoot, templateDir);
  assert.deepEqual(migration.removed, ['proof-or-stop-review-quality.md']);
  assert.deepEqual(migration.preserved.sort(), ['lattice-review-quality.md', 'my-personal-agent.md']);
  assert.equal(readFileSync(join(agentsDir, 'lattice-review-quality.md'), 'utf8'), 'legacy managed role\n', 'unrecognized retired file bytes are preserved without active alias admission');
  assert.equal(existsSync(join(agentsDir, 'my-personal-agent.md')), true, 'upgrade preserves the user-authored role');
} finally {
  rmSync(localAgentsRoot, { recursive: true, force: true });
}

const reviewRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-role-'));
const reviewFixtureEnv = {
  PROOF_OR_STOP_SESSION_ID: 'sess-brand-role-review-fixture',
  PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
};
const previousReviewEnv = Object.fromEntries(Object.keys(reviewFixtureEnv).map(key => [key, process.env[key]]));
try {
  // Only these isolated registry consumers use the explicit supported host.
  // They must not inherit the invoking host or its cached session identity.
  Object.assign(process.env, reviewFixtureEnv);
  resetSessionIdForTest();
  assert.equal(getSessionIdentity().sessionId, reviewFixtureEnv.PROOF_OR_STOP_SESSION_ID);
  assert.equal(getSessionIdentity().hostProvider, 'codex');
  mkdirSync(join(reviewRoot, 'packages/main/src'), { recursive: true });
  writeFileSync(join(reviewRoot, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    proofAdmissibility: { mode: 'enforce', enforcedConsumers: ['REVIEW'] },
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
  }));
  writeFileSync(join(reviewRoot, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/tmp/\n.proof-or-stop/runtime/native-review-invocations/\n.native-review-fixture-*.json\n');
  writeFileSync(join(reviewRoot, 'packages/main/src/index.ts'), 'export const migrationSmoke = true;\n');
  execFileSync('git', ['init', '-q'], { cwd: reviewRoot });
  execFileSync('git', ['config', 'user.email', '26995688+Harmonynet@users.noreply.github.com'], { cwd: reviewRoot });
  execFileSync('git', ['config', 'user.name', 'Harmonynet'], { cwd: reviewRoot });
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
  const findingAdd = registry.get('finding_add');
  const quorumSubmit = registry.get('quorum_submit');
  assert.ok(dispatch && reviewRunStart && reviewPassSet && findingAdd && quorumSubmit, 'canonical evidence consumers are registered');
  const reviewRuns = new Map();
  for (const lane of ['proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage']) {
    assert.match(String(dispatch({ storyId, agentType: lane }).prompt), new RegExp(`Review lane: ${lane}`));
    const started = String(reviewRunStart({ storyId, agent: lane }));
    const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
    assert.ok(reviewRunId, `${lane} review_run_start emits a signed run id`);
    reviewRuns.set(lane, reviewRunId);
    withBrokeredNativeReviewInvocation({ root: reviewRoot, store, storyId, agent: lane, reviewRunId, invoke: () => reviewPassSet({
      storyId,
      agent: lane,
      reviewRunId,
      note: `Canonical ${lane} pass`,
      readManifest: { filesReadFully: ['packages/main/src/index.ts'], filesTriagedByName: [], scanEscalationReason: null },
    }) });
  }
  const canonicalFinding = {
    storyId, agent: 'proof-or-stop-review-quality',
    reviewRunId: reviewRuns.get('proof-or-stop-review-quality'),
    desc: 'Canonical reviewer writes a signed finding in the isolated test project',
    severity: 'low', category: 'edge',
    readManifest: { filesReadFully: ['packages/main/src/index.ts'], filesTriagedByName: [], scanEscalationReason: null },
  };
  withBrokeredNativeReviewInvocation({ root: reviewRoot, store, storyId, agent: canonicalFinding.agent, reviewRunId: canonicalFinding.reviewRunId, invoke: () => findingAdd(canonicalFinding) });
  assert.equal(store.readFindings(storyId).findings.at(-1)?.agent, canonicalFinding.agent);
  function snapshotFiles(dir) {
    return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [
      entry.name, entry.isDirectory() ? snapshotFiles(join(dir, entry.name)) : readFileSync(join(dir, entry.name)).toString('base64'),
    ]));
  }
  const storyPath = join(reviewRoot, '.proof-or-stop/story/actives', storyId);
  for (const retiredLane of ['lattice-review-quality', 'proofbound-review-quality']) {
    const before = snapshotFiles(storyPath);
    assert.throws(() => dispatch({ storyId, agentType: retiredLane }), /unknown agentType/);
    assert.throws(() => reviewRunStart({ storyId, agent: retiredLane }), /reviewer|agent|lane/i);
    assert.throws(() => findingAdd({
      ...canonicalFinding, agent: retiredLane,
    }), /reviewer|agent|lane|retired/i);
    assert.throws(() => reviewPassSet({
      storyId, agent: retiredLane, reviewRunId: canonicalFinding.reviewRunId,
      note: 'Retired actor must be rejected', readManifest: canonicalFinding.readManifest,
    }), /reviewer|agent|lane|retired/i);
    assert.deepEqual(snapshotFiles(storyPath), before, 'rejected retired actors preserve every Story file byte');
  }
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
  for (const [key, value] of Object.entries(previousReviewEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSessionIdForTest();
  rmSync(reviewRoot, { recursive: true, force: true });
}
for (const [key, value] of Object.entries(previousReviewEnv)) assert.equal(process.env[key], value, `${key} fixture context was not restored`);

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
  execFileSync('git', ['config', 'user.email', '26995688+Harmonynet@users.noreply.github.com'], { cwd: initRoot });
  execFileSync('git', ['config', 'user.name', 'Harmonynet'], { cwd: initRoot });
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
