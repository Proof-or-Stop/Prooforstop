#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { runPreReviewCheckGate } from '../handlers/transition-orchestrator.js';
import { signScopeCheck } from '../handlers/scope-check.js';
import type { AcceptanceVerificationTopologyV1, ChecklistData, ProofStoryContractData, ScopeCheckData, ScopeContractData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..', '..');
const latticeBin = join(repositoryRoot, 'bin/lattice.js');
const storyId = 'B-pre-review-smoke';
const baseAt = '2026-07-22T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}
function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function cli(root: string, command: string, args: Record<string, unknown>, allowFail = false): string {
  try {
    return execFileSync(process.execPath, [latticeBin, '--root', root, command, JSON.stringify(args)], {
      cwd: root, env: { ...process.env, LATTICE_SESSION_ID: 'sess-pre-review-smoke', LATTICE_AGENT: 'lattice-implementer' }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
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
  commandRefs: [{ refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' }],
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
  write(root, 'packages/main/src/cli/command-catalog.ts', "export const MAIN_TOOLS=[{name:'acceptance_basis'},{name:'acceptance_basis_generate'},{name:'pre_review_check'},{name:'pre_review_check_read'}];\n");
  write(root, 'packages/main/src/registry.ts', "import {createProofStoryHandlers} from './handlers/proofstory.js'; const r={registerBatch(_:unknown){}}; r.registerBatch(createProofStoryHandlers({} as any));\n");
  write(root, 'packages/main/src/handlers/proofstory.ts', "export function createProofStoryHandlers(){return{acceptance_basis(){},acceptance_basis_generate(){},pre_review_check(){},pre_review_check_read(){}}}\n");
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts', 'export function runPreReviewCheckGate(){}\n');
  write(root, 'packages/main/src/core/process-fact-registry.ts', "export const facts=['acceptance_basis','acceptance_basis_generate','pre_review_check','pre_review_check_read','artifact:pre-review-check.json'];\n");
  write(root, 'packages/main/src/core/acceptance-topology.ts', 'export const acceptanceTopology=true;\n');
  write(root, 'packages/main/src/core/agent-dispatch-registry.ts', 'export const agentDispatch=true;\n');
  write(root, 'packages/main/src/core/pre-review-check.ts', 'export const preReviewCheck=true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCritic=true;\n');
  write(root, 'scripts/verify-process-fact-contract.mjs', "export const facts=['pre_review_check','pre_review_check_read','artifact:pre-review-check.json'];\n");
}

const root = mkdtempSync(join(tmpdir(), 'proofstory-pre-review-'));
const originalCwd = process.cwd();
try {
  write(root, '.gitignore', '.lattice/runtime/\n');
  write(root, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'observe' } }));
  write(root, 'tsconfig.json', '{}\n');
  writeRegistration(root);
  write(root, 'packages/main/src/producer.ts', 'export const produceFact=()=>({fact:true});\n');
  write(root, 'packages/main/src/consumer.ts', 'export const consumeFact=(v:{fact:boolean})=>v.fact;\n');
  write(root, 'evidence/pre-review-transcript.json', JSON.stringify({ storyId, events: [{ kind: 'producer', intentRef: 'INT-PRE' }, { kind: 'consumer', intentRef: 'INT-PRE' }], mutation: { applied: true, expectedCode: 'PR_PRODUCTION_PATH_UNPROVEN', observedCode: 'PR_PRODUCTION_PATH_UNPROVEN', controlRestored: true } }));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Pre Review Smoke']); git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'seed']); git(root, ['switch', '-c', `story/${storyId}`]);
  process.chdir(root); resetConfigCache();
  const store = new StoryStore(root);
  const story = { storyId, name: storyId, title: 'pre review smoke', description: 'pre review smoke', type: 'feature', priority: 'high', phase: 'DEV', createdAt: baseAt, startedAt: baseAt, endedAt: null, events: [], worktree: { path: root, branch: `story/${storyId}`, createdAt: baseAt } } as StoryInfo;
  store.writeStory(storyId, story); store.writeChecklist(storyId, checklist()); store.writeProofStoryContract(storyId, contract()); store.writeScopeContract(storyId, scopeContract()); store.writeScopeCheck(storyId, scopeCheck(root));
  git(root, ['add', '.']); git(root, ['commit', '--author=lattice-implementer <lattice-implementer@noreply.local>', '-m', 'implementation']);
  const plan = cli(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.equal(JSON.parse(plan).artifact.basis.status, 'complete', plan);
  const data = store.readChecklist(storyId);
  const headHash = currentGitHead(root)!; const materialHash = currentMaterialHash(root, 'HEAD', root)!; const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root)!;
  data.items[0].verificationEvidence = [{ intentRef: 'INT-PRE', kind: 'integration_test', result: 'pass', command: 'node real-chain.js', note: 'real production producer reaches consumer; mutation bites and control restores',
    headHash, materialHash, storyFilesHash, timestamp: '2026-07-22T00:00:01.000Z',
    attestation: { kind: 'ci', actor: 'pre-review-smoke', command: 'node real-chain.js', artifactRef: 'transcript:producer-consumer', result: 'pass', attestedAt: '2026-07-22T00:00:01.000Z', checkedClaims: ['production-path', 'mutation-applied', 'mutation-bites', 'control-restored', 'transcript-related', 'authority-admissible', 'cutoff-bound'] },
    actorTrust: { producerActorId: 'producer-ci', verifierActorId: 'independent-verifier', trustStatus: 'trusted' } },
  { intentRef: 'INT-PRE', kind: 'manual_transcript', result: 'pass', file: 'evidence/pre-review-transcript.json', note: 'structured producer-before-consumer and mutation/control transcript',
    headHash, materialHash, storyFilesHash, timestamp: '2026-07-22T00:00:01.000Z',
    attestation: { kind: 'ci', actor: 'pre-review-smoke', artifactRef: 'evidence/pre-review-transcript.json', result: 'pass', checkedClaims: ['authority-admissible', 'cutoff-bound'] },
    actorTrust: { producerActorId: 'producer-ci', verifierActorId: 'independent-verifier', trustStatus: 'trusted' } }];
  store.writeChecklist(storyId, data);
  const produced = cli(root, 'pre_review_check', { storyId, json: true });
  let parsed = JSON.parse(produced);
  assert.equal(parsed.ok, true, produced);
  assert.equal(parsed.plannedActual, 'complete');
  assert.equal(parsed.mutations, 'biting');
  assert.equal(parsed.transcript, 'related');
  const read = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(cli(root, 'pre_review_check_read', { storyId, json: true }), cli(root, 'pre_review_check_read', { storyId, json: true }), 'read-only projection is byte-stable');
  assert.match(cli(root, 'pre_review_check', { storyId, json: true, verdict: 'pass' }, true), /Forbidden|invalid|unsupported/i, 'caller verdict/authority fields are rejected at the real CLI schema');
  const ctx = { root, scanRoot: join(root, 'packages/main'), store } as unknown as HandlerContext;
  assert.match(runPreReviewCheckGate(ctx, storyId), /status=pass/);

  const originalContract = structuredClone(store.readProofStoryContract(storyId)!);
  const omittedContract = structuredClone(originalContract);
  omittedContract.acceptanceBindings[0].verificationTopology!.consumerRefs = [];
  store.writeProofStoryContract(storyId, omittedContract);
  const omitted = cli(root, 'pre_review_check', { storyId, json: true });
  assert.match(omitted, /PR_NEW_PATH_UNMAPPED|PR_COVERAGE_BASIS_CHANGED/, 'topology-only omission bites while the current basis retains the path');
  store.writeProofStoryContract(storyId, originalContract);
  parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(parsed.ok, true, 'exact topology restoration returns the clean control to PASS');

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

  write(root, 'evidence/pre-review-transcript.json', JSON.stringify({ storyId, events: [{ kind: 'consumer', intentRef: 'INT-PRE' }, { kind: 'producer', intentRef: 'INT-PRE' }], mutation: { applied: true, expectedCode: 'X', observedCode: 'X', controlRestored: true } }));
  const unrelatedTranscript = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
  assert.ok(unrelatedTranscript.codes.includes('PR_TRANSCRIPT_UNRELATED'), JSON.stringify(unrelatedTranscript.codes));
  write(root, 'evidence/pre-review-transcript.json', JSON.stringify({ storyId, events: [{ kind: 'producer', intentRef: 'INT-PRE' }, { kind: 'consumer', intentRef: 'INT-PRE' }], mutation: { applied: true, expectedCode: 'PR_PRODUCTION_PATH_UNPROVEN', observedCode: 'PR_PRODUCTION_PATH_UNPROVEN', controlRestored: true } }));

  write(root, 'packages/main/src/consumer.ts', 'export const wrongSymbol=()=>false;\n'); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'mutation remove planned consumer']);
  const unresolved = cli(root, 'pre_review_check', { storyId, json: true });
  assert.match(unresolved, /PR_PLANNED_PATH_UNRESOLVED/, 'removing the declared current consumer makes planned-to-actual reconciliation fail');
  write(root, 'packages/main/src/consumer.ts', 'export const consumeFact=(v:{fact:boolean})=>v.fact;\n'); git(root, ['add', 'packages/main/src/consumer.ts']); git(root, ['commit', '-m', 'restore planned consumer']);
  parsed = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true })); assert.equal(parsed.ok, true, 'source restoration returns clean control to PASS');

  const equalCutoff = store.readChecklist(storyId); equalCutoff.items[0].verificationEvidence![0].timestamp = parsed.artifact.cutoffAt; store.writeChecklist(storyId, equalCutoff);
  const cutoff = cli(root, 'pre_review_check_read', { storyId, json: true });
  assert.match(cutoff, /PR_POSITIVE_EVIDENCE_MISSING|PR_CUTOFF_UNBOUND/, 'evidence at cutoff is excluded (>= fail-closed)');

  // Flat project mode is the only rollout selector in Wave 3. Rebind the PLAN
  // basis/evidence after config material changes so the mode assertions test
  // admission semantics rather than unrelated freshness failures.
  const rebindEvidence = (): void => {
    const value = store.readChecklist(storyId);
    const binding = { headHash: currentGitHead(root)!, materialHash: currentMaterialHash(root, 'HEAD', root)!, storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! };
    for (const row of value.items[0].verificationEvidence ?? []) Object.assign(row, binding, { timestamp: '2026-07-22T00:00:01.000Z' });
    store.writeChecklist(storyId, value);
  };
  write(root, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'enforce' } }));
  git(root, ['add', 'lattice.config.json']); git(root, ['commit', '-m', 'enable flat enforce mode']); resetConfigCache();
  rebindEvidence(); cli(root, 'acceptance_basis_generate', { storyId, json: true });
  const enforce = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(enforce.blocking, true); assert.ok(enforce.codes.includes('PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED'));
  assert.throws(() => runPreReviewCheckGate(ctx, storyId), /executable pre-review gate blocked DEV admission/);

  write(root, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', proofStory: { acceptanceTopologyGateMode: 'warn' } }));
  git(root, ['add', 'lattice.config.json']); git(root, ['commit', '-m', 'rollback flat mode to warn']); resetConfigCache();
  rebindEvidence(); cli(root, 'acceptance_basis_generate', { storyId, json: true });
  const warn = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));
  assert.equal(warn.blocking, false); assert.equal(warn.ok, true); assert.match(runPreReviewCheckGate(ctx, storyId), /mode=warn; status=pass/);

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
} finally {
  process.chdir(originalCwd); resetConfigCache(); rmSync(root, { recursive: true, force: true });
}
