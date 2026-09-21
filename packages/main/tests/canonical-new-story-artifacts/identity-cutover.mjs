


import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';



import ts from 'typescript';



import { check } from "./runner.mjs";
import { state, currentDigestPrefix, StoryStore, NOW, promptRegistry, currentReviewRunSalt, reviewRunContracts, retiredIdentityPattern, repoRoot, retiredProtocolPrefix, promptEnvelope, fixtureRoots, artifactReleaseLedgerPath, capabilityReleaseLedgerPath, readArtifactReleaseLedger, readCapabilityReleaseLedger, promptContracts, promptRoleContracts, RETIRED_PROMPT_ENVELOPE_IDENTITY_BOUNDARIES, retiredProtocolStem, retiredReviewRunSalt, COMMAND_POLICIES, processFacts, promptMeasurement, runArtifactReleaseLedgerAfterDoneMergeDetailed, runCapabilityReleaseLedgerAfterDoneMerge } from "./data.mjs";
import { git, runCli, establishCurrentImplementationPrerequisite, initRepo, validBackground } from "./fixture-support.mjs";
import { digestWithIdentityPrefix, reviewRunHashWithSalt, assertReviewPassRejectsEnvelopeMutation, assertReviewPassRejectsRunMutation } from "./identity-inventory.mjs";
import { snapshotRuntimeState, assertRuntimeFixtureUnchanged, snapshotIdentityAuthorityState, assertIdentityAuthorityStateUnchanged, snapshotPublicOperationState, assertRuntimeAuthoritativeStateUnchanged, createPublicOperationClone } from "./public-fixtures.mjs";
import { createIdentityVerifierClone } from "./release.mjs";

export async function runCases() {
await check(['identity-cutover'], 'CHK-007:happy:1 fresh public lifecycle emits and consumes only proof-or-stop identities', () => {
  assert.ok(state.freshFixture, 'fresh public CLI fixture must exist');
  const configPath = join(state.freshFixture.root, 'proof-or-stop.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.promptEnvelope = {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: {
      'proof-or-stop-review-story-init': 'full-envelope',
      'proof-or-stop-review-quality': 'full-envelope',
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  git(state.freshFixture.root, ['add', 'proof-or-stop.config.json']);
  git(state.freshFixture.root, ['commit', '-m', 'enable canonical prompt envelope fixture']);
  const dispatched = runCli(state.freshFixture.root, 'dispatch', {
    storyId: state.freshFixture.storyId,
    agentType: 'proof-or-stop-review-story-init',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(dispatched.status, 0, `${dispatched.stdout}${dispatched.stderr}`);
  const envelopePath = join(state.freshFixture.storyDir, 'prompt-envelopes.json');
  const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')).envelopes.at(-1);
  const { envelopeId: _id, createdAt: _createdAt, ...semantic } = envelope;
  state.identityCutoverFixture = { envelopePath, envelope };
  assert.equal(envelope.envelopeId, digestWithIdentityPrefix(currentDigestPrefix, 'prompt-envelope.semantic.v1', semantic));

  const store = new StoryStore(state.freshFixture.root);
  const story = store.readStory(state.freshFixture.storyId);
  story.phase = 'REVIEW';
  story.currentReviewRound = NOW;
  store.writeStory(state.freshFixture.storyId, story);
  git(state.freshFixture.root, ['commit', '--allow-empty', '-m', 'fixture implementation provenance']);
  establishCurrentImplementationPrerequisite(state.freshFixture.root);
  let run;
  for (const lane of promptRegistry.MODULAR_REVIEWER_ROLE_IDS) {
    const reviewDispatch = runCli(state.freshFixture.root, 'dispatch', {
      storyId: state.freshFixture.storyId,
      agentType: lane,
    }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
    assert.equal(reviewDispatch.status, 0, `${lane}: ${reviewDispatch.stdout}${reviewDispatch.stderr}`);
    const started = runCli(state.freshFixture.root, 'review_run_start', {
      storyId: state.freshFixture.storyId,
      agent: lane,
    }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', PROOF_OR_STOP_AGENT: lane });
    assert.equal(started.status, 0, `${lane}: ${started.stdout}${started.stderr}`);
    run = JSON.parse(readFileSync(join(state.freshFixture.storyDir, 'review-runs.json'), 'utf8')).runs.at(-1);
    assert.equal(run.agent, lane);
    assert.equal(run._hash, reviewRunHashWithSalt(run, currentReviewRunSalt));
    assert.equal(reviewRunContracts.verifyReviewRun(run, store), true);
    assert.equal(reviewRunContracts.verifyReviewRunPromptEnvelope(store, run).ok, true);
  }
  state.identityCutoverFixture = { ...state.identityCutoverFixture, run };
  const activeBytes = `${readFileSync(envelopePath, 'utf8')}\n${JSON.stringify(run)}`;
  assert.doesNotMatch(activeBytes, retiredIdentityPattern);
});

await check(['identity-cutover'], 'CHK-007:edge:0 frozen proofbound history stays byte-identical and is rejected by active readers', () => {
  const envelopePath = join(repoRoot, '.proof-or-stop/story/actives/B-022e/prompt-envelopes.json');
  const reviewRunsPath = join(repoRoot, '.proof-or-stop/story/actives/B-022e/review-runs.json');
  const envelopeBytes = readFileSync(envelopePath);
  const reviewRunBytes = readFileSync(reviewRunsPath);
  const envelopeDigest = createHash('sha256').update(envelopeBytes).digest('hex');
  const runDigest = createHash('sha256').update(reviewRunBytes).digest('hex');
  const historicalEnvelope = JSON.parse(envelopeBytes).envelopes.find((row) => row.schemaVersion?.startsWith(retiredProtocolPrefix));
  const historicalRun = JSON.parse(reviewRunBytes).runs.find((row) => row.assembledPrompt?.includes(retiredProtocolPrefix));
  assert.ok(historicalEnvelope && historicalRun, 'representative historical prompt/review records must remain present');
  assert.equal(promptEnvelope.verifyPromptEnvelopeIntegrity(historicalEnvelope), false);
  assert.equal(reviewRunContracts.verifyReviewRun(historicalRun), false);
  assert.equal(createHash('sha256').update(readFileSync(envelopePath)).digest('hex'), envelopeDigest);
  assert.equal(createHash('sha256').update(readFileSync(reviewRunsPath)).digest('hex'), runDigest);

  const retiredLedgerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-retired-ledger-'));
  fixtureRoots.push(retiredLedgerRoot);
  mkdirSync(join(retiredLedgerRoot, '.proof-or-stop'), { recursive: true });
  writeFileSync(
    artifactReleaseLedgerPath(retiredLedgerRoot),
    `${JSON.stringify({ schemaVersion: `${retiredProtocolPrefix}artifact-release.v1` })}\n`,
  );
  writeFileSync(
    capabilityReleaseLedgerPath(retiredLedgerRoot),
    `${JSON.stringify({ schemaVersion: `${retiredProtocolPrefix}product-capability-release.v1` })}\n`,
  );
  assert.throws(() => readArtifactReleaseLedger(retiredLedgerRoot), /unsupported identity schema.*proof-or-stop\.artifact-release\.v1/i);
  assert.throws(() => readCapabilityReleaseLedger(retiredLedgerRoot), /unsupported identity schema.*proof-or-stop\.product-capability-release\.v1/i);
});

await check(['identity-cutover'], 'CHK-007:edge:1 clean defaults expose no legacy reader verifier config alias or fallback', () => {
  for (const [name, module] of [['prompt-contracts', promptContracts], ['prompt-envelope', promptEnvelope], ['prompt-registry', promptRegistry], ['review-run', reviewRunContracts], ['prompt-role-contracts', promptRoleContracts]]) {
    assert.deepEqual(Object.keys(module).filter((key) => /legacy/i.test(key)), [], `${name} exports legacy acceptance API`);
  }
  const activePromptModePaths = [
    'packages/main/src/core/config.ts',
    'packages/main/src/core/prompt-contracts.ts',
    'packages/main/src/core/prompt-envelope.ts',
    'packages/main/src/core/prompt-registry.ts',
    'packages/main/src/core/prompt-role-contract-registry.ts',
    'packages/main/src/core/review-run.ts',
    'packages/main/src/handlers/agent-prompt.ts',
    'packages/main/src/handlers/review-run.ts',
    'packages/main/src/cli-init.ts',
    'packages/main/src/core/managed-assets.ts',
  ];
  for (const path of activePromptModePaths) {
    const source = readFileSync(join(repoRoot, path), 'utf8');
    if (path !== 'packages/main/src/core/prompt-registry.ts') {
      assert.doesNotMatch(source, /LEGACY_(?:PROMPT|REVIEW)|verifyLegacy|validateLegacy/);
    }
    assert.doesNotMatch(source, /legacy-full-context/, `${path} retains the retired active prompt mode`);
  }
  for (const roleId of promptRegistry.MODULAR_COMPLEX_ROLE_IDS) {
    const entry = promptRegistry.readPromptRegistry().agents.find((candidate) => candidate.agentId === roleId);
    assert.ok(entry, `${roleId} remains registered`);
    const source = promptRegistry.readPromptTemplate(entry);
    assert.equal(promptRegistry.renderPromptEntryForHost(entry, 'claude'), source, `${roleId} defaults to canonical package bytes`);
    assert.equal(promptRoleContracts.resolvePromptEnvelopeRolloutMode(roleId, undefined), 'full-envelope');
    assert.throws(() => promptRoleContracts.resolvePromptEnvelopeRolloutMode(roleId, {
      version: promptRoleContracts.PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: { [roleId]: 'legacy-full-context' },
    }), /unsupported mode/);
  }
});

await check(['identity-cutover'], 'CHK-007:adversarial:0 proofbound injection at every active boundary fails closed with zero mutation', () => {
  assert.ok(state.freshFixture, 'fresh public CLI fixture must exist');
  const configPath = join(state.freshFixture.root, 'proof-or-stop.config.json');
  const canonicalConfigBytes = readFileSync(configPath);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.promptEnvelope = {
    version: `${retiredProtocolPrefix}prompt-envelope-rollout.v1`,
    roles: { 'proof-or-stop-review-story-init': 'full-envelope' },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  git(state.freshFixture.root, ['add', 'proof-or-stop.config.json']);
  git(state.freshFixture.root, ['commit', '-m', 'inject retired prompt config']);
  const fixture = {
    root: state.freshFixture.root,
    storyId: state.freshFixture.storyId,
    storyDir: state.freshFixture.storyDir,
    eventsPath: join(state.freshFixture.storyDir, 'process-events.jsonl'),
    indexPath: join(state.freshFixture.storyDir, 'index.json'),
  };
  const before = snapshotRuntimeState(fixture);
  const result = runCli(state.freshFixture.root, 'dispatch', {
    storyId: state.freshFixture.storyId,
    agentType: 'proof-or-stop-review-story-init',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(result.status, 0, 'retired explicit config must be rejected');
  assert.match(`${result.stdout}${result.stderr}`, /unsupported|promptEnvelope\.version|proof-or-stop/i);
  assertRuntimeFixtureUnchanged(fixture, before);

  writeFileSync(configPath, canonicalConfigBytes);
  git(state.freshFixture.root, ['add', 'proof-or-stop.config.json']);
  git(state.freshFixture.root, ['commit', '-m', 'restore canonical prompt config']);

  const canonicalDispatch = runCli(state.freshFixture.root, 'dispatch', {
    storyId: state.freshFixture.storyId,
    agentType: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(canonicalDispatch.status, 0, `${canonicalDispatch.stdout}${canonicalDispatch.stderr}`);
  const started = runCli(state.freshFixture.root, 'review_run_start', {
    storyId: state.freshFixture.storyId,
    agent: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
  const boundaryRun = JSON.parse(readFileSync(join(state.freshFixture.storyDir, 'review-runs.json'), 'utf8')).runs.at(-1);
  state.identityCutoverFixture = { ...state.identityCutoverFixture, boundaryRun };
  const envelopePath = join(state.freshFixture.storyDir, 'prompt-envelopes.json');
  const canonicalEnvelopeBytes = readFileSync(envelopePath);
  const envelopeBoundaries = [
    ...RETIRED_PROMPT_ENVELOPE_IDENTITY_BOUNDARIES.map((boundary) => [
      boundary.id,
      (envelope) => { envelope[boundary.path] = boundary.retired; },
    ]),
    ['prompt-envelope.digest-prefix', (envelope) => {
      const { envelopeId: _id, createdAt: _createdAt, ...semantic } = envelope;
      envelope.envelopeId = digestWithIdentityPrefix(`${retiredProtocolPrefix}digest.v1`, 'prompt-envelope.semantic.v1', semantic);
    }],
    ['prompt-envelope.role-lane', (envelope) => {
      envelope.roleId = `${retiredProtocolStem}-review-quality`;
      envelope.lane = `${retiredProtocolStem}-review-quality`;
    }],
  ];
  for (const [label, mutate] of envelopeBoundaries) {
    assertReviewPassRejectsEnvelopeMutation({ fixture, boundaryRun, canonicalBytes: canonicalEnvelopeBytes, label, mutate });
  }

  const reviewRunsPath = join(state.freshFixture.storyDir, 'review-runs.json');
  const canonicalRunsBytes = readFileSync(reviewRunsPath);
  const retiredRunBoundaries = [
    ['review-run.signing-salt', (run) => { run._hash = reviewRunHashWithSalt(run, retiredReviewRunSalt); }],
    ['review-run.prompt-digest-prefix', (run) => {
      run.promptHash = digestWithIdentityPrefix(`${retiredProtocolPrefix}digest.v1`, 'assembled-prompt.raw-utf8.v1', new StoryStore(fixture.root).readReviewPrompt(run));
      run._hash = reviewRunHashWithSalt(run, currentReviewRunSalt);
    }],
    ['review-run.agent', (run) => { run.agent = `${retiredProtocolStem}-review-quality`; }],
    ['review-run.lane', (run) => { run.lane = `${retiredProtocolStem}-review-quality`; }],
    ['review-run.workspace-binding', (run) => {
      run.workspaceBinding = { ...(run.workspaceBinding ?? {}), schemaVersion: `${retiredProtocolPrefix}review_run_workspace_binding.v1` };
    }],
    ['review-run.scope-binding', (run) => {
      run.scopeBinding = { ...(run.scopeBinding ?? {}), schemaVersion: `${retiredProtocolPrefix}review_run_scope_binding.v1` };
    }],
    ['review-run.assembled-prompt', (run) => { run.assembledPrompt += `\n${retiredProtocolPrefix}nested.v1`; }],
  ];
  for (const [label, mutate] of retiredRunBoundaries) {
    assertReviewPassRejectsRunMutation({ fixture, boundaryRun, canonicalBytes: canonicalRunsBytes, label, mutate });
  }

  const retiredDispatchBefore = snapshotIdentityAuthorityState(fixture);
  for (const [command, args, env] of [
    ['dispatch', { storyId: state.freshFixture.storyId, agentType: `${retiredProtocolStem}-review-quality` }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' }],
    ['review_run_start', { storyId: state.freshFixture.storyId, agent: `${retiredProtocolStem}-review-quality` }, { PROOF_OR_STOP_AGENT: `${retiredProtocolStem}-review-quality`, PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' }],
  ]) {
    const rejected = runCli(state.freshFixture.root, command, args, env);
    assert.notEqual(rejected.status, 0, `${command} must reject the retired reviewer identity`);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /unknown|retired|not permitted|invalid/i, command);
    assertIdentityAuthorityStateUnchanged(fixture, retiredDispatchBefore);
  }

  const initRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-retired-init-writer-'));
  fixtureRoots.push(initRoot);
  initRepo(initRoot, false);
  const initCreated = runCli(initRoot, 'story_create', {
    name: 'retired-init-writer-boundary',
    title: 'Retired INIT writer boundary',
    description: 'Exercise exact INIT reviewer identity admission through the public writer.',
    type: 'chore', priority: 'high', background: validBackground(), forceNew: true,
    checklist: [{ title: 'Reject retired INIT writer', context: 'Only canonical INIT reviewer identities may persist.' }],
    scopeBoundary: {
      mode: 'custom', allowed: ['retired INIT identity rejection'], excluded: ['historical rewrite'],
      userConfirmed: true, actor: 'human', confirmation: 'Bounded Round 18 public-operation fixture.',
    },
    executionBoundary: {
      allowedCommands: ['node packages/main/tests/canonical-new-story-artifacts.test.mjs'],
      allowedTools: ['shell'], allowedPaths: ['packages/main/tests/canonical-new-story-artifacts.test.mjs'],
      excludedCommands: ['git push'], blockedPaths: ['.proof-or-stop/story'],
    },
  });
  assert.equal(initCreated.status, 0, `${initCreated.stdout}${initCreated.stderr}`);
  const initStoryId = initCreated.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
  assert.ok(initStoryId, initCreated.stdout);
  const initStoryDir = join(initRoot, '.proof-or-stop', 'story', 'actives', initStoryId);
  const initFixture = {
    root: initRoot,
    storyId: initStoryId,
    storyDir: initStoryDir,
    eventsPath: join(initStoryDir, 'process-events.jsonl'),
    indexPath: join(initStoryDir, 'index.json'),
  };
  const initBefore = snapshotIdentityAuthorityState(initFixture);
  const retiredInit = runCli(initRoot, 'init_check_set', {
    storyId: initStoryId,
    issues: [],
    agentId: `${retiredProtocolStem}-review-story-init`,
  }, { PROOF_OR_STOP_AGENT: `${retiredProtocolStem}-review-story-init` });
  assert.notEqual(retiredInit.status, 0, `${retiredInit.stdout}${retiredInit.stderr}`);
  assert.match(`${retiredInit.stdout}${retiredInit.stderr}`, /unknown|retired|not permitted|invalid/i);
  assertIdentityAuthorityStateUnchanged(initFixture, initBefore);

  const releaseRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-retired-release-writers-'));
  fixtureRoots.push(releaseRoot);
  initRepo(releaseRoot, false);
  mkdirSync(join(releaseRoot, 'docs'), { recursive: true });
  writeFileSync(join(releaseRoot, 'docs', 'identity-boundary.md'), 'retired release identity boundary\n');
  git(releaseRoot, ['add', 'docs/identity-boundary.md']);
  git(releaseRoot, ['commit', '-m', 'seed release identity boundary']);
  mkdirSync(join(releaseRoot, '.proof-or-stop'), { recursive: true });
  const retiredReleaseCases = [
    {
      label: 'artifact release',
      path: artifactReleaseLedgerPath(releaseRoot),
      row: { schemaVersion: `${retiredProtocolPrefix}artifact-release.v1` },
      command: 'artifact_release_list',
    },
    {
      label: 'capability release',
      path: capabilityReleaseLedgerPath(releaseRoot),
      row: { schemaVersion: `${retiredProtocolPrefix}product-capability-release.v1` },
      command: 'capability_release_list',
    },
  ];
  for (const releaseCase of retiredReleaseCases) {
    writeFileSync(releaseCase.path, `${JSON.stringify(releaseCase.row)}\n`);
    const beforeRead = snapshotPublicOperationState(releaseRoot);
    const rejected = runCli(releaseRoot, releaseCase.command, { format: 'json' });
    assert.notEqual(rejected.status, 0, `${releaseCase.label} public reader accepted retired identity`);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /unsupported identity schema/i, `${releaseCase.label} public reader`);
    assert.deepEqual(
      snapshotPublicOperationState(releaseRoot),
      beforeRead,
      `${releaseCase.label} public reader changed repository, lock, ledger, or generated-output state`,
    );
  }

  const measurementPolicy = COMMAND_POLICIES.prompt_measurement_report;
  const measurementFact = processFacts.PROCESS_FACT_REGISTRY_BY_NAME.prompt_measurement_report;
  assert.equal(measurementPolicy.ownershipClass, 'readOnly');
  assert.deepEqual(
    { level: measurementFact.level, gateEvidence: measurementFact.gateEvidence, destructiveRisk: measurementFact.destructiveRisk },
    { level: 'L0', gateEvidence: false, destructiveRisk: 'none' },
  );
  const measurementBefore = snapshotRuntimeState(fixture);
  const measured = runCli(state.freshFixture.root, 'prompt_measurement_report', { json: true });
  assert.equal(measured.status, 0, `${measured.stdout}${measured.stderr}`);
  assertRuntimeAuthoritativeStateUnchanged(fixture, measurementBefore);
  const measurementRoot = createPublicOperationClone('proof-or-stop-b49df-measurement-public-');
  const measurementConfigPath = join(measurementRoot, 'proof-or-stop.config.json');
  const measurementConfig = JSON.parse(readFileSync(measurementConfigPath, 'utf8'));
  measurementConfig.storyDir = '.proof-or-stop-test/story/actives';
  writeFileSync(measurementConfigPath, `${JSON.stringify(measurementConfig, null, 2)}\n`);
  const measurementBaselinePath = join(measurementRoot, promptMeasurement.PROMPT_MEASUREMENT_BASELINE_PATH);
  const canonicalMeasurementBytes = readFileSync(measurementBaselinePath);
  const checkedInMeasurement = JSON.parse(canonicalMeasurementBytes.toString('utf8'));
  for (const [label, mutate] of [
    ['prompt-measurement report schema', (report) => { report.schemaVersion = `${retiredProtocolPrefix}prompt-measurement-report.v1`; }],
    ['prompt-measurement record schema', (report) => { report.records[0].schemaVersion = `${retiredProtocolPrefix}prompt-measurement.v1`; }],
    ['prompt role-contract registry version', (report) => { report.roleContractRegistryVersion = `${retiredProtocolPrefix}prompt-role-contract-registry.v1`; }],
  ]) {
    const mutant = structuredClone(checkedInMeasurement);
    mutate(mutant);
    writeFileSync(measurementBaselinePath, `${JSON.stringify(mutant, null, 2)}\n`);
    const beforeVerify = snapshotPublicOperationState(measurementRoot, ['B-49df']);
    const rejected = spawnSync('npm', ['run', 'test:proof-or-stop-prompt-baseline'], {
      cwd: measurementRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'sess-b49df-measurement-public' },
    });
    assert.notEqual(rejected.status, 0, `${label}: public prompt-baseline verifier accepted retired identity`);
    assert.match(
      `${rejected.stdout}${rejected.stderr}`,
      /(?:role-prompt measurement sidecar validation failed:.*(?:unsupported|does not match|schema)|retired active protocol identity at docs\/requirements\/baselines\/role-prompt-measurement-baseline\.json.*not admitted)/is,
      `${label}: public prompt-baseline verifier did not report the identity failure: ${rejected.error?.message ?? ''}\n${rejected.stdout}${rejected.stderr}`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(measurementRoot, ['B-49df']),
      beforeVerify,
      `${label}: public prompt-baseline verifier changed Story, Git, lock, or generated-output state`,
    );
    writeFileSync(measurementBaselinePath, canonicalMeasurementBytes);
  }

  const registryRoot = createPublicOperationClone('proof-or-stop-b49df-prompt-registry-public-');
  const registryConsumerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-prompt-registry-consumer-'));
  fixtureRoots.push(registryConsumerRoot);
  initRepo(registryConsumerRoot, false);
  const registryDistPath = join(registryRoot, 'packages', 'main', 'dist', 'core', 'prompt-registry.js');
  const canonicalRegistryBytes = readFileSync(registryDistPath);
  const canonicalRegistrySource = canonicalRegistryBytes.toString('utf8');
  const registrySnapshotBlock = [
    '        schemaVersion: PROMPT_REGISTRY_VERSION,',
    '        source: PROMPT_REGISTRY_SOURCE,',
    '        root: templateDir,',
  ].join('\n');
  assert.equal(canonicalRegistrySource.split(registrySnapshotBlock).length - 1, 1, 'prompt registry snapshot producer block drifted');
  for (const [label, injectedBlock] of [
    ['schema', [
      `        schemaVersion: '${retiredProtocolPrefix}prompt-registry.v1',`,
      '        source: PROMPT_REGISTRY_SOURCE,',
      '        root: templateDir,',
    ].join('\n')],
    ['source', [
      '        schemaVersion: PROMPT_REGISTRY_VERSION,',
      `        source: '@${retiredProtocolStem}/core/templates/agents',`,
      '        root: templateDir,',
    ].join('\n')],
  ]) {
    writeFileSync(registryDistPath, canonicalRegistrySource.replace(registrySnapshotBlock, injectedBlock));
    const beforeRuntime = snapshotPublicOperationState(registryRoot, ['B-49df']);
    const beforePrompt = snapshotPublicOperationState(registryConsumerRoot);
    const rejected = runCli(
      registryConsumerRoot,
      'agent_prompt',
      { role: 'proof-or-stop-review-quality' },
      { PROOF_OR_STOP_ACTIVITY_SOURCE: 'test' },
      { entrypoint: join(registryRoot, 'packages', 'main', 'dist', 'cli.js') },
    );
    assert.notEqual(rejected.status, 0, `public agent_prompt accepted retired prompt-registry ${label}`);
    assert.match(
      `${rejected.stdout}${rejected.stderr}`,
      /prompt registry.*unsupported|unsupported.*prompt registry|retired active protocol identity at packages\/main\/src\/core\/prompt-registry\.ts.*not admitted/i,
      `public agent_prompt did not report retired prompt-registry ${label}`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(registryConsumerRoot),
      beforePrompt,
      `retired prompt-registry ${label} changed consumer Story, Git, lock, or generated-output state`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(registryRoot, ['B-49df']),
      beforeRuntime,
      `retired prompt-registry ${label} changed injected runtime state`,
    );
    writeFileSync(registryDistPath, canonicalRegistryBytes);
  }

  for (const releaseWriter of [
    {
      label: 'artifact release writer',
      ledgerPath: artifactReleaseLedgerPath,
      retiredSchema: `${retiredProtocolPrefix}artifact-release.v1`,
      write: (root, mainCommit, runGit) => runArtifactReleaseLedgerAfterDoneMergeDetailed(
        root, 'B-retired-artifact', mainCommit, mainCommit,
        { changedPaths: ['docs/requirements/decisions/proof-or-stop-identity-cutover.md'], runGit },
      ),
    },
    {
      label: 'capability release writer',
      ledgerPath: capabilityReleaseLedgerPath,
      retiredSchema: `${retiredProtocolPrefix}product-capability-release.v1`,
      write: (root, mainCommit, runGit) => runCapabilityReleaseLedgerAfterDoneMerge(
        root, 'B-retired-capability', mainCommit, mainCommit,
        { changedPaths: ['docs/requirements/decisions/proof-or-stop-identity-cutover.md'], runGit },
      ),
    },
  ]) {
    const verifier = createIdentityVerifierClone(`proof-or-stop-b49df-${releaseWriter.label.replaceAll(' ', '-')}-`);
    const verifierMainCommit = git(verifier.root, ['rev-parse', 'HEAD']);
    const ledgerPath = releaseWriter.ledgerPath(verifier.root);
    const canonicalLedgerBytes = existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.from('');
    writeFileSync(ledgerPath, `${canonicalLedgerBytes.toString('utf8')}${JSON.stringify({ schemaVersion: releaseWriter.retiredSchema })}\n`);
    const injectedVerifier = spawnSync(process.execPath, [verifier.verifierPath], { cwd: verifier.root, encoding: 'utf8' });
    assert.notEqual(injectedVerifier.status, 0, `${releaseWriter.label}: injected retired boundary left the verifier green`);
    assert.match(
      `${injectedVerifier.stdout}${injectedVerifier.stderr}`,
      /retired|proofbound|unsupported|unexpected|pinned|provenance|allowlist/i,
      `${releaseWriter.label}: verifier did not identify the injected retired boundary: ${injectedVerifier.stdout}${injectedVerifier.stderr}`,
    );
    const beforeWrite = snapshotPublicOperationState(verifier.root, ['B-49df']);
    const gitCalls = [];
    let writerFailure = null;
    try {
      releaseWriter.write(verifier.root, verifierMainCommit, (args) => { gitCalls.push(args); return ''; });
    } catch (error) {
      writerFailure = error;
    }
    assert.ok(writerFailure, `${releaseWriter.label}: public writer accepted the injected retired identity`);
    assert.match(
      String(writerFailure?.message ?? writerFailure),
      /identity verification failed before commit/is,
      `${releaseWriter.label}: public writer returned the wrong failure: ${String(writerFailure?.message ?? writerFailure)}`,
    );
    assert.match(
      String(writerFailure?.message ?? writerFailure),
      /retired|proofbound|unsupported|unexpected|allowlist|schema/is,
      `${releaseWriter.label}: public writer did not expose the retired-identity diagnostic: ${String(writerFailure?.message ?? writerFailure)}`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(verifier.root, ['B-49df']),
      beforeWrite,
      `${releaseWriter.label} changed Story, Git, lock, ledger, or generated-output state`,
    );
    assert.deepEqual(gitCalls, [], `${releaseWriter.label} reached Git`);
  }

});
}
