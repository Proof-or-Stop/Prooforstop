#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
/**
 * Focused logic proof for B-1909 scope-shrinkage withdrawal dispositions.
 *
 * @task B-1909
 * @checklist CHK-006
 * @title Prove the write-time empty-scope floor and withdrawal helpers in-process
 * @type feature
 * @priority high
 * @description
 *   In-process (no git / no CLI) proof that the scope-shrinkage decision writer
 *   is the sole applier of both withdrawal dispositions, that a bad ref mutates
 *   nothing, that layers are independent, that re-application is idempotent, and
 *   that emptying the effective acceptance-binding set is HARD-REFUSED at write
 *   time under the DEFAULT observe config unless an explicit full-withdrawal
 *   re-approval is recorded. The comprehensive both-direction CLI smoke lives in
 *   CHK-007; this file proves the core model and the OQ-1 write-time floor.
 * @changes
 *   - [CHK-003] buildScopeShrinkageDecision generates a stable decisionId, preserves createdAt, persists new refs, and rejects an empty confirmed decision.
 *   - [CHK-004] effectiveAcceptanceBindings excludes withdrawn bindings via append-only dispositions and via the decision refs.
 *   - [CHK-005] the applier validates refs before any write and stamps one decisionId across both layers.
 *   - [CHK-006] the empty-scope floor refuses full withdrawal without re-approval at write time under default observe config.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const probeRepo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
import { StoryStore } from '../core/store.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import {
  buildScopeShrinkageDecision,
  effectiveAcceptanceBindings,
  withdrawnBindingIdsFrom,
  withdrawnChecklistItemIdsFrom,
} from '../core/proofstory.js';
import type { HandlerContext } from '../handlers/context.js';
import type {
  ChecklistData,
  ProofStoryContractData,
  ScopeShrinkageDecisionData,
  StoryInfo,
} from '../core/types.js';

function makeCtx(root: string): HandlerContext {
  return { store: new StoryStore(root), root, scanRoot: root } as HandlerContext;
}

function seedStory(store: StoryStore, storyId: string): void {
  const now = new Date().toISOString();
  store.writeStory(storyId, {
    storyId,
    name: storyId,
    title: 'withdrawal fixture',
    description: 'withdrawal fixture story',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
  } as StoryInfo);
}

function seedChecklist(store: StoryStore, storyId: string, itemIds: string[]): void {
  const items = itemIds.map((id) => ({
    id,
    title: id,
    status: 'done' as const,
    startTime: null,
    endTime: null,
  }));
  store.writeChecklist(storyId, { items } as ChecklistData);
}

function seedContract(store: StoryStore, storyId: string, bindingIds: string[]): void {
  const now = new Date().toISOString();
  const contract: ProofStoryContractData = {
    schemaVersion: 'proofstory.contract.v1',
    storyId,
    diagnosticOnly: false,
    hardeningLevel: 'standard',
    triggerReasons: [],
    acceptanceBindings: bindingIds.map((id, i) => ({
      id,
      checklistRefs: [`CHK-00${i + 1}`],
      verificationIntentRefs: [`CHK-00${i + 1}:happy:0`],
      milestoneIds: [],
    })),
    diagnosticGaps: [],
    createdAt: now,
    updatedAt: now,
  };
  store.writeProofStoryContract(storyId, contract);
}

function run(): void {
  const root = mkdtempSync(join(tmpdir(), 'b1909-withdrawal-floor-'));
  try {
    const ctx = makeCtx(root);
    const store = ctx.store;
    const ps = createProofStoryHandlers(ctx);
    const chk = createChecklistHandlers(ctx);

    // ── Pure helpers + build ─────────────────────────────────────────────
    // Legacy decision (no new fields) loads and yields empty withdrawal sets.
    const legacy: ScopeShrinkageDecisionData = {
      schemaVersion: 'proofstory.scope_shrinkage_decision.v1',
      storyId: 'B-legacy',
      decision: 'rejected',
      userConfirmed: false,
      removedMilestoneIds: [],
      reason: 'legacy compat fixture',
      approvedBy: 'legacy',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(withdrawnChecklistItemIdsFrom(legacy).size, 0, 'legacy: no checklist withdrawals');
    assert.equal(withdrawnBindingIdsFrom(legacy).size, 0, 'legacy: no binding withdrawals');
    const legacyContract = { acceptanceBindings: [
      { id: 'AB-1', checklistRefs: [], verificationIntentRefs: [], milestoneIds: [] },
      { id: 'AB-2', checklistRefs: [], verificationIntentRefs: [], milestoneIds: [] },
    ] };
    assert.equal(
      effectiveAcceptanceBindings(legacyContract, legacy).length,
      2,
      'legacy contract with no dispositions keeps all bindings effective',
    );

    // decisionId generated + createdAt/decisionId preserved on update.
    const d1 = buildScopeShrinkageDecision({
      storyId: 'B-build', decision: 'confirmed', userConfirmed: true,
      reason: 'withdraw an item', approvedBy: 'op', withdrawnChecklistItemRefs: ['CHK-001'],
    });
    assert.ok(d1.decisionId && d1.decisionId.startsWith('SD-'), 'decisionId generated with SD- prefix');
    assert.deepEqual(d1.withdrawnChecklistItemRefs, ['CHK-001'], 'refs persisted');
    const d2 = buildScopeShrinkageDecision({
      storyId: 'B-build', decision: 'confirmed', userConfirmed: true,
      reason: 'now withdraw a binding', approvedBy: 'op', withdrawnAcceptanceBindingRefs: ['AB-1'],
    }, d1);
    assert.equal(d2.createdAt, d1.createdAt, 'createdAt preserved on update');
    assert.equal(d2.decisionId, d1.decisionId, 'decisionId preserved on update');

    // Confirmed with all three removal sets empty is rejected.
    assert.throws(
      () => buildScopeShrinkageDecision({ storyId: 'B-build', decision: 'confirmed', userConfirmed: true, reason: 'nothing', approvedBy: 'op' }),
      /at least one of/i,
      'confirmed decision with nothing to withdraw is rejected',
    );
    // Confirmed without userConfirmed is rejected even with a removal set.
    assert.throws(
      () => buildScopeShrinkageDecision({ storyId: 'B-build', decision: 'confirmed', reason: 'x', approvedBy: 'op', withdrawnChecklistItemRefs: ['CHK-001'] }),
      /userConfirmed/i,
      'confirmed decision without userConfirmed is rejected',
    );

    // ── Checklist-only withdrawal: layer independence, binding stays active ──
    const s1 = 'B-t001';
    seedStory(store, s1); seedChecklist(store, s1, ['CHK-001', 'CHK-002']); seedContract(store, s1, ['AB-1']);
    ps.scope_shrinkage_decision_set({
      storyId: s1, decision: 'confirmed', userConfirmed: true,
      reason: 'CHK-002 proved undeliverable', approvedBy: 'op', withdrawnChecklistItemRefs: ['CHK-002'],
    });
    const cl1 = store.readChecklist(s1);
    const dec1 = store.readScopeShrinkageDecision(s1)!;
    const withdrawnItem = cl1.items.find((i) => i.id === 'CHK-002')!;
    assert.equal(withdrawnItem.status, 'withdrawn', 'checklist item flipped to withdrawn');
    assert.equal(withdrawnItem.decisionRef, dec1.decisionId, 'item decisionRef equals decisionId');
    assert.equal(cl1.items.find((i) => i.id === 'CHK-001')!.status, 'done', 'other item unchanged');
    const contract1 = store.readProofStoryContract(s1)!;
    assert.equal((contract1.bindingDispositions ?? []).length, 0, 'binding-only layer untouched by item withdrawal');
    assert.equal(effectiveAcceptanceBindings(contract1, dec1).length, 1, 'binding stays active');

    // ── Binding-only withdrawal: append-only, original binding intact ────────
    const s2 = 'B-t002';
    seedStory(store, s2); seedChecklist(store, s2, ['CHK-001', 'CHK-002']); seedContract(store, s2, ['AB-1', 'AB-2']);
    ps.scope_shrinkage_decision_set({
      storyId: s2, decision: 'confirmed', userConfirmed: true,
      reason: 'AB-2 proved undeliverable', approvedBy: 'op', withdrawnAcceptanceBindingRefs: ['AB-2'],
    });
    const contract2 = store.readProofStoryContract(s2)!;
    const dec2 = store.readScopeShrinkageDecision(s2)!;
    assert.ok(contract2.acceptanceBindings.some((b) => b.id === 'AB-2'), 'original binding object preserved');
    assert.equal(contract2.bindingDispositions!.length, 1, 'one append-only disposition');
    assert.equal(contract2.bindingDispositions![0].bindingId, 'AB-2', 'disposition names the binding');
    assert.equal(contract2.bindingDispositions![0].decisionRef, dec2.decisionId, 'disposition decisionRef equals decisionId');
    assert.deepEqual(effectiveAcceptanceBindings(contract2, dec2).map((b) => b.id), ['AB-1'], 'effective excludes withdrawn binding');
    assert.ok(store.readChecklist(s2).items.every((i) => i.status === 'done'), 'checklist layer unchanged by binding withdrawal');

    // ── Empty-scope floor at WRITE time under default observe config ─────────
    const s3 = 'B-t003';
    seedStory(store, s3); seedChecklist(store, s3, ['CHK-001']); seedContract(store, s3, ['AB-1', 'AB-2']);
    assert.throws(
      () => ps.scope_shrinkage_decision_set({
        storyId: s3, decision: 'confirmed', userConfirmed: true,
        reason: 'withdraw everything', approvedBy: 'op', withdrawnAcceptanceBindingRefs: ['AB-1', 'AB-2'],
      }),
      /empty_scope_after_withdrawal/,
      'full withdrawal without re-approval is refused at write time',
    );
    assert.equal(store.readScopeShrinkageDecision(s3), null, 'refused floor wrote no decision');
    assert.equal((store.readProofStoryContract(s3)!.bindingDispositions ?? []).length, 0, 'refused floor wrote no disposition');
    // With explicit re-approval the full withdrawal is allowed.
    ps.scope_shrinkage_decision_set({
      storyId: s3, decision: 'confirmed', userConfirmed: true,
      reason: 'withdraw everything', approvedBy: 'op', withdrawnAcceptanceBindingRefs: ['AB-1', 'AB-2'],
      fullWithdrawalReapproval: { approvedBy: 'human', reason: 'story fully descoped, tracked in a successor story', at: new Date().toISOString() },
    });
    const contract3 = store.readProofStoryContract(s3)!;
    const dec3 = store.readScopeShrinkageDecision(s3)!;
    assert.equal(contract3.bindingDispositions!.length, 2, 'full withdrawal with re-approval recorded both dispositions');
    assert.equal(effectiveAcceptanceBindings(contract3, dec3).length, 0, 'effective set is empty after approved full withdrawal');

    // ── Bad ref mutates nothing ──────────────────────────────────────────────
    const s4 = 'B-t004';
    seedStory(store, s4); seedChecklist(store, s4, ['CHK-001']); seedContract(store, s4, ['AB-1', 'AB-2']);
    assert.throws(
      () => ps.scope_shrinkage_decision_set({ storyId: s4, decision: 'confirmed', userConfirmed: true, reason: 'bad binding', approvedBy: 'op', withdrawnAcceptanceBindingRefs: ['AB-NOPE'] }),
      /not an acceptance binding/,
      'unknown binding ref refused',
    );
    assert.throws(
      () => ps.scope_shrinkage_decision_set({ storyId: s4, decision: 'confirmed', userConfirmed: true, reason: 'bad item', approvedBy: 'op', withdrawnChecklistItemRefs: ['CHK-NOPE'] }),
      /not a checklist item/,
      'unknown checklist ref refused',
    );
    assert.equal(store.readScopeShrinkageDecision(s4), null, 'bad ref wrote no decision');
    assert.equal((store.readProofStoryContract(s4)!.bindingDispositions ?? []).length, 0, 'bad ref wrote no disposition');

    // ── Idempotency: re-applying the same decision converges ─────────────────
    const s5 = 'B-t005';
    seedStory(store, s5); seedChecklist(store, s5, ['CHK-001', 'CHK-002']); seedContract(store, s5, ['AB-1', 'AB-2']);
    const apply = () => ps.scope_shrinkage_decision_set({
      storyId: s5, decision: 'confirmed', userConfirmed: true, reason: 'idempotent apply', approvedBy: 'op',
      withdrawnChecklistItemRefs: ['CHK-002'], withdrawnAcceptanceBindingRefs: ['AB-2'],
    });
    apply(); apply();
    const contract5 = store.readProofStoryContract(s5)!;
    assert.equal(contract5.bindingDispositions!.length, 1, 're-application does not duplicate the disposition');
    assert.equal(store.readChecklist(s5).items.find((i) => i.id === 'CHK-002')!.status, 'withdrawn', 're-application converges on withdrawn');

    // ── checklist_update refuses a direct withdrawn write ───────────────────
    const s6 = 'B-t006';
    seedStory(store, s6); seedChecklist(store, s6, ['CHK-001']);
    assert.throws(
      () => chk.checklist_update({ storyId: s6, itemId: 'CHK-001', status: 'withdrawn' }),
      /scope_shrinkage_decision_set/,
      'direct checklist_update withdrawn is refused and redirects to the sole applier',
    );

    // ── F-009: evidenceRefs persists through the writer AND is returned by
    //     scope_shrinkage_decision_get (the CHK-003:happy:0 intent) ────────────
    const s7 = 'B-t007';
    seedStory(store, s7); seedChecklist(store, s7, ['CHK-001', 'CHK-002']); seedContract(store, s7, ['AB-1']);
    // AB-1 is bound to CHK-001 (positional seedContract), so withdrawing the
    // CHK-002 checklist item leaves AB-1 effective — no empty-scope trip.
    ps.scope_shrinkage_decision_set({
      storyId: s7, decision: 'confirmed', userConfirmed: true,
      reason: 'withdraw CHK-002 and record the authorizing audit evidence', approvedBy: 'op',
      withdrawnChecklistItemRefs: ['CHK-002'], evidenceRefs: ['B-bf52:F-062'],
    });
    const gotEvidence = JSON.parse(
      ps.scope_shrinkage_decision_get({ storyId: s7, json: true }),
    ) as ScopeShrinkageDecisionData;
    assert.deepEqual(
      gotEvidence.evidenceRefs, ['B-bf52:F-062'],
      'evidenceRefs persists and scope_shrinkage_decision_get returns it',
    );

    // ── F-001/F-002/F-007 regression (proving the committed union + immutable-id
    //     fix): two scope_shrinkage_decision_set calls under ONE decisionId must
    //     ACCUMULATE both withdrawal ref sets (union), and a conflicting caller
    //     decisionId must be REJECTED with the record left unchanged ────────────
    const s8 = 'B-t008';
    seedStory(store, s8); seedChecklist(store, s8, ['CHK-001', 'CHK-002']); seedContract(store, s8, ['AB-1', 'AB-2']);
    // Call 1: withdraw the CHK-002 checklist item (auto-generates the decisionId).
    ps.scope_shrinkage_decision_set({
      storyId: s8, decision: 'confirmed', userConfirmed: true,
      reason: 'call 1 withdraws the CHK-002 checklist item', approvedBy: 'op',
      withdrawnChecklistItemRefs: ['CHK-002'],
    });
    const storedId = store.readScopeShrinkageDecision(s8)!.decisionId!;
    assert.ok(storedId, 'call 1 stamped a decisionId');
    // Call 2: REUSE the stored decisionId, withdraw AB-1 (a binding) WITHOUT
    // repeating CHK-002. Pre-fix this reset withdrawnChecklistItemRefs to []; the
    // union fix must instead preserve CHK-002 and add AB-1. (AB-2 stays effective,
    // so no empty-scope trip.)
    ps.scope_shrinkage_decision_set({
      storyId: s8, decision: 'confirmed', userConfirmed: true,
      reason: 'call 2 withdraws AB-1 under the same decisionId', approvedBy: 'op',
      decisionId: storedId,
      withdrawnAcceptanceBindingRefs: ['AB-1'],
    });
    const accum = store.readScopeShrinkageDecision(s8)!;
    assert.equal(accum.decisionId, storedId, 'decisionId is stable across both calls');
    assert.deepEqual(
      accum.withdrawnChecklistItemRefs, ['CHK-002'],
      'call 2 does NOT reset the checklist ref set — union preserves CHK-002',
    );
    assert.deepEqual(
      accum.withdrawnAcceptanceBindingRefs, ['AB-1'],
      'call 2 accumulates the binding ref (union), not just the latest call',
    );
    // Both layers stay correctly stamped under the one decisionId.
    const accumChecklist = store.readChecklist(s8);
    const accumItem = accumChecklist.items.find((i) => i.id === 'CHK-002')!;
    assert.equal(accumItem.status, 'withdrawn', 'CHK-002 stays withdrawn after the second call');
    assert.equal(accumItem.decisionRef, storedId, 'CHK-002 cites the single decisionId');
    const accumContract = store.readProofStoryContract(s8)!;
    const ab1Disp = (accumContract.bindingDispositions ?? []).find((d) => d.bindingId === 'AB-1');
    assert.equal(ab1Disp?.disposition, 'withdrawn', 'AB-1 disposition recorded by the second call');
    assert.equal(ab1Disp?.decisionRef, storedId, 'AB-1 disposition cites the same single decisionId');
    // F-007: a third call passing a decisionId that DIFFERS from the stored one is
    // rejected, and the persisted record is left byte-identical.
    const beforeReject = JSON.stringify(store.readScopeShrinkageDecision(s8));
    assert.throws(
      () => ps.scope_shrinkage_decision_set({
        storyId: s8, decision: 'confirmed', userConfirmed: true,
        reason: 'a conflicting decisionId must be refused', approvedBy: 'op',
        decisionId: 'SD-conflicting', withdrawnChecklistItemRefs: ['CHK-002'],
      }),
      /immutable/i,
      'a caller decisionId conflicting with the stored one is rejected',
    );
    assert.equal(
      JSON.stringify(store.readScopeShrinkageDecision(s8)), beforeReject,
      'the rejected conflicting-id call left the decision record byte-identical',
    );

    for (const probe of ['probe-scope-checkpoint-compensation.mjs', 'probe-scope-checkpoint-interrupted.mjs', 'probe-closeout-busy-propagation.mjs', 'probe-scope-transaction-boundaries.mjs']) {
      execFileSync(process.execPath, ['scripts/' + probe, '--scenario=scope-write-failure'], { cwd: probeRepo, stdio: 'inherit', timeout: 120_000 });
    }
    execFileSync(process.execPath, ['scripts/probe-closeout-busy-propagation.mjs', '--ordinary'], { cwd: probeRepo, stdio: 'inherit', timeout: 120_000 });
    console.log('scope-shrinkage-withdrawal-floor-smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

run();
