import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../../core/config.js';

import { currentGitHead } from '../../core/evidence-freshness.js';
import { persistSyntheticAdmittedWindowForTest as persistSyntheticWindow } from '../../core/certification-window.js';
import { deriveCertificationDomainInputHashes } from '../../handlers/certification-window.js';

import { signFinding, signReviewPass } from '../../core/finding-verify.js';

import { hashReviewPrompt } from '../../core/review-run.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION, resolvePromptRoleBody } from '../../core/prompt-role-contract-registry.js';
import { CURRENT_PROMPT_IDENTITIES, domainSeparatedDigest } from '../../core/prompt-contracts.js';

import { StoryStore } from '../../core/store.js';
import type { ChecklistData, Finding, ReviewRun, StoryInfo } from '../../core/types.js';

import { createStoryDispatchHandlers } from '../../handlers/story-dispatch.js';
import { createMainRegistry } from '../../registry.js';
import {
  issueBrokeredNativeReviewBinding,
  nativeReviewFixtureBrokers,
  withNativeReviewFixtureHostIdentity,
} from '../native-review-fixture.js';
import { createReviewRunHandlers } from '../../handlers/review-run.js';

export const ORIGINAL_TASKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function persistSyntheticAdmittedWindowForTest(args: Parameters<typeof persistSyntheticWindow>[0]) {
  return persistSyntheticWindow({ ...args, causalInputHashes: deriveCertificationDomainInputHashes(args.gitCwd ?? args.projectRoot, 'HEAD', args.projectRoot) });
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function writeAcceptanceBasisDiscoveryFixture(root: string): void {
  // Explicit synthetic discovery dependencies required by the current registry;
  // these are not executed and do not claim production runtime coverage.
  for (const file of ["bin/bootstrap-runner.js", "packages/main/src/cli-engine.ts", "packages/main/src/core/auto-commit-metadata.ts", "packages/main/src/core/causal-evidence.ts", "packages/main/src/core/execution-implementation.ts", "packages/main/src/core/store.ts", "packages/main/src/core/verification-intent-amendment.ts", "packages/main/src/core/verification-intent-checkpoint.ts", "packages/main/src/handlers/done-required-validation.ts", "packages/main/src/tasks/quorum-submit-smoke-case-catalog.ts", "packages/main/src/tasks/quorum-submit-smoke-fixture.ts", "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts", "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts", "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts", "packages/main/src/tasks/quorum-submit-smoke-worker.ts", "packages/main/src/tasks/quorum-submit-smoke.ts", "scripts/build-lock-target.mjs"]) {
    write(root, file, 'export const fixtureDependency = true;\n');
  }
  // Current registered source snapshots, not execution evidence for these modules.
  for (const file of ["packages/graph/src/core/app.ts", "packages/graph/src/shells/web/app.js", "packages/main/src/core/host-execution-readiness.ts", "packages/main/src/core/managed-execution-identity-key.ts", "packages/main/src/core/managed-execution-input-identity.ts", "packages/main/src/core/managed-launch-admission.ts", "packages/main/src/core/managed-run-dashboard.ts", "packages/main/src/core/prompt-contracts.ts", "packages/main/src/core/prompt-envelope.ts", "packages/main/src/core/review-run.ts", "packages/main/src/core/reviewer-batch-admission.ts", "packages/main/src/core/reviewer-batch-producer.ts", "packages/main/src/core/reviewer-batch-subject.ts", "packages/main/src/handlers/graph.ts", "packages/main/src/handlers/reviewer-batch-admit.ts"]) {
    if (!existsSync(join(root, file))) write(root, file, "export const fixtureDependency = true;\n");
  }

  // Current registered producer/consumer snapshots must exist even though this
  // fixture isolates discovery and does not execute those dependency modules.
  for (const name of ['scope-inventory-budget', 'evidence-freshness', 'material-path-policy', 'review-convergence',
    'shared-validation-execution', 'story-aware-validation', 'story-owner-lease', 'validation-execution-lock',
    'acceptance-amendment-journal', 'convergence-progress-gate', 'convergence-progress-journal',
    'host-run', 'planned-steps-executor', 'proof-or-stop-dispatch', 'provider-process-admission',
    'provider-process-registry', 'story-scope-budget', 'story-scope-budget-decisions', 'story-scope-decomposition',
    'managed-host-run', 'managed-review-lane-policy', 'managed-review-lane',
    'managed-review-provider-state', 'managed-review-readonly', 'story-scope-budget-legacy']) {
    write(root, `packages/main/src/core/${name}.ts`, 'export const fixtureDependency = true;\n');
  }
  for (const path of ['handlers/story-review', 'handlers/cross-host-review', 'providers/supervised-process', 'providers/supervised-process-worker']) {
    write(root, `packages/main/src/${path}.ts`, 'export const fixtureDependency = true;\n');
  }
  write(root, 'packages/main/src/core/managed-review-lane-build.mjs', 'export const fixtureDependency = true;\n');
  write(root, 'packages/main/src/cli/command-catalog.ts', [
    'export const MAIN_TOOLS = [',
    "  { name: 'acceptance_basis' },",
    "  { name: 'acceptance_basis_generate' },",
    "  { name: 'acceptance_topology_check' },",
    "  { name: 'pre_review_check' },",
    "  { name: 'pre_review_check_read' },",
    '];',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/registry.ts', [
    "import { createProofStoryHandlers } from './handlers/proofstory.js';",
    'const registry = { registerBatch: (_handlers: unknown) => undefined };',
    'const ctx = {};',
    'registry.registerBatch(createProofStoryHandlers(ctx));',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/handlers/proofstory.ts', [
    'export function createProofStoryHandlers() {',
    '  return {',
    '    acceptance_basis() { return true; },',
    '    acceptance_basis_generate() { return true; },',
    '    acceptance_topology_check() { return true; },',
    '    pre_review_check() { return true; },',
    '    pre_review_check_read() { return true; },',
    '  };',
    '}',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/core/process-fact-registry.ts', 'export const acceptance_basis_generate = "acceptance_basis read-only receipt verification and diagnostic rendering boundary";\n');
  write(root, 'packages/main/src/core/acceptance-topology.ts', 'export const acceptanceTopology = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/machine.ts', 'export const machine = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/review-inventory-epoch.ts', 'export const reviewInventoryEpoch = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/handlers/review-inventory.ts', 'export const reviewInventory = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/agent-dispatch-registry.ts', 'export const agentDispatchRegistry = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/pre-review-check.ts', 'export const preReviewCheck = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/pre-review-live-proof.ts', 'export const preReviewLiveProof = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'scripts/run-proofstory-pre-review-live-proof.mjs', 'export const preReviewLiveProofRunner = true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCriticReceipt = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts', 'export const planConsumer = "acceptance_basis_generate";\n');
  write(root, 'scripts/verify-process-fact-contract.mjs', 'export const acceptance_basis_generate = "acceptance_basis read-only receipt verification and diagnostic rendering boundary";\n');
  write(root, 'packages/main/src/core/acceptance-rollout.ts', 'export const acceptanceRollout = "acceptance_rollout_report verifier-owned signed flat-project rollout report";\n');
  write(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'export const acceptanceRolloutCohortRunner = true;\n');
  // F090: registered runtime source refs are physical snapshot inputs even
  // when this fixture exercises only the acceptance-basis command paths.
  // Empty test modules supply those inputs without inventing extra call edges.
  for (const path of [
    'packages/main/src/core/evidence-freshness.ts',
    'packages/main/src/core/lifecycle-readiness.ts',
    'packages/main/src/core/material-path-policy.ts',
    'packages/main/src/core/proof-admissibility.ts',
    'packages/main/src/core/shared-validation-execution.ts',
    'packages/main/src/core/story-aware-validation.ts',
    'packages/main/src/core/story-owner-lease.ts',
    'packages/main/src/core/validation-execution-lock.ts',
    'packages/main/src/core/verification-execution-evidence.ts',
    'packages/main/src/core/verification.ts',
    'packages/main/src/handlers/certification-window.ts',
    'packages/main/src/handlers/checklist.ts',
    'packages/main/src/handlers/done-prepare.ts',
    'packages/main/src/handlers/phase-gates.ts',
    'packages/main/src/handlers/verifier.ts',
  ]) write(root, path, 'export {};\n');
}

export function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

export function localCliPath(): string {
  return resolve(ORIGINAL_TASKS_DIR, '..', 'cli.js');
}

export const nativeReviewFixtureContexts = new Map<string, { root: string; store: StoryStore }>();

export function registerNativeReviewFixtureContexts(
  root: string,
  store: StoryStore,
  storyId: string,
  runs: ReviewRun[],
): void {
  const registry = createMainRegistry({ root, store, scanRoot: join(root, 'packages/main') });
  const dispatch = registry.get('dispatch');
  assert.ok(dispatch, 'flow native review fixture dispatch handler is registered');
  for (const agent of new Set(runs.map(run => run.agent))) {
    withNativeReviewFixtureHostIdentity({
      agent,
      invoke: () => dispatch({ storyId, agentType: agent }),
    });
  }
  for (const run of runs) {
    nativeReviewFixtureContexts.set(`${storyId}\0${run.agent}\0${run.reviewRunId}`, { root, store });
  }
}

export function fixtureNativeBinding(storyId: string, agent: string, reviewRunId: string) {
  const context = nativeReviewFixtureContexts.get(`${storyId}\0${agent}\0${reviewRunId}`)
    ?? [...nativeReviewFixtureContexts].find(([key]) => key.startsWith(`${storyId}\0${agent}\0`))?.[1];
  if (!context || !existsSync(context.root)) return undefined;
  return issueBrokeredNativeReviewBinding({ ...context, storyId, agent, reviewRunId });
}

export function makeFinding(storyId: string, agent: string, reviewRound: string, idSuffix: string, reviewRunId: string): Finding {
  const id = `${storyId}:F-${idSuffix}`;
  const createdAt = new Date(Date.UTC(2099, 3, 27, 12, 0, Number(idSuffix))).toISOString();
  const desc = `${agent} clean finding`;
  const severity = 'low';
  const nativeEvidenceBinding = fixtureNativeBinding(storyId, agent, reviewRunId);
  return {
    id,
    desc,
    severity,
    category: 'happy',
    status: 'resolved',
    agent,
    createdAt,
    reviewRound,
    reviewRunId,
    ...(nativeEvidenceBinding ? { nativeEvidenceBinding } : {}),
    _hash: signFinding(
      storyId,
      id,
      desc,
      severity,
      createdAt,
      reviewRound,
      reviewRunId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      nativeEvidenceBinding,
      nativeEvidenceBinding ? {
        category: 'happy',
        evidenceState: null,
        uncertaintyReason: null,
        files: [],
      } : undefined,
    ),
  };
}

export const reviewEnvelopeIds = new Map<string, string>();

export function makeLegacyFindingWithoutRun(storyId: string, agent: string, reviewRound: string, idSuffix: string): Finding {
  const id = `${storyId}:F-${idSuffix}`;
  const createdAt = `2026-04-27T12:05:${idSuffix}.000Z`;
  const desc = `${agent} legacy finding without review run binding`;
  const severity = 'low';
  return {
    id,
    desc,
    severity,
    category: 'happy',
    status: 'resolved',
    agent,
    createdAt,
    reviewRound,
    _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound),
  };
}

export function makeReviewPass(storyId: string, agent: string, reviewRound: string, idSuffix: string, reviewRunId: string) {
  const id = `${storyId}:RP-${idSuffix}`;
  const createdAt = new Date(Date.UTC(2099, 3, 27, 12, 10, Number(idSuffix))).toISOString();
  const note = `${agent} checked the story and found no blocking issue`;
  const nativeEvidenceBinding = fixtureNativeBinding(storyId, agent, reviewRunId);
  const provenance = nativeEvidenceBinding ? {
    writerSessionId: nativeEvidenceBinding.writerSessionId,
    sessionSource: nativeEvidenceBinding.sessionSource,
  } : undefined;
  const envelopeId = reviewEnvelopeIds.get(reviewRunId) ?? reviewRunId;
  return {
    id,
    agent,
    note,
    createdAt,
    reviewRound,
    reviewRunId,
    ...(nativeEvidenceBinding ? {
      nativeEvidenceBinding,
      writerSessionId: nativeEvidenceBinding.writerSessionId,
      sessionSource: nativeEvidenceBinding.sessionSource,
    } : {}),
    envelopeId,
    _hash: signReviewPass(
      storyId,
      id,
      agent,
      note,
      createdAt,
      reviewRound,
      reviewRunId,
      undefined,
      undefined,
      undefined,
      provenance,
      envelopeId,
      undefined,
      nativeEvidenceBinding,
    ),
  };
}

export function makeLegacyReviewPassWithoutRun(storyId: string, agent: string, reviewRound: string, idSuffix: string) {
  const id = `${storyId}:RP-${idSuffix}`;
  const createdAt = `2026-04-27T12:20:${idSuffix}.000Z`;
  const note = `${agent} legacy pass without review run binding`;
  return {
    id,
    agent,
    note,
    createdAt,
    reviewRound,
    _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound),
  };
}

export function seedReviewRuns(root: string, store: StoryStore, storyId: string, reviewRound: string, agents: string[]): Map<string, string> {
  if (!currentGitHead(root)) {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'review-seed@example.test']);
    git(root, ['config', 'user.name', 'review-seed-smoke']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'review seed baseline']);
  }
  const context = { store, root, scanRoot: join(root, 'packages/main') };
  const dispatchHandlers = createStoryDispatchHandlers(context);
  const reviewRunHandlers = createReviewRunHandlers(context);
  const result = new Map<string, string>();
  for (const agent of agents) {
    withNativeReviewFixtureHostIdentity({ agent: agent, invoke: () => dispatchHandlers.dispatch({ storyId, agentType: agent }) });
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    const previousCwd = process.cwd();
    process.env.PROOF_OR_STOP_AGENT = agent;
    process.chdir(root);
    try {
      withNativeReviewFixtureHostIdentity({ agent: agent, invoke: () => reviewRunHandlers.review_run_start({ storyId, agent }) });
    } finally {
      process.chdir(previousCwd);
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
    }
    const run = [...store.readReviewRuns(storyId).runs].reverse().find(candidate => candidate.agent === agent);
    assert.ok(run, `production review_run_start should persist ${agent}`);
    assert.equal(run.reviewRound, reviewRound);
    assert.ok(run.envelopeId, `production review run for ${agent} should bind a Prompt Envelope`);
    reviewEnvelopeIds.set(run.reviewRunId, run.envelopeId);
    nativeReviewFixtureContexts.set(`${storyId}\0${agent}\0${run.reviewRunId}`, { root, store });
    result.set(agent, run.reviewRunId);
  }
  for (const run of store.readReviewRuns(storyId).runs) { nativeReviewFixtureContexts.set(`${storyId}\0${run.agent}\0${run.reviewRunId}`, { root, store }); }
  return result;
}

export function legacyPromptHash(agent: string): string {
  return hashReviewPrompt(resolvePromptRoleBody(agent, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [agent]: 'full-envelope' },
  }).body);
}

export function currentPromptEnvelopeBinding(agent: string, envelopeId: string): {
  assembledPrompt: string;
  promptHash: string;
  envelopeId: string;
} {
  const assembledPrompt = [
    JSON.stringify({ schemaVersion: CURRENT_PROMPT_IDENTITIES.roleContract, agent }),
    JSON.stringify({ schemaVersion: CURRENT_PROMPT_IDENTITIES.fullTaskContext }),
    JSON.stringify({ schemaVersion: CURRENT_PROMPT_IDENTITIES.knownExecutionEnvironment }),
  ].join('\n');
  return {
    assembledPrompt,
    promptHash: domainSeparatedDigest('assembled-prompt.raw-utf8.v1', assembledPrompt),
    envelopeId,
  };
}

export function createReviewStore(root: string): { store: StoryStore; storyId: string; reviewRound: string } {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
  }));
  resetConfigCache();

  write(root, 'README.md', 'flow review fixture\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'flow-review@example.invalid']);
  git(root, ['config', 'user.name', 'Flow Review Fixture']);
  // B-137a main-merge fix: the fixture writes proof-or-stop.config.json (above),
  // so staging the retired filename failed with 'did not match any files'.
  git(root, ['add', 'proof-or-stop.config.json', 'README.md']);
  git(root, ['commit', '-m', 'fixture']);

  const store = new StoryStore(root);
  const storyId = 'B-smoke';
  const now = '2026-04-27T12:00:00.000Z';
  const reviewRound = '2026-04-27T12:01:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'flow-stability-smoke',
    title: 'Flow stability smoke',
    description: 'Synthetic story for REVIEW gate smoke coverage.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  const checklist: ChecklistData = {
    items: ['001', '002', '003'].map((suffix) => ({
      id: `CHK-${suffix}`,
      title: `Done item ${suffix}`,
      context: 'Synthetic checklist item.',
      verificationIntent: { happy: [{ desc: 'The reviewer gate reports the required lane and current signed run binding.', type: 'manual' as const }], edge: [], adversarial: [] },
      // Synthetic prerequisite only: each test below still executes its real lane/run assertions.
      verificationEvidence: [{ intentRef: `CHK-${suffix}:happy:0`, kind: 'manual_transcript' as const, result: 'pass' as const, note: 'Synthetic acceptance prerequisite for the isolated reviewer gate fixture; this is not a product verification receipt.' }],
      status: 'done',
      startTime: now,
      endTime: now,
    })),
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Check review gate',
    outcome: 'Review gate reports opt-in reviewers',
    facts: [],
    constraints: [],
    unknowns: [],
    touchpoints: ['packages/main/src/core/machine.ts'],
    timestamp: now,
  });
  store.writeDecision(storyId, {
    principles: ['keep gates explicit', 'reuse reviewer routing', 'avoid fixture state leakage'],
    drivers: ['normal channel smoke coverage'],
    options: [
      { name: 'A: shared reviewer routing', pros: ['matches reviewer_list'], cons: ['requires signed fixtures'] },
      { name: 'B: local copy', pros: ['simple'], cons: ['drifts from reviewer_list'] },
    ],
    chosen: 'A: shared reviewer routing',
    rationale: 'normal channel requires multiple real options in the smoke fixture',
    timestamp: now,
  });
  return { store, storyId, reviewRound };
}
