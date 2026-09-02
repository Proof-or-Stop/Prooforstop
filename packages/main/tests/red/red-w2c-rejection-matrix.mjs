#!/usr/bin/env node
/**
 * RED artifact C (W2c / B-506e, §7 rejection matrix) — every destructive /
 * adversarial case is a COMMITTED regression, asserted here (not inline node -e).
 *
 * Repro-first RED: written and committed BEFORE the chain plane (chain.ts),
 * append pipeline (append.ts), operation key (operation-key.ts), and the two
 * chain-control commands exist. Against today's tree the imports / commands are
 * absent, so every assertion below is unreachable — that is the RED signal.
 *
 * Matrix (each hashed where noted):
 *  1. two records same priorRecordDigest → fork rejection, reason id DISTINCT
 *     from the prior-digest-mismatch reason id.
 *  2. seq gap rejected; seq reuse rejected.
 *  3. recover-of-a-recover rejected (recover needs a quarantine head).
 *  4. quarantine-of-non-head rejected.
 *  5. retired (quarantined) record byte-identical before/after quarantine.
 *  6. self-referential / looping recover chain TERMINATES (bounded).
 *  7. replay (same operationKey) returns existing record, length unchanged, no run.
 *  8. corrupted stored operationKey → CONFLICT, nothing written.
 *  9. forged caller approvedBy REJECTED — recorded approvedBy is <actor>@<sessionId>.
 * 10. out-of-topology target rejected at write time (CHK-012).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { createMainRegistry } = await import(`${DIST}/registry.js`);
const { computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const {
  RED_EVIDENCE_V2_SCHEMA_VERSION, computeRecordDigest, computeSpecDigest, recordCanonicalBytes,
} = await import(`${DIST}/core/red-evidence/record-v2.js`);
const {
  controlOperationKey, redAssertOperationKey, deriveRecordId,
} = await import(`${DIST}/core/red-evidence/operation-key.js`);
const {
  partitionChain, resolveChainHead, checkChainIntegrity, effectiveHeadOperation,
  REASON_SEQ_INVALID, REASON_PRIOR_DIGEST_MISMATCH, REASON_CHAIN_FORK,
} = await import(`${DIST}/core/red-evidence/chain.js`);
const { appendControlRecord, RedEvidenceChainError, REASON_STORE_CORRUPTION } = await import(`${DIST}/core/red-evidence/append.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const roots = [];
function freshRoot(label) { const r = mkdtempSync(join(tmpdir(), `red-w2c-rej-${label}-`)); roots.push(r); return r; }

function synthRedAssert(storyId, target, seq, prior, supersedes) {
  const greenRelation = { targetRef: target, relation: 'same_acceptance' };
  const specDigest = computeSpecDigest(target, greenRelation);
  const operationKey = redAssertOperationKey({ storyId, acceptanceTargetRef: target, baselineHeadHash: 'h', baselineMaterialHash: 'm', specDigest, assertionDigest: 'sha256:a', policyDigest: 'sha256:p' });
  const draft = {
    id: deriveRecordId('red-assert', operationKey, seq), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'red-assert',
    seq, priorRecordDigest: prior, supersedes, storyId, acceptanceTargetRef: target,
    trigger: 't', observedFailure: 'f', baselineHeadHash: 'h', baselineMaterialHash: 'm', greenRelation,
    assertion: {}, policySnapshot: {}, specDigest, operationKey, runReceipt: {}, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}
function control(op, storyId, target, seq, prior, supersedes, recoversRecordId, referencedRecordDigest, reason, key) {
  const operationKey = key ?? controlOperationKey({ operation: op, storyId, acceptanceTargetRef: target, recoversRecordId, referencedRecordDigest, reason });
  const draft = {
    id: deriveRecordId(op, operationKey, seq), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: op,
    seq, priorRecordDigest: prior, supersedes, storyId, acceptanceTargetRef: target,
    recoversRecordId, referencedRecordDigest, linkKind: op === 'quarantine' ? 'quarantines' : 'recovers',
    reason, approvedBy: 'proof-or-stop-implementer@sess-test', operationKey, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}
function seedStory(root, storyId) {
  const store = new StoryStore(root);
  store.writeStory(storyId, { storyId, name: 'rej', title: 'W2c rej', description: 'auth security regression behavior change', type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null });
  const milestones = [{ id: 'M1', sourceRequirementId: 'REQ-1', claim: 'c', doneMeans: 'd', requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned' }];
  store.writeMilestoneLedger(storyId, { schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed', ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW });
  return store;
}
function writeRecords(store, storyId, records) {
  store.writeRedEvidence(storyId, { schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW });
}

try {
  // 1 + 2: fork / seq-gap / seq-reuse / prior-mismatch reason ids (chain integrity).
  const ra = synthRedAssert('B-i', 'M1', 1, null, null);
  const child = synthRedAssert('B-i', 'M1', 2, ra.recordDigest, ra.id);
  assert.equal(checkChainIntegrity([ra], ra, { seq: 3, priorRecordDigest: ra.recordDigest }).reasonId, REASON_SEQ_INVALID, 'seq gap rejected');
  assert.equal(checkChainIntegrity([ra], ra, { seq: 1, priorRecordDigest: ra.recordDigest }).reasonId, REASON_SEQ_INVALID, 'seq reuse rejected');
  assert.equal(checkChainIntegrity([ra], ra, { seq: 2, priorRecordDigest: 'sha256:wrong' }).reasonId, REASON_PRIOR_DIGEST_MISMATCH, 'prior mismatch rejected');
  assert.equal(checkChainIntegrity([ra, child], ra, { seq: 2, priorRecordDigest: ra.recordDigest }).reasonId, REASON_CHAIN_FORK, 'fork rejected');
  assert.notEqual(REASON_CHAIN_FORK, REASON_PRIOR_DIGEST_MISMATCH, 'fork reason id is DISTINCT from prior-digest-mismatch');

  // 6: self-referential + mutual recover chains TERMINATE (bounded, no overflow).
  const selfRec = control('recover', 'B-i', 'M2', 1, null, 'REC-self', 'REC-self', 'sha256:self', 'loop');
  const selfById = { ...selfRec, id: 'REC-self' };
  assert.doesNotThrow(() => effectiveHeadOperation([selfById], selfById), 'self-referential recover terminates');
  const a = { ...control('recover', 'B-i', 'M3', 1, null, 'REC-B', 'REC-B', 'sha256:b', 'a'), id: 'REC-A' };
  const b = { ...control('recover', 'B-i', 'M3', 2, 'sha256:x', 'REC-A', 'REC-A', 'sha256:a', 'b'), id: 'REC-B' };
  assert.doesNotThrow(() => effectiveHeadOperation([a, b], a), 'mutual recover cycle terminates');

  // 8: corrupted stored operationKey → CONFLICT, nothing written.
  {
    const store = seedStory(freshRoot('conflict'), 'B-c');
    const cra = synthRedAssert('B-c', 'M1', 1, null, null);
    const key = controlOperationKey({ operation: 'quarantine', storyId: 'B-c', acceptanceTargetRef: 'M1', recoversRecordId: cra.id, referencedRecordDigest: cra.recordDigest, reason: 'orig' });
    const cq = control('quarantine', 'B-c', 'M1', 2, cra.recordDigest, cra.id, cra.id, cra.recordDigest, 'orig', key);
    writeRecords(store, 'B-c', [cra, { ...cq, reason: 'TAMPERED' }]); // key no longer recomputes
    assert.throws(
      () => appendControlRecord({ store, storyId: 'B-c', acceptanceTargetRef: 'M1', operation: 'quarantine', operationKey: key, recoversRecordId: cra.id, referencedRecordDigest: cra.recordDigest, linkKind: 'quarantines', reason: 'orig', approvedBy: 'a@s', requiredHeadOperations: ['red-assert', 'green-confirm', 'recover'] }),
      (e) => e instanceof RedEvidenceChainError && e.reasonId === REASON_STORE_CORRUPTION,
      'a stored record whose operationKey does not recompute → CONFLICT, nothing written',
    );
  }

  // 3,4,5,7,9,10: via the registered handlers.
  {
    const root = freshRoot('hdl');
    const store = seedStory(root, 'B-h');
    const registry = createMainRegistry({ store, root, scanRoot: root });
    const quarantine = registry.get('red_evidence_quarantine');
    const recover = registry.get('red_evidence_recover');
    assert.ok(quarantine && recover, 'both chain-control commands are registered');

    const ra1 = synthRedAssert('B-h', 'M1', 1, null, null);
    const ra2 = synthRedAssert('B-h', 'M1', 2, ra1.recordDigest, ra1.id);
    writeRecords(store, 'B-h', [ra1, ra2]);

    // 4: quarantine of a NON-head record rejected.
    assert.throws(() => quarantine({ storyId: 'B-h', recordId: ra1.id, reason: 'x', agent: 'proof-or-stop-implementer' }), /not the current chain head/i, 'quarantine of non-head rejected');

    // 9: a forged caller approvedBy is REJECTED (§4.1), nothing written.
    const lenBeforeForge = store.readRedEvidence('B-h').records.length;
    assert.throws(() => quarantine({ storyId: 'B-h', recordId: ra2.id, reason: 'retire', agent: 'proof-or-stop-implementer', approvedBy: 'FORGED@evil' }),
      /approvedBy is derived/, 'a caller-supplied approvedBy is rejected, not silently ignored');
    assert.equal(store.readRedEvidence('B-h').records.length, lenBeforeForge, 'the rejected forged-approvedBy request writes nothing');

    // 5: retired byte-identical + DERIVED approvedBy — quarantine WITHOUT approvedBy.
    const beforeBytes = recordCanonicalBytes(ra2);
    quarantine({ storyId: 'B-h', recordId: ra2.id, reason: 'retire', agent: 'proof-or-stop-implementer' });
    const chain = partitionChain(store.readRedEvidence('B-h').records, 'B-h', 'M1');
    const storedRa2 = chain.find((r) => r.id === ra2.id);
    assert.equal(recordCanonicalBytes(storedRa2), beforeBytes, 'retired record is BYTE-IDENTICAL before/after quarantine');
    const qHead = resolveChainHead(chain);
    assert.match(qHead.approvedBy, /^proof-or-stop-implementer@/, 'recorded approvedBy = <actor>@<sessionId>');

    // 7: replay — same quarantine returns existing record, length unchanged, no run.
    const lenAfterQ = store.readRedEvidence('B-h').records.length;
    const replay = quarantine({ storyId: 'B-h', recordId: ra2.id, reason: 'retire', agent: 'proof-or-stop-implementer' });
    assert.match(replay, /replay/, 'a same-key quarantine replays');
    assert.equal(store.readRedEvidence('B-h').records.length, lenAfterQ, 'replay does not change records.length');

    // 3: recover the quarantine, then recover-of-a-recover rejected.
    recover({ storyId: 'B-h', recordId: qHead.id, reason: 'undo', agent: 'proof-or-stop-implementer' });
    const recHead = resolveChainHead(partitionChain(store.readRedEvidence('B-h').records, 'B-h', 'M1'));
    assert.equal(recHead.operation, 'recover');
    assert.throws(() => recover({ storyId: 'B-h', recordId: recHead.id, reason: 'again', agent: 'proof-or-stop-implementer' }), /head operation|not one of|transition/i, 'recover-of-a-recover rejected');
  }

  // 10: out-of-topology target rejected at write time, nothing written (CHK-012).
  {
    const root = freshRoot('topo');
    const store = seedStory(root, 'B-t');
    const registry = createMainRegistry({ store, root, scanRoot: root });
    const quarantine = registry.get('red_evidence_quarantine');
    const recover = registry.get('red_evidence_recover');
    const outsider = synthRedAssert('B-t', 'NOT-A-TARGET', 1, null, null);
    writeRecords(store, 'B-t', [outsider]);
    const len = store.readRedEvidence('B-t').records.length;
    assert.throws(() => quarantine({ storyId: 'B-t', recordId: outsider.id, reason: 'x', agent: 'proof-or-stop-implementer' }), /not in expectedRedTargets/, 'quarantine of out-of-topology target rejected');
    assert.throws(() => recover({ storyId: 'B-t', recordId: outsider.id, reason: 'x', agent: 'proof-or-stop-implementer' }), /not in expectedRedTargets/, 'recover of out-of-topology target rejected');
    assert.equal(store.readRedEvidence('B-t').records.length, len, 'nothing written on membership rejection');
  }

  console.log('red-w2c-rejection-matrix: OK (fork/seq/prior-mismatch reason ids distinct; self+mutual recover terminate; CONFLICT on corrupted key; quarantine-non-head/recover-of-recover rejected; retired byte-identical; forged approvedBy rejected; replay length-unchanged; CHK-012 out-of-topology rejected)');
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
