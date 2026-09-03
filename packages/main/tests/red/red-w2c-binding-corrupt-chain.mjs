#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, F-007 codex host-B D2) — red_evidence_binding_set
 * must NOT treat a corrupt non-empty chain (no unique head) as an empty/settable
 * chain.
 *
 * `resolveChainHead` returns `null` for an EMPTY chain AND for a MALFORMED
 * non-empty chain (two records both qualify as head → no unique head). The
 * pre-fix binding-freeze check `if (head && head.operation !== 'quarantine')`
 * treated a null head as "empty, therefore settable", so a corrupt chain silently
 * PERMITTED the binding write. Repro: seed a target whose chain has TWO founding
 * heads (both seq=1, priorRecordDigest=null) → resolveChainHead is null →
 * binding_set wrote the binding. That silent write IS the RED signal.
 *
 * After the fix (mirror the append.ts CORRUPT_CHAIN guard): a non-empty chain
 * with `head === null` is rejected as corrupt-chain, and NOTHING is written.
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
const { RED_EVIDENCE_V2_SCHEMA_VERSION, computeRecordDigest, computeSpecDigest } = await import(`${DIST}/core/red-evidence/record-v2.js`);
const { redAssertOperationKey, deriveRecordId } = await import(`${DIST}/core/red-evidence/operation-key.js`);
const { partitionChain, resolveChainHead } = await import(`${DIST}/core/red-evidence/chain.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const root = mkdtempSync(join(tmpdir(), 'red-w2c-corruptchain-'));
const storyId = 'B-cc';

/** A well-formed founding v2 red-assert whose key/id vary by baselineHeadHash. */
function foundingRedAssert(target, baselineHeadHash) {
  const greenRelation = { targetRef: target, relation: 'same_acceptance' };
  const specDigest = computeSpecDigest(target, greenRelation);
  const operationKey = redAssertOperationKey({ storyId, acceptanceTargetRef: target, baselineHeadHash, baselineMaterialHash: 'm', specDigest, assertionDigest: 'sha256:a', policyDigest: 'sha256:p' });
  const draft = {
    id: deriveRecordId('red-assert', operationKey, 1), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'red-assert',
    seq: 1, priorRecordDigest: null, supersedes: null, storyId, acceptanceTargetRef: target,
    trigger: 't', observedFailure: 'f', baselineHeadHash, baselineMaterialHash: 'm', greenRelation,
    assertion: {}, policySnapshot: {}, specDigest, operationKey, runReceipt: {}, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}

try {
  const store = new StoryStore(root);
  store.writeStory(storyId, { storyId, name: 'cc', title: 'W2c corrupt chain', description: 'auth security regression behavior change', type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null });
  const milestones = [{ id: 'M1', sourceRequirementId: 'REQ-1', claim: 'c', doneMeans: 'd', requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned' }];
  store.writeMilestoneLedger(storyId, { schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed', ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW });

  // A MALFORMED non-empty chain for M1: two founding heads, neither consumed.
  const headA = foundingRedAssert('M1', 'head-A');
  const headB = foundingRedAssert('M1', 'head-B');
  store.writeRedEvidence(storyId, { schemaVersion: 'proofstory.red_evidence.v1', storyId, records: [headA, headB], createdAt: NOW, updatedAt: NOW });

  // Precondition: the chain is genuinely corrupt (resolveChainHead === null on a
  // non-empty chain) — that is exactly the state the pre-fix code mis-read as empty.
  const chain = partitionChain(store.readRedEvidence(storyId).records, storyId, 'M1');
  assert.equal(chain.length, 2, 'the malformed chain is non-empty');
  assert.equal(resolveChainHead(chain), null, 'a malformed multi-head chain has no unique head (resolveChainHead === null)');

  const registry = createMainRegistry({ store, root, scanRoot: root });
  const bindingSet = registry.get('red_evidence_binding_set');
  assert.ok(bindingSet, 'red_evidence_binding_set is registered');

  const bindingsBefore = JSON.stringify(store.readRedTargetBindings(storyId));

  assert.throws(
    () => bindingSet({ storyId, acceptanceTargetRef: 'M1', adapterId: 'node-test@1', testCaseRef: 'node-test:a#b', agent: 'proof-or-stop-implementer' }),
    /corrupt-chain|no unique head/i,
    'binding_set rejects a corrupt non-empty chain (does not treat a null head as empty/settable)',
  );

  const bindingsAfter = JSON.stringify(store.readRedTargetBindings(storyId));
  assert.equal(bindingsAfter, bindingsBefore, 'nothing is written to the bindings on a corrupt-chain rejection');

  console.log('red-w2c-binding-corrupt-chain: OK (binding_set rejects a malformed multi-head chain as corrupt — a null head from a non-empty chain is NOT treated as empty/settable; nothing written)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
