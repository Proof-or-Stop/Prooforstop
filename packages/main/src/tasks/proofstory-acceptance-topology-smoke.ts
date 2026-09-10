#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptanceMatrixEvidenceProvenance,
  buildAcceptanceMatrixReport,
  isAcceptanceMatrixDerivedEvidence,
  plannedPathDeclarationSnapshot,
} from '../core/acceptance-topology.js';
import { resetConfigCache } from '../core/config.js';
import { canSendStoryEventWithoutSnapshotCan } from '../core/machine.js';
import { buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport } from '../core/milestone-status.js';
import { evaluateReviewCompleteness } from '../core/proofstory.js';
import { StoryStore } from '../core/store.js';
import { buildVerificationCoverage } from '../core/verification.js';
import type {
  AcceptanceVerificationTopologyV1,
  ChecklistData,
  MilestoneLedgerData,
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

function run(
  root: string,
  command: string,
  args: Record<string, unknown>,
  allowFailure = false,
  agent = 'main-agent',
): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'acceptance-topology-smoke', PROOF_OR_STOP_AGENT: agent },
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

const lifecycleFixtureFiles = [
  'packages/main/src/core/machine.ts',
  'packages/main/src/handlers/phase-gates.ts',
] as const;

function lifecycleFixtureDigest(root: string): string {
  const hash = createHash('sha256');
  for (const file of lifecycleFixtureFiles) {
    hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
  }
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
assert.deepEqual(
  acceptanceMatrixEvidenceProvenance({ kind: 'logic_test', command: `node bin/proof-or-stop.js acceptance_matrix --storyId=${storyId}`, note: 'ordinary transcript' }),
  { kind: 'producer_command', producerCommand: 'acceptance_matrix' },
  'exact producer command token derives structured non-evidentiary provenance',
);
for (const command of [
  `proof-or-stop acceptance_matrix --storyId=${storyId}`,
  `/usr/local/bin/proof-or-stop --root /tmp/proof-or-stop acceptance_matrix --storyId=${storyId}`,
  `node bin/proof-or-stop.js acceptance_matrix --storyId=${storyId}`,
  `/usr/bin/node ./bin/proof-or-stop.js --root=/tmp/proof-or-stop acceptance_matrix --json`,
  `node /Users/example/proof-or-stop/bin/proof-or-stop.js --root /tmp/proof-or-stop acceptance_matrix`,
  `./bin/proof-or-stop.js acceptance_matrix --storyId=${storyId}`,
]) {
  assert.equal(isAcceptanceMatrixDerivedEvidence({ kind: 'logic_test', command, note: 'ordinary transcript' }), true, `canonical Proof-or-Stop invocation is derived: ${command}`);
}
for (const command of [
  'rg acceptance_matrix packages/main/src/core/command-policy.ts',
  'printf acceptance_matrix',
  'node cli-contract-test.mjs acceptance_matrix',
  'echo proof-or-stop acceptance_matrix',
  'proof-or-stop check acceptance_matrix',
  'node bin/proof-or-stop.js help acceptance_matrix',
]) {
  assert.equal(isAcceptanceMatrixDerivedEvidence({ kind: 'logic_test', command, note: 'independent assertion passed' }), false, `data/argument token is not producer provenance: ${command}`);
}
assert.equal(isAcceptanceMatrixDerivedEvidence({ kind: 'manual_transcript', note: 'Observed matrix projection was inconclusive_basis_unverified.' }), true, 'paraphrasing around a reserved manual matrix result cannot bypass legacy classification');
assert.equal(isAcceptanceMatrixDerivedEvidence({ kind: 'manual_transcript', note: 'Result: warning' }), true, 'exact legacy manual warning output line remains compatible');
assert.equal(isAcceptanceMatrixDerivedEvidence({ kind: 'manual_transcript', note: 'Result: warning threshold test passed with expected fallback.' }), false, 'unrelated warning prose is not a matrix projection false positive');
assert.equal(isAcceptanceMatrixDerivedEvidence({ kind: 'logic_test', note: 'Valid graph remains inconclusive_basis_unverified by design.' }), false, 'logic-test notes may discuss the reserved result without becoming projection evidence');
assert.equal(isAcceptanceMatrixDerivedEvidence({ kind: 'integration_test', note: 'CLI stays inconclusive_basis_unverified by design.' }), false, 'integration-test notes may discuss the reserved result without becoming projection evidence');
const schemaInvalidCases: Array<[string, unknown]> = [
  ['unknown schema version', { ...declaration, schemaVersion: 'v2' }],
  ['empty declaration id', { ...declaration, id: '' }],
  ['invalid relation', { ...declaration, relation: 'consumer_to_producer' }],
  ['zero consumers', { ...declaration, consumers: [] }],
  ['empty producer id', { ...declaration, producer: { ...declaration.producer, id: '' } }],
  ['producer role swap', { ...declaration, producer: { ...declaration.producer, role: 'consumer' } }],
  ['consumer role swap', { ...declaration, consumers: [{ ...declaration.consumers[0], role: 'producer' }] }],
  ['unsupported artifact kind', { ...declaration, producer: { ...declaration.producer, expectedArtifactKind: 'database' } }],
  ['malformed file declaration ref', { ...declaration, producer: { ...declaration.producer, fileDeclarationRef: 'CHK-001:create:0' } }],
  ['duplicate endpoint id', { ...declaration, consumers: [{ ...declaration.consumers[0], id: declaration.producer.id }] }],
  ['empty expected symbol', { ...declaration, producer: { ...declaration.producer, expectedSymbolOrFact: '' } }],
  ['empty output fact', { ...declaration, outputFactRef: '' }],
];
for (const [label, candidate] of schemaInvalidCases) {
  assert.throws(
    () => verificationIntentSchema.parse({ happy: [{ id: 'BAD', desc: 'bad', type: 'logic', plannedPathDeclarations: [candidate] }], edge: [], adversarial: [] }),
    Error,
    `${label} must fail the shared CLI schema`,
  );
}
assert.throws(
  () => verificationIntentSchema.parse({ happy: [{ id: 'BAD', desc: 'bad', type: 'logic', plannedPathDeclarations: [declaration, { ...declaration }] }], edge: [], adversarial: [] }),
  /duplicate planned path declaration id/,
  'duplicate declaration IDs fail the shared schema',
);
for (const [label, changed] of [
  ['symbol', { ...declaration, producer: { ...declaration.producer, expectedSymbolOrFact: 'produceChanged' } }],
  ['output fact', { ...declaration, outputFactRef: 'planned-fact:changed' }],
] as const) {
  const changedIntent = { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [changed] }] } as VerificationIntent;
  assert.notEqual(plannedPathDeclarationSnapshot(changedIntent), plannedPathDeclarationSnapshot(intent), `${label} mutation with stable IDs changes canonical declaration semantics`);
}

const handlerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-topology-handler-'));
try {
  write(handlerRoot, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }));
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

  const savedAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = 'verification-intent';
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
    const persistedBytes = bytes();
    delete process.env.PROOF_OR_STOP_AGENT;
    assert.throws(
      () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: checklist(false).items[0].verificationIntent }),
      /planned_path_writer_not_authorized/,
      'ordinary PLAN replacement cannot erase an existing declaration',
    );
    assert.equal(bytes(), persistedBytes, 'unauthorized declaration removal is byte-atomic');
    assert.throws(
      () => checklistHandlers.checklist_update({
        storyId,
        itemId: 'CHK-001',
        files: { modify: [], create: ['packages/main/src/retargeted.ts', 'packages/main/src/consumer.ts'], test: [] },
      }),
      /planned_path_file_binding_frozen/,
      'ordinary PLAN files update cannot retarget a declaration binding',
    );
    assert.equal(bytes(), persistedBytes, 'unauthorized file retarget is byte-atomic');
    process.env.PROOF_OR_STOP_AGENT = 'verification-intent';
    const invalidFileCases: Array<[string, VerificationIntent, RegExp]> = [
      ['wrong item', { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, fileDeclarationRef: 'CHK-002:files:create:0' } }] }] }, /planned_path_file_ref_wrong_item/],
      ['unsafe path', { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, expectedFileRef: '../producer.ts' } }] }] }, /planned_path_file_ref_unsafe/],
      ['absolute path', { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, expectedFileRef: '/tmp/evil.ts' } }] }] }, /planned_path_file_ref_unsafe/],
      ['dot segment', { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, expectedFileRef: 'packages/./main/src/producer.ts' } }] }] }, /planned_path_file_ref_unsafe/],
      ['backslash path', { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, expectedFileRef: 'packages\\main\\src\\producer.ts' } }] }] }, /planned_path_file_ref_unsafe/],
      ['unresolved index', { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, fileDeclarationRef: 'CHK-001:files:create:99' } }] }] }, /planned_path_file_ref_unresolved/],
      ['mismatched target', { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, expectedFileRef: 'packages/main/src/not-declared.ts' } }] }] }, /planned_path_file_ref_mismatch/],
    ];
    for (const [label, invalidIntent, expected] of invalidFileCases) {
      assert.throws(() => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: invalidIntent }), expected, label);
      assert.equal(bytes(), persistedBytes, `${label} persistence failure is byte-atomic`);
    }
    const changedSymbolIntent = { ...intent, happy: [{ ...intent.happy[0], plannedPathDeclarations: [{ ...declaration, producer: { ...declaration.producer, expectedSymbolOrFact: 'produceChanged' } }] }] };
    checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: changedSymbolIntent });
    assert.notEqual(bytes(), persistedBytes, 'eligible stable-ID symbol mutation changes persisted canonical bytes');
    checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: intent });
    assert.equal(bytes(), persistedBytes, 'restored eligible control returns to original bytes');
    const frozenBytes = bytes();
    store.writeStory(storyId, story('DEV'));
    assert.throws(() => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', verificationIntent: { ...intent, edge: [{ id: 'LATE', desc: 'late', type: 'logic' }] } }), /cannot be modified during the DEV phase/);
    assert.equal(bytes(), frozenBytes, 'post-PLAN mutation leaves frozen declaration bytes unchanged');
  } finally {
    if (savedAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = savedAgent;
  }
} finally {
  rmSync(handlerRoot, { recursive: true, force: true });
}

const writerCliRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-topology-writer-cli-'));
try {
  git(writerCliRoot, ['init', '-b', 'main']);
  git(writerCliRoot, ['config', 'user.email', 'topology-writer@example.test']);
  git(writerCliRoot, ['config', 'user.name', 'Topology Writer Smoke']);
  write(writerCliRoot, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
  write(writerCliRoot, 'README.md', 'writer CLI smoke\n');
  resetConfigCache();
  const store = new StoryStore(writerCliRoot);
  store.writeStory(storyId, story());
  store.writeChecklist(storyId, checklist(false));
  git(writerCliRoot, ['add', '.']);
  git(writerCliRoot, ['commit', '-m', 'seed writer story']);

  run(writerCliRoot, 'checklist_update', { storyId, itemId: 'CHK-001', verificationIntent: intent }, false, 'verification-intent');
  assert.deepEqual(store.readChecklist(storyId).items[0].verificationIntent, intent, 'real CLI plus registered verification-intent identity persists a valid PLAN declaration');
  const checklistAfterEligible = JSON.stringify(store.readChecklist(storyId));
  const eventsAfterEligible = JSON.stringify(store.readProcessEvents(storyId));
  assert.match(
    run(writerCliRoot, 'checklist_update', { storyId, itemId: 'CHK-001', verificationIntent: checklist(false).items[0].verificationIntent }, true, 'main-agent'),
    /planned_path_writer_not_authorized/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), checklistAfterEligible, 'real CLI unauthorized removal leaves checklist bytes unchanged');
  assert.equal(JSON.stringify(store.readProcessEvents(storyId)), eventsAfterEligible, 'real CLI unauthorized removal appends no process event');
  assert.match(
    run(writerCliRoot, 'checklist_add', { storyId, title: 'No writer bypass', reason: 'Reject alternate writer route', verificationIntent: intent }, true, 'main-agent'),
    /planned_path_writer_not_authorized/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), checklistAfterEligible, 'real CLI checklist_add bypass is atomic');
  assert.match(
    run(writerCliRoot, 'story_create', {
      name: 'no-writer-bypass', title: 'No writer bypass', description: 'Reject INIT declaration persistence.', type: 'feature', priority: 'medium',
      checklist: [{ title: 'No bypass', verificationIntent: intent }],
    }, true, 'main-agent'),
    /planned_path_writer_not_authorized/,
  );
  assert.deepEqual(store.listStoryIds(), [storyId], 'real CLI story_create bypass writes no partial Story');
  store.writeStory(storyId, story('DEV'));
  assert.match(
    run(writerCliRoot, 'checklist_update', { storyId, itemId: 'CHK-001', verificationIntent: intent }, true, 'verification-intent'),
    /DEV phase|Allowed phases: PLAN/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), checklistAfterEligible, 'real CLI post-PLAN mutation leaves declaration bytes frozen');
  assert.equal(JSON.stringify(store.readProcessEvents(storyId)), eventsAfterEligible, 'real CLI post-PLAN rejection appends no event');
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{ intentRef: 'INT-001', kind: 'manual_transcript', command: 'node replay.mjs', result: 'pass', note: 'Observed matrix projection was inconclusive_basis_unverified.' }],
    }, true, 'main-agent'),
    /acceptance_matrix_non_evidentiary_projection/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), checklistAfterEligible, 'real CLI rejects matrix-derived evidence before persistence');
  assert.equal(JSON.stringify(store.readProcessEvents(storyId)), eventsAfterEligible, 'matrix-derived evidence rejection creates no process event');
  assert.match(
    run(writerCliRoot, 'verification_evidence_add', {
      storyId,
      itemId: 'CHK-001',
      intentRef: 'INT-001',
      kind: 'manual_transcript',
      command: 'node replay.mjs',
      result: 'pass',
      note: 'Observed matrix projection was inconclusive_basis_unverified.',
    }, true, 'main-agent'),
    /acceptance_matrix_non_evidentiary_projection/,
  );
  assert.match(
    run(writerCliRoot, 'verification_evidence_batch_add', {
      storyId,
      evidences: [{
        itemId: 'CHK-001',
        intentRef: 'INT-001',
        kind: 'manual_transcript',
        command: `proof-or-stop acceptance_matrix --storyId=${storyId}`,
        result: 'pass',
        note: 'Result: inconclusive_basis_unverified',
      }],
    }, true, 'main-agent'),
    /acceptance_matrix_non_evidentiary_projection/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), checklistAfterEligible, 'all real evidence writer surfaces reject matrix projections atomically');
  assert.equal(JSON.stringify(store.readProcessEvents(storyId)), eventsAfterEligible, 'alternate matrix evidence writers append no process event');
  // B-ec67 F-006: an executable (type:cli) intent's evidence write must be a mechanical
  // receipt (selector) or an audited non-mechanical attestation. These false-positive
  // controls are non-matrix and genuinely un-executable in this fixture, so they migrate
  // to the audited escape (nonMechanicalReason) — the write still succeeds and preserves
  // the note/command, which is all these assertions check.
  const nonMatrixEscape = 'non-matrix false-positive control; execution not applicable in this acceptance-topology fixture';
  assert.match(
    run(writerCliRoot, 'verification_evidence_add', {
      storyId,
      itemId: 'CHK-001',
      intentRef: 'INT-001',
      kind: 'integration_test',
      command: 'node warning-threshold.test.mjs',
      result: 'pass',
      note: 'Result: warning threshold test passed with expected fallback.',
      nonMechanicalReason: nonMatrixEscape,
    }, false, 'main-agent'),
    /Verification evidence recorded/,
  );
  assert.equal(store.readChecklist(storyId).items[0].verificationEvidence?.[0]?.note, 'Result: warning threshold test passed with expected fallback.', 'false-positive control persists ordinary evidence through the real CLI');
  // B-ec67 F-008: checklist_update may re-persist an already-audited non-mechanical
  // row. It strips caller-supplied provenance, then carries the trusted on-disk
  // mechanical:false/reason pair forward; changing the incoming row must not upgrade it.
  const audited = store.readChecklist(storyId).items[0].verificationEvidence![0];
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{ intentRef: audited.intentRef, kind: audited.kind, command: audited.command, result: audited.result, note: audited.note }],
    }, false, 'main-agent'),
    /verificationEvidence updated/,
    'an exact semantic re-persist retains the audited non-mechanical provenance',
  );
  assert.equal(store.readChecklist(storyId).items[0].verificationEvidence?.[0]?.nonMechanicalReason, nonMatrixEscape, 'exact re-persist carries the on-disk audit reason');
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{ intentRef: audited.intentRef, kind: audited.kind, command: 'node changed-command.test.mjs', result: audited.result, note: audited.note }],
    }, true, 'main-agent'),
    /checklist_update_executable_evidence_unenforced/,
    'changed command cannot inherit an old nonMechanicalReason',
  );
  run(writerCliRoot, 'checklist_update', {
    storyId,
    itemId: 'CHK-001',
    verificationEvidence: [{ intentRef: audited.intentRef, kind: audited.kind, command: audited.command, result: 'fail', note: audited.note }],
  }, false, 'main-agent');
  const changedResult = store.readChecklist(storyId).items[0].verificationEvidence![0];
  assert.equal(changedResult.result, 'fail', 'changed result remains an explicit failure');
  assert.equal(changedResult.mechanical, undefined, 'changed result does not inherit non-mechanical provenance');
  assert.equal(changedResult.nonMechanicalReason, undefined, 'changed result does not inherit the old audit reason');
  // B-ec67 F-007: checklist_update no longer accepts executable-intent evidence (it does
  // not execute pinned commands); a non-matrix row is now refused with the F-007 code
  // (NOT the matrix-projection code), directing callers to verification_evidence_add.
  const beforeUnenforcedExecutableEvidence = JSON.stringify(store.readChecklist(storyId));
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{ intentRef: 'INT-001', kind: 'logic_test', command: 'rg acceptance_matrix packages/main/src/core/command-policy.ts', result: 'pass', note: 'Registry source assertion passed.' }],
    }, true, 'main-agent'),
    /checklist_update_executable_evidence_unenforced/,
    'checklist_update must refuse a fresh executable evidence row instead of pretending to execute it',
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), beforeUnenforcedExecutableEvidence, 'refused executable evidence leaves the audited checklist row unchanged');

  const freshChecklist = store.readChecklist(storyId);
  freshChecklist.items.push({
    ...checklist(false).items[0],
    id: 'CHK-FRESH',
    title: 'Fresh executable evidence guard',
    verificationIntent: { happy: [{ id: 'INT-FRESH', desc: 'fresh executable evidence requires enforcement', type: 'logic', priority: 'must' }], edge: [], adversarial: [] },
    verificationEvidence: [],
  });
  store.writeChecklist(storyId, freshChecklist);
  const freshChecklistBeforeRefusal = JSON.stringify(store.readChecklist(storyId));
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-FRESH',
      verificationEvidence: [{ intentRef: 'INT-FRESH', kind: 'logic_test', command: 'rg acceptance_matrix packages/main/src/core/command-policy.ts', result: 'pass', note: 'Registry source assertion passed.' }],
    }, true, 'main-agent'),
    /checklist_update_executable_evidence_unenforced/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), freshChecklistBeforeRefusal, 'fresh executable evidence without trusted provenance remains refused atomically');
  assert.match(
    run(writerCliRoot, 'verification_evidence_add', {
      storyId,
      itemId: 'CHK-001',
      intentRef: 'INT-001',
      kind: 'logic_test',
      command: 'printf acceptance_matrix',
      result: 'pass',
      note: 'Literal-output assertion passed independently.',
      nonMechanicalReason: nonMatrixEscape,
    }, false, 'main-agent'),
    /Verification evidence recorded/,
  );
  assert.match(
    run(writerCliRoot, 'verification_evidence_batch_add', {
      storyId,
      evidences: [{
        itemId: 'CHK-001',
        intentRef: 'INT-001',
        kind: 'integration_test',
        command: 'node cli-contract-test.mjs acceptance_matrix',
        result: 'pass',
        note: 'CLI argument-contract assertion passed independently.',
        nonMechanicalReason: nonMatrixEscape,
      }],
    }, false, 'main-agent'),
    /Verification evidence batch recorded/,
  );
  assert.equal(store.readChecklist(storyId).items[0].verificationEvidence?.[0]?.command, 'node cli-contract-test.mjs acceptance_matrix', 'all three writer surfaces preserve a non-producer argument token');
  const sameEvidenceCommand = 'node cli-contract-test.mjs acceptance_matrix';
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{ intentRef: 'INT-001', kind: 'integration_test', command: sameEvidenceCommand, result: 'pass', note: 'same evidence with updated metadata' }],
    }, false, 'main-agent'),
    /verificationEvidence updated/,
  );
  const sameEvidence = store.readChecklist(storyId).items[0].verificationEvidence?.[0];
  assert.equal(sameEvidence?.mechanical, false, 'same command/result carries forward the audited non-mechanical provenance');
  assert.equal(sameEvidence?.nonMechanicalReason, nonMatrixEscape, 'same command/result carries forward the on-disk non-mechanical reason');
  assert.equal(sameEvidence?.note, 'same evidence with updated metadata', 'same-evidence re-persistence still updates ordinary metadata');
  const changedCommandBefore = JSON.stringify(store.readChecklist(storyId));
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{ intentRef: 'INT-001', kind: 'integration_test', command: 'node mutated-evidence.mjs', result: 'pass', note: 'changed command must not reuse attestation' }],
    }, true, 'main-agent'),
    /checklist_update_executable_evidence_unenforced/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), changedCommandBefore, 'changed command refusal is atomic');
  const changedResultBefore = JSON.stringify(store.readChecklist(storyId));
  assert.match(
    run(writerCliRoot, 'checklist_update', {
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{ intentRef: 'INT-001', kind: 'integration_test', command: sameEvidenceCommand, note: 'changed result must not reuse attestation' }],
    }, true, 'main-agent'),
    /checklist_update_executable_evidence_unenforced/,
  );
  assert.equal(JSON.stringify(store.readChecklist(storyId)), changedResultBefore, 'changed result refusal is atomic');
} finally {
  rmSync(writerCliRoot, { recursive: true, force: true });
}

const enabledReport = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: topology }]), ledger: null });
assert.equal(enabledReport.result, 'inconclusive_basis_unverified', 'a coherent Wave 1 graph never promotes itself to complete/pass/ready');
assert.deepEqual(enabledReport.diagnostics, [], 'valid reference-only graph has no intrinsic structural warning');
assert.deepEqual(enabledReport.rows[0].plannedPathDeclarationRefs, ['INT-001:VPP-1']);
assert.deepEqual(enabledReport.rows[0].endpointRefs, ['ENDPOINT-CONSUMER', 'ENDPOINT-PRODUCER']);
const staticBasisPathRefs = [
  'basis-path:path:static-call:packages/main/src/a.ts#produceA->consumer:packages/main/src/b.ts#consumeA',
  'basis-path:path:static-call:packages/main/src/c.ts#produceB->consumer:packages/main/src/d.ts#consumeB',
  'basis-path:path:static-call:packages/main/src/e.ts#produceC->consumer:packages/main/src/f.ts#consumeC',
  'basis-path:path:static-call:packages/main/src/g.ts#produceD->consumer:packages/main/src/h.ts#consumeD',
];
const basisPathStructuralTopology: AcceptanceVerificationTopologyV1 = {
  ...topology,
  commandRefs: [
    { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
    ...staticBasisPathRefs.map(canonicalSourceRef => ({ refKind: 'existing' as const, canonicalSourceRef })),
  ],
};
const basisPathStructuralReport = buildAcceptanceMatrixReport({
  storyId,
  checklist: checklist(),
  contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: basisPathStructuralTopology }]),
  ledger: null,
});
assert.ok(!basisPathStructuralReport.rows[0].diagnosticCodes.includes('AT_UNKNOWN_REF'), 'canonical process-fact object and four strict basis-path static edges pass structural reference validation');
for (const malformed of [
  'basis-path:static-call:a#produce->consumer:b#consume',
  'basis-path:path:not-an-edge',
  'basis-path:path:bogus:x->y',
  'basis-path:path:static-call:/tmp/evil.ts#produce->consumer:packages/main/src/consumer.ts#consume',
  'basis-path:path:static-call:packages/../evil.ts#produce->consumer:packages/main/src/consumer.ts#consume',
  'basis-path:path:static-call:packages/./main/src/producer.ts#produce->consumer:packages/main/src/consumer.ts#consume',
  'basis-path:path:static-call:packages\\main\\src\\producer.ts#produce->consumer:packages/main/src/consumer.ts#consume',
  'basis-path:path:process-fact:pre_review_check->consumer:../evil',
  'basis-path:path:static-call:a#produce->consumer:b#consume\nforged',
]) {
  const malformedTopology = { ...topology, commandRefs: [{ refKind: 'existing' as const, canonicalSourceRef: malformed }] };
  const malformedReport = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: malformedTopology }]), ledger: null });
  assert.ok(malformedReport.rows[0].diagnosticCodes.includes('AT_UNKNOWN_REF'), `malformed basis-path reference remains unknown: ${JSON.stringify(malformed)}`);
}
const unreconciledBasisPathTopology = {
  ...topology,
  positiveAssertionRefs: [{ ...topology.positiveAssertionRefs[0], sourceRef: { refKind: 'existing' as const, canonicalSourceRef: staticBasisPathRefs[0] } }],
};
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: unreconciledBasisPathTopology }]), ledger: null })
  .rows[0].diagnosticCodes.includes('AT_UNKNOWN_REF'), 'basis-path cannot bypass validation in assertion groups that basis reconciliation does not consume');
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
const swappedRoleTopology = {
  ...topology,
  producerRefs: [{ ...topology.producerRefs[0], sourceRef: { refKind: 'planned' as const, plannedPathDeclarationRef: 'INT-001:VPP-1', endpointRef: 'ENDPOINT-CONSUMER' } }],
  consumerRefs: [{ ...topology.consumerRefs[0], sourceRef: { refKind: 'planned' as const, plannedPathDeclarationRef: 'INT-001:VPP-1', endpointRef: 'ENDPOINT-PRODUCER' } }],
};
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: swappedRoleTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_PLANNED_PATH_DECLARATION_DRIFT'), 'swapped planned endpoint roles bite independently');
for (const [label, mutatedTopology, expectedCode] of [
  ['unknown declaration', { ...topology, producerRefs: [{ ...topology.producerRefs[0], sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-001:UNKNOWN', endpointRef: 'ENDPOINT-PRODUCER' } }] }, 'AT_PLANNED_PATH_DECLARATION_MISSING'],
  ['unknown endpoint', { ...topology, producerRefs: [{ ...topology.producerRefs[0], sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-001:VPP-1', endpointRef: 'ENDPOINT-UNKNOWN' } }] }, 'AT_PLANNED_PATH_DECLARATION_MISSING'],
  ['unknown canonical source', { ...topology, commandRefs: [{ refKind: 'existing', canonicalSourceRef: 'handler:not-a-bounded-owner' }] }, 'AT_UNKNOWN_REF'],
] as const) {
  const codes = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: mutatedTopology as any }]), ledger: null }).rows[0].diagnosticCodes;
  assert.ok(codes.includes(expectedCode), `${label} mutation emits ${expectedCode}`);
}
const duplicateTopology = { ...topology, consumerRefs: [{ ...topology.consumerRefs[0], id: 'P-1' }] };
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: duplicateTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_DUPLICATE_ID'), 'duplicate topology ID bites');
const orphanTopology = { ...topology, consumerRefs: [] };
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: orphanTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_ORPHAN_PRODUCER'), 'orphan producer bites');
const orphanConsumerTopology = { ...topology, consumerRefs: [{ ...topology.consumerRefs[0], producerRefs: [] }] };
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: orphanConsumerTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_ORPHAN_CONSUMER'), 'orphan consumer bites');
const noCommandTopology = { ...topology, commandRefs: [] };
const noCommandChecklist = checklist();
noCommandChecklist.items[0].verificationIntent!.edge.push({ id: 'INT-COMMAND', desc: 'second outcome requires an explicit command', type: 'cli', priority: 'must' });
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: noCommandChecklist, contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001', 'INT-COMMAND'], milestoneIds: [], verificationTopology: noCommandTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_COMMAND_MISSING'), 'empty command group bites for a non-minimal multi-outcome binding');
const unrelatedIntentChecklist = checklist();
unrelatedIntentChecklist.items[0].verificationIntent!.happy.push({ id: 'INT-OTHER', desc: 'unrelated must intent', type: 'logic', priority: 'must' });
const wrongIntentTopology = { ...topology, positiveAssertionRefs: [{ ...topology.positiveAssertionRefs[0], sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'intent:INT-OTHER' } }] };
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: unrelatedIntentChecklist, contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: wrongIntentTopology }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_INTENT_UNCOVERED'), 'assertion group presence cannot hide an unmapped bound must intent');
const laneChecklist = checklist();
laneChecklist.items[0].verificationIntent!.edge.push({ id: 'INT-EDGE', desc: 'edge path is mapped', type: 'logic', priority: 'must' });
laneChecklist.items[0].verificationIntent!.adversarial.push({ id: 'INT-ADV', desc: 'mutation must bite', type: 'logic', priority: 'must' });
const laneTopology = {
  ...topology,
  mutationCaseRefs: [
    { ...topology.mutationCaseRefs[0], id: 'M-EDGE', sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'intent:INT-EDGE' } },
    { ...topology.mutationCaseRefs[0], id: 'M-ADV', sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'intent:INT-ADV' } },
  ],
};
const laneBinding = { id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001', 'INT-EDGE', 'INT-ADV'], milestoneIds: [], verificationTopology: laneTopology };
assert.ok(!buildAcceptanceMatrixReport({ storyId, checklist: laneChecklist, contract: contract([laneBinding]), ledger: null }).rows[0].diagnosticCodes.includes('AT_INTENT_UNCOVERED'), 'happy/edge/adversarial must intents map through their appropriate groups');
const missingAdversarial = { ...laneTopology, mutationCaseRefs: laneTopology.mutationCaseRefs.filter(entry => entry.id !== 'M-ADV') };
assert.ok(buildAcceptanceMatrixReport({ storyId, checklist: laneChecklist, contract: contract([{ ...laneBinding, verificationTopology: missingAdversarial }]), ledger: null }).rows[0].diagnosticCodes.includes('AT_INTENT_UNCOVERED'), 'adversarial must-intent omission bites even when mutation group remains non-empty');
const inlineTopology = { ...topology, relation: 'invented', result: 'pass', coverageBasisRef: 'self-authored' } as any;
const inlineCodes = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: inlineTopology }]), ledger: null }).rows[0].diagnosticCodes;
assert.ok(inlineCodes.includes('AT_PLANNED_PATH_DECLARATION_DRIFT') && inlineCodes.includes('AT_INLINE_RESULT_FORBIDDEN') && inlineCodes.includes('AT_AUTHORITY_PROMOTION_FORBIDDEN'), 'inline semantics/result/authority mutations bite');
const unsupported = buildAcceptanceMatrixReport({ storyId, checklist: checklist(), contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: { ...topology, schemaVersion: 'proofstory.acceptance_topology.v2' } as any }]), ledger: null });
assert.ok(unsupported.rows[0].diagnosticCodes.includes('AT_UNSUPPORTED_VERSION'), 'unsupported topology versions remain readable as warnings');
const docsChecklist = checklist(false);
docsChecklist.items[0].verificationIntent = { happy: [{ id: 'INT-001', desc: 'documentation source boundary', type: 'docs', priority: 'must' }], edge: [], adversarial: [{ id: 'INT-DOC-ADV', desc: 'documentation omission check', type: 'docs', priority: 'must' }] };
const docsTopology = {
  ...topology,
  producerRefs: [{ id: 'P-1', sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'checklist:CHK-001' } }],
  consumerRefs: [{ id: 'C-1', sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'intent:INT-001' }, producerRefs: ['P-1'] }],
  positiveAssertionRefs: [
    topology.positiveAssertionRefs[0],
    { ...topology.positiveAssertionRefs[0], id: 'A-DOC-ADV', sourceRef: { refKind: 'existing' as const, canonicalSourceRef: 'intent:INT-DOC-ADV' } },
  ],
  mutationCaseRefs: [], transcriptAssertionRefs: [], commandRefs: [],
};
assert.equal(buildAcceptanceMatrixReport({ storyId, checklist: docsChecklist, contract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001', 'INT-DOC-ADV'], milestoneIds: [], verificationTopology: docsTopology }]), ledger: null }).result, 'inconclusive_basis_unverified', 'docs-only topology maps must intents without fabricated runtime mutation/transcript/command');

const injectedProjectionChecklist = checklist(false);
injectedProjectionChecklist.items[0].verificationEvidence = [{
  intentRef: 'INT-001',
  kind: 'manual_transcript',
  command: `proof-or-stop acceptance_matrix --storyId=${storyId}`,
  result: 'pass',
  note: 'Result: inconclusive_basis_unverified',
}];
assert.equal(buildVerificationCoverage(injectedProjectionChecklist).missingRequired, 1, 'legacy/injected matrix transcript cannot cover general verification gate intent');
const projectionReview = evaluateReviewCompleteness({
  story: story('REVIEW'),
  checklist: injectedProjectionChecklist,
  originalIntentSnapshot: null,
  milestoneLedger: null,
  slicePlan: null,
  parentLedgerRollup: null,
  proofStoryContract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [] }]),
  intentCollision: null,
  scopeContract: null,
  scopeShrinkageDecision: null,
  redEvidence: null,
  spikeEvidence: null,
}, 'observe');
assert.ok(projectionReview.gaps.some(gap => gap.code === 'review_completeness_missing_evidence'), 'legacy/injected matrix transcript cannot cover ProofStory REVIEW completeness');

const paraphrasedProjectionChecklist = checklist(false);
paraphrasedProjectionChecklist.items[0].status = 'done';
paraphrasedProjectionChecklist.items[0].verificationEvidence = [{
  intentRef: 'INT-001',
  kind: 'manual_transcript',
  command: 'node replay.mjs',
  result: 'pass',
  note: 'Observed matrix projection was inconclusive_basis_unverified.',
}];
assert.equal(buildVerificationCoverage(paraphrasedProjectionChecklist).missingRequired, 1, 'paraphrased reserved result remains non-covering in general verification');
const paraphrasedProjectionReview = evaluateReviewCompleteness({
  story: story('REVIEW'),
  checklist: paraphrasedProjectionChecklist,
  originalIntentSnapshot: null,
  milestoneLedger: null,
  slicePlan: null,
  parentLedgerRollup: null,
  proofStoryContract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [] }]),
  intentCollision: null,
  scopeContract: null,
  scopeShrinkageDecision: null,
  redEvidence: null,
  spikeEvidence: null,
}, 'observe');
assert.ok(paraphrasedProjectionReview.gaps.some(gap => gap.code === 'review_completeness_missing_evidence'), 'paraphrased reserved result remains non-covering in ProofStory completeness');
for (const kind of ['logic_test', 'integration_test'] as const) {
  const reservedTokenControl = checklist(false);
  reservedTokenControl.items[0].verificationEvidence = [{
    intentRef: 'INT-001',
    kind,
    command: 'node independent-verification.test.mjs',
    result: 'pass',
    note: 'Valid graph remains inconclusive_basis_unverified because Wave 1 is observe-only.',
  }];
  assert.equal(buildVerificationCoverage(reservedTokenControl).missingRequired, 0, `${kind} notes may mention reserved output while independent evidence remains covering`);
}
const falsePositiveControl = checklist(false);
falsePositiveControl.items[0].verificationEvidence = [{
  intentRef: 'INT-001',
  kind: 'logic_test',
  command: 'node warning-threshold.test.mjs',
  result: 'pass',
  note: 'Result: warning threshold test passed with expected fallback.',
}];
assert.equal(buildVerificationCoverage(falsePositiveControl).missingRequired, 0, 'ordinary warning prose remains covering');
for (const command of [
  'rg acceptance_matrix packages/main/src/core/command-policy.ts',
  'printf acceptance_matrix',
  'node cli-contract-test.mjs acceptance_matrix',
]) {
  const argumentTokenControl = checklist(false);
  argumentTokenControl.items[0].verificationEvidence = [{
    intentRef: 'INT-001',
    kind: 'logic_test',
    command,
    result: 'pass',
    note: 'Independent source or argument assertion passed.',
  }];
  assert.equal(buildVerificationCoverage(argumentTokenControl).missingRequired, 0, `general verification accepts non-producer token: ${command}`);
}
const proofStoryArgumentControl = checklist(false);
proofStoryArgumentControl.items[0].verificationEvidence = [{
  intentRef: 'INT-001',
  kind: 'integration_test',
  command: 'node cli-contract-test.mjs acceptance_matrix',
  result: 'pass',
  note: 'Independent CLI argument-contract assertion passed.',
}];
const argumentControlReview = evaluateReviewCompleteness({
  story: story('REVIEW'),
  checklist: proofStoryArgumentControl,
  originalIntentSnapshot: null,
  milestoneLedger: null,
  slicePlan: null,
  parentLedgerRollup: null,
  proofStoryContract: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [] }]),
  intentCollision: null,
  scopeContract: null,
  scopeShrinkageDecision: null,
  redEvidence: null,
  spikeEvidence: null,
}, 'observe');
assert.ok(!argumentControlReview.gaps.some(gap => gap.code === 'review_completeness_missing_evidence'), 'ProofStory accepts acceptance_matrix used only as a test argument');
const milestoneProjectionChecklist = checklist(false);
milestoneProjectionChecklist.items[0].status = 'done';
milestoneProjectionChecklist.items[0].verificationEvidence = [{
  intentRef: 'INT-001',
  kind: 'logic_test',
  command: `proof-or-stop acceptance_matrix --storyId=${storyId}`,
  result: 'pass',
  note: 'Caller marked the replayed legacy row as passing.',
}];
const matrixReplayLedger: MilestoneLedgerData = {
    schemaVersion: 'proofstory.milestone_ledger.v1',
    storyId,
    state: 'confirmed',
    ledgerHash: 'matrix-replay',
    createdAt: now,
    updatedAt: now,
    milestones: [{
      id: 'M-MATRIX-REPLAY',
      sourceRequirementId: 'REQ-MATRIX-REPLAY',
      claim: 'Matrix projection cannot close milestone evidence',
      doneMeans: 'Only independent verification covers this milestone',
      requiredEvidence: ['logic_test'],
      checklistRefs: ['CHK-001'],
      verificationIntentRefs: ['INT-001'],
      status: 'planned',
    }],
};
const milestoneReport = buildMilestoneStatusReport({
  story: story('DEV'),
  checklist: milestoneProjectionChecklist,
  milestoneLedger: matrixReplayLedger,
});
const milestoneRow = milestoneReport.milestones[0];
assert.match(milestoneRow.statusDetail, /evidence=not-passing; requiredEvidence=missing/, 'milestone evidence and requiredEvidence remain uncovered');
assert.equal(milestoneRow.subObjectives.find(row => row.id === 'INT-001')?.status, 'not-passing', 'milestone intent subobjective remains uncovered');
assert.equal(milestoneRow.subObjectives.find(row => row.id === 'logic_test')?.status, 'missing-evidence-kind', 'milestone required-evidence subobjective remains uncovered');
assert.throws(() => buildMilestoneCloseoutSnapshot({ report: milestoneReport }), /incomplete|remaining/i, 'closeout cannot freeze matrix-derived coverage');
const milestoneArgumentControl = checklist(false);
milestoneArgumentControl.items[0].status = 'done';
milestoneArgumentControl.items[0].verificationEvidence = [{
  intentRef: 'INT-001',
  kind: 'logic_test',
  command: 'rg acceptance_matrix packages/main/src/core/command-policy.ts',
  result: 'pass',
  note: 'Independent registry assertion passed.',
}];
const milestoneArgumentReport = buildMilestoneStatusReport({ story: story('DEV'), checklist: milestoneArgumentControl, milestoneLedger: matrixReplayLedger });
assert.match(milestoneArgumentReport.milestones[0].statusDetail, /evidence=covered; requiredEvidence=covered/, 'milestone consumer accepts a non-producer search token');

const cliRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-topology-cli-'));
try {
  git(cliRoot, ['init', '-b', 'main']);
  git(cliRoot, ['config', 'user.email', 'topology@example.test']);
  git(cliRoot, ['config', 'user.name', 'Topology Smoke']);
  write(cliRoot, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }, null, 2));
  write(cliRoot, 'README.md', 'acceptance topology smoke\n');
  write(cliRoot, lifecycleFixtureFiles[0], 'export const lifecycleMachineFixture = true;\n');
  write(cliRoot, lifecycleFixtureFiles[1], 'export const lifecyclePhaseGateFixture = true;\n');
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

  const lifecycleDigestBefore = lifecycleFixtureDigest(cliRoot);
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

  const lifecycleContracts = {
    valid: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [], verificationTopology: topology }]),
    missing: contract([{ id: 'AC-1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-001'], milestoneIds: [] }]),
    malformed: malformedContract,
  };
  const lifecycleEventsBefore = JSON.stringify(store.readProcessEvents(storyId));
  const lifecycleDecisions: Record<string, { planToDev: boolean; devToReview: boolean }> = {};
  for (const [state, stateContract] of Object.entries(lifecycleContracts)) {
    store.writeProofStoryContract(storyId, stateContract);
    store.writeChecklist(storyId, checklist());
    store.writeStory(storyId, story('PLAN'));
    const planToDev = canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', cliRoot);
    const devChecklist = checklist();
    devChecklist.items[0].status = 'done';
    devChecklist.items[0].startTime = now;
    devChecklist.items[0].endTime = now;
    store.writeChecklist(storyId, devChecklist);
    store.writeStory(storyId, story('DEV'));
    const devToReview = canSendStoryEventWithoutSnapshotCan(storyId, store, 'DEV', 'CODE_REVIEW', cliRoot);
    lifecycleDecisions[state] = { planToDev, devToReview };
    assert.equal(store.readStory(storyId).phase, 'DEV', `${state} diagnostic evaluation does not auto-advance DEV`);
    assert.equal(JSON.stringify(store.readProcessEvents(storyId)), lifecycleEventsBefore, `${state} diagnostic evaluation emits no lifecycle event`);
  }
  assert.deepEqual(lifecycleDecisions.valid, lifecycleDecisions.missing, 'valid and missing topology preserve PLAN→DEV and DEV→REVIEW decisions');
  assert.deepEqual(lifecycleDecisions.valid, lifecycleDecisions.malformed, 'valid and malformed topology preserve PLAN→DEV and DEV→REVIEW decisions');
  assert.equal(lifecycleFixtureDigest(cliRoot), lifecycleDigestBefore, 'topology diagnostics do not modify fixture-local lifecycle sources');

  const machineFixture = readFileSync(join(cliRoot, lifecycleFixtureFiles[0]), 'utf8');
  write(cliRoot, lifecycleFixtureFiles[0], `${machineFixture}export const unauthorizedTopologyMutation = true;\n`);
  assert.notEqual(lifecycleFixtureDigest(cliRoot), lifecycleDigestBefore, 'fixture-local lifecycle invariant bites an unauthorized machine mutation');
  write(cliRoot, lifecycleFixtureFiles[0], machineFixture);
  assert.equal(lifecycleFixtureDigest(cliRoot), lifecycleDigestBefore, 'restoring the fixture-local lifecycle source restores the invariant');
} finally {
  rmSync(cliRoot, { recursive: true, force: true });
}

console.log('ProofStory acceptance topology Wave 1 smoke passed');
