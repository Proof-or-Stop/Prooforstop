#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceMatrixReport } from '../core/acceptance-topology.js';
import { resetConfigCache } from '../core/config.js';
import { canSendStoryEventWithoutSnapshotCan } from '../core/machine.js';
import { StoryStore } from '../core/store.js';
import type {
  AcceptanceVerificationTopologyV1,
  ChecklistData,
  ProofStoryContractData,
  StoryInfo,
  VerificationIntent,
} from '../core/types.js';
import { verificationIntentSchema } from '../cli/command-schemas.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const storyId = 'B-topology-smoke';
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
      env: { ...process.env, LATTICE_SESSION_ID: 'acceptance-topology-smoke', LATTICE_AGENT: 'main-agent' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const output = `${String(error.stdout || '')}${String(error.stderr || '')}${String(error.message || '')}`;
    if (allowFailure) return output;
    throw new Error(output);
  }
}

function treeDigest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files.push(abs);
    }
  };
  walk(root);
  const hash = createHash('sha256');
  files.forEach(file => hash.update(file.slice(root.length)).update('\0').update(readFileSync(file)).update('\0'));
  return hash.digest('hex');
}

function story(phase: StoryInfo['phase'] = 'PLAN'): StoryInfo {
  return {
    storyId,
    name: 'topology-smoke',
    title: 'Acceptance topology smoke',
    description: 'Exercise observe-only acceptance topology diagnostics.',
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  };
}

const declaration = {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1' as const,
  id: 'VPP-1',
  relation: 'producer_to_consumer' as const,
  producer: {
    id: 'ENDPOINT-PRODUCER', role: 'producer' as const, expectedArtifactKind: 'handler' as const,
    expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produce', fileDeclarationRef: 'CHK-001:files:create:0',
  },
  consumers: [{
    id: 'ENDPOINT-CONSUMER', role: 'consumer' as const, expectedArtifactKind: 'process_fact' as const,
    expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'consume', fileDeclarationRef: 'CHK-001:files:create:1',
  }],
  outputFactRef: 'planned-fact:one',
};

const intent: VerificationIntent = {
  happy: [{ id: 'INT-001', desc: 'producer reaches consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [declaration] }],
  edge: [],
  adversarial: [],
};

const topology: AcceptanceVerificationTopologyV1 = {
  schemaVersion: 'proofstory.acceptance_topology.v1',
  producerRefs: [{ id: 'P-1', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-001:VPP-1', endpointRef: 'ENDPOINT-PRODUCER' } }],
  consumerRefs: [{ id: 'C-1', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-001:VPP-1', endpointRef: 'ENDPOINT-CONSUMER' }, producerRefs: ['P-1'] }],
  positiveAssertionRefs: [{ id: 'A-1', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-001' }, producerRefs: ['P-1'], consumerRefs: ['C-1'] }],
  mutationCaseRefs: [{ id: 'M-1', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-001' }, producerRefs: ['P-1'], consumerRefs: ['C-1'] }],
  transcriptAssertionRefs: [{ id: 'T-1', sourceRef: { refKind: 'existing', canonicalSourceRef: 'acceptance-binding:AC-1' }, producerRefs: ['P-1'], consumerRefs: ['C-1'] }],
  commandRefs: [{ refKind: 'existing', canonicalSourceRef: 'intent:INT-001' }],
};

function checklist(withDeclaration = true): ChecklistData {
  return { items: [{
    id: 'CHK-001',
    title: 'Implement topology',
    files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
    verificationIntent: withDeclaration ? intent : { happy: [{ id: 'INT-001', desc: 'producer reaches consumer', type: 'cli', priority: 'must' }], edge: [], adversarial: [] },
    verificationEvidence: [{ intentRef: 'INT-001', kind: 'integration_test', result: 'pass', note: 'synthetic canonical evidence' }],
    status: 'pending', startTime: null, endTime: null,
  }] };
}

function contract(bindings: ProofStoryContractData['acceptanceBindings']): ProofStoryContractData {
  return {
    schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: bindings, diagnosticGaps: [], createdAt: now, updatedAt: now,
  };
}

const schemaRoundTrip = verificationIntentSchema.parse(intent);
assert.deepEqual(schemaRoundTrip, intent, 'valid planned declaration round-trips without changing stable IDs or semantics');
assert.equal(verificationIntentSchema.parse({ happy: [{ id: 'LEGACY', desc: 'legacy', type: 'logic' }], edge: [], adversarial: [] }).happy[0].plannedPathDeclarations, undefined, 'legacy intent remains optional');
assert.throws(() => verificationIntentSchema.parse({ happy: [{ id: 'BAD', desc: 'bad', type: 'logic', plannedPathDeclarations: [{ ...declaration, schemaVersion: 'v2' }] }], edge: [], adversarial: [] }), /schemaVersion/);
assert.throws(() => verificationIntentSchema.parse({ happy: [{ id: 'BAD', desc: 'bad', type: 'logic', plannedPathDeclarations: [{ ...declaration, consumers: [{ ...declaration.consumers[0], id: declaration.producer.id }] }] }], edge: [], adversarial: [] }), /duplicate planned endpoint id/);

const handlerRoot = mkdtempSync(join(tmpdir(), 'lattice-topology-handler-'));
try {
  write(handlerRoot, 'lattice.config.json', JSON.stringify({ storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements' }));
  const store = new StoryStore(handlerRoot);
  store.writeStory(storyId, story());
  store.writeChecklist(storyId, checklist(false));
  const context = { root: handlerRoot, store, scanRoot: join(handlerRoot, 'packages/main') };
  const checklistHandlers = createChecklistHandlers(context);
  const createHandlers = createStoryCreateHandlers(context);
  const bytes = () => JSON.stringify(store.readChecklist(storyId));
  const beforeOrdinary = bytes();
  assert.throws(() => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: intent }), /planned_path_writer_not_authorized/);
  assert.equal(bytes(), beforeOrdinary, 'ordinary checklist_update rejection is atomic');
  assert.throws(() => checklistHandlers.checklist_add({ storyId, title: 'No bypass', reason: 'Reject alternate writer surface', verificationIntent: intent }), /planned_path_writer_not_authorized/);
  assert.equal(bytes(), beforeOrdinary, 'checklist_add rejection is atomic');
  assert.throws(() => createHandlers.story_create({
    name: 'no-create-bypass', title: 'No create bypass', description: 'Reject declaration during INIT creation.', type: 'feature', priority: 'medium',
    checklist: [{ title: 'No bypass', verificationIntent: intent }],
  }), /planned_path_writer_not_authorized/);
  assert.equal(store.listStoryIds().filter(id => id !== storyId).length, 0, 'story_create rejection precedes partial Story persistence');

  const savedAgent = process.env.LATTICE_AGENT;
  process.env.LATTICE_AGENT = 'verification-intent';
  try {
    const beforeInvalidRef = bytes();
    const mismatchIntent = {
      ...intent,
      happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, expectedFileRef: 'packages/main/src/not-declared.ts' } }] }],
    };
    assert.throws(() => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: mismatchIntent }), /planned_path_file_ref_mismatch/);
    assert.equal(bytes(), beforeInvalidRef, 'unresolved/mismatched file declaration rejection is atomic');
    checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: intent });
    assert.deepEqual(store.readChecklist(storyId).items[0].verificationIntent, intent, 'registered PLAN verification-intent flow persists declaration');
    const frozenBytes = bytes();
    store.writeStory(storyId, story('DEV'));
    assert.throws(() => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: { ...intent, edge: [{ id: 'LATE', desc: 'late', type: 'logic' }] } }), /cannot be modified during the DEV phase/);
    assert.equal(bytes(), frozenBytes, 'post-PLAN mutation leaves frozen declaration bytes unchanged');
  } finally {
    if (savedAgent === undefined) delete process.env.LATTICE_AGENT;
    else process.env.LATTICE_AGENT = savedAgent;
  }
} finally {
  rmSync(handlerRoot, { recursive: true, force: true });
}

const enabledReport = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: topology }]), ledger: null });
assert.equal(enabledReport.result, 'inconclusive_basis_unverified', 'a coherent Wave 1 graph never promotes itself to complete/pass/ready');
assert.deepEqual(enabledReport.diagnostics, [], 'valid reference-only graph has no intrinsic structural warning');
assert.deepEqual(enabledReport.rows[0].plannedPathDeclarationRefs, ['INT-001:VPP-1']);
assert.deepEqual(enabledReport.rows[0].endpointRefs, ['ENDPOINT-CONSUMER', 'ENDPOINT-PRODUCER']);
const permutedTopology: AcceptanceVerificationTopologyV1 = {
  ...topology,
  producerRefs: [...topology.producerRefs].reverse(),
  consumerRefs: [...topology.consumerRefs].reverse(),
  positiveAssertionRefs: [...topology.positiveAssertionRefs].reverse(),
  mutationCaseRefs: [...topology.mutationCaseRefs].reverse(),
  transcriptAssertionRefs: [...topology.transcriptAssertionRefs].reverse(),
  commandRefs: [...topology.commandRefs].reverse(),
};
assert.equal(
  JSON.stringify(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: permutedTopology }]), ledger: null })),
  JSON.stringify(enabledReport),
  'source insertion permutations normalize to byte-equivalent matrix output',
);

const missingDeclaration = buildAcceptanceMatrixReport({ storyId, checklist: checklist(false), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: topology }]), ledger: null });
assert.ok(missingDeclaration.rows[0].diagnosticCodes.includes('AT_PLANNED_PATH_DECLARATION_MISSING'), 'deleting canonical declaration bites');
const duplicateTopology = { ...topology, consumerRefs: [{ ...topology.consumerRefs[0], id: 'P-1' }] };
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: duplicateTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_DUPLICATE_ID'), 'duplicate topology ID bites');
const orphanTopology = { ...topology, consumerRefs: [] };
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: orphanTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_ORPHAN_PRODUCER'), 'orphan producer bites');
const inlineTopology = { ...topology, relation: 'invented', result: 'pass', coverageBasisRef: 'self-authored' } as any;
const inlineCodes = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: inlineTopology }]), ledger: null }).rows[0].diagnosticCodes;
assert.ok(inlineCodes.includes('AT_PLANNED_PATH_DECLARATION_DRIFT') && inlineCodes.includes('AT_INLINE_RESULT_FORBIDDEN') && inlineCodes.includes('AT_AUTHORITY_PROMOTION_FORBIDDEN'), 'inline semantics/result/authority mutations bite');
const unsupported = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: { ...topology, schemaVersion: 'proofstory.acceptance_topology.v2' } as any }]), ledger: null });
assert.ok(unsupported.rows[0].diagnosticCodes.includes('AT_UNSUPPORTED_VERSION'), 'unsupported topology versions remain readable as warnings');
const docsChecklist = checklist(false);
docsChecklist.items[0].verificationIntent = { happy: [{ id: 'INT-001', desc: 'documentation source boundary', type: 'docs', priority: 'must' }], edge: [], adversarial: [] };
const docsTopology = { ...topology, producerRefs: [{ id: 'P-1', sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'checklist:CHK-001' } }], consumerRefs: [{ id: 'C-1', sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'intent:INT-001' }, producerRefs: ['P-1'] }], mutationCaseRefs: [], transcriptAssertionRefs: [], commandRefs: [] };
assert.equal(buildAcceptanceMatrixReport({ storyId, checklist: docsChecklist, contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: docsTopology }]), ledger: null }).result, 'inconclusive_basis_unverified', 'docs-only topology requires no fabricated runtime mutation/transcript');

const cliRoot = mkdtempSync(join(tmpdir(), 'lattice-topology-cli-'));
try {
  git(cliRoot, ['init', '-b', 'main']);
  git(cliRoot, ['config', 'user.email', 'topology@example.test']);
  git(cliRoot, ['config', 'user.name', 'Topology Smoke']);
  write(cliRoot, 'lattice.config.json', JSON.stringify({ storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
  write(cliRoot, 'README.md', 'acceptance topology smoke\n');
  resetConfigCache();
  const store = new StoryStore(cliRoot);
  store.writeStory(storyId, story());
  store.writeChecklist(storyId, checklist());
  store.writeProofStoryContract(storyId, contract([
    { id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: topology },
    { id: 'AC-LEGACY', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [] },
  ]));
  git(cliRoot, ['add', '.']);
  git(cliRoot, ['commit', '-m', 'seed topology story']);

  const phaseBefore = store.readStory(storyId).phase;
  const transitionBefore = canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', cliRoot);
  const digestBefore = treeDigest(cliRoot);
  const statusBefore = git(cliRoot, ['status', '--porcelain']);
  const eventsBefore = JSON.stringify(store.readProcessEvents(storyId));
  const jsonOne = run(cliRoot, 'acceptance_matrix', { storyId, json: true });
  const jsonTwo = run(cliRoot, 'acceptance_matrix', { storyId, json: true });
  const text = run(cliRoot, 'acceptance_matrix', { storyId });
  assert.equal(jsonOne, jsonTwo, 'unchanged CLI JSON reads are byte-equivalent');
  const parsed = JSON.parse(jsonOne);
  assert.deepEqual(parsed.rows.map((row: any) => row.acceptanceBindingRef), ['acceptance-binding:AC-1', 'acceptance-binding:AC-LEGACY']);
  assert.match(text, /Mode: observe \(read-only, non-evidentiary\)/);
  assert.match(text, /Result: inconclusive_basis_unverified/);
  assert.match(text, /result=legacy_missing/);
  assert.equal(treeDigest(cliRoot), digestBefore, 'text and JSON commands leave all non-git bytes unchanged');
  assert.equal(git(cliRoot, ['status', '--porcelain']), statusBefore, 'CLI reads leave git status unchanged');
  assert.equal(JSON.stringify(store.readProcessEvents(storyId)), eventsBefore, 'CLI reads append no process event');
  assert.equal(store.readStory(storyId).phase, phaseBefore, 'CLI reads do not change lifecycle phase');
  assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', cliRoot), transitionBefore, 'topology diagnostics do not alter lifecycle decision');
  assert.match(run(cliRoot, 'acceptance_matrix', { storyId, verdict: 'pass' }, true), /Argument validation failed|verdict/);
  assert.equal(treeDigest(cliRoot), digestBefore, 'write-shaped request rejection leaves bytes unchanged');
  assert.equal(JSON.stringify(store.readProcessEvents(storyId)), eventsBefore, 'write-shaped request produces no event/evidence');
  const malformedContract = contract([
    { id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: { ...topology, consumerRefs: [] } },
    { id: 'AC-LEGACY', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [] },
  ]);
  store.writeProofStoryContract(storyId, malformedContract);
  assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', cliRoot), transitionBefore, 'malformed topology changes diagnostics only, not lifecycle guards');
  assert.equal(JSON.stringify(store.readProcessEvents(storyId)), eventsBefore, 'malformed topology itself creates no process or gate event');
  assert.equal(JSON.parse(run(cliRoot, 'acceptance_matrix', { storyId, json: true })).result, 'warning', 'malformed topology is an observe-only warning');
} finally {
  rmSync(cliRoot, { recursive: true, force: true });
}

console.log('ProofStory acceptance topology Wave 1 smoke passed');
