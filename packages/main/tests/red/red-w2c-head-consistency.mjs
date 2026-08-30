#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, F-008 codex host-B D1) — the RESOLVED CHAIN HEAD is
 * re-verified before it is trusted as the new record's prior link (§3.5).
 *
 * `assertStoredControlRecordConsistent` used to run ONLY on a `dedupeHit`. On a
 * FRESH (non-replay) quarantine/recover the resolved head's stored
 * `recordDigest` / `operationKey` / `id` were trusted WITHOUT recomputation and
 * `head.recordDigest` became the new record's `priorRecordDigest` — silently
 * extending a corrupt head. The handler derives `referencedRecordDigest` FROM the
 * stored record, so the downstream `head.recordDigest !== referencedRecordDigest`
 * check compares the tampered value against itself and PASSES. Repro: tamper a
 * stored head's `recordDigest`, then run a fresh `red_evidence_recover` against
 * it — pre-fix the append SUCCEEDED and chained onto the corrupt digest. That
 * silent extension IS the RED signal.
 *
 * After the fix: the head is recomputed BEFORE use; a mismatch raises a
 * store-corruption CONFLICT with NOTHING written.
 *
 * Non-vacuity: part (a) runs the IDENTICAL fresh recover against an UNTAMPERED
 * head and asserts it SUCCEEDS, so the part (b) rejection is attributable to the
 * head corruption and not to any other validation check.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { createMainRegistry } = await import(`${DIST}/registry.js`);
const { computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const {
  RED_EVIDENCE_V2_SCHEMA_VERSION, computeRecordDigest, computeSpecDigest, recordDigestMatches,
} = await import(`${DIST}/core/red-evidence/record-v2.js`);
const { controlOperationKey, redAssertOperationKey, deriveRecordId } = await import(`${DIST}/core/red-evidence/operation-key.js`);
const { partitionChain, resolveChainHead } = await import(`${DIST}/core/red-evidence/chain.js`);
const { RedEvidenceChainError, REASON_STORE_CORRUPTION } = await import(`${DIST}/core/red-evidence/append.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const roots = [];
function freshRoot(label) { const r = mkdtempSync(join(tmpdir(), `red-w2c-headcons-${label}-`)); roots.push(r); return r; }

function synthRedAssert(storyId, target) {
  const greenRelation = { targetRef: target, relation: 'same_acceptance' };
  const specDigest = computeSpecDigest(target, greenRelation);
  const operationKey = redAssertOperationKey({ storyId, acceptanceTargetRef: target, baselineHeadHash: 'h', baselineMaterialHash: 'm', specDigest, assertionDigest: 'sha256:a', policyDigest: 'sha256:p' });
  const draft = {
    id: deriveRecordId('red-assert', operationKey, 1), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'red-assert',
    seq: 1, priorRecordDigest: null, supersedes: null, storyId, acceptanceTargetRef: target,
    trigger: 't', observedFailure: 'f', baselineHeadHash: 'h', baselineMaterialHash: 'm', greenRelation,
    assertion: {}, policySnapshot: {}, specDigest, operationKey, runReceipt: {}, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}

function quarantineOf(storyId, target, ra, reason) {
  const operationKey = controlOperationKey({ operation: 'quarantine', storyId, acceptanceTargetRef: target, recoversRecordId: ra.id, referencedRecordDigest: ra.recordDigest, reason });
  const draft = {
    id: deriveRecordId('quarantine', operationKey, 2), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'quarantine',
    seq: 2, priorRecordDigest: ra.recordDigest, supersedes: ra.id, storyId, acceptanceTargetRef: target,
    recoversRecordId: ra.id, referencedRecordDigest: ra.recordDigest, linkKind: 'quarantines',
    reason, approvedBy: 'proof-or-stop-implementer@sess-test', operationKey, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}

function seedStory(root, storyId) {
  const store = new StoryStore(root);
  store.writeStory(storyId, { storyId, name: 'hc', title: 'W2c head consistency', description: 'auth security regression behavior change', type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null });
  const milestones = [{ id: 'M1', sourceRequirementId: 'REQ-1', claim: 'c', doneMeans: 'd', requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned' }];
  store.writeMilestoneLedger(storyId, { schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed', ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW });
  return store;
}

function writeRecords(store, storyId, records) {
  store.writeRedEvidence(storyId, { schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW });
}

try {
  // ── (a) NON-VACUITY control: an UNTAMPERED quarantine head accepts the SAME
  //        fresh recover (so part (b)'s rejection is attributable to corruption). ──
  {
    const storyId = 'B-ok';
    const store = seedStory(freshRoot('ok'), storyId);
    const registry = createMainRegistry({ store, root: roots[roots.length - 1], scanRoot: roots[roots.length - 1] });
    const recover = registry.get('red_evidence_recover');
    const ra = synthRedAssert(storyId, 'M1');
    const q = quarantineOf(storyId, 'M1', ra, 'retire');
    writeRecords(store, storyId, [ra, q]);
    assert.ok(recordDigestMatches(q), 'control head is well-formed');
    const before = store.readRedEvidence(storyId).records.length;
    recover({ storyId, recordId: q.id, reason: 'undo the retire', agent: 'proof-or-stop-implementer' });
    assert.equal(store.readRedEvidence(storyId).records.length, before + 1, 'a fresh recover on a WELL-FORMED head appends (non-vacuous control)');
    const head = resolveChainHead(partitionChain(store.readRedEvidence(storyId).records, storyId, 'M1'));
    assert.equal(head.operation, 'recover', 'the control recover became the head');
  }

  // ── (b) a TAMPERED head is REJECTED before it becomes the prior link ────────
  {
    const storyId = 'B-bad';
    const root = freshRoot('bad');
    const store = seedStory(root, storyId);
    const registry = createMainRegistry({ store, root, scanRoot: root });
    const recover = registry.get('red_evidence_recover');

    const ra = synthRedAssert(storyId, 'M1');
    const q = quarantineOf(storyId, 'M1', ra, 'retire');
    // Tamper ONLY the stored recordDigest — the exact value that would become the
    // new recover record's priorRecordDigest. Every OTHER field is untouched, so
    // the reference/transition/membership checks all still pass; ONLY the §3.5
    // head recomputation can catch this.
    const tampered = { ...q, recordDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' };
    writeRecords(store, storyId, [ra, tampered]);

    // Precondition: the tampered record IS the resolved head and it does NOT recompute.
    const chain = partitionChain(store.readRedEvidence(storyId).records, storyId, 'M1');
    const head = resolveChainHead(chain);
    assert.equal(head?.id, q.id, 'the tampered quarantine is still the resolved chain head');
    assert.equal(recordDigestMatches(head), false, 'the tampered head does NOT recompute from its own bytes');

    const before = store.readRedEvidence(storyId).records.length;
    // A FRESH (non-replay) recover: its operationKey embeds operation="recover",
    // so it can never collide with the quarantine's key — the dedupe branch (the
    // ONLY pre-fix consistency check) is provably NOT taken.
    assert.throws(
      () => recover({ storyId, recordId: q.id, reason: 'undo the retire', agent: 'proof-or-stop-implementer' }),
      (e) => e instanceof RedEvidenceChainError && e.reasonId === REASON_STORE_CORRUPTION,
      'a fresh recover onto a corrupt head raises a store-corruption CONFLICT (the head is recomputed BEFORE it is used as the prior link)',
    );
    assert.equal(store.readRedEvidence(storyId).records.length, before, 'NOTHING is written when the resolved head fails recomputation');
  }

  // ── (c) the same guard covers a tampered operationKey on a fresh append ─────
  {
    const storyId = 'B-key';
    const root = freshRoot('key');
    const store = seedStory(root, storyId);
    const registry = createMainRegistry({ store, root, scanRoot: root });
    const recover = registry.get('red_evidence_recover');
    const ra = synthRedAssert(storyId, 'M1');
    const q = quarantineOf(storyId, 'M1', ra, 'retire');
    // Re-seal the record around a tampered operationKey so its recordDigest DOES
    // recompute — only the KEY derivation is corrupt.
    const keyDraft = { ...q, operationKey: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' };
    delete keyDraft.recordDigest;
    const keyTampered = { ...keyDraft, recordDigest: computeRecordDigest(keyDraft) };
    writeRecords(store, storyId, [ra, keyTampered]);
    assert.ok(recordDigestMatches(keyTampered), 'the key-tampered head still recomputes its recordDigest (only the key is corrupt)');
    const before = store.readRedEvidence(storyId).records.length;
    assert.throws(
      () => recover({ storyId, recordId: keyTampered.id, reason: 'undo the retire', agent: 'proof-or-stop-implementer' }),
      (e) => e instanceof RedEvidenceChainError && e.reasonId === REASON_STORE_CORRUPTION,
      'a head whose operationKey does not recompute is also caught on a FRESH append',
    );
    assert.equal(store.readRedEvidence(storyId).records.length, before, 'nothing written on the key-corruption CONFLICT');
  }

  console.log('red-w2c-head-consistency: OK (a well-formed head accepts the fresh recover; a head whose stored recordDigest or operationKey does not recompute raises a store-corruption CONFLICT on a FRESH non-replay append, with nothing written — the resolved head is re-verified BEFORE it becomes the prior link)');
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
