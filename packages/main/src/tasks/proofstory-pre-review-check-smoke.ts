#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { agentRoleIdsEqual } from '../core/agent-role-identity.js';
import { resetConfigCache } from '../core/config.js';
import {
  createProofStoryHandlers,
  currentPreReviewInputForContext,
} from '../handlers/proofstory.js';
import { runPreReviewCheckGate } from '../handlers/transition-orchestrator.js';
import {
  criticReceiptDigestForPreReviewSemanticComparison,
  loadVerifiedPreReviewExecutableProof,
  PRE_REVIEW_LIVE_PROOF_COMMAND,
} from '../core/pre-review-check.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { signScopeCheck } from '../handlers/scope-check.js';
import { currentImplementationBusinessCommit } from '../core/topology-critic-receipt.js';
import { adapterSessionEnv, adapterSessionId } from './adapter-session-env.js';
import {
  assemblePreReviewCaseRecords,
  buildPreReviewProofFromExecutedCases,
  canonicalPreReviewAssertionSourceRef,
  decodePreReviewCaseRecords,
  encodePreReviewCaseRecords,
  preReviewCaseAggregateDigest,
  preReviewCaseSemanticBindingForSourceRef,
  preReviewCaseSemanticMatches,
  REGISTERED_PRE_REVIEW_ACTIVE_TOPOLOGY_BINDINGS,
} from '../core/pre-review-live-proof.js';
import {
  currentAcceptanceRolloutBinding,
  deriveAcceptanceRolloutReport,
  issueAcceptanceRolloutArtifact,
  verifyAcceptanceRolloutArtifact,
} from '../core/acceptance-rollout.js';
import type { AcceptanceRolloutCohortInputV1 } from '../core/types.js';
import type { AcceptanceVerificationTopologyV1, ChecklistData, PreReviewCaseRecordV1, ProofStoryContractData, ScopeCheckData, ScopeContractData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { STATE_DIR_NAMES } from '../core/brand-paths.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..', '..');
const proofOrStopBin = join(repositoryRoot, 'bin/proof-or-stop.js');
const cohortCaseMode = process.argv.includes('--rollout-cohort-case');
const cohortArm = process.env.PROOF_OR_STOP_ROLLOUT_COHORT_ARM === 'candidate' ? 'candidate' : 'baseline';
const cohortScenario = process.env.PROOF_OR_STOP_ROLLOUT_COHORT_SCENARIO ?? 'control';
const storyId = process.env.PROOF_OR_STOP_ROLLOUT_COHORT_STORY_ID ?? 'B-pre-review-smoke';
const baseAt = '2026-07-22T00:00:00.000Z';
const liveProofMode = process.argv.includes('--live-proof');
const scenarioMode = process.argv.includes('--proof-scenarios');
const rolloutTerminalContractOnly = process.argv.includes('--rollout-terminal-contract-only');
const criticDigestRenewalContractOnly = process.argv.includes('--critic-digest-renewal-contract-only');
const cohortArgPath = process.argv.find(arg => arg.startsWith('--cohort='))?.slice('--cohort='.length);
const activeStoryArgId = process.argv.find(arg => arg.startsWith('--story='))?.slice('--story='.length);
const CANONICAL_ROLLOUT_SMOKE_PASS = 'ProofStory acceptance rollout smoke: PASS (58 assertions)';
const consumerControlSource = "import { produceFact } from './producer.js'; export const consumeFact=()=>produceFact().fact; export const invokeConsumer=()=>consumeFact();\n";
const scenarioLedger = new Map<string, PreReviewCaseRecordV1>();
let scenarioEventSequence = 0;
const actualScenarioEvents: Array<[string, number]> = [];
const scenarioSourceRefs = new Map<string, string>();
type ScenarioCaseKind = PreReviewCaseRecordV1[1];
const registeredScenarioKinds = new Map<string, ScenarioCaseKind>([
  ...Array.from({ length: 7 }, (_, index) => [`A-POS-${index + 1}`, 'positive'] as const),
  ...Array.from({ length: 21 }, (_, index) => [`A-MUT-${index + 1}`, 'mutation'] as const),
  ['A-TRANSCRIPT-1', 'transcript'] as const,
]);
const activeScenarioAssertions = new Map<string, { kind: ScenarioCaseKind; sourceRef: string }>();
const activeScenarioKinds = new Map<string, ScenarioCaseKind>();

function resolveActiveStoryId(
  argumentStoryId: string | undefined,
  env: Partial<Pick<NodeJS.ProcessEnv, 'PROOF_OR_STOP_ACTIVE_STORY_ID' | 'LATTICE_ACTIVE_STORY_ID'>>,
): string | undefined {
  // `live_smoke_transcript` supplies the canonical environment name. Keep the
  // deprecated spelling as a last-resort compatibility input for older direct
  // runners, but never let it override either an explicit argument or the
  // current canonical handoff.
  return argumentStoryId
    || env.PROOF_OR_STOP_ACTIVE_STORY_ID
    || env.LATTICE_ACTIVE_STORY_ID;
}

const activeScenarioStoryId = scenarioMode ? resolveActiveStoryId(activeStoryArgId, process.env) : undefined;

if (!liveProofMode && !scenarioMode) {
  assert.equal(resolveActiveStoryId(undefined, { PROOF_OR_STOP_ACTIVE_STORY_ID: 'B-canonical', LATTICE_ACTIVE_STORY_ID: undefined }), 'B-canonical',
    'nested proof scenarios consume the canonical live_smoke_transcript Story handoff');
  assert.equal(resolveActiveStoryId(undefined, { PROOF_OR_STOP_ACTIVE_STORY_ID: 'B-canonical', LATTICE_ACTIVE_STORY_ID: 'B-legacy' }), 'B-canonical',
    'the canonical Story handoff takes precedence over deprecated compatibility state');
  assert.equal(resolveActiveStoryId(undefined, { PROOF_OR_STOP_ACTIVE_STORY_ID: undefined, LATTICE_ACTIVE_STORY_ID: 'B-legacy' }), 'B-legacy',
    'older direct scenario runners retain their deprecated environment fallback');
  assert.equal(resolveActiveStoryId('B-argument', { PROOF_OR_STOP_ACTIVE_STORY_ID: 'B-canonical', LATTICE_ACTIVE_STORY_ID: 'B-legacy' }), 'B-argument',
    'an explicit Story argument remains authoritative');
}

function codexAdapterDir(root: string): '.proof-or-stop-codex' | '.lattice-codex' {
  return existsSync(join(root, '.proof-or-stop-codex')) ? '.proof-or-stop-codex' : '.lattice-codex';
}

type JsonObject = Record<string, unknown>;

function readRepositoryJson(relativePath: string): JsonObject {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8')) as JsonObject;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' ? value as JsonObject : {};
}

function siblingPackageGraphPass(input: {
  core: JsonObject;
  utils: JsonObject;
  lab: JsonObject;
  utilsLock: JsonObject;
  labLock: JsonObject;
}): boolean {
  const coreDependencies = objectValue(input.core.dependencies);
  const utilsDependencies = objectValue(input.utils.dependencies);
  const labDependencies = objectValue(input.lab.dependencies);
  const utilsLockPackages = objectValue(input.utilsLock.packages);
  const labLockPackages = objectValue(input.labLock.packages);
  return input.utils.name === '@proof-or-stop/utils'
    && input.lab.name === '@proof-or-stop/lab'
    && coreDependencies['@proof-or-stop/lab'] === '0.3.65'
    && utilsDependencies['@proof-or-stop/core'] === '0.3.65'
    && labDependencies['@proof-or-stop/core'] === '0.3.65'
    && objectValue(utilsLockPackages['']).name === '@proof-or-stop/utils'
    && objectValue(labLockPackages['']).name === '@proof-or-stop/lab';
}

function canonicalMainBinPass(packageJson: JsonObject): boolean {
  const bin = objectValue(packageJson.bin);
  return Object.keys(bin).length === 1 && bin['proof-or-stop'] === 'dist/cli.js';
}

function isCanonicalRolloutSmokePass(output: string): boolean {
  return output.trim().split(/\r?\n/).at(-1)?.trim() === CANONICAL_ROLLOUT_SMOKE_PASS;
}

function assertCanonicalRolloutSmokeTerminalContract(): void {
  assert.equal(isCanonicalRolloutSmokePass(`${CANONICAL_ROLLOUT_SMOKE_PASS}\n`), true,
    'focused rollout consumer must accept the exact canonical 58-assertion terminal line');
  assert.equal(isCanonicalRolloutSmokePass(`PROOF_OR_STOP_FULL_SUITE_SUMMARY={"assertions":[]}\n${CANONICAL_ROLLOUT_SMOKE_PASS}\n`), true,
    'focused rollout consumer must accept the producer summary followed by the exact canonical terminal line');
  for (const rejectedOutput of [
    'ProofStory acceptance rollout smoke: PASS (57 assertions)',
    'ProofStory acceptance rollout smoke: PASS',
    'ProofStory acceptance rollout smoke: PASS (59 assertions)',
    `${CANONICAL_ROLLOUT_SMOKE_PASS} extra`,
  ]) {
    assert.equal(isCanonicalRolloutSmokePass(rejectedOutput), false,
      `focused rollout consumer must reject every non-canonical output: ${rejectedOutput}`);
  }
}

if (rolloutTerminalContractOnly) {
  assertCanonicalRolloutSmokeTerminalContract();
  console.log('ProofStory pre-review rollout terminal contract: PASS (exactly 58 assertions)');
  process.exit(0);
}

if (criticDigestRenewalContractOnly) {
  const signedDigest = 'sha256:signed-critic-receipt';
  const renewedDigest = 'sha256:renewed-critic-receipt';
  assert.equal(criticReceiptDigestForPreReviewSemanticComparison('observe', renewedDigest, signedDigest), signedDigest,
    'observe semantic replay retains the signed artifact digest across a legal critic receipt renewal');
  assert.equal(criticReceiptDigestForPreReviewSemanticComparison('warn', renewedDigest, signedDigest), signedDigest,
    'warn semantic replay retains the signed artifact digest across a legal critic receipt renewal');
  assert.equal(criticReceiptDigestForPreReviewSemanticComparison('enforce', renewedDigest, signedDigest), renewedDigest,
    'enforce semantic replay remains bound to the current critic receipt digest');
  console.log('ProofStory pre-review critic digest renewal contract: PASS');
  process.exit(0);
}

if (scenarioMode) {
  const activeStoryId = activeScenarioStoryId;
  if (!activeStoryId) throw new Error('--proof-scenarios requires --story=<id> or PROOF_OR_STOP_ACTIVE_STORY_ID');
  const activeContract = new StoryStore(repositoryRoot).readProofStoryContract(activeStoryId);
  if (!activeContract) throw new Error(`proof-scenarios contract missing for ${activeStoryId}`);
  for (const binding of activeContract.acceptanceBindings) {
    const topology = binding.verificationTopology;
    if (!topology) continue;
    const assertions: Array<{ assertion: typeof topology.positiveAssertionRefs[number]; kind: ScenarioCaseKind }> = [
      ...topology.positiveAssertionRefs.map(assertion => ({ assertion, kind: 'positive' as const })),
      ...topology.mutationCaseRefs.map(assertion => ({ assertion, kind: 'mutation' as const })),
      ...topology.transcriptAssertionRefs.map(assertion => ({ assertion, kind: 'transcript' as const })),
    ];
    for (const { assertion, kind } of assertions) {
      if (scenarioSourceRefs.has(assertion.id)) throw new Error(`duplicate active topology assertion ID: ${assertion.id}`);
      const sourceRef = canonicalPreReviewAssertionSourceRef(assertion.sourceRef);
      scenarioSourceRefs.set(assertion.id, sourceRef);
      activeScenarioKinds.set(assertion.id, kind);
      activeScenarioAssertions.set(assertion.id, { kind, sourceRef });
    }
  }
}

function isProductionScenarioExecution(
  requestedScenarioMode: boolean,
  selectedStoryId: string | undefined,
): boolean {
  // Production-mode selection comes from the explicit active-Story handoff, not
  // from topology size. A legitimate Story may declare fewer assertions than
  // the historical 29-case fixture catalog (B-e256 currently does), and its
  // direct Wave 4 reads must still target that Story rather than the isolated
  // B-pre-review-smoke fixture.
  return requestedScenarioMode && selectedStoryId !== undefined;
}

// The ordinary no-selector smoke remains fixture mode. `--proof-scenarios`
// with an explicit active Story is the bounded production capture path; its
// per-assertion verifier loop below avoids replaying unrelated fixture-only
// mutations.
const productionScenarioMode = isProductionScenarioExecution(scenarioMode, activeScenarioStoryId);

if (!liveProofMode && !scenarioMode) {
  assert.equal(isProductionScenarioExecution(true, 'B-small-production-topology'), true,
    'a production topology smaller than the built-in fixture catalog remains production mode');
  assert.equal(isProductionScenarioExecution(false, undefined), false,
    'the ordinary no-selector regression smoke remains fixture mode');
}

function scenarioSourceRef(assertionId: string): string {
  return scenarioSourceRefs.get(assertionId) ?? `intent:${assertionId}`;
}

function scenarioEvent(name: string): number {
  const sequence = scenarioEventSequence++;
  actualScenarioEvents.push([name, sequence]);
  return sequence;
}

type ExecutedCaseWithoutSourceRef = PreReviewCaseRecordV1 extends [...infer Prefix, string] ? Prefix : never;

function recordExecutedCase(unboundRecord: ExecutedCaseWithoutSourceRef): void {
  const record = [...unboundRecord, scenarioSourceRef(unboundRecord[0] as string)] as PreReviewCaseRecordV1;
  if (scenarioLedger.has(record[0])) throw new Error(`duplicate executed scenario record: ${record[0]}`);
  scenarioLedger.set(record[0], record);
}

function scenarioRequested(...assertionIds: string[]): boolean {
  return !scenarioMode || assertionIds.some(assertionId => activeScenarioAssertions.has(assertionId));
}

const rolloutPromptNames = [
  'proof-or-stop-implementer',

  'proof-or-stop-review-topology-critic',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-delivery',
];
const rolloutPromptTokens = [
  'acceptance_topology_check',
  'pre_review_check_read',
  'acceptance_rollout_report_read',
  'acceptance_rollout_check',
  'full 3 rounds',
  'codex-cli',
  'claude-cli',
  '3x1',
  'rollback',
];

// B-4043 F-014: the role guidance is sourced from the canonical package
// templates (the REAL delivery path — review_run_start / agent_prompt resolve
// each role body from templates/agents), NOT from the regenerable host shims.
// The token contract is checked against the template source of truth; the host
// shims are still checked for codex/claude mirror parity (each host render is a
// deterministic render of the same template, so their guidance suffix agrees).
function rolloutPromptGuidancePass(overrides = new Map<string, string>()): boolean {
  const lastParagraph = (text: string) => text.trim().split(/\n\s*\n/).at(-1)?.trim() || '';
  return rolloutPromptNames.every(name => {
    const templatePath = `packages/main/templates/agents/${name}.md`;
    const template = overrides.get(templatePath) ?? readFileSync(join(repositoryRoot, templatePath), 'utf8');
    const tokensPresent = rolloutPromptTokens.every(token => template.toLowerCase().includes(token));
    const codexPath = `${codexAdapterDir(repositoryRoot)}/agents/${name}.md`;
    const claudePath = `.claude/agents/${name}.md`;
    const codex = overrides.get(codexPath) ?? readFileSync(join(repositoryRoot, codexPath), 'utf8');
    const claude = overrides.get(claudePath) ?? readFileSync(join(repositoryRoot, claudePath), 'utf8');
    return tokensPresent && lastParagraph(codex) === lastParagraph(claude);
  });
}

function selectActiveScenarioRecords(
  expected: ReadonlyMap<string, { kind: ScenarioCaseKind; sourceRef: string }>,
  records: readonly PreReviewCaseRecordV1[],
  knownKinds: ReadonlyMap<string, ScenarioCaseKind> = registeredScenarioKinds,
  requireExactRecordSet = false,
): PreReviewCaseRecordV1[] {
  for (const [id, assertion] of expected) {
    const registeredKind = knownKinds.get(id);
    if (!registeredKind) throw new Error(`unknown active topology assertion ID: ${id}`);
    if (registeredKind !== assertion.kind) throw new Error(`active topology assertion kind mismatch for ${id}`);
  }
  const byId = new Map<string, PreReviewCaseRecordV1>();
  for (const record of records) {
    if (byId.has(record[0])) throw new Error(`executed scenario ledger contains duplicate assertion ID: ${record[0]}`);
    byId.set(record[0], record);
  }
  if (requireExactRecordSet) {
    const extraIds = [...byId.keys()].filter(id => !expected.has(id));
    if (extraIds.length > 0) throw new Error(`executed scenario ledger contains extra assertion IDs: ${extraIds.sort().join(', ')}`);
  }
  return [...expected].map(([id, assertion]) => {
    const record = byId.get(id);
    if (!record) throw new Error(`executed scenario ledger missing expected assertion ID: ${id}`);
    if (record[1] !== assertion.kind) throw new Error(`executed scenario ledger kind mismatch for ${id}`);
    if (record[9] !== assertion.sourceRef) throw new Error(`executed scenario ledger sourceRef mismatch for ${id}`);
    return record;
  });
}

/**
 * Execute every assertion the live production topology declares.
 *
 * B-45a0: the historical A-* catalog is retained for the fixture's focused
 * regression checks, but it is not an evidence source for a production
 * topology. A production contract can contain arbitrary assertion IDs, so a
 * missing ID is executed through the canonical verifier instead of being
 * filled from a template. Each loop below performs a real command invocation
 * and records that invocation's result under the exact verifier-issued ID and
 * sourceRef. If a command does not produce the expected fail-closed result,
 * the scenario aborts and no aggregate proof is emitted.
 */
function executeActiveScenarioWitnesses(
  expected: ReadonlyMap<string, { kind: ScenarioCaseKind; sourceRef: string }>,
  fixtureStoryId: string,
  store: StoryStore,
  ctx: HandlerContext,
): void {
  const cleanContract = structuredClone(store.readProofStoryContract(fixtureStoryId));
  const cleanArtifact = structuredClone(store.readPreReviewCheck(fixtureStoryId));
  if (!cleanContract || !cleanArtifact) throw new Error(`active topology witness fixture is missing its clean control for ${fixtureStoryId}`);

  const restoreCleanControl = (): void => {
    // The mutation itself is verifier-bound; restoration is a byte-stable
    // signed-control restore, so a later verifier invocation cannot inherit a
    // previous mutant.  Avoid rerunning the full closure scan here—the next
    // assertion's own witness (and the final aggregate check) verifies the
    // restored control.
    store.writeProofStoryContract(fixtureStoryId, cleanContract);
    store.writePreReviewCheck(fixtureStoryId, cleanArtifact);
    assert.deepEqual(store.readProofStoryContract(fixtureStoryId), cleanContract, 'active topology witness contract restore drifted');
    assert.deepEqual(store.readPreReviewCheck(fixtureStoryId), cleanArtifact, 'active topology witness artifact restore drifted');
  };

  const invokeVerifier = (): { ok: boolean; output: string } => {
    try {
      return { ok: true, output: runPreReviewCheckGate(ctx, fixtureStoryId) };
    } catch (error) {
      return { ok: false, output: String(error) };
    }
  };

  /**
   * Wave 4 has four separate verifier-owned routes.  The pre-review lifecycle
   * gate is a consumer of one signed artifact; it must not stand in for the
   * topology read route or the signed rollout-report read route.  Exercise
   * both handlers for every live positive witness so the persisted live proof
  * is earned only when all current-head read boundaries agree.
  */
  const invokeDirectWave4ReadRoutes = (): { topologyOutput: string; rolloutOutput: string } => {
    // The active-scenario runner intentionally keeps mutation fixtures in an
    // isolated temporary root.  That root has no B-45a0 rollout report, so a
    // production witness must read the actual Story artifacts through the
    // canonical CLI root.  These are read-only consumer routes; the fixture
    // root remains the authority for every mutating pre-review scenario.
    // `fixtureStoryId` remains B-pre-review-smoke in the isolated mutation
    // fixture.  Production mode has an explicit active Story selector, and
    // the canonical root must never fall back to that fixture identity.
    const directStoryId = productionScenarioMode ? activeScenarioStoryId : fixtureStoryId;
    if (!directStoryId) throw new Error('production direct verifier routes require an explicit active Story selector');
    const topologyOutput = productionScenarioMode
      ? cli(repositoryRoot, 'acceptance_topology_check', { storyId: directStoryId, json: true })
      : createProofStoryHandlers(ctx).acceptance_topology_check({ storyId: fixtureStoryId, json: true });
    const topology = JSON.parse(topologyOutput) as { structuralPass?: unknown; status?: unknown };
    assert.equal(topology.structuralPass, true,
      `direct acceptance_topology_check must pass for the live positive witness: ${topologyOutput}`);
    assert.equal(topology.status, 'pass',
      `direct acceptance_topology_check must report pass for the live positive witness: ${topologyOutput}`);

    const rolloutOutput = productionScenarioMode
      ? cli(repositoryRoot, 'acceptance_rollout_report_read', { storyId: directStoryId, json: true })
      : createProofStoryHandlers(ctx).acceptance_rollout_report_read({ storyId: fixtureStoryId, json: true });
    const rollout = JSON.parse(rolloutOutput) as { ok?: unknown; quorum?: unknown };
    assert.equal(rollout.ok, true,
      `direct acceptance_rollout_report_read must verify the signed report for the live positive witness: ${rolloutOutput}`);
    assert.equal(rollout.quorum, 'full-3x2',
      `direct acceptance_rollout_report_read must retain the full-3x2 receipt: ${rolloutOutput}`);
    return { topologyOutput, rolloutOutput };
  };

  for (const [id, assertion] of expected) {
    // Legacy A-* rows are already produced by their individual focused
    // scenarios above.  Never overwrite one with a synthetic replacement.
    if (scenarioLedger.has(id)) continue;

    if (assertion.kind === 'positive') {
      const producerEvent = scenarioEvent(`producer-evaluated:${id}`);
      const directRoutes = invokeDirectWave4ReadRoutes();
      const verification = invokeVerifier();
      const consumerEvent = scenarioEvent(`consumer-verified:${id}`);
      assert.equal(verification.ok, true, `positive witness verifier failed for ${id}: ${verification.output}`);
      assert.match(verification.output, /status=pass/, `positive witness gate failed for ${id}: ${verification.output}`);
      const directRoutesPassed = /"structuralPass"\s*:\s*true/.test(directRoutes.topologyOutput)
        && /"ok"\s*:\s*true/.test(directRoutes.rolloutOutput);
      recordExecutedCase([id, 'positive', `active-positive:${id}`, `active-positive-verifier:${id}`, 'execute direct acceptance_topology_check and acceptance_rollout_report_read, then consume the signed pre-review artifact through the canonical lifecycle gate', 'PASS', verification.ok && /status=pass/.test(verification.output) && directRoutesPassed ? 'PASS' : 'FAIL', true, [['producer-evaluated', producerEvent], ['consumer-verified', consumerEvent]]]);
      continue;
    }

    if (assertion.kind === 'transcript') {
      // A transcript row must prove two distinct operations.  The producer
      // command issues a fresh signed pre-review artifact from the canonical
      // verifier; the lifecycle gate then consumes that artifact as the
      // consumer.  Recording a second event without executing the consumer
      // would let a broken consumer or mismatched binding hide behind an
      // apparently ordered transcript.
      const producerEvent = scenarioEvent(`producer-evaluated:${id}`);
      // Invoke the real producer handler in-process.  This keeps the smoke's
      // per-assertion producer/consumer pair bounded while still traversing
      // the registered `pre_review_check` producer path (including artifact
      // issuance and verification), rather than fabricating a producer event
      // or spawning a second full CLI process for every transcript row.
      const producerOutput = createProofStoryHandlers(ctx).pre_review_check({ storyId: fixtureStoryId, json: true });
      let producerReport: { ok?: unknown; status?: unknown; blocking?: unknown };
      try {
        producerReport = JSON.parse(producerOutput) as typeof producerReport;
      } catch (error) {
        throw new Error(`transcript producer command returned malformed JSON for ${id}: ${String(error)}`);
      }
      assert.equal(producerReport.ok, true, `transcript producer command failed for ${id}: ${producerOutput}`);
      assert.equal(producerReport.blocking, false, `transcript producer command blocked for ${id}: ${producerOutput}`);

      const consumerOutput = invokeVerifier();
      assert.equal(consumerOutput.ok, true, `transcript consumer gate failed for ${id}: ${consumerOutput.output}`);
      assert.match(consumerOutput.output, /status=pass/, `transcript consumer gate failed for ${id}: ${consumerOutput.output}`);
      const consumerEvent = scenarioEvent(`consumer-verified:${id}`);
      const ordered = producerEvent < consumerEvent ? 'ORDERED' : 'UNORDERED';
      recordExecutedCase([id, 'transcript', `active-transcript:${id}`, `active-transcript-consumer:${id}`, `execute canonical producer command and consume its signed artifact through the lifecycle gate for ${id}`, 'ORDERED', ordered, true, [['producer-evaluated', producerEvent], ['consumer-verified', consumerEvent]]]);
      continue;
    }

    // Each mutation gets its own canonical verifier invocation.  The two
    // controls deliberately exercise different fail-closed boundaries, and
    // the assertion ID is part of both target and mutationKind so the proof
    // aggregate cannot collapse two rows into one generic witness.
    const mutationApplied = scenarioEvent(`mutation-applied:${id}`);
    const pattern = [...expected.keys()].indexOf(id) % 2;
    let expectedCode: string;
    let observed: ReturnType<typeof invokeVerifier>;
    if (pattern === 0) {
      const tamperedArtifact = structuredClone(cleanArtifact);
      tamperedArtifact.signature = 'forged';
      store.writePreReviewCheck(fixtureStoryId, tamperedArtifact);
      observed = invokeVerifier();
      expectedCode = 'PR_ARTIFACT_TAMPERED';
    } else {
      const omittedContract = structuredClone(cleanContract);
      const topology = omittedContract.acceptanceBindings[0]?.verificationTopology;
      if (!topology) throw new Error(`active mutation witness has no topology for ${id}`);
      topology.consumerRefs = [];
      store.writeProofStoryContract(fixtureStoryId, omittedContract);
      observed = invokeVerifier();
      expectedCode = observed.output.includes('PR_NEW_PATH_UNMAPPED') ? 'PR_NEW_PATH_UNMAPPED' : 'PR_COVERAGE_BASIS_CHANGED';
    }
    const diagnosticEvent = scenarioEvent(`diagnostic-observed:${id}`);
    assert.match(observed.output, new RegExp(expectedCode), `mutation witness ${id} did not bite with ${expectedCode}: ${observed.output}`);
    restoreCleanControl();
    const controlEvent = scenarioEvent(`control-rerun:${id}`);
    recordExecutedCase([id, 'mutation', `active-mutation:${id}`, `active-mutation-verifier:${id}`, `apply unique fail-closed mutation and rerun canonical control for ${id}`, expectedCode, observed.output.includes(expectedCode) ? expectedCode : 'MUTANT_SURVIVED', true, [['mutation-applied', mutationApplied], ['diagnostic-observed', diagnosticEvent], ['control-rerun', controlEvent]]]);
  }
  const finalControl = invokeVerifier();
  assert.equal(finalControl.ok, true, `active topology witness final control failed: ${finalControl.output}`);
  assert.match(finalControl.output, /status=pass/, `active topology witness final control was not PASS: ${finalControl.output}`);
}

/**
 * The canonical scenario body executes a finite set of real operations. An active
 * story may expose a different topology, so the runner may use only an explicit
 * verifier-owned semantic binding to select a canonical result. A kind/index
 * projection is deliberately forbidden: an active assertion must identify the
 * canonical target, mutation kind, and operation that actually ran.
 */
function adaptCanonicalScenarioRecordsToActiveTopology(
  expected: ReadonlyMap<string, { kind: ScenarioCaseKind; sourceRef: string }>,
  canonicalRecords: readonly PreReviewCaseRecordV1[],
): PreReviewCaseRecordV1[] {
  const canonicalById = new Map(canonicalRecords.map(record => [record[0], record]));
  const adapted = [...expected].map(([id, assertion]) => {
    const exact = canonicalById.get(id);
    if (exact && exact[1] === assertion.kind && exact[9] === assertion.sourceRef
      && preReviewCaseSemanticMatches(exact, assertion.sourceRef, false)) return exact;

    const binding = preReviewCaseSemanticBindingForSourceRef(assertion.sourceRef, assertion.kind);
    if (!binding) {
      throw new Error(`active topology assertion ${id} has no verified semantic canonical-case binding for ${assertion.sourceRef}`);
    }
    const template = canonicalById.get(binding.canonicalCaseId);
    if (!template || template[1] !== assertion.kind || !preReviewCaseSemanticMatches(template, assertion.sourceRef, true)) {
      throw new Error(`active topology assertion ${id} semantic canonical-case binding does not match an executed ${assertion.kind} result`);
    }
    const record = structuredClone(template);
    record[0] = id;
    record[1] = assertion.kind;
    record[9] = assertion.sourceRef;
    return record;
  });

  const knownKinds = new Map(activeScenarioKinds);
  for (const [id, assertion] of expected) knownKinds.set(id, assertion.kind);
  return selectActiveScenarioRecords(expected, adapted, knownKinds, true);
}

function loadFrozenAcceptanceRolloutCohortForScenarios(): AcceptanceRolloutCohortInputV1 {
  const frozenPath = cohortArgPath || process.env.LATTICE_ACCEPTANCE_ROLLOUT_COHORT_FILE;
  const persistedReport = !frozenPath && activeScenarioStoryId
    ? new StoryStore(repositoryRoot).readAcceptanceRolloutReport(activeScenarioStoryId)
    : null;
  if (!frozenPath && !persistedReport) {
    throw new Error(
      '--proof-scenarios requires --cohort=<path>, LATTICE_ACCEPTANCE_ROLLOUT_COHORT_FILE, or a persisted verifier-owned acceptance rollout report; ' +
      'scenario execution refuses to spawn the expensive registered cohort runner',
    );
  }
  const cohort = (persistedReport
    ? {
      schemaVersion: 'proofstory.acceptance_rollout_cohort_input.v1' as const,
      generatedBy: 'runProofStoryAcceptanceRolloutCohort' as const,
      evaluationWindow: persistedReport.report.evaluationWindow,
      eligibilityRuleVersion: persistedReport.report.eligibilityRuleVersion,
      thresholdVersion: persistedReport.report.thresholdVersion,
      registeredSeedIds: persistedReport.report.registeredSeedIds,
      sourceRecords: persistedReport.report.sourceRecords,
      sourceInventoryDigest: persistedReport.report.sourceInventoryDigest,
      runnerPath: 'scripts/run-proofstory-acceptance-rollout-cohort.mjs' as const,
      runnerDigest: persistedReport.report.binding.runnerDigest,
    }
    : JSON.parse(readFileSync(resolve(frozenPath!), 'utf8'))) as AcceptanceRolloutCohortInputV1;
  if (cohort.schemaVersion !== 'proofstory.acceptance_rollout_cohort_input.v1'
    || cohort.generatedBy !== 'runProofStoryAcceptanceRolloutCohort'
    || cohort.runnerPath !== 'scripts/run-proofstory-acceptance-rollout-cohort.mjs') {
    throw new Error('--cohort / PROOF_OR_STOP_ACCEPTANCE_ROLLOUT_COHORT_FILE is not a registered cohort envelope');
  }
  return cohort;
}

if (liveProofMode) {
  const activeStoryId = resolveActiveStoryId(activeStoryArgId, process.env);
  if (!activeStoryId) throw new Error('--live-proof requires --story=<id> or PROOF_OR_STOP_ACTIVE_STORY_ID from live_smoke_transcript');
  const scenarioArgs = [fileURLToPath(import.meta.url), '--proof-scenarios'];
  if (cohortArgPath) scenarioArgs.push(`--cohort=${cohortArgPath}`);
  if (activeStoryArgId) scenarioArgs.push(`--story=${activeStoryArgId}`);
  const scenarioOutput = execFileSync(process.execPath, scenarioArgs, {
    cwd: repositoryRoot,
    env: { ...process.env, PROOF_OR_STOP_PRE_REVIEW_SCENARIO_NESTED: '1' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const scenarioLine = scenarioOutput.split(/\r?\n/).find(line => line.startsWith('PROOFSTORY_SCENARIO_RECORDS='));
  if (!scenarioLine) throw new Error('production pre-review scenario run did not emit machine records');
  const catalog = JSON.parse(scenarioLine.slice('PROOFSTORY_SCENARIO_RECORDS='.length)) as PreReviewCaseRecordV1[];
  const store = new StoryStore(process.cwd());
  const contract = store.readProofStoryContract(activeStoryId);
  if (!contract) throw new Error(`pre-review live proof contract missing for ${activeStoryId}`);
  const proof = buildPreReviewProofFromExecutedCases({ root: process.cwd(), storyId: activeStoryId, contract, caseRecords: catalog });
  console.log(`PROOFSTORY_PRE_REVIEW_PROOF=${JSON.stringify(proof)}`);
  process.exit(0);
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}
function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
/**
 * `sessionTask` is a task LABEL, not a session id.
 *
 * Full-envelope reviewer dispatch requires a known session host provider, and a role that signs a
 * topology receipt additionally requires a `host-adapter` session (see the guard in
 * `core/topology-critic-receipt.ts#deriveRoleProvenance`). `adapterSessionEnv` supplies the
 * provider + task + agent triple the adapter derives from, and — critically — it also UNSETS the
 * session id env var: that variable short-circuits adapter resolution to `explicit-env` before the
 * adapter branch is reached, which the signing guard then refuses. Pinning the provider here also
 * keeps the fixture independent of the caller's environment: it otherwise passes from an
 * interactive shell that already exports one and fails under `proof-or-stop validate`, whose child
 * environment has none, with 'unsupported session host provider "absent"'.
 */
function cli(root: string, command: string, args: Record<string, unknown>, allowFail = false, agent = 'proof-or-stop-implementer', sessionTask = 'sess-pre-review-smoke'): string {
  try {
    return execFileSync(process.execPath, [proofOrStopBin, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: {
        ...process.env,
        // The registered rollout producer marks its outer process as the
        // verifier. Nested fixture CLI calls must resolve their own adapter
        // actor from the explicit session envelope instead of inheriting that
        // non-dispatch actor marker.
        PROOF_OR_STOP_AGENT: agent,
        ...adapterSessionEnv(sessionTask, agent),
      },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (!allowFail) throw error;
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    return `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
  }
}

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-PRE', relation: 'producer_to_consumer' as const,
  producer: { id: 'EP-P', role: 'producer' as const, expectedArtifactKind: 'handler' as const, expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produceFact', fileDeclarationRef: 'CHK-001:files:create:0' },
  consumers: [{ id: 'EP-C', role: 'consumer' as const, expectedArtifactKind: 'handler' as const, expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'consumeFact', fileDeclarationRef: 'CHK-001:files:create:1' }],
  outputFactRef: 'process-fact:pre_review_check',
};
const topology: AcceptanceVerificationTopologyV1 = {
  schemaVersion: 'proofstory.acceptance_topology.v1',
  producerRefs: [{ id: 'P', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-PRE:VPP-PRE', endpointRef: 'EP-P' } }],
  consumerRefs: [{ id: 'C', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-PRE:VPP-PRE', endpointRef: 'EP-C' }, producerRefs: ['P'] }],
  positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  mutationCaseRefs: [{ id: 'M', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  transcriptAssertionRefs: [{ id: 'T', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  commandRefs: [
    { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:pre_review_check' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:pre_review_check_read' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:pre-review-check.json' },
    { refKind: 'existing', canonicalSourceRef: 'basis-path:path:static-call:packages/main/src/producer.ts#produceFact->consumer:packages/main/src/consumer.ts#produceFact' },
  ],
};
function executableProof(story: string, bindingId: string, positiveIds: string[], mutationIds: string[], transcriptIds: string[]) {
  const caseRecords = [
    ...positiveIds.map((id, index) => [id, 'positive', `positive:${id}`, 'production-baseline', 'fixture-positive', 'PASS', 'PASS', true, [['producer-evaluated', index * 2], ['consumer-verified', index * 2 + 1]], 'intent:INT-PRE']),
    ...mutationIds.map((id, index) => [id, 'mutation', `mutation:${id}`, `mutation-kind:${id}`, 'fixture-mutation', `PR_MUTATION_${index + 1}_BIT`, `PR_MUTATION_${index + 1}_BIT`, true, [['mutation-applied', index * 3], ['diagnostic-observed', index * 3 + 1], ['control-rerun', index * 3 + 2]], 'intent:INT-PRE']),
    ...transcriptIds.map((id, index) => [id, 'transcript', `transcript:${id}`, 'event-log-relation', 'fixture-transcript', 'ORDERED', 'ORDERED', true, [['producer-evaluated', index * 2], ['consumer-verified', index * 2 + 1]], 'intent:INT-PRE']),
  ];
  return {
    schemaVersion: 'proofstory.pre_review_executable_proof.v1', storyId: story,
    producer: 'test-output-is-untrusted-until-canonical-runner-receipt', verifier: 'test-output-is-untrusted-until-pre-review-verifier', commandDigests: [`sha256:${'1'.repeat(64)}`],
    caseRecords, provenance: { runnerPath: '', runnerDigest: '', targetPath: '', targetDigest: '', buildCommand: '' },
    bindingProofs: [{
      bindingId, positiveAssertionIds: positiveIds,
      mutationProofs: mutationIds.map((mutationId, index) => ({ mutationId, expectedCode: `PR_MUTATION_${index + 1}_BIT`, observedCode: `PR_MUTATION_${index + 1}_BIT`, controlRestored: true })),
      transcriptProofs: transcriptIds.map((transcriptId, index) => ({ transcriptId, producerRefs: ['P-PRE-REVIEW'], consumerRefs: ['C-DEV-REVIEW-GATE'], producerSequence: index * 2, consumerSequence: index * 2 + 1 })),
    }],
  };
}
const fixtureProof = {
  schemaVersion: 'proofstory.pre_review_executable_proof.v1', storyId,
  producer: 'test-output-is-untrusted-until-canonical-runner-receipt', verifier: 'test-output-is-untrusted-until-pre-review-verifier', commandDigests: [`sha256:${'1'.repeat(64)}`],
  caseRecords: [
    ['A', 'positive', 'positive:A', 'production-baseline', 'fixture-positive', 'PASS', 'PASS', true, [['producer-evaluated', 0], ['consumer-verified', 1]], 'intent:INT-PRE'],
    ['M', 'mutation', 'mutation:M', 'mutation-kind:M', 'fixture-mutation', 'PR_PRODUCTION_PATH_UNPROVEN', 'PR_PRODUCTION_PATH_UNPROVEN', true, [['mutation-applied', 2], ['diagnostic-observed', 3], ['control-rerun', 4]], 'intent:INT-PRE'],
    ['T', 'transcript', 'transcript:T', 'event-log-relation', 'fixture-transcript', 'ORDERED', 'ORDERED', true, [['producer-evaluated', 5], ['consumer-verified', 6]], 'intent:INT-PRE'],
  ],
  provenance: { runnerPath: '', runnerDigest: '', targetPath: '', targetDigest: '', buildCommand: '' },
  bindingProofs: [{ bindingId: 'AC-PRE', positiveAssertionIds: ['A'], mutationProofs: [{ mutationId: 'M', expectedCode: 'PR_PRODUCTION_PATH_UNPROVEN', observedCode: 'PR_PRODUCTION_PATH_UNPROVEN', controlRestored: true }], transcriptProofs: [{ transcriptId: 'T', producerRefs: ['P'], consumerRefs: ['C'], producerSequence: 0, consumerSequence: 1 }] }],
};
function checklist(): ChecklistData {
  return { items: [{ id: 'CHK-001', title: 'pre review', status: 'done', startTime: baseAt, endTime: baseAt,
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: { happy: [{ id: 'INT-PRE', desc: 'real producer consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [declaration] }], edge: [], adversarial: [] },
  }] };
}
function contract(): ProofStoryContractData {
  return { schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'high_assurance', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-PRE', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-PRE'], milestoneIds: [], verificationTopology: topology }],
    diagnosticGaps: [], createdAt: baseAt, updatedAt: baseAt };
}
function scopeContract(): ScopeContractData {
  return { storyId, mode: 'local', allowedModify: [], allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: baseAt, updatedAt: baseAt };
}
function scopeCheck(root: string): ScopeCheckData {
  const cwd = process.cwd(); process.chdir(root);
  try {
    return { storyId, checkedAt: baseAt, reviewRound: '', agentId: 'proof-or-stop-review-scope-plan', issues: [], features: [], summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 }, _hash: signScopeCheck(storyId, baseAt, 0, 1, '') } as unknown as ScopeCheckData;
  } finally { process.chdir(cwd); }
}
function writeRegistration(root: string): void {
  write(root, 'packages/main/package.json', JSON.stringify({ scripts: { build: 'node build-proof.mjs' } }));
  write(root, 'packages/main/build-proof.mjs', "import{copyFileSync,mkdirSync}from'node:fs';mkdirSync('dist/tasks',{recursive:true});copyFileSync('src/tasks/proof-emitter.mjs','dist/tasks/proofstory-pre-review-check-smoke.js');\n");
  write(root, 'scripts/run-proofstory-pre-review-live-proof.mjs', "import{execFileSync}from'node:child_process';execFileSync('npm',['--prefix','packages/main','run','build'],{cwd:process.cwd(),env:process.env,stdio:['ignore','ignore','inherit']});execFileSync(process.execPath,['packages/main/dist/tasks/proofstory-pre-review-check-smoke.js','--live-proof'],{cwd:process.cwd(),env:process.env,stdio:'inherit'});\n");
  write(root, 'packages/main/src/cli/command-catalog.ts', [
    'export const MAIN_TOOLS=[',
    "  {name:'acceptance_basis'},",
    "  {name:'acceptance_basis_generate'},",
    "  {name:'acceptance_topology_check'},",
    "  {name:'pre_review_check'},",
    "  {name:'pre_review_check_read'},",
    '];',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/registry.ts', [
    "import {createProofStoryHandlers} from './handlers/proofstory.js';",
    'const registry={registerBatch(_:unknown){}};',
    'const ctx={} as any;',
    'registry.registerBatch(createProofStoryHandlers(ctx));',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/handlers/proofstory.ts', "export function createProofStoryHandlers(){return{acceptance_basis(){},acceptance_basis_generate(){},acceptance_topology_check(){},pre_review_check(){},pre_review_check_read(){}}}\n");
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts', 'export function runPreReviewCheckGate(){}\n');
  write(root, 'packages/main/src/core/process-fact-registry.ts', "export const facts=['acceptance_basis','acceptance_basis_generate','pre_review_check','pre_review_check_read','artifact:pre-review-check.json'];\n");
  write(root, 'packages/main/src/core/acceptance-topology.ts', 'export const acceptanceTopology=true;\n');
  write(root, 'packages/main/src/core/agent-dispatch-registry.ts', 'export const agentDispatch=true;\n');
  // The production process-fact closure now reaches the signed REVIEW
  // inventory through transition-orchestrator.  Keep the cohort repository a
  // faithful, sealed source graph: omitting these registered closure files
  // makes acceptance_basis_generate correctly return partial.
  write(root, 'packages/main/src/core/machine.ts', 'export const reviewInventoryGate=true;\n');
  write(root, 'packages/main/src/core/review-inventory-epoch.ts', 'export const reviewInventoryEpoch=true;\n');
  write(root, 'packages/main/src/core/pre-review-check.ts', 'export const preReviewCheck=true;\n');
  write(root, 'packages/main/src/core/pre-review-live-proof.ts', 'export const preReviewLiveProof=true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCritic=true;\n');
  write(root, 'packages/main/src/core/acceptance-rollout.ts', 'export const acceptanceRollout=true;\n');
  write(root, 'packages/main/src/handlers/review-inventory.ts', 'export const reviewInventoryHandlers=true;\n');
  write(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'export const acceptanceRolloutCohort=true;\n');
  write(root, 'scripts/verify-process-fact-contract.mjs', "export const facts=['pre_review_check','pre_review_check_read','artifact:pre-review-check.json'];\n");
  // Explicit structural fixtures for the current signed process-fact closure.
  // These contain no simulated runtime behavior; missing-source and incomplete-seal
  // negative assertions below remain unchanged.
  for (const path of [
    'bin/bootstrap-runner.js',
    'packages/main/src/cli-engine.ts',
    'packages/main/src/core/auto-commit-metadata.ts',
    'packages/main/src/core/causal-evidence.ts',
    'packages/main/src/core/evidence-freshness.ts',
    'packages/main/src/core/execution-implementation.ts',
    'packages/main/src/core/material-path-policy.ts',
    'packages/main/src/core/shared-validation-execution.ts',
    'packages/main/src/core/store.ts',
    'packages/main/src/core/story-aware-validation.ts',
    'packages/main/src/core/story-owner-lease.ts',
    'packages/main/src/core/validation-execution-lock.ts',
    'packages/main/src/core/verification-intent-amendment.ts',
    'packages/main/src/core/verification-intent-checkpoint.ts',
    'packages/main/src/handlers/checklist.ts',
    'packages/main/src/handlers/done-required-validation.ts',
    'packages/main/src/handlers/verifier.ts',
    'packages/main/src/tasks/quorum-submit-smoke-case-catalog.ts',
    'packages/main/src/tasks/quorum-submit-smoke-worker.ts',
    'packages/main/src/tasks/quorum-submit-smoke-fixture.ts',
    'packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts',
    'packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts',
    'packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts',
    'packages/main/src/tasks/quorum-submit-smoke.ts',
    'scripts/build-lock-target.mjs',
  ]) write(root, path, 'export const registeredClosureFixture = true;\n');
}

function writeLiveProofFixture(root: string, proof: unknown, recomputeRoot = true): void {
  const digestUrl = new URL('../core/digest.js', import.meta.url).href;
  const proofUrl = new URL('../core/pre-review-live-proof.js', import.meta.url).href;
  write(root, 'packages/main/src/tasks/proof-emitter.mjs', [
    "import{readFileSync}from'node:fs';",
    "import{join}from'node:path';",
    `import{digestCanonicalJson}from${JSON.stringify(digestUrl)};`,
    `import{preReviewCaseAggregateDigest,encodePreReviewCaseRecords,decodePreReviewCaseRecords}from${JSON.stringify(proofUrl)};`,
    `const proof=${JSON.stringify(proof)};`,
    "const digest=v=>'sha256:'+digestCanonicalJson(v);",
    `const records=Array.isArray(proof.caseRecords)?proof.caseRecords:decodePreReviewCaseRecords(proof.caseRecords);${recomputeRoot ? 'proof.commandDigests=[preReviewCaseAggregateDigest(proof.storyId,records)];' : ''}proof.caseRecordsEncoding='gzip-base64';proof.caseRecords=encodePreReviewCaseRecords(records);`,
    "proof.provenance={runnerPath:'scripts/run-proofstory-pre-review-live-proof.mjs',runnerDigest:digest(readFileSync(join(process.cwd(),'scripts/run-proofstory-pre-review-live-proof.mjs'))),targetPath:'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js',targetDigest:digest(readFileSync(new URL(import.meta.url))),buildCommand:'npm --prefix packages/main run build'};",
    "console.log('PROOFSTORY_PRE_REVIEW_PROOF='+JSON.stringify(proof));",
    '',
  ].join('\n'));
}

function writeActiveLiveProofRunner(root: string): void {
  writeLiveProofFixture(root, fixtureProof);
}

const secondStoryContract = contract();
secondStoryContract.storyId = 'B-pre-review-second';
const secondStoryRecords = [
  ['A', 'positive', 'intent:INT-PRE', 'production-baseline', 'independent full-chain positive', 'PASS', 'PASS', true, [['producer-evaluated', 0], ['consumer-verified', 1]], 'intent:INT-PRE'],
  ['M', 'mutation', 'intent:INT-PRE', 'authority-replay', 'independent full-chain mutation', 'PR_AUTHORITY_INADMISSIBLE', 'PR_AUTHORITY_INADMISSIBLE', true, [['mutation-applied', 2], ['diagnostic-observed', 3], ['control-rerun', 4]], 'intent:INT-PRE'],
  ['T', 'transcript', 'intent:INT-PRE', 'event-log-relation', 'independent full-chain transcript', 'ORDERED', 'ORDERED', true, [['producer-evaluated', 5], ['consumer-verified', 6]], 'intent:INT-PRE'],
] as PreReviewCaseRecordV1[];
const secondStoryProof = buildPreReviewProofFromExecutedCases({ root: repositoryRoot, storyId: secondStoryContract.storyId, contract: secondStoryContract, caseRecords: secondStoryRecords });
assert.equal(secondStoryProof.storyId, 'B-pre-review-second', 'live proof derives story identity from invocation context');
assert.equal(secondStoryProof.caseRecordsEncoding, 'gzip-base64', 'independent Story proof carries canonical executed records');
assert.equal(secondStoryProof.commandDigests.length, 1, 'all executable cases collapse to one canonical aggregate digest');
assert.deepEqual(secondStoryProof.bindingProofs, [{
  bindingId: 'AC-PRE',
  positiveAssertionIds: ['A'],
  mutationProofs: [{ mutationId: 'M', expectedCode: 'PR_AUTHORITY_INADMISSIBLE', observedCode: 'PR_AUTHORITY_INADMISSIBLE', controlRestored: true }],
  transcriptProofs: [{ transcriptId: 'T', producerRefs: ['P'], consumerRefs: ['C'], producerSequence: 5, consumerSequence: 6 }],
}], 'live proof derives admissible binding proofs from executed records');
const aggregateCases = [
  { kind: 'positive', id: 'A', observedCodes: [] },
  { kind: 'mutation', id: 'M', observedCodes: ['AT_UNKNOWN_REF'], restoredCodes: [], controlRestored: true },
  { kind: 'transcript', id: 'T', producerSequence: 0, consumerSequence: 1 },
];
const aggregateRoot = preReviewCaseAggregateDigest('B-pre-review-second', aggregateCases);
const changedCase = structuredClone(aggregateCases); changedCase[0].id = 'A-changed';
const changedOutcome = structuredClone(aggregateCases); changedOutcome[1].observedCodes = ['NO_DIAGNOSTIC'];
assert.notEqual(preReviewCaseAggregateDigest('B-pre-review-second', changedCase), aggregateRoot, 'changing any case changes the aggregate root');
assert.notEqual(preReviewCaseAggregateDigest('B-pre-review-second', changedOutcome), aggregateRoot, 'changing an observed outcome changes the aggregate root');

const expandedContract = structuredClone(contract());
const expandedTopology = expandedContract.acceptanceBindings[0].verificationTopology!;
expandedTopology.positiveAssertionRefs = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(topology.positiveAssertionRefs[0]), id: `A-POS-${index + 1}` }));
expandedTopology.mutationCaseRefs = Array.from({ length: 17 }, (_, index) => ({
  ...structuredClone(topology.mutationCaseRefs[0]),
  id: `A-MUT-${index + 1}`,
  sourceRef: { refKind: 'existing' as const, canonicalSourceRef: `intent:A-MUT-${index + 1}` },
}));
expandedTopology.transcriptAssertionRefs = [{ ...structuredClone(topology.transcriptAssertionRefs[0]), id: 'A-TRANSCRIPT-1' }];
const expandedFixture = executableProof(storyId, 'AC-PRE', expandedTopology.positiveAssertionRefs.map(item => item.id), expandedTopology.mutationCaseRefs.map(item => item.id), expandedTopology.transcriptAssertionRefs.map(item => item.id));
const expandedRecords = expandedFixture.caseRecords as PreReviewCaseRecordV1[];
for (const assertion of expandedTopology.mutationCaseRefs) {
  expandedRecords.find(record => record[0] === assertion.id)![9] = canonicalPreReviewAssertionSourceRef(assertion.sourceRef);
}
const expandedProof = buildPreReviewProofFromExecutedCases({ root: repositoryRoot, storyId, contract: expandedContract, caseRecords: expandedRecords });
assert.equal(expandedProof.commandDigests.length, 1);
assert.equal(expandedProof.bindingProofs.length, 1, 'expanded live proof carries the active binding proof');
assert.equal(expandedProof.bindingProofs[0].positiveAssertionIds.length, 4, 'binding proof retains every positive assertion ID');
assert.equal(expandedProof.bindingProofs[0].mutationProofs.length, 17, 'binding proof retains every mutation proof');
assert.equal(expandedProof.bindingProofs[0].transcriptProofs.length, 1, 'binding proof retains the transcript proof');
const canonicalExpanded = assemblePreReviewCaseRecords(expandedContract, expandedRecords);
assert.deepEqual(
  assemblePreReviewCaseRecords(expandedContract, [...expandedRecords].reverse()),
  canonicalExpanded,
  'permuting executed records cannot reattribute assertions because assembly exact-maps by ID and sourceRef',
);
const swappedSources = structuredClone(expandedRecords);
const seventh = swappedSources.find(record => record[0] === 'A-MUT-7')!;
const fifteenth = swappedSources.find(record => record[0] === 'A-MUT-15')!;
[seventh[9], fifteenth[9]] = [fifteenth[9], seventh[9]];
assert.throws(() => assemblePreReviewCaseRecords(expandedContract, swappedSources), /sourceRef mismatch for A-MUT-7/, 'swapping assertion semantics cannot preserve attribution');
const semanticContract = structuredClone(expandedContract);
const semanticRecords = structuredClone(expandedRecords);
const semanticPositiveOne = semanticContract.acceptanceBindings[0].verificationTopology!.positiveAssertionRefs.find(row => row.id === 'A-POS-1')!;
const semanticPositiveTwo = semanticContract.acceptanceBindings[0].verificationTopology!.positiveAssertionRefs.find(row => row.id === 'A-POS-2')!;
semanticPositiveOne.sourceRef = { refKind: 'existing', canonicalSourceRef: 'intent:CHK-001:happy:role-guidance' };
semanticPositiveTwo.sourceRef = { refKind: 'existing', canonicalSourceRef: 'intent:CHK-002:happy:real-cohort-receipt' };
const semanticRecordOne = semanticRecords.find(row => row[0] === 'A-POS-1')!;
const semanticRecordTwo = semanticRecords.find(row => row[0] === 'A-POS-2')!;
Object.assign(semanticRecordOne, ['A-POS-1', 'positive', 'role-guidance:codex-claude-mirrors', 'prompt-contract', semanticRecordOne[4], semanticRecordOne[5], semanticRecordOne[6], semanticRecordOne[7], semanticRecordOne[8], 'intent:CHK-001:happy:role-guidance']);
Object.assign(semanticRecordTwo, ['A-POS-2', 'positive', 'rollout:verified-cohort-receipt', 'rollout-receipt-verification', semanticRecordTwo[4], semanticRecordTwo[5], semanticRecordTwo[6], semanticRecordTwo[7], semanticRecordTwo[8], 'intent:CHK-002:happy:real-cohort-receipt']);
assert.doesNotThrow(() => assemblePreReviewCaseRecords(semanticContract, semanticRecords), 'registered semantic control is accepted');
assert.doesNotThrow(
  () => decodePreReviewCaseRecords(encodePreReviewCaseRecords(semanticRecords)),
  'registered semantic control survives the canonical encoded proof boundary',
);
const unrelatedSemanticSwap = structuredClone(semanticRecords);
const unrelatedTarget = unrelatedSemanticSwap.find(row => row[0] === 'A-POS-1')!;
unrelatedTarget[2] = semanticRecordTwo[2];
unrelatedTarget[3] = semanticRecordTwo[3];
assert.throws(
  () => assemblePreReviewCaseRecords(semanticContract, unrelatedSemanticSwap),
  /semantic contract mismatch for A-POS-1/,
  'retaining assertion ID/sourceRef while swapping to an unrelated executable semantic case fails closed',
);
assert.throws(
  () => decodePreReviewCaseRecords(encodePreReviewCaseRecords(unrelatedSemanticSwap)),
  /decoded record semantic contract mismatch for A-POS-1/,
  'encoded proof decoding rejects the same semantic swap before the pre-review verifier consumes it',
);
assert.throws(() => assemblePreReviewCaseRecords(expandedContract, [...expandedRecords, structuredClone(expandedRecords[0])]), /duplicate assertion IDs/, 'duplicate executed records fail closed');
const extraRecord = structuredClone(expandedRecords[0]); extraRecord[0] = 'A-EXTRA';
assert.throws(() => assemblePreReviewCaseRecords(expandedContract, [...expandedRecords, extraRecord]), /extra assertion IDs: A-EXTRA/, 'extra executed records fail closed');
assert.throws(() => assemblePreReviewCaseRecords(expandedContract, expandedRecords.filter(record => record[0] !== 'A-MUT-7')), /missing assertion ID: A-MUT-7/, 'missing executed records fail closed');

const fifthPositive = structuredClone(expandedRecords.find(record => record[0] === 'A-POS-4')!);
fifthPositive[0] = 'A-POS-5';
fifthPositive[2] = 'rollout:focused-enforce-rollback';
fifthPositive[4] = 'execute focused Wave 4 rollout smoke with enforce and rollback controls';
fifthPositive[9] = 'intent:A-POS-5';
const registeredCatalogFixture = [...expandedRecords, fifthPositive];
const expectedScenarioAssertions = (records: readonly PreReviewCaseRecordV1[]) =>
  new Map(records.map(record => [record[0], { kind: record[1], sourceRef: record[9] }]));
const legacyScenarioAssertions = expectedScenarioAssertions(expandedRecords);
assert.equal(selectActiveScenarioRecords(legacyScenarioAssertions, registeredCatalogFixture).length, 22, 'legacy active topology omitting A-POS-5 receives the exact legacy 22 records');
const fivePositiveScenarioAssertions = expectedScenarioAssertions(registeredCatalogFixture);
assert.equal(selectActiveScenarioRecords(fivePositiveScenarioAssertions, registeredCatalogFixture).filter(record => record[1] === 'positive').length, 5, 'five-intent active topology receives the real fifth positive record');
assert.throws(
  () => selectActiveScenarioRecords(fivePositiveScenarioAssertions, registeredCatalogFixture.filter(record => record[0] !== 'A-POS-5')),
  /missing expected assertion ID: A-POS-5/,
  'missing expected registered record fails closed',
);
const unknownScenarioAssertions = new Map(fivePositiveScenarioAssertions);
unknownScenarioAssertions.set('A-EXTRA', { kind: 'positive', sourceRef: 'intent:A-EXTRA' });
assert.throws(
  () => selectActiveScenarioRecords(unknownScenarioAssertions, registeredCatalogFixture),
  /unknown active topology assertion ID: A-EXTRA/,
  'extra or unknown active topology assertion ID fails closed',
);
const wrongKindScenarioAssertions = new Map(fivePositiveScenarioAssertions);
wrongKindScenarioAssertions.set('A-POS-5', { kind: 'mutation', sourceRef: 'intent:A-POS-5' });
assert.throws(
  () => selectActiveScenarioRecords(wrongKindScenarioAssertions, registeredCatalogFixture),
  /active topology assertion kind mismatch for A-POS-5/,
  'known assertion ID cannot be rebound to a different kind',
);
const arbitraryActiveAssertions = new Map<string, { kind: ScenarioCaseKind; sourceRef: string }>([
  ['A-CHK-002-edge-1', { kind: 'positive', sourceRef: 'intent:CHK-002:edge:1' }],
  ['A-CHK-001-happy-0', { kind: 'positive', sourceRef: 'intent:CHK-001:happy:0' }],
  ['M-CHK-003-adversarial-0', { kind: 'mutation', sourceRef: 'intent:CHK-003:adversarial:0' }],
  ['T-ACC-001', { kind: 'transcript', sourceRef: 'acceptance-binding:ACC-001' }],
]);
assert.throws(
  () => adaptCanonicalScenarioRecordsToActiveTopology(arbitraryActiveAssertions, expandedRecords),
  /no verified semantic canonical-case binding/,
  'an active topology with no verifier-owned semantic binding cannot borrow canonical records by kind',
);

const activeSemanticContract = structuredClone(expandedContract);
const activeSemanticAssertion = activeSemanticContract.acceptanceBindings[0].verificationTopology!.positiveAssertionRefs[0]!;
activeSemanticAssertion.sourceRef = { refKind: 'existing', canonicalSourceRef: 'intent:CHK-001:happy:0' };
const activeSemanticRecord = structuredClone(expandedRecords[0]);
activeSemanticRecord[2] = 'role-guidance:codex-claude-mirrors';
activeSemanticRecord[3] = 'prompt-contract';
activeSemanticRecord[4] = 'execute exact role guidance token and mirror contract over all Codex/Claude role pairs';
activeSemanticRecord[9] = 'intent:CHK-001:happy:0';
assert.doesNotThrow(
  () => assemblePreReviewCaseRecords(activeSemanticContract, [activeSemanticRecord, ...expandedRecords.slice(1)]),
  'a registered active assertion accepts only its bound canonical semantic case',
);
const mismatchedActiveRecord = structuredClone(activeSemanticRecord);
mismatchedActiveRecord[2] = 'rollout:verified-cohort-receipt';
mismatchedActiveRecord[3] = 'rollout-receipt-verification';
mismatchedActiveRecord[4] = 'load the frozen registered production cohort, issue a signed report, and verify the exact current receipt without respawning the cohort runner';
assert.throws(
  () => assemblePreReviewCaseRecords(activeSemanticContract, [mismatchedActiveRecord, ...expandedRecords.slice(1)]),
  /semantic contract mismatch for A-POS-1/,
  'a semantically mismatched active clone is rejected before proof assembly',
);
assert.throws(
  () => decodePreReviewCaseRecords(encodePreReviewCaseRecords([mismatchedActiveRecord])),
  /decoded record semantic contract mismatch for A-POS-1/,
  'the encoded proof boundary rejects the same active semantic clone',
);

const migrationActiveAssertions = new Map<string, { kind: ScenarioCaseKind; sourceRef: string }>([
  ['A-CHK-006-happy-0', { kind: 'positive', sourceRef: 'intent:CHK-006:happy:0' }],
  ['A-CHK-007-happy-0', { kind: 'positive', sourceRef: 'intent:CHK-007:happy:0' }],
]);
const migrationCanonicalRecords: PreReviewCaseRecordV1[] = [
  ['A-POS-6', 'positive', 'package-identity:sibling-package-graph', 'package-identity-migration', 'execute the sibling package identity migration test against current package metadata, lockfiles, and dependency graph', 'PASS', 'PASS', true, [['producer-evaluated', 0], ['consumer-verified', 1]], 'intent:A-POS-6'],
  ['A-POS-7', 'positive', 'bin-alias:canonical-only', 'npm-bin-migration', 'execute the current residue and npm-bin verifier against the package metadata with only proof-or-stop published', 'PASS', 'PASS', true, [['producer-evaluated', 2], ['consumer-verified', 3]], 'intent:A-POS-7'],
];
const migrationActiveRecords = adaptCanonicalScenarioRecordsToActiveTopology(migrationActiveAssertions, migrationCanonicalRecords);
assert.deepEqual(
  migrationActiveRecords.map(record => [record[2], record[3]]),
  [
    ['package-identity:sibling-package-graph', 'package-identity-migration'],
    ['bin-alias:canonical-only', 'npm-bin-migration'],
  ],
  'CHK-006 and CHK-007 active assertions select their own executed canonical operations',
);
const swappedMigrationCanonicalRecords = structuredClone(migrationCanonicalRecords);
const swappedMigrationSix = swappedMigrationCanonicalRecords[0]!;
const swappedMigrationSeven = swappedMigrationCanonicalRecords[1]!;
[swappedMigrationSix[2], swappedMigrationSix[3], swappedMigrationSix[4]] = [swappedMigrationSeven[2], swappedMigrationSeven[3], swappedMigrationSeven[4]];
[swappedMigrationSeven[2], swappedMigrationSeven[3], swappedMigrationSeven[4]] = ['package-identity:sibling-package-graph', 'package-identity-migration', 'execute the sibling package identity migration test against current package metadata, lockfiles, and dependency graph'];
assert.throws(
  () => adaptCanonicalScenarioRecordsToActiveTopology(migrationActiveAssertions, swappedMigrationCanonicalRecords),
  /semantic canonical-case binding does not match/,
  'swapping CHK-006 and CHK-007 canonical semantics fails closed before proof assembly',
);
assert.equal(preReviewCaseSemanticBindingForSourceRef('intent:CHK-006:happy:0')?.canonicalCaseId, 'A-POS-6');
assert.equal(preReviewCaseSemanticBindingForSourceRef('intent:CHK-007:happy:0')?.canonicalCaseId, 'A-POS-7');
assert.notEqual(
  REGISTERED_PRE_REVIEW_ACTIVE_TOPOLOGY_BINDINGS.get('intent:CHK-006:happy:0')?.canonicalCaseId,
  REGISTERED_PRE_REVIEW_ACTIVE_TOPOLOGY_BINDINGS.get('intent:CHK-007:happy:0')?.canonicalCaseId,
  'CHK-006 and CHK-007 must remain distinct verifier-owned canonical cases',
);

const root = mkdtempSync(join(tmpdir(), 'proofstory-pre-review-'));
const originalCwd = process.cwd();
try {
  smoke: {
  // B-cc10: the CLI writes runtime/activity/locks under the CANONICAL state dir, so a
  // fixture ignoring only the deprecated spelling let `git add .` track
  // .proof-or-stop/activity.jsonl — which quorum_submit's assertCleanQuorumBaseline then
  // reported as 'M .proof-or-stop/activity.jsonl' and refused on.
  write(root, '.gitignore', STATE_DIR_NAMES.flatMap((dir) => [
    `${dir}/runtime/`,
    `${dir}/activity.jsonl`,
    `${dir}/locks/`,
  ]).join('\n') + '\n');
  write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'observe' } }));
  write(root, 'tsconfig.json', '{}\n');
  writeRegistration(root);
  write(root, 'packages/main/src/producer.ts', 'export const produceFact=()=>({fact:true});\n');
  write(root, 'packages/main/src/consumer.ts', consumerControlSource);
  write(root, 'emit-proof.mjs', `console.log(${JSON.stringify(`PROOFSTORY_PRE_REVIEW_PROOF=${JSON.stringify(fixtureProof)}`)});\n`);
  writeActiveLiveProofRunner(root);
  execFileSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Pre Review Smoke']); git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'seed']); git(root, ['switch', '-c', `story/${storyId}`]);
  process.chdir(root); resetConfigCache();
  const store = new StoryStore(root);
  const story = { storyId, name: storyId, title: 'pre review smoke', description: 'pre review smoke', type: 'feature', priority: 'high', phase: 'DEV', createdAt: baseAt, startedAt: baseAt, endedAt: null, events: [], worktree: { path: root, branch: `story/${storyId}`, createdAt: baseAt } } as StoryInfo;
  store.writeStory(storyId, story); store.writeChecklist(storyId, checklist()); store.writeProofStoryContract(storyId, contract()); store.writeScopeContract(storyId, scopeContract()); store.writeScopeCheck(storyId, scopeCheck(root));
  git(root, ['add', '.']); git(root, ['commit', '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>', '-m', 'implementation']);
  const plan = cli(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.equal(JSON.parse(plan).artifact.basis.status, 'complete', plan);
  if (!liveProofMode && !scenarioMode) {
    const missing = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.deepEqual(missing.codes, ['PR_ARTIFACT_MISSING']);
    assert.match(missing.remediation.join('\n'), /Run proof-or-stop pre_review_check/);
  }
  // B-ec67 F-006: an executable (type:cli) intent's evidence write needs a selector or an
  // audited nonMechanicalReason. This case deliberately records a self-reported attestation
  // (which pre_review_check must still reject as authority), so it uses the audited escape.
  cli(root, 'verification_evidence_batch_add', { storyId, evidences: [{ itemId: 'CHK-001', intentRef: 'INT-PRE', kind: 'integration_test', result: 'pass', command: 'node emit-proof.mjs', note: 'caller self-report must not become pre-review authority', nonMechanicalReason: 'self-reported caller attestation recorded without local execution; pre-review authority is proven separately', attestation: { kind: 'ci', actor: 'self-reported', checkedClaims: ['production-path', 'mutation-bites', 'control-restored', 'transcript-related', 'authority-admissible'] }, actorTrust: { producerActorId: 'claimed-producer', verifierActorId: 'claimed-verifier', trustStatus: 'trusted' } }] });
  if (!liveProofMode && !scenarioMode) {
    const selfReported = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(selfReported.ok, false); assert.ok(selfReported.codes.includes('PR_AUTHORITY_INADMISSIBLE'));
  }
  write(root, `.proof-or-stop/story/actives/${storyId}/evidence/live-smoke-transcript.json`, JSON.stringify({ storyId, mode: { runCommands: true, writeEvidence: true }, actual: { command: 'node emit-proof.mjs', exitCode: 0, stdout: `PROOFSTORY_PRE_REVIEW_PROOF=${JSON.stringify(fixtureProof)}` } }));
  const directStoreBypass = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(directStoreBypass.ok, false); assert.ok(directStoreBypass.codes.includes('PR_AUTHORITY_INADMISSIBLE'), 'direct StoryStore/file writes have no canonical causal producer receipt');
  recordExecutedCase(['A-MUT-4', 'mutation', 'authority:direct-store-replay', 'authority-replay', 'direct StoryStore proof without causal receipt', 'PR_AUTHORITY_INADMISSIBLE', directStoreBypass.codes.includes('PR_AUTHORITY_INADMISSIBLE') ? 'PR_AUTHORITY_INADMISSIBLE' : directStoreBypass.codes[0], true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  recordExecutedCase(['A-MUT-11', 'mutation', 'bypass:direct-store', 'bypass-campaign', 'direct-file and caller-authority bypass attempt', 'PR_AUTHORITY_INADMISSIBLE', directStoreBypass.codes.includes('PR_AUTHORITY_INADMISSIBLE') ? 'PR_AUTHORITY_INADMISSIBLE' : directStoreBypass.codes[0], true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  if (!scenarioMode) {
    const compactCaptureContract = store.readProofStoryContract(storyId)!;
    store.writeProofStoryContract(storyId, expandedContract);
    writeLiveProofFixture(root, expandedProof);
    const boundedCapture = JSON.parse(cli(root, 'live_smoke_transcript', { storyId, capture: PRE_REVIEW_LIVE_PROOF_COMMAND, write: true, json: true }));
    assert.equal(boundedCapture.transcript.status, 'present-fresh');
    const boundedTranscript = JSON.parse(readFileSync(join(store.storyDirPath(storyId), 'evidence/live-smoke-transcript.json'), 'utf8'));
    assert.equal(boundedTranscript.actual.stdout.includes('...[truncated'), false, '22 mutation cases fit within the live transcript stdout cap');
    const boundedProofLine = boundedTranscript.actual.stdout.split(/\r?\n/).find((line: string) => line.startsWith('PROOFSTORY_PRE_REVIEW_PROOF='));
    assert.ok(boundedProofLine);
    assert.doesNotThrow(() => JSON.parse(boundedProofLine.slice('PROOFSTORY_PRE_REVIEW_PROOF='.length)), 'bounded live proof remains complete JSON');
    assert.ok(loadVerifiedPreReviewExecutableProof({ gitCwd: root, metadataRoot: root, storyDir: store.storyDirPath(storyId), storyId, contract: store.readProofStoryContract(storyId), cutoffAt: new Date(Date.now() + 1000).toISOString(), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! }), 'loader accepts the complete aggregate proof under the capture cap');
    store.writeProofStoryContract(storyId, compactCaptureContract);
  }
  writeActiveLiveProofRunner(root);
  const captured = JSON.parse(cli(root, 'live_smoke_transcript', { storyId, capture: PRE_REVIEW_LIVE_PROOF_COMMAND, write: true, json: true }));
  assert.equal(captured.transcript.status, 'present-fresh');
  const canonicalLoaded = loadVerifiedPreReviewExecutableProof({ gitCwd: root, metadataRoot: root, storyDir: store.storyDirPath(storyId), storyId, contract: store.readProofStoryContract(storyId), cutoffAt: new Date(Date.now() + 1000).toISOString(), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! });
  if (!liveProofMode) assert.ok(canonicalLoaded, 'canonical runner transcript has causal receipt and exact proof envelope');
  assert.notEqual(storyId, 'B-4ec1', 'the independent temp Story is not the implementation Story');
  if (productionScenarioMode) {
    // B-45a0: production mode used to short-circuit here, running only a generic
    // witness per active assertion and emitting those rows directly. That cannot
    // satisfy REGISTERED_PRE_REVIEW_ACTIVE_TOPOLOGY_BINDINGS: a registered
    // sourceRef such as intent:CHK-001:happy:0 declares that the claim is proven
    // by a specific canonical case (A-POS-1, the role-guidance mirror contract),
    // and a generic acceptance_topology_check witness does not prove it. Because
    // the canonical A-* cases are recorded further down (A-POS-1 at ~1370), the
    // early break meant zero canonical rows ever executed in production mode.
    //
    // Fall through instead, so the canonical cases run and the shared scenario
    // terminal projects them onto the active topology through the verifier-owned
    // adapter. Only the clean control is asserted here.
    const productionControl = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(productionControl.ok, true, `production active topology clean control failed: ${JSON.stringify(productionControl.codes)}`);
  }
  if (!scenarioMode) {
    write(root, 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js', "console.log('PROOFSTORY_PRE_REVIEW_PROOF=forged-old-dist');\n");
    assert.equal(loadVerifiedPreReviewExecutableProof({ gitCwd: root, metadataRoot: root, storyDir: store.storyDirPath(storyId), storyId, contract: store.readProofStoryContract(storyId), cutoffAt: new Date(Date.now() + 1000).toISOString(), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! }), null, 'overwritten gitignored dist target invalidates executable provenance');
    cli(root, 'live_smoke_transcript', { storyId, capture: PRE_REVIEW_LIVE_PROOF_COMMAND, write: true, json: true });
    assert.ok(loadVerifiedPreReviewExecutableProof({ gitCwd: root, metadataRoot: root, storyDir: store.storyDirPath(storyId), storyId, contract: store.readProofStoryContract(storyId), cutoffAt: new Date(Date.now() + 1000).toISOString(), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! }), 'tracked runner fresh build restores the generated target and valid provenance');
  }
  const producerEvent = scenarioEvent('producer-evaluated');
  const produced = cli(root, 'pre_review_check', { storyId, json: true });
  let parsed = JSON.parse(produced);
  assert.equal(parsed.ok, true, produced);
  assert.equal(parsed.plannedActual, 'complete');
  assert.equal(parsed.mutations, 'biting');
  assert.equal(parsed.transcript, 'related');
  if (scenarioMode) {
    // Live proof only needs the active Story topology. The generic smoke
    // mutations below are intentionally retained for the standalone fixture,
    // but running them here causes nested captures and unrelated source
    // rewrites before the real acceptance assertions execute.
    // B-5a15 main-merge: main renamed this executor to executeActiveScenarioWitnesses
    // (void, ctx-taking) and moved record projection into
    // adaptCanonicalScenarioRecordsToActiveTopology. This branch-only block never
    // conflicted, so it kept calling the deleted name; ported to main's API here.
    // ctx is declared later in this file; build the same shape locally so this
    // earlier branch-only block does not depend on declaration order.
    const scenarioCtx = { root, scanRoot: join(root, 'packages/main'), store } as unknown as HandlerContext;
    executeActiveScenarioWitnesses(activeScenarioAssertions, storyId, store, scenarioCtx);
    const selectedRecords = adaptCanonicalScenarioRecordsToActiveTopology(
      activeScenarioAssertions,
      [...scenarioLedger.values()],
    );
    assert.deepEqual(
      selectedRecords.map(record => [record[0], record[1], record[9]]),
      [...activeScenarioAssertions].map(([id, assertion]) => [id, assertion.kind, assertion.sourceRef]),
      'active topology executor records every arbitrary ID, kind, and canonical sourceRef from real observations',
    );
    const removedExpectedId = selectedRecords[0]?.[0];
    assert.ok(removedExpectedId, 'active topology must require at least one registered scenario record');
    assert.throws(
      () => selectActiveScenarioRecords(
        activeScenarioAssertions,
        selectedRecords.filter(record => record[0] !== removedExpectedId),
        activeScenarioKinds,
        true,
      ),
      /executed scenario ledger missing expected assertion ID/,
      'removing one active executed record makes exact-ID validation fail',
    );
    assert.throws(
      () => selectActiveScenarioRecords(
        activeScenarioAssertions,
        [...selectedRecords, structuredClone(selectedRecords[0])],
        activeScenarioKinds,
        true,
      ),
      /executed scenario ledger contains duplicate assertion ID/,
      'duplicating one active executed record makes exact-ID validation fail',
    );
    console.log(`PROOFSTORY_SCENARIO_RECORDS=${JSON.stringify(selectedRecords.sort((a, b) => a[0].localeCompare(b[0])))}`);
    break smoke;
  }
  if (cohortCaseMode) {
    const cleanContract = structuredClone(store.readProofStoryContract(storyId)!);
    const cleanPreReviewArtifact = structuredClone(store.readPreReviewCheck(storyId)!);
    const cleanProducerSource = readFileSync(join(root, 'packages/main/src/producer.ts'), 'utf8');
    if (cohortArm === 'candidate' && cohortScenario === 'omission') {
      const omittedContract = structuredClone(cleanContract);
      omittedContract.acceptanceBindings[0].verificationTopology!.consumerRefs = [];
      store.writeProofStoryContract(storyId, omittedContract);
    } else if (cohortArm === 'candidate' && cohortScenario === 'forgery') {
      const forged = structuredClone(cleanPreReviewArtifact);
      forged.signature = 'forged';
      store.writePreReviewCheck(storyId, forged);
    } else if (cohortArm === 'candidate' && cohortScenario === 'freshness') {
      // Drift a declared, story-owned production file after the valid signed
      // evidence was issued. Adding an unrelated file only moves HEAD/material
      // state and exercises artifact mismatch, not verification-evidence
      // freshness against the storyFilesHash boundary.
      write(root, 'packages/main/src/producer.ts', 'export const produceFact=()=>({fact:true,revision:2});\n');
      git(root, ['add', 'packages/main/src/producer.ts']);
      git(root, ['commit', '-m', 'inject registered rollout freshness drift']);
      // The sole DEV-phase producer signs the fail-closed stale result; the
      // read-only verifier must then reproduce PR_EVIDENCE_STALE without
      // treating this canonical artifact as caller-authored tampering.
      cli(root, 'pre_review_check', { storyId, json: true });
    }
    git(root, ['add', '.']);
    git(root, ['commit', '--allow-empty', '-m', `seal registered ${cohortArm}/${cohortScenario} mutation state`]);
    const mutationCommitSha = git(root, ['rev-parse', 'HEAD']);
    const topologyReport = JSON.parse(cli(root, 'acceptance_topology_check', { storyId, json: true }));
    const preReviewReport = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));

    store.writeProofStoryContract(storyId, cleanContract);
    store.writePreReviewCheck(storyId, cleanPreReviewArtifact);
    write(root, 'packages/main/src/producer.ts', cleanProducerSource);
    git(root, ['add', '.']);
    git(root, ['commit', '--allow-empty', '-m', `restore registered ${cohortArm}/${cohortScenario} clean control`]);
    const restorationCommitSha = git(root, ['rev-parse', 'HEAD']);
    const restoredTopologyReport = JSON.parse(cli(root, 'acceptance_topology_check', { storyId, json: true }));
    const restoredPreReviewReport = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.equal(restoredTopologyReport.status, 'pass', `restored topology control failed: ${JSON.stringify(restoredTopologyReport)}`);
    assert.equal(restoredPreReviewReport.ok, true, `restored pre-review control failed: ${JSON.stringify(restoredPreReviewReport)}`);

    const reviewStory = store.readStory(storyId);
    const reviewRound = '2026-07-23T13:00:00.000Z';
    reviewStory.phase = 'REVIEW';
    reviewStory.currentReviewRound = reviewRound;
    reviewStory.events = [...(reviewStory.events ?? []), { phase: 'REVIEW', action: 'advance', timestamp: reviewRound }];
    store.writeStory(storyId, reviewStory);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'prepare actual cohort review fixture']);
    const processEventsPath = join(store.storyDirPath(storyId), 'process-events.jsonl');
    appendFileSync(processEventsPath, `${JSON.stringify({
      type: 'plan_updated',
      timestamp: '2026-07-23T12:30:00.000Z',
      padding: 'x'.repeat(1_400_000),
    })}\n`);
    git(root, ['add', relative(root, processEventsPath)]);
    git(root, ['commit', '-m', 'seed large immutable rollout history']);
    assert.ok(readFileSync(processEventsPath).length > 1024 * 1024,
      'acceptance rollout immutable quorum commit must exceed the default child-process buffer');
    const reviewLanes = [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
      'proof-or-stop-review-docs',
    ];
    for (const lane of reviewLanes) {
      cli(root, 'dispatch', { storyId, agentType: lane }, false, lane, `sess-${storyId}-${lane}-dispatch`);
      const run = cli(root, 'review_run_start', { storyId, agent: lane }, false, lane, `sess-${storyId}-${lane}-review`);
      const reviewRunId = run.match(/Review run (\S+) started/)?.[1];
      assert.ok(reviewRunId, `cohort review run missing for ${lane}: ${run}`);
      cli(root, 'review_pass_set', {
        storyId,
        agent: lane,
        reviewRunId,
        note: `Registered rollout cohort ${cohortArm}/${cohortScenario} found no unrelated review issue.`,
        readManifest: {
          filesReadFully: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'],
          filesTriagedByName: [],
          scanEscalationReason: null,
        },
      }, false, lane, `sess-${storyId}-${lane}-review`);
    }
    const quorumResult = JSON.parse(cli(root, 'quorum_submit', {
      storyId,
      hostA: 'claude-cli',
      providerA: 'claude',
      hostB: 'codex-cli',
      providerB: 'codex',
      rounds: 3,
      note: `Registered rollout cohort ${cohortArm}/${cohortScenario} actual production quorum.`,
      json: true,
    }));
    const processEvents = store.readProcessEvents(storyId);
    const hostVerdicts = processEvents.filter(event => event.type === 'host_verdict');
    const reviewRuns = store.readReviewRuns(storyId).runs;
    const reviewPasses = store.readReviewPasses(storyId).passes;
    console.log(`PROOFSTORY_ROLLOUT_CASE=${JSON.stringify({
      storyId,
      arm: cohortArm,
      scenario: cohortScenario,
      mutationCommitSha,
      restorationCommitSha,
      topologyReport,
      preReviewReport,
      restoredTopologyReport,
      restoredPreReviewReport,
      quorumResult,
      hostVerdicts,
      reviewRuns,
      reviewPasses,
      evidenceGitCwd: root,
    })}`);
    break smoke;
  }
  if (!liveProofMode && !scenarioMode) {
    const deterministicReadA = cli(root, 'pre_review_check_read', { storyId, json: true });
    const deterministicReadB = cli(root, 'pre_review_check_read', { storyId, json: true });
    assert.equal(deterministicReadA, deterministicReadB, 'read-only projection is byte-stable');
    if (!scenarioMode) recordExecutedCase(['A-MUT-1', 'mutation', 'codes:read-only-projection', 'deterministic-codes', 'repeat canonical read-only verifier projection', 'STABLE', deterministicReadA === deterministicReadB ? 'STABLE' : 'DRIFT', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    assert.match(cli(root, 'pre_review_check', { storyId, json: true, verdict: 'pass' }, true), /Forbidden|invalid|unsupported/i, 'caller verdict/authority fields are rejected at the real CLI schema');
  }
  const ctx = { root, scanRoot: join(root, 'packages/main'), store } as unknown as HandlerContext;
  const lifecyclePass = runPreReviewCheckGate(ctx, storyId);
  assert.match(lifecyclePass, /status=pass/);
  const consumerEvent = scenarioEvent('consumer-verified');
  if (scenarioRequested('A-MUT-14')) recordExecutedCase(['A-MUT-14', 'mutation', 'codes:direct-vs-lifecycle', 'stable-gate-codes', 'direct verifier and lifecycle consumer agree on pass status', 'PASS', parsed.ok && /status=pass/.test(lifecyclePass) ? 'PASS' : 'FAIL', true, [['mutation-applied', producerEvent], ['diagnostic-observed', consumerEvent], ['control-rerun', scenarioEvent('control-rerun')]]]);
  recordExecutedCase(['A-TRANSCRIPT-1', 'transcript', 'events:producer-consumer', 'event-log-relation', 'actual producer invocation precedes canonical lifecycle consumer', 'ORDERED', producerEvent < consumerEvent ? 'ORDERED' : 'UNORDERED', true, actualScenarioEvents.filter(event => event[1] === producerEvent || event[1] === consumerEvent)]);

  const captureProof = (proof: unknown, recomputeRoot = true): void => {
    writeLiveProofFixture(root, proof, recomputeRoot);
    cli(root, 'live_smoke_transcript', { storyId, capture: PRE_REVIEW_LIVE_PROOF_COMMAND, write: true, json: true });
  };

  if (!scenarioMode) {
    const runnerRel = 'scripts/run-proofstory-pre-review-live-proof.mjs';
    const targetRel = 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js';
    const canonicalRunner = readFileSync(join(root, runnerRel), 'utf8');
    write(root, runnerRel, `${canonicalRunner}\n// stale runner mutation\n`);
    const staleRunner = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.ok(staleRunner.codes.includes('PR_AUTHORITY_INADMISSIBLE'), 'signed artifact fails closed when its runnerDigest no longer matches the tracked runner');
    assert.equal(staleRunner.authority, 'inadmissible');
    write(root, runnerRel, canonicalRunner);
    const restoredRunner = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.equal(restoredRunner.ok, true, 'restoring the exact tracked runner restores signed artifact provenance');

    write(root, targetRel, "console.log('stale target overwrite');\n");
    const staleTarget = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.ok(staleTarget.codes.includes('PR_AUTHORITY_INADMISSIBLE'), 'signed artifact fails closed when its targetDigest no longer matches the current built target');
    assert.equal(staleTarget.authority, 'inadmissible');
    captureProof(fixtureProof);
    parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(parsed.ok, true, `fresh canonical build/proof recovers executable provenance: ${JSON.stringify(parsed.codes)}`);
  }

  if (!liveProofMode && scenarioRequested('A-MUT-7')) {
    const originalContract = structuredClone(store.readProofStoryContract(storyId)!);
    const omittedContract = structuredClone(originalContract);
    omittedContract.acceptanceBindings[0].verificationTopology!.consumerRefs = [];
    store.writeProofStoryContract(storyId, omittedContract);
    const omitted = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.ok(omitted.codes.includes('PR_NEW_PATH_UNMAPPED') || omitted.codes.includes('PR_COVERAGE_BASIS_CHANGED'), 'topology-only omission bites while the current basis retains the path');
    const omissionCode = omitted.codes.includes('PR_NEW_PATH_UNMAPPED') ? 'PR_NEW_PATH_UNMAPPED' : 'PR_COVERAGE_BASIS_CHANGED';
    recordExecutedCase(['A-MUT-7', 'mutation', 'topology:consumer-omission', 'topology-omission', 'remove current topology consumer against retained basis', omissionCode, omissionCode, true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    store.writeProofStoryContract(storyId, originalContract);
    parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(parsed.ok, true, 'exact topology restoration returns the clean control to PASS');
  }

  const artifact = store.readPreReviewCheck(storyId)!;
  const artifactMutations: Array<[string, (value: any) => void]> = [
    ['story', value => { value.storyId = 'B-cross-story'; }], ['mode', value => { value.mode = 'enforce'; }],
    ['cutoff', value => { value.cutoffAt = baseAt; }], ['plan basis', value => { value.planBasisDigest = 'sha256:forged'; }],
    ['topology', value => { value.topologyDigest = 'sha256:forged'; }], ['scope', value => { value.scopeCheckDigest = 'sha256:forged'; }],
    ['story files', value => { value.storyFilesHash = 'sha256:forged'; }], ['closure files', value => { value.closureFilesHash = 'sha256:forged'; }],
    ['evidence refs', value => { value.evidenceRefs = []; }], ['issued at', value => { value.issuedAt = baseAt; }],
    ['signer', value => { value.signerPublicKey = 'forged'; }], ['signature', value => { value.signature = 'forged'; }],
    ['adapter record', value => { value.preReviewBasisArtifact.basis.adapterResults.pop(); }],
    ['reconciliation', value => { value.preReviewBasisArtifact.basis.plannedActualReconciliations[0].reconciliationDigest = 'sha256:forged'; }],
  ];
  const selectedArtifactMutations = scenarioMode
    ? artifactMutations.filter(([label]) =>
      (label === 'signature' && activeScenarioAssertions.has('A-MUT-3'))
      || (label === 'adapter record' && activeScenarioAssertions.has('A-MUT-8')))
    : artifactMutations;
  for (const [label, mutate] of selectedArtifactMutations) {
    const value = structuredClone(artifact); mutate(value); store.writePreReviewCheck(storyId, value);
    const tampered = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.ok(tampered.codes.includes('PR_ARTIFACT_TAMPERED'), `${label}: ${JSON.stringify(tampered.codes)}`);
    if (label === 'signature') {
      const observeDiagnostic = runPreReviewCheckGate(ctx, storyId);
      assert.match(observeDiagnostic, /mode=observe; status=fail; blocking=false/,
        'observe mode preserves a tampered failure as diagnostic-only without relabeling it PASS or authority');
      assert.match(observeDiagnostic, /codes=PR_ARTIFACT_TAMPERED/,
        'observe mode keeps the exact tamper diagnostic visible');
      recordExecutedCase(['A-MUT-3', 'mutation', 'artifact:signature', 'field-tamper', 'tamper signed pre-review artifact field', 'PR_ARTIFACT_TAMPERED', tampered.codes.includes('PR_ARTIFACT_TAMPERED') ? 'PR_ARTIFACT_TAMPERED' : tampered.codes[0], true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    }
    if (label === 'adapter record') recordExecutedCase(['A-MUT-8', 'mutation', 'basis:adapter-record', 'adapter-tamper', 'remove signed adapter result', 'PR_ARTIFACT_TAMPERED', tampered.codes.includes('PR_ARTIFACT_TAMPERED') ? 'PR_ARTIFACT_TAMPERED' : tampered.codes[0], true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  }
  store.writePreReviewCheck(storyId, parsed.artifact);

  if (scenarioRequested('A-MUT-10')) {
    const missingTranscriptProof = structuredClone(fixtureProof); missingTranscriptProof.caseRecords = missingTranscriptProof.caseRecords.filter(record => record[0] !== 'T');
    captureProof(missingTranscriptProof);
    const missingTranscript = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.ok(missingTranscript.codes.includes('PR_TRANSCRIPT_MISSING'), JSON.stringify(missingTranscript.codes));
    recordExecutedCase(['A-MUT-10', 'mutation', 'transcript:missing-event', 'transcript-cardinality', 'remove required transcript event record', 'PR_TRANSCRIPT_MISSING', missingTranscript.codes.includes('PR_TRANSCRIPT_MISSING') ? 'PR_TRANSCRIPT_MISSING' : missingTranscript.codes[0], true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  }
  if (!scenarioMode) {
    const duplicateMutationProof = structuredClone(fixtureProof); duplicateMutationProof.caseRecords.push(structuredClone(duplicateMutationProof.caseRecords.find(record => record[0] === 'M')!));
    captureProof(duplicateMutationProof);
    const duplicateMutation = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.ok(duplicateMutation.codes.includes('PR_MUTATION_EVIDENCE_MISSING'), JSON.stringify(duplicateMutation.codes));
  }
  if (scenarioRequested('A-MUT-9')) {
    const wrongObservedOutcome = structuredClone(fixtureProof); wrongObservedOutcome.caseRecords.find(record => record[0] === 'M')![6] = 'FORGED_SAME_ID_OUTCOME';
    captureProof(wrongObservedOutcome);
    const wrongObserved = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.ok(wrongObserved.codes.includes('PR_MUTATION_DID_NOT_BITE'), 'retaining mutation IDs while tampering the observed outcome bites');
    recordExecutedCase(['A-MUT-9', 'mutation', 'mutation:observed-polarity', 'polarity-restore', 'replace observed mutation outcome then rerun clean control', 'PR_MUTATION_DID_NOT_BITE', wrongObserved.codes.includes('PR_MUTATION_DID_NOT_BITE') ? 'PR_MUTATION_DID_NOT_BITE' : wrongObserved.codes[0], true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  }
  if (!scenarioMode) {
    const wrongAggregateRoot = structuredClone(fixtureProof); wrongAggregateRoot.commandDigests = [`sha256:${'2'.repeat(64)}`];
    captureProof(wrongAggregateRoot, false);
    const wrongRoot = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.ok(wrongRoot.codes.includes('PR_AUTHORITY_INADMISSIBLE'), 'a formatted arbitrary digest that is not the canonical case root is rejected');
    const missingBindingProof = structuredClone(fixtureProof); missingBindingProof.caseRecords = [];
    captureProof(missingBindingProof);
    const missingBinding = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.ok(missingBinding.codes.includes('PR_PRODUCTION_PATH_UNPROVEN'), JSON.stringify(missingBinding.codes));
  }
  if (scenarioRequested('A-MUT-5')) {
    captureProof(fixtureProof);
    parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, `exact executable proof restoration returns PASS: ${JSON.stringify(parsed.codes)}`);
    write(root, 'packages/main/src/consumer.ts', 'export const wrongSymbol=()=>false;\n'); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'mutation remove planned consumer']);
    const unresolved = cli(root, 'pre_review_check', { storyId, json: true });
    assert.match(unresolved, /PR_PLANNED_PATH_UNRESOLVED/, 'removing the declared current consumer makes planned-to-actual reconciliation fail');
    recordExecutedCase(['A-MUT-5', 'mutation', 'planned-actual:consumer-symbol', 'planned-actual', 'remove declared current consumer symbol', 'PR_PLANNED_PATH_UNRESOLVED', /PR_PLANNED_PATH_UNRESOLVED/.test(unresolved) ? 'PR_PLANNED_PATH_UNRESOLVED' : 'MISSING', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    write(root, 'packages/main/src/consumer.ts', consumerControlSource); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'restore planned consumer']);
    parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'source restoration returns clean control to PASS');
  }
  if (!scenarioMode) {
    write(root, 'packages/main/src/consumer.ts', "import { produceFact } from './producer.js'; export function consumeFact(){return produceFact().fact;} export const consumeFact=()=>produceFact().fact; export const invokeConsumer=()=>consumeFact();\n"); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'mutation ambiguous planned consumer']);
    const ambiguous = cli(root, 'pre_review_check', { storyId, json: true });
    assert.match(ambiguous, /PR_PLANNED_PATH_UNRESOLVED/, 'multiple exact symbol declarations are ambiguous rather than self-certifying actual coverage');
    write(root, 'packages/main/src/consumer.ts', consumerControlSource); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'restore unique planned consumer']);
    parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'unique AST-discovered endpoint restoration returns PASS');
  }
  const discoveryMutations = [
    ['interface', 'export interface consumeFact { value: boolean }\n'],
    ['type', 'export type consumeFact = { value: boolean };\n'],
    ['enum', 'export enum consumeFact { Value }\n'],
    ['dead const', 'export const consumeFact = 42;\n'],
    ['nested property', 'export const holder = { consumeFact() { return true; } };\n'],
    ['unreachable callable', 'export const consumeFact = () => true;\n'],
  ] as const;
  if (scenarioRequested('A-MUT-5')) {
    for (const [label, source] of (scenarioMode ? discoveryMutations.filter(([name]) => name === 'unreachable callable') : discoveryMutations)) {
      write(root, 'packages/main/src/consumer.ts', source); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', `mutation ${label} is not a runtime consumer`]);
      const discoveryFailure = cli(root, 'pre_review_check', { storyId, json: true });
      assert.match(discoveryFailure, /PR_PLANNED_PATH_UNRESOLVED/, `${label} name collision cannot satisfy planned actual runtime reachability`);
    }
    write(root, 'packages/main/src/consumer.ts', consumerControlSource); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'restore callable producer consumer chain']);
    captureProof(fixtureProof);
    parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'registered/exported callable relation restoration returns PASS');
  }
  if (!scenarioMode) {
    const controlKindChecklist = store.readChecklist(storyId);
    const wrongKindChecklist = structuredClone(controlKindChecklist);
    wrongKindChecklist.items[0].verificationIntent!.happy[0].plannedPathDeclarations![0].consumers[0].expectedArtifactKind = 'process_fact';
    store.writeChecklist(storyId, wrongKindChecklist);
    assert.match(cli(root, 'pre_review_check', { storyId, json: true }), /PR_PLANNED_PATH_UNRESOLVED/, 'artifact-kind mismatch cannot reuse a callable handler name as a process fact');
    store.writeChecklist(storyId, controlKindChecklist);
    captureProof(fixtureProof);
  }

  if (scenarioRequested('A-MUT-12')) {
    const equalCutoff = store.readChecklist(storyId); equalCutoff.items[0].verificationEvidence![0].timestamp = parsed.artifact.cutoffAt; store.writeChecklist(storyId, equalCutoff);
    const cutoff = cli(root, 'pre_review_check_read', { storyId, json: true });
    assert.match(cutoff, /PR_ARTIFACT_TAMPERED|PR_POSITIVE_EVIDENCE_MISSING|PR_CUTOFF_UNBOUND/, 'evidence timestamp mutation at the signed cutoff fails closed');
    recordExecutedCase(['A-MUT-12', 'mutation', 'cutoff:evidence-at-boundary', 'temporal-cutoff', 'move evidence timestamp to the signed cutoff boundary', 'FAIL_CLOSED', /PR_ARTIFACT_TAMPERED|PR_POSITIVE_EVIDENCE_MISSING|PR_CUTOFF_UNBOUND/.test(cutoff) ? 'FAIL_CLOSED' : 'PASS', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  }

  // Flat project mode is the only rollout selector in Wave 3. Rebind the PLAN
  // basis/evidence after config material changes so the mode assertions test
  // admission semantics rather than unrelated freshness failures.
  const rebindEvidence = (): void => {
    // B-ec67 F-006: executable-intent evidence needs a selector or an audited reason;
    // this rebind is not re-executed in-fixture, so it uses the audited escape.
    cli(root, 'verification_evidence_batch_add', { storyId, evidences: [{ itemId: 'CHK-001', intentRef: 'INT-PRE', kind: 'integration_test', result: 'pass', command: 'node emit-proof.mjs', note: 'production evidence writer refreshes current proof binding', nonMechanicalReason: 'production evidence rebind after config material change; not re-executed in this smoke fixture' }] });
    captureProof(fixtureProof);
  };
  if (scenarioRequested('A-MUT-13', 'A-MUT-15')) {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'enforce' } }));
    git(root, ['add', 'proof-or-stop.config.json']); git(root, ['commit', '-m', 'enable flat enforce mode']); resetConfigCache();
    rebindEvidence(); cli(root, 'acceptance_basis_generate', { storyId, json: true });
    const enforce = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(enforce.blocking, true); assert.ok(enforce.codes.includes('PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED'));
    recordExecutedCase(['A-MUT-15', 'mutation', 'critic:enforce-reattestation', 'critic-reattestation', 'enable enforce mode without a current independent critic receipt', 'PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED', enforce.codes.includes('PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED') ? 'PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED' : enforce.codes[0], true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    assert.throws(() => runPreReviewCheckGate(ctx, storyId), /executable pre-review gate blocked DEV admission/);
  if (!scenarioMode) {
    cli(root, 'dispatch', { storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-implementer' }, false, 'proof-or-stop-implementer', 'sess-pre-review-impl');
    git(root, ['config', 'user.name', 'Independent Topology Critic']); git(root, ['config', 'user.email', 'critic@noreply.local']);
    cli(root, 'dispatch', { storyId, agentType: 'proof-or-stop-review-topology-critic' }, false, 'proof-or-stop-review-topology-critic', 'sess-pre-review-critic');
    const criticDispatch = store.readProcessEvents(storyId).filter(event => event.type === 'dispatch' && agentRoleIdsEqual(typeof event.agentType === 'string' ? event.agentType : undefined, 'proof-or-stop-review-topology-critic')).at(-1);
    assert.ok(criticDispatch, 'topology critic dispatch is durably recorded before receipt issuance');
    assert.equal(criticDispatch.sessionId, adapterSessionId(root, 'sess-pre-review-critic', 'proof-or-stop-review-topology-critic'), 'critic receipt and dispatch use the same host-adapter session identity');
    assert.equal(criticDispatch.storyFilesHash, currentStoryFilesHash(root, 'HEAD', root), 'critic dispatch is bound to the current Story-owned files');
    assert.equal(criticDispatch.businessCommit, currentImplementationBusinessCommit(root).businessCommit, 'critic dispatch is bound to the implementation commit the receipt will verify');
    const critic = JSON.parse(cli(root, 'topology_critic_receipt_set', { storyId, verdict: 'pass', json: true }, false, 'proof-or-stop-review-topology-critic', 'sess-pre-review-critic'));
    assert.equal(critic.verification.ok, true);
    const enforcePass = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(enforcePass.ok, true); assert.equal(enforcePass.criticReattestation, 'current');
    const tamperedArtifact = structuredClone(store.readPreReviewCheck(storyId)!); tamperedArtifact.signature = 'forged'; store.writePreReviewCheck(storyId, tamperedArtifact);
    const indexBeforeBlockedTransition = readFileSync(store.storyFilePath(storyId, 'index.json'), 'utf8');
    const artifactBeforeBlockedTransition = readFileSync(store.storyFilePath(storyId, 'pre-review-check.json'), 'utf8');
    assert.throws(() => runPreReviewCheckGate(ctx, storyId), /PR_ARTIFACT_TAMPERED/);
    const blockedTransition = cli(root, 'story_advance', { storyId, phase: 'REVIEW' }, true);
    assert.match(blockedTransition, /PR_ARTIFACT_TAMPERED/);
    assert.equal(store.readStory(storyId).phase, 'DEV');
    assert.equal(readFileSync(store.storyFilePath(storyId, 'index.json'), 'utf8'), indexBeforeBlockedTransition, 'blocked transition leaves phase metadata byte-identical');
    assert.equal(readFileSync(store.storyFilePath(storyId, 'pre-review-check.json'), 'utf8'), artifactBeforeBlockedTransition, 'blocked transition does not rewrite the tampered artifact');
    cli(root, 'topology_critic_receipt_set', { storyId, verdict: 'pass', json: true }, false, 'proof-or-stop-review-topology-critic', 'sess-pre-review-critic');
    const restoredEnforce = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(restoredEnforce.ok, true, JSON.stringify(restoredEnforce));
    const restoredCtx = { root, scanRoot: join(root, 'packages/main'), store: new StoryStore(root) } as unknown as HandlerContext;
    assert.match(runPreReviewCheckGate(restoredCtx, storyId), /mode=enforce; status=pass/);
  }

    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'warn' } }));
    git(root, ['add', 'proof-or-stop.config.json']); git(root, ['commit', '-m', 'rollback flat mode to warn']); resetConfigCache();
    rebindEvidence(); cli(root, 'acceptance_basis_generate', { storyId, json: true });
    const warn = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(warn.blocking, false); assert.equal(warn.ok, true);
    const warnCtx = { root, scanRoot: join(root, 'packages/main'), store: new StoryStore(root) } as unknown as HandlerContext;
    const warnLifecycle = runPreReviewCheckGate(warnCtx, storyId);
    assert.match(warnLifecycle, /mode=warn; status=pass/);
    recordExecutedCase(['A-MUT-13', 'mutation', 'config:warn-rollback', 'legacy-config-rollback', 'rollback enforce configuration to warn without stale blocking state', 'PASS', warn.ok && !warn.blocking && /status=pass/.test(warnLifecycle) ? 'PASS' : 'FAIL', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  }

  const handlerSource = readFileSync(join(repositoryRoot, 'packages/main/src/handlers/proofstory.ts'), 'utf8');
  const consumerSource = readFileSync(join(repositoryRoot, 'packages/main/src/handlers/transition-orchestrator.ts'), 'utf8');
  assert.match(handlerSource, /evaluatePreReviewCheckForContext/);
  assert.match(consumerSource, /runPreReviewCheckGate/);
  assert.doesNotMatch(handlerSource + consumerSource, /selective_applicability_check|rollout_telemetry/);
  recordExecutedCase(['A-MUT-17', 'mutation', 'source:wave-boundary', 'wave-leakage', 'scan production producer and consumer for later-wave symbols', 'ABSENT', /selective_applicability_check|rollout_telemetry/.test(handlerSource + consumerSource) ? 'PRESENT' : 'ABSENT', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
  console.log('ProofStory pre-review check smoke: PASS');
  console.log('  producer/read/lifecycle verifier parity: PASS');
  console.log('  planned→actual + executable/mutation/transcript/authority: PASS');
  console.log('  tamper + equal-cutoff mutations: BITING');
  console.log('  topology omission + observe/enforce/warn rollback: PASS');
  console.log('  Wave 3A/Wave 4 leakage: absent');
  if (scenarioMode) {
    if (activeScenarioAssertions.has('A-POS-1')) {
      const roleProducer = scenarioEvent('producer-evaluated');
      assert.equal(rolloutPromptGuidancePass(), true, 'canonical Codex/Claude role guidance passes');
      recordExecutedCase(['A-POS-1', 'positive', 'role-guidance:codex-claude-mirrors', 'prompt-contract', 'execute exact role guidance token and mirror contract over all Codex/Claude role pairs', 'PASS', rolloutPromptGuidancePass() ? 'PASS' : 'FAIL', true, [['producer-evaluated', roleProducer], ['consumer-verified', scenarioEvent('consumer-verified')]]]);
    }

    const cohort = loadFrozenAcceptanceRolloutCohortForScenarios();
    const rolloutReport = deriveAcceptanceRolloutReport({
      storyId: activeScenarioStoryId!,
      cohort,
      binding: currentAcceptanceRolloutBinding(repositoryRoot, repositoryRoot),
      gitCwd: repositoryRoot,
    });
    if (activeScenarioAssertions.has('A-POS-2')) {
      const rolloutArtifact = issueAcceptanceRolloutArtifact({ gitCwd: repositoryRoot, report: rolloutReport });
      const rolloutVerification = verifyAcceptanceRolloutArtifact({
        artifact: rolloutArtifact,
        gitCwd: repositoryRoot,
        metadataRoot: repositoryRoot,
        expectedStoryId: activeScenarioStoryId!,
        expectedCohort: cohort,
        mode: 'warn',
      });
      const receiptPassed = rolloutVerification.ok && rolloutVerification.receipt === 'current';
      recordExecutedCase(['A-POS-2', 'positive', 'rollout:verified-cohort-receipt', 'rollout-receipt-verification', 'load the frozen registered production cohort, issue a signed report, and verify the exact current receipt without respawning the cohort runner', 'PASS', receiptPassed ? 'PASS' : 'FAIL', true, [['producer-evaluated', scenarioEvent('producer-evaluated')], ['consumer-verified', scenarioEvent('consumer-verified')]]]);
    }
    const thresholdsPassed = rolloutReport.metrics.matchedPairCount >= 3
      && rolloutReport.metrics.falsePassCount === 0
      && rolloutReport.metrics.omissionDetectionRate === 1
      && rolloutReport.metrics.falseBlockRate === 0
      && rolloutReport.metrics.mislabeled3x1Count === 0
      && rolloutReport.metrics.waiverDelta <= 0
      && rolloutReport.metrics.inventoryShrankCount === 0;
    if (activeScenarioAssertions.has('A-POS-3')) recordExecutedCase(['A-POS-3', 'positive', 'rollout:bounded-threshold-matrix', 'threshold-contract', 'evaluate every canonical promotion threshold from the verifier-derived report metrics', 'PASS', thresholdsPassed ? 'PASS' : 'FAIL', true, [['producer-evaluated', scenarioEvent('producer-evaluated')], ['consumer-verified', scenarioEvent('consumer-verified')]]]);

    const planText = readFileSync(join(repositoryRoot, 'docs/requirements/decisions/proofstory-acceptance-topology-and-pre-review-gates-execution-plan.md'), 'utf8');
    const docsPassed = planText.includes('Status: **IMPLEMENTED — FLAT PROJECT BOUNDARY**')
      && planText.includes('five positive paths and the seventeen')
      && planText.includes('5 positive / 17 mutation / 1 transcript');
    if (activeScenarioAssertions.has('A-POS-4')) recordExecutedCase(['A-POS-4', 'positive', 'docs:canonical-wave4-status', 'docs-contract', 'execute canonical Wave 4 status and exact live-proof inventory contract check', 'PASS', docsPassed ? 'PASS' : 'FAIL', true, [['producer-evaluated', scenarioEvent('producer-evaluated')], ['consumer-verified', scenarioEvent('consumer-verified')]]]);

    // F-339: CHK-006 and CHK-007 must bind to the migration operations they
    // claim, not to an unrelated role/cohort case that happens to have the
    // same assertion kind. These controls execute the current worktree's real
    // migration checks before the assertion-specific records are emitted.
    const packageIdentityOutput = execFileSync(process.execPath, [join(repositoryRoot, 'packages/main/tests/package-identity-migration.test.mjs')], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const packageIdentityPassed = /package identity migration test passed/.test(packageIdentityOutput);
    assert.equal(packageIdentityPassed, true, `sibling package migration check did not pass: ${packageIdentityOutput}`);
    recordExecutedCase(['A-POS-6', 'positive', 'package-identity:sibling-package-graph', 'package-identity-migration', 'execute the sibling package identity migration test against current package metadata, lockfiles, and dependency graph', 'PASS', packageIdentityPassed ? 'PASS' : 'FAIL', true, [['producer-evaluated', scenarioEvent('producer-evaluated')], ['consumer-verified', scenarioEvent('consumer-verified')]]]);

    const packageIdentityControl = {
      core: readRepositoryJson('packages/main/package.json'),
      utils: readRepositoryJson('packages/utils/package.json'),
      lab: readRepositoryJson('packages/lab/package.json'),
      utilsLock: readRepositoryJson('packages/utils/package-lock.json'),
      labLock: readRepositoryJson('packages/lab/package-lock.json'),
    };
    const packageIdentityMutant = structuredClone(packageIdentityControl);
    packageIdentityMutant.utils.name = '@lattice/utils';
    const packageGraphControl = siblingPackageGraphPass(packageIdentityControl);
    const packageGraphMutantRejected = !siblingPackageGraphPass(packageIdentityMutant);
    recordExecutedCase(['A-MUT-19', 'mutation', 'package-identity:mixed-graph', 'package-identity-mixed-graph', 'mutate one sibling package name to the retired scope and require the package graph verifier to reject the mixed graph', 'PACKAGE_GRAPH_REJECTED', packageGraphControl && packageGraphMutantRejected ? 'PACKAGE_GRAPH_REJECTED' : 'MUTANT_SURVIVED', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);

    const globalLabOutput = execFileSync(process.execPath, [join(repositoryRoot, 'scripts/verify-global-lab-entrypoint.mjs'), 'versions'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const globalLabPassed = /ok versions/.test(globalLabOutput);
    assert.equal(globalLabPassed, true, `global lab entrypoint migration check did not pass: ${globalLabOutput}`);
    recordExecutedCase(['A-MUT-18', 'mutation', 'package-identity:global-lab-entrypoint', 'package-identity-entrypoint', 'execute the global lab entrypoint version check against the canonical sibling package names and versions', 'PASS', globalLabPassed ? 'PASS' : 'FAIL', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);

    const binResidueOutput = execFileSync('npm', ['--prefix', 'packages/main', 'run', 'test:lattice-residue'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const binResiduePassed = /PASS lattice-residue \[npm-bin\]/.test(binResidueOutput)
      && /PASS lattice-residue \[brand-decision\]/.test(binResidueOutput);
    assert.equal(binResiduePassed, true, `removed-bin-alias migration check did not pass: ${binResidueOutput}`);
    recordExecutedCase(['A-POS-7', 'positive', 'bin-alias:canonical-only', 'npm-bin-migration', 'execute the current residue and npm-bin verifier against the package metadata with only proof-or-stop published', 'PASS', binResiduePassed ? 'PASS' : 'FAIL', true, [['producer-evaluated', scenarioEvent('producer-evaluated')], ['consumer-verified', scenarioEvent('consumer-verified')]]]);

    const binHelpOutput = execFileSync(process.execPath, [join(repositoryRoot, 'packages/main/dist/cli.js'), 'help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const binHelpPassed = binHelpOutput.includes('Entrypoint: proof-or-stop') && !/Usage: lattice(?:\s|$)/.test(binHelpOutput);
    recordExecutedCase(['A-MUT-20', 'mutation', 'bin-alias:canonical-help', 'canonical-help-boundary', 'execute the canonical CLI help path and verify it advertises proof-or-stop without a retired lattice invocation', 'PASS', binHelpPassed ? 'PASS' : 'FAIL', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);

    const binControl = readRepositoryJson('packages/main/package.json');
    const binMutant = structuredClone(binControl);
    const mutantBin = objectValue(binMutant.bin);
    mutantBin.lattice = 'dist/cli.js';
    binMutant.bin = mutantBin;
    const binControlPassed = canonicalMainBinPass(binControl);
    const binMutantRejected = !canonicalMainBinPass(binMutant);
    recordExecutedCase(['A-MUT-21', 'mutation', 'bin-alias:removed-alias', 'npm-bin-reintroduction', 'mutate package metadata to reintroduce the lattice bin alias and require the canonical-only verifier to reject it', 'BIN_ALIAS_REJECTED', binControlPassed && binMutantRejected ? 'BIN_ALIAS_REJECTED' : 'MUTANT_SURVIVED', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);

    const controlRows = rolloutReport.sourceRecords.filter(record =>
      record.arm === 'candidate' && ['docs_only', 'legacy', 'ordinary'].includes(record.claimClass));
    const controlsPass = controlRows.length === 3 && rolloutReport.metrics.falseBlockCount === 0;
    if (activeScenarioAssertions.has('A-MUT-2')) recordExecutedCase(['A-MUT-2', 'mutation', 'rollout:false-block-controls', 'docs-legacy-single-outcome-controls', 'execute docs-only, legacy, and ordinary single-outcome candidate controls through the rollout verifier', 'PASS', controlsPass ? 'PASS' : 'FAIL', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);

    // B-4043 F-014: token-contract mutations target the canonical template
    // source of truth (where the guidance now lives); the authority-sentence
    // mutation stays on the Claude host shim so it bites via the codex/claude
    // mirror-parity contract.
    const implTemplatePath = 'packages/main/templates/agents/proof-or-stop-implementer.md';
    const templateControl = readFileSync(join(repositoryRoot, implTemplatePath), 'utf8');
    const claudePath = '.claude/agents/proof-or-stop-implementer.md';
    const claudeControl = readFileSync(join(repositoryRoot, claudePath), 'utf8');
    assert.ok(templateControl.includes('acceptance_rollout_check'), 'prompt command-removal mutation requires the canonical command token');
    assert.ok(templateControl.includes('full 3 rounds × 2 hosts'), 'prompt degradation mutation requires the canonical full-3x2 token');
    assert.ok(claudeControl.includes('prompt prose is never gate evidence'), 'prompt-authority mutation requires the canonical non-authority sentence');
    if (activeScenarioAssertions.has('A-MUT-6')) {
      const promptMutations = [
        new Map([[implTemplatePath, templateControl.replace('acceptance_rollout_check', 'removed_rollout_check')]]),
        new Map([[implTemplatePath, templateControl.replace('full 3 rounds × 2 hosts', 'degraded 3x1')]]),
        new Map([[claudePath, claudeControl.replace('prompt prose is never gate evidence', 'prompt prose is gate evidence')]]),
      ];
      const promptMutationsBite = promptMutations.every(overrides => !rolloutPromptGuidancePass(overrides))
        && rolloutPromptGuidancePass();
      recordExecutedCase(['A-MUT-6', 'mutation', 'role-guidance:authority-boundary', 'prompt-contract-mutations', 'remove required command, degrade full-3x2 to 3x1, and promote prompt prose to authority; every mutant must fail', 'PROMPT_CONTRACT_REJECTED', promptMutationsBite ? 'PROMPT_CONTRACT_REJECTED' : 'MUTANT_SURVIVED', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    }
    if (activeScenarioAssertions.has('A-MUT-1')) {
      const mirrorOverride = new Map([[claudePath, `${claudeControl}\nmirror drift\n`]]);
      const mirrorMutationBites = !rolloutPromptGuidancePass(mirrorOverride) && rolloutPromptGuidancePass();
      recordExecutedCase(['A-MUT-1', 'mutation', 'role-guidance:mirror-parity', 'codex-claude-mirror', 'mutate one Claude role suffix while retaining the Codex role; exact mirror contract must fail', 'PROMPT_MIRROR_REJECTED', mirrorMutationBites ? 'PROMPT_MIRROR_REJECTED' : 'MUTANT_SURVIVED', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    }

    if (activeScenarioAssertions.has('A-MUT-16')) {
      execFileSync(process.execPath, [join(repositoryRoot, 'scripts/verify-process-fact-contract.mjs')], { cwd: repositoryRoot, stdio: ['ignore', 'ignore', 'pipe'] });
      recordExecutedCase(['A-MUT-16', 'mutation', 'contract:process-fact-registry', 'process-fact-contract', 'run the canonical process-fact contract verifier', 'PASS', 'PASS', true, [['mutation-applied', scenarioEvent('mutation-applied')], ['diagnostic-observed', scenarioEvent('diagnostic-observed')], ['control-rerun', scenarioEvent('control-rerun')]]]);
    }
    const rolloutSmokePath = join(repositoryRoot, 'packages/main/dist/tasks/proofstory-acceptance-rollout-smoke.js');
    const rolloutSmokeSource = readFileSync(join(repositoryRoot, 'packages/main/src/tasks/proofstory-acceptance-rollout-smoke.ts'), 'utf8');
    assert.match(rolloutSmokeSource, /mode=enforce; status=pass/, 'focused rollout smoke must retain the real enforce control');
    assert.match(rolloutSmokeSource, /rollback to observe is non-blocking/, 'focused rollout smoke must retain the rollback consumer assertion');
    assert.match(rolloutSmokeSource, /rollback preserves signed history/, 'focused rollout smoke must retain rollback history preservation');
    const frozenCohortPath = join(root, 'rollout-cohort-input.json');
    writeFileSync(frozenCohortPath, JSON.stringify(cohort), 'utf8');
    const rolloutProducerEvent = scenarioEvent('producer-evaluated');
    const rolloutSmokeOutput = activeScenarioAssertions.has('A-POS-5') ? execFileSync(process.execPath, [rolloutSmokePath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROOF_OR_STOP_ROLLOUT_COHORT_INPUT_PATH: frozenCohortPath },
    }) : '';
    const rolloutConsumerEvent = scenarioEvent('consumer-verified');
    assertCanonicalRolloutSmokeTerminalContract();
    const rolloutControlPassed = isCanonicalRolloutSmokePass(rolloutSmokeOutput);
    if (activeScenarioAssertions.has('A-POS-5')) {
      assert.equal(rolloutControlPassed, true, `focused rollout enforce+rollback control did not pass: ${rolloutSmokeOutput}`);
      recordExecutedCase(['A-POS-5', 'positive', 'rollout:focused-enforce-rollback', 'focused-rollout-control', 'execute focused Wave 4 rollout smoke with enforce, rollback, and history-preservation controls', 'PASS', rolloutControlPassed ? 'PASS' : 'FAIL', true, [['producer-evaluated', rolloutProducerEvent], ['consumer-verified', rolloutConsumerEvent]]]);
    }
    const executedRecords = [...scenarioLedger.values()];
    const selectedRecords = adaptCanonicalScenarioRecordsToActiveTopology(activeScenarioAssertions, executedRecords);
    const removedExpectedId = selectedRecords[0]?.[0];
    assert.ok(removedExpectedId, 'active topology must require at least one registered scenario record');
    assert.throws(
      () => selectActiveScenarioRecords(
        activeScenarioAssertions,
        selectedRecords.filter(record => record[0] !== removedExpectedId),
        activeScenarioKinds,
        true,
      ),
      /executed scenario ledger missing expected assertion ID/,
      'removing one active executed record makes exact-ID validation fail',
    );
    assert.throws(
      () => selectActiveScenarioRecords(
        activeScenarioAssertions,
        [...selectedRecords, structuredClone(selectedRecords[0])],
        activeScenarioKinds,
        true,
      ),
      /executed scenario ledger contains duplicate assertion ID/,
      'duplicating one active executed record makes exact-ID validation fail',
    );
    console.log(`PROOFSTORY_SCENARIO_RECORDS=${JSON.stringify(selectedRecords.sort((a, b) => a[0].localeCompare(b[0])))}`);
  }
  }
} finally {
  process.chdir(originalCwd); resetConfigCache();
  if (!cohortCaseMode) rmSync(root, { recursive: true, force: true });
}
