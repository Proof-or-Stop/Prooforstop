#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveAcceptanceCoverageBasis,
  derivePlannedCoveragePaths,
  computeClosureFilesHash,
  digestAcceptanceCoverageBasis,
  foundationalExclusionDecisionRef,
  reconcileTopologyWithCoverageBasis,
  verifyAcceptanceCoverageBasis,
} from '../core/acceptance-coverage-basis.js';
import {
  reconcileAcceptanceDiscoveryResults,
  deriveRegisteredProcessFactClosure,
  digestCoverageAdapterResult,
  runAcceptanceDiscoveryAdapters,
} from '../core/acceptance-discovery-adapters.js';
import { verifyAcceptanceBasisReceipt } from '../core/acceptance-basis-receipt.js';
import { generateEd25519KeyPair, signCanonical } from '../core/authority-signing.js';
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
const cliPath = join(packageRoot, 'cli.js');
const storyId = 'B-basis-smoke';
const now = '2026-07-22T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, LATTICE_SESSION_ID: 'acceptance-basis-smoke', LATTICE_AGENT: 'lattice-implementer' },
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

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-BASIS',
  relation: 'producer_to_consumer' as const,
  producer: {
    id: 'EP-PRODUCER', role: 'producer' as const, expectedArtifactKind: 'handler' as const,
    expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produceBasis', fileDeclarationRef: 'CHK-001:files:create:0',
  },
  consumers: [{
    id: 'EP-CONSUMER', role: 'consumer' as const, expectedArtifactKind: 'process_fact' as const,
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
    { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
  ],
};

function writeCanonicalAcceptanceRegistration(root: string): void {
  write(root, 'packages/main/src/cli/command-catalog.ts', [
    'export const MAIN_TOOLS = [',
    "  { name: 'acceptance_basis' },",
    "  { name: 'acceptance_basis_generate' },",
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
    '  };',
    '}',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/core/process-fact-registry.ts', 'export const acceptance_basis_generate = "acceptance_basis read-only receipt verification and diagnostic rendering boundary";\n');
  write(root, 'scripts/verify-process-fact-contract.mjs', 'export const acceptance_basis_generate = "acceptance_basis read-only receipt verification and diagnostic rendering boundary";\n');
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
    storyId, checkedAt: now, reviewRound: '', agentId: 'lattice-review-scope-plan', issues: [], features: [],
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
  write(pureRoot, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
  writeCanonicalAcceptanceRegistration(pureRoot);
  const plannedBeforeCode = deriveAcceptanceCoverageBasis({
    storyId, workspaceRoot: pureRoot, checklist: checklist(), contract: contract(), scopeCheck: scopeCheck(pureRoot), scopeContract: scopeContract(),
    headHash: 'head', materialHash: 'material', storyFilesHash: 'story', supported: true,
  });
  assert.equal(plannedBeforeCode.basis.status, 'complete', `valid PLAN endpoints are structurally complete before implementation files exist: ${JSON.stringify({ diagnostics: plannedBeforeCode.diagnostics, adapters: plannedBeforeCode.basis.adapterResults }, null, 2)}`);
  write(pureRoot, 'packages/main/src/producer.ts', 'export const produceBasis = () => true;\n');
  write(pureRoot, 'packages/main/src/consumer.ts', 'export const verifyBasis = () => true;\n');
  const input = {
    storyId, workspaceRoot: pureRoot, checklist: checklist(), contract: contract(), scopeCheck: scopeCheck(pureRoot), scopeContract: scopeContract(),
    headHash: 'head', materialHash: 'material', storyFilesHash: 'story', supported: true,
  };
  const first = deriveAcceptanceCoverageBasis(input);
  const adapterControl = runAcceptanceDiscoveryAdapters({ supported: true, workspaceRoot: pureRoot, storyId, plannedPathRecords: first.basis.plannedPathRecords, scopeRefs: ['S1', 'scope:file:packages/main/src/handlers/proofstory.ts'] });
  const globalClosure = deriveRegisteredProcessFactClosure(pureRoot, ['packages/main/src/handlers/proofstory.ts']);
  assert.ok(globalClosure.pathRefs.some(path => path.includes('acceptance_basis_generate->consumer:<audit-only>')), 'non-gate writer remains registered without inventing a lifecycle consumer');
  assert.ok(globalClosure.pathRefs.some(path => path.includes('artifact:acceptance-basis.json') && path.includes('consumer:acceptance_basis read-only receipt verification')), 'signed artifact retains its read-only verifier consumer boundary');
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
  disagreementDispatch.pathRefs = ['path:process-fact:forged-dispatch->consumer:<audit-only>'];
  redigestAdapter(disagreementDispatch);
  assert.ok(reconcileAcceptanceDiscoveryResults(disagreement).diagnostics.some(item => item.code === 'AT_DISCOVERY_DISAGREEMENT'), 'unexplained registry/dispatch disagreement bites');
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
  closureRegistry.pathRefs = closureRegistry.pathRefs.filter(path => !path.includes('artifact:acceptance-basis.json'));
  redigestAdapter(closureRegistry);
  redigestBasis(closureAdapterOmission);
  assert.ok(!verifyAcceptanceCoverageBasis(closureAdapterOmission).ok, 'omitting registered consumer path from one closure adapter fails disagreement verification');
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

  const genericRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-generic-'));
  try {
    write(genericRoot, 'tsconfig.json', '{}\n');
    write(genericRoot, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    write(genericRoot, 'packages/main/src/cli/command-catalog.ts', "export const MAIN_TOOLS = [\n  { name: 'review_run_start' },\n];\n");
    write(genericRoot, 'packages/main/src/handlers/review-run.ts', [
      'export const emitReviewRunFact = () => true;',
      'export function createReviewRunHandlers() {',
      '  return {',
      '    review_run_start() { return emitReviewRunFact(); },',
      '  };',
      '}',
      '',
    ].join('\n'));
    const genericRegistryControl = [
      "import { createReviewRunHandlers as makeReviewHandlers } from './handlers/review-run.js';",
      'const registry = { registerBatch: (_handlers: unknown) => undefined };',
      'const ctx = {};',
      'registry.registerBatch(makeReviewHandlers(ctx));',
      '',
    ].join('\n');
    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl);
    write(genericRoot, 'packages/main/src/consumers/c2.ts', [
      "import { emitReviewRunFact as consumeReviewRun } from '../handlers/review-run.js';",
      'export const c2 = () => consumeReviewRun();',
      '',
    ].join('\n'));
    write(genericRoot, 'packages/main/src/unrelated.ts', 'export const unrelated = () => true;\n');
    const genericInput = {
      supported: true, workspaceRoot: genericRoot, storyId: 'B-generic', plannedPathRecords: [],
      scopeRefs: ['scope:file:packages/main/src/handlers/review-run.ts'],
    };
    const genericControl = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(genericControl.status, 'complete', JSON.stringify(genericControl, null, 2));
    const c2Path = genericControl.enumeratedPathRefs.find(path => path.includes('static-call:packages/main/src/handlers/review-run.ts#emitReviewRunFact') && path.includes('consumer:packages/main/src/consumers/c2.ts#consumeReviewRun'));
    assert.ok(c2Path, 'empty planned declarations still discover a non-ProofStory handler and its unregistered external C2 consumer');
    assert.ok(genericControl.enumeratedPathRefs.some(path => path.includes('process-fact:review_run_start')), 'generic factory alias resolves the registered review-run command');
    assert.ok(!genericControl.enumeratedPathRefs.some(path => path.includes('acceptance_basis')), 'bounded graph does not pull the unrelated process registry universe');
    const closureControl = deriveRegisteredProcessFactClosure(genericRoot, ['packages/main/src/handlers/review-run.ts']);
    assert.ok(closureControl.sourceFileRefs.includes('packages/main/src/consumers/c2.ts'), 'outside-scope C2 is discovered from canonical source-root reverse import/call inventory');
    assert.ok(!closureControl.sourceFileRefs.includes('packages/main/src/unrelated.ts'), 'unrelated source inventory file without a call relation stays outside closure');
    const closureHash = computeClosureFilesHash(genericRoot, [], closureControl.sourceInventoryRefs);

    const genericBasis = structuredClone(first.basis);
    genericBasis.storyId = 'B-generic';
    genericBasis.adapterResults = genericControl.adapterResults;
    genericBasis.discoveryMethods = genericControl.adapterResults.map(item => item.method).sort();
    genericBasis.enumeratedPathRefs = genericControl.enumeratedPathRefs;
    genericBasis.blindSpots = genericControl.blindSpots;
    genericBasis.plannedPathRecords = [];
    redigestBasis(genericBasis);
    const c2Topology: AcceptanceVerificationTopologyV1 = {
      schemaVersion: 'proofstory.acceptance_topology.v1', producerRefs: [], consumerRefs: [], positiveAssertionRefs: [], mutationCaseRefs: [], transcriptAssertionRefs: [],
      commandRefs: genericControl.enumeratedPathRefs.map(path => ({ refKind: 'existing' as const, canonicalSourceRef: `basis-path:${path}` })),
    };
    assert.equal(reconcileTopologyWithCoverageBasis(contract(c2Topology), genericBasis).length, 0, 'restored generic C2 topology control passes');
    write(genericRoot, 'packages/main/src/consumers/c2.ts', 'export const c2 = () => true;\n');
    const omittedC2 = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput));
    assert.equal(omittedC2.status, 'partial', 'consumerGate without a resolvable outside-scope consumer fails closed');
    assert.ok(omittedC2.blindSpots.some(item => item.includes('consumerGate but no resolvable consumer source')), 'missing C2 produces an explicit consumer-source blind spot');
    const omittedBasis = structuredClone(genericBasis);
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
    const mutatedClosure = deriveRegisteredProcessFactClosure(genericRoot, ['packages/main/src/handlers/review-run.ts']);
    assert.notEqual(computeClosureFilesHash(genericRoot, [], mutatedClosure.sourceInventoryRefs), closureHash, 'outside-scope C2 content mutation stales the closure binding');

    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl.replace('registry.registerBatch(makeReviewHandlers(ctx));', '// deleted registerBatch(makeReviewHandlers(ctx));'));
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'deleted generic registerBatch fails closed');
    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl.replace('registry.registerBatch(makeReviewHandlers(ctx));', 'registry.registerBatch(factoryMap.review(ctx));'));
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'ambiguous dynamic factory registration fails closed');
    write(genericRoot, 'packages/main/src/registry.ts', genericRegistryControl);
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'complete', 'restored generic alias factory control passes');
    write(genericRoot, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'missing-src' }));
    resetConfigCache();
    assert.equal(reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters(genericInput)).status, 'partial', 'missing configured source root fails closed');
    write(genericRoot, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    resetConfigCache();
  } finally {
    rmSync(genericRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(pureRoot, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), 'proofstory-basis-cli-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'basis-smoke@example.test']);
  git(root, ['config', 'user.name', 'Basis Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({ storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist', testsDir: 'packages/main/tests', fixturesDir: 'packages/main/tests/fixtures' }, null, 2));
  write(root, 'tsconfig.json', '{}\n');
  write(root, 'packages/main/src/producer.ts', 'export const produceBasis = () => true;\n');
  write(root, 'packages/main/src/consumer.ts', 'export const verifyBasis = () => true;\n');
  writeCanonicalAcceptanceRegistration(root);
  resetConfigCache();
  const store = new StoryStore(root);
  const directHandlers = createProofStoryHandlers({ store, root, scanRoot: join(root, 'packages/main') } as HandlerContext);
  const story: StoryInfo = { storyId, name: 'basis-smoke', title: 'Basis smoke', description: 'real CLI basis smoke', type: 'feature', phase: 'PLAN', priority: 'high', createdAt: now, startedAt: now, endedAt: null, events: [] };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract());
  store.writeScopeContract(storyId, scopeContract());
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

  rmSync(join(root, 'tsconfig.json'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'remove supported profile marker']);
  const unsupportedCli = run(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.match(unsupportedCli, /"status": "unsupported"/, 'real CLI emits unsupported when the registered profile is unavailable');
  write(root, 'tsconfig.json', '{}\n');
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
    story: bytes(root, `.lattice/story/actives/${storyId}/index.json`),
    checklist: bytes(root, `.lattice/story/actives/${storyId}/checklist.json`),
    contract: bytes(root, `.lattice/story/actives/${storyId}/proofstory.json`),
    scope: bytes(root, `.lattice/story/actives/${storyId}/scope-contract.json`),
    artifact: bytes(root, `.lattice/story/actives/${storyId}/acceptance-basis.json`),
    events: bytes(root, `.lattice/story/actives/${storyId}/process-events.jsonl`),
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

  const forbiddenFields: Record<string, unknown> = {
    status: 'complete', enumeratedPathRefs: ['forged'], blindSpots: [], excludedPathRefs: [],
    generatedBy: { verifier: 'forged' }, digest: `sha256:${'0'.repeat(64)}`,
    receiptRef: 'receipt:forged', basisDigest: `sha256:${'1'.repeat(64)}`, issuer: 'forged', signature: 'forged',
    headHash: 'forged', materialHash: 'forged', storyFilesHash: 'forged', closureFilesHash: 'forged',
    workspaceIdentityDigest: 'forged', scopeCheckDigest: 'forged', scopeContractDigest: 'forged', topologyDigest: 'forged',
    adapterResults: [], discoveryMethods: [], discoveryProfileRef: 'forged', discoveryProfileDigest: 'forged',
    sourceInventoryRefs: [], plannedPathRecords: [], receipt: {}, binding: {}, evidence: {}, verdict: 'pass', authority: 'forged',
  };
  for (const command of ['acceptance_basis', 'acceptance_basis_generate']) {
    for (const [field, value] of Object.entries(forbiddenFields)) {
      const forged = run(root, command, { storyId, [field]: value }, true);
      assert.match(forged, /Forbidden|never|invalid|expected|unsupported caller fields/i, `${command} rejects caller ${field}`);
      assert.deepEqual(fullSnapshot(), snapshot, `${command} ${field} rejection is atomic`);
      assert.throws(() => directHandlers[command]({ storyId, [field]: value }), /unsupported caller fields/, `direct ${command} rejects caller ${field}`);
      assert.deepEqual(fullSnapshot(), snapshot, `direct ${command} ${field} rejection is atomic`);
    }
  }
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
    story: bytes(root, `.lattice/story/actives/${legacyId}/index.json`),
    artifact: bytes(root, `.lattice/story/actives/${legacyId}/acceptance-basis.json`),
    events: bytes(root, `.lattice/story/actives/${legacyId}/process-events.jsonl`),
    status: git(root, ['status', '--porcelain']),
  };
  assert.match(run(root, 'acceptance_basis', { storyId: legacyId, json: true }), /legacy_missing/, 'legacy story remains explicitly missing');
  assert.match(run(root, 'acceptance_basis_generate', { storyId: legacyId, status: 'complete' }, true), /Forbidden|invalid|unsupported/i, 'failed legacy generation rejects caller completeness');
  assert.deepEqual({
    story: bytes(root, `.lattice/story/actives/${legacyId}/index.json`),
    artifact: bytes(root, `.lattice/story/actives/${legacyId}/acceptance-basis.json`),
    events: bytes(root, `.lattice/story/actives/${legacyId}/process-events.jsonl`),
    status: git(root, ['status', '--porcelain']),
  }, legacySnapshot, 'legacy read and failed generation leave no partial artifact, event, or lifecycle mutation');

  write(root, 'packages/main/src/consumer.ts', 'export const verifyBasis = () => false;\n');
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
  const privateKey = readFileSync(join(root, '.git', 'lattice-acceptance-basis-verifier-v1.key'), 'utf8').trim();
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
  write(freshnessRoot, 'lattice.config.json', JSON.stringify({ storyDir: '.lattice/story/actives', scanRoot: 'packages/main', rootDir: 'src' }));
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
  write(freshnessRoot, '.lattice/story/actives/B-freshness/note.json', '{}\n');
  git(freshnessRoot, ['add', '.']);
  git(freshnessRoot, ['commit', '-m', 'metadata only']);
  const metadataArtifactBefore = bytes(freshnessRoot, '.lattice/story/actives/B-freshness/note.json');
  const headOnly = checkEvidenceFreshnessForGit(freshnessRoot, evidenceHead, evidenceMaterial, freshnessRoot, evidenceStoryFiles);
  assert.equal(headOnly.fresh, true, headOnly.reason);
  assert.match(headOnly.reason, /materialHash matches/, 'head-only metadata movement is classified by canonical material freshness');
  assert.equal(bytes(freshnessRoot, '.lattice/story/actives/B-freshness/note.json'), metadataArtifactBefore, 'freshness read never silently rewrites evidence');

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

const projectRoot = resolve(packageRoot, '../../..');
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
      env: { ...process.env, LATTICE_PROCESS_FACT_CONTRACT_MUTATION: mutation },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    contractMutationOutput = `${String(error.stdout || '')}${String(error.stderr || '')}`;
  }
  assert.match(contractMutationOutput, /acceptance basis contract|acceptance_basis_generate|required process fact missing|MAIN_TOOLS command missing/, `${mutation} bites the real contract verifier`);
}

console.log('ProofStory acceptance coverage basis Wave 1A smoke passed');
