#!/usr/bin/env node
/**
 * @task B-c389
 * @checklist CHK-003
 * @title capability candidate structured-outcome recording + evidence-based promotion (M7)
 * @type feature
 * @priority high
 * @description
 *   Hermetic proof that a CAPABILITY-flavored candidate (its lineage carries a
 *   capabilityReleaseId — the post-backfill PBP-882 shape) flows through the
 *   ALREADY-EXISTING M7 contract without any new mechanism:
 *
 *     (happy) A structured outcome (exposureMode=candidate-inspection + a
 *       structured verdictSource, verdict=helped) is ACCEPTED by the real
 *       playbook_outcome_record handler and written to the outcomes ledger.
 *       With enough structured helped outcomes across ≥2 context classes,
 *       playbook_promotion_sweep's aggregation counts them toward decisiveSamples
 *       and EMITS a recommend_activate recommendation — while NEVER auto-activating
 *       (dry-run writes nothing; apply appends an idempotent recommendation row but
 *       leaves the candidate status='candidate').
 *
 *     (edge) A done-settlement helped outcome does NOT count toward
 *       helped/decisiveSamples; helped REQUIRES exposureMode != none + a structured
 *       verdictSource (the handler refuses exposureMode=none + verdict=helped; the
 *       aggregate excludes done-settlement). Asserted for the capability candidate.
 *
 *     (adversarial) No path activates the capability candidate without concrete
 *       exposure + a structured verdict: with ZERO structured helped outcomes the
 *       sweep never recommends activation, and even a full recommend_activate
 *       recommendation (dry-run OR apply) leaves the on-disk status='candidate'
 *       (the sweep records recommendations only; it never flips status).
 *
 *   Fully hermetic: all fixtures live under mkdtemp; no live repo-root .lattice
 *   state is read. This file adds NO new mechanism — it pins the existing M7 path.
 *
 * @changes
 *   - [CHK-003] Prove a capability candidate flows through playbook_outcome_record
 *     + playbook_promotion_sweep's aggregation to a recommend_activate recommendation
 *     that never auto-activates, and pin the helped/decisive exclusion invariants.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Playbook } from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  evaluatePlaybookPromotion,
  isPositiveHelpedPlaybookOutcome,
  readPlaybookOutcomeEvents,
  readPlaybooks,
  writePlaybooks,
} from '../core/learning-store.js';
import { StoryStore } from '../core/store.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';

const NOW = '2026-07-05T00:00:00.000Z';
const PLAYBOOK_ID = 'PBP-882';
const STORY_ID = 'B-785e';
const CAP_RELEASE_ID = 'PCR-capability-release-m7promotion';
const CAP_ID = 'experiments-multi-model-ablation';
const CAP_VERSION = '9896bd874641';

function mkdtemp(prefix: string): string {
  return execFileSync('mktemp', ['-d', join(tmpdir(), `${prefix}XXXXXX`)], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

/** The post-backfill PBP-882 shape: a candidate whose lineage carries a capabilityReleaseId. */
function capabilityCandidate(): Playbook {
  return {
    id: PLAYBOOK_ID,
    title: 'Playbook: capability release provenance for B-785e',
    trigger: {
      keywords: ['capability', 'release', 'provenance'],
      fileKinds: ['jsonl'],
      storyPhases: ['DONE', 'REVIEW'],
    },
    check: 'Before similar work, confirm the capability release provenance binding.',
    pitfalls: ['Do not treat capability release seed material as authoritative gate evidence.'],
    verification: ['Confirm the source condition behind B-785e:DONE-EXPERIENCE cannot recur'],
    lineage: {
      sourceStoryId: STORY_ID,
      sourceFindingId: 'B-785e:DONE-EXPERIENCE',
      sourceSignature: 'done_experience',
      capabilityReleaseId: CAP_RELEASE_ID,
      capabilityId: CAP_ID,
      capabilityVersion: CAP_VERSION,
    },
    status: 'candidate',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

/**
 * A structured (non done-settlement) helped-outcome record argument set for the
 * real playbook_outcome_record handler. The `triggerClasses` differ per call so
 * the outcomes span ≥2 distinct context classes (contextClassCount ≥ 2, needed
 * for a recommend_activate recommendation).
 */
function structuredHelpedArgs(eventId: string, triggerClass: string) {
  return {
    storyId: STORY_ID,
    playbookId: PLAYBOOK_ID,
    eventId,
    idempotencyKey: `structured-${eventId}`,
    observedAt: NOW,
    exposureMode: 'candidate-inspection',
    consumer: 'dev_memory_start',
    context: { fileKinds: ['jsonl'], triggerClasses: [triggerClass] },
    outcome: {
      verdict: 'helped',
      verdictSource: 'reviewer-confirmation',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: true,
    },
  };
}

const cleanup: string[] = [];
// The M7 sweep --apply requires the promotion-sweep feature flag; set it for the
// smoke process (dry-run never needs it). Restore afterwards.
const priorFlag = process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED;

try {
  const root = mkdtemp('capability-candidate-promotion-');
  cleanup.push(root);
  write(root, 'lattice.config.json', '{}');
  writePlaybooks(root, [capabilityCandidate()]);

  const handlers = createPlaybookHandlers({
    root,
    store: new StoryStore(root),
    scanRoot: join(root, 'packages/main'),
  });

  // ── HAPPY: structured outcomes accepted → sweep recommends activate, no activation ─
  check('HAPPY: playbook_outcome_record accepts structured helped outcomes for the capability candidate', () => {
    // Three structured helped outcomes across TWO context classes (delivery x2, review x1)
    // → decisiveSamples=3 (>= minDecisiveSamples 3), helped=3 (>= minHelpedCount 2),
    //   contextClassCount=2 (>= minContextClasses 2), dismissalRate 0, no harmful/wrongClaim.
    handlers.playbook_outcome_record(structuredHelpedArgs('ev-a', 'delivery'));
    handlers.playbook_outcome_record(structuredHelpedArgs('ev-b', 'delivery'));
    handlers.playbook_outcome_record(structuredHelpedArgs('ev-c', 'review'));

    const rows = readPlaybookOutcomeEvents(root);
    assert.equal(rows.length, 3, 'three structured outcomes were recorded');
    for (const row of rows) {
      assert.equal(row.playbookId, PLAYBOOK_ID);
      assert.equal(row.exposureMode, 'candidate-inspection', 'concrete exposure mode (not none)');
      assert.equal(row.outcome.verdict, 'helped');
      assert.equal(row.outcome.verdictSource, 'reviewer-confirmation', 'a structured verdictSource');
      assert.equal(isPositiveHelpedPlaybookOutcome(row), true, 'each is a positive helped outcome');
    }
  });

  check('HAPPY: aggregatePlaybookPromotion counts the structured outcomes toward decisiveSamples', () => {
    const candidate = readPlaybooks(root).find((p) => p.id === PLAYBOOK_ID)!;
    const aggregate = aggregatePlaybookPromotion(candidate, readPlaybookOutcomeEvents(root));
    assert.equal(aggregate.helpedCount, 3);
    assert.equal(aggregate.decisiveSamples, 3, 'three decisive samples');
    assert.equal(aggregate.dismissedCount, 0);
    assert.equal(aggregate.harmfulCount, 0);
    assert.equal(aggregate.wrongClaimCount, 0);
    assert.equal(aggregate.contextClassCount, 2, 'two distinct context classes');
    // The evaluator recommends activation on this aggregate (threshold met).
    const evaluation = evaluatePlaybookPromotion(aggregate);
    assert.equal(evaluation.action, 'recommend_activate');
    assert.ok(evaluation.reasonCodes.includes('activation_threshold_met'));
  });

  let dryDigest = '';
  check('HAPPY: playbook_promotion_sweep dry-run EMITS a recommend_activate recommendation (writes nothing)', () => {
    const report = JSON.parse(handlers.playbook_promotion_sweep({ json: true }) as string);
    assert.equal(report.dryRun, true);
    assert.equal(report.applied, false);
    const decision = report.decisions.find((d: { playbookId: string }) => d.playbookId === PLAYBOOK_ID);
    assert.ok(decision, 'the capability candidate has a sweep decision');
    assert.equal(decision.action, 'recommend_activate', 'sweep recommends activation when decisiveSamples suffice');
    assert.equal(decision.aggregate.decisiveSamples, 3);
    assert.equal(decision.aggregate.helpedCount, 3);
    // Dry-run recommendation NEVER activates: the candidate is still 'candidate' on disk.
    assert.equal(readPlaybooks(root).find((p) => p.id === PLAYBOOK_ID)!.status, 'candidate');
    dryDigest = decision.aggregateDigest;
    assert.ok(typeof dryDigest === 'string' && dryDigest.length > 0);
  });

  check('HAPPY: playbook_promotion_sweep --apply appends an idempotent recommendation but NEVER activates', () => {
    process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED = '1';
    const first = JSON.parse(handlers.playbook_promotion_sweep({ apply: true, json: true }) as string);
    assert.equal(first.applied, true);
    const d1 = first.decisions.find((d: { playbookId: string }) => d.playbookId === PLAYBOOK_ID);
    assert.equal(d1.action, 'recommend_activate');
    assert.equal(d1.applied, true);
    assert.equal(d1.alreadyApplied ?? false, false, 'first apply writes a fresh recommendation row');
    // Applying the recommendation does NOT flip the candidate to active.
    assert.equal(readPlaybooks(root).find((p) => p.id === PLAYBOOK_ID)!.status, 'candidate', 'sweep apply never activates');

    // IDEMPOTENT: a second apply recognizes the existing recommendation (alreadyApplied).
    const second = JSON.parse(handlers.playbook_promotion_sweep({ apply: true, json: true }) as string);
    const d2 = second.decisions.find((d: { playbookId: string }) => d.playbookId === PLAYBOOK_ID);
    assert.equal(d2.action, 'recommend_activate');
    assert.equal(d2.alreadyApplied, true, 're-apply is idempotent (recommendation already recorded)');
    assert.equal(readPlaybooks(root).find((p) => p.id === PLAYBOOK_ID)!.status, 'candidate');
  });

  // ── EDGE: done-settlement excluded; helped requires exposureMode != none ───────
  check('EDGE: a done-settlement helped outcome does NOT count toward helped/decisiveSamples', () => {
    // Record a done-settlement helped outcome for the same capability candidate.
    handlers.playbook_outcome_record({
      ...structuredHelpedArgs('ev-done', 'delivery'),
      outcome: {
        verdict: 'helped',
        verdictSource: 'done-settlement',
        causedNoise: false,
        causedWrongClaim: false,
        preventedRepeatFinding: true,
      },
    });
    const doneRow = readPlaybookOutcomeEvents(root).find((r) => r.eventId === 'ev-done')!;
    // The handler accepts it as a well-formed row, but it is NOT a positive helped outcome…
    assert.equal(doneRow.outcome.verdictSource, 'done-settlement');
    assert.equal(isPositiveHelpedPlaybookOutcome(doneRow), false, 'done-settlement is never a positive helped outcome');
    // …and the aggregate does NOT grow helped/decisiveSamples because of it (still 3 helped, 3 decisive).
    const candidate = readPlaybooks(root).find((p) => p.id === PLAYBOOK_ID)!;
    const aggregate = aggregatePlaybookPromotion(candidate, readPlaybookOutcomeEvents(root));
    assert.equal(aggregate.helpedCount, 3, 'done-settlement did not increment helped');
    assert.equal(aggregate.decisiveSamples, 3, 'done-settlement did not increment decisiveSamples');
  });

  check('EDGE: playbook_outcome_record REFUSES a helped outcome with exposureMode=none (helped requires != none)', () => {
    assert.throws(
      () => handlers.playbook_outcome_record({
        ...structuredHelpedArgs('ev-none', 'delivery'),
        exposureMode: 'none',
      }),
      /helped outcomes require exposureMode other than none/,
    );
    // The refused outcome was NOT written.
    assert.equal(readPlaybookOutcomeEvents(root).some((r) => r.eventId === 'ev-none'), false);
  });

  // ── ADVERSARIAL: no activation without concrete exposure + structured verdict ──
  check('ADVERSARIAL: with ZERO structured helped outcomes the sweep never recommends activation', () => {
    const barrenRoot = mkdtemp('capability-candidate-promotion-barren-');
    cleanup.push(barrenRoot);
    write(barrenRoot, 'lattice.config.json', '{}');
    writePlaybooks(barrenRoot, [capabilityCandidate()]);
    const barren = createPlaybookHandlers({
      root: barrenRoot,
      store: new StoryStore(barrenRoot),
      scanRoot: join(barrenRoot, 'packages/main'),
    });
    // No outcomes recorded at all → the sweep holds (insufficient decisive samples),
    // never recommends activation, and the candidate stays 'candidate'.
    const report = JSON.parse(barren.playbook_promotion_sweep({ json: true }) as string);
    const decision = report.decisions.find((d: { playbookId: string }) => d.playbookId === PLAYBOOK_ID);
    assert.ok(decision);
    assert.notEqual(decision.action, 'recommend_activate', 'no exposure/verdict → never recommend activation');
    assert.equal(decision.action, 'hold');
    assert.ok(decision.reasonCodes.includes('insufficient_decisive_samples'));
    assert.equal(readPlaybooks(barrenRoot).find((p) => p.id === PLAYBOOK_ID)!.status, 'candidate');
  });

  check('ADVERSARIAL: even a full recommend_activate recommendation leaves the candidate status=candidate (no auto-activation)', () => {
    // The main root has a recommend_activate recommendation applied above; re-read
    // the on-disk playbook and confirm the sweep NEVER flipped it to active.
    const candidate = readPlaybooks(root).find((p) => p.id === PLAYBOOK_ID)!;
    assert.equal(candidate.status, 'candidate', 'a recommendation is advisory; the sweep never activates');
    // And a dry-run recommendation likewise never activates.
    const report = JSON.parse(handlers.playbook_promotion_sweep({ dryRun: true, json: true }) as string);
    const decision = report.decisions.find((d: { playbookId: string }) => d.playbookId === PLAYBOOK_ID);
    assert.equal(decision.action, 'recommend_activate');
    assert.equal(readPlaybooks(root).find((p) => p.id === PLAYBOOK_ID)!.status, 'candidate');
  });

  console.log(`capability-candidate-promotion smoke passed: ${passed} checks`);
} finally {
  if (priorFlag === undefined) delete process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED;
  else process.env.PLAYBOOK_PROMOTION_SWEEP_ENABLED = priorFlag;
  for (const dir of cleanup.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
