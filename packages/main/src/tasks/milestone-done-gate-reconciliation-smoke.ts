#!/usr/bin/env node
/**
 * Reconciliation smoke: milestone_status vs the DONE intent-equivalence gate.
 *
 * @task B-f7b3
 * @checklist CHK-010
 * @title Reconcile the milestone_status vs DONE-gate stale-evidence disagreement and the closeout second-gate divergence
 * @type chore
 * @priority high
 * @description
 *   B-b550's completeness critic found two divergences between the milestone
 *   observability surface and the designed DONE gate:
 *     (a) STALE-EVIDENCE DISAGREEMENT: milestone_status demotes a row to
 *         statusDetail=stale (evidence=stale) when its evidence binding no longer
 *         matches, but evaluateDoneIntentEquivalence used a freshness-blind
 *         evidenceCoversIntent and could still PASS the same stale ledger.
 *     (b) CLOSEOUT SECOND-GATE: captureMilestoneCloseoutSnapshotFromStore could
 *         THROW on incomplete/stale ledger states, acting as an undesigned second
 *         DONE gate that diverges from evaluateDoneIntentEquivalence.
 *
 *   This smoke asserts the reconciliation:
 *     1. milestone_status and evaluateDoneIntentEquivalence now AGREE on stale
 *        milestone evidence: the row is demoted (not completed) AND the gate emits
 *        a stale_milestone_evidence diagnostic naming the same milestone.
 *     2. Under the DEFAULT observe mode the stale diagnostic is NON-BLOCKING
 *        (blocking:false); it only blocks under enforce.
 *     3. captureMilestoneCloseoutSnapshotFromStore does NOT throw on a DONE the
 *        designed gate allows — it degrades to a non-throwing 'skipped' capture
 *        for an unbuildable snapshot, and writes a snapshot for a clean/fresh one.
 *     4. (regression) A genuinely uncovered milestone still BLOCKS under enforce.
 *
 * @changes
 *   - [CHK-010] Assert milestone_status stale-row demotion and the DONE gate stale_milestone_evidence diagnostic agree on the same milestone.
 *   - [CHK-010] Assert stale milestone evidence is non-blocking under observe and blocking under enforce.
 *   - [CHK-010] Assert closeout capture does not throw on a DONE the designed gate allows (skips the unbuildable snapshot, writes the buildable one).
 *   - [CHK-010] Assert a genuinely uncovered milestone still blocks under enforce (regression guard).
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMilestoneStatusReport,
  type MilestoneStatusCurrentEvidenceBinding,
  type MilestoneCloseoutSnapshot,
} from '../core/milestone-status.js';
import { captureMilestoneCloseoutSnapshotFromStore } from '../handlers/milestone-status.js';
import { configuredProofStoryMode } from '../handlers/phase-gates.js';
import type { HandlerContext } from '../handlers/context.js';
import { resetConfigCache } from '../core/config.js';
import { evaluateDoneIntentEquivalence, type ProofStoryDiagnosticInput } from '../core/proofstory.js';
import type {
  ChecklistData,
  ChecklistItem,
  MilestoneLedgerData,
  MilestoneLedgerItem,
  StoryInfo,
  StorySummaryData,
  VerificationEvidence,
} from '../core/types.js';

// ── Fixture builders ────────────────────────────────────────────────────────

const FRESH_BINDING: MilestoneStatusCurrentEvidenceBinding = {
  headHash: 'head-current',
  materialHash: 'material-current',
  storyFilesHash: 'story-files-current',
};

const STALE_BINDING = {
  headHash: 'head-old',
  materialHash: 'material-old',
  storyFilesHash: 'story-files-old',
};

function story(storyId: string, phase: StoryInfo['phase'] = 'DEV'): StoryInfo {
  return {
    storyId,
    name: `${storyId.toLowerCase()}-reconciliation`,
    title: 'Reconciliation smoke story',
    description: 'Milestone status vs DONE gate reconciliation.',
    type: 'chore',
    phase,
    priority: 'high',
    createdAt: '2026-07-05T00:00:00.000Z',
    startedAt: '2026-07-05T00:00:00.000Z',
    endedAt: null,
  } as StoryInfo;
}

function intent(desc: string) {
  return { happy: [{ desc, type: 'logic' as const }], edge: [], adversarial: [] };
}

function evidence(
  intentRef: string,
  binding: MilestoneStatusCurrentEvidenceBinding,
  result: VerificationEvidence['result'] = 'pass',
): VerificationEvidence {
  return {
    intentRef,
    kind: 'logic_test',
    result,
    note: `${intentRef} ${result}`,
    command: `node ${intentRef}.test.mjs`,
    timestamp: '2026-07-05T00:00:00.000Z',
    ...binding,
  } as VerificationEvidence;
}

function checklistItem(
  id: string,
  status: ChecklistItem['status'],
  ev: VerificationEvidence[],
  vi: ReturnType<typeof intent>,
): ChecklistItem {
  return {
    id,
    title: `${id} title`,
    status,
    startTime: null,
    endTime: null,
    verificationIntent: vi,
    ...(ev.length > 0 ? { verificationEvidence: ev } : {}),
  } as ChecklistItem;
}

function ledger(milestones: MilestoneLedgerItem[], storyId: string): MilestoneLedgerData {
  return {
    schemaVersion: 'proofstory.milestone_ledger.v1',
    storyId,
    state: 'confirmed',
    ledgerHash: 'sha256:reconcile-fixture',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    milestones,
  } as unknown as MilestoneLedgerData;
}

function milestone(overrides: Partial<MilestoneLedgerItem> & { id: string }): MilestoneLedgerItem {
  return {
    sourceRequirementId: 'REQ-001',
    claim: 'Reconciliation claim',
    doneMeans: 'Reconciliation done means',
    checklistRefs: [],
    verificationIntentRefs: [],
    status: 'done',
    ...overrides,
  } as MilestoneLedgerItem;
}

function diagnosticInput(
  storyId: string,
  checklist: ChecklistData,
  milestoneLedger: MilestoneLedgerData,
  currentEvidenceBinding: MilestoneStatusCurrentEvidenceBinding | undefined,
  summary?: StorySummaryData | null,
): ProofStoryDiagnosticInput {
  return {
    story: story(storyId),
    checklist,
    originalIntentSnapshot: null,
    milestoneLedger,
    slicePlan: null,
    parentLedgerRollup: null,
    proofStoryContract: null,
    intentCollision: null,
    scopeContract: null,
    scopeShrinkageDecision: null,
    redEvidence: null,
    spikeEvidence: null,
    summary: summary ?? null,
    currentEvidenceBinding,
  };
}

// ── (a) stale-evidence AGREEMENT ────────────────────────────────────────────
{
  const storyId = 'B-recon-stale';
  const ref = 'CHK-001:happy:0';
  const checklist: ChecklistData = {
    items: [
      // Passing evidence, but its binding is STALE against the current binding.
      checklistItem('CHK-001', 'done', [evidence(ref, STALE_BINDING)], intent('stale-covered intent')),
    ],
  };
  const led = ledger(
    [milestone({ id: 'M1', checklistRefs: ['CHK-001'], verificationIntentRefs: [ref], status: 'done' })],
    storyId,
  );

  // milestone_status: the row must be demoted (NOT completed) and marked stale.
  const statusReport = buildMilestoneStatusReport({
    story: story(storyId),
    checklist,
    milestoneLedger: led,
    currentEvidenceBinding: FRESH_BINDING,
  });
  const m1Status = statusReport.milestones.find((row) => row.id === 'M1');
  assert.ok(m1Status, 'milestone_status must include row M1');
  assert.notEqual(m1Status.status, 'completed', 'milestone_status must NOT mark a stale row completed');
  assert.match(m1Status.statusDetail, /evidence=stale/, 'milestone_status must report evidence=stale for a stale row');
  assert.ok(
    !statusReport.groups.completed.includes('M1'),
    'milestone_status must not place a stale row in the completed group',
  );

  // DONE gate (observe): must now AGREE — emit stale_milestone_evidence naming M1,
  // and it must be NON-BLOCKING.
  const observe = evaluateDoneIntentEquivalence(
    diagnosticInput(storyId, checklist, led, FRESH_BINDING),
    'observe',
  );
  assert.ok(
    observe.staleMilestoneEvidenceIds.includes('M1'),
    `DONE gate must flag M1 as stale-covered; got ${JSON.stringify(observe.staleMilestoneEvidenceIds)}`,
  );
  const staleGap = observe.gaps.find((g) => g.code === 'stale_milestone_evidence');
  assert.ok(staleGap, 'DONE gate must emit a stale_milestone_evidence gap');
  assert.equal(staleGap.severity, 'warn', 'stale_milestone_evidence must be severity warn (non-blocking under observe)');
  assert.match(staleGap.message, /M1/, 'stale gap message must name the stale milestone');
  assert.equal(observe.blocking, false, 'stale milestone evidence must NOT block under the default observe mode');
  // M1 base-covers, so it must NOT be in the hard uncovered set.
  assert.ok(
    !observe.uncoveredRequiredMilestoneIds.includes('M1'),
    'a base-covered-but-stale milestone must be a stale diagnostic, not an uncovered_required gap',
  );

  // DONE gate (enforce): the same stale diagnostic now BLOCKS.
  const enforce = evaluateDoneIntentEquivalence(
    diagnosticInput(storyId, checklist, led, FRESH_BINDING),
    'enforce',
  );
  assert.equal(enforce.blocking, true, 'stale milestone evidence must block under enforce');
  assert.equal(enforce.status, 'fail', 'stale milestone evidence must fail under enforce');

  // Reconciliation invariant: milestone_status "row is stale" iff DONE gate flags it.
  const statusSaysStale = m1Status.statusDetail.includes('evidence=stale');
  const gateSaysStale = observe.staleMilestoneEvidenceIds.includes('M1');
  assert.equal(statusSaysStale, gateSaysStale, 'milestone_status and DONE gate must AGREE on stale milestone M1');

  // Backward-compat: with NO current binding, freshness is not evaluated and the
  // stale row base-covers (gate passes clean) — proving the change is opt-in.
  const noBinding = evaluateDoneIntentEquivalence(
    diagnosticInput(storyId, checklist, led, undefined),
    'observe',
  );
  assert.equal(
    noBinding.staleMilestoneEvidenceIds.length,
    0,
    'without a current binding the gate must not fabricate staleness (base coverage preserved)',
  );
  assert.equal(noBinding.gaps.length, 0, 'without a binding a fully base-covered ledger must have no gaps');
}

// ── (a') FRESH evidence: no disagreement, both surfaces pass clean ──────────
{
  const storyId = 'B-recon-fresh';
  const ref = 'CHK-001:happy:0';
  const checklist: ChecklistData = {
    items: [checklistItem('CHK-001', 'done', [evidence(ref, FRESH_BINDING)], intent('fresh-covered intent'))],
  };
  const led = ledger(
    [milestone({ id: 'M1', checklistRefs: ['CHK-001'], verificationIntentRefs: [ref], status: 'done' })],
    storyId,
  );
  const statusReport = buildMilestoneStatusReport({
    story: story(storyId),
    checklist,
    milestoneLedger: led,
    currentEvidenceBinding: FRESH_BINDING,
  });
  const m1 = statusReport.milestones.find((row) => row.id === 'M1');
  assert.ok(m1 && m1.status === 'completed', 'fresh covered milestone must be completed in milestone_status');
  assert.match(m1.statusDetail, /evidence=covered/, 'fresh covered milestone reports evidence=covered');

  const gate = evaluateDoneIntentEquivalence(diagnosticInput(storyId, checklist, led, FRESH_BINDING), 'enforce');
  assert.equal(gate.staleMilestoneEvidenceIds.length, 0, 'fresh evidence must produce no stale ids');
  assert.equal(gate.blocking, false, 'fresh fully covered ledger must not block even under enforce');
  assert.equal(gate.status, 'pass', 'fresh fully covered ledger must pass');
}

// ── (b) closeout does NOT act as a divergent second gate ────────────────────

// Minimal in-memory store double for captureMilestoneCloseoutSnapshotFromStore.
function makeStore(
  storyId: string,
  storyPhase: StoryInfo['phase'],
  checklist: ChecklistData,
  milestoneLedger: MilestoneLedgerData | null,
) {
  let written: MilestoneCloseoutSnapshot | undefined;
  return {
    handle: {
      readStory: (_id: string) => story(storyId, storyPhase),
      readChecklist: (_id: string) => checklist,
      readMilestoneLedger: (_id: string) => milestoneLedger,
      readSummary: (_id: string): StorySummaryData | null => null,
      writeMilestoneCloseout: (_id: string, snapshot: MilestoneCloseoutSnapshot) => {
        written = snapshot;
      },
    },
    getWritten: () => written,
  };
}

// (b.1) A DONE the designed gate ALLOWS (fresh, complete) → closeout WRITES,
//        does not throw.
{
  const storyId = 'B-recon-closeout-ok';
  const ref = 'CHK-001:happy:0';
  const checklist: ChecklistData = {
    items: [checklistItem('CHK-001', 'done', [evidence(ref, FRESH_BINDING)], intent('closeout-ok intent'))],
  };
  const led = ledger(
    [milestone({ id: 'M1', checklistRefs: ['CHK-001'], verificationIntentRefs: [ref], status: 'done' })],
    storyId,
  );
  const { handle, getWritten } = makeStore(storyId, 'DONE', checklist, led);
  let result: ReturnType<typeof captureMilestoneCloseoutSnapshotFromStore> | undefined;
  assert.doesNotThrow(() => {
    result = captureMilestoneCloseoutSnapshotFromStore(handle as never, storyId, {
      currentEvidenceBinding: FRESH_BINDING,
    });
  }, 'closeout must not throw on a clean DONE the designed gate allows');
  assert.ok(result && result.status === 'written', 'closeout must WRITE a snapshot for a clean fresh DONE');
  assert.ok(getWritten(), 'closeout snapshot must be persisted for a clean fresh DONE');
}

// (b.2) A stale/incomplete report (buildMilestoneCloseoutSnapshot would THROW)
//        → capture DEGRADES to a non-throwing 'skipped', never a throw.
{
  const storyId = 'B-recon-closeout-stale';
  const ref = 'CHK-001:happy:0';
  const checklist: ChecklistData = {
    items: [checklistItem('CHK-001', 'done', [evidence(ref, STALE_BINDING)], intent('closeout-stale intent'))],
  };
  const led = ledger(
    [milestone({ id: 'M1', checklistRefs: ['CHK-001'], verificationIntentRefs: [ref], status: 'done' })],
    storyId,
  );
  const { handle, getWritten } = makeStore(storyId, 'DONE', checklist, led);
  let result: ReturnType<typeof captureMilestoneCloseoutSnapshotFromStore> | undefined;
  assert.doesNotThrow(() => {
    result = captureMilestoneCloseoutSnapshotFromStore(handle as never, storyId, {
      currentEvidenceBinding: FRESH_BINDING,
    });
  }, 'closeout must NOT throw on a stale report — that would be an undesigned second gate');
  assert.ok(
    result && result.status === 'skipped' && result.reason === 'closeout_snapshot_unbuildable',
    `closeout must degrade a stale/unbuildable report to a non-throwing skip; got ${JSON.stringify(result)}`,
  );
  assert.equal(getWritten(), undefined, 'no snapshot may be persisted when the report is unbuildable');
}

// (b.3) A missing ledger still skips cleanly (pre-existing behavior preserved).
{
  const storyId = 'B-recon-closeout-noledger';
  const { handle } = makeStore(storyId, 'DONE', { items: [] }, null);
  const result = captureMilestoneCloseoutSnapshotFromStore(handle as never, storyId, {});
  assert.ok(
    result.status === 'skipped' && result.reason === 'missing_milestone_ledger',
    'missing ledger must still skip cleanly',
  );
}

// ── (regression) genuinely uncovered milestone still BLOCKS under enforce ───
{
  const storyId = 'B-recon-uncovered';
  const checklist: ChecklistData = {
    items: [
      // Item exists but has NO passing evidence for the mapped intent ref.
      checklistItem('CHK-001', 'done', [], intent('uncovered intent')),
    ],
  };
  const led = ledger(
    [milestone({ id: 'M1', checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'done' })],
    storyId,
  );
  const enforce = evaluateDoneIntentEquivalence(
    diagnosticInput(storyId, checklist, led, FRESH_BINDING),
    'enforce',
  );
  assert.ok(
    enforce.uncoveredRequiredMilestoneIds.includes('M1'),
    'a milestone with no covering evidence must be uncovered_required',
  );
  assert.equal(enforce.blocking, true, 'a genuinely uncovered milestone must still block under enforce');
  assert.ok(
    !enforce.staleMilestoneEvidenceIds.includes('M1'),
    'an uncovered (no evidence at all) milestone is uncovered, not stale',
  );
}

// ── (c) gate-mode DEFAULT pins to 'observe' when config is unset ────────────
//
// B-f7b3 (F-001/F-003): the milestone-triggered-gate-mode-default decision
// (docs/requirements/decisions/milestone-triggered-gate-mode-default-decision.md)
// records that `doneGateMode`/`reviewGateMode` MUST default to `observe`. This
// pins that default against the REAL resolver — configuredProofStoryMode in
// packages/main/src/handlers/phase-gates.ts — NOT a re-implemented `?? 'observe'`
// in this test. It exercises the config-key-ABSENT path: a fresh temp root with
// NO lattice.config.json, so loadConfig(root).proofStory is undefined and only the
// `?? 'observe'` fallback can produce the result.
//
// UN-GAMEABLE GUARANTEE: if a future edit flips that fallback in phase-gates.ts to
// `?? 'enforce'` (or removes the default), this block MUST fail. Do not "fix" a
// failure here by re-pointing the assertion at a copied default — the whole point
// is that it runs the shipped resolver.
{
  const emptyRoot = mkdtempSync(join(tmpdir(), 'b-f7b3-gate-mode-default-'));
  try {
    // Ensure loadConfig does not serve a cached config for this fresh root.
    resetConfigCache();
    // Minimal HandlerContext: configuredProofStoryMode only reads ctx.root.
    const ctx = { root: emptyRoot } as unknown as HandlerContext;

    assert.equal(
      configuredProofStoryMode(ctx, 'doneGateMode'),
      'observe',
      'doneGateMode MUST default to observe when unset — flipping the phase-gates ?? fallback to enforce must fail this',
    );
    assert.equal(
      configuredProofStoryMode(ctx, 'reviewGateMode'),
      'observe',
      'reviewGateMode MUST default to observe when unset — flipping the phase-gates ?? fallback to enforce must fail this',
    );
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// eslint-disable-next-line no-console
console.log('milestone-done-gate-reconciliation-smoke: OK');
