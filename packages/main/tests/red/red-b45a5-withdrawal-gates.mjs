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
 * ── TWO MODES ───────────────────────────────────────────────────────────────
 *
 *   (default)   repro-first: exit 1 while either gate is RED, 0 when both are
 *               GREEN, 2 when a control/premise is BROKEN. This is the mode
 *               registered in `lattice.config.json`.
 *   --attest    identical measurement, identical rows, but exit 0 whenever the
 *               measurement RAN CLEANLY (all controls/premises OK), so it can be
 *               pinned as a tool-executed `verification_evidence_add` command,
 *               whose selector then carries the verdict. Exit 0 here certifies
 *               ONLY that the measurement completed with sound controls — it
 *               does NOT claim the tree is fixed. Read `B45A5-VERDICT=` for that.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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

  const broken = rows.filter((r) => r.verdict === 'BROKEN');

  if (broken.length > 0) {
    // NO conclusion is drawn about the gates.
    row('B1', 'NOT-MEASURED', 'the completeness gate\'s handling of the authorized withdrawal was not evaluated');
    row('B2', 'NOT-MEASURED', 'the channel gate\'s handling of the authorized withdrawal was not evaluated');
    row('B3', 'NOT-MEASURED', 'no joint conclusion is available while a control or premise is BROKEN');
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
    exitCode = b3 === 'GREEN' ? 0 : 1;
  }

  // Same measurement in both modes; only the exit code differs.
  if (ATTEST && exitCode === 1) exitCode = 0;
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

// ── report ──────────────────────────────────────────────────────────────────

const verdict = exitCode === 2
  ? 'BROKEN'
  : rows.find((r) => r.id === 'B3')?.verdict ?? 'BROKEN';

const lines = [];
lines.push('=== B-45a5 CHK-001 — do the two REVIEW-path gates read an item-level withdrawal? ===');
if (ATTEST) {
  lines.push('mode=attest: exit 0 certifies the measurement RAN with sound controls, NOT that the tree is fixed.');
  lines.push('             the verdict is carried by the row markers below.');
} else {
  lines.push('mode=repro: exit 1 while either gate is RED, 0 when both are GREEN, 2 when a control is BROKEN.');
}
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
} else if (verdict === 'RED') {
  lines.push('  both gates demand delivery evidence for work a confirmed decision withdrew.');
} else if (verdict === 'MIXED') {
  lines.push('  exactly one gate learned about the withdrawal; the other did not.');
} else {
  lines.push('  both gates exclude the withdrawn item, and both still bite on everything that is not withdrawn.');
}
console.log(lines.join('\n'));
process.exit(exitCode);
