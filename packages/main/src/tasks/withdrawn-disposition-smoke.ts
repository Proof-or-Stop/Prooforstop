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
import {acquireOwnerLease,releaseOwnerLease} from '../core/story-owner-lease.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { createChecklistHandlers, summarizeChecklist } from '../handlers/checklist.js';
import { createStoryQueryHandlers } from '../handlers/story-query.js';
import { createSessionHandlers } from '../handlers/session.js';
import { decorateResult } from '../handlers/hints.js';
import { effectiveAcceptanceBindings } from '../core/proofstory.js';
import { buildMilestoneStatusReport } from '../core/milestone-status.js';
import { checklistAllDoneGuard } from '../core/machine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import type { HandlerContext } from '../handlers/context.js';
import type {
  ChecklistData,
  MilestoneLedgerData,
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

/**
 * F-006: session_brief (session.ts) must render a withdrawn item as WITHDRAWN,
 * never DONE, and exclude it from the delivered/done tally. session_brief only
 * renders the active-story checklist when it detects a `story/<id>` branch, so
 * this needs a real git-backed root (the public handler surface — never the
 * module-private summarizeChecklist copy).
 */
function assertSessionBriefExcludesWithdrawn(): void {
  const root = mkdtempSync(join(tmpdir(), 'b1909-session-brief-'));
  try {
    const git = (...gitArgs: string[]): void => {
      execFileSync('git', gitArgs, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    };
    git('init', '-q');
    git('config', 'user.email', 'smoke@noreply.local');
    git('config', 'user.name', 'smoke');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, '.gitkeep'), '');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'story/B-sess');

    const ctx = makeCtx(root);
    const h: Handles = {
      store: ctx.store,
      ps: createProofStoryHandlers(ctx),
      chk: createChecklistHandlers(ctx),
    };
    const session = createSessionHandlers(ctx);

    seedStory(h.store, 'B-sess', 'DEV');
    seedChecklist(h.store, 'B-sess', ['CHK-001', 'CHK-002']);
    seedContract(h.store, 'B-sess', [
      { id: 'AB-1', checklistRefs: ['CHK-002'] },
      { id: 'AB-2', checklistRefs: ['CHK-001'] },
    ]);
    // Withdraw CHK-002 through the REAL applier so the fixture is genuine.
    h.ps.scope_shrinkage_decision_set({
      storyId: 'B-sess', decision: 'confirmed', userConfirmed: true,
      reason: 'CHK-002 proved undeliverable', approvedBy: 'operator',
      withdrawnChecklistItemRefs: ['CHK-002'],
    });

    const brief = session.session_brief({ concise: true });
    assert.ok(
      /## Checklist \(1\/2 done, 1 withdrawn\)/.test(brief),
      'session_brief header counts done DELIVERED-only (1/2) and surfaces withdrawn separately',
    );
    assert.ok(!/2\/2 done/.test(brief), 'session_brief never folds the withdrawn item into the done tally');
    assert.ok(/withdrawn \(1\):/.test(brief), 'session_brief renders a dedicated withdrawn block');
    assert.ok(
      !/CHK-002.*\bdone\b/i.test(brief),
      'session_brief never labels the withdrawn CHK-002 as done',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'b1909-withdrawn-disposition-'));
  try {
    // A fresh temp root carries NO proof-or-stop.config.json, so config resolves to
    // defaults — proofStory gate mode = observe. Every refusal below therefore
    // holds under the DEFAULT observe config and is independent of doneGateMode
    // (the write-time floor never reads it).
    const ctx = makeCtx(root);
    const h: Handles = {
      store: ctx.store,
      ps: createProofStoryHandlers(ctx),
      chk: createChecklistHandlers(ctx),
    };

    // ── CHK-004 ADVERSARIAL: the PLAN freeze is intact ───────────────────────
    // proofstory_contract_set stays PLAN-only (the frozen binding writer), while
    // the append-only correction path (scope_shrinkage_decision_set) is the one
    // that reaches DEV/REVIEW/TEST. This proves the freeze was NOT relaxed to add
    // the withdrawal capability.
    assert.deepEqual(
      COMMAND_POLICIES['proofstory_contract_set'].allowedPhases,
      ['PLAN'],
      'proofstory_contract_set stays PLAN-frozen',
    );
    for (const phase of ['DEV', 'REVIEW', 'TEST'] as const) {
      assert.ok(
        (COMMAND_POLICIES['scope_shrinkage_decision_set'].allowedPhases as readonly string[]).includes(phase),
        `scope_shrinkage_decision_set (the post-PLAN correction path) reaches ${phase}`,
      );
    }

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

    // ── F-004: the OTHER named count consumers ALSO exclude withdrawn ─────────
    // CHK-002:edge:0 names 5 counting sites; the block above only covered
    // checklist.ts. Prove the remaining load-bearing sites through their REAL
    // public handlers / exported functions (never the module-private
    // summarizeChecklist copies in story-query / session / hints). Reuse
    // B-pos-dev: CHK-001 done, CHK-002 withdrawn under a real decision.
    const sq = createStoryQueryHandlers(ctx);

    // story-query.ts story_list projection (clDone/clTotal path): clDone counts
    // DELIVERED (done) only, withdrawn surfaced as a separate `+Nw` suffix, so a
    // withdrawn item is never counted as done nor left looking permanently stuck.
    const devRows = sq.story_list({ phase: 'DEV' }) as Array<{ storyId: string; checklist: string }>;
    const posDevRow = devRows.find((r) => r.storyId === 'B-pos-dev')!;
    assert.ok(posDevRow, 'story_list surfaces the seeded DEV story');
    assert.equal(
      posDevRow.checklist,
      '1/2 +1w',
      'story_list clDone counts done-only (1/2), withdrawn shown separately (+1w), never counted as done',
    );

    // hints.ts checklist_update hint path (via the exported decorateResult
    // consumer). With CHK-001 done + CHK-002 withdrawn the summary is all-TERMINAL
    // (allDone), so the hint is the advancement hint — proving withdrawn is NOT
    // bucketed as pending/outstanding (which would instead emit a "下一项" hint
    // naming CHK-002 and keep the story looking incomplete).
    const hint = decorateResult({
      cmd: 'checklist_update',
      args: { storyId: 'B-pos-dev', status: 'done' },
      result: 'CHK-001 marked done',
      store: h.store,
      root,
      activeStory: null,
    });
    assert.equal(typeof hint, 'string', 'checklist_update hint decorates the result');
    const hintText = hint as string;
    assert.ok(
      hintText.includes('所有 2 个 item 已 done'),
      'hint fires the all-terminal advancement path (withdrawn counted as terminal, not outstanding)',
    );
    assert.ok(hintText.includes('REVIEW'), 'DEV all-terminal hint points at REVIEW');
    assert.ok(
      !hintText.includes('下一项'),
      'hint never proposes a next pending item — withdrawn is not bucketed as pending',
    );
    assert.ok(
      !hintText.includes('CHK-002'),
      'the withdrawn CHK-002 is never surfaced by the hint as an outstanding item',
    );

    // core/milestone-status.ts buildMilestoneStatusReport (exported): a milestone
    // whose checklistRef points at a withdrawn item treats it as TERMINAL — no
    // "still ${status}" incompleteness risk, no "Complete checklist item" next
    // action, and checklist=complete in statusDetail (the checklistRefsComplete
    // change). Built from the REAL withdrawn checklist for B-pos-dev.
    const posDevStory = h.store.readStory('B-pos-dev');
    const posDevChecklist = h.store.readChecklist('B-pos-dev');
    const withdrawnLedger: MilestoneLedgerData = {
      schemaVersion: 'proofstory.milestone_ledger.v1',
      storyId: 'B-pos-dev',
      state: 'confirmed',
      milestones: [{
        id: 'M-1',
        sourceRequirementId: 'REQ-1',
        claim: 'delivers CHK-002',
        doneMeans: 'CHK-002 accounted for',
        requiredEvidence: [],
        checklistRefs: ['CHK-002'],
        verificationIntentRefs: [],
        status: 'covered',
      }],
      createdAt: posDevStory.createdAt,
      updatedAt: posDevStory.createdAt,
    };
    const withdrawnReport = buildMilestoneStatusReport({
      story: posDevStory,
      checklist: posDevChecklist,
      milestoneLedger: withdrawnLedger,
    });
    const withdrawnSub = withdrawnReport.milestones[0].subObjectives.find((s) => s.id === 'CHK-002')!;
    assert.equal(withdrawnSub.status, 'withdrawn', 'milestone subObjective mirrors the withdrawn status');
    assert.equal(withdrawnSub.risks.length, 0, 'a withdrawn checklist ref raises no incompleteness risk');
    assert.ok(
      !withdrawnReport.risks.some((r) => /Checklist item CHK-002 is/.test(r)),
      'milestone_status raises no "Checklist item CHK-002 is ..." risk for a terminal withdrawn ref',
    );
    assert.ok(
      !withdrawnReport.nextActions.some((a) => /Complete checklist item CHK-002/.test(a)),
      'milestone_status proposes no "Complete checklist item CHK-002" action for a withdrawn ref',
    );
    assert.ok(
      /checklist=complete/.test(withdrawnReport.milestones[0].statusDetail),
      'withdrawn ref counts as TERMINAL toward checklistRefsComplete (statusDetail=complete)',
    );
    // CONTROL differential: the SAME milestone against a NON-terminal CHK-002
    // DOES raise the incompleteness risk + next action + checklist=incomplete,
    // proving the withdrawn-terminal branch above is load-bearing, not vacuous.
    const inProgressChecklist: ChecklistData = {
      items: posDevChecklist.items.map((it) =>
        it.id === 'CHK-002' ? { ...it, status: 'in_progress' as const } : it,
      ),
    };
    const controlReport = buildMilestoneStatusReport({
      story: posDevStory,
      checklist: inProgressChecklist,
      milestoneLedger: withdrawnLedger,
    });
    assert.ok(
      controlReport.risks.some((r) => /Checklist item CHK-002 is in_progress/.test(r)),
      'control: a non-terminal CHK-002 DOES raise the incompleteness risk (branch is load-bearing)',
    );
    assert.ok(
      /checklist=incomplete/.test(controlReport.milestones[0].statusDetail),
      'control: a non-terminal CHK-002 keeps the milestone checklist=incomplete',
    );

    // ── F-006: story_get + session_brief renderers NEVER show withdrawn as DONE ─
    // story_get (story-query.ts) returns the checklist projection; the withdrawn
    // item renders as status='withdrawn' with its decisionRef, never 'done'.
    const posDevGet = sq.story_get({ storyId: 'B-pos-dev' }) as { checklist: ChecklistData };
    const getItem = posDevGet.checklist.items.find((i) => i.id === 'CHK-002')!;
    assert.equal(getItem.status, 'withdrawn', 'story_get renders CHK-002 as withdrawn');
    assert.notEqual(getItem.status, 'done', 'story_get never labels the withdrawn item DONE');
    assert.ok(getItem.decisionRef, 'story_get surfaces the withdrawn item decisionRef (terminal, authorized)');
    // session_brief (session.ts) is exercised in its own git-backed root below.
    assertSessionBriefExcludesWithdrawn();

    // ── F-008: the userConfirmed authority refusal fires at the HANDLER level ──
    // The existing evidence only exercised the pure buildScopeShrinkageDecision()
    // fn (in the floor smoke). Drive the refusals through ps.scope_shrinkage_decision_set
    // (the real handler) and prove nothing is mutated.
    const sAuth = 'B-neg-authority';
    seedStory(h.store, sAuth, 'DEV');
    seedChecklist(h.store, sAuth, ['CHK-001']);
    seedContract(h.store, sAuth, [{ id: 'AB-1', checklistRefs: ['CHK-001'] }]);
    // (a) decision='confirmed' with userConfirmed omitted/false + a real ref is
    // refused at the handler, mutating nothing.
    assert.throws(
      () => h.ps.scope_shrinkage_decision_set({
        storyId: sAuth, decision: 'confirmed', userConfirmed: false,
        reason: 'attempt to withdraw without user confirmation', approvedBy: 'operator',
        withdrawnChecklistItemRefs: ['CHK-001'],
      }),
      /userConfirmed/i,
      'handler refuses a confirmed withdrawal missing userConfirmed',
    );
    assert.equal(h.store.readScopeShrinkageDecision(sAuth), null, 'authority refusal (a) wrote no decision');
    assert.equal(h.store.readChecklist(sAuth).items[0].status, 'done', 'authority refusal (a) left the item done');
    assert.equal(
      (h.store.readProofStoryContract(sAuth)!.bindingDispositions ?? []).length,
      0,
      'authority refusal (a) wrote no disposition',
    );
    // (b) the handler's OWN defense-in-depth authority guard: decision='rejected'
    // with withdrawal refs does NOT throw inside buildScopeShrinkageDecision (a
    // rejected decision needs no userConfirmed / removal set), so it exclusively
    // exercises the handler-level `hasWithdrawals && !(confirmed&&userConfirmed)`
    // check — the very site F-008 flagged as never covered.
    assert.throws(
      () => h.ps.scope_shrinkage_decision_set({
        storyId: sAuth, decision: 'rejected',
        reason: 'reject yet still name a withdrawal ref', approvedBy: 'operator',
        withdrawnChecklistItemRefs: ['CHK-001'],
      }),
      /require decision=confirmed with userConfirmed/,
      'handler defense-in-depth refuses withdrawal refs on a rejected decision',
    );
    assert.equal(h.store.readScopeShrinkageDecision(sAuth), null, 'authority refusal (b) wrote no decision');
    assert.equal(h.store.readChecklist(sAuth).items[0].status, 'done', 'authority refusal (b) left the item done');

    // ── CHK-002 HAPPY: withdrawn is TERMINAL for advancement, not just excluded ─
    // A checklist of done + withdrawn items satisfies the DEV→REVIEW every-item
    // terminal guard (withdrawn is recorded-undeliverable, no longer outstanding).
    const sGuard = 'B-guard-terminal';
        execFileSync('git',['init','-b','main'],{cwd:root,stdio:'ignore'});
        execFileSync('git',['config','user.email','withdrawn@example.invalid'],{cwd:root});
        execFileSync('git',['config','user.name','Withdrawn Fixture'],{cwd:root});
    seedStory(h.store, sGuard, 'DEV');
    h.store.writeChecklist(sGuard, {
      items: [
        { id: 'CHK-001', title: 'CHK-001', status: 'done', startTime: null, endTime: null, verificationIntent: { happy: [{ desc: 'Completed sibling remains terminal alongside a withdrawn item', type: 'logic', priority: 'must' }] } },
        { id: 'CHK-002', title: 'CHK-002', status: 'withdrawn', decisionRef: 'SD-terminal-fixture', startTime: null, endTime: null },
      ],
    } as ChecklistData);
execFileSync('git',['add','.'],{cwd:root});
        execFileSync('git',['commit','-m','guard fixture'],{cwd:root,stdio:'ignore'});
        acquireOwnerLease(h.store.storyDirPath(sGuard),{command:'verification_evidence_add',cwd:root});
        try{await h.chk.verification_evidence_add({storyId:sGuard,itemId:'CHK-001',intentRef:'CHK-001:happy:0',kind:'logic_test',result:'pass',command: `node -e "const c=require('fs').readFileSync('${h.store.storyDirPath(sGuard)}/checklist.json','utf8');const a=JSON.parse(c).items;require('assert').deepEqual(a.map(x=>x.status),['done','withdrawn']);console.log('WITHDRAWN_SIBLING_OK')"`,selector:'WITHDRAWN_SIBLING_OK',note:'Actual stored terminal sibling and withdrawn item verified'});}finally{releaseOwnerLease(h.store.storyDirPath(sGuard));}
    assert.equal(
      checklistAllDoneGuard({ store: h.store, storyId: sGuard, projectRoot: root }),
      true,
      'checklistAllDoneGuard advances a done+withdrawn checklist (withdrawn is terminal)',
    );

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

await run();
