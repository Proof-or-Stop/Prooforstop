#!/usr/bin/env node
import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from './native-review-fixture.js';
import { readConvergenceProgress, recordConvergenceProgress } from '../core/convergence-progress-journal.js';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { currentImplementationBusinessCommit, deriveRoleProvenance } from '../core/topology-critic-receipt.js';
import { resetConfigCache } from '../core/config.js';
import { digestCandidateRoutingValue, verifyCandidateSpecSet, type CandidateSpecSetArtifact } from '../core/candidate-spec-routing.js';
import {
  consumeReviewInventoryReceipt,
  finalizedUnconsumedReviewInventory,
  signReviewInventoryEpoch,
  signReviewInventoryReceipt,
} from '../core/review-inventory-epoch.js';
import { promptRoleContract, promptRoleContractForSemanticDigest } from '../core/prompt-role-contract-registry.js';
import { computePromptEnvelopeId, verifyPromptEnvelopeIntegrity } from '../core/prompt-envelope.js';
import { domainSeparatedDigest } from '../core/prompt-contracts.js';
import { verifyHistoricalReviewerDispatchBinding, verifyReviewRunPromptEnvelope } from '../core/review-run.js';
import { signFinding } from '../core/finding-verify.js';
import type { Finding, ProofStoryContractData, StoryInfo } from '../core/types.js';
import { createReviewInventoryHandlers } from '../handlers/review-inventory.js';
import { createReviewRunHandlers } from '../handlers/review-run.js';
import { verifyCurrentReviewerDispatchBinding } from '../core/review-run.js';
import { reviewInventoryPurposeBinding } from '../core/review-inventory-epoch.js';
import {
  reviewIncrementalContext,
  computeCanonicalDependencyClosure,
  postRemediationReviewSelection,
  verifyCurrentPostRemediationReviewSelection,
  verifyPostRemediationReviewSelection,
} from '../core/review-incremental-context.js';
import { computeFinalReviewRoster, renderFinalReviewRoster, type ActiveReviewer } from '../handlers/reviewer-list.js';

const storyId = 'B-inventory-handler';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../../../../bin/proof-or-stop.js', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cli(root: string, command: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PROOF_OR_STOP_AGENT: 'main',
      PROOF_OR_STOP_SESSION_ID: 'inventory-handler-fixture-owner',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      ...env,
    },
  }).trim();
}

function cliAsync(root: string, command: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => execFile(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROOF_OR_STOP_AGENT: 'main',
      PROOF_OR_STOP_SESSION_ID: 'inventory-handler-fixture-owner',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      ...env,
    },
  }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` })));
}

function waitForFile(path: string, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function setup(author = { name: 'lattice-implementer', email: 'lattice-implementer@noreply.local' }, fullEnvelope = false) {
  const root = mkdtempSync(join(tmpdir(), 'review-inventory-handler-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  mkdirSync(join(root, 'packages/main/tests'), { recursive: true });
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    ...(fullEnvelope ? { promptEnvelope: { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proof-or-stop-review-topology-critic': 'full-envelope' } } } : {}),
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  writeFileSync(join(root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
  writeFileSync(join(root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js';\n");
  writeFileSync(join(root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js';\n");
  writeFileSync(join(root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 1;\n');
  writeFileSync(join(root, 'docs/requirements/decisions/inventory.md'), '# Review inventory\n');
  writeFileSync(join(root, 'docs/requirements/decisions/inventory-secondary.md'), '# Review inventory supplementary\n');
  for (const name of ['almanac', 'beacon', 'compass', 'dossier', 'ledger', 'notebook']) {
    writeFileSync(join(root, `docs/requirements/decisions/${name}.md`), `# ${name}\nUnrelated fixture material.\n`);
  }
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['config', 'user.name', author.name]);
  git(root, ['config', 'user.email', author.email]);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  resetConfigCache();
  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId, name: 'inventory-handler-smoke', title: 'Inventory handler smoke',
    description: 'Exercise real review inventory handler persistence and fail-closed paths.',
    type: 'chore', phase: 'REVIEW', priority: 'high', createdAt: reviewRound,
    startedAt: reviewRound, endedAt: null, currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  store.writeStory(storyId, story);
  // Main added a DEV-door preflight ack (B-a7c5). Write it here so later
  // story_advance DEV assertions observe inventory/cutoff behavior, not
  // missing_dev_memory_preflight_ack.
  store.writeDevMemoryPreflightAck(storyId, {
    schemaVersion: 'lattice.dev_memory_preflight_ack.v1',
    storyId,
    packDigest: 'review-inventory-handler-smoke-synthetic-digest',
    topHitIds: [],
    acknowledgedAt: reviewRound,
    acknowledgedBy: 'review-inventory-handler-smoke',
  });
  store.writeChecklist(storyId, { items: [
    { id: 'CHK-001', title: 'Synthetic handler coverage', context: 'real handler smoke', status: 'done', files: [
      'packages/main/src/subject.ts',
      'packages/main/src/consumer-a.ts',
      'packages/main/src/consumer-b.ts',
      'packages/main/src/opaque.ts',
      'packages/main/tests/isolated.test.ts',
    ] },
  ] } as never);
  return { root, store, handlers: createReviewInventoryHandlers({ root, scanRoot: join(root, 'packages/main'), store }) };
}

function rewriteCandidateArtifact(
  artifact: CandidateSpecSetArtifact,
  changes: Partial<Omit<CandidateSpecSetArtifact, 'artifactDigest'>>,
): CandidateSpecSetArtifact {
  const { artifactDigest: _artifactDigest, ...base } = artifact;
  const next = { ...base, ...changes };
  return { ...next, artifactDigest: digestCandidateRoutingValue(next) };
}

function seedProofStoryAcceptance(store: StoryStore): void {
  const now = new Date().toISOString();
  const contract: ProofStoryContractData = {
    schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: false,
    hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: [
      { id: 'AB-001', checklistRefs: ['CHK-001'], verificationIntentRefs: [], milestoneIds: [] },
      { id: 'AB-002', checklistRefs: ['CHK-001'], verificationIntentRefs: [], milestoneIds: [] },
    ],
    diagnosticGaps: [], createdAt: now, updatedAt: now,
  };
  store.writeProofStoryContract(storyId, contract);
}

// B-29bc: the same production CLI fixture supplies complete signed required
// lanes before critic admission. Host names below describe disposable fixtures,
// not independent-host assurance. Existing topology assertions remain below.
async function inventoryPurposeRecovery(): Promise<void> {
  const actor = 'proof-or-stop-review-topology-critic';
  const env = (agent: string, session: string): NodeJS.ProcessEnv => ({
    PROOF_OR_STOP_AGENT: agent, PROOF_OR_STOP_SESSION_ID: session,
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'synthetic-b29bc-purpose',
  });
  const topology = setup();
  const fixture = setup({ name: 'Harmonynet', email: '26995688+Harmonynet@users.noreply.github.com' });
  try {
    assert.match(cli(topology.root, 'dispatch', { storyId, agentType: actor }, env(actor, 'b29bc-topology-control')), /topology/);
    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor }, env(actor, 'b29bc-default-refusal')), /implementation|author|provenance/i);
    cli(fixture.root, 'review_inventory_begin', { storyId }, env('main', 'b29bc-owner'));
    const epoch = fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
    assert.equal(epoch.state, 'OPEN');
    const readManifest = { filesReadFully: ['packages/main/src/subject.ts'], filesTriagedByName: [], scanEscalationReason: null };
    const readEvents = [{ path: 'packages/main/src/subject.ts', mode: 'full', action: 'Read', tokenCount: null }];
    for (const lane of epoch.requiredLanes) {
      const laneEnv = env(lane, `b29bc-required-${lane}`);
      cli(fixture.root, 'dispatch', { storyId, agentType: lane }, laneEnv);
      const started = cli(fixture.root, 'review_run_start', { storyId, agent: lane }, laneEnv);
      const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
      assert.ok(reviewRunId, started);
      const beforeIncompletePass = JSON.stringify(fixture.store.readReviewPasses(storyId));
      assert.throws(() => cli(fixture.root, 'review_pass_set', { storyId, agent: lane, reviewRunId,
        note: 'Disposable lane has a manifest but no mechanical read log.', readManifest }, laneEnv),
      /OPEN review inventory requires signed readManifest plus mechanical readEvents\/readLog/,
      'F-001 public pass producer must reject missing mechanical read evidence');
      assert.equal(JSON.stringify(fixture.store.readReviewPasses(storyId)), beforeIncompletePass,
        'refused incomplete pass must not persist a terminal');
      assert.throws(() => cli(fixture.root, 'finding_add', { storyId, agent: lane, reviewRunId,
        desc: 'No blocking issues found.', severity: 'low', category: 'missing', readManifest }, laneEnv),
      /OPEN review inventory requires signed readManifest plus mechanical readEvents\/readLog/,
      'F-001 pass-only finding normalization must enforce the same producer boundary');
      assert.equal(JSON.stringify(fixture.store.readReviewPasses(storyId)), beforeIncompletePass);
      await runBrokeredNativeReviewCli({ root: fixture.root, store: fixture.store, storyId, agent: lane, reviewRunId: reviewRunId, command: 'review_pass_set', payload: { storyId, agent: lane, reviewRunId, note: 'Disposable required lane inspected the frozen inventory subject.', readManifest, readEvents } });
    }
    const status = cli(fixture.root, 'review_inventory_status', { storyId }, env('main', 'b29bc-owner'));
    assert.doesNotMatch(status, /REVIEW_INVENTORY_LANES_INCOMPLETE/);
    assert.match(status, /REVIEW_INVENTORY_CRITIC_INCOMPLETE/);
    console.log('B29BC_INVENTORY_SETUP PASS: signed required lanes terminated; default topology controls preserved');
    const purpose = { reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId };
    const criticEnv = env(actor, 'b29bc-independent-critic');
    const beforeSchema = JSON.stringify(fixture.store.readReviewRuns(storyId));
    for (const invalid of [
      { reviewPurpose: 'invented', inventoryEpochId: epoch.epochId },
      { reviewPurpose: 'inventory-completeness' },
      { inventoryEpochId: epoch.epochId },
      { reviewPurpose: 'topology', inventoryEpochId: epoch.epochId },
      { reviewPurpose: null, inventoryEpochId: epoch.epochId },
      { ...purpose, inventoryEpochId: `${epoch.epochId}-wrong` },
    ]) {
      assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...invalid }, criticEnv), /purpose|epoch|invalid|expected/i);
      assert.throws(() => cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...invalid }, criticEnv), /purpose|epoch|invalid|expected/i);
    }
    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: 'proof-or-stop-review-quality', ...purpose }, env('proof-or-stop-review-quality', 'wrong-role')), /purpose|critic/i);
    assert.throws(() => cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...purpose }, env(actor, 'missing-dispatch')), /dispatch/i);
    assert.equal(JSON.stringify(fixture.store.readReviewRuns(storyId)), beforeSchema, 'invalid purpose/schema and missing dispatch cannot publish a run');
    let dispatch = '';
    assert.doesNotThrow(() => { dispatch = cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...purpose }, criticEnv); }, 'B-29bc explicit inventory dispatch must admit real non-role Git attribution');
    assert.match(dispatch, /inventory-completeness/);
    assert.match(dispatch, new RegExp(epoch.epochId));
    const signedEpochData = fixture.store.readReviewInventoryEpochs(storyId);
    fixture.store.writeReviewInventoryEpochs(storyId, { ...signedEpochData, epochs: signedEpochData.epochs.map(row => ({ ...row, _hash: 'forged' })) });
    for (const command of ['dispatch', 'review_run_start']) {
      assert.throws(() => cli(fixture.root, command, { storyId, ...(command === 'dispatch' ? { agentType: actor } : { agent: actor }), ...purpose }, criticEnv), /signature/i);
    }
    assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length, 0, 'forged epoch cannot issue critic authority');
    fixture.store.writeReviewInventoryEpochs(storyId, signedEpochData);
    // Exercise the unchanged topology provenance consumer with a real default
    // dispatch positive control, then the actual inventory dispatch carrier.
    // This is provenance admission, not issuance of a complete topology receipt.
    const topologyEvent = topology.store.readProcessEvents(storyId).filter(row => row.type === 'dispatch').at(-1)!;
    const context = { storyId, basisStatus: 'complete' as const, basisDigest: 'fixture-basis', topologyDigest: 'fixture-topology', scopeCheckDigest: 'fixture-scope',
      storyFilesHash: String(topologyEvent.storyFilesHash), closureFilesHash: 'fixture-closure', exclusions: [], findingRefs: [] };
    const implementation = { agentId: 'proof-or-stop-implementer' as const, sessionId: 'fixture-implementation', dispatchId: 'fixture-implementation-dispatch', storyId,
      headHash: String(topologyEvent.headHash), storyFilesHash: context.storyFilesHash, businessIdentity: 'fixture-implementation',
      ...currentImplementationBusinessCommit(topology.root), businessCommitAuthorSource: 'git-log:commit-author' as const };
    const provenanceArgs = { gitCwd: topology.root, expectedRole: actor as 'proof-or-stop-review-topology-critic', actor, sessionId: String(topologyEvent.sessionId), sessionSource: 'host-adapter' as const, context, implementation };
    assert.equal(deriveRoleProvenance({ ...provenanceArgs, events: [topologyEvent] }).businessCommit, implementation.businessCommit);
    const inventoryEvent = fixture.store.readProcessEvents(storyId).filter(row => row.type === 'dispatch').at(-1)!;
    assert.equal(inventoryEvent.targetKind, 'inventory-critic-review');
    assert.equal(inventoryEvent.businessCommit, undefined);
    const dispatchInput = { storyId, lane: actor, reviewRound, projectRoot: fixture.root,
      reviewPurpose: 'inventory-completeness' as const, inventoryBinding: reviewInventoryPurposeBinding(epoch) };
    assert.equal(verifyCurrentReviewerDispatchBinding({ ...dispatchInput, store: fixture.store }).ok, true);
    for (const mutation of [
      { reviewPurpose: undefined }, { inventoryBinding: undefined }, { dispatchBindingDigest: 'tampered' },
      { dispatchPromptDigest: 'tampered' }, { hostRenderIdentityDigest: 'tampered' },
      { inventoryBinding: { ...dispatchInput.inventoryBinding, storyId: 'B-other' } },
      { inventoryBinding: { ...dispatchInput.inventoryBinding, wave: 99 } },
      { inventoryBinding: { ...dispatchInput.inventoryBinding, cutoff: { ...epoch.cutoff, headHash: 'tampered' } } },
    ]) {
      const readOnlyMutationStore = { readProcessEvents: () => [{ ...inventoryEvent, ...mutation }] } as unknown as StoryStore;
      assert.equal(verifyCurrentReviewerDispatchBinding({ ...dispatchInput, store: readOnlyMutationStore }).ok, false,
        `actual dispatch carrier mutation refused: ${JSON.stringify(mutation)}`);
    }
    for (const variant of [inventoryEvent, { ...inventoryEvent, reviewPurpose: undefined, inventoryBinding: undefined },
      { ...inventoryEvent, reviewPurpose: 'topology', agentType: 'lattice-review-topology-critic' }]) {
      assert.throws(() => deriveRoleProvenance({ ...provenanceArgs, sessionId: String(variant.sessionId), events: [variant] }), /no current registered dispatch provenance/);
    }
    console.log('B29BC_CROSS_PURPOSE_TOPOLOGY_REFUSED PASS');
    const started = cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...purpose }, criticEnv);
    const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
    assert.ok(reviewRunId, started);
    const run = fixture.store.readReviewRuns(storyId).runs.find(row => row.reviewRunId === reviewRunId)!;
    assert.equal((run as unknown as { reviewPurpose: string }).reviewPurpose, 'inventory-completeness');
    const listed = JSON.parse(cli(fixture.root, 'review_run_list', { storyId, json: true }, criticEnv));
    assert.equal(listed.runs.find((row: { reviewRunId: string }) => row.reviewRunId === reviewRunId)?.signatureValid, true);
    const runReader = createReviewRunHandlers({ root: fixture.root, scanRoot: join(fixture.root, 'packages/main'), store: fixture.store });
    const canonicalList = JSON.parse(runReader.review_run_list({ storyId, lane: actor, latest: true, json: true }));
    const aliasList = JSON.parse(cli(fixture.root, 'review_run_list', { storyId, lane: 'lattice-review-topology-critic', latest: true, json: true }, criticEnv));
    assert.deepEqual(aliasList.runs, canonicalList.runs, 'registered alias and canonical reader select the same signed latest run');
    assert.equal(aliasList.runs.length, 1);
    assert.throws(() => cli(fixture.root, 'review_run_list', { storyId, lane: 'unknown-lane', json: true }, criticEnv), /invalid|expected/i);
    const beforeTerminal = JSON.stringify(fixture.store.readReviewInventoryEpochs(storyId));
    assert.throws(() => cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: epoch.epochId, reviewRunId, agent: actor, findingDispositions: [] }, criticEnv), /terminal|read|evidence/i);
    assert.equal(JSON.stringify(fixture.store.readReviewInventoryEpochs(storyId)), beforeTerminal, 'missing terminal evidence cannot publish a critic receipt');
    await runBrokeredNativeReviewCli({ root: fixture.root, store: fixture.store, storyId, agent: actor, reviewRunId: reviewRunId, command: 'review_pass_set', payload: { storyId, agent: actor, reviewRunId, note: 'Independent disposable critic inspected every required lane and the empty exact finding set.', readManifest, readEvents } });
    assert.match(cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: epoch.epochId, reviewRunId, agent: actor, findingDispositions: [] }, criticEnv), /Completeness critic: complete/);
    assert.equal(git(fixture.root, ['log', '--format=%an <%ae>', '--', 'packages/main/src/subject.ts']), 'Harmonynet <26995688+Harmonynet@users.noreply.github.com>');
    console.log('B29BC_INVENTORY_PURPOSE PASS');
    const alias = 'lattice-review-topology-critic';
    const aliasEnv = env(alias, 'b29bc-alias-critic');
    assert.match(cli(fixture.root, 'dispatch', { storyId, agentType: alias, ...purpose }, aliasEnv), /inventory-completeness/);
    assert.match(cli(fixture.root, 'review_run_start', { storyId, agent: alias, ...purpose }, aliasEnv), /Review run/);
    // A second ordinary identity is read from Git rather than matched by name.
    git(fixture.root, ['config', 'user.name', 'Ordinary Contributor']);
    git(fixture.root, ['config', 'user.email', 'ordinary@example.test']);
    assert.match(cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...purpose }, env(actor, 'b29bc-second-identity')), /inventory-completeness/);
    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor, reviewPurpose: 'topology' }, criticEnv), /implementation|author|provenance/i);
    console.log('B29BC_PURPOSE_SCHEMA_ALIAS_DEFAULT PASS');
    const ready = join(fixture.root, 'inventory-purpose-publication-ready');
    const raceEnv = { ...env(actor, 'b29bc-second-identity'), NODE_ENV: 'test', LATTICE_INTERNAL_REVIEW_RUN_HOLD_MS: '1000', LATTICE_INTERNAL_REVIEW_RUN_READY_FILE: ready };
    const publication = cliAsync(fixture.root, 'review_run_start', { storyId, agent: actor, ...purpose }, raceEnv);
    waitForFile(ready);
    const cancellation = cliAsync(fixture.root, 'review_inventory_cancel', { storyId, reason: 'Disposable locked inventory-purpose publication interleaving.' }, env('main', 'b29bc-owner'));
    assert.equal((await publication).ok, true, 'run commits against the still OPEN epoch while holding the inventory lock');
    assert.equal((await cancellation).ok, true, 'cancellation serializes after publication');
    unlinkSync(ready); // Disposable synchronization marker is not source material.
    assert.equal(fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1)?.state, 'CANCELLED');
    const afterCancel = JSON.stringify(fixture.store.readReviewInventoryEpochs(storyId));
    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...purpose }, criticEnv), /OPEN|epoch|cancel/i);
    assert.throws(() => cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...purpose }, criticEnv), /OPEN|epoch|cancel/i);
    assert.throws(() => cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: epoch.epochId, reviewRunId, agent: actor, findingDispositions: [] }, criticEnv), /OPEN|epoch|sealed/i);
    assert.equal(JSON.stringify(fixture.store.readReviewInventoryEpochs(storyId)), afterCancel, 'cancelled replay cannot issue authority');
    cli(fixture.root, 'review_inventory_begin', { storyId }, env('main', 'b29bc-owner'));
    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...purpose }, criticEnv), /OPEN|epoch|current/i);
    cli(fixture.root, 'review_inventory_cancel', { storyId, reason: 'Finish disposable legacy-mode phase before full-envelope control.' }, env('main', 'b29bc-owner'));
    const configPath = join(fixture.root, 'proof-or-stop.config.json');
    const config = { nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() }, scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', promptEnvelope: {} as Record<string, unknown> };
    config.promptEnvelope = { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { [actor]: 'full-envelope' } };
    writeFileSync(configPath, JSON.stringify(config));
    resetConfigCache();
    git(fixture.root, ['add', 'proof-or-stop.config.json']);
    git(fixture.root, ['commit', '-m', 'Synthetic full-envelope inventory mode with ordinary contributor identity']);
    cli(fixture.root, 'review_inventory_begin', { storyId }, env('main', 'b29bc-owner'));
    const fullEpoch = fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
    for (const lane of fullEpoch.requiredLanes) {
      const laneEnv = env(lane, `b29bc-full-required-${lane}`);
      cli(fixture.root, 'dispatch', { storyId, agentType: lane }, laneEnv);
      const fullStarted = cli(fixture.root, 'review_run_start', { storyId, agent: lane }, laneEnv);
      const fullId = fullStarted.match(/Review run (\S+) started/)?.[1];
      assert.ok(fullId, fullStarted);
      await runBrokeredNativeReviewCli({ root: fixture.root, store: fixture.store, storyId, agent: lane, reviewRunId: fullId, command: 'review_pass_set', payload: { storyId, agent: lane, reviewRunId: fullId, note: 'Disposable second epoch required lane read evidence.', readManifest, readEvents } });
    }
    const fullPurpose = { reviewPurpose: 'inventory-completeness', inventoryEpochId: fullEpoch.epochId };
    const fullEnv = env(actor, 'b29bc-full-critic');
    assert.match(cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...fullPurpose }, fullEnv), /inventory-completeness/);
    const fullStarted = cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...fullPurpose }, fullEnv);
    const fullId = fullStarted.match(/Review run (\S+) started/)?.[1];
    assert.ok(fullId, fullStarted);
    assert.ok(fixture.store.readReviewRuns(storyId).runs.find(row => row.reviewRunId === fullId)?.envelopeId, 'full-envelope purpose is carried by an actual durable envelope');
    await runBrokeredNativeReviewCli({ root: fixture.root, store: fixture.store, storyId, agent: actor, reviewRunId: fullId, command: 'review_pass_set', payload: { storyId, agent: actor, reviewRunId: fullId, note: 'Full-envelope disposable critic read every frozen source.', readManifest, readEvents } });
    assert.match(cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: fullEpoch.epochId, reviewRunId: fullId, agent: actor, findingDispositions: [] }, fullEnv), /Completeness critic: complete/);
    assert.equal(git(fixture.root, ['log', '-1', '--format=%an <%ae>']), 'Ordinary Contributor <ordinary@example.test>');
    console.log('B29BC_PURPOSE_FULL_ENVELOPE PASS');
    const fullRun = fixture.store.readReviewRuns(storyId).runs.find(row => row.reviewRunId === fullId)!;
    const fullEnvelope = fixture.store.readPromptEnvelopes(storyId).envelopes.find(row => row.envelopeId === fullRun.envelopeId)!;
    const selectedContract = promptRoleContract(actor, 'inventory-completeness');
    assert.equal(fullEnvelope.roleSemanticDigest, selectedContract.semanticDigest);
    assert.equal(fullEnvelope.eligibilityRoleSemanticDigest, selectedContract.semanticDigest);
    assert.deepEqual(selectedContract.requiredOutputIds, ['review-finding-or-pass', 'review-inventory-critic-receipt']);
    assert.ok(!selectedContract.allowedCommandIds.includes('topology_critic_receipt_set'));
    assert.equal(verifyReviewRunPromptEnvelope(fixture.store, fullRun).ok, true);
    assert.equal(verifyPromptEnvelopeIntegrity({ ...fullEnvelope, reviewerDispatchBindingDigest: '0'.repeat(64) }), false);
    assert.equal(verifyPromptEnvelopeIntegrity({ ...fullEnvelope, eligibilityRoleSemanticDigest: '0'.repeat(64) }), false);
    cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...fullPurpose }, fullEnv);
    assert.equal(verifyReviewRunPromptEnvelope(fixture.store, fullRun).ok, true, 'later dispatch preserves historical signed run');
    const fullData = fixture.store.readReviewInventoryEpochs(storyId);
    if (process.argv.includes('--progress-recovery-fixture')) {
      const observationPath = fixture.store.storyFilePath(storyId, 'convergence-progress.json');
      const beforeObservation = readFileSync(observationPath, 'utf8');
      writeFileSync(observationPath, '{invalid');
      assert.match(cli(fixture.root, 'review_inventory_finalize', { storyId }, env('main', 'b29bc-owner')), /Convergence progress unavailable/);
      assert.equal(fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1)?.state, 'FINALIZED', 'observation failure does not erase independently completed review');
      writeFileSync(observationPath, beforeObservation);
    }
    assert.match(cli(fixture.root, 'review_inventory_finalize', { storyId }, env('main', 'b29bc-owner')), /FINALIZED/);
    const progress = readConvergenceProgress(fixture.store, storyId, fixture.root);
    assert.ok(progress?.state.snapshot.completedEpochIds.includes(fullEpoch.epochId), 'U11 finalization captures actual independently completed epoch');
    const progressPath = fixture.store.storyFilePath(storyId, 'convergence-progress.json');
    const progressBytes = readFileSync(progressPath, 'utf8');
    cli(fixture.root, 'review_inventory_status', { storyId }, env('main', 'b29bc-owner'));
    assert.equal(readFileSync(progressPath, 'utf8'), progressBytes, 'inventory status never signs or mutates progress');
    if (process.argv.includes('--progress-recovery-fixture')) {
      cli(fixture.root, 'review_inventory_finalize', { storyId }, env('main', 'b29bc-owner'));
      assert.equal(readFileSync(progressPath, 'utf8'), progressBytes, 'recovered completion is recorded exactly once');
      console.log('PASS U11 finalize retry recovers one verified observation');
    }

    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...fullPurpose }, fullEnv), /OPEN|epoch|FINALIZED/i);
    assert.throws(() => cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...fullPurpose }, fullEnv), /OPEN|epoch|sealed/i);
    assert.throws(() => cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: fullEpoch.epochId, reviewRunId: fullId, agent: actor, findingDispositions: [] }, fullEnv), /OPEN|epoch|sealed/i);
    if (process.argv.includes('--progress-capture-fixture')) {
      cli(fixture.root, 'review_inventory_cancel', { storyId, reason: 'Cancel an unconsumed completed fixture epoch.' }, env('main', 'b29bc-owner'));
      assert.doesNotThrow(() => readConvergenceProgress(fixture.store, storyId, fixture.root), 'U11 legitimate signed cancellation preserves observed history');
      recordConvergenceProgress(fixture.store, storyId, fixture.root);
      const cancelledProgress = readConvergenceProgress(fixture.store, storyId, fixture.root)!;
      assert.deepEqual(cancelledProgress.state.snapshot.completedEpochIds, [fullEpoch.epochId]);
      assert.deepEqual(cancelledProgress.state.stagnantEpochIds, [], 'revocation interrupts a consecutive stagnation claim');
      cli(fixture.root, 'review_inventory_begin', { storyId }, env('main', 'b29bc-owner'));
      assert.ok(readConvergenceProgress(fixture.store, storyId, fixture.root));
      return;
    }
    // The following independent mutation cells restore their pre-finalization fixture.
    rmSync(progressPath, { force: true });
    fixture.store.writeReviewInventoryEpochs(storyId, fullData);
    const fullChecklist = fixture.store.readChecklist(storyId);
    fixture.store.writeChecklist(storyId, { ...fullChecklist, items: fullChecklist.items.map(row => ({ ...row, context: `${row.context} Changed accepted scope.` })) });
    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...fullPurpose }, fullEnv), /INVALIDATED|SCOPE|changed/i);
    assert.throws(() => cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...fullPurpose }, fullEnv), /OPEN|epoch|scope/i);
    // Independent fixture mutation cells reset to the exact previously signed
    // bytes. This is not an application recovery operation or epoch reopening.
    fixture.store.writeChecklist(storyId, fullChecklist);
    fixture.store.writeReviewInventoryEpochs(storyId, fullData);
    writeFileSync(join(fixture.root, 'packages/main/src/subject.ts'), 'export const subject = 2;\n');
    assert.throws(() => cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...fullPurpose }, fullEnv), /uncommitted|dirty/i);
    git(fixture.root, ['add', 'packages/main/src/subject.ts']);
    git(fixture.root, ['commit', '-m', 'Synthetic committed source-cutoff drift']);
    assert.throws(() => cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...fullPurpose }, fullEnv), /INVALIDATED|MATERIAL|changed/i);
    assert.throws(() => cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...fullPurpose }, fullEnv), /OPEN|epoch|sealed|material/i);
    assert.throws(() => cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: fullEpoch.epochId, reviewRunId: fullId, agent: actor, findingDispositions: [] }, fullEnv), /OPEN|epoch|sealed/i);
    console.log('B29BC_PURPOSE_LOCKED_FRESHNESS PASS');
  } finally {
    rmSync(topology.root, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function criticDiscoveryRecovery(): void {
  // Separate real-handler fixture: a critic discovers before its first receipt.
  // A receipt already issued for an empty set remains immutable; this test does
  // not require replacing it or reopening a previously certified observation.
  const fixture = setup({ name: 'Harmonynet', email: '26995688+Harmonynet@users.noreply.github.com' });
  const env = (agent: string): NodeJS.ProcessEnv => ({ PROOF_OR_STOP_AGENT: agent,
    PROOF_OR_STOP_SESSION_ID: `b29bc-discovery-${agent}` });
  const readManifest = { filesReadFully: ['packages/main/src/subject.ts'], filesTriagedByName: [], scanEscalationReason: null };
  const readEvents = [{ path: 'packages/main/src/subject.ts', mode: 'full', action: 'Read', tokenCount: null }];
  try {
    cli(fixture.root, 'review_inventory_begin', { storyId }, env('main'));
    const epoch = fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
    for (const lane of epoch.requiredLanes) {
      cli(fixture.root, 'dispatch', { storyId, agentType: lane }, env(lane));
      const started = cli(fixture.root, 'review_run_start', { storyId, agent: lane }, env(lane));
      const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
      assert.ok(reviewRunId, started);
      cli(fixture.root, 'review_pass_set', { storyId, agent: lane, reviewRunId,
        note: 'Disposable required lane inspected the frozen source.', readManifest, readEvents }, env(lane));
    }
    const actor = 'proof-or-stop-review-topology-critic';
    const purpose = { reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId };
    cli(fixture.root, 'dispatch', { storyId, agentType: actor, ...purpose }, env(actor));
    const started = cli(fixture.root, 'review_run_start', { storyId, agent: actor, ...purpose }, env(actor));
    const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
    assert.ok(reviewRunId, started);
    const output = cli(fixture.root, 'finding_add', { storyId, agent: actor, reviewRunId,
      desc: 'The disposable critic discovered a verified missing read boundary after required lanes terminated.',
      severity: 'high', category: 'missing', evidenceState: 'verified', files: ['packages/main/src/subject.ts'],
      readManifest, readEvents }, env(actor));
    const findingId = output.match(/(B-inventory-handler:F-\d+)/)?.[1];
    assert.ok(findingId, output);
    assert.throws(() => cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: epoch.epochId,
      reviewRunId, agent: actor, findingDispositions: [] }, env(actor)), /REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE/,
    'F-002 an empty disposition set cannot erase current critic discovery');
    assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length, 0);
    assert.match(cli(fixture.root, 'review_inventory_critic_set', { storyId, epochId: epoch.epochId,
      reviewRunId, agent: actor, findingDispositions: [{ findingId, disposition: 'verified_family',
        familyKey: 'critic-discovered-boundary', reason: 'The independent disposable critic verified this signed current observation.' }] }, env(actor)),
    /Completeness critic: complete/, 'F-002 exact own-finding disposition must be accepted');
    console.log('B29BC_CRITIC_OWN_FINDING_DISPOSITION PASS');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}

await inventoryPurposeRecovery();
if (process.argv.includes('--progress-capture-fixture')) {
  console.log('PASS U11 real inventory finalization captures verified progress');
  process.exit(0);
}
criticDiscoveryRecovery();
if (process.argv.includes('--purpose-only')) process.exit(0);

const criticArgs = { storyId, agentType: 'proof-or-stop-review-topology-critic' };
const first = setup(undefined, true);
seedProofStoryAcceptance(first.store);
const originalProofStoryContract = structuredClone(first.store.readProofStoryContract(storyId)!);
const criticDispatch = cli(first.root, 'dispatch', { storyId, agentType: 'proof-or-stop-review-topology-critic' }, {
  PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic',
  PROOF_OR_STOP_SESSION_ID: 'sess-inventory-topology-critic',
});
assert.match(criticDispatch, /topology_critic_receipt_set/);
const actualCriticRun = cli(first.root, 'review_run_start', { storyId, agent: 'proof-or-stop-review-topology-critic' }, {
  PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic',
  PROOF_OR_STOP_SESSION_ID: 'sess-inventory-topology-critic',
});
assert.match(actualCriticRun, /Review run B-inventory-handler:RR-/);
const listedCriticRuns = JSON.parse(cli(first.root, 'review_run_list', {
  storyId,
  latest: true,
  json: true,
})) as { latest: boolean; runs: Array<{ reviewRunId: string; signatureValid: boolean }> };
assert.equal(listedCriticRuns.latest, true, 'review_run_list acknowledges the compact latest-only filter');
assert.equal(listedCriticRuns.runs.length, 1, 'review_run_list returns the compact persisted run record');
assert.match(listedCriticRuns.runs[0].reviewRunId, /^B-inventory-handler:RR-\d+$/, 'review_run_list exposes the durable run ID');
assert.equal(listedCriticRuns.runs[0].signatureValid, true, 'review_run_list verifies its returned run signature');
const begin = cli(first.root, 'review_inventory_begin', { storyId, maxWaves: 2 });
assert.match(begin, /State: OPEN/);
assert.match(first.handlers.review_inventory_status({ storyId }), /REVIEW_INVENTORY_LANES_INCOMPLETE/);
assert.match(cli(first.root, 'review_inventory_status', { storyId }), /REVIEW_INVENTORY_LANES_INCOMPLETE/);
const reloaded = new StoryStore(first.root);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).epochs.length, 1, 'begin persists across store reload');
const epoch = reloaded.readReviewInventoryEpochs(storyId).epochs[0];
const beforeIncompleteAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_LANES_INCOMPLETE/,
  'real wave_advance rejects incomplete lanes',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeIncompleteAdvance, 'incomplete wave rejection is side-effect free');
const readManifest = { filesReadFully: ['packages/main/src/subject.ts'], filesTriagedByName: [], scanEscalationReason: null };
const readEvents = [{ path: 'packages/main/src/subject.ts', mode: 'full', action: 'Read', tokenCount: 8 }];
let realFindingId = '';
const firstWaveRuns = new Map<string, { reviewRunId: string; sessionId: string }>();
for (const [index, lane] of epoch.requiredLanes.entries()) {
  const sessionId = `sess-inventory-${lane}`;
  cli(first.root, 'dispatch', { storyId, agentType: lane }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
  const started = cli(first.root, 'review_run_start', { storyId, agent: lane }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
  const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
  assert.ok(reviewRunId, `real review_run_start must return a signed run for ${lane}: ${started}`);
  firstWaveRuns.set(lane, { reviewRunId, sessionId });
  if (index === 0) {
    const finding = cli(first.root, 'finding_add', {
      storyId,
      agent: lane,
      reviewRunId,
      desc: 'Synthetic verified family proving the real finding_add terminal path.',
      severity: 'medium',
      category: 'missing',
      evidenceState: 'verified',
      files: ['packages/main/src/subject.ts'],
      readManifest,
      readEvents,
    }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
    realFindingId = finding.match(/(B-inventory-handler:F-\d+)/)?.[1] ?? '';
    assert.ok(realFindingId, `real finding_add must persist an ID: ${finding}`);
  } else {
    cli(first.root, 'review_pass_set', {
      storyId,
      agent: lane,
      reviewRunId,
      note: `Real handler smoke found no blocker for ${lane}.`,
      readManifest,
      readEvents,
    }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
  }
}
const retryLane = epoch.requiredLanes[1];
const retryRun = firstWaveRuns.get(retryLane)!;
const passCountBeforeRetry = reloaded.readReviewPasses(storyId).passes.length;
const passEventsBeforeRetry = reloaded.readProcessEvents(storyId).filter(row => row.type === 'review_pass').length;
const ambiguousRetry = cli(first.root, 'review_pass_set', {
  storyId, agent: retryLane, reviewRunId: retryRun.reviewRunId,
  note: `Real handler smoke found no blocker for ${retryLane}.`, readManifest, readEvents,
}, { PROOF_OR_STOP_AGENT: retryLane, PROOF_OR_STOP_SESSION_ID: retryRun.sessionId });
const retryPassId = reloaded.readReviewPasses(storyId).passes.find(row => row.reviewRunId === retryRun.reviewRunId)!.id;
assert.match(ambiguousRetry, new RegExp(`Review pass ${retryPassId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} already recorded`));
assert.equal(reloaded.readReviewPasses(storyId).passes.length, passCountBeforeRetry, 'F046: an ambiguous exact retry preserves one RP');
assert.equal(reloaded.readProcessEvents(storyId).filter(row => row.type === 'review_pass').length, passEventsBeforeRetry, 'F046: an ambiguous exact retry emits no duplicate event');
assert.throws(
  () => cli(first.root, 'review_pass_set', {
    storyId, agent: retryLane, reviewRunId: retryRun.reviewRunId,
    note: 'Conflicting semantic evidence for the same terminal must fail closed.', readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: retryLane, PROOF_OR_STOP_SESSION_ID: retryRun.sessionId }),
  /conflicting terminal pass/,
);
const multiRunLane = epoch.requiredLanes[0];
const multiRunSession = `sess-inventory-newer-pass-${multiRunLane}`;
cli(first.root, 'dispatch', { storyId, agentType: multiRunLane }, { PROOF_OR_STOP_AGENT: multiRunLane, PROOF_OR_STOP_SESSION_ID: multiRunSession });
const newerSameLaneStarted = cli(first.root, 'review_run_start', { storyId, agent: multiRunLane }, {
  PROOF_OR_STOP_AGENT: multiRunLane, PROOF_OR_STOP_SESSION_ID: multiRunSession,
});
const newerSameLaneRunId = newerSameLaneStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(newerSameLaneRunId);
cli(first.root, 'review_pass_set', {
  storyId, agent: multiRunLane, reviewRunId: newerSameLaneRunId,
  note: 'Newer same-lane pass must not hide the older run verified finding.', readManifest, readEvents,
}, { PROOF_OR_STOP_AGENT: multiRunLane, PROOF_OR_STOP_SESSION_ID: multiRunSession });
const beforeCriticAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_CRITIC_INCOMPLETE/,
  'real wave_advance rejects a complete lane set without critic authority',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeCriticAdvance, 'critic-incomplete rejection is side-effect free');
cli(first.root, 'dispatch', { storyId, agentType: 'proof-or-stop-review-topology-critic', reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId }, {
  PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic', PROOF_OR_STOP_SESSION_ID: 'sess-inventory-critic-terminal',
});
const criticStarted = cli(first.root, 'review_run_start', { storyId, agent: 'proof-or-stop-review-topology-critic', reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId }, {
  PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic', PROOF_OR_STOP_SESSION_ID: 'sess-inventory-critic-terminal',
});
const criticReviewRunId = criticStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(criticReviewRunId, `real critic review_run_start must return a signed run: ${criticStarted}`);
cli(first.root, 'review_pass_set', {
  storyId,
  agent: 'proof-or-stop-review-topology-critic',
  reviewRunId: criticReviewRunId,
  note: 'Independent critic reviewed the exact aggregate and lane coverage.',
  readManifest,
  readEvents,
}, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic', PROOF_OR_STOP_SESSION_ID: 'sess-inventory-critic-terminal' });
const criticPassCount = reloaded.readReviewPasses(storyId).passes.length;
const criticPassRetry = cli(first.root, 'review_pass_set', {
  storyId,
  agent: 'proof-or-stop-review-topology-critic',
  reviewRunId: criticReviewRunId,
  note: 'Independent critic reviewed the exact aggregate and lane coverage.',
  readManifest,
  readEvents,
}, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic', PROOF_OR_STOP_SESSION_ID: 'sess-inventory-critic-terminal' });
assert.match(criticPassRetry, /already recorded/, 'F046: critic pass uses the same idempotent terminal writer');
assert.equal(reloaded.readReviewPasses(storyId).passes.length, criticPassCount);
const critic = cli(first.root, 'review_inventory_critic_set', {
  storyId, epochId: epoch.epochId, reviewRunId: criticReviewRunId,
  agent: 'proof-or-stop-review-topology-critic',
  findingDispositions: [{
    findingId: realFindingId,
    disposition: 'verified_family',
    familyKey: `finding:${realFindingId}`,
    reason: 'Independent critic conservatively retained this verified family',
  }],
}, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic' });
assert.match(critic, /Completeness critic: complete/);
const discoveryStatus = cli(first.root, 'review_inventory_status', { storyId });
assert.match(discoveryStatus, /Blockers: none/);
assert.match(discoveryStatus, /Next: proof-or-stop review_inventory_finalize .*--remediation/);
assert.equal((discoveryStatus.match(/^Next:/gm) ?? []).length, 1);
assert.throws(
  () => cli(first.root, 'review_inventory_finalize', { storyId }),
  /REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE/,
  'finalize cannot persist a non-saturated wave as an implicit checkpoint',
);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).epochs[0].waves.length, 0, 'rejected finalize is side-effect free');
const beforeEarlyFinalize = reloaded.readReviewInventoryEpochs(storyId);
const beforeEarlyFindings = reloaded.readFindings(storyId);
const earlyFinalizeOutput = cli(first.root, 'review_inventory_finalize', {storyId,remediation:true});
assert.match(earlyFinalizeOutput,/FINALIZED/);
const earlyFinalized = reloaded.readReviewInventoryEpochs(storyId);
assert.equal(earlyFinalized.receipts.at(-1)?.authority,'review-remediation-only');
assert.equal(earlyFinalized.receipts.at(-1)?.authorizesTest,false);
assert.equal(earlyFinalized.epochs[0].waves.length,1);
assert.deepEqual(reloaded.readFindings(storyId),beforeEarlyFindings,'early remediation preserves findings');
// This store belongs to a disposable test fixture; reset only this snapshot so
// the existing explicit saturation and hostile-evidence controls run unchanged.
reloaded.writeReviewInventoryEpochs(storyId,beforeEarlyFinalize);

const discoveryWave = cli(first.root, 'review_inventory_wave_advance', { storyId });
assert.match(discoveryWave, /State: OPEN/);
assert.match(discoveryWave, /Current wave: 2\/2/);
assert.throws(() => cli(first.root, 'review_run_start', { storyId, agent: criticArgs.agentType, reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId }, { PROOF_OR_STOP_AGENT: criticArgs.agentType, PROOF_OR_STOP_SESSION_ID: 'sess-inventory-critic-terminal' }), /dispatch|inventory/);
const oldWaveLane = epoch.requiredLanes[1];
const oldWaveRun = firstWaveRuns.get(oldWaveLane)!;
assert.throws(
  () => cli(first.root, 'review_pass_set', {
    storyId, agent: oldWaveLane, reviewRunId: oldWaveRun.reviewRunId,
    note: 'A late terminal from the prior wave must be rejected.', readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: oldWaveLane, PROOF_OR_STOP_SESSION_ID: oldWaveRun.sessionId }),
  /REVIEW_INVENTORY_WAVE_EVIDENCE_SEALED/,
  'F031: wave checkpoint seals every ReviewRun that started before the new wave boundary',
);
// Force the already-persisted positive wave to be the configured budget edge,
// then prove the real CLI refuses before writing another checkpoint.
let budgetData = reloaded.readReviewInventoryEpochs(storyId);
const budgetEpoch = budgetData.epochs[0];
const { _hash: _budgetHash, ...budgetUnsigned } = budgetEpoch;
const exhaustedUnsigned = { ...budgetUnsigned, maxWaves: 1 };
budgetData.epochs[0] = { ...exhaustedUnsigned, _hash: signReviewInventoryEpoch(exhaustedUnsigned) };
reloaded.writeReviewInventoryEpochs(storyId, budgetData);
const beforeBudgetAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_BUDGET_EXHAUSTED/,
  'real wave_advance rejects exhaustion instead of manufacturing progress',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeBudgetAdvance, 'budget rejection is side-effect free');
budgetData = reloaded.readReviewInventoryEpochs(storyId);
const exhaustedEpoch = budgetData.epochs[0];
const { _hash: _exhaustedHash, ...exhaustedBase } = exhaustedEpoch;
const restoredBudgetUnsigned = { ...exhaustedBase, maxWaves: 2 };
budgetData.epochs[0] = { ...restoredBudgetUnsigned, _hash: signReviewInventoryEpoch(restoredBudgetUnsigned) };
reloaded.writeReviewInventoryEpochs(storyId, budgetData);
const secondWaveRuns = new Map<string, { reviewRunId: string; sessionId: string }>();
for (const lane of epoch.requiredLanes) {
  const sessionId = `sess-inventory-wave2-${lane}`;
  cli(first.root, 'dispatch', { storyId, agentType: lane }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
  const started = cli(first.root, 'review_run_start', { storyId, agent: lane }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
  const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
  assert.ok(reviewRunId, `second-wave review_run_start must return a signed run for ${lane}: ${started}`);
  secondWaveRuns.set(lane, { reviewRunId, sessionId });
  cli(first.root, 'review_pass_set', {
    storyId, agent: lane, reviewRunId,
    note: `Second complete unchanged-material wave found no new family for ${lane}.`,
    readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
}
cli(first.root, 'dispatch', { storyId, agentType: 'proof-or-stop-review-topology-critic', reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId }, {
  PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic', PROOF_OR_STOP_SESSION_ID: 'sess-inventory-wave2-critic',
});
const secondCriticStarted = cli(first.root, 'review_run_start', { storyId, agent: 'proof-or-stop-review-topology-critic', reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId }, {
  PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic', PROOF_OR_STOP_SESSION_ID: 'sess-inventory-wave2-critic',
});
const secondCriticReviewRunId = secondCriticStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(secondCriticReviewRunId);
const selectedInventoryRole = promptRoleContract(criticArgs.agentType, 'inventory-completeness');
const secondCriticRun = reloaded.readReviewRuns(storyId).runs.find(row => row.reviewRunId === secondCriticReviewRunId)!;
const secondCriticEnvelope = reloaded.readPromptEnvelopes(storyId).envelopes.find(row => row.envelopeId === secondCriticRun.envelopeId)!;
assert.ok(secondCriticEnvelope.priorPassRef, 'wave two must consume a genuine signed prior critic PASS');
assert.equal(secondCriticEnvelope.eligibilityRoleSemanticDigest, selectedInventoryRole.semanticDigest);
assert.ok(!secondCriticEnvelope.eligibilityReasonCodes!.includes('FULL_ROLE_CONTRACT_CHANGED'), 'same inventory contract must not force full');
assert.equal(verifyReviewRunPromptEnvelope(reloaded, secondCriticRun).ok, true);
const currentEligibility = reviewIncrementalContext(reloaded, first.root, storyId, criticArgs.agentType);
assert.ok(!currentEligibility.eligibilityReasonCodes.includes('FULL_ROLE_CONTRACT_CHANGED'), 'read-only live selector shares signed OPEN contract');
const topologyEligibility = reviewIncrementalContext(reloaded, first.root, storyId, criticArgs.agentType, {
  roleSemanticDigest: promptRoleContract(criticArgs.agentType).semanticDigest,
});
assert.ok(topologyEligibility.eligibilityReasonCodes.includes('FULL_ROLE_CONTRACT_CHANGED'), 'inventory-to-topology responsibility transition still requires full');
assert.throws(() => reviewIncrementalContext(reloaded, first.root, storyId, criticArgs.agentType, {
  roleSemanticDigest: promptRoleContract('proof-or-stop-review-quality').semanticDigest,
}), /unregistered/, 'cross-role semantic selection is refused');
cli(first.root, 'review_pass_set', {
  storyId, agent: 'proof-or-stop-review-topology-critic', reviewRunId: secondCriticReviewRunId,
  note: 'Second-wave critic verified zero new finding families.', readManifest, readEvents,
}, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic', PROOF_OR_STOP_SESSION_ID: 'sess-inventory-wave2-critic' });
cli(first.root, 'review_inventory_critic_set', {
  storyId, epochId: epoch.epochId, reviewRunId: secondCriticReviewRunId,
  agent: 'proof-or-stop-review-topology-critic', findingDispositions: [],
}, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-topology-critic' });
const beforeZeroNewAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_ZERO_NEW_READY_TO_FINALIZE/,
  'real wave_advance refuses the zero-new state reserved for finalize',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeZeroNewAdvance, 'zero-new rejection is side-effect free');
const finalizeReady = join(first.root, 'review-inventory-finalize.ready');
const finalizeDuringShrinkRace = cliAsync(first.root, 'review_inventory_finalize', { storyId }, {
  NODE_ENV: 'test',
  LATTICE_INTERNAL_REVIEW_INVENTORY_FINALIZE_HOLD_MS: '1000',
  LATTICE_INTERNAL_REVIEW_INVENTORY_FINALIZE_READY_FILE: finalizeReady,
});
waitForFile(finalizeReady);
const shrinkAfterFinalizeChecks = cliAsync(first.root, 'scope_shrinkage_decision_set', {
  storyId, decision: 'confirmed', userConfirmed: true,
  withdrawnAcceptanceBindingRefs: ['AB-002'],
  reason: 'Race a binding withdrawal against receipt publication.', approvedBy: 'operator',
});
const [finalizeRaceResult, shrinkRaceResult] = await Promise.all([finalizeDuringShrinkRace, shrinkAfterFinalizeChecks]);
unlinkSync(finalizeReady);
assert.equal(finalizeRaceResult.ok, true, finalizeRaceResult.output);
assert.equal(shrinkRaceResult.ok, true, shrinkRaceResult.output);
const finalized = finalizeRaceResult.output;
assert.match(finalized, /State: FINALIZED/);
assert.throws(
  () => consumeReviewInventoryReceipt(reloaded, storyId, reviewRound, epoch.cutoff),
  /effective ProofStory\/checklist acceptance subject changed/,
  'F042: finalize-vs-shrink linearizes finalize first, then consume rejects the changed acceptance subject',
);
// Restore the exact frozen semantic subject so the remaining independent
// receipt/aggregate tests can exercise their intended rejection boundaries.
reloaded.writeProofStoryContract(storyId, originalProofStoryContract);
unlinkSync(first.store.storyFilePath(storyId, 'scope-shrinkage-decision.json'));
assert.ok(finalizedUnconsumedReviewInventory(reloaded, storyId), 'finalized signed receipt is visible to the begin barrier');
assert.throws(() => cli(first.root, 'review_inventory_begin', { storyId }), /REVIEW_INVENTORY_RECEIPT_UNCONSUMED/);
const finalizedData = reloaded.readReviewInventoryEpochs(storyId);
const receipt = finalizedData.receipts[0];
const sealedLane = epoch.requiredLanes[0];
const sealedRun = secondWaveRuns.get(sealedLane)!;
assert.throws(
  () => cli(first.root, 'review_pass_set', {
    storyId, agent: sealedLane, reviewRunId: sealedRun.reviewRunId,
    note: 'Late pass must not mutate a finalized review inventory.', readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: sealedLane, PROOF_OR_STOP_SESSION_ID: sealedRun.sessionId }),
  /REVIEW_INVENTORY_EVIDENCE_SEALED/,
  'review_pass_set cannot append after FINALIZED',
);
assert.throws(
  () => cli(first.root, 'finding_add', {
    storyId, agent: sealedLane, reviewRunId: sealedRun.reviewRunId,
    desc: 'Late verified finding must not escape the finalized aggregate.',
    severity: 'medium', category: 'adversarial', evidenceState: 'verified',
    files: ['packages/main/src/subject.ts'], readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: sealedLane, PROOF_OR_STOP_SESSION_ID: sealedRun.sessionId }),
  /REVIEW_INVENTORY_EVIDENCE_SEALED/,
  'finding_add cannot append after FINALIZED',
);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).receipts[0]._hash, receipt._hash, 'sealed writer refusals preserve the receipt');

// Simulate an out-of-band/crash-era writer that bypassed the shared lock. The
// consumer must still recompute the live aggregate and reject the old receipt.
const findingsBeforeTamper = reloaded.readFindings(storyId);
const sourceFinding = findingsBeforeTamper.findings.find(row => row.id === realFindingId)!;
const lateId = `${storyId}:F-999`;
const lateCreatedAt = new Date(Date.parse(receipt.issuedAt) + 1).toISOString();
const lateDesc = 'Out-of-band late verified finding omitted from the finalized receipt.';
const lateFinding: Finding = {
  ...sourceFinding,
  id: lateId,
  desc: lateDesc,
  agent: sealedLane,
  createdAt: lateCreatedAt,
  reviewRunId: sealedRun.reviewRunId,
  reviewRound,
  _hash: signFinding(
    storyId, lateId, lateDesc, sourceFinding.severity, lateCreatedAt, reviewRound,
    sealedRun.reviewRunId, sourceFinding.readManifest, sourceFinding.readLog, sourceFinding.readDiagnostics,
  ),
};
findingsBeforeTamper.findings.push(lateFinding);
reloaded.writeFindings(storyId, findingsBeforeTamper);
assert.throws(
  () => consumeReviewInventoryReceipt(reloaded, storyId, reviewRound, epoch.cutoff),
  /REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED/,
  'consumer re-verifies live terminals/finding families instead of trusting a stale frozen aggregate',
);
const restoredFindings = reloaded.readFindings(storyId);
restoredFindings.findings = restoredFindings.findings.filter(row => row.id !== lateId);
reloaded.writeFindings(storyId, restoredFindings);
writeFileSync(join(first.root, 'packages/main/src/subject.ts'), 'export const subject = 99;\n');
assert.throws(
  () => cli(first.root, 'story_advance', { storyId, phase: 'DEV' }),
  /REVIEW_INVENTORY|cutoff|material|invalid/i,
  'real story_advance rejects a post-finalize pre-consumption material mutation',
);
assert.equal(reloaded.readStory(storyId).phase, 'REVIEW', 'TOCTOU rejection cannot publish DEV');
assert.equal(reloaded.readReviewInventoryEpochs(storyId).receipts[0].consumedAt, undefined, 'TOCTOU rejection cannot consume the receipt');
writeFileSync(join(first.root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
const remediationAdvance = cli(first.root, 'story_advance', { storyId, phase: 'DEV' });
assert.match(remediationAdvance, /DEV/);
assert.equal(reloaded.readStory(storyId).phase, 'DEV', 'real story_advance consumes the receipt before publishing DEV');
assert.throws(() => consumeReviewInventoryReceipt(reloaded, storyId, reviewRound, epoch.cutoff), /REVIEW_INVENTORY_REMEDIATION_BLOCKED/);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).receipts[0].receiptId, receipt.receiptId);
assert.throws(
  () => cli(first.root, 'finding_add', {
    storyId, agent: sealedLane, reviewRunId: sealedRun.reviewRunId,
    desc: 'An old review run cannot append evidence after DEV phase publication.',
    severity: 'medium', category: 'adversarial', evidenceState: 'verified',
    files: ['packages/main/src/subject.ts'], readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: sealedLane, PROOF_OR_STOP_SESSION_ID: sealedRun.sessionId }),
  /REVIEW_EVIDENCE_PHASE_REQUIRED/,
  'F030: reviewer evidence is phase-bound, so DEV cannot accept an old-run writer',
);

const postRemediationStory = reloaded.readStory(storyId);
postRemediationStory.currentReviewRound = '2020-01-02T00:00:00.000Z';
reloaded.writeStory(storyId, postRemediationStory);
writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 2;\n');
git(first.root, ['add', 'packages/main/tests/isolated.test.ts']);
git(first.root, ['commit', '-m', 'narrow post-remediation repair']);
const activeReviewers: ActiveReviewer[] = [
  { name: 'concept', lane: 'proof-or-stop-review-concept', legacyAliases: [], reason: 'baseline' },
  { name: 'quality', lane: 'proof-or-stop-review-quality', legacyAliases: [], reason: 'baseline' },
  { name: 'test-coverage', lane: 'proof-or-stop-review-test-coverage', legacyAliases: [], reason: 'baseline' },
  { name: 'behavior', lane: 'proof-or-stop-review-behavior', legacyAliases: [], reason: 'riskSignal: gate' },
  { name: 'docs', lane: 'proof-or-stop-review-docs', legacyAliases: [], reason: 'touchpoints .md' },
];
const narrowClosure = computeCanonicalDependencyClosure(first.root, ['packages/main/tests/isolated.test.ts']);
assert.equal(narrowClosure.complete, true, JSON.stringify(narrowClosure));
const narrowSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(narrowSelection.selection, 'dependency-closure', JSON.stringify(narrowSelection));
assert.deepEqual(narrowSelection.selectedLanes, [
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
]);
assert.equal(narrowSelection.requiredHostAssurance, 'unchanged');
assert.equal(verifyPostRemediationReviewSelection(narrowSelection), true);
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), true);
for (const forged of [
  { ...narrowSelection, _hash: '' },
  { ...narrowSelection, storyId: 'B-cross-story' },
  { ...narrowSelection, reviewRound: 'cross-round' },
  { ...narrowSelection, headHash: '0'.repeat(40) },
  { ...narrowSelection, materialHash: '0'.repeat(64) },
  { ...narrowSelection, storyFilesHash: '0'.repeat(64) },
]) {
  assert.equal(verifyPostRemediationReviewSelection(forged), false, 'unsigned, cross-boundary, or forged lineage cannot narrow final review');
}
const roster = computeFinalReviewRoster(reloaded, first.root, storyId, activeReviewers);
assert.deepEqual(roster.requiredReviewers.map(row => row.name), ['quality', 'test-coverage']);
const rosterStatus = renderFinalReviewRoster(roster, storyId);
assert.match(rosterStatus, /^Final-review lanes: proof-or-stop-review-quality, proof-or-stop-review-test-coverage$/m);
assert.match(rosterStatus, /^Selection: dependency-closure \(PROVEN_CANONICAL_DEPENDENCY_CLOSURE: 1 changed file\(s\) close over 1 tracked dependency file\(s\)\)$/m);
assert.equal((rosterStatus.match(/^Next:/gm) ?? []).length, 1);
assert.deepEqual(
  computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts', 'packages/main/src/subject.ts']),
  computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts']),
  'dependency closure canonicalizes ordering and duplicate inputs',
);

writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 3;\n');
const dirtySelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(dirtySelection.selection, 'full-set');
assert.equal(dirtySelection.reason, 'DIRTY_MATERIAL');
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), false, 'dirty material invalidates a prior narrow selection even though HEAD is unchanged');
writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 2;\n');

writeFileSync(join(first.root, '.git/info/exclude'), 'packages/main/src/ignored.ts\n');
writeFileSync(join(first.root, 'packages/main/src/ignored.ts'), 'export const ignored = true;\n');
const ignoredSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(ignoredSelection.selection, 'full-set');
assert.equal(ignoredSelection.reason, 'UNTRACKED_OR_IGNORED_MATERIAL');
unlinkSync(join(first.root, 'packages/main/src/ignored.ts'));

git(first.root, ['mv', 'packages/main/src/subject.ts', 'packages/main/src/renamed-subject.ts']);
git(first.root, ['commit', '-m', 'inject unsupported rename']);
const renameSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(renameSelection.selection, 'full-set');
assert.equal(renameSelection.reason, 'UNSUPPORTED_RENAME_OR_DELETE');
git(first.root, ['mv', 'packages/main/src/renamed-subject.ts', 'packages/main/src/subject.ts']);
git(first.root, ['commit', '-m', 'restore canonical subject path']);

writeFileSync(join(first.root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js'; export const a = 2;\n");
writeFileSync(join(first.root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js'; export const b = 2;\n");
git(first.root, ['add', 'packages/main/src/consumer-a.ts', 'packages/main/src/consumer-b.ts']);
git(first.root, ['commit', '-m', 'add transitive shared dependants']);
const expandedClosure = computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts']);
assert.equal(expandedClosure.complete, true, JSON.stringify(expandedClosure));
assert.deepEqual(expandedClosure.files, [
  'packages/main/src/consumer-a.ts',
  'packages/main/src/consumer-b.ts',
  'packages/main/src/subject.ts',
]);
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), false, 'new dependency invalidates the prior narrow selection binding');
const recomputedSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.notEqual(recomputedSelection._hash, narrowSelection._hash);
assert.ok(recomputedSelection.closureFiles.includes('packages/main/src/consumer-b.ts'), 'current-material recomputation follows transitive dependants');

writeFileSync(join(first.root, 'packages/main/src/untracked.ts'), 'export const hidden = true;\n');
const untrackedSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(untrackedSelection.selection, 'full-set');
assert.equal(untrackedSelection.reason, 'UNTRACKED_OR_IGNORED_MATERIAL');
unlinkSync(join(first.root, 'packages/main/src/untracked.ts'));

writeFileSync(join(first.root, 'packages/main/src/opaque.ts'), "declare const target: string; export const load = () => import(target);\n");
git(first.root, ['add', 'packages/main/src/opaque.ts']);
git(first.root, ['commit', '-m', 'inject opaque dependency']);
const opaqueSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(opaqueSelection.selection, 'full-set');
assert.equal(opaqueSelection.reason, 'DEPENDENCY_CLOSURE_INCOMPLETE');
assert.match(opaqueSelection.reasonDetail, /opaque dynamic dependency/);
assert.deepEqual(opaqueSelection.selectedLanes, opaqueSelection.activeLanes);
const opaqueStatus = renderFinalReviewRoster(computeFinalReviewRoster(reloaded, first.root, storyId, activeReviewers), storyId);
assert.match(opaqueStatus, /^Selection: full-set \(DEPENDENCY_CLOSURE_INCOMPLETE: opaque dynamic dependency:/m);
assert.equal((opaqueStatus.match(/^Next:/gm) ?? []).length, 1);
assert.equal(computeCanonicalDependencyClosure(first.root, ['../subject.ts']).complete, false, 'path traversal cannot enter the canonical source inventory');

const expandedChecklist = reloaded.readChecklist(storyId);
expandedChecklist.items[0].files = { modify: ['packages/main/src/subject.ts', 'packages/main/src/expanded.ts'], create: [], test: [] };
reloaded.writeChecklist(storyId, expandedChecklist);
const expandedScopeSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(expandedScopeSelection.selection, 'full-set');
assert.equal(expandedScopeSelection.reason, 'SCOPE_OR_POLICY_CHANGED');
assert.deepEqual(expandedScopeSelection.selectedLanes, narrowSelection.activeLanes, 'scope expansion restores every active lane');

const provenance = [
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-043'],
  ['57bbc87d5faba0610cca88e088af1b54a327c0ef', 'B-cdf6:RR-044'],
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-045'],
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-046'],
  ['26a30e6cd7f00672e2b399d5d8e7473a4cbb1360', 'B-cdf6:F-036'],
] as const;
for (const [commit, identifier] of provenance) {
  git(repositoryRoot, ['cat-file', '-e', `${commit}^{commit}`]);
  git(repositoryRoot, ['grep', '-q', '-F', identifier, commit, '--', '.lattice/story/actives/B-cdf6']);
}
git(repositoryRoot, ['cat-file', '-e', '155e787d0c92612f16e9c2dd011531b0caa18ee6^{commit}']);
const decisionText = readFileSync(join(repositoryRoot, 'docs/requirements/decisions/review-inventory-epoch-and-saturation-gate.md'), 'utf8');
for (const [, identifier] of provenance) assert.ok(decisionText.includes(identifier), `decision provenance must cite ${identifier}`);
assert.ok(decisionText.includes('155e787d0c92612f16e9c2dd011531b0caa18ee6'), 'decision provenance must cite the exact material-fix commit');
assert.ok(!decisionText.includes('claude-session-b-cdf6-review-convergence-analysis-and-optimization.md'), 'decision provenance cannot depend on the excluded analysis document');
console.log('B3F3D-006-H3 docs/provenance: PASS');

const symlinkCase = setup();
symlinkSync('subject.ts', join(symlinkCase.root, 'packages/main/src/subject-alias.ts'));
git(symlinkCase.root, ['add', 'packages/main/src/subject-alias.ts']);
git(symlinkCase.root, ['commit', '-m', 'inject source alias']);
const symlinkClosure = computeCanonicalDependencyClosure(symlinkCase.root, ['packages/main/src/subject-alias.ts']);
assert.equal(symlinkClosure.complete, false);
assert.match(symlinkClosure.reason ?? '', /symlink/);

const cancelled = setup();
cli(cancelled.root, 'review_inventory_begin', { storyId });
assert.match(cli(cancelled.root, 'review_inventory_cancel', { storyId, reason: 'operator cancels this real handler smoke epoch' }), /State: CANCELLED/);
assert.match(cli(cancelled.root, 'review_inventory_begin', { storyId }), /State: OPEN/, 'cancelled epoch permits a fresh persisted epoch');

const cancelRace = setup();
cli(cancelRace.root, 'review_inventory_begin', { storyId });
const raceLane = 'proof-or-stop-review-concept';
const raceSession = 'sess-inventory-cancel-race';
cli(cancelRace.root, 'dispatch', { storyId, agentType: raceLane }, { PROOF_OR_STOP_AGENT: raceLane, PROOF_OR_STOP_SESSION_ID: raceSession });
const raceStarted = cli(cancelRace.root, 'review_run_start', { storyId, agent: raceLane }, { PROOF_OR_STOP_AGENT: raceLane, PROOF_OR_STOP_SESSION_ID: raceSession });
const raceRunId = raceStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(raceRunId);
const [cancelRaceResult, findingRaceResult] = await Promise.all([
  cliAsync(cancelRace.root, 'review_inventory_cancel', { storyId, reason: 'concurrent late evidence recovery race' }),
  cliAsync(cancelRace.root, 'finding_add', {
    storyId, agent: raceLane, reviewRunId: raceRunId,
    desc: 'Concurrent finding is either durably before cancel or rejected after its boundary.',
    severity: 'high', category: 'adversarial', evidenceState: 'verified',
    files: ['packages/main/src/subject.ts'], readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: raceLane, PROOF_OR_STOP_SESSION_ID: raceSession }),
]);
assert.equal(cancelRaceResult.ok, true, cancelRaceResult.output);
if (!findingRaceResult.ok) assert.match(findingRaceResult.output, /REVIEW_INVENTORY_EVIDENCE_SEALED/);
const racePersistedFindingIds = cancelRace.store.readFindings(storyId).findings.map(row => row.id).sort();
cli(cancelRace.root, 'review_inventory_begin', { storyId });
assert.deepEqual(
  cancelRace.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!.baselineFindingIds,
  racePersistedFindingIds,
  'cancel-vs-finding lock order either rejects the late writer or carries its durable finding into the fresh epoch',
);

const finalizedRecovery = setup();
const recoveryCutoff = finalizedRecovery.handlers.review_inventory_begin({ storyId });
assert.match(recoveryCutoff, /State: OPEN/);
let recoveryData = finalizedRecovery.store.readReviewInventoryEpochs(storyId);
const recoveryEpoch = recoveryData.epochs[0];
const recoveryIssuedAt = new Date().toISOString();
const recoveryReceiptUnsigned = {
  schemaVersion: 'proofbound.review_inventory_receipt.v1' as const,
  receiptId: `${recoveryEpoch.epochId}:RCP-001`, epochId: recoveryEpoch.epochId, storyId,
  reviewRound, cutoff: recoveryEpoch.cutoff, scopeDigest: recoveryEpoch.scopeDigest,
  requiredLanes: recoveryEpoch.requiredLanes, waveCount: 1,
  findingSetDigest: 'f'.repeat(64), coverageDigest: 'e'.repeat(64),
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS' as const,
  authority: 'inventory-completeness-only' as const, authorizesTest: false as const,
  issuedAt: recoveryIssuedAt,
};
const recoveryFinalizedUnsigned = {
  ...recoveryEpoch, state: 'FINALIZED' as const, updatedAt: recoveryIssuedAt,
  receiptId: recoveryReceiptUnsigned.receiptId,
};
delete (recoveryFinalizedUnsigned as Partial<typeof recoveryFinalizedUnsigned>)._hash;
recoveryData.epochs[0] = { ...recoveryFinalizedUnsigned, _hash: signReviewInventoryEpoch(recoveryFinalizedUnsigned) };
recoveryData.receipts.push({ ...recoveryReceiptUnsigned, _hash: signReviewInventoryReceipt(recoveryReceiptUnsigned) });
finalizedRecovery.store.writeReviewInventoryEpochs(storyId, recoveryData);
assert.match(
  cli(finalizedRecovery.root, 'review_inventory_cancel', { storyId, reason: 'genuine late finding requires a fresh signed inventory' }),
  /State: CANCELLED/,
  'F029: operator can signed-invalidate an unconsumed FINALIZED receipt',
);
recoveryData = finalizedRecovery.store.readReviewInventoryEpochs(storyId);
assert.ok(recoveryData.receipts[0].invalidatedAt);
assert.equal(recoveryData.receipts[0].invalidationReason, 'genuine late finding requires a fresh signed inventory');
assert.equal(finalizedUnconsumedReviewInventory(finalizedRecovery.store, storyId), null);
assert.match(cli(finalizedRecovery.root, 'review_inventory_begin', { storyId }), /State: OPEN/);

const carryForward = setup();
const carryLane = 'proof-or-stop-review-concept';
const carrySession = 'sess-inventory-carry-forward';
cli(carryForward.root, 'dispatch', { storyId, agentType: carryLane }, { PROOF_OR_STOP_AGENT: carryLane, PROOF_OR_STOP_SESSION_ID: carrySession });
const carryStarted = cli(carryForward.root, 'review_run_start', { storyId, agent: carryLane }, { PROOF_OR_STOP_AGENT: carryLane, PROOF_OR_STOP_SESSION_ID: carrySession });
const carryRunId = carryStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(carryRunId);
const carryFindingOutput = cli(carryForward.root, 'finding_add', {
  storyId, agent: carryLane, reviewRunId: carryRunId,
  desc: 'Pre-epoch verified finding must survive cancel and begin recovery.',
  severity: 'high', category: 'adversarial', evidenceState: 'verified',
  files: ['packages/main/src/subject.ts'], readManifest, readEvents,
}, { PROOF_OR_STOP_AGENT: carryLane, PROOF_OR_STOP_SESSION_ID: carrySession });
const carryFindingId = carryFindingOutput.match(/(B-inventory-handler:F-\d+)/)?.[1];
assert.ok(carryFindingId);
cli(carryForward.root, 'review_inventory_begin', { storyId });
let carryEpoch = carryForward.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
assert.deepEqual(carryEpoch.baselineFindingIds, [carryFindingId], 'F032: begin signs the current-cutoff/current-round open verified baseline');
assert.ok(carryForward.handlers.review_inventory_status({ storyId }).includes('REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE'));
cli(carryForward.root, 'review_inventory_cancel', { storyId, reason: 'exercise cancellation without losing a verified finding' });
cli(carryForward.root, 'review_inventory_begin', { storyId });
carryEpoch = carryForward.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
assert.deepEqual(carryEpoch.baselineFindingIds, [carryFindingId], 'F032: cancellation/rebegin cannot erase an existing verified finding');

const scopeDrift = setup();
const scopeNow = new Date().toISOString();
scopeDrift.store.writeScopeContract(storyId, {
  storyId, mode: 'enforce',
  allowedModify: ['packages/main/src/subject.ts'], allowedCreate: [],
  allowedTest: ['packages/main/tests/isolated.test.ts'], protectedFiles: [], explicitExcludes: [],
  acknowledgements: [], createdAt: scopeNow, updatedAt: scopeNow,
});
cli(scopeDrift.root, 'review_inventory_begin', { storyId });
cli(scopeDrift.root, 'scope_contract_acknowledge', {
  storyId, paths: ['packages/main/src/consumer-a.ts'],
  reason: 'Expand the frozen review scope for deterministic drift coverage.',
});
const scopeDriftStatus = cli(scopeDrift.root, 'review_inventory_status', { storyId });
assert.match(scopeDriftStatus, /State: INVALIDATED/);
assert.match(scopeDriftStatus, /OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/);
assert.match(
  cli(scopeDrift.root, 'review_inventory_finalize', { storyId }),
  /State: FINALIZED[\s\S]*authorizesTest: false/,
  'F035: begin -> scope acknowledgement invalidates OPEN epoch; finalize then writes PRE_CERT completeness receipt',
);

const acceptanceDrift = setup();
const acceptanceChecklist = acceptanceDrift.store.readChecklist(storyId);
acceptanceChecklist.items[0].verificationEvidence = [{
  kind: 'logic_test',
  intentRef: 'CHK-001:happy:0',
  result: 'pass',
  note: 'Existing passing evidence used by the audited legacy repair path.',
}] as never;
acceptanceDrift.store.writeChecklist(storyId, acceptanceChecklist);
cli(acceptanceDrift.root, 'review_inventory_begin', { storyId });
cli(acceptanceDrift.root, 'verification_intent_repair', {
  storyId,
  mode: 'fromEvidence',
  legacyRepair: true,
  reason: 'Deterministically exercise a supported REVIEW acceptance-semantic writer.',
});
const acceptanceDriftStatus = cli(acceptanceDrift.root, 'review_inventory_status', { storyId });
assert.match(acceptanceDriftStatus, /State: INVALIDATED/);
assert.match(acceptanceDriftStatus, /OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/);
assert.match(
  cli(acceptanceDrift.root, 'review_inventory_finalize', { storyId }),
  /State: FINALIZED[\s\S]*authorizesTest: false/,
  'F037: begin -> verification_intent_repair invalidates OPEN epoch; finalize then writes PRE_CERT completeness receipt',
);

const proofStoryDrift = setup();
seedProofStoryAcceptance(proofStoryDrift.store);
cli(proofStoryDrift.root, 'review_inventory_begin', { storyId });
cli(proofStoryDrift.root, 'scope_shrinkage_decision_set', {
  storyId, decision: 'confirmed', userConfirmed: true,
  withdrawnAcceptanceBindingRefs: ['AB-002'],
  reason: 'Withdraw one acceptance binding after the frozen inventory begins.', approvedBy: 'operator',
});
assert.match(cli(proofStoryDrift.root, 'review_inventory_status', { storyId }), /OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/);
assert.match(
  cli(proofStoryDrift.root, 'review_inventory_finalize', { storyId }),
  /State: FINALIZED[\s\S]*authorizesTest: false/,
  'F042/F044: acceptance-binding withdrawal invalidates OPEN epoch; finalize then writes PRE_CERT completeness receipt',
);

const finalizedProofStoryDrift = setup();
seedProofStoryAcceptance(finalizedProofStoryDrift.store);
cli(finalizedProofStoryDrift.root, 'review_inventory_begin', { storyId });
let finalizedProofData = finalizedProofStoryDrift.store.readReviewInventoryEpochs(storyId);
const finalizedProofEpoch = finalizedProofData.epochs[0];
const finalizedProofAt = new Date().toISOString();
const finalizedProofReceiptUnsigned = {
  schemaVersion: 'proofbound.review_inventory_receipt.v1' as const,
  receiptId: `${finalizedProofEpoch.epochId}:RCP-001`, epochId: finalizedProofEpoch.epochId, storyId,
  reviewRound, cutoff: finalizedProofEpoch.cutoff, scopeDigest: finalizedProofEpoch.scopeDigest,
  requiredLanes: finalizedProofEpoch.requiredLanes, waveCount: 1,
  findingSetDigest: 'f'.repeat(64), coverageDigest: 'e'.repeat(64),
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS' as const,
  authority: 'inventory-completeness-only' as const, authorizesTest: false as const,
  issuedAt: finalizedProofAt,
};
const { _hash: _finalizedProofHash, ...finalizedProofBase } = finalizedProofEpoch;
const finalizedProofUnsigned = {
  ...finalizedProofBase, state: 'FINALIZED' as const, updatedAt: finalizedProofAt,
  receiptId: finalizedProofReceiptUnsigned.receiptId,
};
finalizedProofData.epochs[0] = { ...finalizedProofUnsigned, _hash: signReviewInventoryEpoch(finalizedProofUnsigned) };
finalizedProofData.receipts.push({ ...finalizedProofReceiptUnsigned, _hash: signReviewInventoryReceipt(finalizedProofReceiptUnsigned) });
finalizedProofStoryDrift.store.writeReviewInventoryEpochs(storyId, finalizedProofData);
cli(finalizedProofStoryDrift.root, 'scope_shrinkage_decision_set', {
  storyId, decision: 'confirmed', userConfirmed: true,
  withdrawnAcceptanceBindingRefs: ['AB-002'],
  reason: 'Withdraw one binding after FINALIZED but before receipt consumption.', approvedBy: 'operator',
});
assert.throws(
  () => consumeReviewInventoryReceipt(finalizedProofStoryDrift.store, storyId, reviewRound, finalizedProofEpoch.cutoff),
  /effective ProofStory\/checklist acceptance subject changed/,
  'F042: FINALIZED consumption recomputes the acceptance subject instead of trusting the old receipt',
);

const candidateDrift = setup();
cli(candidateDrift.root, 'candidate_spec_route', { storyId, hosts: false });
cli(candidateDrift.root, 'review_inventory_begin', { storyId });
const candidateBeforeDrift = candidateDrift.store.readCandidateSpecSet(storyId);
assert.ok(candidateBeforeDrift, 'candidate route must persist the initial valid artifact');
assert.ok(candidateBeforeDrift.candidates.length > 0, 'content-drift regression requires a selected candidate row');
const candidateContentDrift = rewriteCandidateArtifact(candidateBeforeDrift, {
  candidates: candidateBeforeDrift.candidates.map((candidate, index) => index === 0
    ? { ...candidate, contentHash: 'f'.repeat(64) }
    : candidate),
});
assert.equal(verifyCandidateSpecSet(candidateContentDrift), true, 'content drift fixture must remain a structurally valid artifact');
candidateDrift.store.writeCandidateSpecSet(storyId, candidateContentDrift);
const candidateDriftStatus = cli(candidateDrift.root, 'review_inventory_status', { storyId });
assert.match(candidateDriftStatus, /State: INVALIDATED/);
assert.match(candidateDriftStatus, /OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION/);
assert.match(
  cli(candidateDrift.root, 'review_inventory_finalize', { storyId }),
  /State: FINALIZED[\s\S]*authorizesTest: false/,
  'F039: selected candidate content drift invalidates OPEN epoch; finalize then writes PRE_CERT completeness receipt',
);

const candidatePathDrift = setup();
cli(candidatePathDrift.root, 'candidate_spec_route', { storyId, hosts: false });
cli(candidatePathDrift.root, 'review_inventory_begin', { storyId });
const candidateBeforePathDrift = candidatePathDrift.store.readCandidateSpecSet(storyId);
assert.ok(candidateBeforePathDrift, 'candidate route must persist the initial artifact before selected-path drift');
assert.ok(candidateBeforePathDrift.candidates.length > 0, 'selected-path drift fixture requires a selected candidate row');
const selectedCandidate = candidateBeforePathDrift.candidates[0]!;
const mutatedSelectedPath = 'docs/requirements/decisions/almanac.md';
assert.ok(!candidateBeforePathDrift.candidateSpecSet.includes(mutatedSelectedPath), 'selected-path drift fixture requires a path outside the initial selected set');
const selectedCandidateBasis = candidateBeforePathDrift.candidateBasis[selectedCandidate.path];
assert.ok(selectedCandidateBasis, 'selected-path drift fixture requires basis evidence for the selected row');
const { [selectedCandidate.path]: _removedBasis, ...remainingCandidateBasis } = candidateBeforePathDrift.candidateBasis;
const candidatePathMutation = rewriteCandidateArtifact(candidateBeforePathDrift, {
  candidates: candidateBeforePathDrift.candidates.map((candidate, index) => index === 0
    ? { ...candidate, path: mutatedSelectedPath }
    : candidate),
  candidateSpecSet: candidateBeforePathDrift.candidateSpecSet.map((path, index) => index === 0 ? mutatedSelectedPath : path),
  candidateBasis: { ...remainingCandidateBasis, [mutatedSelectedPath]: selectedCandidateBasis },
});
assert.equal(verifyCandidateSpecSet(candidatePathMutation), true, 'selected-path mutation fixture must retain a structurally valid recomputed artifact');
candidatePathDrift.store.writeCandidateSpecSet(storyId, candidatePathMutation);
const candidatePathDriftStatus = cli(candidatePathDrift.root, 'review_inventory_status', { storyId });
assert.match(candidatePathDriftStatus, /State: INVALIDATED/);
assert.match(candidatePathDriftStatus, /OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION/);
assert.doesNotMatch(candidatePathDriftStatus, /TypeError/);
console.log('B-8af0 selected path mutation invalidates: PASS');

const candidateOrderNeutral = setup();
cli(candidateOrderNeutral.root, 'candidate_spec_route', { storyId, hosts: false });
cli(candidateOrderNeutral.root, 'review_inventory_begin', { storyId });
const candidateBeforeReorder = candidateOrderNeutral.store.readCandidateSpecSet(storyId);
assert.ok(candidateBeforeReorder, 'candidate route must persist an artifact before the reorder regression');
assert.ok(candidateBeforeReorder.candidates.length >= 2, 'reorder regression requires multiple selected candidate rows');
const candidateReordered = rewriteCandidateArtifact(candidateBeforeReorder, {
  candidates: [...candidateBeforeReorder.candidates].reverse(),
  candidateSpecSet: [...candidateBeforeReorder.candidateSpecSet].reverse(),
});
assert.equal(verifyCandidateSpecSet(candidateReordered), true, 'reordered candidate artifact must retain a valid artifactDigest');
candidateOrderNeutral.store.writeCandidateSpecSet(storyId, candidateReordered);
const candidateOrderNeutralStatus = cli(candidateOrderNeutral.root, 'review_inventory_status', { storyId });
assert.match(candidateOrderNeutralStatus, /State: OPEN/, 'the same selected path/content set in a different order must stay OPEN');
assert.doesNotMatch(candidateOrderNeutralStatus, /OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION/);

// Reconstructed from immutable B-3f3d fixture commit
// 2c9395fa22e18ca40ba3ee47d9d40c2ad748e009. Never apply/pop its originating stash:
// the real intervening branch commit is essential to exercise changedPaths freshness.
const candidateStoryBranchNeutral = setup();
git(candidateStoryBranchNeutral.root, ['checkout', '-b', `story/${storyId}`]);
cli(candidateStoryBranchNeutral.root, 'candidate_spec_route', { storyId, hosts: false });
cli(candidateStoryBranchNeutral.root, 'review_inventory_begin', { storyId });
const runtimeActivityPath = join(candidateStoryBranchNeutral.root, '.proof-or-stop/activity.jsonl');
assert.equal(existsSync(runtimeActivityPath), true, 'candidate route must leave a runtime activity artifact for the routing-neutral branch fixture');
git(candidateStoryBranchNeutral.root, ['add', '.proof-or-stop/activity.jsonl']);
git(candidateStoryBranchNeutral.root, ['commit', '-m', 'unrelated runtime artifact change that moves HEAD and changedPaths']);
assert.notEqual(
  git(candidateStoryBranchNeutral.root, ['diff', '--name-only', 'main...HEAD']),
  '',
  'B-8af0 fixture must produce non-empty changedPaths on a story branch',
);
cli(candidateStoryBranchNeutral.root, 'candidate_spec_route', { storyId, hosts: false });
const candidateStoryBranchNeutralStatus = cli(candidateStoryBranchNeutral.root, 'review_inventory_status', { storyId });
assert.match(candidateStoryBranchNeutralStatus, /State: OPEN/, 'routing-neutral re-route after an unrelated branch commit must stay OPEN');
assert.doesNotMatch(candidateStoryBranchNeutralStatus, /OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION/);
console.log('B-8af0 canonical candidate-order OPEN: PASS');
console.log('B-8af0 candidate content-or-selection drift: PASS');
console.log('B-8af0 canonical barrier real-handler discriminates order: PASS');
console.log('B-8af0 story-branch routing-neutral OPEN: PASS');
console.log('B-8af0 routing-neutral positive OPEN state: PASS');
console.log('B-8af0 immutable story-branch fixture: PASS');

for (const [label, malformedCandidates] of [
  ['string', 'not-an-array'],
  ['object', { path: 'not-an-array' }],
] as const) {
  const malformedCandidate = setup();
  cli(malformedCandidate.root, 'candidate_spec_route', { storyId, hosts: false });
  cli(malformedCandidate.root, 'review_inventory_begin', { storyId });
  const artifact = malformedCandidate.store.readCandidateSpecSet(storyId);
  assert.ok(artifact, `candidate route must persist an artifact before malformed ${label} injection`);
  const { artifactDigest: _staleArtifactDigest, ...validBase } = artifact;
  const malformedBase = {
    ...validBase,
    candidates: malformedCandidates,
  };
  // A stale digest is already rejected by the legacy integrity check. Recompute
  // it so this proves the structural candidates guard remains fail-closed even
  // when an attacker supplies a signed-looking replacement artifact.
  const signedMalformedArtifact = {
    ...malformedBase,
    artifactDigest: digestCandidateRoutingValue(malformedBase),
  } as unknown as CandidateSpecSetArtifact;
  assert.equal(verifyCandidateSpecSet(signedMalformedArtifact), false, `malformed ${label} candidates must fail structural verification even with a recomputed artifactDigest`);
  malformedCandidate.store.writeCandidateSpecSet(storyId, signedMalformedArtifact);
  const malformedStatus = cli(malformedCandidate.root, 'review_inventory_status', { storyId });
  assert.match(malformedStatus, /State: INVALIDATED/, `malformed ${label} candidates must invalidate the OPEN epoch`);
  assert.match(malformedStatus, /OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT/);
  assert.doesNotMatch(malformedStatus, /TypeError/, `malformed ${label} candidates must fail closed without a raw TypeError`);
}
console.log('B-8af0 malformed candidates fail closed: PASS');
console.log('B-8af0 malformed candidate variants deterministic: PASS');
console.log('B-8af0 malformed candidate structural guard: PASS');

for (const [label, malformedCandidates] of [
  ['string', 'not-an-array'],
  ['object', { path: 'not-an-array' }],
] as const) {
  const malformedBeforeBegin = setup();
  cli(malformedBeforeBegin.root, 'candidate_spec_route', { storyId, hosts: false });
  const artifact = malformedBeforeBegin.store.readCandidateSpecSet(storyId);
  assert.ok(artifact, `candidate route must persist an artifact before pre-begin malformed ${label} injection`);
  const { artifactDigest: _staleArtifactDigest, ...validBase } = artifact;
  const malformedBase = { ...validBase, candidates: malformedCandidates };
  const signedMalformedArtifact = {
    ...malformedBase,
    artifactDigest: digestCandidateRoutingValue(malformedBase),
  } as unknown as CandidateSpecSetArtifact;
  assert.equal(verifyCandidateSpecSet(signedMalformedArtifact), false, `pre-begin malformed ${label} candidates must fail structural verification despite a recomputed artifactDigest`);
  malformedBeforeBegin.store.writeCandidateSpecSet(storyId, signedMalformedArtifact);
  const beginStatus = cli(malformedBeforeBegin.root, 'review_inventory_begin', { storyId });
  assert.match(beginStatus, /State: INVALIDATED/, `pre-begin malformed ${label} candidates must never sign an OPEN inventory epoch`);
  assert.doesNotMatch(beginStatus, /State: OPEN/);
  assert.match(beginStatus, /OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT/);
  assert.match(beginStatus, /Invalid candidate routing artifact: persisted candidate-spec-set\.json failed structural and artifactDigest verification\./);
  assert.doesNotMatch(beginStatus, /TypeError/);
  const persistedStatus = cli(malformedBeforeBegin.root, 'review_inventory_status', { storyId });
  assert.match(persistedStatus, /State: INVALIDATED/, `pre-begin malformed ${label} invalidation must persist atomically`);
  assert.match(persistedStatus, /OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT/);
}
console.log('B-8af0 pre-begin malformed candidates fail closed: PASS');

const staleDigestContentTamper = setup();
cli(staleDigestContentTamper.root, 'candidate_spec_route', { storyId, hosts: false });
cli(staleDigestContentTamper.root, 'review_inventory_begin', { storyId });
const validArtifactBeforeTamper = staleDigestContentTamper.store.readCandidateSpecSet(storyId);
assert.ok(validArtifactBeforeTamper, 'candidate route must persist a valid-shape artifact before stale-digest content tampering');
assert.equal(verifyCandidateSpecSet(validArtifactBeforeTamper), true, 'stale-digest handler fixture must start from a valid routed artifact');
assert.ok(validArtifactBeforeTamper.candidates.length > 0, 'stale-digest handler fixture requires a selected candidate row');
const staleDigestContentTamperedArtifact = {
  ...validArtifactBeforeTamper,
  candidates: validArtifactBeforeTamper.candidates.map((candidate, index) => index === 0
    ? { ...candidate, contentHash: 'e'.repeat(64) }
    : candidate),
};
staleDigestContentTamper.store.writeCandidateSpecSet(storyId, staleDigestContentTamperedArtifact);
const staleDigestContentTamperStatus = cli(staleDigestContentTamper.root, 'review_inventory_status', { storyId });
assert.match(staleDigestContentTamperStatus, /State: INVALIDATED/);
assert.match(staleDigestContentTamperStatus, /OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT/);
assert.match(staleDigestContentTamperStatus, /Invalid candidate routing artifact: persisted candidate-spec-set\.json failed structural and artifactDigest verification\./);
assert.doesNotMatch(staleDigestContentTamperStatus, /TypeError/);
console.log('B-8af0 handler artifactDigest tamper fail closed: PASS');

const publicationRace = setup();
cli(publicationRace.root, 'review_inventory_begin', { storyId });
const publicationLane = 'proof-or-stop-review-concept';
const publicationSession = 'sess-review-run-publication-race';
cli(publicationRace.root, 'dispatch', { storyId, agentType: publicationLane }, {
  PROOF_OR_STOP_AGENT: publicationLane, PROOF_OR_STOP_SESSION_ID: publicationSession,
});
const publicationReady = join(publicationRace.root, 'review-run-publication.ready');
const runPublication = cliAsync(publicationRace.root, 'review_run_start', { storyId, agent: publicationLane }, {
  PROOF_OR_STOP_AGENT: publicationLane,
  PROOF_OR_STOP_SESSION_ID: publicationSession,
  NODE_ENV: 'test',
  LATTICE_INTERNAL_REVIEW_RUN_HOLD_MS: '1000',
  LATTICE_INTERNAL_REVIEW_RUN_READY_FILE: publicationReady,
});
waitForFile(publicationReady);
const cancelPublication = cliAsync(publicationRace.root, 'review_inventory_cancel', {
  storyId, reason: 'Cancel concurrently with a ReviewRun publication linearization test.',
});
const [publishedRun, publishedCancel] = await Promise.all([runPublication, cancelPublication]);
assert.equal(publishedRun.ok, true, publishedRun.output);
assert.equal(publishedCancel.ok, true, publishedCancel.output);
const publishedRunId = publishedRun.output.match(/Review run (\S+) started/)?.[1];
assert.ok(publishedRunId, publishedRun.output);
assert.throws(
  () => cli(publicationRace.root, 'review_pass_set', {
    storyId, agent: publicationLane, reviewRunId: publishedRunId,
    note: 'A run published before cancel must remain sealed by cancel.', readManifest, readEvents,
  }, { PROOF_OR_STOP_AGENT: publicationLane, PROOF_OR_STOP_SESSION_ID: publicationSession }),
  /REVIEW_INVENTORY_EVIDENCE_SEALED/,
  'F038: cancel cannot fall between inventory precheck and RR durable publication',
);

const longHolder = setup();
const longLanes = ['proof-or-stop-review-concept', 'proof-or-stop-review-quality'];
const longRuns = new Map<string, { reviewRunId: string; sessionId: string }>();
for (const lane of longLanes) {
  const sessionId = `sess-long-holder-${lane}`;
  cli(longHolder.root, 'dispatch', { storyId, agentType: lane }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
  const started = cli(longHolder.root, 'review_run_start', { storyId, agent: lane }, { PROOF_OR_STOP_AGENT: lane, PROOF_OR_STOP_SESSION_ID: sessionId });
  longRuns.set(lane, { reviewRunId: started.match(/Review run (\S+) started/)![1], sessionId });
}
const readyFile = join(longHolder.root, 'long-review-pass.ready');
const firstLong = longRuns.get(longLanes[0])!;
const secondLong = longRuns.get(longLanes[1])!;
const longHolderStartedAt = Date.now();
const firstLongPromise = cliAsync(longHolder.root, 'review_pass_set', {
  storyId, agent: longLanes[0], reviewRunId: firstLong.reviewRunId,
  note: 'Long live-holder pass remains authoritative beyond ten seconds.', readManifest, readEvents,
}, {
  PROOF_OR_STOP_AGENT: longLanes[0], PROOF_OR_STOP_SESSION_ID: firstLong.sessionId, NODE_ENV: 'test',
  LATTICE_INTERNAL_REVIEW_PASS_HOLD_MS: '11000',
  LATTICE_INTERNAL_REVIEW_PASS_READY_FILE: readyFile,
});
waitForFile(readyFile);
const secondLongPromise = cliAsync(longHolder.root, 'review_pass_set', {
  storyId, agent: longLanes[1], reviewRunId: secondLong.reviewRunId,
  note: 'Concurrent waiter must not reclaim a live review-pass lock.', readManifest, readEvents,
}, { PROOF_OR_STOP_AGENT: longLanes[1], PROOF_OR_STOP_SESSION_ID: secondLong.sessionId, NODE_ENV: 'test' });
const [firstLongResult, secondLongResult] = await Promise.all([firstLongPromise, secondLongPromise]);
assert.equal(firstLongResult.ok, true, firstLongResult.output);
assert.equal(secondLongResult.ok, true, secondLongResult.output);
assert.ok(Date.now() - longHolderStartedAt >= 10_500, 'F036 stress must actually cross the historical 10s stale threshold');
const durableLongPasses = longHolder.store.readReviewPasses(storyId).passes
  .filter(row => longLanes.includes(row.agent));
assert.equal(durableLongPasses.length, 2, 'F036: >10s live holder preserves both concurrent signed passes');
assert.equal(new Set(durableLongPasses.map(row => row.id)).size, 2, 'F036: atomic RMW assigns unique durable pass IDs');

const drifted = setup();
cli(drifted.root, 'review_inventory_begin', { storyId });
writeFileSync(join(drifted.root, 'packages/main/src/subject.ts'), 'export const subject = 2;\n');
git(drifted.root, ['add', 'packages/main/src/subject.ts']);
git(drifted.root, ['commit', '-m', 'mutate frozen review material']);
assert.throws(
  () => cli(drifted.root, 'review_inventory_wave_advance', { storyId }),
  /OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION|State: INVALIDATED/,
  'real wave_advance detects frozen-cutoff drift before admission',
);
const driftedData = drifted.store.readReviewInventoryEpochs(storyId);
assert.equal(driftedData.epochs[0].state, 'INVALIDATED', 'drift persists only the intentional invalidation');
assert.equal(driftedData.epochs[0].waves.length, 0, 'drift rejection never persists a wave');
assert.equal(driftedData.receipts.length, 0, 'drift rejection never mints a receipt');
assert.match(
  drifted.handlers.review_inventory_finalize({ storyId }),
  /State: FINALIZED[\s\S]*authorizesTest: false/,
  'material-drift INVALIDATED epoch: finalize writes PRE_CERT completeness receipt instead of throwing',
);

const unsupported = setup();
const unsupportedBegin = unsupported.handlers.review_inventory_begin({ storyId });
const unsupportedEpoch = unsupported.store.readReviewInventoryEpochs(storyId).epochs[0];
const before = JSON.stringify(unsupported.store.readReviewInventoryEpochs(storyId));
assert.throws(() => unsupported.handlers.review_inventory_critic_set({
  storyId, epochId: unsupportedEpoch.epochId, reviewRunId: 'unsupported-run',
  agent: 'proof-or-stop-review-topology-critic', findingDispositions: [],
}), /only proof-or-stop-review-topology-critic|agent_dispatch_mutation_denied|LANES_INCOMPLETE/);
assert.equal(JSON.stringify(unsupported.store.readReviewInventoryEpochs(storyId)), before, 'rejected critic mutation is side-effect free');
assert.match(unsupportedBegin, /Next: proof-or-stop review_inventory_status/);

console.log('review inventory real handler smoke: PASS');
