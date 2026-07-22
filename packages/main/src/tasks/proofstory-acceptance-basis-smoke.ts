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
  reconcileTopologyWithCoverageBasis,
  verifyAcceptanceCoverageBasis,
} from '../core/acceptance-coverage-basis.js';
import {
  reconcileAcceptanceDiscoveryResults,
  deriveRegisteredProcessFactClosure,
  runAcceptanceDiscoveryAdapters,
} from '../core/acceptance-discovery-adapters.js';
import { verifyAcceptanceBasisReceipt } from '../core/acceptance-basis-receipt.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type {
  AcceptanceBasisArtifactV1,
  AcceptanceVerificationTopologyV1,
  ChecklistData,
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
  commandRefs: [{ refKind: 'existing', canonicalSourceRef: 'intent:INT-BASIS' }],
};

function checklist(): ChecklistData {
  return { items: [{
    id: 'CHK-001', title: 'basis', context: 'smoke', status: 'pending', startTime: null, endTime: null,
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: {
      happy: [{ id: 'INT-BASIS', desc: 'basis producer reaches consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [declaration] }],
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
    storyId, mode: 'local', allowedModify: [], allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [],
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

const adapterControl = runAcceptanceDiscoveryAdapters({ supported: true, pathRefs: ['C2', 'C1'], scopeRefs: ['S1'] });
const globalClosure = deriveRegisteredProcessFactClosure(['process_fact:acceptance_basis_generate']);
assert.ok(globalClosure.pathRefs.some(path => path.includes('acceptance_basis_generate') && path.includes('consumer:Wave 2 acceptance_topology_check')), 'process-fact traversal retains registered consumers outside Story scope');
assert.ok(globalClosure.sourceInventoryRefs.some(ref => ref.startsWith('consumer:Wave 2 acceptance_topology_check')), 'global consumer enters closure inventory binding');
const adapterControlReconciled = reconcileAcceptanceDiscoveryResults(adapterControl);
assert.equal(adapterControlReconciled.status, 'complete');
assert.deepEqual(adapterControlReconciled.enumeratedPathRefs, ['C1', 'C2'], 'registered adapter union is canonical and non-lossy');
const omitted = reconcileAcceptanceDiscoveryResults(adapterControl.slice(1));
assert.ok(omitted.diagnostics.some(item => item.code === 'AT_REQUIRED_ADAPTER_RESULT_MISSING'), 'required adapter omission bites');
const duplicated = reconcileAcceptanceDiscoveryResults([...adapterControl, adapterControl[0]]);
assert.ok(duplicated.diagnostics.some(item => item.code === 'AT_REQUIRED_ADAPTER_RESULT_MISSING'), 'required adapter duplication bites');
const resultTamper = structuredClone(adapterControl);
resultTamper[1].pathRefs.push('C3');
assert.ok(reconcileAcceptanceDiscoveryResults(resultTamper).diagnostics.some(item => item.code === 'AT_ADAPTER_RESULT_DIGEST_MISMATCH'), 'adapter path mutation without digest bites');
const disagreement = structuredClone(adapterControl);
disagreement.find(item => item.method === 'handler_dispatch_inventory')!.pathRefs = ['C1'];
assert.ok(reconcileAcceptanceDiscoveryResults(disagreement).diagnostics.some(item => item.code === 'AT_DISCOVERY_DISAGREEMENT'), 'unexplained registry/dispatch disagreement bites');
const staticRuntimeAsymmetry = reconcileAcceptanceDiscoveryResults(adapterControl);
assert.ok(!staticRuntimeAsymmetry.diagnostics.some(item => item.code === 'AT_DISCOVERY_DISAGREEMENT'), 'typed bounded runtime asymmetry retains static C2');
const unsupported = reconcileAcceptanceDiscoveryResults(runAcceptanceDiscoveryAdapters({ supported: false, pathRefs: ['C1'], scopeRefs: ['S1'] }));
assert.equal(unsupported.status, 'unsupported', 'unsupported profile never becomes complete');

const pureRoot = mkdtempSync(join(tmpdir(), 'proofstory-basis-pure-'));
try {
  write(pureRoot, 'tsconfig.json', '{}\n');
  const input = {
    storyId, workspaceRoot: pureRoot, checklist: checklist(), contract: contract(), scopeCheck: scopeCheck(pureRoot), scopeContract: scopeContract(),
    headHash: 'head', materialHash: 'material', storyFilesHash: 'story', supported: true,
  };
  const first = deriveAcceptanceCoverageBasis(input);
  const second = deriveAcceptanceCoverageBasis({ ...input, checklist: { items: [...input.checklist.items] } });
  assert.equal(first.basis.basisDigest, second.basis.basisDigest, 'unchanged canonical inputs replay to the same basis digest');
  assert.equal(first.basis.status, 'complete');
  const firstVerification = verifyAcceptanceCoverageBasis(first.basis);
  assert.equal(firstVerification.ok, true, JSON.stringify(firstVerification.diagnostics));
  const aggregateTamper = structuredClone(first.basis);
  aggregateTamper.enumeratedPathRefs = aggregateTamper.enumeratedPathRefs.filter(path => !path.includes('VPP-BASIS'));
  assert.ok(!verifyAcceptanceCoverageBasis(aggregateTamper).ok, 'aggregate omission bites without trusting the aggregate');
  const optimistic = structuredClone(first.basis);
  optimistic.adapterResults[0].coverageClaim = 'partial';
  optimistic.status = 'complete';
  assert.ok(!verifyAcceptanceCoverageBasis(optimistic).ok, 'partial-to-complete optimism mutation bites');
  const missingDeclarationChecklist = checklist();
  missingDeclarationChecklist.items[0].verificationIntent!.happy[0].plannedPathDeclarations = [];
  assert.ok(reconcileTopologyWithCoverageBasis(contract(), deriveAcceptanceCoverageBasis({ ...input, checklist: missingDeclarationChecklist }).basis)
    .some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS' || item.code === 'AT_UNMAPPED_SCOPE_REF' || item.code === 'AT_PLANNED_PATH_OUTSIDE_BASIS'), 'deleting planned declaration cannot leave topology falsely complete');
  const inventedTopology = structuredClone(topology);
  inventedTopology.consumerRefs[0].sourceRef = { refKind: 'existing', canonicalSourceRef: 'invented:C2' };
  assert.ok(reconcileTopologyWithCoverageBasis(contract(inventedTopology), first.basis).some(item => item.code === 'AT_TOPOLOGY_OUTSIDE_BASIS'), 'invented topology path outside basis bites');
  const exclusionTamper = structuredClone(first.basis);
  exclusionTamper.excludedPathRefs = [{ pathRef: 'C2', decisionRef: 'self approved prose' }];
  assert.ok(reconcileTopologyWithCoverageBasis(contract(), exclusionTamper).some(item => item.code === 'AT_UNJUSTIFIED_EXCLUSION'), 'non-auditable exclusion prose bites');
  const invalidFiles = checklist();
  invalidFiles.items[0].files = { ...invalidFiles.items[0].files!, create: ['packages/main/src/other.ts', 'packages/main/src/consumer.ts'] };
  assert.ok(derivePlannedCoveragePaths(invalidFiles, contract(), scopeContract()).diagnostics.some(item => item.code === 'AT_PLANNED_PATH_INVALID'), 'planned endpoint must resolve frozen checklist file');
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
  resetConfigCache();
  const store = new StoryStore(root);
  const story: StoryInfo = { storyId, name: 'basis-smoke', title: 'Basis smoke', description: 'real CLI basis smoke', type: 'feature', phase: 'PLAN', priority: 'high', createdAt: now, startedAt: now, endedAt: null, events: [] };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract());
  store.writeScopeContract(storyId, scopeContract());
  store.writeScopeCheck(storyId, scopeCheck(root));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed real basis repo']);

  const generated = run(root, 'acceptance_basis_generate', { storyId, json: true });
  assert.match(generated, /proofstory\.acceptance_basis_artifact\.v1/);
  const artifact = store.readAcceptanceBasis(storyId)!;
  assert.equal(artifact.basis.status, 'complete');
  const control = verifyAcceptanceBasisReceipt({ artifact, gitCwd: root, metadataRoot: root, expectedStoryId: storyId });
  assert.equal(control.ok, true, control.diagnostics.join('; '));

  const snapshot = {
    story: bytes(root, `.lattice/story/actives/${storyId}/index.json`),
    artifact: bytes(root, `.lattice/story/actives/${storyId}/acceptance-basis.json`),
    events: bytes(root, `.lattice/story/actives/${storyId}/process-events.jsonl`),
    status: git(root, ['status', '--porcelain']),
  };
  const readOne = run(root, 'acceptance_basis', { storyId, json: true });
  const readTwo = run(root, 'acceptance_basis', { storyId, json: true });
  assert.equal(readOne, readTwo, 'unchanged diagnostic JSON is byte-equivalent');
  assert.match(readOne, /"receiptVerification"/);
  assert.deepEqual({
    story: bytes(root, `.lattice/story/actives/${storyId}/index.json`),
    artifact: bytes(root, `.lattice/story/actives/${storyId}/acceptance-basis.json`),
    events: bytes(root, `.lattice/story/actives/${storyId}/process-events.jsonl`),
    status: git(root, ['status', '--porcelain']),
  }, snapshot, 'read-only text/JSON diagnostics mutate no story, receipt, process event, phase, or git state');

  const forged = run(root, 'acceptance_basis', { storyId, status: 'complete', enumeratedPathRefs: ['forged'], issuer: 'implementer' }, true);
  assert.match(forged, /Forbidden|never|invalid|expected/i, 'write-shaped reader payload is rejected by command schema');
  assert.equal(bytes(root, `.lattice/story/actives/${storyId}/acceptance-basis.json`), snapshot.artifact, 'forgery rejection is atomic');

  const mutations: Array<[string, (value: AcceptanceBasisArtifactV1) => void]> = [
    ['signature', value => { value.receipt.signature = Buffer.alloc(64).toString('base64'); }],
    ['basis digest', value => { value.receipt.basisDigest = `sha256:${'0'.repeat(64)}`; }],
    ['story', value => { value.receipt.storyId = 'B-other'; }],
    ['workspace', value => { value.receipt.workspaceIdentityDigest = `sha256:${'1'.repeat(64)}`; }],
    ['scope', value => { value.receipt.scopeCheckDigest = `sha256:${'2'.repeat(64)}`; }],
    ['closure', value => { value.receipt.closureFilesHash = `sha256:${'3'.repeat(64)}`; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(artifact);
    mutate(changed);
    assert.equal(verifyAcceptanceBasisReceipt({ artifact: changed, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, false, `${label} tamper bites`);
    assert.equal(verifyAcceptanceBasisReceipt({ artifact, gitCwd: root, metadataRoot: root, expectedStoryId: storyId }).ok, true, `${label} restored control passes`);
  }

  write(root, 'packages/main/src/consumer.ts', 'export const verifyBasis = () => false;\n');
  git(root, ['add', 'packages/main/src/consumer.ts']);
  git(root, ['commit', '-m', 'mutate closure source']);
  const stale = run(root, 'acceptance_basis', { storyId, json: true });
  assert.match(stale, /AT_COVERAGE_BASIS_STALE|AT_ADAPTER_RESULT_DIGEST_MISMATCH|closure files hash mismatch/, 'stale closure or workspace binding fails closed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('ProofStory acceptance coverage basis Wave 1A smoke passed');
