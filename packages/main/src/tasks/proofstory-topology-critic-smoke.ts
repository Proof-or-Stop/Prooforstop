#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { resetSessionIdForTest } from '../core/owner-session.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { signScopeCheck } from '../handlers/scope-check.js';
import type { AcceptanceVerificationTopologyV1, ChecklistData, ProofStoryContractData, ScopeCheckData, ScopeContractData, StoryInfo, TopologyCriticReceiptV1 } from '../core/types.js';
import {
  canonicalTopologyReceiptContext,
  deriveImplementationProvenance,
  deriveRoleProvenance,
  independenceMatrix,
  issueTopologyCriticReceipt,
  issueTopologyExclusionApproval,
  TOPOLOGY_CRITIC_ROLE,
  TOPOLOGY_EXCLUSION_APPROVER_ROLE,
  verifyTopologyCriticReceipt,
} from '../core/topology-critic-receipt.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storyId = 'B-topology-critic-smoke';
const now = '2026-07-22T00:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function asSession<T>(agent: string, sessionId: string, fn: () => T): T {
  const priorAgent = process.env.LATTICE_AGENT;
  const priorSession = process.env.LATTICE_SESSION_ID;
  process.env.LATTICE_AGENT = agent;
  process.env.LATTICE_SESSION_ID = sessionId;
  resetSessionIdForTest();
  try { return fn(); }
  finally {
    if (priorAgent === undefined) delete process.env.LATTICE_AGENT; else process.env.LATTICE_AGENT = priorAgent;
    if (priorSession === undefined) delete process.env.LATTICE_SESSION_ID; else process.env.LATTICE_SESSION_ID = priorSession;
    resetSessionIdForTest();
  }
}

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-CRITIC', relation: 'producer_to_consumer' as const,
  producer: { id: 'EP-P', role: 'producer' as const, expectedArtifactKind: 'handler' as const, expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produce', fileDeclarationRef: 'CHK-001:files:create:0' },
  consumers: [{ id: 'EP-C', role: 'consumer' as const, expectedArtifactKind: 'process_fact' as const, expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'consume', fileDeclarationRef: 'CHK-001:files:create:1' }],
  outputFactRef: 'process-fact:topology-critic',
};

const topology: AcceptanceVerificationTopologyV1 = {
  schemaVersion: 'proofstory.acceptance_topology.v1',
  producerRefs: [{ id: 'P', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-1:VPP-CRITIC', endpointRef: 'EP-P' } }],
  consumerRefs: [{ id: 'C', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-1:VPP-CRITIC', endpointRef: 'EP-C' }, producerRefs: ['P'] }],
  positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-1' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  mutationCaseRefs: [{ id: 'M', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-1' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  transcriptAssertionRefs: [{ id: 'T', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-1' }, producerRefs: ['P'], consumerRefs: ['C'] }],
  commandRefs: [{ refKind: 'existing', canonicalSourceRef: 'intent:INT-1' }],
};

function checklist(): ChecklistData {
  return { items: [{ id: 'CHK-001', title: 'critic', context: 'smoke', status: 'pending', startTime: null, endTime: null,
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: { happy: [{ id: 'INT-1', desc: 'producer reaches consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [declaration] }], edge: [], adversarial: [] },
  }] };
}

function contract(): ProofStoryContractData {
  return { schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'high_assurance', triggerReasons: [],
    acceptanceBindings: [{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-1'], milestoneIds: [], verificationTopology: topology }],
    diagnosticGaps: [], createdAt: now, updatedAt: now };
}

function scopeContract(): ScopeContractData {
  return { storyId, mode: 'local', allowedModify: [], allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: now, updatedAt: now };
}

function scopeCheck(root: string): ScopeCheckData {
  const base = { storyId, checkedAt: now, reviewRound: '', agentId: 'lattice-review-scope-plan', issues: [], features: [], summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 } } as unknown as ScopeCheckData;
  const cwd = process.cwd(); process.chdir(root);
  try { return { ...base, _hash: signScopeCheck(storyId, now, 0, 1, '') }; }
  finally { process.chdir(cwd); }
}

function writeDiscoveryRegistration(root: string): void {
  write(root, 'packages/main/src/cli/command-catalog.ts', "export const MAIN_TOOLS=[{name:'acceptance_basis'},{name:'acceptance_basis_generate'},{name:'topology_critic_receipt_set'},{name:'topology_critic_receipt_check'}];\n");
  write(root, 'packages/main/src/registry.ts', "import {createProofStoryHandlers} from './handlers/proofstory.js'; const registry={registerBatch(_:unknown){}}; registry.registerBatch(createProofStoryHandlers({} as any));\n");
  write(root, 'packages/main/src/handlers/proofstory.ts', "export function createProofStoryHandlers(){return{acceptance_basis(){},acceptance_basis_generate(){},topology_critic_receipt_set(){},topology_critic_receipt_check(){}}}\n");
  write(root, 'packages/main/src/core/process-fact-registry.ts', "export const facts=['acceptance_basis','acceptance_basis_generate','topology_critic_receipt_set','topology_critic_receipt_check','artifact:acceptance-basis.json'];\n");
  write(root, 'scripts/verify-process-fact-contract.mjs', "export const facts=['acceptance_basis','acceptance_basis_generate','topology_critic_receipt_set','topology_critic_receipt_check','artifact:acceptance-basis.json'];\n");
  write(root, 'packages/main/src/core/acceptance-topology.ts', 'export const acceptanceTopology=true;\n');
  write(root, 'packages/main/src/core/agent-dispatch-registry.ts', 'export const topologyCriticRole=true;\n');
  write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCriticReceipt=true;\n');
  write(root, 'packages/main/src/handlers/transition-orchestrator.ts', 'export const topologyConsumer=true;\n');
}

const root = mkdtempSync(join(tmpdir(), 'proofstory-topology-critic-'));
const originalCwd = process.cwd();
try {
  write(root, 'lattice.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements' }));
  write(root, 'tsconfig.json', '{}\n');
  writeDiscoveryRegistration(root);
  write(root, 'packages/main/src/producer.ts', 'export const produce=()=>true;\n');
  write(root, 'packages/main/src/consumer.ts', 'export const consume=()=>true;\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Independent Reviewer']);
  git(root, ['config', 'user.email', 'reviewer@noreply.local']);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'base']);
  git(root, ['switch', '-c', `story/${storyId}`]);
  write(root, 'packages/main/src/implementation.ts', 'export const implemented=true;\n');
  git(root, ['add', '.']); git(root, ['commit', '--author=lattice-implementer <lattice-implementer@noreply.local>', '-m', 'implement topology critic fixture']);
  process.chdir(root);

  resetConfigCache();
  const store = new StoryStore(root);
  const story = { storyId, name: storyId, title: 'smoke', description: 'smoke', type: 'feature', priority: 'high', phase: 'PLAN', createdAt: now, startedAt: null, endedAt: null, events: [], worktree: { path: root, branch: `story/${storyId}`, createdAt: now } } as StoryInfo;
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract());
  store.writeScopeContract(storyId, scopeContract());
  store.writeScopeCheck(storyId, scopeCheck(root));
  const ctx = { root, scanRoot: join(root, 'packages/main'), store };
  const dispatch = createStoryDispatchHandlers(ctx);
  asSession(TOPOLOGY_EXCLUSION_APPROVER_ROLE, 'sess-scope', () => dispatch.dispatch({ storyId, agentType: TOPOLOGY_EXCLUSION_APPROVER_ROLE }));
  story.phase = 'DEV'; store.writeStory(storyId, story);
  asSession('lattice-implementer', 'sess-impl', () => dispatch.dispatch({ storyId, itemId: 'CHK-001', agentType: 'lattice-implementer' }));
  asSession(TOPOLOGY_CRITIC_ROLE, 'sess-critic', () => dispatch.dispatch({ storyId, agentType: TOPOLOGY_CRITIC_ROLE }));
  git(root, ['add', '.']); git(root, ['commit', '-m', 'record story inputs and dispatch provenance']);

  const handlers = createProofStoryHandlers(ctx);
  const basisOutput = handlers.acceptance_basis_generate({ storyId, json: true });
  assert.equal(JSON.parse(basisOutput).artifact.basis.status, 'complete', basisOutput);
  const producerOutput = asSession(TOPOLOGY_CRITIC_ROLE, 'sess-critic', () => handlers.topology_critic_receipt_set({ storyId, verdict: 'pass', json: true }));
  assert.equal(JSON.parse(producerOutput).verification.ok, true, producerOutput);
  const checkOutput = handlers.topology_critic_receipt_check({ storyId, json: true });
  assert.equal(JSON.parse(checkOutput).verification.ok, true, checkOutput);

  const artifact = store.readAcceptanceBasis(storyId)!;
  const receipt = store.readTopologyCriticReceipt(storyId)!;
  const events = store.readProcessEvents(storyId);
  const implementation = deriveImplementationProvenance(root, events);
  const context = canonicalTopologyReceiptContext({ storyId, basisStatus: artifact.basis.status, basisDigest: artifact.basis.basisDigest,
    topologyDigest: receipt.topologyDigest, scopeCheckDigest: artifact.basis.binding.scopeCheckDigest,
    ...(artifact.basis.binding.scopeContractDigest ? { scopeContractDigest: artifact.basis.binding.scopeContractDigest } : {}),
    storyFilesHash: artifact.basis.binding.storyFilesHash, closureFilesHash: artifact.basis.binding.closureFilesHash, exclusions: [], findingRefs: [] });
  const verify = (candidate: TopologyCriticReceiptV1 | null, nextContext = context, approvals: any[] = []) => verifyTopologyCriticReceipt({ gitCwd: root, context: nextContext, receipt: candidate, approvals, implementation });
  assert.equal(verify(receipt).ok, true, 'clean production receipt passes');

  const topLevelFields: Array<keyof TopologyCriticReceiptV1> = ['schemaVersion', 'storyId', 'criticIdentity', 'criticRole', 'criticProvenance', 'implementationProvenance', 'basisDigest', 'topologyDigest', 'scopeCheckDigest', 'scopeContractDigest', 'storyFilesHash', 'closureFilesHash', 'findingRefs', 'approvedExclusionRefs', 'verdict', 'issuedAt', 'signerPublicKey', 'signature'];
  for (const field of topLevelFields) {
    const changed = structuredClone(receipt) as any;
    if (field === 'signature') changed[field] = 'forged';
    else if (field === 'findingRefs' || field === 'approvedExclusionRefs') changed[field] = ['forged'];
    else if (field === 'criticProvenance' || field === 'implementationProvenance') changed[field] = { ...changed[field], sessionId: 'forged' };
    else if (field === 'scopeContractDigest') changed[field] = 'sha256:forged';
    else changed[field] = `${String(changed[field])}-forged`;
    assert.equal(verify(changed).ok, false, `tampering ${field} must fail`);
  }
  for (const field of ['basisDigest', 'topologyDigest', 'scopeCheckDigest', 'scopeContractDigest', 'storyFilesHash', 'closureFilesHash'] as const) {
    const drifted = { ...context, [field]: 'sha256:drift' };
    assert.equal(verify(receipt, drifted).ok, false, `${field} freshness drift must fail`);
  }
  for (const dimension of ['agentId', 'sessionId', 'dispatchId', 'businessIdentity'] as const) {
    const collided = { ...receipt.criticProvenance, [dimension]: dimension === 'businessIdentity' ? implementation.businessCommitAuthor : implementation[dimension] };
    assert.throws(() => issueTopologyCriticReceipt({ gitCwd: root, context, critic: collided, implementation, approvals: [], verdict: 'pass' }), /independence failed/, `${dimension} collision must fail before signing`);
  }
  assert.deepEqual(independenceMatrix(receipt.criticProvenance, implementation), { agent: true, session: true, dispatch: true, businessCommitAuthor: true });
  assert.throws(() => deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: 'lattice-review-topology-critic-spoof', sessionId: 'sess-critic' }), /role eligibility failed/);
  assert.throws(() => deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: TOPOLOGY_CRITIC_ROLE, sessionId: 'sess-impl' }), /no registered dispatch provenance/);
  assert.equal(verify(receipt, { ...context, basisStatus: 'partial' }).ok, false, 'critic cannot override partial');
  assert.equal(verify(receipt, { ...context, basisStatus: 'unsupported' }).ok, false, 'critic cannot override unsupported');

  const scopeActor = deriveRoleProvenance({ gitCwd: root, events, expectedRole: TOPOLOGY_EXCLUSION_APPROVER_ROLE, actor: TOPOLOGY_EXCLUSION_APPROVER_ROLE, sessionId: 'sess-scope' });
  const criticActor = receipt.criticProvenance;
  const excludedContext = canonicalTopologyReceiptContext({ ...context, exclusions: [{ pathRef: 'scope:C2', decisionRef: 'decision:C2' }] });
  const approval = issueTopologyExclusionApproval({ gitCwd: root, context: excludedContext, exclusionRef: 'decision:C2', actor: scopeActor, implementation });
  const excludedReceipt = issueTopologyCriticReceipt({ gitCwd: root, context: excludedContext, critic: criticActor, implementation, approvals: [approval], verdict: 'pass' });
  assert.equal(verify(excludedReceipt, excludedContext, [approval]).ok, true, 'one-to-one independent exclusion passes');
  assert.throws(() => issueTopologyCriticReceipt({ gitCwd: root, context: excludedContext, critic: criticActor, implementation, approvals: [], verdict: 'pass' }), /one-to-one/);
  assert.throws(() => issueTopologyCriticReceipt({ gitCwd: root, context: excludedContext, critic: criticActor, implementation, approvals: [approval, approval], verdict: 'pass' }), /one-to-one/);
  assert.equal(verify(excludedReceipt, excludedContext, []).ok, false, 'missing approval fails persisted verification');
  const forgedApproval = structuredClone(approval); forgedApproval.scopeRef = 'scope:forged';
  assert.equal(verify(excludedReceipt, excludedContext, [forgedApproval]).ok, false, 'forged approval fails');
  assert.equal(verify(excludedReceipt, excludedContext, [approval]).ok, true, 'exact restoration passes without residue');

  const sourceRoot = resolve(packageRoot, '..');
  const repositoryRoot = resolve(sourceRoot, '..', '..');
  const handlerSource = readFileSync(join(sourceRoot, 'src/handlers/proofstory.ts'), 'utf8');
  const catalogSource = readFileSync(join(sourceRoot, 'src/cli/command-catalog.ts'), 'utf8');
  for (const forbidden of ['pre_review_check', 'evaluatePlannedToActual', 'selective_applicability_check', 'rollout_telemetry']) {
    assert.equal(handlerSource.includes(forbidden) || catalogSource.includes(forbidden), false, `Wave 2A must not leak ${forbidden}`);
  }
  for (const mutation of ['drop-topology-critic-prompt', 'drop-topology-critic-handler', 'drop-topology-critic-verifier', 'weaken-topology-critic-incomplete-basis']) {
    assert.throws(() => execFileSync(process.execPath, [join(repositoryRoot, 'scripts/verify-process-fact-contract.mjs')], {
      cwd: repositoryRoot,
      env: { ...process.env, LATTICE_PROCESS_FACT_CONTRACT_MUTATION: mutation },
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }), `process-fact mutation ${mutation} must bite`);
  }
  assert.ok(existsSync(join(sourceRoot, 'src/core/topology-critic-receipt.ts')));
  console.log('ProofStory topology critic smoke: PASS');
  console.log('  production handler producer + read-only verifier: PASS');
  console.log('  all receipt fields, freshness, role spoof/replay, 4D independence: PASS');
  console.log('  exclusion one-to-one + partial/unsupported + restoration: PASS');
  console.log('  prompt/handler/verifier/incomplete-basis process-fact mutations: PASS');
  console.log('  Wave 3/3A/4 leakage: absent');
} finally {
  resetConfigCache();
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}
