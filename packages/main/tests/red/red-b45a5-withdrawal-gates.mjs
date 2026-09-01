#!/usr/bin/env node
/**
 * RED artifact (B-45a5, CHK-001) — BOTH REVIEW-path gates are blind to an
 * ITEM-LEVEL withdrawal that a confirmed scope-shrinkage decision authorized.
 *
 * `withdrawnChecklistItemIdsFrom(decision)` (core/proofstory.ts) already resolves
 * exactly this set from the DECISION RECORD, and the sole applier already flips
 * the item and stamps its `decisionRef`. Neither gate ever asks:
 *
 *   - `evaluateReviewCompleteness` (core/proofstory.ts) subtracts withdrawn
 *     ACCEPTANCE BINDINGS via `effectiveAcceptanceBindings`, then requires every
 *     intent ref of every SURVIVING binding. A binding that covers a delivered
 *     item AND a withdrawn item survives, so the withdrawn item's intents are
 *     still demanded and come back as `review_completeness_missing_evidence`.
 *   - `checkDispatchEvidence` (handlers/validate-channel.ts) has no withdrawal
 *     awareness of any kind — its opts carry no decision at all — so the
 *     withdrawn item is reported as having no dispatch/subagent_result evidence.
 *
 * ── WHY THE WITHDRAWN ITEM MUST SHARE A BINDING ─────────────────────────────
 *
 * An item withdrawn together with its whole binding is already excluded, for a
 * reason that has nothing to do with item-level withdrawal. Such a fixture would
 * go green on a fix that changes nothing. The subject fixture here therefore
 * binds the withdrawn item and a DELIVERED item to one acceptance binding, and
 * row C2 MEASURES that the binding is still in force.
 *
 * ── REPRO-FIRST: THIS FILE MUST EXIT NON-ZERO BEFORE THE FIX ────────────────
 *
 * A RED artifact that passes proves nothing. Every row below is printed from a
 * MEASURED observation of a REAL product call — no row is an assertion about
 * code this file re-implements. The gates are invoked directly
 * (`evaluateReviewCompleteness`, `checkDispatchEvidence`) and the diagnostic
 * input is built by the PRODUCTION builder `proofStoryDiagnosticInput`, against
 * a real `StoryStore` over an mkdtemp root, with the withdrawal applied by the
 * real `scope_shrinkage_decision_set` handler. Nothing about withdrawal
 * semantics is simulated here.
 *
 * ── CONTROLS IN BOTH DIRECTIONS, AND WHAT HAPPENS IF ONE MISBEHAVES ─────────
 *
 * "It refused" and "it skipped" are uninterpretable alone. A1 rules out
 * "refuses everything" (a fully covered, non-withdrawn fixture must PASS both
 * gates) and A2 rules out "skips everything" (a non-withdrawn item with
 * genuinely missing evidence must still be REFUSED by both). C1..C4 pin the
 * premises: the withdrawal really is decision-backed, the shared binding really
 * is still in force, the subject fixture really differs from the negative
 * control ONLY by that authorized withdrawal, and the withdrawn item is never
 * laundered into the channel gate's "covered" or "owner-exempted" buckets.
 *
 * If ANY of those is violated the run prints BROKEN, draws NO conclusion about
 * the gates, and exits 2 — never a convenient RED and never a convenient GREEN.
 *
 * ── ROW IDS ARE THE STABLE SELECTORS ────────────────────────────────────────
 *
 * Rows are addressed by id (`B45A5-ROW-A1`, `B45A5-ROW-B2`, ...), never by a
 * prose conclusion line and never by a count: a later sibling rewording a
 * summary sentence or adding a fixture must not silently unpin recorded
 * evidence. Claim text carries no literal counts and no fixture names — every
 * id printed below is DERIVED at runtime from the fixture's own store state
 * (the withdrawn id comes from the helper, the delivered id from the surviving
 * shared binding, the control id from what is left over).
 *
 * ── CHK-004: AN UNBACKED WITHDRAWAL MUST SKIP NOTHING ──────────────────────
 *
 * Rows D1..D5 are the anti-bypass half, and they matter more than the skip: a
 * gate anyone opens by editing one JSON field would be worse than the bug the B
 * rows measure. Each D row puts a withdrawal that NO decision authorizes in
 * front of BOTH gates and requires both to REFUSE it.
 *
 * Every unbacked state is built by writing the store's JSON files DIRECTLY —
 * that is the actual threat model. `scope_shrinkage_decision_set` validates at
 * write time, so D1/D2/D3 are unreachable through it BY DESIGN, and building
 * them only through the CLI would make this proof theatre. D5 is the exception:
 * it IS CLI-reachable, and is built that way on purpose.
 *
 *   D1  status withdrawn, NO decisionRef at all
 *   D2  a decisionRef naming a decision id that does not exist
 *   D3  a decisionRef naming the story's REAL decision, which does not list it
 *   D4  a real decision that DOES list it, overwritten on disk to
 *       decision=rejected / userConfirmed=false
 *   D5  the same un-authorization reached through the CLI — a second
 *       `scope_shrinkage_decision_set` with decision=rejected, whose union logic
 *       preserves `withdrawnChecklistItemRefs` while dropping the authorization
 *
 * ── WHY D1..D3 CARRY A SECOND, GENUINELY WITHDRAWN ITEM ────────────────────
 *
 * Their shared fixture family also contains a DIFFERENT, REAL item that the
 * confirmed decision genuinely withdraws, so `withdrawnChecklistItemRefs` is
 * NON-EMPTY, and row C5 measures that this item IS excluded by both gates. Each
 * D row is therefore a DIFFERENTIAL inside one fixture: the forged item and the
 * backed item are identically situated — no evidence, no dispatch, each named by
 * a surviving binding it shares with the delivered item — and row C6 measures
 * that in D3 they are indistinguishable from the ITEM RECORD ALONE: same status,
 * same decisionRef value. Only the decision record separates them.
 *
 * That is what makes this letter-satisfying implementation fail here:
 *
 *     const withdrawnIds = withdrawnChecklistItemIdsFrom(decision);
 *     if (withdrawnIds.size > 0 && item.status === 'withdrawn') continue;
 *
 * It calls the helper and then keys the skip on the string, so a non-empty
 * withdrawal set naming ANOTHER item is enough to wave the forged one through.
 * With an empty-withdrawal decision it would pass D1..D3 clean, which is why the
 * fixture requirement above is load-bearing rather than decorative. Verified by
 * ablation rather than by assertion: patching the compiled dist to exactly that
 * shape turns D1/D2/D3 BYPASSED.
 *
 * The forged item is never hand-shaped either. The fixture reads back what the
 * REAL applier wrote onto the genuinely withdrawn item and copies those fields
 * verbatim, so this file contains no literal status token and cannot rot into a
 * vacuous pass if the product ever renames one.
 *
 * ── ABLATION RECORD: WHICH ROW CATCHES WHICH BYPASS ────────────────────────
 *
 * Each shape below was compiled INTO dist, measured, then reverted (dist checked
 * back byte-for-byte by sha256). Every one of them leaves B1/B2/B3 GREEN and all
 * ten controls CONTROL-OK — that is the point: they all satisfy the letter of
 * the wiring the B rows measure, and only the D rows tell them apart.
 *
 *   naive shape substituted into both gates          D1  D2  D3  D4  D5
 *   ------------------------------------------------ --- --- --- --- ---
 *   withdrawnIds.size > 0 && item.status===withdrawn  X   X   X   .   .
 *   new Set(decision.withdrawnChecklistItemRefs)      .   .   .   X   X
 *     (the helper's authorization test dropped)
 *   Boolean(item.decisionRef)                         .   X   X   X   X
 *
 *   X = that row went BYPASSED, i.e. the row caught the shape
 *
 * No single row catches all three, and the shipped implementation is the only
 * one of the four that keeps every D row REFUSED. Honest caveat: across these
 * three ablations D2 never catches anything D3 misses — it is kept because the
 * dangling-decisionRef case is one of the four this item owes and it pins that
 * threat explicitly, not because it is independently load-bearing here.
 *
 * ── E1: A WITHDRAWAL MUST NOT LOOSEN A SURVIVING ITEM ────────────────
 *
 * `withdrawnItemIntentRefs` subtracts the withdrawn item's intent refs from the
 * required set. A positional ref (`itemId:lane:index`) embeds the item id and so
 * cannot collide, but an AUTHORED `intent.id` alias is a freeform string that two
 * items may both claim. Subtracting such an alias wholesale would take away a
 * requirement carried by an item NO decision withdrew — a relaxation in the
 * opposite direction from the D rows, and one no D row can see, because every D
 * fixture asks only about the forged item itself.
 *
 * Row E1 asks about the OTHER item: a SURVIVING item that shares one authored
 * alias with a withdrawn one must keep owing EVERY ref it owns, alias included.
 * C9 pins the premises — the collision is real, an in-force binding demands the
 * alias for the surviving item, and the withdrawal is live in the same fixture
 * (the withdrawn item's exclusive positional ref IS excluded) — so E1 can never
 * be satisfied by the exclusion simply not running.
 *
 * Verified by ablation, not by assertion: deleting the `survivingRefs`
 * subtraction from `withdrawnItemIntentRefs` in the compiled dist turns E1
 * REFUSED -> PARTIAL (exit 1, verdict BYPASS) while every A/B/C/D row keeps the
 * value it has today — B1/B2/B3 GREEN, all ten earlier controls CONTROL-OK, all
 * seven D rows REFUSED. No pre-existing row moves, which is exactly why this one
 * is here.
 *
 * PARTIAL rather than BYPASSED, and that is not a weakness: `checkDispatchEvidence`
 * keys on the ITEM ID and never reads an intent ref, so an alias collision is
 * structurally unable to reach it and its half of the row stays REFUSED. The
 * conjunct is kept anyway because the claim is about the surviving ITEM, which
 * nothing withdrew and which both gates therefore still owe — so if the channel
 * gate ever becomes ref-aware, this row already covers that leak. PARTIAL is a
 * failing verdict here exactly as it is for a D row.
 *
 * ── TWO MODES ───────────────────────────────────────────────────────────────
 *
 *   (default)   repro-first: exit 1 while either gate is RED or any D row is
 *               not REFUSED, 0 when both gates are GREEN and every D row is
 *               REFUSED, 2 when a control/premise is BROKEN. This is the mode
 *               registered in `proof-or-stop.config.json`.
 *   --attest    identical measurement, identical rows, but exit 0 whenever the
 *               measurement RAN CLEANLY (all controls/premises OK), so it can be
 *               pinned as a tool-executed `verification_evidence_add` command,
 *               whose selector then carries the verdict. Exit 0 here certifies
 *               ONLY that the measurement completed with sound controls — it
 *               does NOT claim the tree is fixed. Read `B45A5-VERDICT=` for that.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', '..', 'dist');

const { StoryStore } = await import(join(DIST, 'core', 'store.js'));
const { createProofStoryHandlers } = await import(join(DIST, 'handlers', 'proofstory.js'));
const { proofStoryDiagnosticInput } = await import(join(DIST, 'handlers', 'phase-gates.js'));
const {
  evaluateReviewCompleteness,
  effectiveAcceptanceBindings,
  withdrawnChecklistItemIdsFrom,
} = await import(join(DIST, 'core', 'proofstory.js'));
const { checkDispatchEvidence } = await import(join(DIST, 'handlers', 'validate-channel.js'));

const ATTEST = process.argv.includes('--attest');

/** The product's own refusal string for a missing-dispatch item (channel gate). */
const CHANNEL_REFUSAL = 'has no dispatch/subagent_result evidence';
/** The product's own gap code for a demanded-but-unevidenced bound intent. */
const COMPLETENESS_REFUSAL = 'review_completeness_missing_evidence';

const roots = [];
function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `b45a5-${label}-`));
  roots.push(root);
  return root;
}

/**
 * Build one fixture story and take it to REVIEW.
 *
 * `shape` picks which extra item joins the delivered one:
 *   'none'      — only the delivered, fully covered item.
 *   'uncovered' — plus a NON-withdrawn item with a bound intent, no evidence and
 *                 no dispatch (the negative control).
 *   'withdrawn' — byte-identical to 'uncovered' apart from the confirmed
 *                 decision that withdraws that item (the subject). C3 measures
 *                 that this is the only difference.
 *
 * The extra item's intent carries an AUTHORED id alias as well as its positional
 * ref, and the shared binding demands BOTH forms, so a prefix match on the item
 * id would not be enough to exclude it.
 */
function buildFixture(shape) {
  const root = freshRoot(shape);
  const storyId = 'B-fx01';
  const store = new StoryStore(root);
  const handlers = createProofStoryHandlers({ store, root, scanRoot: root });
  const at = '2026-01-01T00:00:00.000Z';

  store.writeStory(storyId, {
    storyId,
    name: storyId,
    // Neutral prose on purpose: the hardening classifier reads the story corpus,
    // and words like "gate" would elevate the fixture to high assurance and add
    // diagnostics that have nothing to do with withdrawal handling.
    title: 'item withdrawal fixture',
    description: 'isolated fixture story; never a real story',
    type: 'feature',
    phase: 'REVIEW',
    // Deliberately NOT high-priority and carrying no risk signals: a
    // high-assurance story adds unrelated diagnostics (intent collision, red
    // evidence, spikes) that would sit in the same gap list and blur the
    // positive control. The coverage loop under test is hardening-independent.
    priority: 'medium',
    riskSignals: [],
    createdAt: at,
    startedAt: at,
    endedAt: null,
  });

  const deliveredId = 'CHK-001';
  const extraId = 'CHK-002';
  const aliasRef = 'INT-EXTRA-ALIAS';

  const items = [
    {
      id: deliveredId,
      title: 'delivered and fully covered',
      status: 'done',
      startTime: at,
      endTime: at,
      verificationIntent: { happy: [{ desc: 'delivered path is covered', type: 'logic', priority: 'must' }] },
      verificationEvidence: [{
        intentRef: `${deliveredId}:happy:0`,
        kind: 'logic_test',
        result: 'pass',
        note: 'fixture evidence covering the delivered intent',
        createdAt: at,
      }],
    },
  ];
  if (shape !== 'none') {
    items.push({
      id: extraId,
      title: 'never delivered',
      status: 'done',
      startTime: at,
      endTime: null,
      verificationIntent: { happy: [{ id: aliasRef, desc: 'never delivered path', type: 'logic', priority: 'must' }] },
    });
  }
  store.writeChecklist(storyId, { items });

  const bindings = [
    {
      id: 'AB-001',
      acceptanceClaim: 'the delivered path is accepted on its own',
      checklistRefs: [deliveredId],
      verificationIntentRefs: [`${deliveredId}:happy:0`],
      milestoneIds: [],
    },
  ];
  if (shape !== 'none') {
    // THE SHARED BINDING: it covers a delivered item and the extra item at once,
    // so no binding-level withdrawal can ever remove it.
    bindings.push({
      id: 'AB-002',
      acceptanceClaim: 'one acceptance spanning a delivered item and the extra item',
      checklistRefs: [deliveredId, extraId],
      verificationIntentRefs: [`${deliveredId}:happy:0`, `${extraId}:happy:0`, aliasRef],
      milestoneIds: [],
    });
  }
  store.writeProofStoryContract(storyId, {
    schemaVersion: 'proofstory.contract.v1',
    storyId,
    diagnosticOnly: false,
    hardeningLevel: 'standard',
    triggerReasons: [],
    acceptanceBindings: bindings,
    diagnosticGaps: [],
    createdAt: at,
    updatedAt: at,
  });

  if (shape === 'withdrawn') {
    // THE REAL SOLE APPLIER performs the withdrawal: it flips the item and stamps
    // its decisionRef. Nothing about the withdrawal is hand-written here.
    handlers.scope_shrinkage_decision_set({
      storyId,
      decision: 'confirmed',
      userConfirmed: true,
      reason: 'the extra item proved undeliverable and was withdrawn with user confirmation',
      approvedBy: 'fixture-operator',
      withdrawnChecklistItemRefs: [extraId],
    });
  }

  // Dispatch evidence exists ONLY for the delivered item, in both shapes.
  const events = [{ type: 'dispatch', itemId: deliveredId, at }];
  return { root, storyId, store, events };
}

// ── CHK-004: fixtures carrying an UNBACKED withdrawal ───────────────────────

/** A decision id no record on disk ever carries (row D2). */
const DANGLING_DECISION_REF = 'SD-00000000';

/**
 * Overwrite fields of one checklist item BY RAW FILE WRITE.
 *
 * Deliberately not `store.writeChecklist` and emphatically not the CLI: the
 * threat being measured is an operator (or an agent) opening checklist.json in
 * an editor and changing a field. `scope_shrinkage_decision_set` validates every
 * ref before it writes, so the D1/D2/D3 states are unreachable through it BY
 * DESIGN — reaching them any other way than this would mean measuring a state
 * the threat model does not contain.
 *
 * A key whose patch value is `undefined` is DELETED, which is how D1 gets an
 * item with no `decisionRef` key at all rather than one set to a falsy value.
 */
function forgeChecklistItem(store, storyId, itemId, patch) {
  const path = store.storyFilePath(storyId, 'checklist.json');
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const item = raw.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`forge: ${storyId} has no checklist item ${itemId}`);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete item[key];
    else item[key] = value;
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

/** Overwrite fields of the scope-shrinkage decision record BY RAW FILE WRITE (row D4). */
function forgeDecisionRecord(store, storyId, patch) {
  const path = store.storyFilePath(storyId, 'scope-shrinkage-decision.json');
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  Object.assign(raw, patch);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

/**
 * Build one fixture whose SUBJECT item looks withdrawn but is not authorized.
 *
 * Two families, and the difference is which item the story's single real
 * decision names:
 *
 *   'd1' | 'd2' | 'd3' — the confirmed decision withdraws a DIFFERENT, REAL
 *     item (`backedId`), so its `withdrawnChecklistItemRefs` is NON-EMPTY and
 *     the exclusion is demonstrably live in this very fixture (row C5). The
 *     subject is then forged into a withdrawn-looking state whose `decisionRef`
 *     is the only thing that varies: absent (d1), dangling (d2), or the real
 *     decision id (d3). The forged fields are COPIED from what the real applier
 *     just wrote onto `backedId`, so nothing about the shape is invented here.
 *
 *   'd4' | 'd5' — the confirmed decision withdraws the SUBJECT, and the REAL
 *     applier performs the flip and the stamp, so the item record is entirely
 *     legitimate. The authorization is then removed from the decision AFTER the
 *     fact: by raw file write (d4) or through the CLI (d5). Row C8 measures that
 *     the decision still LISTS the item, so the only thing taken away is the
 *     authorization — which is exactly what `withdrawnChecklistItemIdsFrom`
 *     requires and what a `.withdrawnChecklistItemRefs.includes(id)` shortcut
 *     would miss.
 *
 * Everything else mirrors `buildFixture`: the subject owns a positional ref AND
 * an authored alias, both demanded by a surviving binding it shares with the
 * delivered item, and the only dispatch event covers the delivered item.
 */
function buildForged(variant) {
  const root = freshRoot(variant);
  const storyId = 'B-fx01';
  const store = new StoryStore(root);
  const handlers = createProofStoryHandlers({ store, root, scanRoot: root });
  const at = '2026-01-01T00:00:00.000Z';
  // Does the story's real decision name the SUBJECT (d4/d5) or another item?
  const decisionNamesSubject = variant === 'd4' || variant === 'd5';

  store.writeStory(storyId, {
    storyId,
    name: storyId,
    title: 'item withdrawal fixture',
    description: 'isolated fixture story; never a real story',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'medium',
    riskSignals: [],
    createdAt: at,
    startedAt: at,
    endedAt: null,
  });

  const deliveredId = 'CHK-001';
  const forgedId = 'CHK-002';
  const backedId = 'CHK-003';
  const forgedAlias = 'INT-FORGED-ALIAS';
  const backedAlias = 'INT-BACKED-ALIAS';

  // The two candidate items are built by the SAME factory, so they are
  // identically situated by construction and the only asymmetry between them is
  // which one the decision names.
  const undeliveredItem = (id, alias) => ({
    id,
    title: 'never delivered',
    status: 'done',
    startTime: at,
    endTime: null,
    verificationIntent: { happy: [{ id: alias, desc: 'never delivered path', type: 'logic', priority: 'must' }] },
  });

  const items = [
    {
      id: deliveredId,
      title: 'delivered and fully covered',
      status: 'done',
      startTime: at,
      endTime: at,
      verificationIntent: { happy: [{ desc: 'delivered path is covered', type: 'logic', priority: 'must' }] },
      verificationEvidence: [{
        intentRef: `${deliveredId}:happy:0`,
        kind: 'logic_test',
        result: 'pass',
        note: 'fixture evidence covering the delivered intent',
        createdAt: at,
      }],
    },
    undeliveredItem(forgedId, forgedAlias),
  ];
  if (!decisionNamesSubject) items.push(undeliveredItem(backedId, backedAlias));
  store.writeChecklist(storyId, { items });

  const bindings = [
    {
      id: 'AB-001',
      acceptanceClaim: 'the delivered path is accepted on its own',
      checklistRefs: [deliveredId],
      verificationIntentRefs: [`${deliveredId}:happy:0`],
      milestoneIds: [],
    },
    {
      id: 'AB-002',
      acceptanceClaim: 'one acceptance spanning a delivered item and the subject item',
      checklistRefs: [deliveredId, forgedId],
      verificationIntentRefs: [`${deliveredId}:happy:0`, `${forgedId}:happy:0`, forgedAlias],
      milestoneIds: [],
    },
  ];
  if (!decisionNamesSubject) {
    bindings.push({
      id: 'AB-003',
      acceptanceClaim: 'one acceptance spanning a delivered item and the decision-backed item',
      checklistRefs: [deliveredId, backedId],
      verificationIntentRefs: [`${deliveredId}:happy:0`, `${backedId}:happy:0`, backedAlias],
      milestoneIds: [],
    });
  }
  store.writeProofStoryContract(storyId, {
    schemaVersion: 'proofstory.contract.v1',
    storyId,
    diagnosticOnly: false,
    hardeningLevel: 'standard',
    triggerReasons: [],
    acceptanceBindings: bindings,
    diagnosticGaps: [],
    createdAt: at,
    updatedAt: at,
  });

  // The story's ONE real decision, written by the REAL applier.
  handlers.scope_shrinkage_decision_set({
    storyId,
    decision: 'confirmed',
    userConfirmed: true,
    reason: 'this item proved undeliverable and was withdrawn with user confirmation',
    approvedBy: 'fixture-operator',
    withdrawnChecklistItemRefs: [decisionNamesSubject ? forgedId : backedId],
  });
  const realDecisionId = store.readScopeShrinkageDecision(storyId)?.decisionId ?? null;

  if (!decisionNamesSubject) {
    // Copy, FIELD FOR FIELD, whatever the applier just wrote onto the item the
    // decision really withdrew. No status token is invented or hard-coded here,
    // so the forgery stays byte-faithful even if the product renames one.
    const applied = store.readChecklist(storyId).items.find((entry) => entry.id === backedId);
    const decisionRef = variant === 'd1'
      ? undefined                       // d1: no decisionRef key at all
      : variant === 'd2'
        ? DANGLING_DECISION_REF         // d2: names a decision that does not exist
        : realDecisionId;               // d3: names the REAL decision, which does not list it
    forgeChecklistItem(store, storyId, forgedId, {
      status: applied?.status,
      endTime: applied?.endTime,
      decisionRef,
    });
  } else if (variant === 'd4') {
    // Raw file write: strip the authorization, leave withdrawnChecklistItemRefs
    // untouched. This is the shape a `.includes(id)` check would still honour.
    forgeDecisionRecord(store, storyId, { decision: 'rejected', userConfirmed: false });
  } else {
    // The CLI-reachable route to the same state: a second decision_set with no
    // incoming refs passes the confirmed-required check, and the union logic
    // carries the existing withdrawnChecklistItemRefs forward unchanged.
    handlers.scope_shrinkage_decision_set({
      storyId,
      decision: 'rejected',
      userConfirmed: false,
      reason: 'the withdrawal was walked back after review; scope is restored',
      approvedBy: 'fixture-operator',
    });
  }

  const events = [{ type: 'dispatch', itemId: deliveredId, at }];
  return {
    root,
    storyId,
    store,
    events,
    variant,
    deliveredId,
    forgedId,
    backedId: decisionNamesSubject ? null : backedId,
    realDecisionId,
  };
}

// ── E1: the ALIAS-COLLISION fixture ─────────────────────────────────────────

/**
 * Build a fixture where a withdrawn item and a SURVIVING item author the SAME
 * `verificationIntent.id`.
 *
 * The surviving item owns exactly two refs — its own positional `id:lane:index`
 * and the shared alias — and a binding it shares with the delivered item demands
 * BOTH. So a subtraction that takes the alias is directly observable: the alias
 * drops out of the demanded set while the positional ref stays, which is a
 * PARTIAL loss and therefore not a refusal (see `gateTreatment`).
 *
 * The two undelivered items come from one factory and are identically situated;
 * the only asymmetry is which one the confirmed decision names.
 */
function buildAliasCollision() {
  const root = freshRoot('alias');
  const storyId = 'B-fx01';
  const store = new StoryStore(root);
  const handlers = createProofStoryHandlers({ store, root, scanRoot: root });
  const at = '2026-01-01T00:00:00.000Z';

  const deliveredId = 'CHK-001';
  const withdrawnId = 'CHK-002';
  const survivingId = 'CHK-003';
  const sharedAlias = 'INT-SHARED-ALIAS';

  store.writeStory(storyId, {
    storyId,
    name: storyId,
    title: 'item withdrawal fixture',
    description: 'isolated fixture story; never a real story',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'medium',
    riskSignals: [],
    createdAt: at,
    startedAt: at,
    endedAt: null,
  });

  const sharingItem = (id) => ({
    id,
    title: 'never delivered',
    status: 'done',
    startTime: at,
    endTime: null,
    verificationIntent: { happy: [{ id: sharedAlias, desc: 'never delivered path', type: 'logic', priority: 'must' }] },
  });

  store.writeChecklist(storyId, {
    items: [
      {
        id: deliveredId,
        title: 'delivered and fully covered',
        status: 'done',
        startTime: at,
        endTime: at,
        verificationIntent: { happy: [{ desc: 'delivered path is covered', type: 'logic', priority: 'must' }] },
        verificationEvidence: [{
          intentRef: `${deliveredId}:happy:0`,
          kind: 'logic_test',
          result: 'pass',
          note: 'fixture evidence covering the delivered intent',
          createdAt: at,
        }],
      },
      sharingItem(withdrawnId),
      sharingItem(survivingId),
    ],
  });

  store.writeProofStoryContract(storyId, {
    schemaVersion: 'proofstory.contract.v1',
    storyId,
    diagnosticOnly: false,
    hardeningLevel: 'standard',
    triggerReasons: [],
    acceptanceBindings: [
      {
        id: 'AB-001',
        acceptanceClaim: 'the delivered path is accepted on its own',
        checklistRefs: [deliveredId],
        verificationIntentRefs: [`${deliveredId}:happy:0`],
        milestoneIds: [],
      },
      {
        id: 'AB-002',
        acceptanceClaim: 'one acceptance spanning a delivered item and the withdrawn item',
        checklistRefs: [deliveredId, withdrawnId],
        verificationIntentRefs: [`${deliveredId}:happy:0`, `${withdrawnId}:happy:0`, sharedAlias],
        milestoneIds: [],
      },
      {
        // The SURVIVING item's own acceptance. Nothing withdraws this binding or
        // this item, so every ref it names stays required no matter what happens
        // to the item next door.
        id: 'AB-003',
        acceptanceClaim: 'one acceptance spanning a delivered item and the surviving item',
        checklistRefs: [deliveredId, survivingId],
        verificationIntentRefs: [`${deliveredId}:happy:0`, `${survivingId}:happy:0`, sharedAlias],
        milestoneIds: [],
      },
    ],
    diagnosticGaps: [],
    createdAt: at,
    updatedAt: at,
  });

  // The REAL applier withdraws exactly ONE of the two alias sharers.
  handlers.scope_shrinkage_decision_set({
    storyId,
    decision: 'confirmed',
    userConfirmed: true,
    reason: 'one of the two alias-sharing items proved undeliverable and was withdrawn with user confirmation',
    approvedBy: 'fixture-operator',
    withdrawnChecklistItemRefs: [withdrawnId],
  });

  const events = [{ type: 'dispatch', itemId: deliveredId, at }];
  return { root, storyId, store, events, deliveredId, withdrawnId, survivingId, sharedAlias };
}

/** Run BOTH real gates over one fixture and return only measured facts. */
function measure(fx) {
  const checklist = fx.store.readChecklist(fx.storyId);
  const decision = fx.store.readScopeShrinkageDecision(fx.storyId);
  const contract = fx.store.readProofStoryContract(fx.storyId);

  const completeness = evaluateReviewCompleteness(
    proofStoryDiagnosticInput(fx.store, fx.storyId, fx.root),
    'enforce',
  );
  // The decision IS handed to the channel gate here. Today's implementation
  // destructures three fields and ignores it entirely — that inertness is half
  // the defect, and it is why row B2 is RED even though the caller supplies
  // everything the gate would need. Whoever plumbs the decision through
  // `checkDispatchEvidence` must make sure the opt is read under THIS name, or
  // update this call site; B2 stays RED until the wiring is real.
  const channel = checkDispatchEvidence({
    checklist,
    events: fx.events,
    mainAgentOwnedItems: new Set(),
    scopeShrinkageDecision: decision,
  });

  const demandedRefs = completeness.gaps
    .filter((gap) => gap.code === COMPLETENESS_REFUSAL)
    .map((gap) => gap.message.match(/Verification intent (\S+)/)?.[1])
    .filter((ref) => typeof ref === 'string');
  const offenders = channel.issues.map((issue) => issue.itemId);

  return {
    checklist,
    decision,
    contract,
    completeness,
    channel,
    demandedRefs,
    offenders,
    channelRefusalFor: (id) => channel.issues.some((i) => i.itemId === id && i.message.includes(CHANNEL_REFUSAL)),
    effective: effectiveAcceptanceBindings(contract, decision),
  };
}

/**
 * Every ref an item owns: positional (`id:lane:index`) AND any authored alias.
 *
 * This derives the fixture's OWN input set, never a gate verdict. If the
 * product's ref convention ever moved out from under it, the refs computed here
 * would stop matching what the gate demands — and A2 would go BROKEN, because
 * the negative control requires these same refs to come back demanded. So a
 * silently wrong derivation cannot turn into a false GREEN on B1; it turns into
 * a refusal to conclude anything.
 */
function refsOwnedBy(checklist, itemId) {
  const item = checklist.items.find((i) => i.id === itemId);
  const refs = new Set();
  for (const [lane, entries] of Object.entries(item?.verificationIntent ?? {})) {
    (entries ?? []).forEach((entry, index) => {
      refs.add(`${itemId}:${lane}:${index}`);
      if (entry?.id) refs.add(entry.id);
    });
  }
  return refs;
}

/**
 * Fixture shape with the authorized withdrawal normalized away, for C3.
 *
 * The applier writes exactly three things onto the withdrawn item — the terminal
 * `status`, the `decisionRef` naming the authorizing decision, and the `endTime`
 * stamp that closes it — so those three are the normalization, and NOTHING else
 * is. Everything that remains (ids, titles, intents, evidence, bindings,
 * dispositions) is compared byte-for-byte.
 */
const WITHDRAWAL_STAMPED_FIELDS = ['status', 'decisionRef', 'endTime'];
function withdrawalAgnosticShape(m, withdrawnId) {
  return JSON.stringify({
    items: m.checklist.items.map((item) => {
      if (item.id !== withdrawnId) return item;
      const normalized = { ...item };
      for (const field of WITHDRAWAL_STAMPED_FIELDS) normalized[field] = '<normalized>';
      return normalized;
    }),
    bindings: m.contract.acceptanceBindings,
    dispositions: m.contract.bindingDispositions ?? [],
  });
}

// ── measure ─────────────────────────────────────────────────────────────────

const rows = [];
const observations = [];
const row = (id, verdict, claim) => { rows.push({ id, verdict, claim }); };
const observe = (text) => { observations.push(text); };

let exitCode = 0;
try {
  const positive = measure(buildFixture('none'));
  const negative = measure(buildFixture('uncovered'));
  const subject = measure(buildFixture('withdrawn'));

  // Roles are DERIVED from the subject fixture's own state, not from constants.
  const withdrawnIds = [...withdrawnChecklistItemIdsFrom(subject.decision)];
  const withdrawnId = withdrawnIds.length === 1 ? withdrawnIds[0] : null;
  const sharedBinding = withdrawnId
    ? subject.effective.find((b) => b.checklistRefs.includes(withdrawnId)
        && b.checklistRefs.some((ref) => ref !== withdrawnId))
    : undefined;
  const deliveredId = sharedBinding?.checklistRefs.find((ref) => ref !== withdrawnId) ?? null;
  // The negative control's subject item is the one that is NOT the delivered item.
  const negativeControlId = negative.checklist.items.map((i) => i.id).find((id) => id !== deliveredId) ?? null;

  // ── A1: positive control — a fully covered, non-withdrawn fixture PASSES ───
  // Scoped to the two gates under test: the criterion is that neither DEMANDS
  // anything, not that the completeness report is globally clean. Unrelated
  // diagnostics (hardening, ledger, collision) land in the same gap list, and
  // folding them in would make this control fail for reasons that have nothing
  // to do with withdrawal handling. The full report is printed either way.
  const positiveCompletenessClean = positive.demandedRefs.length === 0;
  const positiveChannelClean = positive.channel.ok;
  row('A1', positiveCompletenessClean && positiveChannelClean ? 'CONTROL-OK' : 'BROKEN',
    'positive control: a fully covered, non-withdrawn fixture is accepted by both gates (rules out "refuses everything")');
  observe(`A1 completeness status=${positive.completeness.status} demanded=[${positive.demandedRefs.join(' ')}] gapCodes=[${positive.completeness.gaps.map((g) => g.code).join(' ')}]`);
  observe(`A1 channel ok=${positive.channel.ok} offenders=[${positive.offenders.join(' ')}]`);

  // ── A2: negative control — genuinely missing evidence is STILL refused ─────
  const negativeRefs = negativeControlId ? refsOwnedBy(negative.checklist, negativeControlId) : new Set();
  const negativeCompletenessBites = [...negativeRefs].some((ref) => negative.demandedRefs.includes(ref));
  const negativeChannelBites = Boolean(negativeControlId) && negative.channelRefusalFor(negativeControlId);
  row('A2', negativeCompletenessBites && negativeChannelBites ? 'CONTROL-OK' : 'BROKEN',
    'negative control: a non-withdrawn item with genuinely missing evidence is still refused by both gates (rules out "skips everything")');
  observe(`A2 subject item=${negativeControlId} owns refs=[${[...negativeRefs].join(' ')}]`);
  observe(`A2 completeness status=${negative.completeness.status} demanded=[${negative.demandedRefs.join(' ')}]`);
  observe(`A2 channel ok=${negative.channel.ok} offenders=[${negative.offenders.join(' ')}]`);

  // ── C1: the withdrawal really is decision-backed ──────────────────────────
  const item = withdrawnId ? subject.checklist.items.find((i) => i.id === withdrawnId) : undefined;
  const backed = Boolean(withdrawnId)
    && subject.decision?.decision === 'confirmed'
    && subject.decision?.userConfirmed === true
    && item?.decisionRef === subject.decision?.decisionId;
  row('C1', backed ? 'CONTROL-OK' : 'BROKEN',
    'premise: the exported helper resolves the withdrawal from the DECISION RECORD, and the applier stamped the item with that same decision id');
  observe(`C1 helper resolved=[${withdrawnIds.join(' ')}] decision=${subject.decision?.decision}/${subject.decision?.userConfirmed} itemStatus=${item?.status} itemDecisionRef=${item?.decisionRef} decisionId=${subject.decision?.decisionId}`);

  // ── C2: the withdrawn item shares an IN-FORCE binding with a delivered one ─
  const deliveredItem = deliveredId ? subject.checklist.items.find((i) => i.id === deliveredId) : undefined;
  const shared = Boolean(sharedBinding)
    && deliveredItem?.status === 'done'
    && subject.effective.some((b) => b.id === sharedBinding.id);
  row('C2', shared ? 'CONTROL-OK' : 'BROKEN',
    'premise: the withdrawn item shares a still-in-force acceptance binding with a delivered item, so no binding-level exclusion can account for the outcome');
  observe(`C2 sharedBinding=${sharedBinding?.id} refs=[${(sharedBinding?.checklistRefs ?? []).join(' ')}] inForce=[${subject.effective.map((b) => b.id).join(' ')}] deliveredStatus=${deliveredItem?.status}`);

  // ── C3: subject differs from the negative control ONLY by the withdrawal ──
  const sameShape = Boolean(withdrawnId)
    && withdrawalAgnosticShape(subject, withdrawnId) === withdrawalAgnosticShape(negative, withdrawnId);
  row('C3', sameShape ? 'CONTROL-OK' : 'BROKEN',
    'premise: the subject fixture and the negative control are identical once the authorized withdrawal is normalized away, so any verdict difference between them can only come from the withdrawal');
  observe(`C3 shapesEqual=${sameShape} normalizedFields=[${WITHDRAWAL_STAMPED_FIELDS.join(' ')}] everything else compared byte-for-byte`);

  // ── C4: the withdrawn item is never laundered into an existing bucket ─────
  // Guard, not a claim of the defect: it holds today (the item is an offender)
  // and must keep holding once the gate learns about withdrawals. `Covered:` and
  // `plan.md Owner=main-agent exempted:` are what those two buckets render as,
  // so putting a withdrawn item in either would record work never done as done,
  // or attribute it to an owner who never owned it.
  const laundered = Boolean(withdrawnId)
    && (subject.channel.evidencedItems.includes(withdrawnId)
      || subject.channel.exemptedItems.includes(withdrawnId));
  row('C4', laundered ? 'BROKEN' : 'CONTROL-OK',
    'guard: the withdrawn item is reported neither as covered nor as an owner exemption by the channel gate');
  observe(`C4 covered=[${subject.channel.evidencedItems.join(' ')}] exempted=[${subject.channel.exemptedItems.join(' ')}] withdrawn=${withdrawnId}`);

  // ── CHK-004: measure the unbacked withdrawals ────────────────────────────
  //
  // Built AFTER the subject fixture so the terminal status the forgeries copy is
  // read back from a withdrawal the REAL applier performed, never written as a
  // literal in this file.
  const FORGED_VARIANTS = ['d1', 'd2', 'd3', 'd4', 'd5'];
  const forged = FORGED_VARIANTS.map((variant) => {
    const fx = buildForged(variant);
    return { fx, m: measure(fx) };
  });
  const byVariant = new Map(forged.map((entry) => [entry.fx.variant, entry]));
  const terminalWithdrawnStatus = withdrawnId
    ? subject.checklist.items.find((i) => i.id === withdrawnId)?.status
    : undefined;

  /** How BOTH gates actually treated one item in one fixture. Measured, not asserted. */
  const gateTreatment = (m, itemId) => {
    const refs = [...refsOwnedBy(m.checklist, itemId)];
    const demanded = refs.filter((ref) => m.demandedRefs.includes(ref));
    return {
      refs,
      demanded,
      // Every ref the item owns must STILL be demanded. A subtraction that took
      // the positional ref but left the alias (or the reverse) is a partial
      // bypass, and partial is not refused.
      completenessRefuses: refs.length > 0 && demanded.length === refs.length,
      channelRefuses: m.channelRefusalFor(itemId),
      inWithdrawnBucket: (m.channel.withdrawnItems ?? []).includes(itemId),
      laundered: m.channel.evidencedItems.includes(itemId) || m.channel.exemptedItems.includes(itemId),
    };
  };

  // ── C5: in D1..D3 the decision withdraws a DIFFERENT real item, and THAT
  //        item is genuinely excluded by both gates ──────────────────────────
  // The make-or-break fixture premise. Two things at once: the withdrawal set is
  // NON-EMPTY (so `withdrawnIds.size > 0` is true and cannot rescue a
  // status-keyed skip), and the exclusion is demonstrably LIVE in the same
  // fixture that refuses the forgery — so a D-row refusal can never be explained
  // away as "the feature simply is not on here".
  const unlistedFamily = ['d1', 'd2', 'd3'].map((variant) => byVariant.get(variant));
  const c5 = unlistedFamily.every((entry) => {
    if (!entry?.fx.backedId) return false;
    const resolved = withdrawnChecklistItemIdsFrom(entry.m.decision);
    const backed = gateTreatment(entry.m, entry.fx.backedId);
    return resolved.has(entry.fx.backedId)
      && !resolved.has(entry.fx.forgedId)
      && resolved.size > 0
      && backed.demanded.length === 0
      && !backed.channelRefuses
      && backed.inWithdrawnBucket;
  });
  row('C5', c5 ? 'CONTROL-OK' : 'BROKEN',
    'premise: in every forged fixture the confirmed decision withdraws a DIFFERENT, REAL item and that item IS excluded by both gates, so the withdrawal set is non-empty and the exclusion is demonstrably live in the same fixture that refuses the forgery');
  for (const entry of unlistedFamily) {
    if (!entry) continue;
    const resolved = [...withdrawnChecklistItemIdsFrom(entry.m.decision)];
    const backed = entry.fx.backedId ? gateTreatment(entry.m, entry.fx.backedId) : null;
    observe(`C5 ${entry.fx.variant}: helper resolved=[${resolved.join(' ')}] backed=${entry.fx.backedId} demanded=[${backed?.demanded.join(' ')}] channelRefuses=${backed?.channelRefuses} inWithdrawnBucket=${backed?.inWithdrawnBucket}`);
  }

  // ── C6: in D3 the forged item and the backed item are indistinguishable
  //        from the ITEM RECORD ALONE ───────────────────────────────────────
  const d3 = byVariant.get('d3');
  const d3Forged = d3?.m.checklist.items.find((i) => i.id === d3.fx.forgedId);
  const d3Backed = d3?.m.checklist.items.find((i) => i.id === d3.fx.backedId);
  const c6 = Boolean(d3Forged && d3Backed)
    && d3Forged.status === d3Backed.status
    && d3Forged.decisionRef === d3Backed.decisionRef
    && (d3Forged.verificationEvidence ?? []).length === 0
    && (d3Backed.verificationEvidence ?? []).length === 0
    && !d3.fx.events.some((e) => e.itemId === d3Forged.id || e.itemId === d3Backed.id);
  row('C6', c6 ? 'CONTROL-OK' : 'BROKEN',
    'premise: in the real-decision-that-does-not-list-it fixture the forged item and the genuinely withdrawn item carry the SAME status and the SAME decisionRef, both without evidence and without dispatch, so nothing on the item record distinguishes them and only the decision record can');
  observe(`C6 forged=${d3Forged?.id} status=${d3Forged?.status} decisionRef=${d3Forged?.decisionRef} | backed=${d3Backed?.id} status=${d3Backed?.status} decisionRef=${d3Backed?.decisionRef} | dispatchedItems=[${d3?.fx.events.map((e) => e.itemId).join(' ')}]`);

  // ── C7: the forgery actually landed on disk ──────────────────────────────
  // Without this a D row could be "refused" simply because the hand-edit never
  // took, which would prove nothing at all.
  const expectedForgedRef = (variant, realDecisionId) => (
    variant === 'd1' ? undefined : variant === 'd2' ? DANGLING_DECISION_REF : realDecisionId
  );
  const c7 = Boolean(terminalWithdrawnStatus)
    && forged.every((entry) => {
      const forgedItem = entry.m.checklist.items.find((i) => i.id === entry.fx.forgedId);
      return Boolean(forgedItem)
        && forgedItem.status === terminalWithdrawnStatus
        && forgedItem.decisionRef === expectedForgedRef(entry.fx.variant, entry.fx.realDecisionId)
        && refsOwnedBy(entry.m.checklist, entry.fx.forgedId).size >= 2
        && entry.fx.realDecisionId !== DANGLING_DECISION_REF;
    });
  row('C7', c7 ? 'CONTROL-OK' : 'BROKEN',
    'premise: every forged fixture really is on disk in the intended unbacked state — the subject carries the same terminal status the real applier writes, the intended decisionRef (absent / dangling / real), and both a positional ref and an authored alias');
  for (const entry of forged) {
    const forgedItem = entry.m.checklist.items.find((i) => i.id === entry.fx.forgedId);
    observe(`C7 ${entry.fx.variant}: item=${entry.fx.forgedId} status=${forgedItem?.status} decisionRef=${forgedItem?.decisionRef} expected=${expectedForgedRef(entry.fx.variant, entry.fx.realDecisionId)} refs=[${[...refsOwnedBy(entry.m.checklist, entry.fx.forgedId)].join(' ')}]`);
  }

  // ── C8: in D4/D5 the decision STILL lists the item ───────────────────────
  // Only the authorization was removed. If the ref had vanished too, both rows
  // would be trivially refused and would measure nothing about authorization.
  const unauthorizedFamily = ['d4', 'd5'].map((variant) => byVariant.get(variant));
  const c8 = unauthorizedFamily.every((entry) => {
    const decision = entry?.m.decision;
    return Boolean(decision)
      && (decision.withdrawnChecklistItemRefs ?? []).includes(entry.fx.forgedId)
      && !(decision.decision === 'confirmed' && decision.userConfirmed === true)
      && withdrawnChecklistItemIdsFrom(decision).size === 0;
  });
  row('C8', c8 ? 'CONTROL-OK' : 'BROKEN',
    'premise: in the un-authorized fixtures the decision record STILL lists the item in withdrawnChecklistItemRefs and only the authorization was taken away, so what the helper resolves to the empty set is exactly what a bare refs.includes(id) shortcut would still honour');
  for (const entry of unauthorizedFamily) {
    const decision = entry?.m.decision;
    observe(`C8 ${entry?.fx.variant}: decision=${decision?.decision}/${decision?.userConfirmed} refs=[${(decision?.withdrawnChecklistItemRefs ?? []).join(' ')}] helperResolves=[${[...withdrawnChecklistItemIdsFrom(decision)].join(' ')}]`);
  }

  // ── C9: the alias collision is real AND the withdrawal is live in it ────
  // Both halves matter. Without the collision E1 measures nothing; without a
  // live exclusion in the SAME fixture, an E1 refusal could be explained away as
  // "the subtraction simply never ran here".
  const aliasFx = buildAliasCollision();
  const aliasM = measure(aliasFx);
  const aliasResolved = withdrawnChecklistItemIdsFrom(aliasM.decision);
  const aliasWithdrawnOwns = refsOwnedBy(aliasM.checklist, aliasFx.withdrawnId);
  const aliasSurvivingOwns = refsOwnedBy(aliasM.checklist, aliasFx.survivingId);
  // The withdrawn item's refs that NO surviving item owns: exactly the set the
  // shipped subtraction is allowed to remove.
  const aliasExclusive = [...aliasWithdrawnOwns].filter((ref) => !aliasSurvivingOwns.has(ref));
  const c9 = aliasResolved.has(aliasFx.withdrawnId)
    && !aliasResolved.has(aliasFx.survivingId)
    && aliasWithdrawnOwns.has(aliasFx.sharedAlias)
    && aliasSurvivingOwns.has(aliasFx.sharedAlias)
    && aliasM.effective.some((b) => b.checklistRefs.includes(aliasFx.survivingId)
      && b.verificationIntentRefs.includes(aliasFx.sharedAlias))
    && aliasExclusive.length === 1
    && !aliasM.demandedRefs.includes(aliasExclusive[0]);
  row('C9', c9 ? 'CONTROL-OK' : 'BROKEN',
    'premise: a withdrawn item and a SURVIVING item author the SAME intent alias, an in-force binding demands that alias for the surviving item, and the exclusion is live in this very fixture (the withdrawn item\'s exclusive ref is no longer demanded)');
  observe(`C9 withdrawn=${aliasFx.withdrawnId} surviving=${aliasFx.survivingId} helperResolved=[${[...aliasResolved].join(' ')}] alias=${aliasFx.sharedAlias} withdrawnOwns=[${[...aliasWithdrawnOwns].join(' ')}] survivingOwns=[${[...aliasSurvivingOwns].join(' ')}] exclusive=[${aliasExclusive.join(' ')}] demanded=[${aliasM.demandedRefs.join(' ')}]`);

  const broken = rows.filter((r) => r.verdict === 'BROKEN');

  if (broken.length > 0) {
    // NO conclusion is drawn about the gates.
    row('B1', 'NOT-MEASURED', 'the completeness gate\'s handling of the authorized withdrawal was not evaluated');
    row('B2', 'NOT-MEASURED', 'the channel gate\'s handling of the authorized withdrawal was not evaluated');
    row('B3', 'NOT-MEASURED', 'no joint conclusion is available while a control or premise is BROKEN');
    for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D23', 'D45', 'E1']) {
      row(id, 'NOT-MEASURED', 'no conclusion is drawn about an unauthorized skip while a control or premise is BROKEN');
    }
    exitCode = 2;
  } else {
    // ── B1: completeness gate still demands the withdrawn item's intents ────
    const withdrawnRefs = [...refsOwnedBy(subject.checklist, withdrawnId)];
    const stillDemanded = withdrawnRefs.filter((ref) => subject.demandedRefs.includes(ref));
    const b1 = stillDemanded.length > 0 ? 'RED' : 'GREEN';
    row('B1', b1,
      `does the completeness gate still report ${COMPLETENESS_REFUSAL} for intents whose owning item a confirmed decision withdrew? RED = yes`);
    observe(`B1 withdrawn item owns refs=[${withdrawnRefs.join(' ')}] still demanded=[${stillDemanded.join(' ')}]`);
    observe(`B1 completeness status=${subject.completeness.status} blocking=${subject.completeness.blocking}`);
    for (const gap of subject.completeness.gaps.filter((g) => g.code === COMPLETENESS_REFUSAL)) {
      observe(`B1 gap: ${gap.code}: ${gap.message}`);
    }

    // ── B2: channel gate still demands dispatch for the withdrawn item ──────
    const b2 = subject.channelRefusalFor(withdrawnId) ? 'RED' : 'GREEN';
    row('B2', b2,
      `does the channel gate still report "${CHANNEL_REFUSAL}" for an item a confirmed decision withdrew? RED = yes`);
    observe(`B2 channel ok=${subject.channel.ok} offenders=[${subject.offenders.join(' ')}]`);
    for (const detail of subject.channel.details) observe(`B2 detail: ${detail}`);

    // ── B3: joint verdict ───────────────────────────────────────────────────
    const b3 = b1 === b2 ? b1 : 'MIXED';
    row('B3', b3,
      'joint: do BOTH REVIEW-path gates ignore an item-level withdrawal authorized by a confirmed decision? RED = yes, GREEN = neither does, MIXED = only one learned about it');
    observe(`B3 derived from the two rows above; MIXED would mean only one gate learned about the withdrawal`);
    // ── D1..D5: an UNBACKED withdrawal must skip NOTHING ──────────────────
    //
    // REFUSED  = both gates still bite (the required outcome)
    // PARTIAL  = exactly one gate was fooled
    // BYPASSED = both were fooled, i.e. the gate is openable by hand-editing JSON
    const D_CLAIMS = {
      d1: 'an item marked withdrawn with NO decisionRef at all: is it still refused by BOTH gates? REFUSED = yes',
      d2: 'an item whose decisionRef names a decision id that does not exist: is it still refused by BOTH gates? REFUSED = yes',
      d3: 'an item whose decisionRef names the story\'s REAL confirmed decision, which withdraws a DIFFERENT item and does not list this one: is it still refused by BOTH gates? REFUSED = yes',
      d4: 'an item whose decision DOES list it but was overwritten on disk to decision=rejected / userConfirmed=false: is it still refused by BOTH gates? REFUSED = yes',
      d5: 'the same un-authorization reached through the CLI (a second scope_shrinkage_decision_set with decision=rejected, refs preserved by the union logic): is it still refused by BOTH gates? REFUSED = yes',
    };
    const dVerdicts = new Map();
    for (const entry of forged) {
      const id = entry.fx.variant.toUpperCase();
      const t = gateTreatment(entry.m, entry.fx.forgedId);
      const verdict = t.completenessRefuses && t.channelRefuses
        ? 'REFUSED'
        : (!t.completenessRefuses && !t.channelRefuses ? 'BYPASSED' : 'PARTIAL');
      dVerdicts.set(id, verdict);
      row(id, verdict, D_CLAIMS[entry.fx.variant]);
      observe(`${id} subject=${entry.fx.forgedId} owns refs=[${t.refs.join(' ')}] still demanded=[${t.demanded.join(' ')}] completenessRefuses=${t.completenessRefuses}`);
      observe(`${id} channel ok=${entry.m.channel.ok} offenders=[${entry.m.offenders.join(' ')}] channelRefuses=${t.channelRefuses} inWithdrawnBucket=${t.inWithdrawnBucket} launderedIntoCoveredOrExempted=${t.laundered}`);
      observe(`${id} decision=${entry.m.decision?.decision}/${entry.m.decision?.userConfirmed} id=${entry.m.decision?.decisionId} refs=[${(entry.m.decision?.withdrawnChecklistItemRefs ?? []).join(' ')}] helperResolves=[${[...withdrawnChecklistItemIdsFrom(entry.m.decision)].join(' ')}]`);
      for (const detail of entry.m.channel.details) observe(`${id} detail: ${detail}`);
    }

    // Joint rows, one per intent lane, so a pinned selector covers every case
    // that lane claims rather than an arbitrary one of them.
    const jointVerdict = (ids) => {
      const values = ids.map((id) => dVerdicts.get(id));
      if (values.every((v) => v === 'REFUSED')) return 'REFUSED';
      if (values.every((v) => v === 'BYPASSED')) return 'BYPASSED';
      return 'MIXED';
    };
    row('D23', jointVerdict(['D2', 'D3']),
      'joint: are BOTH a decisionRef naming a decision that does not exist AND a decisionRef naming a real decision that does not list the item refused by both gates? REFUSED = yes');
    observe('D23 derived from the two rows above; MIXED would mean one of the two dangling-authority shapes got through');
    row('D45', jointVerdict(['D4', 'D5']),
      'joint: is a decision overwritten to decision=rejected / userConfirmed=false unable to authorize the skip by EITHER route, the raw file write and the CLI? REFUSED = yes');
    observe('D45 derived from the two rows above; MIXED would mean only one of the two routes to the same un-authorized state is caught');

    // ── E1: a withdrawal must not loosen a SURVIVING item's requirement ────
    // Measured on the item NOTHING withdrew. Its refs are its own positional one
    // and the shared alias; a subtraction that swallowed the alias leaves the
    // positional ref still demanded, so `gateTreatment` scores the completeness
    // half as a partial loss rather than a refusal. Ablating `survivingRefs` out
    // of dist moves this row REFUSED -> PARTIAL and nothing else in the report.
    const aliasT = gateTreatment(aliasM, aliasFx.survivingId);
    const aliasVerdict = aliasT.completenessRefuses && aliasT.channelRefuses
      ? 'REFUSED'
      : (!aliasT.completenessRefuses && !aliasT.channelRefuses ? 'BYPASSED' : 'PARTIAL');
    row('E1', aliasVerdict,
      'an item NO decision withdrew, sharing one authored intent alias with a withdrawn one: are ALL of its refs, the shared alias included, still demanded by both gates? REFUSED = yes');
    observe(`E1 subject=${aliasFx.survivingId} owns refs=[${aliasT.refs.join(' ')}] still demanded=[${aliasT.demanded.join(' ')}] completenessRefuses=${aliasT.completenessRefuses} channelRefuses=${aliasT.channelRefuses} inWithdrawnBucket=${aliasT.inWithdrawnBucket} launderedIntoCoveredOrExempted=${aliasT.laundered}`);

    const unbackedAllRefused = [...dVerdicts.values()].every((v) => v === 'REFUSED');
    exitCode = b3 === 'GREEN' && unbackedAllRefused && aliasVerdict === 'REFUSED' ? 0 : 1;
  }

  // Same measurement in both modes; only the exit code differs.
  if (ATTEST && exitCode === 1) exitCode = 0;
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

// ── report ──────────────────────────────────────────────────────────────────

// The joint verdict spans all three clauses: the gates must read an authorized
// withdrawal (B rows), must refuse every unbacked one (D rows), and must not let
// a withdrawal loosen a requirement carried by an item nothing withdrew (E row).
// A tree that skips work no decision authorized is not 'green' in any useful
// sense, so an unauthorized skip of EITHER shape overrides a passing B verdict.
const unauthorizedSkip = rows.some((r) => /^[DE]\d+$/.test(r.id) && r.verdict !== 'REFUSED' && r.verdict !== 'NOT-MEASURED');
const verdict = exitCode === 2
  ? 'BROKEN'
  : unauthorizedSkip
    ? 'BYPASS'
    : rows.find((r) => r.id === 'B3')?.verdict ?? 'BROKEN';

const lines = [];
lines.push('=== B-45a5 — do the two REVIEW-path gates read an item-level withdrawal, and can one be forged? ===');
if (ATTEST) {
  lines.push('mode=attest: exit 0 certifies the measurement RAN with sound controls, NOT that the tree is fixed.');
  lines.push('             the verdict is carried by the row markers below.');
} else {
  lines.push('mode=repro: exit 1 while either gate is RED or any unbacked withdrawal is not REFUSED,');
  lines.push('            0 when both gates are GREEN and every D row is REFUSED, 2 when a control is BROKEN.');
}
lines.push('');
// ROW INDEX, deliberately duplicated ahead of the detail. A consumer that pins a
// row id as a proof selector reads the FIRST occurrence, and captured output is
// capped by the runner (validation-executor trimOutput keeps the leading
// characters and drops the rest). Emitting every verdict up front means a pinned
// selector stays resolvable no matter how much detail this report grows below.
lines.push('--- row index (each row is repeated in full, with its claim and observations, below) ---');
for (const r of rows) lines.push(`B45A5-ROW-${r.id}=${r.verdict}`);
// B45A5-VERDICT is the most-pinned selector of all and its only other emission is
// the LAST line of the report, i.e. the first thing a truncation eats. Emitted
// here too, with the identical value, so it is reachable on the same terms as the
// rows. Duplication is the convention already in use above, not a new one.
lines.push(`B45A5-VERDICT=${verdict}`);
lines.push('--- end row index ---');
lines.push('');
for (const r of rows) {
  lines.push(`B45A5-ROW-${r.id}=${r.verdict}`);
  lines.push(`  ${r.claim}`);
  for (const text of observations.filter((o) => o.startsWith(`${r.id} `))) {
    lines.push(`    observed: ${text.slice(r.id.length + 1)}`);
  }
}
lines.push('');
lines.push(`B45A5-VERDICT=${verdict}`);
if (verdict === 'BROKEN') {
  lines.push('  a control or premise did not behave, so NOTHING is concluded about either gate.');
} else if (verdict === 'BYPASS') {
  lines.push('  a skip NO decision authorized was taken: either an unbacked withdrawal got through');
  lines.push('  (openable by editing JSON), or a withdrawal loosened a NON-withdrawn item\'s requirement.');
} else if (verdict === 'RED') {
  lines.push('  both gates demand delivery evidence for work a confirmed decision withdrew.');
} else if (verdict === 'MIXED') {
  lines.push('  exactly one gate learned about the withdrawal; the other did not.');
} else {
  lines.push('  both gates exclude the decision-backed withdrawn item, both still bite on everything that is');
  lines.push('  not withdrawn (including an item that only SHARES an authored intent alias with a withdrawn');
  lines.push('  one), and every unbacked withdrawal is still refused by both.');
}
console.log(lines.join('\n'));
// NOT process.exit(): on a PIPE (which is how `proof-or-stop validate` and the
// verification_evidence_add receipt runner both capture this) console.log is an
// ASYNC write, and process.exit() abandons whatever has not flushed yet. That
// silently truncated the tail of this report once it passed ~9 KB — the D45 row
// and the verdict line were simply missing from the captured output, so a
// consumer pinning a late row saw it as absent rather than as regressed. Setting
// exitCode and returning normally keeps the same status and flushes first.
process.exitCode = exitCode;
