#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache, resolveAcceptanceTopologyGateMode } from '../core/config.js';
import { buildAcceptanceMatrixReport } from '../core/acceptance-topology.js';
import { derivePlannedCoveragePaths, reconcileTopologyWithCoverageBasis } from '../core/acceptance-coverage-basis.js';
import { PROCESS_FACT_REGISTRY } from '../core/process-fact-registry.js';
import { StoryStore } from '../core/store.js';
import { evaluateAcceptanceTopologyForContext } from '../handlers/proofstory.js';
import type { HandlerContext } from '../handlers/context.js';
import type {
  AcceptanceVerificationTopologyV1,
  ChecklistData,
  ProofStoryContractData,
  ScopeCheckData,
  ScopeContractData,
  StoryInfo,
} from '../core/types.js';
import { signScopeCheck } from '../handlers/scope-check.js';
import { canStartDevGuard, createStoryActor, evaluateDevMemoryPreflightGate, getGuardFailureReason } from '../core/machine.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const repositoryRoot = resolve(packageRoot, '../../..');
const storyId = 'B-topology-gate-smoke';
const now = '2026-07-22T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function bytes(root: string, rel: string): string {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : '<missing>';
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function invoke(root: string, command: string, args: Record<string, unknown>): { status: number; output: string } {
  const result = spawnSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
    cwd: root,
    env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'topology-gate-smoke', PROOF_OR_STOP_AGENT: 'proof-or-stop-implementer' },
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return { status: result.status ?? 1, output };
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  const result = invoke(root, command, args);
  if (!allowFailure && result.status !== 0) throw new Error(result.output);
  return result.output;
}

function config(mode: 'observe' | 'warn' | 'enforce'): string {
  return JSON.stringify({
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests', fixturesDir: 'packages/main/tests/fixtures',
    // The pre-existing ProofStory DEV gate remains enforce here on purpose:
    // Wave 2 rollout must be controlled only by its independent field.
    proofStory: { devGateMode: 'enforce', acceptanceTopologyGateMode: mode },
  }, null, 2);
}

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-TOPOLOGY', relation: 'producer_to_consumer' as const,
  producer: {
    id: 'EP-P', role: 'producer' as const, expectedArtifactKind: 'handler' as const,
    expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produce',
    fileDeclarationRef: 'CHK-001:files:create:0',
  },
  consumers: [{
    id: 'EP-C', role: 'consumer' as const, expectedArtifactKind: 'process_fact' as const,
    expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'consume',
    fileDeclarationRef: 'CHK-001:files:create:1',
  }],
  outputFactRef: 'process-fact:topology-smoke',
};

function topology(): AcceptanceVerificationTopologyV1 {
  return {
    schemaVersion: 'proofstory.acceptance_topology.v1',
    producerRefs: [{ id: 'P', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-TOPOLOGY:VPP-TOPOLOGY', endpointRef: 'EP-P' } }],
    consumerRefs: [{ id: 'C', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-TOPOLOGY:VPP-TOPOLOGY', endpointRef: 'EP-C' }, producerRefs: ['P'] }],
    positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-TOPOLOGY' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    mutationCaseRefs: [{ id: 'M', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-TOPOLOGY' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    transcriptAssertionRefs: [{ id: 'T', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-TOPOLOGY' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    commandRefs: [
      { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis' },
      { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
      { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
      { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
    ],
  };
}

function checklist(): ChecklistData {
  return { items: [{
    id: 'CHK-001', title: 'topology', context: 'focused smoke', status: 'pending', startTime: null, endTime: null,
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: {
      happy: [{ id: 'INT-TOPOLOGY', desc: 'producer reaches consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [structuredClone(declaration)] }],
      edge: [], adversarial: [],
    },
  }] };
}

function contract(value = topology()): ProofStoryContractData {
  return {
    schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-TOPOLOGY', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-TOPOLOGY'], milestoneIds: [], verificationTopology: value }],
    diagnosticGaps: [], createdAt: now, updatedAt: now,
  };
}

function scopeContract(): ScopeContractData {
  return {
    storyId, mode: 'local', allowedModify: ['packages/main/src/handlers/proofstory.ts'],
    allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [],
    protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: now, updatedAt: now,
  };
}

function scopeCheck(root: string): ScopeCheckData {
  const base = {
    storyId, checkedAt: now, reviewRound: '', agentId: 'proof-or-stop-review-scope-plan', issues: [], features: [],
    summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 },
  } as unknown as ScopeCheckData;
  const previous = process.cwd();
  process.chdir(root);
  try { return { ...base, _hash: signScopeCheck(storyId, now, 0, 1, '') }; }
  finally { process.chdir(previous); }
}

function writeDiscoveryRegistration(root: string): void {
  write(root, 'packages/main/src/cli/command-catalog.ts', [
    'export const MAIN_TOOLS = [',
    "  { name: 'acceptance_basis' },",
    "  { name: 'acceptance_basis_generate' },",
    "  { name: 'acceptance_topology_check' },",
    '];', '',
  ].join('\n'));
  write(root, 'packages/main/src/registry.ts', [
    "import { createProofStoryHandlers } from './handlers/proofstory.js';",
    'const registry = { registerBatch: (_handlers: unknown) => undefined };',
    'const ctx = {};',
    'registry.registerBatch(createProofStoryHandlers(ctx));', '',
  ].join('\n'));
  write(root, 'packages/main/src/handlers/proofstory.ts', [
    'export function createProofStoryHandlers() { return {',
    '  acceptance_basis() { return true; },',
    '  acceptance_basis_generate() { return true; },',
    '  acceptance_topology_check() { return true; },',
    '}; }', '',
  ].join('\n'));
  write(root, 'packages/main/src/core/process-fact-registry.ts',
    'export const acceptance_topology_check = "acceptance_basis acceptance_basis_generate transition-orchestrator PLAN to DEV structural gate";\n');
  write(root, 'packages/main/src/core/acceptance-topology.ts',
    'export const evaluateAcceptanceTopologyCheck = () => "PLAN to DEV structural gate";\n');
  write(root, 'packages/main/src/core/agent-dispatch-registry.ts',
    'export const acceptanceTopologyDispatch = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/pre-review-check.ts',
    'export const preReviewCheck = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/pre-review-live-proof.ts',
    'export const preReviewLiveProof = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'scripts/run-proofstory-pre-review-live-proof.mjs',
    'export const preReviewLiveProofRunner = true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts',
    'export const topologyCriticReceipt = "acceptance_basis acceptance_basis_generate";\n');
  // These production acceptance owners are part of the process-fact closure.
  // Keep the hermetic source snapshot mechanically complete so the clean
  // control is not accidentally AT_COVERAGE_BASIS_PARTIAL before mutations.
  write(root, 'packages/main/src/core/acceptance-rollout.ts',
    'export const acceptanceRollout = "acceptance_basis acceptance_topology_check";\n');
  write(root, 'packages/main/src/core/pre-review-live-proof.ts',
    'export const preReviewLiveProof = "acceptance_basis acceptance_topology_check";\n');
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts',
    'export const evaluateAcceptanceTopologyForContext = () => "acceptance_topology_check";\n');
  write(root, 'scripts/verify-process-fact-contract.mjs',
    'export const acceptance_topology_check = "acceptance_basis acceptance_basis_generate transition-orchestrator PLAN to DEV structural gate";\n');
  write(root, 'packages/main/src/core/acceptance-rollout.ts',
    'export const acceptanceRollout = "acceptance_rollout_report verifier-owned signed flat-project rollout report";\n');
  write(root, 'packages/main/src/core/machine.ts',
    'export const machine = "acceptance basis lifecycle consumer";\n');
  write(root, 'packages/main/src/core/review-inventory-epoch.ts',
    'export const reviewInventoryEpoch = "acceptance basis review inventory binding";\n');
  for (const source of [
    'scope-inventory-budget',
    'story-scope-budget',
    'story-scope-budget-decisions',
    'story-scope-budget-legacy',
  ]) {
    write(root, `packages/main/src/core/${source}.ts`,
      `export const ${source.replaceAll('-', '_')} = "acceptance basis source inventory";\n`);
  }
  write(root, 'packages/main/src/handlers/review-inventory.ts',
    'export const reviewInventory = "acceptance basis review inventory handler";\n');
  write(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs',
    'export const acceptanceRolloutCohortRunner = true;\n');
  write(root, 'scripts/run-proofstory-pre-review-live-proof.mjs',
    'export const preReviewLiveProof = "acceptance_basis acceptance_topology_check";\n');

  // This fixture asserts a complete signed source snapshot. Keep it closed
  // over every registered process-fact implementation without duplicating the
  // production registry's evolving source list here.
  for (const entry of PROCESS_FACT_REGISTRY) {
    for (const path of [...(entry.producerSourceRefs ?? []), ...(entry.consumerSourceRefs ?? [])]) {
      if (!existsSync(join(root, path))) write(root, path, 'export const fixtureDependency = true;\n');
    }
  }
}

function parseJsonOutput(output: string): any {
  const start = output.indexOf('{');
  const errorStart = output.indexOf('\nError:', start);
  const end = (errorStart >= 0 ? output.slice(0, errorStart) : output).lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`JSON output missing: ${output}`);
  return JSON.parse(output.slice(start, end + 1));
}

function codes(report: any): string[] {
  return report.diagnostics.map((item: any) => item.code);
}

function assertCode(report: any, code: string, message: string): void {
  assert.ok(codes(report).includes(code), `${message}: expected ${code}, observed ${JSON.stringify(codes(report))}`);
}

function cloneContractBytes(value: string): ProofStoryContractData {
  return JSON.parse(value) as ProofStoryContractData;
}

function exerciseFailingLifecycleMode(mode: 'observe' | 'warn' | 'enforce'): { report: any; coreReport: any; advanceStatus: number; advanceOutput: string; phase: string } {
  const root = mkdtempSync(join(tmpdir(), `proofstory-topology-${mode}-`));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'topology-smoke@example.test']);
    git(root, ['config', 'user.name', 'Topology Smoke']);
    write(root, 'proof-or-stop.config.json', config(mode));
    write(root, 'tsconfig.json', '{}\n');
    write(root, 'packages/main/src/producer.ts', 'export const produce = () => true;\n');
    write(root, 'packages/main/src/consumer.ts', 'export const consume = () => true;\n');
    writeDiscoveryRegistration(root);
    resetConfigCache();
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId, name: 'structural-plan-smoke', title: 'Structural plan smoke', description: 'focused production chain',
      type: 'feature', phase: 'PLAN', priority: 'low', createdAt: now, startedAt: now, endedAt: null,
      events: [], parallelSafe: 'no',
    });
    store.writeChecklist(storyId, checklist());
    const failing = contract();
    failing.acceptanceBindings[0].verificationTopology!.commandRefs = failing.acceptanceBindings[0].verificationTopology!.commandRefs
      .filter(ref => !(ref.refKind === 'existing' && ref.canonicalSourceRef === 'process-fact:acceptance_topology_check'));
    store.writeProofStoryContract(storyId, failing);
    store.writeScopeContract(storyId, scopeContract());
    store.writeScopeCheck(storyId, scopeCheck(root));
    const reviewAt = '2026-07-22T00:00:01.000Z';
    const reviewHash = createHash('sha256').update(`${storyId}:${reviewAt}:0:0:proof-or-stop-review-integrity-v1`).digest('hex');
    store.writeReview(storyId, { reviews: [{ timestamp: reviewAt, issueCount: 0, blockerCount: 0, issues: [], _hash: reviewHash }] } as any);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', `seed ${mode} failing topology`]);
    run(root, 'original_intent_snapshot_set', {
      storyId,
      sourceText: 'Verify the structural plan path before development.',
      normalizedOutcome: 'A complete structural plan can enter development.',
      acceptanceClaim: 'The production transition consumes the same structural evaluator as the read-only check.',
    });
    run(root, 'acceptance_basis_generate', { storyId, json: true });
    // Keep the fixture focused on the acceptance-topology outcome. The
    // independent DEV-memory prerequisite is satisfied before this transition.
    run(root, 'dev_memory_preflight_ack', { storyId });
    const report = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }, mode === 'enforce'));
    const previous = process.cwd();
    let coreReport;
    try {
      process.chdir(root);
      const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
      coreReport = evaluateAcceptanceTopologyForContext(ctx, storyId);
    } finally {
      process.chdir(previous);
    }
    const advance = invoke(root, 'story_advance', { storyId, phase: 'DEV' });
    return { report, coreReport, advanceStatus: advance.status, advanceOutput: advance.output, phase: store.readStory(storyId).phase };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertCompatibilityMatrix(type: 'docs' | 'logic'): void {
  const intentId = `INT-${type.toUpperCase()}`;
  const item: ChecklistData = { items: [{
    id: 'CHK-001', title: type, context: 'compatibility', status: 'pending', startTime: null, endTime: null,
    verificationIntent: { happy: [{ id: intentId, desc: `${type} single outcome`, type, priority: 'must' }], edge: [], adversarial: [] },
  }] };
  const minimal: AcceptanceVerificationTopologyV1 = {
    schemaVersion: 'proofstory.acceptance_topology.v1',
    producerRefs: [{ id: 'P', sourceRef: { refKind: 'existing', canonicalSourceRef: 'checklist:CHK-001' } }],
    consumerRefs: [{ id: 'C', sourceRef: { refKind: 'existing', canonicalSourceRef: 'checklist:CHK-001' }, producerRefs: ['P'] }],
    positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: `intent:${intentId}` }, producerRefs: ['P'], consumerRefs: ['C'] }],
    mutationCaseRefs: [], transcriptAssertionRefs: [], commandRefs: [],
  };
  const report = buildAcceptanceMatrixReport({
    storyId: `B-${type}`, checklist: item, ledger: null,
    contract: {
      schemaVersion: 'proofstory.contract.v1', storyId: `B-${type}`, diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
      acceptanceBindings: [{ id: `AC-${type}`, checklistRefs: ['CHK-001'], verificationIntentRefs: [intentId], milestoneIds: [], verificationTopology: minimal }],
      diagnosticGaps: [], createdAt: now, updatedAt: now,
    },
  });
  assert.deepEqual(report.diagnostics, [], `${type} compatibility must not fabricate runtime mutation/transcript/command obligations`);
}

assertCompatibilityMatrix('docs');
assertCompatibilityMatrix('logic');
assert.equal(resolveAcceptanceTopologyGateMode({ proofStory: { devGateMode: 'enforce' } }), 'observe', 'Wave 2 rollout defaults to observe independently of the pre-existing DEV gate');
assert.equal(resolveAcceptanceTopologyGateMode({ proofStory: { acceptanceTopologyGateMode: 'warn' } }), 'warn');

const assertInvalidPlannedDeclaration = (label: string, mutate: (value: ChecklistData) => void): void => {
  const value = checklist();
  mutate(value);
  assert.ok(derivePlannedCoveragePaths(value, contract(), scopeContract()).diagnostics
    .some(item => item.code === 'AT_PLANNED_PATH_INVALID'), `${label} must fail AT_PLANNED_PATH_INVALID`);
};
assertInvalidPlannedDeclaration('wrong endpoint role', value => {
  value.items[0].verificationIntent!.happy[0].plannedPathDeclarations![0].producer.role = 'consumer' as any;
});
assertInvalidPlannedDeclaration('missing checklist file declaration', value => {
  value.items[0].verificationIntent!.happy[0].plannedPathDeclarations![0].producer.fileDeclarationRef = 'CHK-001:files:create:99';
});
assertInvalidPlannedDeclaration('planned endpoint outside scope', value => {
  value.items[0].files = {
    ...value.items[0].files!,
    create: [...value.items[0].files!.create, 'packages/main/src/outside.ts'],
  };
  const producer = value.items[0].verificationIntent!.happy[0].plannedPathDeclarations![0].producer;
  producer.fileDeclarationRef = 'CHK-001:files:create:2';
  producer.expectedFileRef = 'packages/main/src/outside.ts';
});
const legacyMatrix = buildAcceptanceMatrixReport({
  storyId: 'B-legacy', checklist: { items: [] }, ledger: null,
  contract: {
    schemaVersion: 'proofstory.contract.v1', storyId: 'B-legacy', diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-legacy', checklistRefs: [], verificationIntentRefs: [], milestoneIds: [] }],
    diagnosticGaps: [], createdAt: now, updatedAt: now,
  },
});
assert.equal(legacyMatrix.rows[0]?.topologyState, 'legacy_missing', 'legacy topology remains readable and explicit');

const failingLifecycle = (['observe', 'warn', 'enforce'] as const).map(exerciseFailingLifecycleMode);
const semanticFailureProjection = (result: typeof failingLifecycle[number]) => ({
  status: result.report.status,
  structuralPass: result.report.structuralPass,
  basisStatus: result.report.basisStatus,
  topologyState: result.report.topologyState,
  rows: result.report.rows,
  diagnostics: result.report.diagnostics,
  nextAction: result.report.nextAction,
});
for (const result of failingLifecycle) {
  assert.notEqual(result.report.status, 'pass', 'failing structural report cannot pass');
  assert.equal(result.report.status, failingLifecycle[0].report.status, 'failing structural status is mode-invariant');
  assert.equal(result.report.structuralPass, false);
  assertCode(result.report, 'AT_UNMAPPED_SCOPE_REF', 'real failing lifecycle fixture');
  assert.deepEqual(result.report, result.coreReport, 'core adapter and production CLI expose the exact same canonical report');
}
assert.deepEqual(semanticFailureProjection(failingLifecycle[1]), semanticFailureProjection(failingLifecycle[0]), 'warn preserves the exact failing canonical report');
assert.deepEqual(semanticFailureProjection(failingLifecycle[2]), semanticFailureProjection(failingLifecycle[0]), 'enforce preserves the exact failing canonical report');
assert.equal(failingLifecycle[0].report.blocking, false);
assert.equal(failingLifecycle[1].report.blocking, false);
assert.equal(failingLifecycle[2].report.blocking, true);
assert.equal(failingLifecycle[0].advanceStatus, 0, failingLifecycle[0].advanceOutput);
assert.equal(failingLifecycle[1].advanceStatus, 0, failingLifecycle[1].advanceOutput);
assert.equal(failingLifecycle[0].phase, 'DEV');
assert.equal(failingLifecycle[1].phase, 'DEV');
assert.notEqual(failingLifecycle[2].advanceStatus, 0, 'enforce must reject the same failing report');
assert.match(failingLifecycle[2].advanceOutput, /acceptance topology structural gate blocked PLAN admission/);
assert.equal(failingLifecycle[2].phase, 'PLAN');

const root = mkdtempSync(join(tmpdir(), 'proofstory-topology-gate-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'topology-smoke@example.test']);
  git(root, ['config', 'user.name', 'Topology Smoke']);
  write(root, 'proof-or-stop.config.json', config('observe'));
  write(root, 'tsconfig.json', '{}\n');
  write(root, 'packages/main/src/producer.ts', 'export const produce = () => true;\n');
  write(root, 'packages/main/src/consumer.ts', 'export const consume = () => true;\n');
  writeDiscoveryRegistration(root);
  resetConfigCache();
  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId, name: 'structural-plan-smoke', title: 'Structural plan smoke', description: 'focused production chain',
    type: 'feature', phase: 'PLAN', priority: 'low', createdAt: now, startedAt: now, endedAt: null,
    events: [], parallelSafe: 'no',
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract());
  store.writeScopeContract(storyId, scopeContract());
  store.writeScopeCheck(storyId, scopeCheck(root));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed topology gate smoke']);

  run(root, 'original_intent_snapshot_set', {
    storyId,
    sourceText: 'Verify the structural plan path before development.',
    normalizedOutcome: 'A complete structural plan can enter development.',
    acceptanceClaim: 'The production transition consumes the same structural evaluator as the read-only check.',
  });
  const generatedOutput = run(root, 'acceptance_basis_generate', { storyId, json: true });
  const cleanObserve = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assert.equal(cleanObserve.structuralPass, true, `${generatedOutput}\n${JSON.stringify(cleanObserve.diagnostics)}`);
  assert.equal(cleanObserve.blocking, false);
  assert.equal(cleanObserve.authority, 'diagnostic_only');
  assert.equal(cleanObserve.evidentiary, false);
  const cleanText = run(root, 'acceptance_topology_check', { storyId });
  assert.match(cleanText, /PLAN structural semantics only/);

  const forged = run(root, 'acceptance_topology_check', { storyId, status: 'pass', mode: 'observe', authority: 'production' }, true);
  assert.match(forged, /Argument validation failed|Forbidden|invalid/i, 'caller cannot forge status, mode, or authority');

  const contractPath = `.proof-or-stop/story/actives/${storyId}/proofstory.json`;
  const artifactPath = `.proof-or-stop/story/actives/${storyId}/acceptance-basis.json`;
  const cleanContractBytes = bytes(root, contractPath);
  const cleanArtifactBytes = bytes(root, artifactPath);

  const assertContractMutation = (
    label: string,
    mutate: (value: ProofStoryContractData) => void,
    expectedCodes: string[],
    mutatedChecklist?: ChecklistData,
  ): void => {
    const value = cloneContractBytes(cleanContractBytes);
    mutate(value);
    if (mutatedChecklist) store.writeChecklist(storyId, mutatedChecklist);
    write(root, contractPath, `${JSON.stringify(value, null, 2)}\n`);
    const report = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
    for (const code of expectedCodes) assertCode(report, code, label);
    if (mutatedChecklist) store.writeChecklist(storyId, checklist());
    write(root, contractPath, cleanContractBytes);
    assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, `${label}: exact restoration returns clean pass`);
  };

  assertContractMutation('orphan producer', value => {
    value.acceptanceBindings[0].verificationTopology!.consumerRefs = [];
  }, ['AT_ORPHAN_PRODUCER']);
  assertContractMutation('uncovered must intent', value => {
    value.acceptanceBindings[0].verificationTopology!.positiveAssertionRefs = [];
  }, ['AT_INTENT_UNCOVERED']);
  assertContractMutation('missing mutation declaration', value => {
    value.acceptanceBindings[0].verificationIntentRefs.push('INT-EDGE');
    value.acceptanceBindings[0].verificationTopology!.mutationCaseRefs = [];
  }, ['AT_MUTATION_MISSING'], (() => {
    const value = checklist();
    value.items[0].verificationIntent!.edge.push({ id: 'INT-EDGE', desc: 'edge outcome', type: 'logic', priority: 'must' });
    return value;
  })());
  assertContractMutation('missing transcript declaration', value => {
    value.acceptanceBindings[0].verificationIntentRefs.push('INT-EDGE');
    value.acceptanceBindings[0].verificationTopology!.transcriptAssertionRefs = [];
  }, ['AT_TRANSCRIPT_MISSING'], (() => {
    const value = checklist();
    value.items[0].verificationIntent!.edge.push({ id: 'INT-EDGE', desc: 'edge outcome', type: 'logic', priority: 'must' });
    return value;
  })());
  assertContractMutation('missing command declaration', value => {
    value.acceptanceBindings[0].verificationIntentRefs.push('INT-EDGE');
    value.acceptanceBindings[0].verificationTopology!.commandRefs = [];
  }, ['AT_COMMAND_MISSING'], (() => {
    const value = checklist();
    value.items[0].verificationIntent!.edge.push({ id: 'INT-EDGE', desc: 'edge outcome', type: 'logic', priority: 'must' });
    return value;
  })());
  assertContractMutation('planned path semantic restatement', value => {
    (value.acceptanceBindings[0].verificationTopology!.producerRefs[0].sourceRef as any).role = 'producer';
  }, ['AT_PLANNED_PATH_DECLARATION_DRIFT']);
  assertContractMutation('planned path unknown endpoint', value => {
    const source = value.acceptanceBindings[0].verificationTopology!.consumerRefs[0].sourceRef as any;
    source.endpointRef = 'EP-UNKNOWN';
  }, ['AT_PLANNED_PATH_DECLARATION_MISSING']);

  // Clean → topology-only omission while the independently derived basis keeps C2 → restore → clean.
  const omitted = JSON.parse(cleanContractBytes) as ProofStoryContractData;
  omitted.acceptanceBindings[0].verificationTopology!.commandRefs = omitted.acceptanceBindings[0].verificationTopology!.commandRefs
    .filter(ref => !(ref.refKind === 'existing' && ref.canonicalSourceRef === 'process-fact:acceptance_topology_check'));
  write(root, contractPath, `${JSON.stringify(omitted, null, 2)}\n`);
  const omittedReport = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assert.ok(omittedReport.diagnostics.some((item: any) => item.code === 'AT_UNMAPPED_SCOPE_REF'), 'C2 omission bites while basis remains unchanged');
  write(root, contractPath, cleanContractBytes);
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'exact omission restoration returns clean pass');

  const invented = JSON.parse(cleanContractBytes) as ProofStoryContractData;
  invented.acceptanceBindings[0].verificationTopology!.commandRefs.push({ refKind: 'existing', canonicalSourceRef: 'basis-path:path:not-real' });
  write(root, contractPath, `${JSON.stringify(invented, null, 2)}\n`);
  const inventedReport = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assert.ok(inventedReport.diagnostics.some((item: any) => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS' || item.code === 'AT_UNKNOWN_REF'));
  write(root, contractPath, cleanContractBytes);
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'exact invention restoration returns clean pass');

  const assertArtifactMutation = (label: string, mutate: (value: any) => void, expectedCodes: string[]): void => {
    const value = JSON.parse(cleanArtifactBytes);
    mutate(value);
    write(root, artifactPath, `${JSON.stringify(value, null, 2)}\n`);
    const report = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
    assert.equal(report.structuralPass, false, `${label}: tampered basis cannot pass`);
    for (const code of expectedCodes) assertCode(report, code, label);
    write(root, artifactPath, cleanArtifactBytes);
    assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, `${label}: exact restoration returns clean pass`);
  };

  rmSync(join(root, artifactPath));
  assertCode(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })), 'AT_COVERAGE_BASIS_MISSING', 'missing basis');
  write(root, artifactPath, cleanArtifactBytes);
  assertArtifactMutation('partial basis', value => { value.basis.status = 'partial'; }, ['AT_COVERAGE_BASIS_PARTIAL']);
  assertArtifactMutation('unsupported basis', value => { value.basis.status = 'unsupported'; }, ['AT_COVERAGE_BASIS_PARTIAL']);
  assertArtifactMutation('required adapter omission', value => { value.basis.adapterResults.pop(); }, ['AT_REQUIRED_ADAPTER_RESULT_MISSING', 'AT_ADAPTER_RESULT_DIGEST_MISMATCH']);
  assertArtifactMutation('aggregate projection tamper', value => { value.basis.enumeratedPathRefs.push('path:invented-aggregate'); }, ['AT_ADAPTER_RESULT_DIGEST_MISMATCH']);
  assertArtifactMutation('receipt signature tamper', value => { value.receipt.signature = 'AAAA'; }, ['AT_ADAPTER_RESULT_DIGEST_MISMATCH']);

  const excluded = JSON.parse(cleanArtifactBytes);
  excluded.basis.excludedPathRefs = [{ pathRef: excluded.basis.enumeratedPathRefs[0], decisionRef: 'decision:unapproved' }];
  assert.ok(reconcileTopologyWithCoverageBasis(contract(), excluded.basis, null)
    .some(item => item.code === 'AT_UNJUSTIFIED_EXCLUSION'), 'unapproved coverage exclusion must be rejected');
  write(root, artifactPath, `${JSON.stringify(excluded, null, 2)}\n`);
  assertCode(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })), 'AT_UNJUSTIFIED_EXCLUSION', 'real CLI rejects unapproved exclusion');
  write(root, artifactPath, cleanArtifactBytes);

  write(root, 'packages/main/src/consumer.ts', 'export const consume = () => false;\n');
  const closureStale = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
  assertCode(closureStale, 'AT_CLOSURE_FILES_STALE', 'closure source drift');
  write(root, 'packages/main/src/consumer.ts', 'export const consume = () => true;\n');
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'closure source restoration returns clean pass');

  for (const mode of ['observe', 'warn', 'enforce'] as const) {
    write(root, 'proof-or-stop.config.json', config(mode));
    run(root, 'acceptance_basis_generate', { storyId, json: true });
    const report = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }));
    assert.equal(report.mode, mode);
    assert.equal(report.structuralPass, true, `mode-only change preserves structural result in ${mode}`);
    assert.deepEqual(report.diagnostics, cleanObserve.diagnostics, `mode-only change preserves diagnostics in ${mode}`);
  }

  const changedDiscoveryConfig = JSON.parse(config('enforce'));
  changedDiscoveryConfig.rootDir = 'different-source-root';
  write(root, 'proof-or-stop.config.json', JSON.stringify(changedDiscoveryConfig, null, 2));
  const discoveryConfigDrift = parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true }, true));
  assert.equal(discoveryConfigDrift.structuralPass, false, 'scanRoot/rootDir changes remain structural freshness changes');
  assert.ok(discoveryConfigDrift.diagnostics.some((item: any) =>
    item.code === 'AT_COVERAGE_BASIS_STALE'
      || item.code === 'AT_ADAPTER_RESULT_DIGEST_MISMATCH'
      || item.code === 'AT_COVERAGE_BASIS_PARTIAL'));
  write(root, 'proof-or-stop.config.json', config('enforce'));
  assert.equal(parseJsonOutput(run(root, 'acceptance_topology_check', { storyId, json: true })).structuralPass, true, 'discovery-config restoration returns clean pass');

  // Real PLAN→DEV production route. A valid story_review plus the current
  // verifier receipt admits DEV in enforce mode without executable evidence.
  write(root, 'proof-or-stop.config.json', config('enforce'));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'enable enforce mode']);
  const reviewAt = '2026-07-22T00:00:01.000Z';
  const reviewHash = createHash('sha256').update(`${storyId}:${reviewAt}:0:0:proof-or-stop-review-integrity-v1`).digest('hex');
  store.writeReview(storyId, { reviews: [{ timestamp: reviewAt, issueCount: 0, blockerCount: 0, issues: [], _hash: reviewHash }] } as any);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'record clean plan review']);
  // DEV admission now requires its independent dev-memory preflight receipt.
  // This production-route control must satisfy it rather than asserting an
  // obsolete PLAN→DEV bypass.
  const preflightAck = run(root, 'dev_memory_preflight_ack', { storyId });
  assert.match(preflightAck, /Dev-memory preflight acknowledged/);
  assert.ok(store.readDevMemoryPreflightAck(storyId), 'DEV preflight acknowledgement is persisted before topology evidence refresh');
  assert.equal(evaluateDevMemoryPreflightGate(storyId, store), true, 'persisted preflight acknowledgement satisfies the DEV entry predicate');
  run(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.ok(store.readDevMemoryPreflightAck(storyId), 'topology evidence refresh cannot discard the DEV preflight acknowledgement');
  assert.equal(evaluateDevMemoryPreflightGate(storyId, store), true, 'topology evidence refresh retains a gate-valid DEV preflight acknowledgement');
  assert.equal(canStartDevGuard({ storyId, store, projectRoot: root }), true, 'direct PLAN→DEV guard accepts the current preflight and topology fixtures');
  assert.equal(getGuardFailureReason(storyId, store, 'DEV', root), null, 'the direct PLAN→DEV guard view accepts the current preflight and topology fixtures');
  const actor = createStoryActor(storyId, store, 'PLAN', root);
  actor.start();
  assert.equal(actor.getSnapshot().can({ type: 'START' }), true, 'the restored PLAN actor preserves its store-backed DEV preflight context');
  actor.stop();
  const advance = run(root, 'story_advance', { storyId, phase: 'DEV' });
  assert.match(advance, /advanced to DEV/);
  assert.equal(store.readStory(storyId).phase, 'DEV');

  assert.equal(bytes(root, contractPath), cleanContractBytes, 'topology mutations restore exact contract bytes');
  assert.equal(bytes(root, 'proof-or-stop.config.json'), config('enforce'), 'configuration mutations restore exact enforce bytes');
  assert.equal(bytes(root, 'packages/main/src/producer.ts'), 'export const produce = () => true;\n');
  assert.equal(bytes(root, 'packages/main/src/consumer.ts'), 'export const consume = () => true;\n');

  for (const mutation of ['drop-acceptance-topology-prompt', 'drop-acceptance-topology-handler', 'drop-acceptance-topology-gate', 'invert-acceptance-topology-polarity']) {
    const result = spawnSync(process.execPath, ['scripts/verify-process-fact-contract.mjs'], {
      cwd: repositoryRoot,
      env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: mutation },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${mutation} must make the real process-fact contract fail`);
    assert.match(`${result.stdout || ''}${result.stderr || ''}`, /acceptance topology contract|Process fact contract failed/);
  }

  console.log('proofstory acceptance topology gate smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
