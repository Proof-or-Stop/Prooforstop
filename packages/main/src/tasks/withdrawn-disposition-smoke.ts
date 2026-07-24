#!/usr/bin/env node
/**
 * End-to-end both-direction smoke for B-1909 withdrawn dispositions.
 *
 * @task B-1909
 * @checklist CHK-007
 * @title Smoke both directions of the recorded acceptance (withdrawn disposition)
 * @type feature
 * @priority high
 * @description
 *   Drives the real scope-shrinkage / checklist / proofstory handlers (no CLI
 *   spawn, no PLAN return) to prove BOTH directions of the withdrawn-disposition
 *   contract implemented in commits 22975c138d + e8b846a3e9:
 *
 *   POSITIVE — a confirmed + userConfirmed scope_shrinkage_decision_set that
 *   lists CHK-nnn in withdrawnChecklistItemRefs and AB-mmm in
 *   withdrawnAcceptanceBindingRefs makes checklist_get report CHK-nnn WITHDRAWN
 *   (status='withdrawn' + decisionRef, never 'done') and proofstory_contract_get
 *   report AB-mmm withdrawn (an append-only bindingDisposition present) while the
 *   original acceptanceBindings[AB-mmm] object survives byte-for-byte. Proven
 *   from story phase DEV and phase REVIEW.
 *
 *   NEGATIVE — done still counts as delivered while withdrawn is excluded from
 *   the delivered/done/completed counts; a direct checklist_update status
 *   'withdrawn' is refused and names scope_shrinkage_decision_set; a decision
 *   naming a non-existent checklist item or a non-existent binding is refused and
 *   mutates nothing; the two layers are independent (a checklist-only decision
 *   leaves the binding active, a binding-only decision leaves the item
 *   unchanged); the original binding survives append-only; and withdrawing every
 *   acceptance binding is HARD-REFUSED at write time under the DEFAULT observe
 *   config (independent of doneGateMode) unless an explicit fullWithdrawalReapproval
 *   is recorded.
 *
 *   The focused write-time floor / helper proof lives in
 *   scope-shrinkage-withdrawal-floor-smoke.ts; this file is the broader
 *   end-to-end assertion that also exercises the read/render handlers.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { createChecklistHandlers, summarizeChecklist } from '../handlers/checklist.js';
import { effectiveAcceptanceBindings } from '../core/proofstory.js';
import type { HandlerContext } from '../handlers/context.js';
import type {
  ChecklistData,
  ProofStoryContractData,
  StoryInfo,
} from '../core/types.js';

function makeCtx(root: string): HandlerContext {
  return { store: new StoryStore(root), root, scanRoot: root } as HandlerContext;
}

function seedStory(store: StoryStore, storyId: string, phase: StoryInfo['phase']): void {
  const now = new Date().toISOString();
  store.writeStory(storyId, {
    storyId,
    name: storyId,
    title: 'withdrawn disposition fixture',
    description: 'withdrawn disposition fixture story',
    type: 'feature',
    phase,
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

function seedContract(
  store: StoryStore,
  storyId: string,
  bindings: Array<{ id: string; checklistRefs: string[] }>,
): void {
  const now = new Date().toISOString();
  const contract: ProofStoryContractData = {
    schemaVersion: 'proofstory.contract.v1',
    storyId,
    diagnosticOnly: false,
    hardeningLevel: 'standard',
    triggerReasons: [],
    acceptanceBindings: bindings.map((b) => ({
      id: b.id,
      checklistRefs: b.checklistRefs,
      verificationIntentRefs: b.checklistRefs.map((ref) => `${ref}:happy:0`),
      milestoneIds: [],
    })),
    diagnosticGaps: [],
    createdAt: now,
    updatedAt: now,
  };
  store.writeProofStoryContract(storyId, contract);
}

type Handles = {
  store: StoryStore;
  ps: ReturnType<typeof createProofStoryHandlers>;
  chk: ReturnType<typeof createChecklistHandlers>;
};

function contractViaGet(ps: Handles['ps'], storyId: string): ProofStoryContractData {
  const rendered = ps.proofstory_contract_get({ storyId, json: true }) as string;
  return JSON.parse(rendered) as ProofStoryContractData;
}

function checklistViaGet(chk: Handles['chk'], storyId: string): ChecklistData {
  return chk.checklist_get({ storyId }) as ChecklistData;
}

/**
 * POSITIVE direction from a given phase: withdraw CHK-002 (a checklist item) and
 * AB-1 (the binding bound to it) under one confirmed + userConfirmed decision;
 * AB-2 stays effective so the write-time empty-scope floor is satisfied.
 */
function assertPositiveWithdrawal(h: Handles, storyId: string, phase: StoryInfo['phase']): void {
  seedStory(h.store, storyId, phase);
  seedChecklist(h.store, storyId, ['CHK-001', 'CHK-002']);
  seedContract(h.store, storyId, [
    { id: 'AB-1', checklistRefs: ['CHK-002'] },
    { id: 'AB-2', checklistRefs: ['CHK-001'] },
  ]);

  // Capture the ORIGINAL bound binding object BEFORE any withdrawal so we can
  // prove it survives byte-for-byte (append-only, never mutated in place).
  const originalAb1Json = JSON.stringify(
    h.store.readProofStoryContract(storyId)!.acceptanceBindings.find((b) => b.id === 'AB-1'),
  );

  h.ps.scope_shrinkage_decision_set({
    storyId,
    decision: 'confirmed',
    userConfirmed: true,
    reason: `CHK-002 + AB-1 proved undeliverable in ${phase}`,
    approvedBy: 'operator',
    withdrawnChecklistItemRefs: ['CHK-002'],
    withdrawnAcceptanceBindingRefs: ['AB-1'],
  });

  const decisionId = h.store.readScopeShrinkageDecision(storyId)!.decisionId;
  assert.ok(decisionId, `${phase}: a decisionId is stamped`);

  // checklist_get shows CHK-002 WITHDRAWN (status + decisionRef), never DONE.
  const cl = checklistViaGet(h.chk, storyId);
  const withdrawnItem = cl.items.find((i) => i.id === 'CHK-002')!;
  assert.equal(withdrawnItem.status, 'withdrawn', `${phase}: checklist_get shows CHK-002 withdrawn`);
  assert.notEqual(withdrawnItem.status, 'done', `${phase}: withdrawn item is never rendered as done`);
  assert.equal(withdrawnItem.decisionRef, decisionId, `${phase}: withdrawn item carries the decisionRef`);
  assert.equal(cl.items.find((i) => i.id === 'CHK-001')!.status, 'done', `${phase}: untouched item stays done`);

  // proofstory_contract_get shows AB-1 withdrawn (a bindingDisposition present)
  // while the ORIGINAL binding object is unchanged.
  const contract = contractViaGet(h.ps, storyId);
  const disposition = (contract.bindingDispositions ?? []).find((d) => d.bindingId === 'AB-1');
  assert.ok(disposition, `${phase}: proofstory_contract_get shows an AB-1 disposition`);
  assert.equal(disposition!.disposition, 'withdrawn', `${phase}: disposition is 'withdrawn'`);
  assert.equal(disposition!.decisionRef, decisionId, `${phase}: disposition cites the same decisionId`);
  const survivedAb1Json = JSON.stringify(contract.acceptanceBindings.find((b) => b.id === 'AB-1'));
  assert.equal(survivedAb1Json, originalAb1Json, `${phase}: original AB-1 binding object survives byte-for-byte`);

  // The effective (non-withdrawn) binding projection excludes AB-1, keeps AB-2.
  assert.deepEqual(
    effectiveAcceptanceBindings(contract, h.store.readScopeShrinkageDecision(storyId)).map((b) => b.id),
    ['AB-2'],
    `${phase}: effective bindings exclude the withdrawn AB-1`,
  );
}

function run(): void {
  const root = mkdtempSync(join(tmpdir(), 'b1909-withdrawn-disposition-'));
  try {
    // A fresh temp root carries NO lattice.config.json, so config resolves to
    // defaults — proofStory gate mode = observe. Every refusal below therefore
    // holds under the DEFAULT observe config and is independent of doneGateMode
    // (the write-time floor never reads it).
    const ctx = makeCtx(root);
    const h: Handles = {
      store: ctx.store,
      ps: createProofStoryHandlers(ctx),
      chk: createChecklistHandlers(ctx),
    };

    // ── POSITIVE: withdrawal recorded + rendered from DEV and from REVIEW ─────
    assertPositiveWithdrawal(h, 'B-pos-dev', 'DEV');
    assertPositiveWithdrawal(h, 'B-pos-review', 'REVIEW');

    // ── NEGATIVE: done still delivered; withdrawn excluded from counts ────────
    // Reuse the DEV positive story: CHK-001 done, CHK-002 withdrawn.
    const slim = h.chk.checklist_get({ storyId: 'B-pos-dev', slim: true }) as {
      counts: ReturnType<typeof summarizeChecklist>;
    };
    assert.equal(slim.counts.total, 2, 'counts: total items = 2');
    assert.equal(slim.counts.done, 1, 'counts: done stays delivered-only (CHK-001), not 2');
    assert.equal(slim.counts.withdrawn, 1, 'counts: withdrawn surfaced separately (CHK-002)');
    assert.equal(slim.counts.pending, 0, 'counts: nothing pending');
    assert.equal(slim.counts.inProgress, 0, 'counts: nothing in progress');
    // Cross-check the canonical summarize path directly.
    const summary = summarizeChecklist(h.store.readChecklist('B-pos-dev'));
    assert.equal(summary.done, 1, 'summarizeChecklist: withdrawn is not counted as done/delivered');
    assert.equal(summary.withdrawn, 1, 'summarizeChecklist: withdrawn has its own count');

    // ── NEGATIVE: direct checklist_update status='withdrawn' is refused ───────
    const sDirect = 'B-neg-direct';
    seedStory(h.store, sDirect, 'DEV');
    seedChecklist(h.store, sDirect, ['CHK-001']);
    assert.throws(
      () => h.chk.checklist_update({ storyId: sDirect, itemId: 'CHK-001', status: 'withdrawn' as never }),
      /scope_shrinkage_decision_set/,
      'direct checklist_update withdrawn is refused and names the sole applier',
    );
    assert.equal(
      h.store.readChecklist(sDirect).items[0].status,
      'done',
      'refused direct withdrawn wrote nothing (item stays done)',
    );

    // ── NEGATIVE: decision naming a non-existent checklist item is refused ────
    const sBadItem = 'B-neg-bad-item';
    seedStory(h.store, sBadItem, 'DEV');
    seedChecklist(h.store, sBadItem, ['CHK-001']);
    seedContract(h.store, sBadItem, [{ id: 'AB-1', checklistRefs: ['CHK-001'] }]);
    assert.throws(
      () => h.ps.scope_shrinkage_decision_set({
        storyId: sBadItem, decision: 'confirmed', userConfirmed: true,
        reason: 'names an unknown item', approvedBy: 'operator',
        withdrawnChecklistItemRefs: ['CHK-NOPE'],
      }),
      /not a checklist item/,
      'decision naming a non-existent checklist item is refused',
    );
    assert.equal(h.store.readScopeShrinkageDecision(sBadItem), null, 'bad-item refusal wrote no decision');
    assert.equal(
      (h.store.readProofStoryContract(sBadItem)!.bindingDispositions ?? []).length,
      0,
      'bad-item refusal wrote no disposition',
    );
    assert.equal(h.store.readChecklist(sBadItem).items[0].status, 'done', 'bad-item refusal left checklist intact');

    // ── NEGATIVE: decision naming a non-existent binding is refused ───────────
    const sBadBinding = 'B-neg-bad-binding';
    seedStory(h.store, sBadBinding, 'DEV');
    seedChecklist(h.store, sBadBinding, ['CHK-001']);
    seedContract(h.store, sBadBinding, [{ id: 'AB-1', checklistRefs: ['CHK-001'] }]);
    assert.throws(
      () => h.ps.scope_shrinkage_decision_set({
        storyId: sBadBinding, decision: 'confirmed', userConfirmed: true,
        reason: 'names an unknown binding', approvedBy: 'operator',
        withdrawnAcceptanceBindingRefs: ['AB-NOPE'],
      }),
      /not an acceptance binding/,
      'decision naming a non-existent binding is refused',
    );
    assert.equal(h.store.readScopeShrinkageDecision(sBadBinding), null, 'bad-binding refusal wrote no decision');
    assert.equal(
      (h.store.readProofStoryContract(sBadBinding)!.bindingDispositions ?? []).length,
      0,
      'bad-binding refusal wrote no disposition',
    );

    // ── NEGATIVE: layer independence — checklist ref only ─────────────────────
    const sItemOnly = 'B-neg-item-only';
    seedStory(h.store, sItemOnly, 'DEV');
    seedChecklist(h.store, sItemOnly, ['CHK-001', 'CHK-002']);
    seedContract(h.store, sItemOnly, [{ id: 'AB-1', checklistRefs: ['CHK-002'] }]);
    h.ps.scope_shrinkage_decision_set({
      storyId: sItemOnly, decision: 'confirmed', userConfirmed: true,
      reason: 'withdraw only the checklist item', approvedBy: 'operator',
      withdrawnChecklistItemRefs: ['CHK-002'],
    });
    const itemOnlyContract = contractViaGet(h.ps, sItemOnly);
    assert.equal(
      checklistViaGet(h.chk, sItemOnly).items.find((i) => i.id === 'CHK-002')!.status,
      'withdrawn',
      'item-only decision withdraws the checklist item',
    );
    assert.equal(
      (itemOnlyContract.bindingDispositions ?? []).length,
      0,
      'item-only decision leaves the binding layer untouched',
    );
    assert.equal(
      effectiveAcceptanceBindings(itemOnlyContract, h.store.readScopeShrinkageDecision(sItemOnly)).length,
      1,
      'item-only decision keeps the bound binding active (no silent cross-cancellation)',
    );

    // ── NEGATIVE: layer independence — binding ref only ───────────────────────
    const sBindingOnly = 'B-neg-binding-only';
    seedStory(h.store, sBindingOnly, 'DEV');
    seedChecklist(h.store, sBindingOnly, ['CHK-001', 'CHK-002']);
    seedContract(h.store, sBindingOnly, [
      { id: 'AB-1', checklistRefs: ['CHK-001'] },
      { id: 'AB-2', checklistRefs: ['CHK-002'] },
    ]);
    const originalAb2Json = JSON.stringify(
      h.store.readProofStoryContract(sBindingOnly)!.acceptanceBindings.find((b) => b.id === 'AB-2'),
    );
    h.ps.scope_shrinkage_decision_set({
      storyId: sBindingOnly, decision: 'confirmed', userConfirmed: true,
      reason: 'withdraw only the binding', approvedBy: 'operator',
      withdrawnAcceptanceBindingRefs: ['AB-2'],
    });
    const bindingOnlyContract = contractViaGet(h.ps, sBindingOnly);
    assert.ok(
      h.store.readChecklist(sBindingOnly).items.every((i) => i.status === 'done'),
      'binding-only decision leaves every checklist item unchanged',
    );
    assert.equal(
      (bindingOnlyContract.bindingDispositions ?? []).find((d) => d.bindingId === 'AB-2')?.disposition,
      'withdrawn',
      'binding-only decision records the AB-2 disposition',
    );
    assert.equal(
      JSON.stringify(bindingOnlyContract.acceptanceBindings.find((b) => b.id === 'AB-2')),
      originalAb2Json,
      'binding-only: original AB-2 binding object survives byte-for-byte (append-only)',
    );
    assert.deepEqual(
      effectiveAcceptanceBindings(bindingOnlyContract, h.store.readScopeShrinkageDecision(sBindingOnly)).map((b) => b.id),
      ['AB-1'],
      'binding-only: effective set excludes the withdrawn AB-2',
    );

    // ── NEGATIVE: emptying the effective binding set is refused without,
    //     and allowed with, an explicit fullWithdrawalReapproval ──────────────
    const sEmpty = 'B-neg-empty-scope';
    seedStory(h.store, sEmpty, 'DEV');
    seedChecklist(h.store, sEmpty, ['CHK-001']);
    seedContract(h.store, sEmpty, [
      { id: 'AB-1', checklistRefs: ['CHK-001'] },
      { id: 'AB-2', checklistRefs: ['CHK-001'] },
    ]);
    assert.throws(
      () => h.ps.scope_shrinkage_decision_set({
        storyId: sEmpty, decision: 'confirmed', userConfirmed: true,
        reason: 'withdraw every binding', approvedBy: 'operator',
        withdrawnAcceptanceBindingRefs: ['AB-1', 'AB-2'],
      }),
      /empty_scope_after_withdrawal/,
      'full binding withdrawal without re-approval is HARD-REFUSED at write time (default observe)',
    );
    assert.equal(h.store.readScopeShrinkageDecision(sEmpty), null, 'empty-scope refusal wrote no decision');
    assert.equal(
      (h.store.readProofStoryContract(sEmpty)!.bindingDispositions ?? []).length,
      0,
      'empty-scope refusal wrote no disposition',
    );
    // WITH explicit re-approval the full withdrawal is allowed.
    h.ps.scope_shrinkage_decision_set({
      storyId: sEmpty, decision: 'confirmed', userConfirmed: true,
      reason: 'withdraw every binding', approvedBy: 'operator',
      withdrawnAcceptanceBindingRefs: ['AB-1', 'AB-2'],
      fullWithdrawalReapproval: {
        approvedBy: 'human',
        reason: 'story fully descoped; tracked in a successor story',
        at: new Date().toISOString(),
      },
    });
    const emptyContract = contractViaGet(h.ps, sEmpty);
    assert.equal(
      (emptyContract.bindingDispositions ?? []).length,
      2,
      'approved full withdrawal records both dispositions',
    );
    assert.equal(
      effectiveAcceptanceBindings(emptyContract, h.store.readScopeShrinkageDecision(sEmpty)).length,
      0,
      'approved full withdrawal empties the effective set',
    );

    console.log('withdrawn-disposition-smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

run();
