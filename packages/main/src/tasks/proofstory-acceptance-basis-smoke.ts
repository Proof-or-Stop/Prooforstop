#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptanceCoverageBasisSemanticDigest,
  deriveAcceptanceCoverageBasis,
  derivePlannedCoveragePaths,
  computeClosureFilesHash,
  digestAcceptanceCoverageBasis,
  foundationalExclusionDecisionRef,
  reconcileTopologyWithCoverageBasis,
  verifyAcceptanceCoverageBasis,
} from '../core/acceptance-coverage-basis.js';
import {
  MAX_PROOF_OR_STOP_CONFIG_BYTES,
  detectAcceptanceDiscoverySupport,
  reconcileAcceptanceDiscoveryResults,
  deriveRegisteredProcessFactClosure,
  digestCoverageAdapterResult,
  enumerateBoundedSourceTree,
  readBoundedSourceSetForTest,
  runAcceptanceDiscoveryAdapters,
  runAcceptanceDiscoverySnapshot,
} from '../core/acceptance-discovery-adapters.js';
import { verifyAcceptanceBasisReceipt } from '../core/acceptance-basis-receipt.js';
import { digestCanonicalJson } from '../core/digest.js';
import { generateEd25519KeyPair, signCanonical } from '../core/authority-signing.js';
import { PROCESS_FACT_REGISTRY } from '../core/process-fact-registry.js';
import { resetConfigCache } from '../core/config.js';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import type { HandlerContext } from '../handlers/context.js';
import type {
  AcceptanceBasisArtifactV1,
  AcceptanceVerificationTopologyV1,
  ChecklistData,
  DecisionData,
  ProofStoryContractData,
  ScopeCheckData,
  ScopeContractData,
  StoryInfo,
} from '../core/types.js';
import { signScopeCheck } from '../handlers/scope-check.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(packageRoot, '../../..');
const cliPath = join(packageRoot, 'cli.js');
const probeOptions=process.argv.slice(2);
assert.ok(probeOptions.length<=1&&probeOptions.every(arg=>/^--probe-jobs=[1-4]$/.test(arg)),'INVALID_ACCEPTANCE_PROBE_JOBS');
const probeJobs=Number(probeOptions[0]?.slice('--probe-jobs='.length)??'1');
const execFileAsync=promisify(execFile);
const storyId = 'B-basis-smoke';
const now = '2026-07-22T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

/**
 * Every source a PROCESS_FACT_REGISTRY entry declares as its producer or
 * consumer implementation.
 *
 * `buildBoundedSourceGraph` reports a missing declared ref of a REACHED entry
 * as `uninspectable registered source ...`, which seals as `snapshot_missing`
 * and drops the basis from `complete` to `partial`. Reading that set from the
 * registry itself is what stops these fixtures from silently going partial the
 * next time an entry declares a new source: B-bcae CHK-004 recovered from
 * exactly that, when runtime:evidence_hash_input_boundary and
 * runtime:shared_validation_execution added six refs the hand-written stub list
 * below did not know about.
 */
export function registryDeclaredSourceRefs(): string[] {
  const refs = new Set<string>();
  for (const entry of PROCESS_FACT_REGISTRY) {
    for (const ref of [...(entry.producerSourceRefs ?? []), ...(entry.consumerSourceRefs ?? [])]) refs.add(ref);
  }
  return [...refs].sort();
}

/** A valid module identifier for a derived stub, from the ref's basename. */
export function derivedStubIdentifier(ref: string): string {
  const base = (ref.split('/').at(-1) ?? ref).replace(/\.[^.]+$/, '');
  return base.replace(/[^A-Za-z0-9]+(.)?/g, (_match, next?: string) => (next ? next.toUpperCase() : ''));
}

/**
 * Write a minimal module for every registry-declared source the fixture does
 * not already stub explicitly, and report which ones that produced. The
 * explicit stubs above stay authoritative — several of them carry text the
 * discovery adapters actually parse — so this only fills genuine gaps.
 */
function writeDerivedRegistrySourceStubs(root: string): string[] {
  const derived: string[] = [];
  for (const ref of registryDeclaredSourceRefs()) {
    if (existsSync(join(root, ref))) continue;
    write(root, ref, `export const ${derivedStubIdentifier(ref)} = true;\n`);
    derived.push(ref);
  }
  return derived;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'acceptance-basis-smoke', PROOF_OR_STOP_AGENT: 'proof-or-stop-implementer' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const output = `${String(error.stdout || '')}${String(error.stderr || '')}${String(error.message || '')}`;
    if (allowFailure) return output;
    throw new Error(output);
  }
}

function bytes(root: string, rel: string): string {
  const path = join(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : '<missing>';
}

function redigestBasis(basis: AcceptanceBasisArtifactV1['basis']): void {
  const { basisDigest: _basisDigest, ...unsigned } = basis;
  basis.basisDigest = digestAcceptanceCoverageBasis(unsigned);
}

function redigestAdapter(adapter: AcceptanceBasisArtifactV1['basis']['adapterResults'][number]): void {
  const { resultDigest: _resultDigest, ...unsigned } = adapter;
  adapter.resultDigest = digestCoverageAdapterResult(unsigned);
}

function redigestSnapshotSeal(seal: AcceptanceBasisArtifactV1['basis']['snapshotSeal']): void {
  const { sealDigest: _sealDigest, ...unsigned } = seal;
  seal.sealDigest = `sha256:${digestCanonicalJson(unsigned)}`;
}

const realRepositoryDiscovery = runAcceptanceDiscoveryAdapters({
  supported: detectAcceptanceDiscoverySupport(projectRoot),
  workspaceRoot: projectRoot,
  storyId: 'B-real-repository-discovery',
  plannedPathRecords: [],
  scopeRefs: [
    'scope:file:packages/main/src/cli/command-catalog.ts',
    'scope:file:packages/main/src/handlers/proofstory.ts',
    'scope:file:packages/main/src/registry.ts',
  ],
  topologyPathRefs: [
    'process-fact:acceptance_basis',
    'process-fact:acceptance_basis_generate',
    'process-fact:acceptance_topology_check',
  ],
});
const realRepositoryDispatch = realRepositoryDiscovery.find(result => result.method === 'handler_dispatch_inventory')!;
for (const command of ['acceptance_basis', 'acceptance_basis_generate', 'acceptance_topology_check']) {
  assert.ok(
    realRepositoryDispatch.pathRefs.some(path => path.startsWith(`path:process-fact:${command}->`)),
    `real command catalog and createProofStoryHandlers registration discover ${command}: ${JSON.stringify(realRepositoryDispatch.blindSpots)}`,
  );
}
assert.ok(
  !reconcileAcceptanceDiscoveryResults(realRepositoryDiscovery).diagnostics.some(item => item.code === 'AT_DISCOVERY_DISAGREEMENT'),
  'real process-fact and handler/catalog discovery inventories agree',
);

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-BASIS',
  relation: 'producer_to_consumer' as const,
  producer: {
    id: 'EP-PRODUCER', role: 'producer' as const, expectedArtifactKind: 'handler' as const,
    expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produceBasis', fileDeclarationRef: 'CHK-001:files:create:0',
  },
  consumers: [{
    id: 'EP-CONSUMER', role: 'consumer' as const, expectedArtifactKind: 'handler' as const,
    expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'verifyBasis', fileDeclarationRef: 'CHK-001:files:create:1',
  }],
  outputFactRef: 'process-fact:acceptance-basis',
};

const topology: AcceptanceVerificationTopologyV1 = {
  schemaVersion: 'proofstory.acceptance_topology.v1',
  producerRefs: [{ id: 'P', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-BASIS:VPP-BASIS', endpointRef: 'EP-PRODUCER' } }],
  consumerRefs: [{ id: 'C', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-BASIS:VPP-BASIS', endpointRef: 'EP-CONSUMER' }, producerRefs: ['P'] }],
  positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-BASIS' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  mutationCaseRefs: [{ id: 'M', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-BASIS' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  transcriptAssertionRefs: [{ id: 'T', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-BASIS' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  commandRefs: [
    { refKind: 'existing', canonicalSourceRef: 'intent:INT-BASIS' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
    { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
    { refKind: 'existing', canonicalSourceRef: 'basis-path:path:static-call:packages/main/src/producer.ts#produceBasis->consumer:packages/main/src/consumer.ts#produceBasis' },
  ],
};

function writeCanonicalAcceptanceRegistration(root: string): string[] {
  // Lab's current registered-source closure is preserved by the derived writer below.
  write(root, 'packages/main/src/cli/command-catalog.ts', [
    'export const MAIN_TOOLS = [',
    "  { name: 'branch_status', description: 'infer from the story/* branch' },",
    "  { name: 'acceptance_basis' },",
    "  { name: 'acceptance_basis_generate' },",
    "  { name: 'acceptance_topology_check' },",
    "  { name: 'pre_review_check' },",
    "  { name: 'pre_review_check_read' },",
    "  { name: 'baseline_status', description: 'NL-*/RED baseline' },",
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
  write(root, 'packages/main/src/core/agent-dispatch-registry.ts', 'export const agentDispatchRegistry = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/pre-review-check.ts', 'export const preReviewCheck = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/core/pre-review-live-proof.ts', 'export const preReviewLiveProof = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'scripts/run-proofstory-pre-review-live-proof.mjs', 'export const preReviewLiveProofRunner = true;\n');
  write(root, 'packages/main/src/core/acceptance-rollout.ts', 'export const acceptanceRollout = true;\n');
  write(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'export const acceptanceRolloutRunner = true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCriticReceipt = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts', 'export const planConsumer = "acceptance_basis_generate";\n');
  write(root, 'scripts/verify-process-fact-contract.mjs', 'export const acceptance_basis_generate = "acceptance_basis read-only receipt verification and diagnostic rendering boundary";\n');
  // The B-aa5f runtime facts explicitly bind their real producer and lifecycle
  // consumer sources. Synthetic repositories must contain bounded stand-ins for
  // every registered source so the snapshot seal tests absence rather than
  // inheriting files from this repository.
  for (const file of [
    'packages/main/src/core/evidence-freshness.ts',
    'packages/main/src/core/material-path-policy.ts',
    'packages/main/src/core/verification-execution-evidence.ts',
    'packages/main/src/core/proof-admissibility.ts',
    'packages/main/src/core/shared-validation-execution.ts',
    'packages/main/src/core/story-aware-validation.ts',
    'packages/main/src/core/story-owner-lease.ts',
    'packages/main/src/core/validation-execution-lock.ts',
    'packages/main/src/core/verification.ts',
    'packages/main/src/core/lifecycle-readiness.ts',
    'packages/main/src/handlers/checklist.ts',
    'packages/main/src/handlers/phase-gates.ts',
    'packages/main/src/handlers/verifier.ts',
    'packages/main/src/handlers/done-prepare.ts',
    'packages/main/src/handlers/certification-window.ts',
  ]) write(root, file, 'export const verificationEvidenceContract = true;\n');
  // B-74b9 CHK-001: PROCESS_FACT_REGISTRY's artifact:acceptance-rollout-report.json entry lists
  // these two files as producerSourceRefs alongside handlers/proofstory.ts (stubbed above), so
  // buildBoundedSourceGraph pulls them into the required snapshot closure once that entry is
  // relevant -- they must be stubbed here too, or they surface as snapshot_missing blind spots.
  write(root, 'packages/main/src/core/acceptance-rollout.ts', 'export const acceptanceRollout = "acceptance_basis acceptance_basis_generate";\n');
  write(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'export const acceptanceRolloutCohortRunner = true;\n');
  // The current registration resolves these shared validation dependencies while
  // sealing a PLAN-time snapshot.  They are not implementation prerequisites of
  // this fixture, but the synthetic workspace must contain every source ref the
  // real registry declares or the control case becomes spuriously partial.
  for (const path of [
    'packages/main/src/core/evidence-freshness.ts',
    'packages/main/src/core/material-path-policy.ts',
    'packages/main/src/core/shared-validation-execution.ts',
    'packages/main/src/core/story-aware-validation.ts',
    'packages/main/src/core/story-owner-lease.ts',
    'packages/main/src/core/validation-execution-lock.ts',
  ]) write(root, path, 'export const fixtureDependency = true;\n');
  // Inventory artifact registry lists these as producer/consumer source refs, so the
  // bounded snapshot closure requires them once that entry is live.
  write(root, 'packages/main/src/core/machine.ts', 'export const machine = "acceptance_basis";\n');
  write(root, 'packages/main/src/core/review-inventory-epoch.ts', 'export const reviewInventoryEpoch = "acceptance_basis";\n');
  write(root, 'packages/main/src/core/evidence-freshness.ts', 'export const evidenceFreshness = "acceptance_basis";\n');
  write(root, 'packages/main/src/core/material-path-policy.ts', 'export const materialPathPolicy = "acceptance_basis";\n');
  write(root, 'packages/main/src/core/shared-validation-execution.ts', 'export const sharedValidationExecution = "acceptance_basis";\n');
  write(root, 'packages/main/src/core/story-aware-validation.ts', 'export const storyAwareValidation = "acceptance_basis";\n');
  write(root, 'packages/main/src/core/story-owner-lease.ts', 'export const storyOwnerLease = "acceptance_basis";\n');
  write(root, 'packages/main/src/core/validation-execution-lock.ts', 'export const validationExecutionLock = "acceptance_basis";\n');
  write(root, 'packages/main/src/handlers/review-inventory.ts', 'export const reviewInventory = "acceptance_basis";\n');
  // Everything above is an explicit stub whose CONTENT matters to a discovery
  // adapter. Whatever the registry declares beyond that only has to be
  // inspectable, so derive it instead of extending the hand-list again.
  return writeDerivedRegistrySourceStubs(root);
}

function checklist(): ChecklistData {
  return { items: [{
    id: 'CHK-001', title: 'basis', context: 'smoke', status: 'pending', startTime: null, endTime: null,
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: {
      happy: [{ id: 'INT-BASIS', desc: 'basis producer reaches consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [structuredClone(declaration)] }],
      edge: [], adversarial: [],
    },
  }] };
}

function contract(value: AcceptanceVerificationTopologyV1 = topology): ProofStoryContractData {
  return {
    schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-BASIS', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-BASIS'], milestoneIds: [], verificationTopology: value }],
    diagnosticGaps: [], createdAt: now, updatedAt: now,
  };
}

function scopeContract(): ScopeContractData {
  return {
    storyId, mode: 'local', allowedModify: ['packages/main/src/handlers/proofstory.ts'], allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [],
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

const pureRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-pure-'));
try {
  write(pureRoot, 'tsconfig.json', '{}\n');
  write(pureRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
  const derivedRegistrySourceRefs = writeCanonicalAcceptanceRegistration(pureRoot);
  // B-bcae CHK-004, asserted BEFORE the first basis control so a newly required
  // source is reported by name. PROCESS_FACT_REGISTRY — not this fixture — owns
  // which sources the snapshot closure must be able to inspect, and a missing
  // declared ref of a reached entry seals as snapshot_missing and drops the
  // basis to `partial`. Without this, that arrives as a bare complete/partial
  // mismatch with no indication of which ref moved.
  for (const ref of registryDeclaredSourceRefs()) {
    assert.ok(existsSync(join(pureRoot, ref)),
      `registry-declared source ${ref} is absent from the fixture; writeCanonicalAcceptanceRegistration must supply or derive every declared ref`);
  }
  assert.ok(derivedRegistrySourceRefs.length > 0,
    'the registry declares sources this fixture does not stub explicitly, so the derivation — not the hand-list — must be what supplies them');
  const plannedBeforeCode = deriveAcceptanceCoverageBasis({
    storyId, workspaceRoot: pureRoot, checklist: checklist(), contract: contract(), scopeCheck: scopeCheck(pureRoot), scopeContract: scopeContract(),
    headHash: 'head', materialHash: 'material', storyFilesHash: 'story', supported: true,
  });
  assert.equal(plannedBeforeCode.basis.status, 'complete', `valid PLAN endpoints are structurally complete before implementation files exist: ${JSON.stringify({ diagnostics: plannedBeforeCode.diagnostics, adapters: plannedBeforeCode.basis.adapterResults, blindSpots: plannedBeforeCode.basis.blindSpots, seal: plannedBeforeCode.basis.snapshotSeal }, null, 2)}`);
  write(pureRoot, 'packages/main/src/producer.ts', 'export const produceBasis = () => true;\n');
  write(pureRoot, 'packages/main/src/consumer.ts', "import { produceBasis } from './producer.js'; export const verifyBasis = () => produceBasis(); export const invokeBasis=()=>verifyBasis();\n");
  const input = {
    storyId, workspaceRoot: pureRoot, checklist: checklist(), contract: contract(), scopeCheck: scopeCheck(pureRoot), scopeContract: scopeContract(),
    headHash: 'head', materialHash: 'material', storyFilesHash: 'story', supported: true,
  };
  const first = deriveAcceptanceCoverageBasis(input);
  assert.equal(first.basis.status, 'complete', 'stable end-of-assembly seal preserves the complete control');
  // B-aa5f F-047: these are discovery-owned import/call paths, not invented
  // endpoint names. Keep the original planned endpoints mapped while adding
  // reference-only consumers at the two supported topology shapes.
  {
    const sourcePath = 'path:static-call:packages/main/src/producer.ts#produceBasis->consumer:packages/main/src/consumer.ts#produceBasis';
    const existingSource = { refKind: 'existing' as const, canonicalSourceRef: `basis-path:${sourcePath}` };
    const sameExisting = structuredClone(topology);
    sameExisting.producerRefs.push({ id: 'P-STATIC', sourceRef: existingSource });
    sameExisting.consumerRefs.push({ id: 'C-STATIC', sourceRef: existingSource, producerRefs: ['P-STATIC'] });
    const mixed = structuredClone(topology);
    mixed.producerRefs.push({ id: 'P-MIXED', sourceRef: structuredClone(topology.producerRefs[0].sourceRef) });
    mixed.consumerRefs.push({ id: 'C-MIXED', sourceRef: existingSource, producerRefs: ['P-MIXED'] });
    for (const phaseBasis of ['plan', 'pre_review'] as const) {
      for (const [label, edgeTopology] of [['same-existing', sameExisting], ['planned-static', mixed]] as const) {
        const derived = deriveAcceptanceCoverageBasis({
          ...input, contract: contract(edgeTopology), phaseBasis,
          ...(phaseBasis === 'pre_review' ? { priorPlanBasisDigest: first.basis.basisDigest } : {}),
        });
        assert.ok(derived.basis.enumeratedPathRefs.includes(sourcePath), `${label}: the real call must first be discovered`);
        assert.equal(derived.basis.status, 'complete',
          `F-047 ${label} ${phaseBasis}: exact discovered static edge must reconcile: ${JSON.stringify(derived.diagnostics)}`);
        assert.deepEqual(derived.basis.blindSpots, [], `${label}: no hidden discovery gaps`);
        assert.ok(!derived.basis.enumeratedPathRefs.some(path => path.includes('existing:basis-path:')),
          `${label}: topology projection must not manufacture discovery paths`);
      }
    }

    const control = deriveAcceptanceCoverageBasis({ ...input, contract: contract(mixed), phaseBasis: 'pre_review', priorPlanBasisDigest: first.basis.basisDigest });
    const rejects = (label: string, candidate: AcceptanceVerificationTopologyV1, basis = control.basis): void => {
      assert.ok(reconcileTopologyWithCoverageBasis(contract(candidate), basis)
        .some(issue => issue.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'), `F-047 rejects ${label}`);
    };
    for (const endpointRef of ['EP-MISSING', declaration.consumers[0].id]) {
      const candidate = structuredClone(mixed);
      candidate.producerRefs.find(node => node.id === 'P-MIXED')!.sourceRef = {
        refKind: 'planned', plannedPathDeclarationRef: 'INT-BASIS:VPP-BASIS', endpointRef,
      };
      rejects(`wrong producer endpoint ${endpointRef}`, candidate);
    }
    for (const [label, change] of [
      ['producer file', (record: typeof control.basis.plannedPathRecords[number]) => { record.producer.expectedFileRef = declaration.consumers[0].expectedFileRef; }],
      ['producer symbol', (record: typeof control.basis.plannedPathRecords[number]) => { record.producer.expectedSymbolOrFact = 'anotherProducer'; }],
      ['producer role', (record: typeof control.basis.plannedPathRecords[number]) => { record.producer.role = 'consumer'; }],
    ] as const) {
      const changedBasis = structuredClone(control.basis);
      change(changedBasis.plannedPathRecords[0]);
      rejects(label, mixed, changedBasis);
    }
    for (const ref of [
      `basis-path:${sourcePath.replace('#produceBasis->', '#anotherProducer->')}`,
      `basis-path:${sourcePath.replace('src/producer.ts', 'src/missing.ts')}`,
      `basis-path:${sourcePath.replace('src/producer.ts', 'src/../producer.ts')}`,
      `basis-path:${sourcePath} `,
      `consumer:${sourcePath}`,
    ]) {
      const candidate = structuredClone(mixed);
      candidate.consumerRefs.find(node => node.id === 'C-MIXED')!.sourceRef = { refKind: 'existing', canonicalSourceRef: ref };
      candidate.commandRefs.push({ refKind: 'existing', canonicalSourceRef: ref });
      rejects('mismatched/malformed source even with commandRef', candidate);
    }
    const missingBasis = structuredClone(control.basis);
    missingBasis.enumeratedPathRefs = missingBasis.enumeratedPathRefs.filter(path => path !== sourcePath);
    rejects('missing discovered path despite unchanged commandRef', mixed, missingBasis);
    rejects('missing identical-existing path despite unchanged commandRef', sameExisting, missingBasis);

    const originalConsumer = bytes(pureRoot, declaration.consumers[0].expectedFileRef);
    try {
      const otherPath = sourcePath.replace(/#produceBasis$/, '#otherBasis');
      write(pureRoot, declaration.consumers[0].expectedFileRef,
        `${originalConsumer}import { produceBasis as otherBasis } from './producer.js'; export const invokeOtherBasis = () => otherBasis();\n`);
      const twoPathsTopology = structuredClone(sameExisting);
      twoPathsTopology.commandRefs.push({ refKind: 'existing', canonicalSourceRef: `basis-path:${otherPath}` });
      const twoPaths = deriveAcceptanceCoverageBasis({ ...input, contract: contract(twoPathsTopology), phaseBasis: 'pre_review', priorPlanBasisDigest: first.basis.basisDigest });
      assert.equal(twoPaths.basis.status, 'complete', 'two independently discovered path controls reconcile');
      assert.ok([sourcePath, otherPath].every(path => twoPaths.basis.enumeratedPathRefs.includes(path)), 'both differently named import calls are source-proven');
      const differentExisting = structuredClone(twoPathsTopology);
      differentExisting.consumerRefs.find(node => node.id === 'C-STATIC')!.sourceRef = { refKind: 'existing', canonicalSourceRef: `basis-path:${otherPath}` };
      rejects('two different discovered paths despite both commandRefs', differentExisting, twoPaths.basis);

      write(pureRoot, declaration.consumers[0].expectedFileRef, 'export const verifyBasis = () => true; export const invokeBasis = () => verifyBasis();\n');
      const deleted = deriveAcceptanceCoverageBasis({ ...input, contract: contract(mixed), phaseBasis: 'pre_review', priorPlanBasisDigest: first.basis.basisDigest });
      assert.ok(!deleted.basis.enumeratedPathRefs.includes(sourcePath), 'deleted call is absent from production discovery');
      assert.ok(deleted.diagnostics.some(issue => issue.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'), 'deleted call cannot be restored by topology text');
    } finally { write(pureRoot, declaration.consumers[0].expectedFileRef, originalConsumer); }
  }
  // B-bcae CHK-004 non-vacuity: the derived sources are load-bearing, not
  // decorative. Removing exactly the refs the derivation supplies must drop the
  // complete control above to `partial` and name them, so an entry that starts
  // declaring a new source can never pass unnoticed.
  for (const ref of derivedRegistrySourceRefs) rmSync(join(pureRoot, ref));
  const withoutDerivedSources = deriveAcceptanceCoverageBasis(input);
  assert.equal(withoutDerivedSources.basis.status, 'partial',
    'omitting the registry-declared sources this fixture derives must drop the basis out of complete');
  const missingSeals = (withoutDerivedSources.basis.snapshotSeal?.issues ?? [])
    .filter(issue => issue.code === 'snapshot_missing' && derivedRegistrySourceRefs.includes(issue.canonicalRef));
  assert.ok(missingSeals.length > 0,
    `an omitted registry-declared source must be named as snapshot_missing: ${JSON.stringify(withoutDerivedSources.basis.snapshotSeal)}`);
  writeDerivedRegistrySourceStubs(pureRoot);
  assert.equal(deriveAcceptanceCoverageBasis(input).basis.status, 'complete',
    'restoring the derived registry sources returns the control to complete');
  const registryEdgeTopology = structuredClone(topology);
  registryEdgeTopology.producerRefs.push({
    id: 'P-REGISTRY-BASIS-GENERATOR',
    sourceRef: { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
  });
  registryEdgeTopology.consumerRefs.push({
    id: 'C-REGISTRY-TOPOLOGY-CHECK',
    sourceRef: { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
    producerRefs: ['P-REGISTRY-BASIS-GENERATOR'],
  });
  const registryEdgeIntegration = deriveAcceptanceCoverageBasis({ ...input, contract: contract(registryEdgeTopology) });
  assert.equal(
    registryEdgeIntegration.basis.status,
    'complete',
    `valid process-fact producer/consumer refs reconcile through the authoritative registry consumer path: ${JSON.stringify(registryEdgeIntegration.diagnostics)}`,
  );
  assert.ok(
    registryEdgeIntegration.basis.enumeratedPathRefs.includes('path:process-fact:acceptance_basis_generate->consumer:acceptance_topology_check and transition-orchestrator PLAN to DEV structural gate'),
    'integration basis contains the authoritative registry gateConsumer path',
  );
  const preReviewFactRefs = [
    'process-fact:pre_review_check',
    'process-fact:pre_review_check_read',
    'process-fact:artifact:pre-review-check.json',
  ];
  const phaseAwareTopology: AcceptanceVerificationTopologyV1 = {
    ...topology,
    commandRefs: [
      ...topology.commandRefs,
      ...preReviewFactRefs.map(canonicalSourceRef => ({ refKind: 'existing' as const, canonicalSourceRef })),
    ],
  };
  const phasePlan = deriveAcceptanceCoverageBasis({ ...input, contract: contract(phaseAwareTopology), phaseBasis: 'plan' });
  assert.equal(phasePlan.basis.status, 'complete', `PLAN permits registered next-phase declarations without inventing current paths: ${JSON.stringify(phasePlan.diagnostics)}`);
  for (const ref of preReviewFactRefs) {
    assert.ok(!phasePlan.basis.enumeratedPathRefs.some(path => path.startsWith(`path:${ref}->`)), `${ref} remains deferred outside PLAN discovery`);
  }
  const phasePreReview = deriveAcceptanceCoverageBasis({
    ...input,
    contract: contract(phaseAwareTopology),
    phaseBasis: 'pre_review',
    priorPlanBasisDigest: phasePlan.basis.basisDigest,
  });
  assert.equal(phasePreReview.basis.status, 'complete', `PRE_REVIEW materializes and exactly maps deferred facts: ${JSON.stringify(phasePreReview.diagnostics)}`);
  for (const ref of preReviewFactRefs) {
    assert.ok(phasePreReview.basis.enumeratedPathRefs.some(path => path.startsWith(`path:${ref}->`)), `${ref} becomes material in PRE_REVIEW discovery`);
  }
  const missingFutureMappingTopology = structuredClone(phaseAwareTopology);
  missingFutureMappingTopology.commandRefs = missingFutureMappingTopology.commandRefs
    .filter(ref => ref.refKind !== 'existing' || ref.canonicalSourceRef !== 'process-fact:pre_review_check_read');
  const missingFutureMapping = reconcileTopologyWithCoverageBasis(contract(missingFutureMappingTopology), phasePreReview.basis);
  assert.ok(missingFutureMapping.some(item => item.code === 'AT_UNMAPPED_SCOPE_REF'
    && item.pathRef?.startsWith('path:process-fact:pre_review_check_read->')), 'deleting one PRE_REVIEW mapping exposes the newly material path');
  const unrelatedFutureTopology = structuredClone(phaseAwareTopology);
  unrelatedFutureTopology.commandRefs.push({ refKind: 'existing', canonicalSourceRef: 'process-fact:review_run_start' });
  assert.ok(reconcileTopologyWithCoverageBasis(contract(unrelatedFutureTopology), phasePlan.basis)
    .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS' && item.pathRef === 'process-fact:review_run_start'), 'registered but unrelated future process fact is not deferred implicitly');
  const nonexistentFutureTopology = structuredClone(phaseAwareTopology);
  nonexistentFutureTopology.commandRefs.push({ refKind: 'existing', canonicalSourceRef: 'process-fact:not_registered_future_fact' });
  assert.ok(reconcileTopologyWithCoverageBasis(contract(nonexistentFutureTopology), phasePlan.basis)
    .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS' && item.pathRef === 'process-fact:not_registered_future_fact'), 'nonexistent future process fact remains fail-closed');
  const lateC2 = join(pureRoot, 'packages/main/src/late-c2.ts');
  const lateAddition = deriveAcceptanceCoverageBasis({
    ...input,
    discoveryTestHooks: {
      immediatelyBeforeFinalSeal: () => writeFileSync(lateC2, "export const late = () => true;\n"),
    },
  });
  assert.equal(lateAddition.basis.status, 'partial', 'C2 added after initial enumeration is detected by the derivation seal');
  assert.ok(lateAddition.basis.blindSpots.some(item => item.includes('snapshot-seal:directory_changed')), 'late C2 addition invalidates its inventory directory fingerprint');
  rmSync(lateC2, { force: true });
  const producerControl = 'export const produceBasis = () => true;\n';
  const earlyReadMutation = deriveAcceptanceCoverageBasis({
    ...input,
    discoveryTestHooks: { immediatelyBeforeFinalSeal: () => writeFileSync(join(pureRoot, 'packages/main/src/producer.ts'), `${producerControl}// late mutation\n`) },
  });
  assert.equal(earlyReadMutation.basis.status, 'partial', 'early-read source mutation is rejected at the final seal');
  assert.ok(earlyReadMutation.basis.blindSpots.some(item => item.includes('snapshot-seal:source_file_changed')), 'early-read mutation reports a file fingerprint blind spot');
  writeFileSync(join(pureRoot, 'packages/main/src/producer.ts'), producerControl);
  const configPath = join(pureRoot, 'proof-or-stop.config.json');
  const configControl = readFileSync(configPath, 'utf8');
  const configMutation = deriveAcceptanceCoverageBasis({
    ...input,
    discoveryTestHooks: { immediatelyBeforeFinalSeal: () => writeFileSync(configPath, JSON.stringify({ scanRoot: 'packages/main', rootDir: 'other' })) },
  });
  assert.equal(configMutation.basis.status, 'partial', 'config changed after assembly is rejected at the final seal');
  assert.ok(configMutation.basis.blindSpots.some(item => item.includes('proof-or-stop.config.json')), 'config mutation names the sealed canonical config');
  writeFileSync(configPath, configControl);
  const configSwapRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-config-swap-'));
  try {
    write(configSwapRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'narrow', rootDir: 'src' }));
    const configSwap = deriveAcceptanceCoverageBasis({
      ...input,
      discoveryTestHooks: { immediatelyBeforeFinalSeal: () => { rmSync(configPath); symlinkSync(join(configSwapRoot, 'proof-or-stop.config.json'), configPath, 'file'); } },
    });
    assert.equal(configSwap.basis.status, 'partial', 'config symlink swap before seal fails closed');
  } finally {
    rmSync(configPath, { force: true });
    writeFileSync(configPath, configControl);
    rmSync(configSwapRoot, { recursive: true, force: true });
  }
  writeFileSync(configPath, JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', padding: 'x'.repeat(96 * 1024) }));
  const policyRichConfig = deriveAcceptanceCoverageBasis(input);
  assert.equal(policyRichConfig.basis.status, 'complete', 'a policy-rich config above the former 64 KiB ceiling remains discoverable');
  assert.ok(!policyRichConfig.basis.blindSpots.some(item => item.includes('lexical scan budget')), 'an admitted policy-rich config has no bounded-read blind spot');
  writeFileSync(configPath, JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', padding: 'x'.repeat(MAX_PROOF_OR_STOP_CONFIG_BYTES + 1) }));
  const oversizedConfig = deriveAcceptanceCoverageBasis(input);
  assert.equal(oversizedConfig.basis.status, 'partial', 'oversized config is rejected by the strict config snapshot cap');
  assert.ok(oversizedConfig.basis.blindSpots.some(item => item.includes('lexical scan budget')), 'oversized config produces a bounded-read blind spot');
  writeFileSync(configPath, JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', padding: 'x'.repeat(129 * 1024) }));
  const aboveCeilingConfig = deriveAcceptanceCoverageBasis(input);
  assert.equal(aboveCeilingConfig.basis.status, 'partial', '129 KiB config padding remains rejected by the strict config snapshot cap');
  assert.ok(aboveCeilingConfig.basis.blindSpots.some(item => item.includes('lexical scan budget')), '129 KiB config padding produces a bounded-read blind spot');
  writeFileSync(configPath, configControl);
  const initialConfigSwapRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-config-initial-swap-'));
  try {
    write(initialConfigSwapRoot, 'proof-or-stop.config.json', configControl);
    rmSync(configPath);
    symlinkSync(join(initialConfigSwapRoot, 'proof-or-stop.config.json'), configPath, 'file');
    const initialConfigSwap = deriveAcceptanceCoverageBasis(input);
    assert.equal(initialConfigSwap.basis.status, 'partial', 'initial symlinked config is never followed');
    assert.ok(initialConfigSwap.basis.blindSpots.some(item => item.includes('symlink')), 'initial config symlink reports deterministic safe-read failure');
  } finally {
    rmSync(configPath, { force: true });
    writeFileSync(configPath, configControl);
    rmSync(initialConfigSwapRoot, { recursive: true, force: true });
  }
  const producerFile = join(pureRoot, 'packages/main/src/producer.ts');
  writeFileSync(producerFile, `export const oversized = '${'x'.repeat((2 * 1024 * 1024) + 1)}';\n`);
  const oversizedDerivation = deriveAcceptanceCoverageBasis(input);
  assert.equal(oversizedDerivation.basis.status, 'partial', 'production derivation rejects oversized planned closure source before receipt completeness');
  assert.ok(oversizedDerivation.basis.blindSpots.some(item => item.includes('lexical scan budget')), 'production oversized closure emits bounded-read diagnostic');
  writeFileSync(producerFile, 'export const produceBasis = () => true;\n');
  const closureScript = join(pureRoot, 'scripts/verify-process-fact-contract.mjs');
  const closureScriptText = readFileSync(closureScript, 'utf8');
  rmSync(closureScript);
  assert.equal(deriveAcceptanceCoverageBasis(input).basis.status, 'partial', 'disappearing registered closure source returns partial without throwing');
  writeFileSync(closureScript, closureScriptText);
  const swapRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-closure-swap-'));
  try {
    write(swapRoot, 'external.mjs', 'export const escaped = true;\n');
    rmSync(closureScript);
    symlinkSync(join(swapRoot, 'external.mjs'), closureScript, 'file');
    const swappedClosure = deriveAcceptanceCoverageBasis(input);
    assert.equal(swappedClosure.basis.status, 'partial', 'symlink-swapped registered closure source returns partial without external reread');
    assert.ok(swappedClosure.basis.blindSpots.some(item => item.includes('symlink')), 'symlink-swapped closure source emits deterministic diagnostic');
  } finally {
    rmSync(closureScript, { force: true });
    writeFileSync(closureScript, closureScriptText);
    rmSync(swapRoot, { recursive: true, force: true });
  }
  const adapterControl = runAcceptanceDiscoveryAdapters({ supported: true, workspaceRoot: pureRoot, storyId, plannedPathRecords: first.basis.plannedPathRecords, scopeRefs: ['S1', 'scope:file:packages/main/src/handlers/proofstory.ts'] });
  const globalClosure = deriveRegisteredProcessFactClosure(pureRoot, ['packages/main/src/handlers/proofstory.ts']);
  assert.ok(globalClosure.pathRefs.some(path => path.includes('acceptance_basis->consumer:<audit-only>')), 'non-gate reader remains registered without inventing a lifecycle consumer');
  assert.ok(globalClosure.pathRefs.some(path => path.includes('artifact:acceptance-basis.json') && path.includes('consumer:acceptance_topology_check and transition-orchestrator PLAN to DEV structural gate')), 'signed artifact retains its canonical lifecycle consumer boundary');
  assert.ok(globalClosure.sourceFileRefs.includes('scripts/verify-process-fact-contract.mjs'), 'global consumer source enters closure binding');
  const adapterControlReconciled = reconcileAcceptanceDiscoveryResults(adapterControl);
  assert.equal(adapterControlReconciled.status, 'complete', JSON.stringify(adapterControlReconciled, null, 2));
  const shuffled = reconcileAcceptanceDiscoveryResults([...adapterControl].reverse());
  assert.deepEqual(shuffled, adapterControlReconciled, 'adapter reconciliation is deterministic under shuffled execution order');
  const omitted = reconcileAcceptanceDiscoveryResults(adapterControl.slice(1));
  assert.ok(omitted.diagnostics.some(item => item.code === 'AT_REQUIRED_ADAPTER_RESULT_MISSING'), 'required adapter omission bites');
  const duplicated = reconcileAcceptanceDiscoveryResults([...adapterControl, adapterControl[0]]);
  assert.ok(duplicated.diagnostics.some(item => item.code === 'AT_REQUIRED_ADAPTER_RESULT_MISSING'), 'required adapter duplication bites');
  const resultTamper = structuredClone(adapterControl);
  resultTamper[1].pathRefs.push('C3');
  assert.ok(reconcileAcceptanceDiscoveryResults(resultTamper).diagnostics.some(item => item.code === 'AT_ADAPTER_RESULT_DIGEST_MISMATCH'), 'adapter path mutation without digest bites');
  const disagreement = structuredClone(adapterControl);
  const disagreementDispatch = disagreement.find(item => item.method === 'handler_dispatch_inventory')!;
  disagreementDispatch.pathRefs = disagreementDispatch.pathRefs
    .filter(path => !path.startsWith('path:process-fact:acceptance_basis_generate->'));
  disagreementDispatch.pathRefs.push('path:process-fact:forged-dispatch->consumer:<audit-only>');
  disagreementDispatch.pathRefs.sort();
  redigestAdapter(disagreementDispatch);
  const disagreementDiagnostic = reconcileAcceptanceDiscoveryResults(disagreement).diagnostics.find(item => item.code === 'AT_DISCOVERY_DISAGREEMENT');
  assert.ok(disagreementDiagnostic, 'unexplained registry/dispatch disagreement bites');
  assert.match(disagreementDiagnostic.message, /registryOnly\(count=1\)=\[acceptance_basis_generate\]/, 'registry-only difference is bounded and specific');
  assert.match(disagreementDiagnostic.message, /dispatchOnly\(count=1\)=\[forged-dispatch\]/, 'dispatch-only difference is bounded and specific');
  const boundedDisagreement = structuredClone(adapterControl);
  const boundedDispatch = boundedDisagreement.find(item => item.method === 'handler_dispatch_inventory')!;
  boundedDispatch.pathRefs.push(...Array.from({ length: 10 }, (_, index) => `path:process-fact:forged-${String(index).padStart(2, '0')}->consumer:<audit-only>`));
  boundedDispatch.pathRefs.sort();
  redigestAdapter(boundedDispatch);
  const boundedDiagnostic = reconcileAcceptanceDiscoveryResults(boundedDisagreement).diagnostics.find(item => item.code === 'AT_DISCOVERY_DISAGREEMENT')!;
  assert.match(boundedDiagnostic.message, /dispatchOnly\(count=10\)=\[forged-00,forged-01,forged-02,forged-03,forged-04,forged-05,forged-06,forged-07,…\]/, 'large difference reports total count and bounded sorted names');
  assert.doesNotMatch(boundedDiagnostic.message, /forged-08|forged-09/, 'bounded difference does not leak the full set');
  assert.ok(!adapterControlReconciled.diagnostics.some(item => item.code === 'AT_DISCOVERY_DISAGREEMENT'), 'typed bounded runtime asymmetry retains static-only paths');
  for (const [label, mutate] of [
    ['claim', (value: any) => { value.coverageClaim = 'complete'; }],
    ['provenance', (value: any) => { value.provenanceRefs = []; }],
    ['asymmetry kind', (value: any) => { value.asymmetryPolicy.kind = 'forged'; }],
    ['asymmetry policy', (value: any) => { value.asymmetryPolicy.policyRef = ''; }],
    ['asymmetry scope', (value: any) => { value.asymmetryPolicy.scopeRefs = []; }],
  ] as Array<[string, (value: any) => void]>) {
    const changed = structuredClone(adapterControl);
    mutate(changed[0]);
    redigestAdapter(changed[0]);
    assert.ok(reconcileAcceptanceDiscoveryResults(changed).diagnostics.some(item => item.code === 'AT_ADAPTER_RESULT_INVALID'), `invalid ${label} bites after attacker re-digests`);
  }
  const declaredBlindSpot = structuredClone(adapterControl);
  declaredBlindSpot[0].coverageClaim = 'partial';
  declaredBlindSpot[0].blindSpots = ['bounded missing path'];
  redigestAdapter(declaredBlindSpot[0]);
  assert.equal(reconcileAcceptanceDiscoveryResults(declaredBlindSpot).status, 'partial', 'declared blind spot cannot reconcile complete');
  const handlerControl = bytes(pureRoot, 'packages/main/src/handlers/proofstory.ts');
  write(pureRoot, 'packages/main/src/handlers/proofstory.ts', handlerControl.replace('    acceptance_basis_generate() { return true; },', '    // acceptance_basis_generate() { return true; },'));
  const dispatchOmission = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters({ supported: true, workspaceRoot: pureRoot, storyId, plannedPathRecords: first.basis.plannedPathRecords, scopeRefs: ['S1', 'scope:file:packages/main/src/handlers/proofstory.ts'] }));
  assert.equal(dispatchOmission.status, 'partial', 'real registered handler deletion fails discovery; a comment token does not count as dispatch');
  assert.ok(dispatchOmission.diagnostics.some(item => item.code === 'AT_DISCOVERY_DISAGREEMENT'));
  write(pureRoot, 'packages/main/src/handlers/proofstory.ts', handlerControl);
  const unsupported = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters({ supported: false, workspaceRoot: pureRoot, storyId, plannedPathRecords: first.basis.plannedPathRecords, scopeRefs: ['S1', 'scope:file:packages/main/src/handlers/proofstory.ts'] }));
  assert.equal(unsupported.status, 'unsupported', 'unsupported profile never becomes complete');
  const second = deriveAcceptanceCoverageBasis({ ...input, checklist: { items: [...input.checklist.items] } });
  assert.equal(first.basis.basisDigest, second.basis.basisDigest, 'unchanged canonical inputs replay to the same basis digest');
  assert.equal(first.basis.status, 'complete', JSON.stringify(first.diagnostics, null, 2));
  const firstVerification = verifyAcceptanceCoverageBasis(first.basis);
  assert.equal(firstVerification.ok, true, JSON.stringify(firstVerification.diagnostics));
  assert.equal(verifyAcceptanceCoverageBasis(lateAddition.basis).ok, true, 'authentic structured partial seal verifies without claiming complete');
  const removedSealIssue = structuredClone(lateAddition.basis);
  removedSealIssue.snapshotSeal.issues = [];
  removedSealIssue.snapshotSeal.status = 'complete';
  removedSealIssue.blindSpots = removedSealIssue.blindSpots.filter(item => !item.startsWith('snapshot-seal:'));
  removedSealIssue.status = 'complete';
  redigestBasis(removedSealIssue);
  assert.equal(verifyAcceptanceCoverageBasis(removedSealIssue).ok, false, 'deleting a real seal issue and re-digesting only the basis cannot erase partial integrity');
  const forgedAllowedPrefix = structuredClone(first.basis);
  forgedAllowedPrefix.blindSpots.push('source file forged but formerly prefix-allowed');
  forgedAllowedPrefix.status = 'partial';
  redigestBasis(forgedAllowedPrefix);
  assert.equal(verifyAcceptanceCoverageBasis(forgedAllowedPrefix).ok, false, 'free-text allowed-prefix forgery is rejected by exact structured projection');
  for (const [label, mutate] of [
    ['status', (value: typeof first.basis) => { value.snapshotSeal.status = 'partial'; }],
    ['digest', (value: typeof first.basis) => { value.snapshotSeal.sealDigest = `sha256:${'4'.repeat(64)}`; }],
    ['directory count', (value: typeof first.basis) => { value.snapshotSeal.inventoryDirectoryCount += 1; }],
    ['source count', (value: typeof first.basis) => { value.snapshotSeal.sourceSnapshotCount += 1; }],
  ] as const) {
    const mutation = structuredClone(first.basis);
    mutate(mutation);
    redigestBasis(mutation);
    assert.equal(verifyAcceptanceCoverageBasis(mutation).ok, false, `snapshot seal ${label} mutation bites after basis re-digest`);
  }
  const aggregateTamper = structuredClone(first.basis);
  aggregateTamper.enumeratedPathRefs = aggregateTamper.enumeratedPathRefs.filter(path => !path.includes('VPP-BASIS'));
  redigestBasis(aggregateTamper);
  assert.ok(!verifyAcceptanceCoverageBasis(aggregateTamper).ok, 'aggregate omission bites without trusting the aggregate');
  const aggregateAddition = structuredClone(first.basis);
  aggregateAddition.enumeratedPathRefs.push('path:forged:addition');
  aggregateAddition.enumeratedPathRefs.sort();
  redigestBasis(aggregateAddition);
  assert.ok(!verifyAcceptanceCoverageBasis(aggregateAddition).ok, 'aggregate addition bites without trusting the aggregate');
  const aggregateBlindSpot = structuredClone(first.basis);
  aggregateBlindSpot.blindSpots.push('forged aggregate blind spot');
  redigestBasis(aggregateBlindSpot);
  assert.ok(!verifyAcceptanceCoverageBasis(aggregateBlindSpot).ok, 'aggregate blind-spot tamper bites');
  const recomputedAdapterOldBasis = structuredClone(first.basis);
  const registryAdapter = recomputedAdapterOldBasis.adapterResults.find(item => item.method === 'process_fact_registry')!;
  registryAdapter.pathRefs.push('path:forged:adapter');
  redigestAdapter(registryAdapter);
  recomputedAdapterOldBasis.enumeratedPathRefs.push('path:forged:adapter');
  recomputedAdapterOldBasis.enumeratedPathRefs.sort();
  assert.ok(!verifyAcceptanceCoverageBasis(recomputedAdapterOldBasis).ok, 'recomputed adapter digest retained under old basis digest bites');
  const closureOmission = structuredClone(first.basis);
  closureOmission.sourceInventoryRefs = closureOmission.sourceInventoryRefs.filter(ref => !ref.includes('scripts/verify-process-fact-contract.mjs'));
  redigestBasis(closureOmission);
  assert.notEqual(closureOmission.basisDigest, first.basis.basisDigest, 'registered out-of-scope consumer omission changes the signed basis');
  const closureAdapterOmission = structuredClone(first.basis);
  const closureRegistry = closureAdapterOmission.adapterResults.find(item => item.method === 'process_fact_registry')!;
  closureRegistry.pathRefs = closureRegistry.pathRefs.filter(path => !path.startsWith('path:process-fact:acceptance_basis_generate->'));
  redigestAdapter(closureRegistry);
  redigestBasis(closureAdapterOmission);
  assert.ok(!verifyAcceptanceCoverageBasis(closureAdapterOmission).ok, 'omitting a dispatchable registry path from one closure adapter fails disagreement verification');
  const optimistic = structuredClone(first.basis);
  optimistic.adapterResults[0].coverageClaim = 'partial';
  optimistic.status = 'complete';
  assert.ok(!verifyAcceptanceCoverageBasis(optimistic).ok, 'partial-to-complete optimism mutation bites');
  const narrowedMethods = structuredClone(first.basis);
  narrowedMethods.discoveryMethods = narrowedMethods.discoveryMethods.slice(1);
  redigestBasis(narrowedMethods);
  assert.ok(!verifyAcceptanceCoverageBasis(narrowedMethods).ok, 'caller-narrowed discovery methods fail aggregate projection verification');
  const missingDeclarationChecklist = checklist();
  missingDeclarationChecklist.items[0].verificationIntent!.happy[0].plannedPathDeclarations = [];
  assert.ok(reconcileTopologyWithCoverageBasis(contract(), deriveAcceptanceCoverageBasis({ ...input, checklist: missingDeclarationChecklist }).basis)
    .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS' || item.code === 'AT_UNMAPPED_SCOPE_REF' || item.code === 'AT_PLANNED_PATH_OUTSIDE_BASIS'), 'deleting planned declaration cannot leave topology falsely complete');
  const inventedTopology = structuredClone(topology);
  inventedTopology.consumerRefs[0].sourceRef = { refKind: 'existing', canonicalSourceRef: 'invented:C2' };
  assert.ok(reconcileTopologyWithCoverageBasis(contract(inventedTopology), first.basis).some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'), 'invented topology path outside basis bites');
  const versionDriftTopology = structuredClone(topology);
  (versionDriftTopology as any).schemaVersion = 'proofstory.acceptance_topology.v0';
  assert.ok(reconcileTopologyWithCoverageBasis(contract(versionDriftTopology), first.basis).some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'), 'topology schema version drift bites');
  const exclusionTamper = structuredClone(first.basis);
  exclusionTamper.excludedPathRefs = [{ pathRef: 'C2', decisionRef: 'self approved prose' }];
  assert.ok(reconcileTopologyWithCoverageBasis(contract(), exclusionTamper).some(item => item.code === 'AT_UNJUSTIFIED_EXCLUSION'), 'non-auditable exclusion prose bites');
  const eligibleDecision: DecisionData = {
    principles: ['p1', 'p2', 'p3'], drivers: ['d1', 'd2', 'd3'],
    options: [{ name: '[coverage-exclusion] omit C2', pros: ['bounded'], cons: ['less coverage'] }, { name: 'retain', pros: ['coverage'], cons: ['cost'] }],
    chosen: '[coverage-exclusion] omit C2', rationale: 'C2 is inapplicable because the canonical consumer is absent.', timestamp: now,
  };
  const validExclusion = structuredClone(first.basis);
  validExclusion.excludedPathRefs = [{ pathRef: 'C2', decisionRef: foundationalExclusionDecisionRef(eligibleDecision) }];
  assert.ok(!reconcileTopologyWithCoverageBasis(contract(), validExclusion, eligibleDecision).some(item => item.code === 'AT_UNJUSTIFIED_EXCLUSION'), 'current relevant eligible foundational decision resolves');
  const decisionMatrix: Array<[string, DecisionData | null, string]> = [
    ['missing', null, 'decision:story-design:missing'],
    ['stale', { ...eligibleDecision, timestamp: '2026-07-21T00:00:00.000Z' }, foundationalExclusionDecisionRef(eligibleDecision)],
    ['unrelated', { ...eligibleDecision, rationale: 'Different path only.' }, foundationalExclusionDecisionRef({ ...eligibleDecision, rationale: 'Different path only.' })],
    ['ineligible', { ...eligibleDecision, chosen: 'retain' }, foundationalExclusionDecisionRef({ ...eligibleDecision, chosen: 'retain' })],
    ['malformed', eligibleDecision, 'decision:anything'],
  ];
  for (const [label, decision, decisionRef] of decisionMatrix) {
    const changed = structuredClone(first.basis);
    changed.excludedPathRefs = [{ pathRef: 'C2', decisionRef }];
    assert.ok(reconcileTopologyWithCoverageBasis(contract(), changed, decision).some(item => item.code === 'AT_UNJUSTIFIED_EXCLUSION'), `${label} decisionRef stays non-complete`);
  }
  const duplicateDecision = structuredClone(validExclusion);
  duplicateDecision.excludedPathRefs.push({ pathRef: 'C3', decisionRef: foundationalExclusionDecisionRef(eligibleDecision) });
  assert.ok(reconcileTopologyWithCoverageBasis(contract(), duplicateDecision, eligibleDecision).some(item => item.code === 'AT_UNJUSTIFIED_EXCLUSION'), 'duplicate decisionRef bites');

  const semanticDrifts: Array<[string, (value: typeof first.basis.plannedPathRecords[number]) => void]> = [
    ['role', value => { value.producer.role = 'consumer'; }],
    ['artifact', value => { value.producer.expectedArtifactKind = 'dispatch'; }],
    ['file', value => { value.producer.expectedFileRef = 'packages/main/src/other.ts'; }],
    ['symbol', value => { value.producer.expectedSymbolOrFact = 'otherProducer'; }],
    ['output fact', value => { value.outputFactRef = 'process-fact:other'; }],
  ];
  for (const [label, mutate] of semanticDrifts) {
    const changed = structuredClone(first.basis);
    mutate(changed.plannedPathRecords[0]);
    redigestBasis(changed);
    assert.ok(verifyAcceptanceCoverageBasis(changed).diagnostics.some(item => item.code === 'AT_PLANNED_PATH_DECLARATION_DRIFT'), `${label} drift with retained declaration id bites`);
  }
  const invalidFiles = checklist();
  invalidFiles.items[0].files = { ...invalidFiles.items[0].files!, create: ['packages/main/src/other.ts', 'packages/main/src/consumer.ts'] };
  assert.ok(derivePlannedCoveragePaths(invalidFiles, contract(), scopeContract()).diagnostics.some(item => item.code === 'AT_PLANNED_PATH_INVALID'), 'planned endpoint must resolve frozen checklist file');
  const invalidRelation = checklist();
  (invalidRelation.items[0].verificationIntent!.happy[0].plannedPathDeclarations![0] as any).relation = 'consumer_to_producer';
  assert.ok(derivePlannedCoveragePaths(invalidRelation, contract(), scopeContract()).diagnostics.some(item => item.code === 'AT_PLANNED_PATH_INVALID'), 'declaration relation drift is rejected');

  const repositoryShapeRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-repository-shape-'));
  try {
    write(repositoryShapeRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    write(repositoryShapeRoot, 'packages/main/tsconfig.json', '{}\n');
    write(repositoryShapeRoot, 'packages/main/src/cli/command-catalog.ts', [
      'export const MAIN_TOOLS = [',
      "  { name: 'acceptance_basis' },",
      "  { name: 'acceptance_basis_generate' },",
      "  { name: 'acceptance_topology_check' },",
      "  { name: 'pre_review_check' },",
      "  { name: 'pre_review_check_read' },",
      "  { name: 'story_advance' },",
      "  { name: 'topology_critic_receipt_check' },",
      '];', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'packages/main/src/handlers/proofstory.ts', [
      'export const acceptanceBasisProducer = () => true;',
      'export function createProofStoryHandlers() {',
      '  return {',
      '    acceptance_basis() { return true; },',
      '    acceptance_basis_generate() { return acceptanceBasisProducer(); },',
      '    acceptance_topology_check() { return true; },',
      '    topology_critic_receipt_check() { return true; },',
      '  };',
      '}', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'packages/main/src/handlers/story-advance.ts', [
      'export function createStoryAdvanceHandlers(_ctx: unknown) {',
      '  return { story_advance() { return true; } };',
      '}', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'packages/main/src/handlers/story.ts', [
      "import { createStoryAdvanceHandlers } from './story-advance.js';",
      'export function createStoryHandlers(ctx: unknown) {',
      '  return {',
      '    ...createStoryAdvanceHandlers(ctx),',
      '    story_get() { return true; },',
      '  };',
      '}', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'packages/main/src/handlers/transition-orchestrator.ts', [
      "import { acceptanceBasisProducer as consumeBasis } from './proofstory.js';",
      'export const runPreReviewGate = () => consumeBasis();', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'packages/main/src/registry.ts', [
      "import { createProofStoryHandlers } from './handlers/proofstory.js';",
      "import { createStoryHandlers } from './handlers/story.js';",
      'const registry = { registerBatch: (_handlers: unknown) => undefined };',
      'const ctx = {};',
      'registry.registerBatch(createProofStoryHandlers(ctx));',
      'registry.registerBatch(createStoryHandlers(ctx));', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'packages/main/src/core/acceptance-topology.ts', 'export const acceptanceTopology = true;\n');
    write(repositoryShapeRoot, 'scripts/verify-process-fact-contract.mjs', 'export const processFactContract = true;\n');
    write(repositoryShapeRoot, 'packages/main/src/tests/unrelated.ts', [
      "import { acceptanceBasisProducer } from '../handlers/proofstory.js';",
      'export const unrelatedTestCall = () => acceptanceBasisProducer();', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'packages/main/src/cli-engine.ts', [
      "import { acceptanceBasisProducer } from './handlers/proofstory.js';",
      'export const unrelatedCliEngineCall = () => acceptanceBasisProducer();', '',
    ].join('\n'));
    write(repositoryShapeRoot, 'docs/process-fact-notes.md', '# Process fact notes\n\nThis is snapshot material, not TypeScript.\n');
    write(repositoryShapeRoot, 'packages/main/src/process-fact-shape.json', '{ "notTypeScript": }\n');
    write(repositoryShapeRoot, 'packages/main/src/unrelated-loader.mjs', [
      "const target = './handlers/proofstory.js';",
      'export const loadUnrelated = () => import(target);', '',
    ].join('\n'));
    for (const name of ['scope-inventory-budget', 'story-scope-budget', 'story-scope-budget-decisions', 'story-scope-budget-legacy']) {
      write(repositoryShapeRoot, `packages/main/src/core/${name}.ts`, 'export const fixtureDependency = true;\n');
    }
    const repositoryShapePath = structuredClone(first.basis.plannedPathRecords[0]);
    repositoryShapePath.producer.expectedFileRef = 'packages/main/src/handlers/proofstory.ts';
    repositoryShapePath.producer.expectedSymbolOrFact = 'acceptanceBasisProducer';
    repositoryShapePath.consumers[0].expectedFileRef = 'packages/main/src/handlers/transition-orchestrator.ts';
    repositoryShapePath.consumers[0].expectedSymbolOrFact = 'runPreReviewGate';
    repositoryShapePath.outputFactRef = 'process-fact:acceptance_basis_generate';
    const repositoryShapeInput = {
      supported: true,
      workspaceRoot: repositoryShapeRoot,
      storyId: 'B-repository-shape',
      plannedPathRecords: [repositoryShapePath],
      scopeRefs: [
        'scope:file:packages/main/src/handlers/proofstory.ts',
        'scope:file:packages/main/src/handlers/story.ts',
        'scope:file:packages/main/src/handlers/transition-orchestrator.ts',
        'scope:file:packages/main/src/tests/unrelated.ts',
        'scope:file:packages/main/src/cli-engine.ts',
        'scope:file:docs/process-fact-notes.md',
        'scope:file:packages/main/src/process-fact-shape.json',
        'scope:file:packages/main/src/unrelated-loader.mjs',
      ],
      topologyPathRefs: [
        'process-fact:acceptance_basis_generate',
        'process-fact:story_advance',
        'process-fact:topology_critic_receipt_check',
      ],
    };
    const repositoryShape = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(repositoryShapeInput));
    assert.equal(repositoryShape.status, 'complete', JSON.stringify(repositoryShape, null, 2));
    const repositorySnapshot = runAcceptanceDiscoverySnapshot(repositoryShapeInput);
    for (const snapshotOnlyFile of ['docs/process-fact-notes.md', 'packages/main/src/process-fact-shape.json', 'packages/main/src/unrelated-loader.mjs']) {
      assert.ok(repositorySnapshot.sourceSnapshots.some(snapshot => snapshot.canonicalFile === snapshotOnlyFile), `${snapshotOnlyFile} remains freshness-bound`);
    }
    assert.ok(!repositoryShape.blindSpots.some(item => item.includes('process-fact-shape.json') || item.includes('unrelated-loader.mjs')), 'snapshot-only assets do not create global parser/import blind spots');
    for (const fact of ['acceptance_basis_generate', 'story_advance', 'topology_critic_receipt_check']) {
      assert.ok(repositoryShape.enumeratedPathRefs.some(path => path.startsWith(`path:process-fact:${fact}->`)), `explicit topology fact ${fact} enters registry basis`);
    }
    assert.ok(repositoryShape.enumeratedPathRefs.some(path => path.includes('static-call:packages/main/src/handlers/proofstory.ts#acceptanceBasisProducer')
      && path.includes('consumer:packages/main/src/handlers/transition-orchestrator.ts#consumeBasis')), 'planned proofstory to transition direct edge enters static basis');
    const repositoryDispatch = repositoryShape.adapterResults.find(item => item.method === 'handler_dispatch_inventory')!;
    assert.ok(repositoryDispatch.pathRefs.some(path => path.startsWith('path:process-fact:story_advance->')), 'registered parent handler spread recursively discovers story_advance dispatch');
    assert.ok(!repositoryShape.enumeratedPathRefs.some(path => path.includes('/tests/unrelated.ts') || path.includes('/cli-engine.ts')), 'closure-only unrelated calls stay out of topology path refs');

    const storyParentControl = bytes(repositoryShapeRoot, 'packages/main/src/handlers/story.ts');
    const storyChildControl = bytes(repositoryShapeRoot, 'packages/main/src/handlers/story-advance.ts');
    write(repositoryShapeRoot, 'packages/main/src/handlers/story.ts', [
      'export function createStoryHandlers(ctx: unknown) {',
      '  return { ...createMissingHandlers(ctx) };',
      '}', '',
    ].join('\n'));
    const missingSpread = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(repositoryShapeInput));
    assert.equal(missingSpread.status, 'partial', 'missing handler spread target fails closed');
    assert.ok(missingSpread.blindSpots.some(item => item.includes('handler factory spread target is missing')), 'missing spread target is named as the blind spot');

    write(repositoryShapeRoot, 'packages/main/src/handlers/story.ts', [
      "import { createStoryAdvanceHandlers } from './story-advance.js';",
      'function createStoryAdvanceHandlers(_ctx: unknown) { return { local_only() { return true; } }; }',
      'export function createStoryHandlers(ctx: unknown) {',
      '  return { ...createStoryAdvanceHandlers(ctx) };',
      '}', '',
    ].join('\n'));
    const ambiguousSpread = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(repositoryShapeInput));
    assert.equal(ambiguousSpread.status, 'partial', 'ambiguous handler spread target fails closed');
    assert.ok(ambiguousSpread.blindSpots.some(item => item.includes('handler factory spread target is ambiguous')), 'ambiguous spread target is named as the blind spot');

    write(repositoryShapeRoot, 'packages/main/src/handlers/story.ts', storyParentControl);
    write(repositoryShapeRoot, 'packages/main/src/handlers/story-advance.ts', [
      "import { createStoryHandlers } from './story.js';",
      'export function createStoryAdvanceHandlers(ctx: unknown) {',
      '  return { ...createStoryHandlers(ctx) };',
      '}', '',
    ].join('\n'));
    const cyclicSpread = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(repositoryShapeInput));
    assert.equal(cyclicSpread.status, 'partial', 'cyclic handler spread fails closed');
    assert.ok(cyclicSpread.blindSpots.some(item => item.includes('handler factory spread cycle')), 'spread cycle is named as the blind spot');
    write(repositoryShapeRoot, 'packages/main/src/handlers/story-advance.ts', storyChildControl);
  } finally {
    rmSync(repositoryShapeRoot, { recursive: true, force: true });
  }

  const genericRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-generic-'));
  try {
    write(genericRoot, 'tsconfig.json', '{}\n');
    write(genericRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    writeCanonicalAcceptanceRegistration(genericRoot);
    write(genericRoot, 'packages/main/src/cli/command-catalog.ts', [
      'export const MAIN_TOOLS = [',
      "  { name: 'acceptance_basis' },",
      "  { name: 'acceptance_basis_generate' },",
      "  { name: 'acceptance_topology_check' },",
      "  { name: 'pre_review_check' },",
      "  { name: 'pre_review_check_read' },",
      "  { name: 'review_run_start' },",
      '];',
      '',
    ].join('\n'));
    write(genericRoot, 'packages/main/src/handlers/review-run.ts', [
      'export const emitReviewRunFact = () => true;',
      "export const unrelatedOptions = { ordinary_object_key: true };",
      'export function createReviewRunHandlers() {',
      '  return {',
      '    review_run_start() { return emitReviewRunFact(); },',
      '  };',
      '}',
      'export default { emitReviewRunFact };',
      '',
    ].join('\n'));
    const genericRegistryControl = [
      "import { createProofStoryHandlers } from './handlers/proofstory.js';",
      "import { createReviewRunHandlers as makeReviewHandlers } from './handlers/review-run.js';",
      'const registry = { registerBatch: (_handlers: unknown) => undefined };',
      'const ctx = {};',
      'registry.registerBatch(createProofStoryHandlers(ctx));',
      'registry.registerBatch(makeReviewHandlers(ctx));',
      '',
    ].join('\n');
    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl);
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'export const c2 = () => consumeReviewRun();',
      'export const invokeC2 = () => c2();',
      '',
    ].join('\n'));
    write(genericRoot, 'packages/main/src/unrelated.ts', 'export const unrelated = () => true;\n');
    const genericPlannedPath = structuredClone(first.basis.plannedPathRecords[0]);
    genericPlannedPath.outputFactRef = 'process-fact:review_run_start';
    genericPlannedPath.producer.expectedFileRef = 'packages/main/src/handlers/review-run.ts';
    genericPlannedPath.producer.expectedSymbolOrFact = 'emitReviewRunFact';
    genericPlannedPath.consumers[0].expectedFileRef = 'packages/main/src/consumers/c2.ts';
    genericPlannedPath.consumers[0].expectedSymbolOrFact = 'c2';
    const genericInput = {
      supported: true, workspaceRoot: genericRoot, storyId: 'B-generic', phaseBasis: 'pre_review' as const, plannedPathRecords: [genericPlannedPath],
      scopeRefs: ['scope:file:packages/main/src/handlers/review-run.ts'],
      topologyPathRefs: ['process-fact:review_run_start'],
    };
    const genericInputForConsumer = (consumerFile: string) => {
      const boundedPath = structuredClone(genericPlannedPath);
      boundedPath.consumers[0].expectedFileRef = consumerFile;
      return { ...genericInput, plannedPathRecords: [boundedPath] };
    };
    const genericControl = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(genericControl.status, 'complete', JSON.stringify(genericControl, null, 2));
    assert.ok(genericControl.adapterResults.find(result => result.method === 'static_call_graph')?.pathRefs.includes('actual:handler:packages/main/src/consumers/c2.ts#c2'), 'PRE_REVIEW exact consumer relation emits the actual consumer endpoint');
    const c2Path = genericControl.enumeratedPathRefs.find(path => path.includes('static-call:packages/main/src/handlers/review-run.ts#emitReviewRunFact') && path.includes('consumer:packages/main/src/consumers/c2.ts#consumeReviewRun'));
    assert.ok(c2Path, 'planned bounded graph discovers its non-ProofStory handler and external C2 consumer');
    const sameFilePath = structuredClone(genericPlannedPath);
    sameFilePath.producer.expectedFileRef = 'packages/main/src/handlers/review-run.ts';
    sameFilePath.producer.expectedSymbolOrFact = 'emitReviewRunFact';
    sameFilePath.consumers[0].expectedFileRef = 'packages/main/src/handlers/review-run.ts';
    sameFilePath.consumers[0].expectedSymbolOrFact = 'review_run_start';
    sameFilePath.outputFactRef = 'process-fact:review_run_start';
    const sameFileInput = { ...genericInput, plannedPathRecords: [sameFilePath] };
    const sameFileControl = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(sameFileInput));
    const sameFileStatic = sameFileControl.adapterResults.find(result => result.method === 'static_call_graph');
    assert.ok(sameFileStatic?.pathRefs.includes('actual:handler:packages/main/src/handlers/review-run.ts#emitReviewRunFact'), 'same-file valid edge emits the producer endpoint');
    const reviewRunSourceControl = bytes(genericRoot, 'packages/main/src/handlers/review-run.ts');
    write(genericRoot, 'packages/main/src/handlers/review-run.ts', reviewRunSourceControl.replace(
      'review_run_start() { return emitReviewRunFact(); },',
      'review_run_start() { function emitReviewRunFact() { return false; } return emitReviewRunFact(); },',
    ));
    const sameNameShadow = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(sameFileInput));
    // NOTE (B-5a15): do NOT assert sameNameShadow.status === 'partial' here. This fixture also
    // writes packages/main/src/consumers/c2.ts (above), which imports emitReviewRunFact as a
    // genuine CROSS-FILE consumer, so discovery legitimately still reports 'complete' even when
    // the same-file edge is broken by the nested shadow. Asserting 'partial' over-claims and
    // fails on the aggregate rather than on the behaviour under test. The endpoint assertion
    // below is the real adversarial check: the shadowed helper must not emit a FALSE producer
    // endpoint for the same-file edge.
    assert.ok(!sameNameShadow.adapterResults.find(result => result.method === 'static_call_graph')?.pathRefs.includes('actual:handler:packages/main/src/handlers/review-run.ts#emitReviewRunFact'), 'same-name nested helper does not emit a false producer endpoint');
    write(genericRoot, 'packages/main/src/handlers/review-run.ts', reviewRunSourceControl);
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'export const c2 = () => true;',
      'export const invokeC2 = () => c2();',
      'export const decoyCaller = () => consumeReviewRun();',
      '',
    ].join('\n'));
    const decoyRelation = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.ok(!decoyRelation.adapterResults.find(result => result.method === 'static_call_graph')?.pathRefs.includes('actual:handler:packages/main/src/consumers/c2.ts#c2'), 'a decoy caller elsewhere in the consumer file cannot satisfy the declared consumer-symbol relation');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'export const c2 = () => consumeReviewRun();',
      'export const invokeC2 = () => c2();',
      '',
    ].join('\n'));
    assert.ok(genericControl.enumeratedPathRefs.some(path => path.includes('process-fact:review_run_start')), 'generic factory alias resolves the registered review-run command');
    assert.ok(!genericControl.enumeratedPathRefs.some(path => path.includes('ordinary_object_key')), 'ordinary object keys do not become handler commands');
    assert.ok(genericControl.enumeratedPathRefs.some(path => path.includes('acceptance_basis_generate')), 'independent PLAN profile control facts remain in the bounded basis');
    assert.ok(!genericControl.enumeratedPathRefs.some(path => path.includes('story_create')), 'bounded graph does not pull the unrelated process registry universe');
    const closureControl = deriveRegisteredProcessFactClosure(genericRoot, [
      'packages/main/src/handlers/review-run.ts',
      'packages/main/src/consumers/c2.ts',
    ]);
    assert.ok(closureControl.sourceFileRefs.includes('packages/main/src/consumers/c2.ts'), 'explicit bounded C2 seed enters the source closure');
    assert.ok(!closureControl.sourceFileRefs.includes('packages/main/src/unrelated.ts'), 'unrelated source inventory file without a call relation stays outside closure');
    const closureHash = computeClosureFilesHash(genericRoot, [], closureControl.sourceInventoryRefs);

    const assertMaskedFalseConsumer = (source: string, label: string): void => {
      write(genericRoot, 'packages/main/src/consumers/c2.ts', [
        "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
        source, '',
      ].join('\n'));
      const result = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
      assert.equal(result.status, 'partial', `${label} cannot satisfy consumerGate`);
      assert.ok(!result.enumeratedPathRefs.some(path => path.includes('consumer:packages/main/src/consumers/c2.ts#consumeReviewRun')), `${label} cannot emit a static call edge`);
      assert.ok(!deriveRegisteredProcessFactClosure(genericRoot, ['packages/main/src/handlers/review-run.ts']).sourceFileRefs.includes('packages/main/src/consumers/c2.ts'), `${label} cannot enter the source closure`);
    };
    assertMaskedFalseConsumer("export const marker = 'consumeReviewRun(';", 'single-quoted alias text');
    assertMaskedFalseConsumer('export const marker = "consumeReviewRun(";', 'double-quoted alias text');
    assertMaskedFalseConsumer('// consumeReviewRun(\n/* consumeReviewRun( */\nexport const marker = true;', 'comment-only alias text');
    assertMaskedFalseConsumer('export const marker = `consumeReviewRun(`;', 'template static alias text');
    assertMaskedFalseConsumer('export const marker = /consumeReviewRun\\([})]/gi;', 'regex-literal alias text with escapes, character class, brace, and flags');
    assertMaskedFalseConsumer('export const c2 = (consumeReviewRun: () => boolean) => consumeReviewRun();', 'parameter-shadowed call');
    assertMaskedFalseConsumer('export function c2() { const consumeReviewRun = () => true; return consumeReviewRun(); }', 'local-const-shadowed call');
    assertMaskedFalseConsumer('export function c2() { function consumeReviewRun() { return true; } return consumeReviewRun(); }', 'nested-function-shadowed call');
    assertMaskedFalseConsumer('export function c2() { try { throw new Error(); } catch (consumeReviewRun) { return consumeReviewRun(); } }', 'catch-binding-shadowed call');
    assertMaskedFalseConsumer('export function c2() { { const consumeReviewRun = () => true; return consumeReviewRun(); } }', 'block-binding-shadowed call');
    assertMaskedFalseConsumer('export function c2() { consumeReviewRun(); var consumeReviewRun = () => true; }', 'var-hoisted-shadowed call');
    assertMaskedFalseConsumer('export function c2() { class consumeReviewRun { static run() { return true; } } return consumeReviewRun.run(); }', 'class-binding-shadowed property call');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'export const marker = `${consumeReviewRun()}`;', '',
    ].join('\n'));
    const interpolatedConsumer = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(interpolatedConsumer.status, 'complete', 'template interpolation executable call satisfies the consumer gate');
    assert.ok(interpolatedConsumer.enumeratedPathRefs.some(path => path.includes('consumer:packages/main/src/consumers/c2.ts#consumeReviewRun')), 'template interpolation executable call emits a static call edge');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      "export const marker = `${/}/.test('}') ? `nested ${/[}]/.test('}') ? consumeReviewRun() : false}` : false}`;", '',
    ].join('\n'));
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'complete', 'regex brace inside nested template interpolation does not hide a real call');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      "const pattern = /[})]/g; const ratio = 8 / 2; export const c2 = () => pattern.test('}') && ratio ? consumeReviewRun() : false;", '',
    ].join('\n'));
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'complete', 'real call after regex and division remains discoverable');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'const broken = /[/; export const c2 = () => consumeReviewRun();', '',
    ].join('\n'));
    const parseAmbiguity = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(parseAmbiguity.status, 'partial', 'invalid regex parse ambiguity fails closed');
    assert.ok(parseAmbiguity.blindSpots.some(item => item.includes('typescript parse ambiguity')), 'invalid regex emits a deterministic parse blind spot');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      `export const oversized = '${'x'.repeat((2 * 1024 * 1024) + 1)}';`, '',
    ].join('\n'));
    const oversizedSource = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(oversizedSource.status, 'partial', 'oversized lexical source fails closed');
    assert.ok(oversizedSource.blindSpots.some(item => item.includes('exceeds lexical scan budget')), 'oversized lexical source emits a deterministic budget blind spot');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', 'export const inactive = true;\n');
    for (const row of [
      { extension: 'tsx', source: "import { emitReviewRunFact as consume } from '../handlers/review-run.js'; const view = <div />; export const c2 = () => view && consume();" },
      { extension: 'jsx', source: "import * as review from '../handlers/review-run.js'; export const c2 = () => review.emitReviewRunFact();" },
      { extension: 'mts', source: "import review from '../handlers/review-run.js'; export const c2 = () => review.emitReviewRunFact();" },
      { extension: 'cts', source: "import review = require('../handlers/review-run.js'); export const c2 = () => review.emitReviewRunFact();" },
      { extension: 'js', source: "import { emitReviewRunFact as consume } from '../handlers/review-run'; export const c2 = () => consume();" },
      { extension: 'mjs', source: "import { emitReviewRunFact as consume } from '../handlers/review-run.js'; export const c2 = () => consume();" },
      { extension: 'cjs', source: "const { emitReviewRunFact: consume } = require('../handlers/review-run.js'); exports.c2 = () => consume();" },
    ]) {
      const consumerFile = `packages/main/src/consumers/c2.${row.extension}`;
      write(genericRoot, consumerFile, `${row.source}\n`);
      const moduleForm = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInputForConsumer(consumerFile)));
      assert.equal(moduleForm.status, 'complete', `${row.extension} module form discovers its bound consumer`);
      assert.ok(deriveRegisteredProcessFactClosure(genericRoot, ['packages/main/src/handlers/review-run.ts', consumerFile]).sourceFileRefs.includes(consumerFile), `${row.extension} consumer enters closure`);
      rmSync(join(genericRoot, consumerFile), { force: true });
    }
    for (const row of [
      { label: 'inline require property', extension: 'cjs', source: "exports.c2 = () => require('../handlers/review-run.js').emitReviewRunFact();" },
      { label: 'inline callable require', extension: 'cjs', source: "exports.c2 = () => require('../handlers/review-run.js')();" },
      { label: 'assigned callable require', extension: 'cjs', source: "const review = require('../handlers/review-run.js'); exports.c2 = () => review();" },
      { label: 'default import direct call', extension: 'ts', source: "import review from '../handlers/review-run.js'; export const c2 = () => review();" },
      { label: 'dynamic import namespace', extension: 'ts', source: "export const c2 = async () => { const review = await import('../handlers/review-run.js'); return review.emitReviewRunFact(); };" },
      { label: 'dynamic import destructure', extension: 'ts', source: "export const c2 = async () => { const { emitReviewRunFact: consume } = await import('../handlers/review-run.js'); return consume(); };" },
      { label: 'dynamic import direct property', extension: 'ts', source: "export const c2 = async () => (await import('../handlers/review-run.js')).emitReviewRunFact();" },
      { label: 'parenthesized binding call', extension: 'ts', source: "import { emitReviewRunFact as consume } from '../handlers/review-run.js'; export const c2 = () => (consume)();" },
      { label: 'non-null binding call', extension: 'ts', source: "import { emitReviewRunFact as consume } from '../handlers/review-run.js'; export const c2 = () => consume!();" },
      { label: 'as-expression binding call', extension: 'ts', source: "import { emitReviewRunFact as consume } from '../handlers/review-run.js'; export const c2 = () => (consume as typeof consume)();" },
      { label: 'wrapped namespace property', extension: 'ts', source: "import * as review from '../handlers/review-run.js'; export const c2 = () => (review as typeof review).emitReviewRunFact();" },
    ]) {
      const consumerFile = `packages/main/src/consumers/c2.${row.extension}`;
      write(genericRoot, 'packages/main/src/consumers/c2.ts', 'export const inactive = true;\n');
      write(genericRoot, consumerFile, `${row.source}\n`);
      const result = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInputForConsumer(consumerFile)));
      assert.equal(result.status, 'complete', `${row.label} discovers a bound consumer`);
      assert.ok(deriveRegisteredProcessFactClosure(genericRoot, ['packages/main/src/handlers/review-run.ts', consumerFile]).sourceFileRefs.includes(consumerFile), `${row.label} enters closure`);
      if (consumerFile !== 'packages/main/src/consumers/c2.ts') rmSync(join(genericRoot, consumerFile), { force: true });
    }
    write(genericRoot, 'packages/main/src/consumers/c2.ts', "const target = '../handlers/review-run.js'; export const c2 = async () => (await import(target)).emitReviewRunFact();\n");
    const dynamicUnknown = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(dynamicUnknown.status, 'partial', 'non-literal dynamic import fails closed');
    assert.ok(dynamicUnknown.blindSpots.some(item => item.includes('unsupported dynamic import shape')), 'non-literal dynamic import emits a deterministic blind spot');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', "function require(_specifier: string) { return { emitReviewRunFact: () => true }; } export const c2 = () => require('../handlers/review-run.js').emitReviewRunFact();\n");
    const shadowedRequire = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(shadowedRequire.status, 'partial', 'lexically shadowed require cannot satisfy the consumer gate');
    assert.ok(!shadowedRequire.enumeratedPathRefs.some(path => path.includes('consumer:packages/main/src/consumers/c2.ts')), 'shadowed require emits no static call edge');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', "export const c2 = async () => { const review = await import('../handlers/review-run.js'); return review(); };\n");
    const namespaceDirectCall = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(namespaceDirectCall.status, 'partial', 'dynamic-import namespace direct call cannot satisfy the consumer gate');
    assert.ok(!namespaceDirectCall.enumeratedPathRefs.some(path => path.includes('consumer:packages/main/src/consumers/c2.ts')), 'dynamic-import namespace direct call emits no default edge');
    assert.ok(namespaceDirectCall.blindSpots.some(item => item.includes('namespace is not directly callable')), 'dynamic namespace misuse is diagnosed explicitly');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', "import * as review from '../handlers/review-run.js'; export const c2 = () => review();\n");
    const staticNamespaceDirectCall = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(staticNamespaceDirectCall.status, 'partial', 'static namespace direct call cannot satisfy the consumer gate');
    assert.ok(!staticNamespaceDirectCall.enumeratedPathRefs.some(path => path.includes('consumer:packages/main/src/consumers/c2.ts')), 'static namespace direct call emits no default edge');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', 'export const inactive = true;\n');
    write(genericRoot, 'packages/main/src/bridges/index.ts', [
      "import { emitReviewRunFact as consume } from '../handlers/review-run.js';",
      'export const bridge = () => consume();', '',
    ].join('\n'));
    write(genericRoot, 'packages/main/src/consumers/c2.js', "import { bridge } from '../bridges'; export const c2 = () => bridge();\n");
    const chainedInput = genericInputForConsumer('packages/main/src/consumers/c2.js');
    chainedInput.scopeRefs = [...chainedInput.scopeRefs, 'scope:file:packages/main/src/bridges/index.ts'];
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(chainedInput)).status, 'complete', 'explicit bounded directory index chain is discovered transitively');
    rmSync(join(genericRoot, 'packages/main/src/consumers/c2.js'), { force: true });
    rmSync(join(genericRoot, 'packages/main/src/bridges'), { recursive: true, force: true });
    write(genericRoot, 'packages/main/src/handlers/review-run.tsx', 'export const ambiguous = true;\n');
    write(genericRoot, 'packages/main/src/consumers/c2.mjs', "import { emitReviewRunFact as consume } from '../handlers/review-run.js'; export const c2 = () => consume();\n");
    const ambiguousModule = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(ambiguousModule.status, 'partial', 'multiple viable local module candidates fail closed');
    assert.ok(ambiguousModule.blindSpots.some(item => item.includes('ambiguous local module')), 'module ambiguity emits deterministic candidate detail');
    rmSync(join(genericRoot, 'packages/main/src/handlers/review-run.tsx'), { force: true });
    rmSync(join(genericRoot, 'packages/main/src/consumers/c2.mjs'), { force: true });
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'export const c2 = () => consumeReviewRun();', '',
    ].join('\n'));

    const genericBasis = structuredClone(first.basis);
    genericBasis.storyId = 'B-generic';
    genericBasis.adapterResults = genericControl.adapterResults;
    genericBasis.discoveryMethods = genericControl.adapterResults.map(item => item.method).sort();
    genericBasis.enumeratedPathRefs = genericControl.enumeratedPathRefs.filter(path => !path.startsWith('planned:'));
    genericBasis.blindSpots = genericControl.blindSpots;
    genericBasis.plannedPathRecords = [];
    redigestBasis(genericBasis);
    const c2Topology: AcceptanceVerificationTopologyV1 = {
      schemaVersion: 'proofstory.acceptance_topology.v1', producerRefs: [], consumerRefs: [], positiveAssertionRefs: [], mutationCaseRefs: [], transcriptAssertionRefs: [],
      commandRefs: genericBasis.enumeratedPathRefs.map(path => ({ refKind: 'existing' as const, canonicalSourceRef: `basis-path:${path}` })),
    };
    const genericTopologyDiagnostics = reconcileTopologyWithCoverageBasis(contract(c2Topology), genericBasis);
    assert.equal(genericTopologyDiagnostics.length, 0, `restored generic C2 topology control passes: ${JSON.stringify(genericTopologyDiagnostics)}`);
    const focusedStaticPaths = [
      'path:static-call:packages/main/src/a.ts#produceA->consumer:packages/main/src/b.ts#consumeA',
      'path:static-call:packages/main/src/c.ts#produceB->consumer:packages/main/src/d.ts#consumeB',
      'path:static-call:packages/main/src/e.ts#produceC->consumer:packages/main/src/f.ts#consumeC',
      'path:static-call:packages/main/src/g.ts#produceD->consumer:packages/main/src/h.ts#consumeD',
    ];
    const focusedProcessPath = 'path:process-fact:acceptance_basis_generate->consumer:acceptance_topology_check and transition-orchestrator PLAN to DEV structural gate';
    const focusedBasis = structuredClone(genericBasis);
    focusedBasis.enumeratedPathRefs = [focusedProcessPath, ...focusedStaticPaths];
    focusedBasis.plannedPathRecords = [];
    focusedBasis.plannedActualReconciliations = [];
    focusedBasis.excludedPathRefs = [];
    focusedBasis.phaseBasis = 'pre_review';
    focusedBasis.priorPlanBasisDigest = genericBasis.basisDigest;
    const referenceOnlyBasis = structuredClone(focusedBasis);
    referenceOnlyBasis.enumeratedPathRefs = [focusedProcessPath];
    const referenceOnlyExistingTopology: AcceptanceVerificationTopologyV1 = {
      schemaVersion: 'proofstory.acceptance_topology.v1',
      producerRefs: [{ id: 'P-EXISTING', sourceRef: { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' } }],
      consumerRefs: [{
        id: 'C-EXISTING',
        sourceRef: { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
        producerRefs: ['P-EXISTING'],
      }],
      positiveAssertionRefs: [], mutationCaseRefs: [], transcriptAssertionRefs: [], commandRefs: [],
    };
    assert.deepEqual(
      reconcileTopologyWithCoverageBasis(contract(referenceOnlyExistingTopology), referenceOnlyBasis),
      [],
      'reference-only existing process-fact edge reconciles in the verifier canonical basis path space',
    );
    const outsideReferenceTopology = structuredClone(referenceOnlyExistingTopology);
    outsideReferenceTopology.consumerRefs[0].sourceRef = { refKind: 'existing', canonicalSourceRef: 'process-fact:review_run_start' };
    outsideReferenceTopology.commandRefs = [{ refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' }];
    assert.ok(
      reconcileTopologyWithCoverageBasis(contract(outsideReferenceTopology), referenceOnlyBasis)
        .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'
          && item.pathRef === 'path:process-fact:acceptance_basis_generate->process-fact:review_run_start'),
      'a matching commandRef cannot hide an unrelated but registry-valid process-fact edge',
    );
    const unknownReferenceTopology = structuredClone(referenceOnlyExistingTopology);
    unknownReferenceTopology.producerRefs[0].sourceRef = { refKind: 'existing', canonicalSourceRef: 'process-fact:not_registered_topology_fact' };
    assert.ok(
      reconcileTopologyWithCoverageBasis(contract(unknownReferenceTopology), referenceOnlyBasis)
        .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'
          && item.pathRef === 'path:process-fact:not_registered_topology_fact->process-fact:acceptance_topology_check'),
      'canonical reconciliation remains fail-closed for unknown process-fact refs',
    );
    const callerAliasTopology = structuredClone(referenceOnlyExistingTopology);
    callerAliasTopology.consumerRefs[0].sourceRef = { refKind: 'existing', canonicalSourceRef: 'consumer:acceptance_topology_check' };
    assert.ok(
      reconcileTopologyWithCoverageBasis(contract(callerAliasTopology), referenceOnlyBasis)
        .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'
          && item.pathRef === 'path:process-fact:acceptance_basis_generate->existing:consumer:acceptance_topology_check'),
      'caller-authored consumer aliases cannot impersonate registry-owned canonical paths',
    );
    const focusedTopology: AcceptanceVerificationTopologyV1 = {
      schemaVersion: 'proofstory.acceptance_topology.v1',
      producerRefs: [], consumerRefs: [], positiveAssertionRefs: [], mutationCaseRefs: [], transcriptAssertionRefs: [],
      commandRefs: [
        { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
        ...focusedStaticPaths.map(path => ({ refKind: 'existing' as const, canonicalSourceRef: `basis-path:${path}` })),
      ],
    };
    assert.deepEqual(reconcileTopologyWithCoverageBasis(contract(focusedTopology), focusedBasis), [], 'canonical process-fact mapping plus four exact basis-path static edges reconcile against the current basis');
    const planForwardBasis = structuredClone(focusedBasis);
    planForwardBasis.phaseBasis = 'plan';
    delete planForwardBasis.priorPlanBasisDigest;
    planForwardBasis.enumeratedPathRefs = [focusedProcessPath];
    assert.deepEqual(reconcileTopologyWithCoverageBasis(contract(focusedTopology), planForwardBasis), [], 'PLAN accepts strict basis-path edges as next-phase forward declarations');
    const deletedEdgeTopology = structuredClone(focusedTopology);
    deletedEdgeTopology.commandRefs = deletedEdgeTopology.commandRefs.filter(ref => ref.refKind !== 'existing'
      || ref.canonicalSourceRef !== `basis-path:${focusedStaticPaths[0]}`);
    assert.ok(reconcileTopologyWithCoverageBasis(contract(deletedEdgeTopology), focusedBasis)
      .some(item => item.code === 'AT_UNMAPPED_SCOPE_REF' && item.pathRef === focusedStaticPaths[0]), 'deleting a material PRE_REVIEW edge mapping bites');
    const nonexistentTopology = structuredClone(focusedTopology);
    nonexistentTopology.commandRefs.push({ refKind: 'existing', canonicalSourceRef: 'basis-path:path:static-call:packages/main/src/missing.ts#produce->consumer:packages/main/src/absent.ts#consume' });
    assert.ok(reconcileTopologyWithCoverageBasis(contract(nonexistentTopology), focusedBasis)
      .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'), 'well-formed but nonexistent basis-path remains fail-closed at reconciliation');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', 'export const c2 = () => true;\n');
    const omittedC2 = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(omittedC2.status, 'partial', 'consumerGate without a resolvable outside-scope consumer fails closed');
    assert.ok(omittedC2.blindSpots.some(item => item.includes('consumerGate but no resolvable consumer source')), 'missing C2 produces an explicit consumer-source blind spot');
    const omittedBasis = structuredClone(genericBasis);
    omittedBasis.phaseBasis = 'pre_review';
    omittedBasis.priorPlanBasisDigest = genericBasis.basisDigest;
    omittedBasis.adapterResults = omittedC2.adapterResults;
    omittedBasis.enumeratedPathRefs = omittedC2.enumeratedPathRefs;
    omittedBasis.blindSpots = omittedC2.blindSpots;
    redigestBasis(omittedBasis);
    assert.ok(reconcileTopologyWithCoverageBasis(contract(c2Topology), omittedBasis).some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'), 'omitting external C2 fails the reverse topology mapping');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { consumeReviewRun } from '../handlers/missing-review-run.js';",
      'export const c2 = () => consumeReviewRun();', '',
    ].join('\n'));
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'unresolvable outside-scope C2 import fails closed');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'export const c2 = () => consumeReviewRun();', '// content-bound mutation', '',
    ].join('\n'));
    const mutatedClosure = deriveRegisteredProcessFactClosure(genericRoot, [
      'packages/main/src/handlers/review-run.ts',
      'packages/main/src/consumers/c2.ts',
    ]);
    assert.notEqual(computeClosureFilesHash(genericRoot, [], mutatedClosure.sourceInventoryRefs), closureHash, 'outside-scope C2 content mutation stales the closure binding');

    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl.replace('registry.registerBatch(makeReviewHandlers(ctx));', '// deleted registerBatch(makeReviewHandlers(ctx));'));
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'deleted generic registerBatch fails closed');
    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl.replace('registry.registerBatch(makeReviewHandlers(ctx));', 'registry.registerBatch(factoryMap.review(ctx));'));
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'ambiguous dynamic factory registration fails closed');
    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl);
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'complete', 'restored generic alias factory control passes');
    const c2File = join(genericRoot, 'packages/main/src/consumers/c2.ts');
    chmodSync(c2File, 0o000);
    try {
      const unreadableFile = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
      assert.equal(unreadableFile.status, 'partial', 'unreadable inventoried source file fails closed without throwing');
      assert.ok(unreadableFile.blindSpots.some(item => item.includes('source file is unreadable')), 'unreadable file emits deterministic source blind spot');
    } finally {
      chmodSync(c2File, 0o600);
    }
    const externalConsumerRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-source-swap-'));
    try {
      write(externalConsumerRoot, 'c2.ts', "export const escaped = () => true;\n");
      rmSync(c2File, { force: true });
      symlinkSync(join(externalConsumerRoot, 'c2.ts'), c2File, 'file');
      const swappedSource = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
      assert.equal(swappedSource.status, 'partial', 'source-file symlink swap fails closed without reading external bytes');
      assert.ok(swappedSource.blindSpots.some(item => item.includes('symlink')), 'source-file symlink swap emits deterministic blind spot');
      rmSync(c2File, { force: true });
      const disappearedSource = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
      assert.equal(disappearedSource.status, 'partial', 'disappearing consumer source fails closed without throwing');
      assert.ok(disappearedSource.blindSpots.some(item => item.includes('consumerGate but no resolvable consumer source')), 'missing consumer source preserves the consumer diagnostic');
    } finally {
      rmSync(c2File, { force: true });
      rmSync(externalConsumerRoot, { recursive: true, force: true });
      write(genericRoot, 'packages/main/src/consumers/c2.ts', [
        "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
        'export const c2 = () => consumeReviewRun();', '',
      ].join('\n'));
    }
    write(genericRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'missing-src' }));
    resetConfigCache();
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'missing configured source root fails closed');
    write(genericRoot, 'proof-or-stop.config.json', '{');
    resetConfigCache();
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'malformed source-root config fails closed');
    write(genericRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '..', rootDir: 'outside' }));
    resetConfigCache();
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'lexically escaping source root fails closed');

    const externalRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-external-'));
    try {
      write(externalRoot, 'src/consumers/c2.ts', [
        "import { emitReviewRunFact as consumeReviewRun } from '../../../packages/main/src/handlers/review-run.js';",
        'export const escaped = () => consumeReviewRun();', '',
      ].join('\n'));
      symlinkSync(externalRoot, join(genericRoot, 'link'), 'dir');
      write(genericRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'link', rootDir: 'src' }));
      resetConfigCache();
      const symlinkEscape = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
      assert.equal(symlinkEscape.status, 'partial', 'intermediate source-root symlink escape fails closed');
      assert.ok(symlinkEscape.blindSpots.some(item => item.includes('symlink component')), 'intermediate source-root symlink reports a deterministic blind spot');
      assert.ok(!JSON.stringify(symlinkEscape).includes('link/src/consumers/c2.ts'), 'external source reached through symlink is never enumerated');
    } finally {
      rmSync(join(genericRoot, 'link'), { force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }

    mkdirSync(join(genericRoot, 'packages/main/locked'), { recursive: true });
    chmodSync(join(genericRoot, 'packages/main/locked'), 0o000);
    try {
      write(genericRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'locked' }));
      resetConfigCache();
      assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'unreadable configured source root fails closed');
    } finally {
      chmodSync(join(genericRoot, 'packages/main/locked'), 0o700);
    }
    write(genericRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    resetConfigCache();
  } finally {
    rmSync(genericRoot, { recursive: true, force: true });
  }

  const budgetRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-budget-'));
  try {
    for (const file of ['a/01.ts', 'a/02.ts', 'b/03.ts', 'b/04.ts']) write(budgetRoot, file, 'x\n');
    write(budgetRoot, 'a/unrelated.txt', 'ignored\n');
    const physicalBudgetRoot = realpathSync(budgetRoot);
    const exactBoundary = enumerateBoundedSourceTree(physicalBudgetRoot, physicalBudgetRoot, {
      maxDirectories: 10, maxEntries: 20, maxFiles: 4, maxBytes: 100,
    });
    assert.equal(exactBoundary.stopped, false, 'exact source inventory file boundary remains complete');
    assert.deepEqual(exactBoundary.files, ['a/01.ts', 'a/02.ts', 'b/03.ts', 'b/04.ts'], 'bounded traversal order is deterministic and unrelated extensions stay excluded');
    assert.deepEqual(exactBoundary.stats, { directories: 3, entries: 7, files: 4, bytes: 8, iteratorReads: 10, peakBufferedEntries: 3, handlesOpened: 3, handlesClosed: 3 }, 'exact-boundary traversal instrumentation is stable');

    const wideDeepRoot = join(budgetRoot, 'wide-deep');
    for (const file of ['a/00.ts', 'a/01.ts', 'a/02.ts', 'b/deep/03.ts', 'z-after/04.ts']) write(wideDeepRoot, file, 'x\n');
    const physicalWideDeepRoot = realpathSync(wideDeepRoot);
    const exhausted = enumerateBoundedSourceTree(physicalWideDeepRoot, physicalWideDeepRoot, {
      maxDirectories: 20, maxEntries: 20, maxFiles: 3, maxBytes: 100,
    });
    assert.equal(exhausted.stopped, true, 'global source inventory cap stops traversal from a deep recursive frame');
    assert.deepEqual(exhausted.files, ['a/00.ts', 'a/01.ts', 'a/02.ts'], 'over-cap candidate and later sibling tree are never retained');
    assert.deepEqual(exhausted.stats, { directories: 4, entries: 8, files: 3, bytes: 6, iteratorReads: 12, peakBufferedEntries: 3, handlesOpened: 4, handlesClosed: 4 }, 'instrumentation proves traversal stops on the first over-cap source candidate');
    assert.deepEqual(exhausted.blindSpots, ['configured source-root inventory exhausted maxFiles budget'], 'budget exhaustion emits one deterministic partial blind spot');
    for (const row of [
      { dimension: 'maxDirectories' as const, budget: { maxDirectories: 2, maxEntries: 20, maxFiles: 20, maxBytes: 100 }, stat: 'directories' as const, cap: 2 },
      { dimension: 'maxEntries' as const, budget: { maxDirectories: 20, maxEntries: 2, maxFiles: 20, maxBytes: 100 }, stat: 'entries' as const, cap: 2 },
      { dimension: 'maxBytes' as const, budget: { maxDirectories: 20, maxEntries: 20, maxFiles: 20, maxBytes: 4 }, stat: 'bytes' as const, cap: 4 },
    ]) {
      const bounded = enumerateBoundedSourceTree(physicalWideDeepRoot, physicalWideDeepRoot, row.budget);
      assert.equal(bounded.stopped, true, `${row.dimension} exhaustion stops globally`);
      assert.ok(bounded.stats[row.stat] <= row.cap, `${row.dimension} instrumentation never exceeds its cap`);
      assert.deepEqual(bounded.blindSpots, [`configured source-root inventory exhausted ${row.dimension} budget`], `${row.dimension} emits one deterministic blind spot`);
    }
    const exactDirectoryRoot = join(budgetRoot, 'exact-directories');
    write(exactDirectoryRoot, 'only-child/file.ts', 'x\n');
    const physicalExactDirectoryRoot = realpathSync(exactDirectoryRoot);
    const exactDirectories = enumerateBoundedSourceTree(physicalExactDirectoryRoot, physicalExactDirectoryRoot, {
      maxDirectories: 2, maxEntries: 5, maxFiles: 1, maxBytes: 10,
    });
    assert.equal(exactDirectories.stopped, false, 'directory count equal to maxDirectories remains complete');
    assert.equal(exactDirectories.stats.directories, 2, 'last permitted directory is visited');
    mkdirSync(join(exactDirectoryRoot, 'second-child'));
    const oneOverDirectories = enumerateBoundedSourceTree(physicalExactDirectoryRoot, physicalExactDirectoryRoot, {
      maxDirectories: 2, maxEntries: 5, maxFiles: 1, maxBytes: 10,
    });
    assert.equal(oneOverDirectories.stopped, true, 'first directory beyond maxDirectories fails partial');
    assert.deepEqual(oneOverDirectories.blindSpots, ['configured source-root inventory exhausted maxDirectories budget']);

    const fanoutRoot = join(budgetRoot, 'fanout');
    for (let index = 0; index < 64; index += 1) write(fanoutRoot, `${String(index).padStart(3, '0')}.ts`, 'x\n');
    const physicalFanoutRoot = realpathSync(fanoutRoot);
    const fanout = enumerateBoundedSourceTree(physicalFanoutRoot, physicalFanoutRoot, {
      maxDirectories: 2, maxEntries: 5, maxFiles: 64, maxBytes: 1024,
    });
    assert.equal(fanout.stopped, true, 'single high-fanout directory stops before admitting nondeterministic members');
    assert.deepEqual(fanout.files, [], 'over-wide directory admits no partial unsorted prefix');
    assert.equal(fanout.stats.iteratorReads, 6, 'streaming iterator reads at most remainingEntries plus one');
    assert.equal(fanout.stats.peakBufferedEntries, 6, 'streaming buffer is bounded at remainingEntries plus one');
    assert.deepEqual(fanout.blindSpots, ['configured source-root inventory exhausted maxEntries budget']);

    const readRoot = join(budgetRoot, 'read-budget');
    write(readRoot, 'a.ts', '12345');
    write(readRoot, 'b.ts', '67890');
    write(readRoot, 'oversized.ts', 'x'.repeat(32));
    const perFile = readBoundedSourceSetForTest(readRoot, ['oversized.ts'], { maxFiles: 10, maxBytes: 100, maxPerFileBytes: 8 });
    assert.equal(perFile.stats.maxAllocatedBytes, 0, 'oversized source is rejected before allocation');
    assert.ok(perFile.blindSpots.some(item => item.includes('lexical scan budget')), 'per-file rejection is explicit');
    const aggregate = readBoundedSourceSetForTest(readRoot, ['a.ts', 'b.ts'], { maxFiles: 10, maxBytes: 7, maxPerFileBytes: 8 });
    assert.deepEqual(aggregate.acceptedFiles, ['a.ts'], 'aggregate read budget applies across the source union');
    assert.equal(aggregate.stats.maxAllocatedBytes, 6, 'bounded allocation never exceeds accepted stat size plus sentinel');
    const noFollow = readBoundedSourceSetForTest(readRoot, ['a.ts'], { maxFiles: 10, maxBytes: 100, maxPerFileBytes: 8, forceNoFollow: true });
    assert.equal(noFollow.stats.maxAllocatedBytes, 0, 'missing O_NOFOLLOW rejects before allocation');
    assert.ok(noFollow.blindSpots.some(item => item.includes('no-follow')), 'missing O_NOFOLLOW is a deterministic blind spot');

    const mutationRoot = join(budgetRoot, 'directory-mutation');
    write(mutationRoot, 'stable.ts', 'x\n');
    const physicalMutationRoot = realpathSync(mutationRoot);
    const mutatedDirectory = enumerateBoundedSourceTree(physicalMutationRoot, physicalMutationRoot, {
      maxDirectories: 5, maxEntries: 10, maxFiles: 10, maxBytes: 100,
    }, { afterDirectoryRead: directory => write(directory, 'added.ts', 'x\n') });
    assert.deepEqual(mutatedDirectory.files, [], 'directory mutation discards the pre-mutation snapshot');
    assert.ok(mutatedDirectory.blindSpots.some(item => item.includes('changed during enumeration')), 'directory mutation emits an explicit blind spot');
    assert.equal(mutatedDirectory.stats.handlesOpened, mutatedDirectory.stats.handlesClosed, 'directory mutation closes every opened handle');
    assert.equal(mutatedDirectory.stats.entries, 1, 'discarded mutated directory still charges its iterator work');

    const closeFailureRoot = join(budgetRoot, 'directory-close-failure');
    write(closeFailureRoot, 'candidate.ts', 'x\n');
    const physicalCloseFailureRoot = realpathSync(closeFailureRoot);
    const closeFailure = enumerateBoundedSourceTree(physicalCloseFailureRoot, physicalCloseFailureRoot, {
      maxDirectories: 5, maxEntries: 10, maxFiles: 10, maxBytes: 100,
    }, { closeDirectory: () => { throw new Error('injected close failure'); } });
    assert.deepEqual(closeFailure.files, [], 'close failure admits no provisional directory rows');
    assert.ok(closeFailure.blindSpots.some(item => item.includes('close failed')), 'close failure emits an explicit blind spot');
    assert.equal(closeFailure.stats.handlesOpened, closeFailure.stats.handlesClosed, 'close failure path closes the handle in finally');
    assert.equal(closeFailure.stats.entries, 1, 'close-failed directory still charges iterator work');

    const finalMutationRoot = join(budgetRoot, 'directory-final-mutation');
    write(finalMutationRoot, 'a/first.ts', 'x\n');
    write(finalMutationRoot, 'b/second.ts', 'x\n');
    const physicalFinalMutationRoot = realpathSync(finalMutationRoot);
    const finalMutation = enumerateBoundedSourceTree(physicalFinalMutationRoot, physicalFinalMutationRoot, {
      maxDirectories: 5, maxEntries: 10, maxFiles: 10, maxBytes: 100,
    }, { beforeFinalRevalidation: () => write(finalMutationRoot, 'a/late.ts', 'x\n') });
    assert.deepEqual(finalMutation.files, [], 'late mutation invalidates the globally admitted inventory snapshot');
    assert.ok(finalMutation.blindSpots.some(item => item.includes('changed after enumeration')), 'late mutation of an earlier directory is detected');
    assert.equal(finalMutation.stats.handlesOpened, finalMutation.stats.handlesClosed, 'final revalidation path leaves no directory handles open');
  } finally {
    rmSync(budgetRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(pureRoot, { recursive: true, force: true });
}

const packageProfileRoot = mkdtempSync(join(tmpdir(), 'proofstory-package-profile-'));
try {
  write(packageProfileRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
  write(packageProfileRoot, 'packages/main/tsconfig.json', '{}\n');
  assert.equal(detectAcceptanceDiscoverySupport(packageProfileRoot), true, 'scanRoot tsconfig activates the canonical TypeScript profile without a root tsconfig');
  const representativeLargeConfig = JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    policyPadding: 'x'.repeat(70 * 1024),
  });
  assert.ok(
    Buffer.byteLength(representativeLargeConfig, 'utf8') > 64 * 1024
      && Buffer.byteLength(representativeLargeConfig, 'utf8') < 128 * 1024,
    'representative grown project config stays between the legacy and corrected bounded caps',
  );
  write(packageProfileRoot, 'proof-or-stop.config.json', representativeLargeConfig);
  assert.equal(detectAcceptanceDiscoverySupport(packageProfileRoot), true, 'valid project config above the legacy 64 KiB cap still activates discovery support');
  const overBoundedConfig = JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    policyPadding: 'x'.repeat(128 * 1024),
  });
  assert.ok(Buffer.byteLength(overBoundedConfig, 'utf8') > 128 * 1024, 'oversize control exceeds the corrected bounded cap');
  write(packageProfileRoot, 'proof-or-stop.config.json', overBoundedConfig);
  assert.equal(detectAcceptanceDiscoverySupport(packageProfileRoot), false, 'config beyond the corrected bounded cap remains fail-closed');
  write(packageProfileRoot, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '..', rootDir: 'src' }));
  assert.equal(detectAcceptanceDiscoverySupport(packageProfileRoot), false, 'escaping config cannot activate discovery support');
  rmSync(join(packageProfileRoot, 'proof-or-stop.config.json'));
  assert.equal(detectAcceptanceDiscoverySupport(packageProfileRoot), false, 'missing config cannot authorize a package-local profile');
} finally {
  rmSync(packageProfileRoot, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), 'proofstory-basis-cli-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'basis-smoke@example.test']);
  git(root, ['config', 'user.name', 'Basis Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist', testsDir: 'packages/main/tests', fixturesDir: 'packages/main/tests/fixtures' }, null, 2));
  write(root, 'packages/main/tsconfig.json', '{}\n');
  write(root, 'packages/main/src/acceptance-basis.json', '{"staticSource":true}\n');
  write(root, `.proof-or-stop/story/actives/${storyId}/evidence/acceptance-basis.json`, '{"nestedEvidence":true}\n');
  write(root, 'packages/main/src/producer.ts', 'export const produceBasis = () => true;\n');
  write(root, 'packages/main/src/consumer.ts', "import { produceBasis } from './producer.js'; export const verifyBasis = () => produceBasis(); export const invokeBasis=()=>verifyBasis();\n");
  writeCanonicalAcceptanceRegistration(root);
  resetConfigCache();
  const store = new StoryStore(root);
  const directHandlers = createProofStoryHandlers({ store, root, scanRoot: join(root, 'packages/main') } as HandlerContext);
  const story: StoryInfo = { storyId, name: 'basis-smoke', title: 'Basis smoke', description: 'real CLI basis smoke', type: 'feature', phase: 'PLAN', priority: 'high', createdAt: now, startedAt: now, endedAt: null, events: [] };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract());
  const cliScopeContract = scopeContract();
  cliScopeContract.allowedModify.push(`.proof-or-stop/story/actives/${storyId}/acceptance-basis.json`);
  cliScopeContract.allowedModify.push(`.proof-or-stop/story/actives/${storyId}/evidence/acceptance-basis.json`);
  cliScopeContract.allowedModify.push('packages/main/src/acceptance-basis.json');
  store.writeScopeContract(storyId, cliScopeContract);
  store.writeScopeCheck(storyId, scopeCheck(root));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed real basis repo']);
  const cliChecklist = run(root, 'checklist_get', { storyId });
  assert.match(cliChecklist, /VPP-BASIS/, `production CLI must read frozen planned declarations: ${cliChecklist}`);

  const generated = run(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.match(generated, /proofstory\.acceptance_basis_artifact\.v1/);
  let artifact = store.readAcceptanceBasis(storyId)!;
  assert.equal(artifact.basis.status, 'complete', `${generated}\nCLI CHECKLIST:\n${cliChecklist}`);
  const control = verifyAcceptanceBasisReceipt({ artifact, gitCwd: root, metadataRoot: root, expectedStoryId: storyId });
  assert.equal(control.ok, true, control.diagnostics.join('; '));
  assert.ok(
    artifact.basis.enumeratedPathRefs.some(ref => ref.includes('path:process-fact:artifact:acceptance-basis.json->consumer:')),
    'generated acceptance-basis artifact retains its canonical process-fact consumer path',
  );
  assert.equal(
    artifact.basis.sourceInventoryRefs.some(ref => ref === `source-file:closure:.proof-or-stop/story/actives/${storyId}/acceptance-basis.json`),
    false,
    'generated acceptance-basis bytes are not source closure content',
  );
  assert.ok(
    artifact.basis.sourceInventoryRefs.includes('source-file:closure:packages/main/src/acceptance-basis.json'),
    'a same-basename static source outside the configured story artifact directory remains in closure',
  );
  assert.ok(
    artifact.basis.sourceInventoryRefs.includes(`source-file:closure:.proof-or-stop/story/actives/${storyId}/evidence/acceptance-basis.json`),
    'a nested same-basename file is not confused with the canonical generated root artifact',
  );
  const firstSemanticDigest = acceptanceCoverageBasisSemanticDigest(artifact.basis);
  const firstClosureFilesHash = artifact.basis.binding.closureFilesHash;
  writeFileSync(
    join(root, `.proof-or-stop/story/actives/${storyId}/acceptance-basis.json`),
    `${readFileSync(join(root, `.proof-or-stop/story/actives/${storyId}/acceptance-basis.json`), 'utf8')}\n`,
  );
  const regenerated = run(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.match(regenerated, /proofstory\.acceptance_basis_artifact\.v1/);
  artifact = store.readAcceptanceBasis(storyId)!;
  assert.equal(artifact.basis.status, 'complete', 'consecutive generation remains complete after generated-artifact content mutation');
  assert.equal(artifact.basis.binding.closureFilesHash, firstClosureFilesHash, 'generated-artifact mutation does not stale source closure');
  assert.equal(acceptanceCoverageBasisSemanticDigest(artifact.basis), firstSemanticDigest, 'generated-artifact mutation does not alter basis semantics');
  const stableRead = run(root, 'acceptance_basis', { storyId, json: true });
  const stableTopology = run(root, 'acceptance_topology_check', { storyId, json: true });
  assert.doesNotMatch(stableRead, /AT_ADAPTER_RESULT_DIGEST_MISMATCH|AT_CLOSURE_FILES_STALE/);
  assert.doesNotMatch(stableTopology, /AT_ADAPTER_RESULT_DIGEST_MISMATCH|AT_CLOSURE_FILES_STALE/);
  write(root, `.proof-or-stop/story/actives/${storyId}/evidence/acceptance-basis.json`, '{"nestedEvidence":false}\n');
  assert.match(
    run(root, 'acceptance_basis', { storyId, json: true }),
    /basis semantic discovery digest mismatch|snapshot seal digest mismatch|"status": "invalid"/,
    'nested same-basename content mutation still bites',
  );
  write(root, `.proof-or-stop/story/actives/${storyId}/evidence/acceptance-basis.json`, '{"nestedEvidence":true}\n');
  run(root, 'acceptance_basis_generate', { storyId, json: true });
  artifact = store.readAcceptanceBasis(storyId)!;
  write(root, 'packages/main/src/acceptance-basis.json', '{"staticSource":false}\n');
  assert.match(
    run(root, 'acceptance_basis', { storyId, json: true }),
    /basis semantic discovery digest mismatch|snapshot seal digest mismatch|"status": "invalid"/,
    'same-basename static source mutation still bites',
  );
  write(root, 'packages/main/src/acceptance-basis.json', '{"staticSource":true}\n');
  run(root, 'acceptance_basis_generate', { storyId, json: true });
  artifact = store.readAcceptanceBasis(storyId)!;

  rmSync(join(root, 'packages/main/tsconfig.json'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'remove supported profile marker']);
  const unsupportedCli = run(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.match(unsupportedCli, /"status": "unsupported"/, 'real CLI emits unsupported when the registered profile is unavailable');
  write(root, 'packages/main/tsconfig.json', '{}\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'restore supported profile marker']);
  run(root, 'acceptance_basis_generate', { storyId, json: true });

  const productionHandler = bytes(root, 'packages/main/src/handlers/proofstory.ts');
  write(root, 'packages/main/src/handlers/proofstory.ts', productionHandler.replace('    acceptance_basis_generate() { return true; },', '    // imported acceptance_basis_generate token only; no handler method'));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'remove production handler dispatch']);
  const missingDispatch = run(root, 'acceptance_basis_generate', { storyId, json: true }, true);
  assert.match(missingDispatch, /partial|AT_DISCOVERY_DISAGREEMENT/, 'real CLI fails partial for an unregistered handler even when comments retain the token');
  write(root, 'packages/main/src/handlers/proofstory.ts', productionHandler);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'restore production handler dispatch']);
  run(root, 'acceptance_basis_generate', { storyId, json: true });
  artifact = store.readAcceptanceBasis(storyId)!;
  assert.equal(artifact.basis.status, 'complete');

  const fullSnapshot = () => ({
    story: bytes(root, `.proof-or-stop/story/actives/${storyId}/index.json`),
    checklist: bytes(root, `.proof-or-stop/story/actives/${storyId}/checklist.json`),
    contract: bytes(root, `.proof-or-stop/story/actives/${storyId}/proofstory.json`),
    scope: bytes(root, `.proof-or-stop/story/actives/${storyId}/scope-contract.json`),
    artifact: bytes(root, `.proof-or-stop/story/actives/${storyId}/acceptance-basis.json`),
    events: bytes(root, `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`),
    status: git(root, ['status', '--porcelain']),
  });
  const snapshot = fullSnapshot();
  const readOne = run(root, 'acceptance_basis', { storyId, json: true });
  const readTwo = run(root, 'acceptance_basis', { storyId, json: true });
  const readText = run(root, 'acceptance_basis', { storyId });
  assert.equal(readOne, readTwo, 'unchanged diagnostic JSON is byte-equivalent');
  assert.match(readOne, /"receiptVerification"/);
  assert.match(readText, /Mode: read-only; evidentiary: false/);
  assert.deepEqual(fullSnapshot(), snapshot, 'read-only text/JSON diagnostics mutate no story, checklist, contract, receipt, process event, phase, or git state');
  const lateWorkspaceC2 = join(root, 'packages/main/src/late-after-receipt.ts');
  writeFileSync(lateWorkspaceC2, 'export const lateAfterReceipt = true;\n');
  try {
    const lateWorkspaceRead = run(root, 'acceptance_basis', { storyId, json: true });
    assert.match(lateWorkspaceRead, /basis semantic discovery digest mismatch|snapshot seal digest mismatch|"status": "invalid"/, 'read-only verifier rederives the current physical seal and rejects a late C2');
  } finally {
    rmSync(lateWorkspaceC2, { force: true });
  }

  const forbiddenFields: Record<string, unknown> = {
    status: 'complete', enumeratedPathRefs: ['forged'], blindSpots: [], excludedPathRefs: [],
    generatedBy: { verifier: 'forged' }, digest: `sha256:${'0'.repeat(64)}`,
    receiptRef: 'receipt:forged', basisDigest: `sha256:${'1'.repeat(64)}`, issuer: 'forged', signature: 'forged',
    headHash: 'forged', materialHash: 'forged', storyFilesHash: 'forged', closureFilesHash: 'forged',
    workspaceIdentityDigest: 'forged', scopeCheckDigest: 'forged', scopeContractDigest: 'forged', topologyDigest: 'forged',
    adapterResults: [], discoveryMethods: [], discoveryProfileRef: 'forged', discoveryProfileDigest: 'forged',
    sourceInventoryRefs: [], plannedPathRecords: [], receipt: {}, binding: {}, evidence: {}, verdict: 'pass', authority: 'forged',
  };
  // Every row is an immutable rejection probe; actual CLI and direct-handler
  // assertions remain per row. The matrix shares the frozen fixture only while
  // all calls must refuse before writing; each completion rechecks atomicity.
  const probes=['acceptance_basis','acceptance_basis_generate'].flatMap(command=>Object.entries(forbiddenFields).map(([field,value])=>({command,field,value})));
  assert.equal(probes.length,58,'all forbidden fields and both consumers must remain covered');
  const probeHead=git(root,['rev-parse','HEAD']);
  let nextProbe=0,activeProbes=0,peakProbes=0;
  const completedProbes:string[]=[],probeFailures:unknown[]=[];
  await Promise.all(Array.from({length:probeJobs},async()=>{
    while(nextProbe<probes.length){
      const {command,field,value}=probes[nextProbe++];
      try{
        let forged='';activeProbes++;peakProbes=Math.max(peakProbes,activeProbes);
        try{const result=await execFileAsync(process.execPath,[cliPath,'--root',root,command,JSON.stringify({storyId,[field]:value})],{
          cwd:root,env:{...process.env,PROOF_OR_STOP_SESSION_ID:'acceptance-basis-smoke',PROOF_OR_STOP_AGENT:'proof-or-stop-implementer'},encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
        });throw new Error('FORBIDDEN_PROBE_UNEXPECTED_SUCCESS: '+result.stdout);}
        catch(error:any){
          if(error.killed||error.signal||typeof error.code!=='number'||error.code===0)throw error;
          forged=`${String(error.stdout||'')}${String(error.stderr||'')}${String(error.message||'')}`;}
        finally{activeProbes--;}
        assert.match(forged,/Forbidden|never|invalid|expected|unsupported caller fields/i,`${command} rejects caller ${field}`);
        assert.deepEqual(fullSnapshot(),snapshot,`${command} ${field} rejection is atomic`);
        assert.throws(()=>directHandlers[command]({storyId,[field]:value}),/unsupported caller fields/,`direct ${command} rejects caller ${field}`);
        assert.deepEqual(fullSnapshot(),snapshot,`direct ${command} ${field} rejection is atomic`);
        assert.equal(git(root,['rev-parse','HEAD']),probeHead,'rejected probes must not commit shared state');
        completedProbes.push(`${command}:${field}`);
      }catch(error){probeFailures.push(error);}
    }
  }));
  assert.equal(probeFailures.length,0,probeFailures.map(String).join('\n'));
  assert.deepEqual(completedProbes.sort(),probes.map(({command,field})=>`${command}:${field}`).sort(),'every forbidden field must run exactly once');
  assert.ok(peakProbes<=probeJobs&&(probeJobs===1||peakProbes>1),'requested bounded concurrency must actually execute');
  console.log('ACCEPTANCE_FORBIDDEN_FIELD_COVERAGE '+JSON.stringify({count:completedProbes.length,jobs:probeJobs,peak:peakProbes,ids:completedProbes}));
  const replayedOutput = run(root, 'acceptance_basis_generate', { storyId, evidence: JSON.parse(readOne) }, true);
  assert.match(replayedOutput, /Forbidden|never|invalid|unsupported caller fields/i, 'rendered diagnostic output cannot be replayed as authority');
  assert.deepEqual(fullSnapshot(), snapshot, 'output replay rejection is atomic');

  const mutations: Array<[string, (value: AcceptanceBasisArtifactV1) => void]> = [
    ['receipt schema version', value => { (value.receipt as any).schemaVersion = 'proofstory.acceptance_basis_receipt.v0'; }],
    ['signature', value => { value.receipt.signature = Buffer.alloc(64).toString('base64'); }],
    ['basis digest', value => { value.receipt.basisDigest = `sha256:${'0'.repeat(64)}`; }],
    ['topology digest', value => { value.receipt.topologyDigest = `sha256:${'4'.repeat(64)}`; }],
    ['story', value => { value.receipt.storyId = 'B-other'; }],
    ['phase basis', value => { value.receipt.phaseBasis = 'pre_review'; }],
    ['workspace', value => { value.receipt.workspaceIdentityDigest = `sha256:${'1'.repeat(64)}`; }],
    ['scope', value => { value.receipt.scopeCheckDigest = `sha256:${'2'.repeat(64)}`; }],
    ['scope contract', value => { value.receipt.scopeContractDigest = `sha256:${'5'.repeat(64)}`; }],
    ['head', value => { value.receipt.headHash = 'forged-head'; }],
    ['material', value => { value.receipt.materialHash = `sha256:${'6'.repeat(64)}`; }],
    ['story files', value => { value.receipt.storyFilesHash = `sha256:${'7'.repeat(64)}`; }],
    ['closure', value => { value.receipt.closureFilesHash = `sha256:${'3'.repeat(64)}`; }],
    ['snapshot seal', value => { value.receipt.sealDigest = `sha256:${'8'.repeat(64)}`; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(artifact);
    mutate(changed);
    assert.equal(verifyAcceptanceBasisReceipt({ artifact: changed, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, false, `${label} tamper bites`);
    assert.equal(verifyAcceptanceBasisReceipt({ artifact, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, true, `${label} restored control passes`);
  }
  const forgedIssuer = structuredClone(artifact);
  const attacker = generateEd25519KeyPair();
  forgedIssuer.receipt.signerPublicKey = attacker.publicKey;
  forgedIssuer.receipt.issuerKeyId = `sha256:${createHash('sha256').update(JSON.stringify(attacker.publicKey)).digest('hex')}`;
  const { signature: _oldSignature, ...forgedUnsigned } = forgedIssuer.receipt;
  forgedIssuer.receipt.signature = signCanonical(forgedUnsigned, attacker.privateKey);
  assert.equal(verifyAcceptanceBasisReceipt({ artifact: forgedIssuer, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, false, 'self-signed forged registered-verifier label is rejected against the registered local verifier key');
  assert.equal(verifyAcceptanceBasisReceipt({ artifact, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, true, 'forged issuer restored control passes');

  const adapterBindingTamper = structuredClone(artifact);
  const boundAdapter = adapterBindingTamper.basis.adapterResults[0];
  boundAdapter.pathRefs.push('path:forged:bound-adapter');
  redigestAdapter(boundAdapter);
  adapterBindingTamper.basis.enumeratedPathRefs.push('path:forged:bound-adapter');
  adapterBindingTamper.basis.enumeratedPathRefs.sort();
  redigestBasis(adapterBindingTamper.basis);
  assert.equal(verifyAcceptanceBasisReceipt({ artifact: adapterBindingTamper, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, false, 'adapter-set/result binding mutation with old receipt bites');
  const basisAndReceiptSealTamper = structuredClone(artifact);
  basisAndReceiptSealTamper.basis.snapshotSeal.sourceSnapshotCount += 1;
  redigestSnapshotSeal(basisAndReceiptSealTamper.basis.snapshotSeal);
  redigestBasis(basisAndReceiptSealTamper.basis);
  basisAndReceiptSealTamper.receipt.basisDigest = basisAndReceiptSealTamper.basis.basisDigest;
  basisAndReceiptSealTamper.receipt.sealDigest = basisAndReceiptSealTamper.basis.snapshotSeal.sealDigest;
  assert.equal(verifyAcceptanceBasisReceipt({ artifact: basisAndReceiptSealTamper, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, false, 'basis plus receipt seal re-digest cannot forge the registered verifier signature');

  const inventedProductionTopology = structuredClone(topology);
  inventedProductionTopology.consumerRefs[0].sourceRef = { refKind: 'existing', canonicalSourceRef: 'invented:C2' };
  store.writeProofStoryContract(storyId, contract(inventedProductionTopology));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'mutate production topology']);
  const inventedRead = run(root, 'acceptance_basis', { storyId, json: true });
  assert.match(inventedRead, /AT_TOPOLOGY_OUTSIDE_BASIS|AT_PLANNED_PATH_OUTSIDE_BASIS|"status": "invalid"/, 'production read runs topology reconciliation');
  const inventedGenerate = run(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.match(inventedGenerate, /"status": "partial"|AT_TOPOLOGY_OUTSIDE_BASIS/, 'production generate cannot accept invented topology as complete');
  store.writeProofStoryContract(storyId, contract());
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'restore production topology']);
  run(root, 'acceptance_basis_generate', { storyId, json: true });
  artifact = store.readAcceptanceBasis(storyId)!;
  assert.equal(artifact.basis.status, 'complete', 'restored production topology regenerates a complete control');

  const narrowedScope = scopeContract();
  narrowedScope.allowedCreate = ['packages/main/src/consumer.ts'];
  store.writeScopeContract(storyId, narrowedScope);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'mutate frozen scope']);
  assert.match(run(root, 'acceptance_basis', { storyId, json: true }), /scope-contract digest mismatch|AT_PLANNED_PATH_INVALID|"status": "invalid"/, 'frozen scope drift fails production read');
  store.writeScopeContract(storyId, scopeContract());
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'restore frozen scope']);
  run(root, 'acceptance_basis_generate', { storyId, json: true });

  const driftedChecklist = checklist();
  driftedChecklist.items[0].verificationIntent!.happy[0].plannedPathDeclarations![0].producer.expectedSymbolOrFact = 'missingProducer';
  store.writeChecklist(storyId, driftedChecklist);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'mutate frozen story declaration']);
  assert.match(run(root, 'acceptance_basis', { storyId, json: true }), /basis semantic discovery digest mismatch|AT_|"status": "invalid"/, 'frozen Story/discovery drift fails production read');
  store.writeChecklist(storyId, checklist());
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'restore frozen story declaration']);
  run(root, 'acceptance_basis_generate', { storyId, json: true });
  artifact = store.readAcceptanceBasis(storyId)!;
  assert.equal(artifact.basis.status, 'complete', 'restored scope and Story controls regenerate complete');

  const legacyId = 'B-basis-legacy';
  store.writeStory(legacyId, { ...story, storyId: legacyId, name: 'basis-legacy', title: 'Basis legacy' });
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed legacy story']);
  const legacySnapshot = {
    story: bytes(root, `.proof-or-stop/story/actives/${legacyId}/index.json`),
    artifact: bytes(root, `.proof-or-stop/story/actives/${legacyId}/acceptance-basis.json`),
    events: bytes(root, `.proof-or-stop/story/actives/${legacyId}/process-events.jsonl`),
    status: git(root, ['status', '--porcelain']),
  };
  assert.match(run(root, 'acceptance_basis', { storyId: legacyId, json: true }), /legacy_missing/, 'legacy story remains explicitly missing');
  assert.match(run(root, 'acceptance_basis_generate', { storyId: legacyId, status: 'complete' }, true), /Forbidden|invalid|unsupported/i, 'failed legacy generation rejects caller completeness');
  assert.deepEqual({
    story: bytes(root, `.proof-or-stop/story/actives/${legacyId}/index.json`),
    artifact: bytes(root, `.proof-or-stop/story/actives/${legacyId}/acceptance-basis.json`),
    events: bytes(root, `.proof-or-stop/story/actives/${legacyId}/process-events.jsonl`),
    status: git(root, ['status', '--porcelain']),
  }, legacySnapshot, 'legacy read and failed generation leave no partial artifact, event, or lifecycle mutation');

  write(root, 'packages/main/src/consumer.ts', "import { produceBasis } from './producer.js'; export const verifyBasis = () => produceBasis() && false; export const invokeBasis=()=>verifyBasis();\n");
  git(root, ['add', 'packages/main/src/consumer.ts']);
  git(root, ['commit', '-m', 'mutate closure source']);
  const stale = run(root, 'acceptance_basis', { storyId, json: true });
  assert.match(stale, /AT_COVERAGE_BASIS_STALE|AT_ADAPTER_RESULT_DIGEST_MISMATCH|closure files hash mismatch/, 'stale closure or workspace binding fails closed');

  const rebound = structuredClone(artifact);
  rebound.basis.binding.headHash = currentGitHead(root)!;
  rebound.basis.binding.materialHash = currentMaterialHash(root, 'HEAD', root)!;
  rebound.basis.binding.storyFilesHash = currentStoryFilesHash(root, 'HEAD', root)!;
  rebound.basis.binding.closureFilesHash = deriveAcceptanceCoverageBasis({
    storyId, workspaceRoot: root, checklist: checklist(), contract: contract(), scopeCheck: scopeCheck(root), scopeContract: scopeContract(),
    headHash: rebound.basis.binding.headHash, materialHash: rebound.basis.binding.materialHash, storyFilesHash: rebound.basis.binding.storyFilesHash,
  }).basis.binding.closureFilesHash;
  redigestBasis(rebound.basis);
  rebound.receipt.headHash = rebound.basis.binding.headHash;
  rebound.receipt.materialHash = rebound.basis.binding.materialHash;
  rebound.receipt.storyFilesHash = rebound.basis.binding.storyFilesHash;
  rebound.receipt.closureFilesHash = rebound.basis.binding.closureFilesHash;
  rebound.receipt.basisDigest = rebound.basis.basisDigest;
  const privateKey = readFileSync(join(root, '.git', 'proof-or-stop-acceptance-basis-verifier-v1.key'), 'utf8').trim();
  const { signature: _signature, ...unsignedReboundReceipt } = rebound.receipt;
  rebound.receipt.signature = signCanonical(unsignedReboundReceipt, privateKey);
  store.writeAcceptanceBasis(storyId, rebound);
  const reboundRead = run(root, 'acceptance_basis', { storyId, json: true });
  assert.match(reboundRead, /basis semantic discovery digest mismatch|"status": "invalid"/, 'freshly re-signed hash-only rebind without rerunning discovery fails');
} finally {
  rmSync(root, { recursive: true, force: true });
}

const freshnessRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-freshness-'));
try {
  git(freshnessRoot, ['init', '-b', 'main']);
  git(freshnessRoot, ['config', 'user.email', 'basis-smoke@example.test']);
  git(freshnessRoot, ['config', 'user.name', 'Basis Smoke']);
  write(freshnessRoot, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: 'packages/main', rootDir: 'src' }));
  write(freshnessRoot, 'packages/main/src/story-owned.ts', 'export const storyOwned = 1;\n');
  git(freshnessRoot, ['add', '.']);
  git(freshnessRoot, ['commit', '-m', 'base']);
  git(freshnessRoot, ['switch', '-c', 'story/freshness']);
  write(freshnessRoot, 'packages/main/src/story-owned.ts', 'export const storyOwned = 2;\n');
  git(freshnessRoot, ['add', '.']);
  git(freshnessRoot, ['commit', '-m', 'story material']);
  resetConfigCache();
  const evidenceHead = currentGitHead(freshnessRoot)!;
  const evidenceMaterial = currentMaterialHash(freshnessRoot, 'HEAD', freshnessRoot)!;
  const evidenceStoryFiles = currentStoryFilesHash(freshnessRoot, 'HEAD', freshnessRoot)!;
  write(freshnessRoot, '.proof-or-stop/story/actives/B-freshness/note.json', '{}\n');
  git(freshnessRoot, ['add', '.']);
  git(freshnessRoot, ['commit', '-m', 'metadata only']);
  const metadataArtifactBefore = bytes(freshnessRoot, '.proof-or-stop/story/actives/B-freshness/note.json');
  const headOnly = checkEvidenceFreshnessForGit(freshnessRoot, evidenceHead, evidenceMaterial, freshnessRoot, evidenceStoryFiles);
  assert.equal(headOnly.fresh, true, headOnly.reason);
  assert.match(headOnly.reason, /materialHash matches/, 'head-only metadata movement is classified by canonical material freshness');
  assert.equal(bytes(freshnessRoot, '.proof-or-stop/story/actives/B-freshness/note.json'), metadataArtifactBefore, 'freshness read never silently rewrites evidence');

  git(freshnessRoot, ['switch', 'main']);
  write(freshnessRoot, 'packages/main/src/unrelated.ts', 'export const unrelated = true;\n');
  git(freshnessRoot, ['add', '.']);
  git(freshnessRoot, ['commit', '-m', 'unrelated main material']);
  git(freshnessRoot, ['switch', 'story/freshness']);
  git(freshnessRoot, ['merge', '--no-edit', 'main']);
  const unrelatedMaterial = checkEvidenceFreshnessForGit(freshnessRoot, evidenceHead, evidenceMaterial, freshnessRoot, evidenceStoryFiles);
  assert.equal(unrelatedMaterial.fresh, true, unrelatedMaterial.reason);
  assert.match(unrelatedMaterial.reason, /storyFilesHash matches/, 'unrelated whole-tree material movement is advisory when story-owned files are unchanged');
  assert.ok(unrelatedMaterial.warnings?.some(item => /whole-tree materialHash drift/.test(item)));
} finally {
  rmSync(freshnessRoot, { recursive: true, force: true });
}

for (const mutation of [
  'drop-acceptance-basis-prompt',
  'drop-acceptance-basis-handler',
  'drop-acceptance-basis-registry',
  'drop-acceptance-basis-contract',
]) {
  let contractMutationOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/verify-process-fact-contract.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: mutation },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    contractMutationOutput = `${String(error.stdout || '')}${String(error.stderr || '')}`;
  }
  assert.match(contractMutationOutput, /acceptance basis contract|acceptance_basis_generate|required process fact missing|MAIN_TOOLS command missing/, `${mutation} bites the real contract verifier`);
}

console.log('ProofStory acceptance coverage basis Wave 1A smoke passed');
