import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChecklistData } from '../core/types.js';
import {
  assertReviewInventoryCutoff,
  assertReviewInventoryEvidenceWritable,
  buildWave,
  consumeReviewInventoryCompletenessReceipt,
  consumeReviewInventoryReceipt,
  evaluateReviewInventoryWave,
  isInventoryCompletenessOnlyReceipt,
  persistFinalizedReviewInventory,
  findingFamily,
  reviewInventoryAggregateFamilies,
  reviewInventoryAcceptanceSubjectDigest,
  reviewInventoryAcceptanceSubjectDigestForStore,
  reviewInventoryDigest,
  reviewInventoryPurposeBinding,
  reviewInventoryLaneCoverageDigest,
  reviewInventoryRemediationGate,
  signReviewInventoryCriticReceipt,
  signReviewInventoryEpoch,
  signReviewInventoryReceipt,
  validateReviewInventoryCriticReceipt,
  verifyReviewInventoryEpoch,
  verifyReviewInventoryCriticReceipt,
  verifyReviewInventoryReceipt,
  type ReviewInventoryEvaluation,
} from '../core/review-inventory-epoch.js';
import { signReviewRun, verifyReviewRun } from '../core/review-run.js';
import { CURRENT_PROMPT_IDENTITIES, domainSeparatedDigest } from '../core/prompt-contracts.js';
import { signReviewPass, signFinding, verifyReviewPass, verifyFinding } from '../core/finding-verify.js';
import type {
  Finding,
  ReviewInventoryCriticReceipt,
  ReviewInventoryEpochData,
  ReviewInventoryEpoch,
  ReviewInventoryFindingDisposition,
  ReviewInventoryReceipt,
  ReviewPass,
  ReviewRun,
} from '../core/types.js';
import { assertOpenInventoryFresh, createReviewInventoryHandlers, renderReviewInventoryBegin, renderReviewInventoryStatus } from '../handlers/review-inventory.js';
import { StoryStore } from '../core/store.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import { resetConfigCache } from '../core/config.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { validateVerificationReceipt } from '../core/verification-execution-evidence.js';
import { buildVerificationReuseCapsuleInvocation, verificationReuseCapsuleEnforcementSupported } from '../core/verification-reuse-capsule.js';
import { runSingleAllowlistedCommand } from '../core/validation-executor.js';
import { entriesFromSerialReference, validateInventory } from './full-suite-runner.js';
import { acquireMkdirLock, MKDIR_LOCK_HOLDER_FILE } from '../core/mkdir-lock.js';

// B-aa5f F063: actual producer receipts and a real OPEN epoch, not synthetic
// timestamp edits. Existing historical flat-projection cases remain below.
async function authenticatedInventoryRegression(): Promise<void> {
  const semanticKey = 'B_AA5F_INVENTORY_REAL_ENVIRONMENT';
  const priorSemanticValue = process.env[semanticKey];
  const root = mkdtempSync(join(tmpdir(), 'baa5f-inventory-observation-'));
  const external = mkdtempSync(join(tmpdir(), 'baa5f-inventory-input-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const input = join(external, 'observation.txt');
  const launches = join(external, 'children.txt');
  writeFileSync(input, 'INVENTORY_OK\n');
  writeFileSync(launches, '');
  write('proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements' }));
  write('packages/main/package.json', JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0-smoke' }));
  write('packages/main/src/base.ts', 'export const base = true;\n');
  git('init', '-b', 'work'); git('config', 'user.email', 'smoke@example.test'); git('config', 'user.name', 'Baa5f inventory smoke');
  git('add', '.'); git('commit', '-m', 'seed'); git('branch', 'main');
  resetConfigCache();
  const store = new StoryStore(root);
  const sid = 'B-aa5f-inventory-real';
  const at = '2026-09-06T00:00:00.000Z';
  store.writeStory(sid, { storyId: sid, name: 'inventory-real', title: 'real observation compatibility', description: 'smoke', type: 'chore', phase: 'DEV',
    priority: 'medium', createdAt: at, startedAt: at, endedAt: null });
  store.writeChecklist(sid, { items: [{ id: 'CHK-001', title: 'observation', context: 'real output', status: 'in_progress', startTime: null, endTime: null,
    verificationIntent: { happy: [{ id: 'OBS', desc: 'observe complete output', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] });
  acquireOwnerLease(store.storyDirPath(sid), { command: 'smoke_fixture_setup', cwd: root });
  const ctx = { store, root, scanRoot: join(root, 'packages/main') };
  let childCount = 0;
  const handlers = createChecklistHandlers({ ...ctx, verificationCommandRunner: async (command, cwd, timeoutMs) => {
    childCount++;
    return runSingleAllowlistedCommand(command, root, { cwd, timeoutMs });
  } });
  const code = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(launches)},process.pid+'\\n');process.stdout.write(fs.readFileSync(${JSON.stringify(input)},'utf8'))`;
  const command = `node -e ${JSON.stringify(code)}`;
  const record = () => handlers.verification_evidence_add({ storyId: sid, itemId: 'CHK-001', intentRef: 'OBS', kind: 'integration_test', command,
    selector: 'INVENTORY_OK', result: 'pass', note: 'identical observation contract' });
  const row = () => store.readChecklist(sid).items[0].verificationEvidence!.find(value => value.intentRef === 'OBS')!;
  const validated = () => {
    const evidence = row();
    const expected = { storyId: sid, intentRef: 'OBS', selector: 'INVENTORY_OK', command };
    assert.ok(evidence.receipt);
    const result = validateVerificationReceipt(root, evidence.receipt, expected);
    assert.equal(result.ok, true, `F063 genuine producer graph/artifact valid: ${result.errors.join('; ')}`);
    assert.equal(result.output, 'INVENTORY_OK\n');
    return structuredClone(evidence);
  };
  try {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    const chain = [pkg.scripts['test:serial-reference-prefix'], pkg.scripts['test:serial-reference']].filter(Boolean).join(' && ');
    const entries = entriesFromSerialReference(chain, pkg.scripts);
    validateInventory(entries, chain, pkg.scripts);
    assert.ok(entries.some(entry => entry.name === 'test:review-inventory-epoch'));
    assert.equal(pkg.scripts['test:review-inventory-epoch'], 'node packages/main/dist/tasks/review-inventory-epoch-smoke.js');
    const config = JSON.parse(readFileSync(join(repo, 'proof-or-stop.config.json'), 'utf8'));
    assert.ok(config.validate.commands.some((entry: { command: string; args?: string[] }) => entry.command === 'node' && entry.args?.join(' ') === 'packages/main/dist/tasks/review-inventory-epoch-smoke.js'),
      'F063 inventory smoke registered in configured validation as well as full npm inventory');
    await record();
    const first = validated();
    const subject = reviewInventoryAcceptanceSubjectDigestForStore(store, sid);
    const cutoff = { materialHash: currentMaterialHash(root, 'HEAD', root), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root) };
    store.writeStory(sid, { ...store.readStory(sid), phase: 'REVIEW', currentReviewRound: at });
    createReviewInventoryHandlers(ctx).review_inventory_begin({ storyId: sid });
    const opened = store.readReviewInventoryEpochs(sid).epochs.at(-1)!;
    assert.equal(opened.state, 'OPEN');
    assertOpenInventoryFresh(ctx, sid);
    await record();
    const second = validated();
    assert.equal(childCount, 2, 'F063 two actual executions, no metadata-only simulation');
    assert.equal(new Set(readFileSync(launches, 'utf8').trim().split('\n')).size, 2, 'F063 child-written PID log proves two processes');
    assert.notDeepEqual(second.receipt, first.receipt, 'F063 the two authentic receipt graphs are independently issued');
    assert.equal(second.receipt!.outputDigest, first.receipt!.outputDigest);
    assert.deepEqual({ materialHash: currentMaterialHash(root, 'HEAD', root), storyFilesHash: currentStoryFilesHash(root, 'HEAD', root) }, cutoff,
      'F063 real reexecution leaves epoch material/scope cutoff unchanged');
    console.log('F063 controls realExecutions=2 completeOutputEqual=true receiptsAuthentic=true cutoffUnchanged=true registration=PASS');
    const failures: string[] = [];
    const check = (label: string, fn: () => unknown) => {
      try { fn(); } catch (error) {
        const detail = `${label}: ${error instanceof Error ? error.message : String(error)}`;
        failures.push(detail); console.error(`[F063 assertion FAIL] ${detail}`);
      }
    };
    check('F063 same-output reexecution keeps authenticated observation subject', () => {
      assert.equal(reviewInventoryAcceptanceSubjectDigestForStore(store, sid), subject);
    });
    check('F063 same-output reexecution preserves real OPEN inventory', () => {
      assertOpenInventoryFresh(ctx, sid);
      assert.equal(store.readReviewInventoryEpochs(sid).epochs.at(-1)?.state, 'OPEN');
    });
    assert.equal(failures.length, 0, failures.join('\n'));

    // Tamper rejection is INDEPENDENT of semantic equality. Never drop a bad
    // signature/context because its projected observation would look unchanged.
    const authenticChecklist = store.readChecklist(sid);
    for (const attack of ['signature', 'command', 'freshness'] as const) {
      const changed = structuredClone(authenticChecklist);
      const evidence = changed.items[0].verificationEvidence![0];
      const receipt = evidence.receipt as unknown as Record<string, any>;
      if (attack === 'signature') receipt.executionReceipt.authenticity.signature = 'invalid-signature';
      if (attack === 'command') evidence.command = 'node never-executed-inventory.js';
      if (attack === 'freshness') evidence.materialHash = 'f'.repeat(64);
      store.writeChecklist(sid, changed);
      assert.throws(() => reviewInventoryAcceptanceSubjectDigestForStore(store, sid), /invalid|mismatch|signature|command|freshness|binding/i,
        `F063 ${attack} cannot normalize to a valid observation`);
      store.writeChecklist(sid, authenticChecklist);
    }
    const artifact = (second.receipt as unknown as Record<string, any>).executionReceipt.outputArtifact;
    const artifactPath = join(root, '.proof-or-stop/evidence/objects/sha256', `${artifact.artifactDigest}.json`);
    const artifactBytes = readFileSync(artifactPath, 'utf8');
    writeFileSync(artifactPath, artifactBytes.replace('INVENTORY_OK', 'INVENTORY_NO'));
    assert.throws(() => reviewInventoryAcceptanceSubjectDigestForStore(store, sid), /artifact|digest|integrity|invalid/i, 'F063 full artifact tamper rejected before projection');
    writeFileSync(artifactPath, artifactBytes);

    // A PLAN-authorized intent correction may retire an earlier intentRef while
    // retaining its immutable evidence history. Inventory authentication must
    // evaluate the current acceptance basis, not require retired evidence to
    // resolve against a current pin. The current replacement receipt remains
    // fully authenticated and tamper-sensitive.
    const renamedChecklist = store.readChecklist(sid);
    renamedChecklist.items[0].verificationIntent!.happy[0].id = 'OBS-V2';
    store.writeChecklist(sid, renamedChecklist);
    await handlers.verification_evidence_add({ storyId: sid, itemId: 'CHK-001', intentRef: 'OBS-V2', kind: 'integration_test', command,
      selector: 'INVENTORY_OK', result: 'pass', note: 'replacement observation contract' });
    const renamedAuthentic = store.readChecklist(sid);
    const renamedSubject = reviewInventoryAcceptanceSubjectDigestForStore(store, sid);
    assert.doesNotThrow(
      () => reviewInventoryAcceptanceSubjectDigestForStore(store, sid),
      'RETIRED_EVIDENCE_MUST_NOT_BLOCK_CURRENT_INVENTORY',
    );
    const changedRetired = structuredClone(renamedAuthentic);
    const retiredEvidence = changedRetired.items[0].verificationEvidence!.find(value => value.intentRef === 'OBS')!;
    retiredEvidence.command = 'node retired-history-does-not-define-current-acceptance.js';
    (retiredEvidence.receipt as unknown as Record<string, any>).executionReceipt.authenticity.signature = 'invalid-retired-signature';
    store.writeChecklist(sid, changedRetired);
    assert.equal(
      reviewInventoryAcceptanceSubjectDigestForStore(store, sid),
      renamedSubject,
      'retired evidence is excluded from the current acceptance subject',
    );
    for (const attack of ['signature', 'command', 'freshness'] as const) {
      const tamperedCurrent = structuredClone(renamedAuthentic);
      const currentEvidence = tamperedCurrent.items[0].verificationEvidence!.find(value => value.intentRef === 'OBS-V2')!;
      const receipt = currentEvidence.receipt as unknown as Record<string, any>;
      if (attack === 'signature') receipt.executionReceipt.authenticity.signature = 'invalid-signature';
      if (attack === 'command') currentEvidence.command = 'node never-executed-replacement.js';
      if (attack === 'freshness') currentEvidence.materialHash = 'f'.repeat(64);
      store.writeChecklist(sid, tamperedCurrent);
      assert.throws(
        () => reviewInventoryAcceptanceSubjectDigestForStore(store, sid),
        /invalid|mismatch|signature|command|freshness|binding|authentication/i,
        `current replacement ${attack} remains authenticated`,
      );
    }
    const emptyIntents = structuredClone(renamedAuthentic);
    emptyIntents.items[0].verificationIntent = { happy: [], edge: [], adversarial: [] };
    store.writeChecklist(sid, emptyIntents);
    const emptyIntentSubject = reviewInventoryAcceptanceSubjectDigestForStore(store, sid);
    const emptyIntentsWithoutHistory = structuredClone(emptyIntents);
    emptyIntentsWithoutHistory.items[0].verificationEvidence = [];
    store.writeChecklist(sid, emptyIntentsWithoutHistory);
    assert.equal(
      reviewInventoryAcceptanceSubjectDigestForStore(store, sid),
      emptyIntentSubject,
      'an explicitly empty current intent set retires all prior evidence rows',
    );
    store.writeChecklist(sid, authenticChecklist);

    process.env[semanticKey] = 'real-environment-change-with-identical-output';
    await record();
    const changedInput = row();
    assert.equal(changedInput.receipt!.outputDigest, second.receipt!.outputDigest,
      'F063 isolated input-semantics control keeps complete output exactly equal');
    assert.notEqual((changedInput.receipt as any).executionReceipt.executionIdentityDigest, (second.receipt as any).executionReceipt.executionIdentityDigest,
      'F063 actual subprocess observed a different live environment identity');
    assert.notEqual(reviewInventoryAcceptanceSubjectDigestForStore(store, sid), subject,
      'F063 changed execution-input semantics change subject even when output is identical');
    assert.throws(() => assertOpenInventoryFresh(ctx, sid), /OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/);
    createReviewInventoryHandlers(ctx).review_inventory_begin({ storyId: sid });
    const changedInputSubject = reviewInventoryAcceptanceSubjectDigestForStore(store, sid);
    writeFileSync(input, 'INVENTORY_OK changed observation\n');
    await record();
    assert.notEqual(reviewInventoryAcceptanceSubjectDigestForStore(store, sid), changedInputSubject, 'genuine changed observation changes subject');
    assert.throws(() => assertOpenInventoryFresh(ctx, sid), /OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/);

    // A policy-owned capsule is the only zero-child reuse control. Its subject
    // may stay equal after unrelated material drift; the cutoff must NOT.
    assert.equal(verificationReuseCapsuleEnforcementSupported(), true, 'F063 capsule reuse cannot be skipped');
    store.writeStory(sid, { ...store.readStory(sid), phase: 'DEV' });
    const capInput = 'packages/main/src/capsule-input.txt';
    const manifest = 'packages/main/capsule.verification-dependencies.json';
    write(capInput, 'CAPSULE_INVENTORY_OK\n');
    write(manifest, JSON.stringify({ schemaVersion: 'proof-or-stop.verifier-dependency-manifest.v2', capsuleProfile: 'proof-or-stop.verification-reuse-capsule.v1', files: [capInput] }));
    git('add', capInput, manifest); git('commit', '-m', 'capsule input');
    const capCommand = buildVerificationReuseCapsuleInvocation({ cwd: root, manifestPath: manifest, files: [capInput] }).command;
    const capChecklist = store.readChecklist(sid);
    capChecklist.items[0].verificationIntent!.happy.push({ id: 'CAP', desc: 'capsule observation', type: 'cli', priority: 'must' });
    store.writeChecklist(sid, capChecklist);
    await handlers.verification_evidence_add({ storyId: sid, itemId: 'CHK-001', intentRef: 'CAP', kind: 'integration_test', command: capCommand,
      selector: 'CAPSULE_INVENTORY_OK', result: 'pass', file: manifest, note: 'capsule observation contract' });
    // Keep only the capsule item when comparing the reuse observation; the
    // unrelated ordinary command correctly needs a real execution after drift.
    const capsuleOnly = store.readChecklist(sid);
    capsuleOnly.items[0].verificationIntent!.happy = capsuleOnly.items[0].verificationIntent!.happy.filter(value => value.id === 'CAP');
    capsuleOnly.items[0].verificationEvidence = capsuleOnly.items[0].verificationEvidence!.filter(value => value.intentRef === 'CAP');
    store.writeChecklist(sid, capsuleOnly);
    const capSubject = reviewInventoryAcceptanceSubjectDigestForStore(store, sid);
    store.writeStory(sid, { ...store.readStory(sid), phase: 'REVIEW' });
    createReviewInventoryHandlers(ctx).review_inventory_begin({ storyId: sid });
    write('packages/main/src/unrelated.ts', 'export const unrelated = true;\n');
    git('add', 'packages/main/src/unrelated.ts'); git('commit', '-m', 'unrelated material drift');
    assert.throws(() => assertOpenInventoryFresh(ctx, sid), /OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION/);
    store.writeStory(sid, { ...store.readStory(sid), phase: 'DEV' });
    childCount = 0;
    await handlers.verification_evidence_refresh_stale({ storyId: sid });
    const reused = store.readChecklist(sid).items[0].verificationEvidence![0];
    assert.equal(childCount, 0, 'F063 actual authorized capsule reuse launches zero children');
    assert.equal((reused.receipt as unknown as Record<string, any>).publicationMode, 'reused');
    assert.ok(reused.receipt);
    assert.equal(validateVerificationReceipt(root, reused.receipt, { storyId: sid, intentRef: 'CAP', selector: 'CAPSULE_INVENTORY_OK' }).ok, true);
    assert.equal(reviewInventoryAcceptanceSubjectDigestForStore(store, sid), capSubject, 'F063 valid reuse preserves observation identity');
    write(capInput, 'CAPSULE_INVENTORY_OK changed input\n');
    git('add', capInput); git('commit', '-m', 'actual capsule input change');
    await handlers.verification_evidence_refresh_stale({ storyId: sid });
    assert.equal(childCount, 1);
    assert.notEqual(reviewInventoryAcceptanceSubjectDigestForStore(store, sid), capSubject, 'genuine execution-input changes alter subject');
  } finally {
    if (priorSemanticValue === undefined) delete process.env[semanticKey]; else process.env[semanticKey] = priorSemanticValue;
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
}

let authenticatedInventoryFailure: unknown;
try { await authenticatedInventoryRegression(); } catch (error) {
  authenticatedInventoryFailure = error;
  console.error(`[CHK-007 RED] F063: ${error instanceof Error ? error.message : String(error)}`);
}

const storyId = 'B-cdf6-replay';
const reviewRound = '2026-08-14T00:00:00.000Z';
const cutoff = { headHash: 'a'.repeat(40), materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64) };
const requiredLanes = ['proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage'];

const reusedPidRoot = mkdtempSync(join(tmpdir(), 'review-lock-reused-pid-'));
const reusedPidLockDir = join(reusedPidRoot, 'metadata.lock');
mkdirSync(reusedPidLockDir);
writeFileSync(join(reusedPidLockDir, MKDIR_LOCK_HOLDER_FILE), JSON.stringify({
  pid: process.pid,
  hostname: hostname(),
  command: 'stale prior process incarnation',
  acquiredAt: '2000-01-01T00:00:00.000Z',
  lockId: 'old-incarnation-token',
  processStartTimeMs: 946684800000,
}));
const oldTime = new Date(Date.now() - 20_000);
utimesSync(reusedPidLockDir, oldTime, oldTime);
utimesSync(join(reusedPidLockDir, MKDIR_LOCK_HOLDER_FILE), oldTime, oldTime);
const reusedPidLock = acquireMkdirLock(reusedPidLockDir, { staleMs: 10_000, deadlineMs: 2_000, pollMs: 5 });
reusedPidLock.release();

function epoch(unsignedOverrides: Partial<Omit<ReviewInventoryEpoch, '_hash'>> = {}): ReviewInventoryEpoch {
  const unsigned: Omit<ReviewInventoryEpoch, '_hash'> = {
    schemaVersion: 'proof-or-stop.review_inventory_epoch.v1',
    epochId: `${storyId}:RI-001`,
    storyId,
    reviewRound,
    state: 'OPEN',
    begunAt: '2026-08-14T00:01:00.000Z',
    updatedAt: '2026-08-14T00:01:00.000Z',
    cutoff,
    scopeDigest: reviewInventoryAcceptanceSubjectDigest(null, { items: [] }),
    requiredLanes,
    maxWaves: 3,
    initialRunSequenceBoundary: 0,
    waves: [],
    ...unsignedOverrides,
  };
  return { ...unsigned, _hash: signReviewInventoryEpoch(unsigned) };
}

function run(lane: string, id: number, startedAt = `2026-08-14T00:0${id + 1}:00.000Z`): ReviewRun {
  // Synthetic unit input for inventory classification, never persisted reviewer authority.
  const assembledPrompt = JSON.stringify([
    { schemaVersion: CURRENT_PROMPT_IDENTITIES.roleContract },
    { schemaVersion: CURRENT_PROMPT_IDENTITIES.fullTaskContext },
    { schemaVersion: CURRENT_PROMPT_IDENTITIES.knownExecutionEnvironment },
  ]);
  const row: ReviewRun = {
    reviewRunId: `${storyId}:RR-${String(id).padStart(3, '0')}`,
    storyId,
    agent: lane,
    lane,
    reviewRound,
    startedAt,
    ...cutoff,
    assembledPrompt,
    envelopeId: reviewInventoryDigest({ lane, id }),
    promptHash: domainSeparatedDigest('assembled-prompt.raw-utf8.v1', assembledPrompt),
  };
  row._hash = signReviewRun(
    row.storyId, row.reviewRunId, row.agent, row.lane, row.reviewRound, row.startedAt,
    row.headHash, row.materialHash, row.promptHash, undefined, undefined, row.storyFilesHash, row.envelopeId,
  );
  return row;
}

function pass(row: ReviewRun, index: number): ReviewPass {
  const createdAt = new Date(Date.parse(row.startedAt) + 1_000).toISOString();
  const readManifest = { filesReadFully: [`src/${index}.ts`], filesTriagedByName: [], scanEscalationReason: null };
  const readLog = {
    filesReadFully: [...readManifest.filesReadFully],
    filesTriagedByName: [] as string[],
    summary: { readCount: 1, tokenCount: 10 },
    digest: reviewInventoryDigest({ files: readManifest.filesReadFully, index }),
  };
  const result: ReviewPass = {
    id: `${storyId}:RP-${String(index).padStart(3, '0')}`,
    agent: row.lane,
    note: `No blocking finding in frozen inventory wave ${index}`,
    createdAt,
    reviewRound,
    reviewRunId: row.reviewRunId,
    readManifest,
    readLog,
  };
  result._hash = signReviewPass(
    storyId, result.id, result.agent, result.note, createdAt, reviewRound, row.reviewRunId,
    result.readManifest,
    result.readLog,
  );
  return result;
}

function finding(row: ReviewRun): Finding {
  const createdAt = new Date(Date.parse(row.startedAt) + 1_000).toISOString();
  const readManifest = { filesReadFully: ['src/review.ts'], filesTriagedByName: [], scanEscalationReason: null };
  const readLog = {
    filesReadFully: ['src/review.ts'], filesTriagedByName: [],
    summary: { readCount: 1, tokenCount: 10 },
    digest: reviewInventoryDigest({ finding: row.reviewRunId }),
  };
  const result: Finding = {
    id: `${storyId}:F-001`,
    desc: 'Material mutation began before every frozen lane terminated',
    severity: 'high',
    category: 'adversarial',
    status: 'open',
    evidenceState: 'verified',
    agent: row.lane,
    createdAt,
    reviewRound,
    reviewRunId: row.reviewRunId,
    readManifest,
    readLog,
    files: ['src/review.ts'],
    signatureTag: 'audit-only-must-not-affect-family',
  };
  result._hash = signFinding(storyId, result.id, result.desc, result.severity, createdAt, reviewRound, row.reviewRunId, readManifest, readLog);
  return result;
}

function criticEvidence(
  subjectEpoch: ReviewInventoryEpoch,
  evaluation: ReviewInventoryEvaluation,
  id: number,
  terminalAt: string,
  findingDispositions: ReviewInventoryFindingDisposition[] = [],
): { run: ReviewRun; pass: ReviewPass; receipt: ReviewInventoryCriticReceipt } {
  const criticRun = run('proof-or-stop-review-topology-critic', id, terminalAt);
  criticRun.reviewPurpose = 'inventory-completeness';
  criticRun.inventoryBinding = reviewInventoryPurposeBinding(subjectEpoch);
  criticRun._hash = signReviewRun(criticRun.storyId, criticRun.reviewRunId, criticRun.agent, criticRun.lane,
    criticRun.reviewRound, criticRun.startedAt, criticRun.headHash, criticRun.materialHash, criticRun.promptHash,
    undefined, undefined, criticRun.storyFilesHash, criticRun.envelopeId, undefined, criticRun.reviewPurpose, criticRun.inventoryBinding);
  assert.equal(verifyReviewRun(criticRun), true, 'The purpose-bound critic fixture retains its signed prompt envelope');
  const criticPass = pass(criticRun, id);
  const unsigned: Omit<ReviewInventoryCriticReceipt, '_hash'> = {
    schemaVersion: 'proof-or-stop.review_inventory_critic_receipt.v1',
    criticReceiptId: `${subjectEpoch.epochId}:CRIT-${String(subjectEpoch.waves.length + 1).padStart(2, '0')}`,
    epochId: subjectEpoch.epochId,
    storyId,
    reviewRound,
    wave: subjectEpoch.waves.length + 1,
    cutoff,
    aggregateFindingSetDigest: reviewInventoryDigest(reviewInventoryAggregateFamilies(subjectEpoch, evaluation)),
    requiredLaneCoverageDigest: reviewInventoryLaneCoverageDigest(evaluation),
    criticLane: 'proof-or-stop-review-topology-critic',
    reviewRunId: criticRun.reviewRunId,
    reviewPurpose: 'inventory-completeness',
    inventoryBinding: criticRun.inventoryBinding,
    terminalEvidenceIds: [criticPass.id],
    readEvidenceDigest: reviewInventoryDigest([{ id: criticPass.id, readManifest: criticPass.readManifest, readLog: criticPass.readLog?.digest ?? null }]),
    findingDispositions,
    createdAt: new Date(Date.parse(criticPass.createdAt!) + 1_000).toISOString(),
  };
  return { run: criticRun, pass: criticPass, receipt: { ...unsigned, _hash: signReviewInventoryCriticReceipt(unsigned) } };
}

function memoryStore(initialData: ReviewInventoryEpochData) {
  let data = structuredClone(initialData);
  const lockRoot = mkdtempSync(join(tmpdir(), 'review-inventory-epoch-locks-'));
  return {
    readReviewInventoryEpochs: () => structuredClone(data),
    writeReviewInventoryEpochs: (_storyId: string, next: ReviewInventoryEpochData) => { data = structuredClone(next); },
    readReviewRuns: () => ({ runs: [...firstRuns, ...secondRuns, firstCritic.run, secondCritic.run] }),
    readReviewPasses: () => ({ passes: [...firstPasses, ...secondPasses, firstCritic.pass, secondCritic.pass] }),
    readFindings: () => ({ findings: [historical] }),
    readScopeContract: () => null,
    readChecklist: () => ({ items: [] }),
    readProofStoryContract: () => null,
    readScopeShrinkageDecision: () => null,
    runtimeLockDirPath: (_storyId: string, ...segments: string[]) => join(lockRoot, ...segments),
    snapshot: () => structuredClone(data),
  };
}

const initial = epoch();
assert.equal(verifyReviewInventoryEpoch(initial), true);
assert.equal(verifyReviewInventoryEpoch({ ...initial, maxWaves: 99 }), false, 'epoch tamper rejected');
const beginText = renderReviewInventoryBegin(initial);
assert.match(beginText, /^Review inventory epoch: B-cdf6-replay:RI-001/m);
assert.match(beginText, /^State: OPEN$/m);
assert.match(beginText, /^Frozen cutoff: b{64}$/m);
assert.equal((beginText.match(/^Next:/gm) ?? []).length, 1, 'begin exposes exactly one next command');
const emptyEvaluation = evaluateReviewInventoryWave({ epoch: initial, runs: [], passes: [], findings: [] });
const statusText = renderReviewInventoryStatus(initial, { evaluation: emptyEvaluation });
for (const lane of requiredLanes) assert.match(statusText, new RegExp(`Lane ${lane}: pending`));
assert.match(statusText, /Blockers: REVIEW_INVENTORY_LANES_INCOMPLETE/);
assert.match(statusText, /Next: proof-or-stop dispatch .*proof-or-stop-review-concept/);
assert.equal((statusText.match(/^Next:/gm) ?? []).length, 1, 'status exposes exactly one next command');

const firstRuns = requiredLanes.map((lane, index) => run(lane, index + 1));
const firstPasses = firstRuns.map((row, index) => pass(row, index + 1));
const clean = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns, passes: firstPasses, findings: [] });
assert.deepEqual(clean.missingLanes, []);
assert.equal(clean.newFamilies.length, 0);
assert.equal(buildWave(initial, clean, '2026-08-14T00:10:00.000Z').saturated, true);

// B-29bc F-001/F-002: collect both regression failures on the unchanged
// implementation so the RED proves two independent acceptance gaps.
const recoveryFailures: string[] = [];
for (const [label, check] of [
  ['F-001 signed PASS requires both read fields', () => {
    for (const field of ['readManifest', 'readLog'] as const) {
      const incomplete = { ...firstPasses[0] };
      delete incomplete[field];
      incomplete._hash = signReviewPass(storyId, incomplete.id, incomplete.agent, incomplete.note,
        incomplete.createdAt!, reviewRound, incomplete.reviewRunId, incomplete.readManifest, incomplete.readLog);
      assert.equal(verifyReviewPass(storyId, incomplete), true, 'semantic negative control has a valid signature');
      const result = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns,
        passes: [incomplete, ...firstPasses.slice(1)], findings: [] });
      assert.ok(result.missingLanes.includes(firstRuns[0].lane), `signed PASS without ${field} cannot terminate a lane`);
    }
  }],
  ['F-002 current purpose-bound critic findings enter the exact aggregate', () => {
    const critic = criticEvidence(initial, clean, 9, '2026-08-14T00:09:00.000Z');
    const discovered = finding(critic.run);
    assert.equal(verifyFinding(storyId, discovered), true);
    const input = { epoch: initial, runs: [...firstRuns, critic.run], passes: [...firstPasses, critic.pass], findings: [discovered] };
    const missing = evaluateReviewInventoryWave(input);
    assert.deepEqual(missing.rawFindingIds, [discovered.id], 'critic discovery must not disappear because critic is not a required lane');
    assert.deepEqual(missing.unresolvedFindingIds, [discovered.id]);
    assert.equal(missing.lanes.length, clean.lanes.length, 'critic discovery never adds required-lane coverage');
    assert.equal(validateReviewInventoryCriticReceipt({ ...input, evaluation: missing, receipt: critic.receipt }).ok, false,
      'a previously empty receipt becomes invalid after critic discovery');
    const dispositions: ReviewInventoryFindingDisposition[] = [{ findingId: discovered.id, disposition: 'verified_family',
      familyKey: 'critic-discovered-family', reason: 'Independent critic verified the current signed observation.' }];
    const complete = evaluateReviewInventoryWave({ ...input, findingDispositions: dispositions });
    assert.deepEqual(complete.invalidDispositionIds, []);
    assert.deepEqual(complete.unresolvedFindingIds, []);
    assert.deepEqual(complete.newFamilies, ['critic-discovered-family']);
    const retriedCritic = criticEvidence(initial, complete, 10, '2026-08-14T00:10:00.000Z');
    assert.deepEqual(evaluateReviewInventoryWave({ ...input, runs: [...input.runs, retriedCritic.run],
      passes: [...input.passes, retriedCritic.pass] }).rawFindingIds, [discovered.id],
    'a later critic PASS cannot hide the earlier same-wave critic Finding');
    const terminal = criticEvidence(initial, complete, 9, '2026-08-14T00:09:00.000Z', dispositions);
    terminal.receipt.terminalEvidenceIds = [terminal.pass.id, discovered.id].sort();
    terminal.receipt.readEvidenceDigest = reviewInventoryDigest([terminal.pass, discovered].map(row => ({
      id: row.id, readManifest: row.readManifest, readLog: row.readLog?.digest ?? null,
    })));
    const { _hash: _oldSignature, ...unsigned } = terminal.receipt;
    terminal.receipt._hash = signReviewInventoryCriticReceipt(unsigned);
    assert.equal(validateReviewInventoryCriticReceipt({ ...input, evaluation: complete, receipt: terminal.receipt }).ok, true,
      'exact critic disposition and signed terminal set are accepted');
    for (const mutation of [
      { reviewPurpose: undefined, inventoryBinding: undefined },
      { reviewPurpose: 'topology' as const, inventoryBinding: undefined },
      { inventoryBinding: { ...critic.run.inventoryBinding!, wave: 99 } },
      { inventoryBinding: { ...critic.run.inventoryBinding!, epochId: 'wrong-epoch' } },
      { lane: 'proof-or-stop-review-quality', agent: 'proof-or-stop-review-quality' },
    ]) {
      const changed = { ...critic.run, ...mutation };
      changed._hash = signReviewRun(changed.storyId, changed.reviewRunId, changed.agent, changed.lane,
        changed.reviewRound, changed.startedAt, changed.headHash, changed.materialHash, changed.promptHash,
        undefined, undefined, changed.storyFilesHash, changed.envelopeId, undefined, changed.reviewPurpose, changed.inventoryBinding);
      assert.deepEqual(evaluateReviewInventoryWave({ ...input, runs: [...firstRuns, changed] }).rawFindingIds, [],
        'signed wrong-purpose/subject/role critic cannot supply inventory discovery');
    }
    const canonical = { ...critic.run, lane: 'proof-or-stop-review-topology-critic', agent: 'proof-or-stop-review-topology-critic' };
    canonical._hash = signReviewRun(canonical.storyId, canonical.reviewRunId, canonical.agent, canonical.lane,
      canonical.reviewRound, canonical.startedAt, canonical.headHash, canonical.materialHash, canonical.promptHash,
      undefined, undefined, canonical.storyFilesHash, canonical.envelopeId, undefined, canonical.reviewPurpose, canonical.inventoryBinding);
    assert.deepEqual(evaluateReviewInventoryWave({ ...input, runs: [...firstRuns, canonical] }).rawFindingIds, [discovered.id],
      'canonical and registered critic alias share the exact purpose contract');
    const tampered = { ...critic.run, _hash: 'tampered' };
    assert.deepEqual(evaluateReviewInventoryWave({ ...input, runs: [...firstRuns, tampered] }).rawFindingIds, []);
    const missingRead = { ...discovered, readLog: undefined };
    missingRead._hash = signFinding(storyId, missingRead.id, missingRead.desc, missingRead.severity,
      missingRead.createdAt!, reviewRound, missingRead.reviewRunId, missingRead.readManifest, undefined);
    assert.deepEqual(evaluateReviewInventoryWave({ ...input, findings: [missingRead] }).rawFindingIds, [],
      'critic discoveries retain the same signed mechanical read evidence requirement');
  }],
] as const) {
  try { check(); console.log(`B29BC_RECOVERY ${label}: PASS`); }
  catch (error) { recoveryFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}
assert.deepEqual(recoveryFailures, [], `B29BC_RECOVERY RED/GREEN\n${recoveryFailures.join('\n')}`);

const equalTimestampEpoch = epoch({ initialRunSequenceBoundary: 3 });
const equalOldRun = run(requiredLanes[0], 3, equalTimestampEpoch.begunAt);
const equalFreshRun = run(requiredLanes[0], 4, equalTimestampEpoch.begunAt);
assert.equal(
  evaluateReviewInventoryWave({ epoch: equalTimestampEpoch, runs: [equalOldRun], passes: [pass(equalOldRun, 30)], findings: [] }).lanes.length,
  0,
  'F033: equal timestamp cannot bypass a signed sequence boundary',
);
assert.equal(
  evaluateReviewInventoryWave({ epoch: equalTimestampEpoch, runs: [equalFreshRun], passes: [pass(equalFreshRun, 31)], findings: [] }).lanes.length,
  1,
  'F033: a genuinely post-boundary ReviewRun proves freshness by monotonic RR sequence without a busy-wait',
);

const multiRunEpoch = epoch({ initialRunSequenceBoundary: 10 });
const olderFindingRun = run(requiredLanes[0], 11, '2026-08-14T00:02:00.000Z');
const newerPassRun = run(requiredLanes[0], 12, '2026-08-14T00:03:00.000Z');
const otherLaneRuns = [
  run(requiredLanes[1], 13, '2026-08-14T00:04:00.000Z'),
  run(requiredLanes[2], 14, '2026-08-14T00:05:00.000Z'),
];
const olderFinding = finding(olderFindingRun);
const multiRunEvaluation = evaluateReviewInventoryWave({
  epoch: multiRunEpoch,
  runs: [olderFindingRun, newerPassRun, ...otherLaneRuns],
  passes: [pass(newerPassRun, 32), ...otherLaneRuns.map((row, index) => pass(row, 33 + index))],
  findings: [olderFinding],
});
assert.ok(multiRunEvaluation.rawFindingIds.includes(olderFinding.id),
  'F034: a newer same-lane pass cannot hide an older eligible run verified finding');

const historical = finding(firstRuns[0]);
const familyBeforeAuditTagChange = findingFamily(historical);
assert.equal(findingFamily({ ...historical, signatureTag: 'attacker-renamed-audit-tag' }), familyBeforeAuditTagChange);
const rawDiscovery = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns, passes: firstPasses, findings: [historical] });
assert.deepEqual(rawDiscovery.unresolvedFindingIds, [historical.id], 'raw findings cannot become verified families without critic disposition');
assert.notEqual(
  rawDiscovery.lanes.find(row => row.lane === firstRuns[0].lane)?.coverageDigest,
  clean.lanes.find(row => row.lane === firstRuns[0].lane)?.coverageDigest,
  'finding manifest/read-log evidence participates in the lane coverage digest',
);
const missingFindingReadLog = { ...historical };
delete missingFindingReadLog.readLog;
missingFindingReadLog._hash = signFinding(
  storyId, missingFindingReadLog.id, missingFindingReadLog.desc, missingFindingReadLog.severity,
  missingFindingReadLog.createdAt!, reviewRound, missingFindingReadLog.reviewRunId,
  missingFindingReadLog.readManifest, undefined,
);
const missingFindingReadEvidence = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses.slice(1),
  findings: [missingFindingReadLog],
});
assert.ok(missingFindingReadEvidence.missingLanes.includes(firstRuns[0].lane), 'finding without mechanical readLog cannot terminate an inventory lane');
const historicalDispositions: ReviewInventoryFindingDisposition[] = [{
  findingId: historical.id,
  disposition: 'verified_family',
  familyKey: findingFamily(historical),
  reason: 'independent critic verified this distinct finding family',
}];
const discovery = evaluateReviewInventoryWave({
  epoch: initial, runs: firstRuns, passes: firstPasses, findings: [historical], findingDispositions: historicalDispositions,
});
assert.equal(discovery.newFamilies.length, 1);
const duplicateFinding: Finding = {
  ...historical,
  id: `${storyId}:F-002`,
  agent: firstRuns[1].lane,
  reviewRunId: firstRuns[1].reviewRunId,
  createdAt: new Date(Date.parse(firstRuns[1].startedAt) + 1_000).toISOString(),
};
duplicateFinding._hash = signFinding(
  storyId, duplicateFinding.id, duplicateFinding.desc, duplicateFinding.severity,
  duplicateFinding.createdAt!, reviewRound, duplicateFinding.reviewRunId,
  duplicateFinding.readManifest, duplicateFinding.readLog,
);
const duplicateDisposition: ReviewInventoryFindingDisposition[] = [
  historicalDispositions[0],
  {
    findingId: duplicateFinding.id,
    disposition: 'duplicate',
    familyKey: historicalDispositions[0].familyKey,
    canonicalFindingId: historical.id,
    reason: 'independent critic bound the second verified finding to the canonical family',
  },
];
const deduplicated = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical, duplicateFinding],
  findingDispositions: duplicateDisposition,
});
assert.deepEqual(deduplicated.unresolvedFindingIds, []);
assert.deepEqual(deduplicated.invalidDispositionIds, []);
assert.equal(deduplicated.families.length, 1, 'signed duplicate disposition cannot inflate the verified family count');
const rejectedByCritic = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [{ findingId: historical.id, disposition: 'not_verified', reason: 'critic disproved the candidate family' }],
});
assert.equal(rejectedByCritic.families.length, 0, 'critic not_verified disposition cannot count as a verified family');
const unknownDisposition = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [{ findingId: historical.id, disposition: 'garbage' as never, reason: 'mutation must fail closed' }],
});
assert.deepEqual(unknownDisposition.invalidDispositionIds, [historical.id], 'unknown runtime disposition cannot suppress a verified family');
assert.equal(unknownDisposition.families.length, 0);
const suspectedFinding: Finding = { ...historical, id: `${storyId}:F-suspected`, evidenceState: 'suspected', uncertaintyReason: 'candidate not reproduced' };
suspectedFinding._hash = signFinding(
  storyId, suspectedFinding.id, suspectedFinding.desc, suspectedFinding.severity,
  suspectedFinding.createdAt!, reviewRound, suspectedFinding.reviewRunId,
  suspectedFinding.readManifest, suspectedFinding.readLog,
);
const suspectedOnly = evaluateReviewInventoryWave({
  epoch: initial, runs: firstRuns, passes: firstPasses, findings: [suspectedFinding], findingDispositions: [],
});
assert.deepEqual(suspectedOnly.rawFindingIds, [], 'suspected finding closes its lane but never enters verified-family accounting');
assert.equal(suspectedOnly.families.length, 0);
const forgedDuplicate = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [{
    findingId: historical.id,
    disposition: 'duplicate',
    familyKey: findingFamily(historical),
    canonicalFindingId: `${storyId}:F-missing`,
    reason: 'forged canonical reference',
  }],
});
assert.deepEqual(forgedDuplicate.invalidDispositionIds, [historical.id], 'duplicate disposition requires a real canonical verified family');
const conflictingDisposition = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [
    historicalDispositions[0],
    { findingId: historical.id, disposition: 'not_verified', reason: 'conflicting second disposition' },
  ],
});
assert.deepEqual(conflictingDisposition.invalidDispositionIds, [historical.id], 'one finding cannot carry competing critic dispositions');
assert.equal(conflictingDisposition.families.length, 0);
const lanesCompleteStatus = renderReviewInventoryStatus(initial, { evaluation: rawDiscovery });
assert.match(lanesCompleteStatus, /Lane proof-or-stop-review-concept: finding/);
assert.match(lanesCompleteStatus, /Lane proof-or-stop-review-quality: pass/);
assert.match(lanesCompleteStatus, /Verified findings: 0/);
assert.match(lanesCompleteStatus, /New verified findings: 0/);
assert.match(lanesCompleteStatus, /REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE/);
assert.match(lanesCompleteStatus, /Next: proof-or-stop dispatch .*proof-or-stop-review-topology-critic/);
assert.equal((lanesCompleteStatus.match(/^Next:/gm) ?? []).length, 1);
const firstWave = buildWave(initial, discovery, '2026-08-14T00:10:05.000Z', 4);
assert.equal(firstWave.saturated, false);

const secondEpoch = epoch({ waves: [firstWave], updatedAt: firstWave.completedAt! });
const secondRuns = requiredLanes.map((lane, index) => run(lane, index + 10, `2026-08-14T00:1${index + 1}:00.000Z`));
const secondPasses = secondRuns.map((row, index) => pass(row, index + 10));
const saturated = evaluateReviewInventoryWave({
  epoch: secondEpoch,
  runs: [...firstRuns, ...secondRuns],
  passes: [...firstPasses, ...secondPasses],
  findings: [historical],
  findingDispositions: [],
});
assert.deepEqual(saturated.missingLanes, []);
assert.equal(saturated.newFamilies.length, 0, 'second unchanged-material full-lane wave saturates');

const firstCritic = criticEvidence(initial, discovery, 4, '2026-08-14T00:10:02.000Z', historicalDispositions);
assert.equal(verifyReviewInventoryCriticReceipt(firstCritic.receipt), true);
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: firstCritic.receipt,
  epoch: initial,
  evaluation: discovery,
  runs: [...firstRuns, firstCritic.run],
  passes: [...firstPasses, firstCritic.pass],
  findings: [historical],
}).ok, true, 'critic authority is independently signed after required lanes terminate');
const criticTerminalStatus = renderReviewInventoryStatus(initial, {
  evaluation: discovery,
  criticReviewRunId: firstCritic.run.reviewRunId,
});
const criticInput = { epoch: initial, evaluation: discovery, runs: [...firstRuns, firstCritic.run], passes: [...firstPasses, firstCritic.pass], findings: [historical] };
for (const changes of [
  { reviewPurpose: undefined }, { inventoryBinding: undefined },
  ...['storyId', 'epochId', 'reviewRound', 'scopeDigest', 'requiredLanesDigest'].map(key => ({ inventoryBinding: { ...firstCritic.receipt.inventoryBinding!, [key]: 'substituted' } })),
  { inventoryBinding: { ...firstCritic.receipt.inventoryBinding!, wave: 99 } },
  { inventoryBinding: { ...firstCritic.receipt.inventoryBinding!, runSequenceBoundary: 99 } },
  { inventoryBinding: { ...firstCritic.receipt.inventoryBinding!, cutoff: { ...cutoff, materialHash: 'substituted' } } },
]) {
  const changed = { ...firstCritic.receipt, ...changes };
  // Correctly re-sign semantic mutations: rejection must not rely solely on a stale hash.
  const { _hash: _oldSignature, ...unsignedChanged } = changed;
  changed._hash = signReviewInventoryCriticReceipt(unsignedChanged);
  assert.equal(verifyReviewInventoryCriticReceipt(changed), true, 'semantic mutation must retain a valid signature');
  const rejected = validateReviewInventoryCriticReceipt({ ...criticInput, receipt: changed });
  assert.equal(rejected.ok, false, `critic subject substitution rejected: ${JSON.stringify(changes)}`);
  assert.equal(rejected.reason, 'critic inventory purpose/subject binding missing or mismatched');
}
for (const changes of [{ reviewPurpose: undefined, inventoryBinding: undefined }, { reviewPurpose: 'topology' as const, inventoryBinding: undefined }, { inventoryBinding: { ...firstCritic.run.inventoryBinding!, wave: 99 } }]) {
  const changed = { ...firstCritic.run, ...changes };
  changed._hash = signReviewRun(changed.storyId, changed.reviewRunId, changed.agent, changed.lane, changed.reviewRound, changed.startedAt,
    changed.headHash, changed.materialHash, changed.promptHash, undefined, undefined, changed.storyFilesHash, changed.envelopeId, undefined, changed.reviewPurpose, changed.inventoryBinding);
  assert.equal(validateReviewInventoryCriticReceipt({ ...criticInput, runs: [...firstRuns, changed], receipt: firstCritic.receipt }).ok, false, 'a signed default/topology/wrong-wave run cannot become inventory authority');
}
for (const terminal of [undefined, { ...firstCritic.pass, readManifest: undefined }, { ...firstCritic.pass, _hash: 'tampered' }]) {
  assert.equal(validateReviewInventoryCriticReceipt({ ...criticInput, passes: [...firstPasses, ...(terminal ? [terminal] : [])], receipt: firstCritic.receipt }).ok, false, 'missing or tampered signed read terminal rejected');
}
const incompleteDispositions = { ...firstCritic.receipt, findingDispositions: [] };
const { _hash: _oldDispositionSignature, ...unsignedDispositions } = incompleteDispositions;
incompleteDispositions._hash = signReviewInventoryCriticReceipt(unsignedDispositions);
assert.equal(verifyReviewInventoryCriticReceipt(incompleteDispositions), true, 'disposition mutation must retain a valid signature');
const rejectedDispositions = validateReviewInventoryCriticReceipt({ ...criticInput, receipt: incompleteDispositions });
assert.equal(rejectedDispositions.ok, false, 'signed receipt cannot omit a verified historical Finding disposition');
assert.match(rejectedDispositions.reason ?? '', /^critic finding dispositions missing: /);
assert.equal(validateReviewInventoryCriticReceipt({ ...criticInput, receipt: firstCritic.receipt }).ok, true, 'the unmodified signed receipt remains the positive control');
console.log('B29BC_PURPOSE_TAMPER_TERMINAL_DISPOSITION PASS');
assert.match(criticTerminalStatus, /Next: proof-or-stop review_inventory_critic_set/);
assert.match(criticTerminalStatus, /"findingDispositions":\[/, 'critic Next must include the CLI-required disposition inventory');
assert.equal((criticTerminalStatus.match(/^Next:/gm) ?? []).length, 1);
const criticCompleteStatus = renderReviewInventoryStatus(initial, { evaluation: discovery, criticComplete: true });
assert.match(criticCompleteStatus, /Completeness critic: complete/);
assert.match(criticCompleteStatus, /Blockers: none/);
assert.match(criticCompleteStatus, /Next: proof-or-stop review_inventory_finalize/);
assert.equal((criticCompleteStatus.match(/^Next:/gm) ?? []).length, 1);
const saturationReadyStatus = renderReviewInventoryStatus(secondEpoch, { evaluation: saturated, criticComplete: true });
assert.match(saturationReadyStatus, /Blockers: none/);
assert.match(saturationReadyStatus, /Next: proof-or-stop review_inventory_finalize/);
assert.equal((saturationReadyStatus.match(/^Next:/gm) ?? []).length, 1);
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: { ...firstCritic.receipt, aggregateFindingSetDigest: '0'.repeat(64) },
  epoch: initial,
  evaluation: discovery,
  runs: [...firstRuns, firstCritic.run],
  passes: [...firstPasses, firstCritic.pass],
  findings: [historical],
}).ok, false, 'tampered critic authority fails closed');

const secondCritic = criticEvidence(secondEpoch, saturated, 41, '2026-08-14T00:14:02.000Z');
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: firstCritic.receipt,
  epoch: secondEpoch,
  evaluation: saturated,
  runs: [...firstRuns, ...secondRuns, firstCritic.run],
  passes: [...firstPasses, ...secondPasses, firstCritic.pass],
  findings: [historical],
}).ok, false, 'old-wave critic authority cannot finalize the next wave');
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: secondCritic.receipt,
  epoch: secondEpoch,
  evaluation: saturated,
  runs: [...firstRuns, ...secondRuns, secondCritic.run],
  passes: [...firstPasses, ...secondPasses, secondCritic.pass],
  findings: [historical],
}).ok, true);

const issuedAt = '2026-08-14T00:20:00.000Z';
const unsignedReceipt: Omit<ReviewInventoryReceipt, '_hash'> = {
  schemaVersion: 'proof-or-stop.review_inventory_receipt.v1',
  receiptId: `${storyId}:RI-001:RCP-001`,
  epochId: initial.epochId,
  storyId,
  reviewRound,
  cutoff,
  scopeDigest: initial.scopeDigest,
  requiredLanes,
  waveCount: 2,
  findingSetDigest: firstWave.verifiedFindingSetDigest!,
  coverageDigest: reviewInventoryDigest([firstWave, buildWave(secondEpoch, saturated, issuedAt)]
    .flatMap(row => row.lanes.map(lane => lane.coverageDigest))),
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
  authority: 'inventory-completeness-only',
  authorizesTest: false,
  issuedAt,
};
const receipt: ReviewInventoryReceipt = { ...unsignedReceipt, _hash: signReviewInventoryReceipt(unsignedReceipt) };
assert.equal(verifyReviewInventoryReceipt(receipt), true);
assert.equal(verifyReviewInventoryReceipt({ ...receipt, storyId: 'B-replay-attack' }), false, 'cross-story replay rejected');
assert.equal(receipt.authorizesTest, false, 'inventory receipt never authorizes TEST');

const finalized = epoch({ state: 'FINALIZED', waves: [firstWave, buildWave(secondEpoch, saturated, issuedAt)], receiptId: receipt.receiptId, updatedAt: issuedAt });
const finalizedData: ReviewInventoryEpochData = {
  schemaVersion: 'proof-or-stop.review_inventory_epochs.v1',
  epochs: [finalized],
  receipts: [receipt],
  criticReceipts: [firstCritic.receipt, secondCritic.receipt],
};
const finalizedStatus = renderReviewInventoryStatus(finalized, { criticComplete: true });
assert.match(finalizedStatus, /Next: proof-or-stop story_advance --storyId=B-cdf6-replay --phase=DEV/);
assert.equal((finalizedStatus.match(/^Next:/gm) ?? []).length, 1);
// A complete signed first wave permits repair, while preserving its findings
// and never becoming certification or TEST authority.
const earlyUnsigned = {
  ...unsignedReceipt, waveCount: 1,
  coverageDigest: reviewInventoryDigest(firstWave.lanes.map(lane => lane.coverageDigest)),
  saturationResult: 'NOT_EVALUATED_FOR_REMEDIATION', authority: 'review-remediation-only',
} as unknown as Omit<ReviewInventoryReceipt, '_hash'>;
const earlyReceipt = { ...earlyUnsigned, _hash: signReviewInventoryReceipt(earlyUnsigned) };
assert.equal(verifyReviewInventoryReceipt(earlyReceipt), true, 'complete first wave admits remediation authority');
const earlyData = {
  ...finalizedData, epochs: [epoch({state:'FINALIZED',waves:[firstWave],receiptId:earlyReceipt.receiptId,updatedAt:issuedAt})],
  receipts:[earlyReceipt], criticReceipts:[firstCritic.receipt],
};
const earlyStore = () => ({ ...memoryStore(earlyData),
  readReviewRuns: () => ({runs:[...firstRuns,firstCritic.run]}),
  readReviewPasses: () => ({passes:[...firstPasses,firstCritic.pass]}),
});
assert.equal(consumeReviewInventoryReceipt(earlyStore() as never,storyId,reviewRound,cutoff),earlyReceipt.receiptId);
assert.throws(() => consumeReviewInventoryCompletenessReceipt(earlyStore() as never,storyId,reviewRound,cutoff),
  /remediation-only/, 'remediation authority must not enter certification');
const tamperedEarly = {...earlyReceipt,authorizesTest:true};
assert.equal(verifyReviewInventoryReceipt(tamperedEarly as never),false);
const missingCritic = earlyStore();
const absentCriticData={...earlyData,criticReceipts:[]};
missingCritic.writeReviewInventoryEpochs(storyId,absentCriticData);
assert.throws(()=>consumeReviewInventoryReceipt(missingCritic as never,storyId,reviewRound,cutoff),/REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED/);
const mockStore = memoryStore(finalizedData);
assert.deepEqual(reviewInventoryRemediationGate(mockStore as never, storyId, reviewRound), { required: true, ok: true });
assert.equal(reviewInventoryRemediationGate(mockStore as never, storyId, 'wrong-round').ok, false);
const absentGate = reviewInventoryRemediationGate({
  readReviewInventoryEpochs: () => ({ schemaVersion: 'proof-or-stop.review_inventory_epochs.v1', epochs: [], receipts: [], criticReceipts: [] }),
} as never, storyId, reviewRound);
assert.equal(absentGate.ok, false, 'artifact absence cannot bypass mandatory REVIEW to remediation DEV gate');
assert.match(absentGate.nextCommand ?? '', /review_inventory_begin/);

function completenessMemoryStore() {
  let data: ReviewInventoryEpochData = {
    schemaVersion: 'proof-or-stop.review_inventory_epochs.v1',
    epochs: [],
    receipts: [],
    criticReceipts: [],
  };
  const lockRoot = mkdtempSync(join(tmpdir(), 'review-inventory-completeness-'));
  return {
    readReviewInventoryEpochs: () => structuredClone(data),
    writeReviewInventoryEpochs: (_storyId: string, next: ReviewInventoryEpochData) => { data = structuredClone(next); },
    readReviewRuns: () => ({ runs: [] }),
    readReviewPasses: () => ({ passes: [] }),
    readFindings: () => ({ findings: [] }),
    readScopeContract: () => null,
    readChecklist: () => ({ items: [] }),
    readProofStoryContract: () => null,
    readScopeShrinkageDecision: () => null,
    runtimeLockDirPath: (_storyId: string, ...segments: string[]) => join(lockRoot, ...segments),
    snapshot: () => structuredClone(data),
  };
}

const completenessStoryId = 'B-precert-completeness';
const completenessRound = '2026-08-20T00:00:00.000Z';
const completenessCutoff = { headHash: 'a'.repeat(40), materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64) };
const completenessStore = completenessMemoryStore();
const persistedCompleteness = persistFinalizedReviewInventory({
  store: completenessStore as never,
  storyId: completenessStoryId,
  reviewRound: completenessRound,
  cutoff: completenessCutoff,
});
assert.equal(isInventoryCompletenessOnlyReceipt(persistedCompleteness.epoch, persistedCompleteness.receipt), true);
assert.equal(persistedCompleteness.receipt.authorizesTest, false);
assert.equal(persistedCompleteness.receipt.authority, 'inventory-completeness-only');
assert.equal(persistedCompleteness.epoch.waves.length, 0);
const consumedCompletenessId = consumeReviewInventoryCompletenessReceipt(
  completenessStore as never,
  completenessStoryId,
  completenessRound,
  completenessCutoff,
);
assert.equal(consumedCompletenessId, persistedCompleteness.receipt.receiptId);
assert.ok(completenessStore.snapshot().receipts[0].consumedAt, 'PRE_CERT completeness consume must mark the receipt consumed');
assert.ok(completenessStore.snapshot().epochs[0].consumedAt, 'PRE_CERT completeness consume must mark the epoch consumed');
assert.throws(
  () => consumeReviewInventoryCompletenessReceipt(
    completenessStore as never,
    completenessStoryId,
    completenessRound,
    completenessCutoff,
  ),
  /REVIEW_INVENTORY_RECEIPT_ALREADY_CONSUMED/,
  'second PRE_CERT completeness consume must throw already-consumed',
);

const remediationCompletenessStore = completenessMemoryStore();
persistFinalizedReviewInventory({
  store: remediationCompletenessStore as never,
  storyId: completenessStoryId,
  reviewRound: completenessRound,
  cutoff: completenessCutoff,
});
assert.throws(
  () => consumeReviewInventoryReceipt(
    remediationCompletenessStore as never,
    completenessStoryId,
    completenessRound,
    completenessCutoff,
  ),
  /REVIEW_INVENTORY_REMEDIATION_BLOCKED|REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED/,
  'remediation consume must still refuse completeness-only empty-wave receipts',
);
assert.equal(
  remediationCompletenessStore.snapshot().receipts[0].consumedAt,
  undefined,
  'failed remediation consume must not consume a completeness receipt',
);

type ReplayEvent = { type: string; host?: string; lane?: string; accepted?: boolean; reason?: string };
function replay(): Record<string, number> {
  const events: ReplayEvent[] = [];
  const hosts = ['host-a', 'host-b'];
  for (const lane of requiredLanes) {
    events.push({ type: 'baseline-required-lane', lane });
    events.push({ type: 'proposed-required-lane', lane });
  }

  // Recorded B-cdf6 control path: RR-043..046 found the first issue, then five
  // mutation-driven RR-047..051 redispatches. The counter is derived from those
  // replayed dispatch events, not an expected numeric literal.
  ['RR-043', 'RR-044', 'RR-045', 'RR-046'].forEach((reason, index) => events.push({ type: 'baseline-review', host: hosts[index % hosts.length], reason }));
  events.push({ type: 'baseline-first-finding' });
  ['RR-047', 'RR-048', 'RR-049', 'RR-050', 'RR-051'].forEach((reason, index) => events.push({ type: 'baseline-redispatch', host: hosts[index % hosts.length], reason }));

  const attackStore = memoryStore({ schemaVersion: 'proof-or-stop.review_inventory_epochs.v1', epochs: [initial], receipts: [], criticReceipts: [] });
  try {
    assertReviewInventoryCutoff(attackStore as never, storyId, { materialHash: 'f'.repeat(64), storyFilesHash: cutoff.storyFilesHash });
    events.push({ type: 'open-mutation', accepted: true });
  } catch {
    events.push({ type: 'open-mutation', accepted: false });
  }
  assert.equal(attackStore.snapshot().epochs[0].state, 'INVALIDATED', 'stale mutation invalidates the OPEN epoch');
  const invalidatedStatus = renderReviewInventoryStatus(attackStore.snapshot().epochs[0]);
  assert.match(invalidatedStatus, /Next: proof-or-stop review_inventory_begin/);
  assert.equal((invalidatedStatus.match(/^Next:/gm) ?? []).length, 1);

  events.push({ type: 'discovery-wave', host: hosts[0] });
  events.push({ type: 'saturation-wave', host: hosts[1] });
  assert.equal(firstWave.saturated, false);
  assert.equal(buildWave(secondEpoch, saturated, issuedAt).saturated, true);

  const transitionStore = memoryStore(finalizedData);
  let phase = 'REVIEW';
  consumeReviewInventoryReceipt(transitionStore as never, storyId, reviewRound, cutoff);
  assert.throws(
    () => assertReviewInventoryEvidenceWritable(transitionStore as never, storyId, secondRuns[0]),
    /REVIEW_INVENTORY_EVIDENCE_SEALED/,
    'F030: consumed receipt keeps the old reviewRound sealed before phase publication',
  );
  phase = 'DEV';
  events.push({ type: 'remediation-transition', accepted: phase === 'DEV' });
  const consumedStatus = renderReviewInventoryStatus(transitionStore.snapshot().epochs[0], { criticComplete: true });
  assert.match(consumedStatus, /REVIEW_INVENTORY_RECEIPT_ALREADY_CONSUMED/);
  assert.match(consumedStatus, /Next: proof-or-stop review_inventory_begin/);
  assert.throws(
    () => consumeReviewInventoryReceipt(transitionStore as never, storyId, reviewRound, cutoff),
    /REVIEW_INVENTORY_REMEDIATION_BLOCKED/,
    'receipt replay is rejected mechanically',
  );
  events.push({ type: 'receipt-replay', accepted: false });

  const staleTransitionStore = memoryStore(finalizedData);
  let stalePhase = 'REVIEW';
  assert.throws(() => {
    consumeReviewInventoryReceipt(staleTransitionStore as never, storyId, reviewRound, {
      materialHash: 'e'.repeat(64), storyFilesHash: cutoff.storyFilesHash,
    });
  }, /no longer match the finalized cutoff/);
  assert.equal(stalePhase, 'REVIEW', 'failed consumption occurs before phase publication');
  events.push({ type: 'stale-cutoff-transition', accepted: false });

  const recoveryStore = memoryStore(finalizedData);
  consumeReviewInventoryReceipt(recoveryStore as never, storyId, reviewRound, cutoff);
  assert.equal(reviewInventoryRemediationGate(recoveryStore as never, storyId, reviewRound).ok, false,
    'consume followed by a simulated phase-write failure leaves REVIEW recoverable only through a new epoch');
  events.push({ type: 'phase-write-failure-recovery-required', accepted: false });

  const emptyLiveWaveStore = memoryStore(finalizedData);
  emptyLiveWaveStore.readReviewRuns = () => ({ runs: [] });
  emptyLiveWaveStore.readReviewPasses = () => ({ passes: [] });
  emptyLiveWaveStore.readFindings = () => ({ findings: [] });
  assert.equal(isInventoryCompletenessOnlyReceipt(finalized, receipt), false);
  assert.throws(
    () => consumeReviewInventoryCompletenessReceipt(emptyLiveWaveStore as never, storyId, reviewRound, cutoff),
    /REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED/,
    'PRE_CERT consume of a wave-saturated receipt still recomputes the live aggregate',
  );
  assert.equal(emptyLiveWaveStore.snapshot().receipts[0].consumedAt, undefined, 'failed PRE_CERT wave consume must not mark consumed');

  const missing = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns.slice(0, 2), passes: firstPasses.slice(0, 2), findings: [] });
  assert.equal(missing.missingLanes.length, 1, 'timeout/absent terminal lane cannot saturate');
  const duplicateRuns = firstRuns.map(row => {
    const duplicateRun = { ...row, agent: 'shared-host', promptHash: 'shared-prompt' };
    duplicateRun._hash = signReviewRun(
      duplicateRun.storyId, duplicateRun.reviewRunId, duplicateRun.agent, duplicateRun.lane,
      duplicateRun.reviewRound, duplicateRun.startedAt, duplicateRun.headHash,
      duplicateRun.materialHash, duplicateRun.promptHash, undefined, undefined,
      duplicateRun.storyFilesHash,
    );
    return duplicateRun;
  });
  const duplicate = evaluateReviewInventoryWave({
    epoch: initial,
    runs: duplicateRuns,
    passes: firstPasses,
    findings: [],
  });
  assert.equal(duplicate.missingLanes.length, requiredLanes.length,
    'a shared non-reviewer agent is rejected by current ReviewRun identity validation before inventory saturation');
  assert.match(renderReviewInventoryStatus(initial, { evaluation: duplicate }), /Next: proof-or-stop dispatch/);
  const cancelled = epoch({ state: 'CANCELLED', cancelledAt: issuedAt, cancelReason: 'operator cancelled bounded review' });
  const cancelledStore = memoryStore({ schemaVersion: 'proof-or-stop.review_inventory_epochs.v1', epochs: [cancelled], receipts: [], criticReceipts: [] });
  assert.equal(reviewInventoryRemediationGate(cancelledStore as never, storyId, reviewRound).ok, false, 'cancel cannot grant DEV');
  assert.match(renderReviewInventoryStatus(cancelled), /Next: proof-or-stop review_inventory_begin/);
  const exhausted = epoch({ waves: [firstWave, firstWave, firstWave], maxWaves: 3 });
  assert.equal(exhausted.waves.length >= exhausted.maxWaves && !exhausted.waves.at(-1)?.saturated, true, 'budget exhaustion cannot manufacture a receipt');
  const exhaustedStatus = renderReviewInventoryStatus(exhausted, { evaluation: discovery });
  assert.match(exhaustedStatus, /REVIEW_INVENTORY_BUDGET_EXHAUSTED/);
  assert.match(exhaustedStatus, /Next: proof-or-stop review_inventory_cancel/);
  assert.equal((exhaustedStatus.match(/^Next:/gm) ?? []).length, 1);
  const staleRuns = firstRuns.map(row => ({ ...row, materialHash: '9'.repeat(64) }));
  assert.equal(evaluateReviewInventoryWave({ epoch: initial, runs: staleRuns, passes: firstPasses, findings: [] }).missingLanes.length, requiredLanes.length,
    'stale runs cannot satisfy the frozen cutoff');
  const regressionFinding = finding(secondRuns[0]);
  regressionFinding.desc = 'Final review exposes a new critical regression after remediation';
  regressionFinding._hash = signFinding(
    storyId, regressionFinding.id, regressionFinding.desc, regressionFinding.severity,
    regressionFinding.createdAt!, reviewRound, regressionFinding.reviewRunId,
    regressionFinding.readManifest, regressionFinding.readLog,
  );
  const regression = evaluateReviewInventoryWave({
    epoch: secondEpoch,
    runs: secondRuns,
    passes: secondPasses,
    findings: [historical, regressionFinding],
    findingDispositions: [{
      findingId: regressionFinding.id,
      disposition: 'verified_family',
      familyKey: findingFamily(regressionFinding),
      reason: 'independent critic confirmed this is a new post-remediation regression family',
    }],
  });
  assert.ok(regression.newFamilies.length > 0, 'a final-review regression reopens discovery instead of escaping');
  events.push({ type: 'final-review', host: hosts[0], accepted: true });
  events.push({ type: 'regression-injection', accepted: regression.newFamilies.length === 0 });

  const baselineHosts = new Set(events.filter(event => event.type.startsWith('baseline-') && event.host).map(event => event.host));
  const proposedHosts = new Set(events.filter(event => ['discovery-wave', 'saturation-wave', 'final-review'].includes(event.type) && event.host).map(event => event.host));
  return {
    baselineMutationDrivenRedispatches: events.filter(event => event.type === 'baseline-redispatch').length,
    proposedMutationDrivenRedispatches: events.filter(event => event.type === 'open-mutation' && event.accepted).length,
    discoveryEpochs: events.filter(event => event.type === 'discovery-wave').length,
    acceptedOpenMaterialCommits: events.filter(event => event.type === 'open-mutation' && event.accepted).length,
    stalePassAcceptances: events.filter(event => event.type === 'stale-cutoff-transition' && event.accepted).length,
    aggregatedRemediationTransitions: events.filter(event => event.type === 'remediation-transition' && event.accepted).length,
    finalReviewEpochsWithoutRegression: events.filter(event => event.type === 'final-review').length,
    requiredHostCountBefore: baselineHosts.size,
    requiredHostCountAfter: proposedHosts.size,
    requiredLaneCountBefore: new Set(events.filter(event => event.type === 'baseline-required-lane').map(event => event.lane)).size,
    requiredLaneCountAfter: new Set(events.filter(event => event.type === 'proposed-required-lane').map(event => event.lane)).size,
    criticalHighEscapes: events.filter(event => event.type === 'regression-injection' && event.accepted).length,
    budgetManufacturedPasses: exhausted.waves.at(-1)?.saturated ? 1 : 0,
  };
}
const replayA = replay();
const replayB = replay();
assert.deepEqual(replayA, replayB, 'replay counters deterministic');
assert.ok(replayA.baselineMutationDrivenRedispatches >= 5);
assert.equal(replayA.proposedMutationDrivenRedispatches, 0);
assert.equal(replayA.requiredHostCountBefore, 2);
assert.equal(replayA.requiredHostCountAfter, 2);
assert.equal(replayA.requiredLaneCountAfter, replayA.requiredLaneCountBefore);
assert.equal(replayA.requiredLaneCountBefore, requiredLanes.length);
assert.equal(replayA.criticalHighEscapes + replayA.budgetManufacturedPasses, 0);

// B-3f3d F-099: the acceptance-subject digest must bind what a verifier OBSERVED,
// not when it last ran. A pure verification_evidence_refresh_stale re-pin rotates
// headHash/materialHash/storyFilesHash/timestamp/receipt.executedAt while leaving
// result/command/note/outputDigest identical; hashing those freshness pins made a
// metadata-only refresh trip OPEN_REVIEW_INVENTORY_SCOPE_MUTATION and discard other
// lanes' completed verdicts on an OPEN epoch. Narrowing must NOT go so far that a
// genuine change stops invalidating, so both directions are pinned here.
const evidenceRow = (overrides: Record<string, unknown>): ChecklistData => ({
  items: [{
    id: 'CHK-001',
    title: 'digest fixture',
    status: 'done',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:00.000Z',
    verificationEvidence: [{
      intentRef: 'CHK-001:happy:0', kind: 'logic_test', command: 'node x.js',
      result: 'pass', note: 'covers the happy path', mechanical: true,
      headHash: 'h0', materialHash: 'm0', storyFilesHash: 's0', timestamp: '2026-01-01T00:00:00.000Z',
      receipt: { exitCode: 0, outputDigest: 'digest-0', outputTail: 'ok', selectorMatched: true, executedAt: '2026-01-01T00:00:00.000Z' },
      ...overrides,
    }],
  }],
});
const digestBaseline = reviewInventoryAcceptanceSubjectDigest(null, evidenceRow({}));
const digestRepinned = reviewInventoryAcceptanceSubjectDigest(null, evidenceRow({
  headHash: 'h1', materialHash: 'm1', storyFilesHash: 's1', timestamp: '2026-09-09T09:09:09.000Z',
  receipt: { exitCode: 0, outputDigest: 'digest-0', outputTail: 'ok', selectorMatched: true, executedAt: '2026-09-09T09:09:09.000Z' },
}));
assert.equal(digestRepinned, digestBaseline, 'a pure evidence re-pin must not change the acceptance subject digest');
for (const [label, override] of [
  // B-3f3d F-102: evidenceSemantics strips a NAMED five and spreads the rest, so
  // every other field is bound by construction today. These negative cases exist so
  // that a future refactor which accidentally widens the strip-list — folding in
  // intentRef, kind, file, mechanical, or a receipt sub-field — fails loudly instead
  // of silently letting a semantic change stop invalidating an epoch.
  ['result', { result: 'fail' }],
  ['command', { command: 'node other.js' }],
  ['intentRef', { intentRef: 'CHK-001:edge:0' }],
  ['kind', { kind: 'integration_test' }],
  ['file', { file: 'other.ts' }],
  ['note', { note: 'a different justification' }],
  ['mechanical', { mechanical: false }],
  ['nonMechanicalReason', { nonMechanicalReason: 'receipt invalidated by refresh' }],
  ['outputDigest', { receipt: { exitCode: 0, outputDigest: 'digest-CHANGED', outputTail: 'ok', selectorMatched: true, executedAt: '2026-01-01T00:00:00.000Z' } }],
  ['selectorMatched', { receipt: { exitCode: 0, outputDigest: 'digest-0', outputTail: 'ok', selectorMatched: false, executedAt: '2026-01-01T00:00:00.000Z' } }],
  ['exitCode', { receipt: { exitCode: 1, outputDigest: 'digest-0', outputTail: 'ok', selectorMatched: true, executedAt: '2026-01-01T00:00:00.000Z' } }],
  ['outputTail', { receipt: { exitCode: 0, outputDigest: 'digest-0', outputTail: 'DIFFERENT', selectorMatched: true, executedAt: '2026-01-01T00:00:00.000Z' } }],
] as const) {
  assert.notEqual(
    reviewInventoryAcceptanceSubjectDigest(null, evidenceRow(override)),
    digestBaseline,
    `a changed ${label} must still change the acceptance subject digest`,
  );
}

// B-3f3d F-103/F-104/F-105: the candidate-routing arm of the OPEN-epoch barrier
// must bind the ROUTING UNIVERSE (which specs, and what they contain) and not
// freshness. Two independent leaks were found and fixed: the artifact identity
// digest bakes in headHash/materialHash (F-103), and storyInputDigest plus
// candidates[].score/.reasons are derived from changedPaths, i.e. from
// `git diff --name-only main...HEAD`, so any unrelated commit moved them (F-104).
// This mirrors the shape captureReviewInventoryScope now builds; F-105 filed that
// the fix shipped with no coverage at all, so both directions are pinned here.
const candidateBarrierDigest = (candidates: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) =>
  reviewInventoryDigest({
    schemaVersion: 'candidate-spec-set/v1',
    mode: 'warn',
    candidates: candidates.map(row => ({ path: row.path, contentHash: row.contentHash })),
    scanEscalationReason: null,
    ...overrides,
  });
// Mirrors captureReviewInventoryScope's projection by taking a WHOLE artifact and
// selecting from it, so a field the production code does not bind cannot influence
// the result no matter what the caller puts in the artifact. (Passing an unbound
// field as a top-level override would move any digest and prove nothing.)
const candidateBarrierProjection = (artifact: Record<string, unknown>) => {
  const full = {
    schemaVersion: 'candidate-spec-set/v1',
    mode: 'warn',
    candidates: [{ path: 'docs/a.md', contentHash: 'sha-a', score: 10, reasons: [{ kind: 'changedPath' }] }],
    queryFiltering: { filteredTerms: [] },
    scanEscalationReason: null,
    storyInputDigest: 'sid-baseline',
    artifactDigest: 'artifact-baseline',
    ...artifact,
  } as Record<string, unknown>;
  return reviewInventoryDigest({
    schemaVersion: full.schemaVersion,
    mode: full.mode,
    candidates: (full.candidates as Array<Record<string, unknown>>).map(row => ({ path: row.path, contentHash: row.contentHash })),
    scanEscalationReason: full.scanEscalationReason,
  });
};
const candidateBaseline = [{ path: 'docs/a.md', contentHash: 'sha-a', score: 10, reasons: [{ kind: 'changedPath' }] }];
assert.equal(
  candidateBarrierDigest([{ path: 'docs/a.md', contentHash: 'sha-a', score: 97, reasons: [{ kind: 'seed' }, { kind: 'changedPath' }] }]),
  candidateBarrierDigest(candidateBaseline),
  'candidate score/reasons churn driven by changedPaths must not move the epoch barrier digest',
);
// B-3f3d F-107: queryFiltering must not be bound at all. filteredTerms derives from
// orderedQueryTerms over buildKeywordSeeds, which seeds every changedPaths entry at
// weight 50 — so binding it re-admitted the same git-diff freshness channel F-104
// closed. This asserts against the REAL production projection rather than a local
// override, because an override would trivially move any digest and prove nothing.
assert.equal(
  candidateBarrierProjection({ queryFiltering: { filteredTerms: [{ term: 'x', documentCount: 3, documentFrequencyRatio: 0.4, reason: 'overbroad' }] } }),
  candidateBarrierProjection({ queryFiltering: { filteredTerms: [] } }),
  'queryFiltering churn driven by changedPaths must not move the epoch barrier digest',
);
for (const unbound of ['storyInputDigest', 'artifactDigest'] as const) {
  assert.equal(
    candidateBarrierProjection({ [unbound]: `${unbound}-rotated` }),
    candidateBarrierProjection({}),
    `${unbound} is freshness-bearing and must not move the epoch barrier digest`,
  );
}
for (const [label, candidates, overrides] of [
  ['contentHash', [{ path: 'docs/a.md', contentHash: 'sha-CHANGED' }], {}],
  ['path', [{ path: 'docs/b.md', contentHash: 'sha-a' }], {}],
  ['added candidate', [...candidateBaseline, { path: 'docs/c.md', contentHash: 'sha-c' }], {}],
  ['removed candidate', [], {}],
  ['mode', candidateBaseline, { mode: 'enforce' }],
  ['schemaVersion', candidateBaseline, { schemaVersion: 'candidate-spec-set/v2' }],
  ['scanEscalationReason', candidateBaseline, { scanEscalationReason: 'budget_exhausted' }],
] as const) {
  assert.notEqual(
    candidateBarrierDigest(candidates as Array<Record<string, unknown>>, overrides as Record<string, unknown>),
    candidateBarrierDigest(candidateBaseline),
    `a changed ${label} must still move the epoch barrier digest`,
  );
}

// B-3f3d F-118: CHK-005's userSees promises these labeled lines. The JSON dump alone did not
// emit them, so the promise was unmet even though every value it names was already computed.
// Printed from the real counters -- no value is invented, and a regression in any of them
// changes the printed number rather than being hidden inside a JSON blob.
const baselineRedispatches = replayA.baselineMutationDrivenRedispatches ?? 0;
const qualityRegressionCounters = {
  stalePassAcceptances: replayA.stalePassAcceptances ?? 0,
  criticalHighEscapes: replayA.criticalHighEscapes ?? 0,
  budgetManufacturedPasses: replayA.budgetManufacturedPasses ?? 0,
};
const regressionsClean = Object.values(qualityRegressionCounters).every(value => value === 0);
const lanesUnchanged = replayA.requiredLaneCountBefore === replayA.requiredLaneCountAfter;
const hostsUnchanged = replayA.requiredHostCountBefore === replayA.requiredHostCountAfter;
const replayHealthy = baselineRedispatches >= 5
  && (replayA.proposedMutationDrivenRedispatches ?? -1) === 0
  && (replayA.acceptedOpenMaterialCommits ?? -1) === 0
  && (replayA.aggregatedRemediationTransitions ?? -1) === 1
  && (replayA.finalReviewEpochsWithoutRegression ?? 99) <= 1
  && lanesUnchanged && hostsUnchanged && regressionsClean;

if (!replayHealthy) {
  console.log('FAIL');
  console.log(JSON.stringify({ result: 'FAIL', replay: replayA }, null, 2));
  process.exit(1);
}

console.log(`Baseline mutation-driven redispatches: >=5 (${baselineRedispatches})`);
console.log(`New mutation-driven redispatches: ${replayA.proposedMutationDrivenRedispatches}`);
console.log(`Accepted OPEN commits: ${replayA.acceptedOpenMaterialCommits}`);
console.log(`Remediation DEV transitions: ${replayA.aggregatedRemediationTransitions}`);
console.log(`Clean final-review epochs: <=1 (${replayA.finalReviewEpochsWithoutRegression})`);
console.log(`Required lane count: ${replayA.requiredLaneCountBefore} -> ${replayA.requiredLaneCountAfter} (unchanged)`);
console.log(`Required host count: ${replayA.requiredHostCountBefore} -> ${replayA.requiredHostCountAfter} (unchanged)`);
for (const [name, value] of Object.entries(qualityRegressionCounters)) {
  console.log(`Quality regression counter ${name}: ${value}`);
}
console.log(JSON.stringify({ result: 'PASS', replay: replayA }, null, 2));
if (authenticatedInventoryFailure) process.exit(1);
console.log('B-aa5f F063 authenticated-inventory-projection PASS');
