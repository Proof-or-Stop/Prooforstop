#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { runPreReviewCheckGate } from '../handlers/transition-orchestrator.js';
import { loadVerifiedPreReviewExecutableProof, PRE_REVIEW_LIVE_PROOF_COMMAND } from '../core/pre-review-check.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { signScopeCheck } from '../handlers/scope-check.js';
import { buildActiveStoryPreReviewLiveProof, buildPreReviewLiveProof } from '../core/pre-review-live-proof.js';
import type { AcceptanceVerificationTopologyV1, ChecklistData, ProofStoryContractData, ScopeCheckData, ScopeContractData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..', '..');
const latticeBin = join(repositoryRoot, 'bin/lattice.js');
const storyId = 'B-pre-review-smoke';
const baseAt = '2026-07-22T00:00:00.000Z';
const liveProofMode = process.argv.includes('--live-proof');
const consumerControlSource = "import { produceFact } from './producer.js'; export const consumeFact=()=>produceFact().fact; export const invokeConsumer=()=>consumeFact();\n";

if (liveProofMode) {
  const activeStoryId = process.env.LATTICE_ACTIVE_STORY_ID;
  if (!activeStoryId) throw new Error('--live-proof requires LATTICE_ACTIVE_STORY_ID from live_smoke_transcript');
  const proof = buildActiveStoryPreReviewLiveProof(process.cwd(), activeStoryId);
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
function cli(root: string, command: string, args: Record<string, unknown>, allowFail = false, agent = 'lattice-implementer', sessionId = 'sess-pre-review-smoke'): string {
  try {
    return execFileSync(process.execPath, [latticeBin, '--root', root, command, JSON.stringify(args)], {
      cwd: root, env: { ...process.env, LATTICE_SESSION_ID: sessionId, LATTICE_AGENT: agent }, encoding: 'utf8',
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
  return {
    schemaVersion: 'proofstory.pre_review_executable_proof.v1', storyId: story,
    producer: 'test-output-is-untrusted-until-canonical-runner-receipt', verifier: 'test-output-is-untrusted-until-pre-review-verifier', commandDigests: [`sha256:${'1'.repeat(64)}`],
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
    return { storyId, checkedAt: baseAt, reviewRound: '', agentId: 'lattice-review-scope-plan', issues: [], features: [], summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 }, _hash: signScopeCheck(storyId, baseAt, 0, 1, '') } as unknown as ScopeCheckData;
  } finally { process.chdir(cwd); }
}
function writeRegistration(root: string): void {
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
  write(root, 'packages/main/src/core/pre-review-check.ts', 'export const preReviewCheck=true;\n');
  write(root, 'packages/main/src/core/pre-review-live-proof.ts', 'export const preReviewLiveProof=true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCritic=true;\n');
  write(root, 'scripts/verify-process-fact-contract.mjs', "export const facts=['pre_review_check','pre_review_check_read','artifact:pre-review-check.json'];\n");
}

function writeLiveProofFixture(root: string, proof: unknown): void {
  write(root, 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js', `console.log(${JSON.stringify(`PROOFSTORY_PRE_REVIEW_PROOF=${JSON.stringify(proof)}`)});\n`);
}

function writeActiveLiveProofRunner(root: string): void {
  const moduleUrl = new URL('../core/pre-review-live-proof.js', import.meta.url).href;
  write(root, 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js', [
    `import { buildActiveStoryPreReviewLiveProof } from ${JSON.stringify(moduleUrl)};`,
    "const storyId = process.env.LATTICE_ACTIVE_STORY_ID;",
    "if (!storyId) throw new Error('missing LATTICE_ACTIVE_STORY_ID');",
    "console.log('PROOFSTORY_PRE_REVIEW_PROOF=' + JSON.stringify(buildActiveStoryPreReviewLiveProof(process.cwd(), storyId)));",
    '',
  ].join('\n'));
}

const secondStoryContract = contract();
secondStoryContract.storyId = 'B-pre-review-second';
const secondStoryProof = buildPreReviewLiveProof({ storyId: secondStoryContract.storyId, checklist: checklist(), contract: secondStoryContract, ledger: null });
assert.equal(secondStoryProof.storyId, 'B-pre-review-second', 'live proof derives story identity from invocation context');
assert.equal(secondStoryProof.bindingProofs[0].mutationProofs[0].observedCode, 'AT_UNKNOWN_REF', 'live proof records the evaluator-observed mutation outcome');
assert.ok(secondStoryProof.commandDigests.length >= 3, 'positive, mutation, and transcript case artifacts are digest-bound');

const root = mkdtempSync(join(tmpdir(), 'proofstory-pre-review-'));
const originalCwd = process.cwd();
try {
  smoke: {
  write(root, '.gitignore', '.lattice/runtime/\n');
  write(root, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'observe' } }));
  write(root, 'tsconfig.json', '{}\n');
  writeRegistration(root);
  write(root, 'packages/main/src/producer.ts', 'export const produceFact=()=>({fact:true});\n');
  write(root, 'packages/main/src/consumer.ts', consumerControlSource);
  write(root, 'emit-proof.mjs', `console.log(${JSON.stringify(`PROOFSTORY_PRE_REVIEW_PROOF=${JSON.stringify(fixtureProof)}`)});\n`);
  writeActiveLiveProofRunner(root);
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Pre Review Smoke']); git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'seed']); git(root, ['switch', '-c', `story/${storyId}`]);
  process.chdir(root); resetConfigCache();
  const store = new StoryStore(root);
  const story = { storyId, name: storyId, title: 'pre review smoke', description: 'pre review smoke', type: 'feature', priority: 'high', phase: 'DEV', createdAt: baseAt, startedAt: baseAt, endedAt: null, events: [], worktree: { path: root, branch: `story/${storyId}`, createdAt: baseAt } } as StoryInfo;
  store.writeStory(storyId, story); store.writeChecklist(storyId, checklist()); store.writeProofStoryContract(storyId, contract()); store.writeScopeContract(storyId, scopeContract()); store.writeScopeCheck(storyId, scopeCheck(root));
  git(root, ['add', '.']); git(root, ['commit', '--author=lattice-implementer <lattice-implementer@noreply.local>', '-m', 'implementation']);
  const plan = cli(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.equal(JSON.parse(plan).artifact.basis.status, 'complete', plan);
  if (!liveProofMode) {
    const missing = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.deepEqual(missing.codes, ['PR_ARTIFACT_MISSING']);
    assert.match(missing.remediation.join('\n'), /Run lattice pre_review_check/);
  }
  cli(root, 'verification_evidence_batch_add', { storyId, evidences: [{ itemId: 'CHK-001', intentRef: 'INT-PRE', kind: 'integration_test', result: 'pass', command: 'node emit-proof.mjs', note: 'caller self-report must not become pre-review authority', attestation: { kind: 'ci', actor: 'self-reported', checkedClaims: ['production-path', 'mutation-bites', 'control-restored', 'transcript-related', 'authority-admissible'] }, actorTrust: { producerActorId: 'claimed-producer', verifierActorId: 'claimed-verifier', trustStatus: 'trusted' } }] });
  if (!liveProofMode) {
    const selfReported = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
    assert.equal(selfReported.ok, false); assert.ok(selfReported.codes.includes('PR_AUTHORITY_INADMISSIBLE'));
  }
  write(root, `.lattice/story/actives/${storyId}/evidence/live-smoke-transcript.json`, JSON.stringify({ storyId, mode: { runCommands: true, writeEvidence: true }, actual: { command: 'node emit-proof.mjs', exitCode: 0, stdout: `PROOFSTORY_PRE_REVIEW_PROOF=${JSON.stringify(fixtureProof)}` } }));
  const directStoreBypass = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(directStoreBypass.ok, false); assert.ok(directStoreBypass.codes.includes('PR_AUTHORITY_INADMISSIBLE'), 'direct StoryStore/file writes have no canonical causal producer receipt');
  const captured = JSON.parse(cli(root, 'live_smoke_transcript', { storyId, capture: PRE_REVIEW_LIVE_PROOF_COMMAND, write: true, json: true }));
  assert.equal(captured.transcript.status, 'present-fresh');
  if (!liveProofMode) assert.ok(loadVerifiedPreReviewExecutableProof({ gitCwd: root, metadataRoot: root, storyDir: store.storyDirPath(storyId), storyId, cutoffAt: new Date(Date.now() + 1000).toISOString(), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! }), 'canonical runner transcript has causal receipt and exact proof envelope');
  const produced = cli(root, 'pre_review_check', { storyId, json: true });
  let parsed = JSON.parse(produced);
  assert.equal(parsed.ok, true, produced);
  assert.equal(parsed.plannedActual, 'complete');
  assert.equal(parsed.mutations, 'biting');
  assert.equal(parsed.transcript, 'related');
  if (!liveProofMode) {
    const read = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(cli(root, 'pre_review_check_read', { storyId, json: true }), cli(root, 'pre_review_check_read', { storyId, json: true }), 'read-only projection is byte-stable');
    assert.match(cli(root, 'pre_review_check', { storyId, json: true, verdict: 'pass' }, true), /Forbidden|invalid|unsupported/i, 'caller verdict/authority fields are rejected at the real CLI schema');
  }
  const ctx = { root, scanRoot: join(root, 'packages/main'), store } as unknown as HandlerContext;
  assert.match(runPreReviewCheckGate(ctx, storyId), /status=pass/);

  const captureProof = (proof: unknown): void => {
    writeLiveProofFixture(root, proof);
    cli(root, 'live_smoke_transcript', { storyId, capture: PRE_REVIEW_LIVE_PROOF_COMMAND, write: true, json: true });
  };

  if (!liveProofMode) {
    const originalContract = structuredClone(store.readProofStoryContract(storyId)!);
    const omittedContract = structuredClone(originalContract);
    omittedContract.acceptanceBindings[0].verificationTopology!.consumerRefs = [];
    store.writeProofStoryContract(storyId, omittedContract);
    const omitted = cli(root, 'pre_review_check', { storyId, json: true });
    assert.match(omitted, /PR_NEW_PATH_UNMAPPED|PR_COVERAGE_BASIS_CHANGED/, 'topology-only omission bites while the current basis retains the path');
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
  for (const [label, mutate] of artifactMutations) {
    const value = structuredClone(artifact); mutate(value); store.writePreReviewCheck(storyId, value);
    const tampered = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
    assert.ok(tampered.codes.includes('PR_ARTIFACT_TAMPERED'), `${label}: ${JSON.stringify(tampered.codes)}`);
  }
  store.writePreReviewCheck(storyId, parsed.artifact);

  const missingTranscriptProof = structuredClone(fixtureProof); missingTranscriptProof.bindingProofs[0].transcriptProofs = [];
  captureProof(missingTranscriptProof);
  const missingTranscript = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.ok(missingTranscript.codes.includes('PR_TRANSCRIPT_MISSING'), JSON.stringify(missingTranscript.codes));
  const duplicateMutationProof = structuredClone(fixtureProof); duplicateMutationProof.bindingProofs[0].mutationProofs.push(structuredClone(duplicateMutationProof.bindingProofs[0].mutationProofs[0]));
  captureProof(duplicateMutationProof);
  const duplicateMutation = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.ok(duplicateMutation.codes.includes('PR_MUTATION_EVIDENCE_MISSING'), JSON.stringify(duplicateMutation.codes));
  const wrongObservedOutcome = structuredClone(fixtureProof); wrongObservedOutcome.bindingProofs[0].mutationProofs[0].observedCode = 'FORGED_SAME_ID_OUTCOME';
  captureProof(wrongObservedOutcome);
  const wrongObserved = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.ok(wrongObserved.codes.includes('PR_MUTATION_DID_NOT_BITE'), 'retaining mutation IDs while tampering the observed outcome bites');
  const missingBindingProof = structuredClone(fixtureProof); missingBindingProof.bindingProofs = [];
  captureProof(missingBindingProof);
  const missingBinding = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.ok(missingBinding.codes.includes('PR_PRODUCTION_PATH_UNPROVEN'), JSON.stringify(missingBinding.codes));
  captureProof(fixtureProof);
  parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'exact executable proof restoration returns PASS');

  write(root, 'packages/main/src/consumer.ts', 'export const wrongSymbol=()=>false;\n'); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'mutation remove planned consumer']);
  const unresolved = cli(root, 'pre_review_check', { storyId, json: true });
  assert.match(unresolved, /PR_PLANNED_PATH_UNRESOLVED/, 'removing the declared current consumer makes planned-to-actual reconciliation fail');
  write(root, 'packages/main/src/consumer.ts', consumerControlSource); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'restore planned consumer']);
  parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'source restoration returns clean control to PASS');
  write(root, 'packages/main/src/consumer.ts', "import { produceFact } from './producer.js'; export function consumeFact(){return produceFact().fact;} export const consumeFact=()=>produceFact().fact; export const invokeConsumer=()=>consumeFact();\n"); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'mutation ambiguous planned consumer']);
  const ambiguous = cli(root, 'pre_review_check', { storyId, json: true });
  assert.match(ambiguous, /PR_PLANNED_PATH_UNRESOLVED/, 'multiple exact symbol declarations are ambiguous rather than self-certifying actual coverage');
  write(root, 'packages/main/src/consumer.ts', consumerControlSource); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'restore unique planned consumer']);
  parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'unique AST-discovered endpoint restoration returns PASS');
  for (const [label, source] of [
    ['interface', 'export interface consumeFact { value: boolean }\n'],
    ['type', 'export type consumeFact = { value: boolean };\n'],
    ['enum', 'export enum consumeFact { Value }\n'],
    ['dead const', 'export const consumeFact = 42;\n'],
    ['nested property', 'export const holder = { consumeFact() { return true; } };\n'],
    ['unreachable callable', 'export const consumeFact = () => true;\n'],
  ] as const) {
    write(root, 'packages/main/src/consumer.ts', source); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', `mutation ${label} is not a runtime consumer`]);
    assert.match(cli(root, 'pre_review_check', { storyId, json: true }), /PR_PLANNED_PATH_UNRESOLVED/, `${label} name collision cannot satisfy planned actual runtime reachability`);
  }
  write(root, 'packages/main/src/consumer.ts', consumerControlSource); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'restore callable producer consumer chain']);
  captureProof(fixtureProof);
  parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'registered/exported callable relation restoration returns PASS');
  const controlKindChecklist = store.readChecklist(storyId);
  const wrongKindChecklist = structuredClone(controlKindChecklist);
  wrongKindChecklist.items[0].verificationIntent!.happy[0].plannedPathDeclarations![0].consumers[0].expectedArtifactKind = 'process_fact';
  store.writeChecklist(storyId, wrongKindChecklist);
  assert.match(cli(root, 'pre_review_check', { storyId, json: true }), /PR_PLANNED_PATH_UNRESOLVED/, 'artifact-kind mismatch cannot reuse a callable handler name as a process fact');
  store.writeChecklist(storyId, controlKindChecklist);
  captureProof(fixtureProof);

  const equalCutoff = store.readChecklist(storyId); equalCutoff.items[0].verificationEvidence![0].timestamp = parsed.artifact.cutoffAt; store.writeChecklist(storyId, equalCutoff);
  const cutoff = cli(root, 'pre_review_check_read', { storyId, json: true });
  assert.match(cutoff, /PR_ARTIFACT_TAMPERED|PR_POSITIVE_EVIDENCE_MISSING|PR_CUTOFF_UNBOUND/, 'evidence timestamp mutation at the signed cutoff fails closed');

  // Flat project mode is the only rollout selector in Wave 3. Rebind the PLAN
  // basis/evidence after config material changes so the mode assertions test
  // admission semantics rather than unrelated freshness failures.
  const rebindEvidence = (): void => {
    cli(root, 'verification_evidence_batch_add', { storyId, evidences: [{ itemId: 'CHK-001', intentRef: 'INT-PRE', kind: 'integration_test', result: 'pass', command: 'node emit-proof.mjs', note: 'production evidence writer refreshes current proof binding' }] });
    captureProof(fixtureProof);
  };
  write(root, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'enforce' } }));
  git(root, ['add', 'lattice.config.json']); git(root, ['commit', '-m', 'enable flat enforce mode']); resetConfigCache();
  rebindEvidence(); cli(root, 'acceptance_basis_generate', { storyId, json: true });
  const enforce = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(enforce.blocking, true); assert.ok(enforce.codes.includes('PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED'));
  assert.throws(() => runPreReviewCheckGate(ctx, storyId), /executable pre-review gate blocked DEV admission/);
  cli(root, 'dispatch', { storyId, itemId: 'CHK-001', agentType: 'lattice-implementer' }, false, 'lattice-implementer', 'sess-pre-review-impl');
  git(root, ['config', 'user.name', 'Independent Topology Critic']); git(root, ['config', 'user.email', 'critic@noreply.local']);
  cli(root, 'dispatch', { storyId, agentType: 'lattice-review-topology-critic' }, false, 'lattice-review-topology-critic', 'sess-pre-review-critic');
  const critic = JSON.parse(cli(root, 'topology_critic_receipt_set', { storyId, verdict: 'pass', json: true }, false, 'lattice-review-topology-critic', 'sess-pre-review-critic'));
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
  cli(root, 'topology_critic_receipt_set', { storyId, verdict: 'pass', json: true }, false, 'lattice-review-topology-critic', 'sess-pre-review-critic');
  const restoredEnforce = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(restoredEnforce.ok, true, JSON.stringify(restoredEnforce));
  const restoredCtx = { root, scanRoot: join(root, 'packages/main'), store: new StoryStore(root) } as unknown as HandlerContext;
  assert.match(runPreReviewCheckGate(restoredCtx, storyId), /mode=enforce; status=pass/);

  write(root, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'warn' } }));
  git(root, ['add', 'lattice.config.json']); git(root, ['commit', '-m', 'rollback flat mode to warn']); resetConfigCache();
  rebindEvidence(); cli(root, 'acceptance_basis_generate', { storyId, json: true });
  const warn = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(warn.blocking, false); assert.equal(warn.ok, true);
  const warnCtx = { root, scanRoot: join(root, 'packages/main'), store: new StoryStore(root) } as unknown as HandlerContext;
  assert.match(runPreReviewCheckGate(warnCtx, storyId), /mode=warn; status=pass/);

  const handlerSource = readFileSync(join(repositoryRoot, 'packages/main/src/handlers/proofstory.ts'), 'utf8');
  const consumerSource = readFileSync(join(repositoryRoot, 'packages/main/src/handlers/transition-orchestrator.ts'), 'utf8');
  assert.match(handlerSource, /evaluatePreReviewCheckForContext/);
  assert.match(consumerSource, /runPreReviewCheckGate/);
  assert.doesNotMatch(handlerSource + consumerSource, /selective_applicability_check|rollout_telemetry/);
  console.log('ProofStory pre-review check smoke: PASS');
  console.log('  producer/read/lifecycle verifier parity: PASS');
  console.log('  planned→actual + executable/mutation/transcript/authority: PASS');
  console.log('  tamper + equal-cutoff mutations: BITING');
  console.log('  topology omission + observe/enforce/warn rollback: PASS');
  console.log('  Wave 3A/Wave 4 leakage: absent');
  }
} finally {
  process.chdir(originalCwd); resetConfigCache(); rmSync(root, { recursive: true, force: true });
}
