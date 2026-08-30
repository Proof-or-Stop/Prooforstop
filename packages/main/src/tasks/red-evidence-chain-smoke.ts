#!/usr/bin/env node
/**
 * red-evidence-chain-smoke (W2c / B-506e) — the convergence anchor for the v2
 * record union, the chain plane, the operation key, the append pipeline, and the
 * two owner-gated chain-control commands.
 *
 * Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §1.10, §3.1-
 * §3.7, §4.1, §1.1.3. Covers:
 *   - the v2 record union (per-operation field sets + §0.4 nullability/omission);
 *   - the enforce-gate BYTE-IDENTICAL v1 guard (RED signal A) — a v2 record never
 *     changes the v1 verdict and never crashes the live gate;
 *   - chain head resolution (both §3.2 conjuncts) + the three §3.3 integrity
 *     checks with DISTINCT reason ids + the closed transition table with
 *     transitive, cycle-safe effective-head resolution;
 *   - operation-key preimages + normalizedReason + deterministic id + dedupe /
 *     replay ordering + scoped dedupe (deliberate replacement not swallowed);
 *   - a genuine TWO-PROCESS mkdir-claim race (RED signal B) → exactly one head;
 *   - the FULL rejection matrix (RED signal C);
 *   - quarantine / recover + the §1.1.3 binding-freeze (synthetic v2 red-assert).
 *
 * Assurance scope (§0.6 practical tier): handler-enforced append consistency
 * through the registered surfaces; NOT a defense against a hostile local agent
 * that rewrites the store and recomputes every digest offline (Tier-C).
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canon, canonDigest } from '../core/red-evidence/canon.js';
import {
  RED_EVIDENCE_V2_SCHEMA_VERSION,
  RED_EVIDENCE_FILE_SCHEMA_VERSION,
  isRedEvidenceV2,
  isControlRecordV2,
  classifyRedRecordSchema,
  computeRecordDigest,
  computeSpecDigest,
  recordDigestMatches,
  recordCanonicalBytes,
  first12hex,
  type RedEvidenceRecordV2,
  type RedAssertRecordV2,
} from '../core/red-evidence/record-v2.js';
import {
  controlOperationKey,
  redAssertOperationKey,
  greenConfirmOperationKey,
  normalizeReason,
  deriveRecordId,
} from '../core/red-evidence/operation-key.js';
import {
  partitionChain,
  resolveChainHead,
  checkChainIntegrity,
  effectiveHeadOperation,
  isTransitionLegal,
  isRetiredByQuarantine,
  resolveGoverningRedAssert,
  checkGreenConfirmTarget,
  REASON_SEQ_INVALID,
  REASON_PRIOR_DIGEST_MISMATCH,
  REASON_CHAIN_FORK,
  REASON_ILLEGAL_TRANSITION,
} from '../core/red-evidence/chain.js';
import { appendControlRecord, RedEvidenceChainError, REASON_STORE_CORRUPTION } from '../core/red-evidence/append.js';
import { StoryStore } from '../core/store.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import { proofStoryDiagnosticInput } from '../handlers/phase-gates.js';
import { evaluateProofStoryDiagnostics, resolveExpectedRedTargets, computeMilestoneLedgerHash } from '../core/proofstory.js';
import type { StoryInfo, MilestoneLedgerData, RedEvidenceData, RedEvidenceRecord } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const roots: string[] = [];
function freshRoot(label: string): string {
  const r = mkdtempSync(join(tmpdir(), `red-w2c-${label}-`));
  roots.push(r);
  return r;
}

const NOW = '2026-07-25T00:00:00.000Z';

/** Build a well-formed synthetic v2 red-assert record (WRITTEN by W2d in prod). */
function synthRedAssert(opts: {
  storyId: string;
  acceptanceTargetRef: string;
  seq: number;
  priorRecordDigest: string | null;
  supersedes: string | null;
  baselineHeadHash?: string;
  baselineMaterialHash?: string;
}): RedAssertRecordV2 {
  const greenRelation = { targetRef: opts.acceptanceTargetRef, relation: 'same_acceptance' as const };
  const specDigest = computeSpecDigest(opts.acceptanceTargetRef, greenRelation);
  const operationKey = redAssertOperationKey({
    storyId: opts.storyId,
    acceptanceTargetRef: opts.acceptanceTargetRef,
    baselineHeadHash: opts.baselineHeadHash ?? 'head-base',
    baselineMaterialHash: opts.baselineMaterialHash ?? 'mat-base',
    specDigest,
    assertionDigest: canonDigest({ synthetic: 'assertion', target: opts.acceptanceTargetRef }),
    policyDigest: canonDigest({ synthetic: 'policy' }),
  });
  const draft = {
    id: deriveRecordId('red-assert', operationKey, opts.seq),
    schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION,
    operation: 'red-assert' as const,
    seq: opts.seq,
    priorRecordDigest: opts.priorRecordDigest,
    supersedes: opts.supersedes,
    storyId: opts.storyId,
    acceptanceTargetRef: opts.acceptanceTargetRef,
    trigger: 'synthetic red-assert for W2c chain exercise',
    observedFailure: 'synthetic observed failure',
    baselineHeadHash: opts.baselineHeadHash ?? 'head-base',
    baselineMaterialHash: opts.baselineMaterialHash ?? 'mat-base',
    greenRelation,
    assertion: { synthetic: 'assertion' },
    policySnapshot: { synthetic: 'policy' },
    specDigest,
    operationKey,
    runReceipt: { synthetic: 'receipt' },
    createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft as unknown as Record<string, unknown>) } as RedAssertRecordV2;
}

/** Create a story whose text triggers red_evidence_required + an M1 ledger target. */
function seedRedStory(root: string, storyId: string): StoryStore {
  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId, name: 'w2c-rep', title: 'W2c representative bug',
    description: 'Fix an authentication session security regression (behavior change).',
    type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
  };
  store.writeStory(storyId, story);
  const ledgerMilestones = [{
    id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
    requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned' as const,
  }];
  const ledger: MilestoneLedgerData = {
    schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
    ledgerHash: computeMilestoneLedgerHash(ledgerMilestones),
    milestones: ledgerMilestones, createdAt: NOW, updatedAt: NOW,
  };
  store.writeMilestoneLedger(storyId, ledger);
  return store;
}

function writeRecords(store: StoryStore, storyId: string, records: (RedEvidenceRecord | RedEvidenceRecordV2)[]): void {
  const data: RedEvidenceData = {
    schemaVersion: RED_EVIDENCE_FILE_SCHEMA_VERSION, storyId, records, createdAt: NOW, updatedAt: NOW,
  };
  store.writeRedEvidence(storyId, data);
}

try {
  // ════════════════════════════════════════════════════════════════════════
  // 1. v2 record union — per-operation field sets + §0.4 nullability/omission
  //    (CHK-001)
  // ════════════════════════════════════════════════════════════════════════
  {
    const ra = synthRedAssert({ storyId: 'B-u', acceptanceTargetRef: 'AB-001', seq: 1, priorRecordDigest: null, supersedes: null });
    assert.ok(isRedEvidenceV2(ra), 'synthetic red-assert is a v2 record');
    assert.equal(ra.specDigest, computeSpecDigest('AB-001', { targetRef: 'AB-001', relation: 'same_acceptance' }),
      'specDigest = CANON({acceptanceTargetRef, greenRelation:{targetRef, relation}})');
    assert.ok(recordDigestMatches(ra), 'red-assert recordDigest recomputes from its own bytes');
    // chain-founding record: priorRecordDigest/supersedes carry JSON null (present, not omitted, not "").
    assert.equal(ra.priorRecordDigest, null);
    assert.equal(ra.supersedes, null);
    assert.ok(JSON.stringify(ra).includes('"priorRecordDigest":null'), 'null chain field is PRESENT (not omitted)');

    // A quarantine record carries ONLY the control field set (§1.10).
    const opKey = controlOperationKey({ operation: 'quarantine', storyId: 'B-u', acceptanceTargetRef: 'AB-001', recoversRecordId: ra.id, referencedRecordDigest: ra.recordDigest, reason: 'bad' });
    const qDraft = {
      id: deriveRecordId('quarantine', opKey, 2),
      schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'quarantine' as const,
      seq: 2, priorRecordDigest: ra.recordDigest, supersedes: ra.id,
      storyId: 'B-u', acceptanceTargetRef: 'AB-001',
      recoversRecordId: ra.id, referencedRecordDigest: ra.recordDigest, linkKind: 'quarantines' as const,
      reason: 'bad', approvedBy: 'proof-or-stop-implementer@sess-x', operationKey: opKey, createdAt: NOW,
    };
    const q = { ...qDraft, recordDigest: computeRecordDigest(qDraft as unknown as Record<string, unknown>) } as RedEvidenceRecordV2;
    assert.ok(isControlRecordV2(q), 'quarantine is a control record');
    for (const omitted of ['observedFailure', 'baselineHeadHash', 'baselineMaterialHash', 'greenRelation', 'specDigest', 'assertion', 'policySnapshot', 'runReceipt']) {
      assert.ok(!(omitted in q), `quarantine record OMITS ${omitted} (§0.4 field-set omission)`);
    }
    for (const present of ['recoversRecordId', 'referencedRecordDigest', 'linkKind', 'reason', 'approvedBy', 'operationKey']) {
      assert.ok(present in q, `quarantine record carries ${present}`);
    }

    // A green-confirm record (CHK-001:edge:0) — a SYNTHETIC hand-built
    // GreenConfirmRecordV2 draft (the green-confirm WRITER is W2e; the same
    // technique used for the quarantine draft above, which also has no
    // story-owned writer). It carries confirms*/redBaseline* and OMITS
    // assertion/policySnapshot of ITS OWN: the confirmed assertion is reachable
    // via confirmsRecordId and pinned by confirmsAssertionDigest (§1.10).
    const gcKey = greenConfirmOperationKey({
      storyId: 'B-u', acceptanceTargetRef: 'AB-001', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat',
      confirmsRecordDigest: ra.recordDigest, confirmsAssertionDigest: 'sha256:assertion', specDigest: ra.specDigest,
    });
    const gcDraft = {
      id: deriveRecordId('green-confirm', gcKey, 2),
      schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'green-confirm' as const,
      seq: 2, priorRecordDigest: ra.recordDigest, supersedes: ra.id,
      storyId: 'B-u', acceptanceTargetRef: 'AB-001',
      confirmsRecordId: ra.id, confirmsRecordDigest: ra.recordDigest, confirmsAssertionDigest: 'sha256:assertion',
      redBaselineHeadHash: 'head-base', redBaselineMaterialHash: 'mat-base',
      greenHeadHash: 'green-head', greenMaterialHash: 'green-mat',
      greenRelation: { targetRef: 'AB-001', relation: 'same_acceptance' as const },
      specDigest: ra.specDigest, runReceipt: {}, operationKey: gcKey, createdAt: NOW,
    };
    const gc = { ...gcDraft, recordDigest: computeRecordDigest(gcDraft as unknown as Record<string, unknown>) } as RedEvidenceRecordV2;
    assert.ok(isRedEvidenceV2(gc) && gc.operation === 'green-confirm', 'synthetic green-confirm is a v2 record');
    for (const present of ['confirmsRecordId', 'confirmsRecordDigest', 'confirmsAssertionDigest', 'redBaselineHeadHash', 'redBaselineMaterialHash']) {
      assert.ok(present in gc, `green-confirm record carries ${present} (§1.10)`);
    }
    for (const omitted of ['assertion', 'policySnapshot']) {
      assert.ok(!(omitted in gc), `green-confirm record OMITS ${omitted} of its own (§1.10 — confirmed assertion reached via confirms*)`);
    }
    assert.ok(recordDigestMatches(gc), 'green-confirm recordDigest recomputes from its own bytes');

    // classifyRedRecordSchema: v1 (no version), v2, and an unknown version FAILS CLOSED.
    assert.equal(classifyRedRecordSchema({ id: 'RED-1', observedFailure: 'x' }), 'v1');
    assert.equal(classifyRedRecordSchema(ra), 'v2');
    assert.throws(() => classifyRedRecordSchema({ schemaVersion: 'proofstory.red_evidence.v3' }),
      /unknown per-record schemaVersion/, 'an unknown schemaVersion is rejected, never silently accepted');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. enforce-gate BYTE-IDENTICAL v1 guard (RED signal A, CHK-002 + CHK-003)
  // ════════════════════════════════════════════════════════════════════════
  {
    const root = freshRoot('guard');
    const storyId = 'B-guard';
    const store = seedRedStory(root, storyId);

    // A satisfying v1 record so the v1 verdict is well-defined and non-trivial.
    const v1: RedEvidenceRecord = {
      id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
      baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
      failingCommand: 'npm test', observedFailure: 'assertion failed',
      greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
      createdAt: NOW,
    };
    writeRecords(store, storyId, [v1]);
    const before = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);

    // Add a v2 quarantine record (no observedFailure). On the pre-fix tree this
    // THROWS at record.observedFailure.trim(); after the guard the diagnostic is
    // byte-identical.
    //
    // ORDERING IS LOAD-BEARING: redEvidenceSatisfied iterates the records with
    // Array.prototype.some(), which SHORT-CIRCUITS on the first satisfying
    // record. A v2 record stored AFTER the satisfying v1 record is never handed
    // to redEvidenceRecordSatisfied, so asserting on that arrangement proves
    // nothing — it does not throw even on the pre-fix tree (verified against a
    // dist built from 8727b2db83). The v2 record is therefore stored FIRST.
    const ra = synthRedAssert({ storyId, acceptanceTargetRef: 'M1', seq: 1, priorRecordDigest: null, supersedes: null });
    const opKey = controlOperationKey({ operation: 'quarantine', storyId, acceptanceTargetRef: 'M1', recoversRecordId: ra.id, referencedRecordDigest: ra.recordDigest, reason: 'r' });
    const qDraft = {
      id: deriveRecordId('quarantine', opKey, 2), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'quarantine' as const,
      seq: 2, priorRecordDigest: ra.recordDigest, supersedes: ra.id, storyId, acceptanceTargetRef: 'M1',
      recoversRecordId: ra.id, referencedRecordDigest: ra.recordDigest, linkKind: 'quarantines' as const,
      reason: 'r', approvedBy: 'a@s', operationKey: opKey, createdAt: NOW,
    };
    const q = { ...qDraft, recordDigest: computeRecordDigest(qDraft as unknown as Record<string, unknown>) } as RedEvidenceRecordV2;
    writeRecords(store, storyId, [q, v1]);
    let after = '';
    assert.doesNotThrow(() => {
      after = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);
    }, 'the live gate MUST NOT throw on a v2 quarantine record (no observedFailure) evaluated BEFORE any satisfying v1 record');
    assert.equal(after, before, 'the v1 gate verdict is BYTE-IDENTICAL with a v2 record added (v2 ignored)');

    // MID-ARRAY: the leading record is a GENUINE v1 record with a non-empty
    // observedFailure but a foreign acceptanceTargetRef, so the v1 predicate
    // returns false for it and some() CANNOT short-circuit — the v2 record that
    // follows is really evaluated (pre-fix: TypeError), and the trailing v1
    // record keeps the verdict well-defined. Not a vacuous companion.
    writeRecords(store, storyId, [{ id: 'RED-v1-unsat', trigger: 'unrelated', acceptanceTargetRef: 'M-not-a-declared-target', baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat', failingCommand: 'npm test', observedFailure: 'a different failure', greenRelation: { targetRef: 'M-not-a-declared-target', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' }, createdAt: NOW }, q, v1]);
    let afterMid = '';
    assert.doesNotThrow(() => { afterMid = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence); },
      'the live gate MUST NOT throw on a v2 quarantine record placed MID-ARRAY behind a NON-satisfying v1 record (some() cannot short-circuit, so the v2 record IS evaluated)');
    assert.equal(afterMid, before, 'the v1 gate verdict is BYTE-IDENTICAL with the v2 record mid-array: it is skipped and the verdict still comes from the trailing satisfying v1 record');

    // v2-only store: missingRedEvidence fires (no v1 satisfier), no crash.
    writeRecords(store, storyId, [ra, q]);
    const v2Only = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence;
    assert.ok(v2Only.length > 0, 'a v2-only store has no v1 satisfier → missing_red_evidence fires');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. chain head (both conjuncts) + three integrity checks (CHK-004)
  // ════════════════════════════════════════════════════════════════════════
  {
    const ra1 = synthRedAssert({ storyId: 'B-c', acceptanceTargetRef: 'AB-001', seq: 1, priorRecordDigest: null, supersedes: null });
    // Single-record chain: head is that record; both conjuncts hold.
    assert.equal(resolveChainHead([ra1])?.id, ra1.id, 'single-record head');
    // Empty chain: founding record passes all three checks.
    assert.ok(checkChainIntegrity([], null, { seq: 1, priorRecordDigest: null }).ok, 'founding record passes');
    // Well-formed successor passes.
    const ok = checkChainIntegrity([ra1], ra1, { seq: 2, priorRecordDigest: ra1.recordDigest });
    assert.ok(ok.ok, 'monotonic + linked + no-fork successor passes');
    // Seq gap → REASON_SEQ_INVALID.
    assert.equal(checkChainIntegrity([ra1], ra1, { seq: 3, priorRecordDigest: ra1.recordDigest }).reasonId, REASON_SEQ_INVALID);
    // Seq reuse → REASON_SEQ_INVALID.
    assert.equal(checkChainIntegrity([ra1], ra1, { seq: 1, priorRecordDigest: ra1.recordDigest }).reasonId, REASON_SEQ_INVALID);
    // Prior-digest mismatch → REASON_PRIOR_DIGEST_MISMATCH (distinct from fork).
    const mism = checkChainIntegrity([ra1], ra1, { seq: 2, priorRecordDigest: 'sha256:wrong' });
    assert.equal(mism.reasonId, REASON_PRIOR_DIGEST_MISMATCH);
    // Fork: a second record already consumed the prior digest → REASON_CHAIN_FORK,
    // DISTINCT from the prior-digest-mismatch reason id.
    const child = synthRedAssert({ storyId: 'B-c', acceptanceTargetRef: 'AB-001', seq: 2, priorRecordDigest: ra1.recordDigest, supersedes: ra1.id });
    const fork = checkChainIntegrity([ra1, child], ra1, { seq: 2, priorRecordDigest: ra1.recordDigest });
    assert.equal(fork.reasonId, REASON_CHAIN_FORK, 'fork rejection is its own detector');
    assert.notEqual(REASON_CHAIN_FORK, REASON_PRIOR_DIGEST_MISMATCH, 'fork and prior-mismatch reason ids differ');

    // Partitioning: two targets in the same store are independent chains.
    const ab2 = synthRedAssert({ storyId: 'B-c', acceptanceTargetRef: 'AB-002', seq: 1, priorRecordDigest: null, supersedes: null });
    const all = [ra1, child, ab2];
    assert.equal(partitionChain(all, 'B-c', 'AB-001').length, 2);
    assert.equal(partitionChain(all, 'B-c', 'AB-002').length, 1);
    assert.equal(resolveChainHead(partitionChain(all, 'B-c', 'AB-002'))?.id, ab2.id, 'AB-002 head unaffected by AB-001');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. closed transition table + transitive, cycle-safe effective head (CHK-005)
  // ════════════════════════════════════════════════════════════════════════
  {
    assert.ok(isTransitionLegal('empty', 'red-assert'));
    for (const bad of ['green-confirm', 'quarantine', 'recover'] as const) {
      assert.ok(!isTransitionLegal('empty', bad), `empty admits ONLY red-assert (not ${bad})`);
    }
    assert.ok(isTransitionLegal('red-assert', 'green-confirm') && isTransitionLegal('red-assert', 'red-assert') && isTransitionLegal('red-assert', 'quarantine'));
    assert.ok(!isTransitionLegal('red-assert', 'recover'), 'recover is illegal after red-assert');
    assert.ok(isTransitionLegal('green-confirm', 'red-assert') && isTransitionLegal('green-confirm', 'green-confirm') && isTransitionLegal('green-confirm', 'quarantine'));
    assert.ok(isTransitionLegal('quarantine', 'recover') && isTransitionLegal('quarantine', 'red-assert'));
    assert.ok(!isTransitionLegal('quarantine', 'green-confirm'), 'green-confirm cannot follow a quarantine');

    // Effective head: red-assert → quarantine → recover collapses to red-assert.
    const ra = synthRedAssert({ storyId: 'B-e', acceptanceTargetRef: 'AB-001', seq: 1, priorRecordDigest: null, supersedes: null });
    const q = makeControl('quarantine', 'B-e', 'AB-001', 2, ra.recordDigest, ra.id, ra.id, ra.recordDigest, 'first');
    const r = makeControl('recover', 'B-e', 'AB-001', 3, q.recordDigest, q.id, q.id, q.recordDigest, 'undo');
    assert.equal(effectiveHeadOperation([ra, q, r], r), 'red-assert', 'recover head resolves transitively to red-assert');
    // Two levels of recover.
    const q2 = makeControl('quarantine', 'B-e', 'AB-001', 4, r.recordDigest, r.id, r.id, r.recordDigest, 'second');
    const r2 = makeControl('recover', 'B-e', 'AB-001', 5, q2.recordDigest, q2.id, q2.id, q2.recordDigest, 'undo2');
    assert.equal(effectiveHeadOperation([ra, q, r, q2, r2], r2), 'red-assert', 'two transitive recover levels');

    // CHK-005:edge:2 — a green-confirm candidate is ADMITTED iff its
    // confirmsRecordId names the chain's CURRENT governing red-assert; a
    // foreign/stale target is REJECTED with the transition-table reason,
    // REGARDLESS of chain ordering. This exercises the declared table branch
    // directly (the green-confirm WRITER is W2e) via checkGreenConfirmTarget over
    // a synthetic in-memory records[] fixture — no green-confirm command needed.
    // `raOther` is a genuine but NON-governing red-assert (a different target).
    const raOther = synthRedAssert({ storyId: 'B-e', acceptanceTargetRef: 'AB-OTHER', seq: 1, priorRecordDigest: null, supersedes: null });
    // (a) simplest chain: the effective head IS the governing red-assert.
    assert.ok(checkGreenConfirmTarget([ra], ra, { confirmsRecordId: ra.id }).ok,
      'green-confirm confirming the governing red-assert is ADMITTED');
    const foreignSimple = checkGreenConfirmTarget([ra], ra, { confirmsRecordId: raOther.id });
    assert.equal(foreignSimple.ok, false, 'a green-confirm confirming a foreign red-assert is REJECTED');
    assert.equal(foreignSimple.reasonId, REASON_ILLEGAL_TRANSITION, 'the rejection carries the transition-table reason id (REASON_ILLEGAL_TRANSITION)');
    // (b) regardless of ordering: red-assert -> quarantine -> recover, whose
    // effective head resolves TRANSITIVELY back to the governing red-assert.
    assert.equal(resolveGoverningRedAssert([ra, q, r], r)?.id, ra.id, 'governing red-assert resolves transitively through recover');
    assert.ok(checkGreenConfirmTarget([ra, q, r], r, { confirmsRecordId: ra.id }).ok,
      'after quarantine+recover, a green-confirm confirming the reinstated governing red-assert is ADMITTED');
    assert.equal(checkGreenConfirmTarget([ra, q, r], r, { confirmsRecordId: raOther.id }).reasonId, REASON_ILLEGAL_TRANSITION,
      'a green-confirm confirming a non-governing id is REJECTED even after quarantine+recover');

    // Cycle safety: a self-referential recover terminates (bounded, no stack overflow).
    const selfRec = makeControl('recover', 'B-e', 'AB-002', 1, null, 'REC-self', 'REC-self', 'sha256:self', 'loop');
    assert.doesNotThrow(() => effectiveHeadOperation([selfRec], selfRec), 'self-referential recover terminates');
    // Mutual cycle A↔B terminates.
    const a = makeControl('recover', 'B-e', 'AB-003', 1, null, 'REC-B', 'REC-B', 'sha256:b', 'a');
    const b = makeControl('recover', 'B-e', 'AB-003', 2, 'sha256:x', 'REC-A', 'REC-A', 'sha256:a', 'b');
    const aById = { ...a, id: 'REC-A' } as RedEvidenceRecordV2;
    const bById = { ...b, id: 'REC-B' } as RedEvidenceRecordV2;
    assert.doesNotThrow(() => effectiveHeadOperation([aById, bById], aById), 'mutual recover cycle terminates');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5. operation key + normalizedReason + deterministic id (CHK-006)
  // ════════════════════════════════════════════════════════════════════════
  {
    const base = { operation: 'quarantine' as const, storyId: 'B-k', acceptanceTargetRef: 'AB-001', recoversRecordId: 'RED-x', referencedRecordDigest: 'sha256:d' };
    // normalizedReason collapses whitespace: cosmetic differences → SAME key.
    const k1 = controlOperationKey({ ...base, reason: '  bad   record\tfound  ' });
    const k2 = controlOperationKey({ ...base, reason: 'bad record found' });
    assert.equal(k1, k2, 'whitespace-only reason differences produce the SAME operation key');
    assert.equal(normalizeReason('  a\t b   c '), 'a b c');
    // approvedBy is NOT in the key: it is not even an input to controlOperationKey.
    // priorRecordDigest / seq are NOT in the key (not inputs); a retry at any seq collides.
    const idAt2 = deriveRecordId('quarantine', k1, 2);
    const idAt5 = deriveRecordId('quarantine', k1, 5);
    assert.equal(idAt2.slice(0, -1), idAt5.slice(0, -1), 'id differs only in trailing seq');
    assert.ok(idAt2.startsWith('QUA-'), 'QUA prefix');
    assert.ok(deriveRecordId('recover', k1, 1).startsWith('REC-'));
    assert.ok(deriveRecordId('red-assert', k1, 1).startsWith('RED-'));
    assert.ok(deriveRecordId('green-confirm', k1, 1).startsWith('GRN-'));
    // first12hex strips the sha256: prefix and takes 12 hex chars of the body.
    assert.equal(first12hex('sha256:0123456789abcdef'), '0123456789ab');
    // red-assert / green-confirm preimages are declared (completeness).
    assert.match(redAssertOperationKey({ storyId: 'B', acceptanceTargetRef: 'A', baselineHeadHash: 'h', baselineMaterialHash: 'm', specDigest: 's', assertionDigest: 'a', policyDigest: 'p' }), /^sha256:/);
    assert.match(greenConfirmOperationKey({ storyId: 'B', acceptanceTargetRef: 'A', greenHeadHash: 'h', greenMaterialHash: 'm', confirmsRecordDigest: 'c', confirmsAssertionDigest: 'ca', specDigest: 's' }), /^sha256:/);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 6. append pipeline: dedupe / replay ordering + scoped dedupe + CONFLICT
  //    (CHK-007 + CHK-008) — exercised through the registered handlers.
  // ════════════════════════════════════════════════════════════════════════
  {
    const root = freshRoot('append');
    const storyId = 'B-app';
    const store = seedRedStory(root, storyId);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
    const registry = createMainRegistry(ctx);
    assert.ok(registry.has('red_evidence_quarantine') && registry.has('red_evidence_recover'), 'both chain-control handlers are registered');
    const quarantine = registry.get('red_evidence_quarantine')!;
    const recover = registry.get('red_evidence_recover')!;

    const ra = synthRedAssert({ storyId, acceptanceTargetRef: 'M1', seq: 1, priorRecordDigest: null, supersedes: null });
    writeRecords(store, storyId, [ra]);

    // Quarantine the head → new head, records.length +1.
    const before = store.readRedEvidence(storyId)!.records.length;
    quarantine({ storyId, recordId: ra.id, reason: 'flaky', agent: 'proof-or-stop-implementer' });
    assert.equal(store.readRedEvidence(storyId)!.records.length, before + 1, 'quarantine appends exactly one record');
    const chain1 = partitionChain(store.readRedEvidence(storyId)!.records, storyId, 'M1');
    const head1 = resolveChainHead(chain1)!;
    assert.equal(head1.operation, 'quarantine', 'quarantine is the new head');

    // Replay: the SAME quarantine (same operationKey) returns the existing record,
    // records.length UNCHANGED, nothing written.
    const lenAfterQ = store.readRedEvidence(storyId)!.records.length;
    const replayMsg: string = quarantine({ storyId, recordId: ra.id, reason: 'flaky', agent: 'proof-or-stop-implementer' });
    assert.match(replayMsg, /replay/, 'a same-key quarantine replays');
    assert.equal(store.readRedEvidence(storyId)!.records.length, lenAfterQ, 'replay does NOT change records.length');

    // Recover un-quarantines; a fresh red-assert with the SAME assertion params as
    // the quarantined original is a genuine new record (scoped dedupe): the
    // quarantined red-assert is excluded from the dedupe search.
    const quarantinedRa = ra;
    assert.ok(isRetiredByQuarantine(quarantinedRa, chain1), 'the red-assert is retired-by-quarantine (excluded from dedupe scope)');
    recover({ storyId, recordId: head1.id, reason: 'was fine', agent: 'proof-or-stop-implementer' });
    const chain2 = partitionChain(store.readRedEvidence(storyId)!.records, storyId, 'M1');
    assert.ok(!isRetiredByQuarantine(quarantinedRa, chain2), 'after recover the original is back in the dedupe scope');

    // CONFLICT: a stored control record whose operationKey does not recompute → CONFLICT,
    // nothing written. (Corrupt the stored quarantine record's reason without fixing its key.)
    const corruptRoot = freshRoot('conflict');
    const cStore = seedRedStory(corruptRoot, 'B-conf');
    const cra = synthRedAssert({ storyId: 'B-conf', acceptanceTargetRef: 'M1', seq: 1, priorRecordDigest: null, supersedes: null });
    const cKey = controlOperationKey({ operation: 'quarantine', storyId: 'B-conf', acceptanceTargetRef: 'M1', recoversRecordId: cra.id, referencedRecordDigest: cra.recordDigest, reason: 'orig' });
    const cq = makeControl('quarantine', 'B-conf', 'M1', 2, cra.recordDigest, cra.id, cra.id, cra.recordDigest, 'orig', cKey);
    // Tamper: change the stored reason so its operationKey no longer recomputes.
    const tampered = { ...cq, reason: 'TAMPERED' } as RedEvidenceRecordV2;
    writeRecords(cStore, 'B-conf', [cra, tampered]);
    assert.throws(
      () => appendControlRecord({
        store: cStore, storyId: 'B-conf', acceptanceTargetRef: 'M1', operation: 'quarantine', operationKey: cKey,
        recoversRecordId: cra.id, referencedRecordDigest: cra.recordDigest, linkKind: 'quarantines',
        reason: 'orig', approvedBy: 'a@s', requiredHeadOperations: ['red-assert', 'green-confirm', 'recover'],
      }),
      (e: unknown) => e instanceof RedEvidenceChainError && (e as RedEvidenceChainError).reasonId === REASON_STORE_CORRUPTION,
      'a stored record whose key does not recompute raises CONFLICT (store corruption)',
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 7. rejection matrix via handlers (RED signal C) + retired byte-identical +
  //    forged approvedBy ignored + CHK-012 membership (CHK-010 + CHK-012)
  // ════════════════════════════════════════════════════════════════════════
  {
    const root = freshRoot('reject');
    const storyId = 'B-rej';
    const store = seedRedStory(root, storyId);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
    const registry = createMainRegistry(ctx);
    const quarantine = registry.get('red_evidence_quarantine')!;
    const recover = registry.get('red_evidence_recover')!;

    const ra = synthRedAssert({ storyId, acceptanceTargetRef: 'M1', seq: 1, priorRecordDigest: null, supersedes: null });
    writeRecords(store, storyId, [ra]);

    // Recover of a non-quarantined head → REJECTED (recover requires a quarantine head).
    assert.throws(() => recover({ storyId, recordId: ra.id, reason: 'x', agent: 'proof-or-stop-implementer' }),
      /reference|transition|not one of|head operation/i, 'recover of a red-assert head is rejected');

    // Quarantine of a NON-head record → REJECTED. Append a second red-assert head,
    // then try to quarantine the (now non-head) seq-1 record.
    const ra2 = synthRedAssert({ storyId, acceptanceTargetRef: 'M1', seq: 2, priorRecordDigest: ra.recordDigest, supersedes: ra.id });
    writeRecords(store, storyId, [ra, ra2]);
    assert.throws(() => quarantine({ storyId, recordId: ra.id, reason: 'x', agent: 'proof-or-stop-implementer' }),
      /not the current chain head/i, 'quarantine of a non-head record is rejected');

    // F-010: a caller-supplied approvedBy is REJECTED (§4.1), not silently
    // ignored — nothing is written.
    const lenBeforeForge = store.readRedEvidence(storyId)!.records.length;
    assert.throws(() => quarantine({ storyId, recordId: ra2.id, reason: 'retire', agent: 'proof-or-stop-implementer', approvedBy: 'FORGED@evil' }),
      /approvedBy is derived/, 'a caller-supplied approvedBy is rejected, not silently ignored');
    assert.equal(store.readRedEvidence(storyId)!.records.length, lenBeforeForge, 'the rejected forged-approvedBy request writes nothing');

    // Retired byte-identical + DERIVED approvedBy: quarantine ra2 (the head) with
    // NO caller approvedBy; ra2's stored bytes are UNCHANGED and the recorded
    // approvedBy is the derived <actor>@<sessionId>.
    const beforeBytes = recordCanonicalBytes(ra2);
    quarantine({ storyId, recordId: ra2.id, reason: 'retire', agent: 'proof-or-stop-implementer' });
    const chainR = partitionChain(store.readRedEvidence(storyId)!.records, storyId, 'M1');
    const storedRa2 = chainR.find((r) => r.id === ra2.id)!;
    assert.equal(recordCanonicalBytes(storedRa2), beforeBytes, 'the retired record is BYTE-IDENTICAL after quarantine (§4.2 immutability)');
    const qHead = resolveChainHead(chainR)!;
    assert.match((qHead as { approvedBy: string }).approvedBy, /^proof-or-stop-implementer@/, 'approvedBy = <actor>@<sessionId> (derived, not forged)');

    // Quarantine of an already-quarantined head → REJECTED.
    assert.throws(() => quarantine({ storyId, recordId: qHead.id, reason: 'again', agent: 'proof-or-stop-implementer' }),
      /head operation|not one of|transition/i, 'double-quarantine is rejected');

    // Recover the quarantine, then recover-of-a-recover → REJECTED.
    recover({ storyId, recordId: qHead.id, reason: 'undo', agent: 'proof-or-stop-implementer' });
    const recHead = resolveChainHead(partitionChain(store.readRedEvidence(storyId)!.records, storyId, 'M1'))!;
    assert.equal(recHead.operation, 'recover', 'recover is head');
    assert.throws(() => recover({ storyId, recordId: recHead.id, reason: 'again', agent: 'proof-or-stop-implementer' }),
      /head operation|not one of|transition/i, 'recover-of-a-recover is rejected');

    // Cross-story / phantom reference → REJECTED.
    assert.throws(() => quarantine({ storyId, recordId: 'RED-does-not-exist', reason: 'x', agent: 'proof-or-stop-implementer' }),
      /not a v2 chain record/i, 'a phantom recordId is rejected');

    // CHK-012 out-of-topology target → REJECTED, nothing written. A record whose
    // acceptanceTargetRef is NOT an expectedRedTarget.
    const outRoot = freshRoot('outtopo');
    const outStore = seedRedStory(outRoot, 'B-out');
    const outCtx: HandlerContext = { store: outStore, root: outRoot, scanRoot: join(outRoot, 'packages', 'main') };
    const outRegistry = createMainRegistry(outCtx);
    const outQ = outRegistry.get('red_evidence_quarantine')!;
    const outR = outRegistry.get('red_evidence_recover')!;
    const outsider = synthRedAssert({ storyId: 'B-out', acceptanceTargetRef: 'NOT-A-TARGET', seq: 1, priorRecordDigest: null, supersedes: null });
    writeRecords(outStore, 'B-out', [outsider]);
    const lenOut = outStore.readRedEvidence('B-out')!.records.length;
    assert.throws(() => outQ({ storyId: 'B-out', recordId: outsider.id, reason: 'x', agent: 'proof-or-stop-implementer' }),
      /not in expectedRedTargets/, 'quarantine of an out-of-topology target is rejected (CHK-012)');
    assert.throws(() => outR({ storyId: 'B-out', recordId: outsider.id, reason: 'x', agent: 'proof-or-stop-implementer' }),
      /not in expectedRedTargets/, 'recover of an out-of-topology target is rejected (CHK-012)');
    assert.equal(outStore.readRedEvidence('B-out')!.records.length, lenOut, 'nothing written on a membership rejection');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 8. §1.1.3 binding-freeze (CHK-010): frozen after a run record, unfrozen
  //    after quarantine, re-frozen after recover — synthetic v2 red-assert.
  // ════════════════════════════════════════════════════════════════════════
  {
    const root = freshRoot('freeze');
    const storyId = 'B-frz';
    const store = seedRedStory(root, storyId);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
    const registry = createMainRegistry(ctx);
    const bindingSet = registry.get('red_evidence_binding_set')!;
    const quarantine = registry.get('red_evidence_quarantine')!;
    const recover = registry.get('red_evidence_recover')!;

    // Empty chain: binding is settable.
    bindingSet({ storyId, acceptanceTargetRef: 'M1', adapterId: 'node-test@1', testCaseRef: 'node-test:a#b', agent: 'proof-or-stop-implementer' });

    // A run record now exists on an unquarantined chain → the binding is FROZEN
    // (a second binding write REJECTS). (The M1 binding was already written above;
    // add the synthetic red-assert head to make the chain unquarantined.)
    const ra = synthRedAssert({ storyId, acceptanceTargetRef: 'M1', seq: 1, priorRecordDigest: null, supersedes: null });
    writeRecords(store, storyId, [ra]);
    // Use a fresh target CHK-001:happy:0 (also an expected target) to test the freeze
    // path independently of the one-binding-per-target rule.
    const ra2 = synthRedAssert({ storyId, acceptanceTargetRef: 'CHK-001:happy:0', seq: 1, priorRecordDigest: null, supersedes: null });
    writeRecords(store, storyId, [ra, ra2]);
    assert.throws(() => bindingSet({ storyId, acceptanceTargetRef: 'CHK-001:happy:0', adapterId: 'node-test@1', testCaseRef: 'node-test:c#d', agent: 'proof-or-stop-implementer' }),
      /FROZEN/, 'a binding is frozen once a run record exists on an unquarantined chain (§1.1.3)');

    // Quarantine the head → the binding UNFREEZES (settable again).
    quarantine({ storyId, recordId: ra2.id, reason: 'retire', agent: 'proof-or-stop-implementer' });
    assert.doesNotThrow(() => bindingSet({ storyId, acceptanceTargetRef: 'CHK-001:happy:0', adapterId: 'node-test@1', testCaseRef: 'node-test:e#f', agent: 'proof-or-stop-implementer' }),
      'quarantining the head unfreezes the binding');

    // Recover reinstates the run record → the binding RE-FREEZES.
    const qHead = resolveChainHead(partitionChain(store.readRedEvidence(storyId)!.records, storyId, 'CHK-001:happy:0'))!;
    recover({ storyId, recordId: qHead.id, reason: 'undo', agent: 'proof-or-stop-implementer' });
    assert.throws(() => bindingSet({ storyId, acceptanceTargetRef: 'CHK-001:happy:0', adapterId: 'node-test@1', testCaseRef: 'node-test:g#h', agent: 'proof-or-stop-implementer' }),
      /FROZEN/, 'recovery reinstates the freeze (§1.1.3)');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 9. genuine TWO-PROCESS mkdir-claim race (RED signal B, CHK-009) → one head
  // ════════════════════════════════════════════════════════════════════════
  {
    const root = freshRoot('race');
    const storyId = 'B-race';
    const store = seedRedStory(root, storyId);
    const ra = synthRedAssert({ storyId, acceptanceTargetRef: 'M1', seq: 1, priorRecordDigest: null, supersedes: null });
    writeRecords(store, storyId, [ra]);

    const raceDir = roots[roots.length - 1];
    const worker = join(raceDir, 'race-worker.mjs');
    const launcher = join(raceDir, 'race-launcher.mjs');
    writeFileSync(worker, raceWorkerSource(DIST, root, storyId, ra.id));
    writeFileSync(launcher, raceLauncherSource(worker));
    const before = store.readRedEvidence(storyId)!.records.length;
    // The launcher spawns TWO worker processes CONCURRENTLY (both contend on the
    // same mkdir claim); it prints "EXIT:<a>,<b>" once both have closed.
    const launched = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
    const m = /EXIT:(\-?\d+),(\-?\d+)/.exec(launched.stdout);
    assert.ok(m, `race launcher must report both child exit codes; stdout=${launched.stdout} stderr=${launched.stderr}`);
    const exitCodes = [Number(m![1]), Number(m![2])];
    const records = store.readRedEvidence(storyId)!.records;
    const chain = partitionChain(records, storyId, 'M1');
    const quarantines = chain.filter((r) => r.operation === 'quarantine');
    assert.equal(records.length, before + 1, `the 2-process race appends EXACTLY one record (got ${records.length - before})`);
    assert.equal(quarantines.length, 1, 'exactly one quarantine record exists after the race');
    assert.ok(resolveChainHead(chain), 'the chain head is unique after the race (§3.2)');
    const okCount = exitCodes.filter((c) => c === 0).length;
    assert.equal(okCount, 1, `exactly one child won; the loser reported a structured non-zero abort (exit codes ${exitCodes.join(',')})`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 12. EMPTY records array — the mixed v1+v2 union boundary case (CHK-002:edge:0)
  //
  // A store that has no evidence yet: records: []. It must round-trip through
  // writeRedEvidence → readRedEvidence as a STILL-EMPTY array (the widened union
  // and the §6.4 load-time classifier must neither synthesize nor drop entries,
  // and must not reject an empty array), and the LIVE v1 gate verdict on it must
  // be WELL-DEFINED — no v1 satisfier, so the missing-red-evidence diagnostic
  // fires — rather than a crash or a silent pass.
  //
  // Placement note: this block is appended LAST deliberately, so adding it does
  // not renumber any earlier line in the emitted dist/tasks/red-evidence-chain-
  // smoke.js that other evidence notes cite.
  //
  // Scope note: unlike sections 2-11 this is NOT a guard-regression signal — it
  // pins a boundary behaviour that holds on the pre-fix tree too. It exists
  // because CHK-002:edge:0 names the empty-array round-trip and nothing in this
  // file asserted it (B-506e F-012).
  // ════════════════════════════════════════════════════════════════════════
  {
    const root = freshRoot('empty');
    const storyId = 'B-empty';
    const store = seedRedStory(root, storyId);
    writeRecords(store, storyId, []);
    const readBack = store.readRedEvidence(storyId);
    assert.notEqual(readBack, null, 'a store written with an empty records array reads back (not null)');
    const roundTripped = readBack as RedEvidenceData;
    assert.ok(Array.isArray(roundTripped.records), 'records round-trips as an ARRAY');
    assert.equal(roundTripped.records.length, 0, 'records round-trips as an EMPTY array — the load-time classifier neither synthesizes nor drops entries');
    assert.equal(JSON.stringify(roundTripped.records), '[]', 'the empty array is byte-identical after write → read');
    assert.equal(roundTripped.schemaVersion, RED_EVIDENCE_FILE_SCHEMA_VERSION, 'the file-level schemaVersion survives the empty-array round-trip unchanged');
    let emptyVerdict: unknown[] = [];
    assert.doesNotThrow(() => {
      emptyVerdict = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence;
    }, 'the LIVE v1 gate MUST NOT throw on an empty records array');
    assert.ok(emptyVerdict.length > 0, 'an empty records array has no v1 satisfier → the v1 gate verdict is well-defined: missing_red_evidence fires (not a crash, not a silent pass)');
  }

  console.log('red-evidence-chain-smoke: OK — v2 union + §0.4 omission/nullability; enforce-gate byte-identical v1 guard (RED signal A); chain head both conjuncts + three integrity checks with distinct reason ids; closed transition table + transitive cycle-safe effective head; operation-key + normalizedReason + deterministic id; dedupe/replay ordering + scoped dedupe + CONFLICT; full rejection matrix + retired byte-identical + forged approvedBy rejected + CHK-012 membership; §1.1.3 binding-freeze/unfreeze/re-freeze; genuine 2-process mkdir-claim race → one head (RED signal B); empty-records-array round-trip + well-defined v1 verdict.');
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeControl(
  operation: 'quarantine' | 'recover',
  storyId: string,
  acceptanceTargetRef: string,
  seq: number,
  priorRecordDigest: string | null,
  supersedes: string | null,
  recoversRecordId: string,
  referencedRecordDigest: string,
  reason: string,
  operationKey?: string,
): RedEvidenceRecordV2 {
  const key =
    operationKey ??
    controlOperationKey({ operation, storyId, acceptanceTargetRef, recoversRecordId, referencedRecordDigest, reason });
  const draft = {
    id: deriveRecordId(operation, key, seq),
    schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION,
    operation,
    seq,
    priorRecordDigest,
    supersedes,
    storyId,
    acceptanceTargetRef,
    recoversRecordId,
    referencedRecordDigest,
    linkKind: operation === 'quarantine' ? ('quarantines' as const) : ('recovers' as const),
    reason,
    approvedBy: 'proof-or-stop-implementer@sess-test',
    operationKey: key,
    createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft as unknown as Record<string, unknown>) } as RedEvidenceRecordV2;
}

function raceWorkerSource(dist: string, root: string, storyId: string, recordId: string): string {
  return [
    `import { StoryStore } from ${JSON.stringify(join(dist, 'core', 'store.js'))};`,
    `import { createMainRegistry } from ${JSON.stringify(join(dist, 'registry.js'))};`,
    `const root = ${JSON.stringify(root)};`,
    `const store = new StoryStore(root);`,
    `const registry = createMainRegistry({ store, root, scanRoot: root });`,
    `const quarantine = registry.get('red_evidence_quarantine');`,
    `const reason = process.argv[2];`,
    `try {`,
    `  quarantine({ storyId: ${JSON.stringify(storyId)}, recordId: ${JSON.stringify(recordId)}, reason, agent: 'proof-or-stop-implementer' });`,
    `  process.exit(0);`,
    `} catch (e) {`,
    `  process.stderr.write(String(e && e.message || e));`,
    `  process.exit(3);`,
    `}`,
    ``,
  ].join('\n');
}

function raceLauncherSource(worker: string): string {
  return [
    `import { spawn } from 'node:child_process';`,
    `function run(reason) {`,
    `  return new Promise((resolve) => {`,
    `    const c = spawn(process.execPath, [${JSON.stringify(worker)}, reason], { stdio: 'ignore' });`,
    `    c.on('close', (code) => resolve(code === null ? -1 : code));`,
    `  });`,
    `}`,
    `// Launch BOTH concurrently so they genuinely contend on the mkdir claim.`,
    `const [a, b] = await Promise.all([run('reason-alpha'), run('reason-beta')]);`,
    `process.stdout.write('EXIT:' + a + ',' + b);`,
    ``,
  ].join('\n');
}
