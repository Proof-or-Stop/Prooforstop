#!/usr/bin/env node
/**
 * @task B-c389
 * @checklist CHK-002
 * @title capability candidate pending-learning exposure + exposure records (M6)
 * @type feature
 * @priority high
 * @description
 *   Hermetic proof that a CAPABILITY-flavored candidate (its lineage carries a
 *   capabilityReleaseId — the post-backfill PBP-882 shape) flows through the
 *   ALREADY-EXISTING M6 exposure surfaces without any new mechanism:
 *
 *     (happy) It appears in the real playbook_promotion_status pendingLearning
 *       surface WITH its capabilityRelease lineage, and an exposure record is
 *       produced + observable via the existing candidate-exposure trial path
 *       (playbook_trial_run --apply → a playbook-outcome row with
 *       exposureMode=candidate-inspection, verdictSource=candidate-trial, carrying
 *       the candidate's playbookId + capabilityReleaseId via its lineage, storyId,
 *       consumer(surface), observedAt).
 *
 *     (edge) The capability candidate surfaces ONLY under
 *       pendingLearning / promotionRecommendations / candidate-inspection — it is
 *       excluded from ACTIVE runtime surfacing: matchRuntimePlaybooks returns none
 *       and MemoryFreshnessPack.results.playbookIds omits it (the status==='active'
 *       guard in matchActivePlaybook, unchanged). Flipping the SAME playbook to
 *       active is what surfaces it — proving the status guard is the gate.
 *
 *     (adversarial) Writing/observing an exposure record does NOT change the
 *       candidate status (stays 'candidate') and is NOT treated as a helped
 *       outcome (the trial exposure verdict is 'unknown'; isPositiveHelped
 *       PlaybookOutcome is false; aggregatePlaybookPromotion counts 0 helped /
 *       0 decisiveSamples for the pure exposure).
 *
 *   Fully hermetic: all fixtures live under mkdtemp; no live repo-root .lattice
 *   state is read. This file adds NO new mechanism — it pins the existing M6 path.
 *
 * @changes
 *   - [CHK-002] Prove a capability candidate flows through the existing M6
 *     pending-learning surface + candidate-exposure trial without weakening the
 *     active-surfacing status guard or producing a helped outcome.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Playbook } from '../core/experience-layer-types.js';
import {
  aggregatePlaybookPromotion,
  isPositiveHelpedPlaybookOutcome,
  readPlaybookOutcomeEvents,
  readPlaybooks,
  writePlaybooks,
} from '../core/learning-store.js';
import {
  buildMemoryFreshnessPack,
  matchRuntimePlaybooks,
} from '../core/playbook-runtime-memory.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { createPlaybookHandlers } from '../handlers/playbook.js';

const NOW = '2026-07-05T00:00:00.000Z';
const STORY_ID = 'B-785e';
const CAP_RELEASE_ID = 'PCR-capability-release-m6exposure';
const CAP_ID = 'experiments-multi-model-ablation';
const CAP_VERSION = '9896bd874641';
/** A query that matches the capability candidate's trigger/text, so the ONLY
 *  possible reason it is excluded from active surfacing is the status guard. */
const QUERY = 'capability release provenance';

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

/**
 * The post-backfill PBP-882 shape: a candidate playbook whose lineage carries a
 * capabilityReleaseId (a capability-flavored candidate). Trigger keywords match
 * QUERY so that, once active, it WOULD surface at runtime.
 */
function capabilityCandidate(status: Playbook['status']): Playbook {
  return {
    id: 'PBP-882',
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
      sourceStoryId: 'B-785e',
      sourceFindingId: 'B-785e:DONE-EXPERIENCE',
      sourceSignature: 'done_experience',
      capabilityReleaseId: CAP_RELEASE_ID,
      capabilityId: CAP_ID,
      capabilityVersion: CAP_VERSION,
    },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

/** A minimal on-disk story so the candidate-exposure trial path can read its context. */
function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: STORY_ID,
    title: 'Capability release provenance',
    description: 'Synthetic story fixture for the M6 candidate-exposure smoke.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: NOW }],
  };
}

const cleanup: string[] = [];

try {
  // ── HAPPY: pendingLearning surfaces the capability candidate + exposure record ─
  const root = mkdtemp('capability-candidate-exposure-');
  cleanup.push(root);
  write(root, 'lattice.config.json', JSON.stringify({ storyDir: '.lattice/story/actives' }));
  writePlaybooks(root, [capabilityCandidate('candidate')]);

  const store = new StoryStore(root);
  // The candidate-exposure trial reads the story context; write a minimal story.
  store.writeStory(STORY_ID, story());
  const handlers = createPlaybookHandlers({
    root,
    store,
    scanRoot: join(root, 'packages/main'),
  });

  check('HAPPY: playbook_promotion_status pendingLearning surfaces the capability candidate WITH its lineage', () => {
    const json = JSON.parse(handlers.playbook_promotion_status({ json: true }) as string) as {
      pendingLearning: Array<{
        playbookId: string;
        status: string;
        label: string;
        capabilityRelease?: { capabilityReleaseId: string; capabilityId?: string; capabilityVersion?: string };
      }>;
    };
    const row = json.pendingLearning.find((p) => p.playbookId === 'PBP-882');
    assert.ok(row, 'the capability candidate must appear in pendingLearning');
    assert.equal(row?.status, 'candidate');
    assert.equal(row?.label, 'pending learning material; not active runtime guidance');
    // The capabilityRelease lineage rides on the pendingLearning row (M5/M6 surface).
    assert.equal(row?.capabilityRelease?.capabilityReleaseId, CAP_RELEASE_ID);
    assert.equal(row?.capabilityRelease?.capabilityId, CAP_ID);
    assert.equal(row?.capabilityRelease?.capabilityVersion, CAP_VERSION);

    // The TEXT render carries the same capability-release segment.
    const text = handlers.playbook_promotion_status({}) as string;
    assert.ok(text.includes(`capabilityRelease=${CAP_RELEASE_ID}`));
    assert.ok(text.includes(`(${CAP_ID} v${CAP_VERSION})`));
  });

  check('HAPPY: candidate-exposure trial (playbook_trial_run --apply) writes an observable exposure record', () => {
    // DRY-RUN first: the candidate is in scope, nothing is written yet.
    const dry = JSON.parse(handlers.playbook_trial_run({ storyId: 'B-785e', consumer: 'session_brief', json: true }) as string);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.candidateCount, 1);
    assert.equal(dry.outcomeCreatedCount, 0, 'dry-run writes no exposure record');
    assert.equal(readPlaybookOutcomeEvents(root).length, 0);

    // APPLY: the existing candidate-exposure path writes exactly one exposure row.
    const applied = JSON.parse(handlers.playbook_trial_run({ storyId: 'B-785e', consumer: 'session_brief', apply: true, json: true }) as string);
    assert.equal(applied.applied, true);
    assert.equal(applied.outcomeCreatedCount, 1, 'exactly one exposure record produced');
    assert.equal(applied.controlCreatedCount, 1, 'the matched control is written alongside');

    // The exposure record is OBSERVABLE on the outcomes ledger with the expected
    // exposure shape: playbookId + candidate-inspection + candidate-trial +
    // storyId + consumer(surface) + observedAt, and (via the candidate's lineage)
    // the capabilityReleaseId is recoverable.
    const rows = readPlaybookOutcomeEvents(root);
    assert.equal(rows.length, 1, 'exactly one exposure record on the ledger');
    const rec = rows[0];
    assert.equal(rec.playbookId, 'PBP-882');
    assert.equal(rec.playbookStatusAtObservation, 'candidate');
    assert.equal(rec.exposureMode, 'candidate-inspection', 'exposure is candidate-inspection, never active-advisory');
    assert.equal(rec.outcome.verdictSource, 'candidate-trial');
    assert.equal(rec.storyId, 'B-785e');
    assert.equal(rec.consumer, 'session_brief', 'the exposure surface/consumer is recorded');
    assert.ok(typeof rec.observedAt === 'string' && rec.observedAt.length > 0);
    // The capabilityReleaseId is recoverable by joining the exposure back to the
    // candidate's lineage (the exposure record binds the playbookId; the lineage
    // carries the capability release).
    const candidate = readPlaybooks(root).find((p) => p.id === rec.playbookId)!;
    assert.equal(candidate.lineage.capabilityReleaseId, CAP_RELEASE_ID);
  });

  check('HAPPY: re-running the trial is idempotent (no duplicate exposure record)', () => {
    const again = JSON.parse(handlers.playbook_trial_run({ storyId: 'B-785e', consumer: 'session_brief', apply: true, json: true }) as string);
    assert.equal(again.outcomeCreatedCount, 0, 're-apply creates no new exposure');
    assert.equal(again.outcomeAlreadyExistsCount, 1);
    assert.equal(readPlaybookOutcomeEvents(root).length, 1, 'still exactly one exposure record');
  });

  // ── EDGE: exposure only under pending-learning; NEVER active runtime surfacing ─
  check('EDGE: the capability candidate is EXCLUDED from active runtime surfacing (matchRuntimePlaybooks)', () => {
    const candidate = capabilityCandidate('candidate');
    // Sanity: the lineage really does carry the capability release id (so the
    // exclusion under test is the status guard, not a mis-built fixture).
    assert.equal(candidate.lineage.capabilityReleaseId, CAP_RELEASE_ID);
    const matches = matchRuntimePlaybooks(
      { projectRoot: '/nonexistent-hermetic', query: QUERY },
      [candidate],
    );
    assert.equal(matches.length, 0, 'a status:candidate capability playbook must never surface as an active match');
  });

  check('EDGE: the capability candidate is absent from MemoryFreshnessPack.results.playbookIds', () => {
    const pack = buildMemoryFreshnessPack({
      projectRoot: root,
      query: QUERY,
      consumer: 'session_brief',
      generatedAt: NOW,
    });
    assert.equal(pack.results.playbookIds.includes('PBP-882'), false, 'candidate is not runtime-surfaced');
    assert.equal(pack.items.playbooks.some((p) => p.id === 'PBP-882'), false);
  });

  check('EDGE: flipping the SAME capability playbook to active proves status===active is the surfacing gate', () => {
    const active = capabilityCandidate('active');
    const matches = matchRuntimePlaybooks(
      { projectRoot: '/nonexistent-hermetic', query: QUERY },
      [active],
    );
    assert.equal(matches.length, 1, 'an ACTIVE capability playbook with a matching query surfaces');
    assert.equal(matches[0].playbook.id, 'PBP-882');

    const activeRoot = mkdtemp('capability-candidate-exposure-active-');
    cleanup.push(activeRoot);
    write(activeRoot, 'lattice.config.json', '{}');
    writePlaybooks(activeRoot, [active]);
    const pack = buildMemoryFreshnessPack({
      projectRoot: activeRoot,
      query: QUERY,
      consumer: 'session_brief',
      generatedAt: NOW,
    });
    assert.equal(pack.results.playbookIds.includes('PBP-882'), true, 'active capability playbook IS runtime-surfaced');
  });

  // ── ADVERSARIAL: exposure changes no status + is not a helped outcome ──────────
  check('ADVERSARIAL: writing an exposure record does NOT change the candidate status', () => {
    // The exposure trial ran (--apply) above; the candidate must still be 'candidate'.
    const candidate = readPlaybooks(root).find((p) => p.id === 'PBP-882')!;
    assert.equal(candidate.status, 'candidate', 'exposure must never activate the candidate');
    assert.equal(candidate.usage.surfacedCount, 0, 'the exposure trial does not bump usage.surfacedCount');
    assert.equal(candidate.usage.resolvedHits, 0);
    assert.equal(candidate.usage.dismissedHits, 0);
  });

  check('ADVERSARIAL: the exposure record is NOT a helped outcome (verdict unknown; 0 helped / 0 decisive)', () => {
    const rows = readPlaybookOutcomeEvents(root);
    assert.equal(rows.length, 1);
    const exposure = rows[0];
    // The exposure verdict is 'unknown' — an exposure is not a helped outcome.
    assert.equal(exposure.outcome.verdict, 'unknown');
    assert.equal(
      isPositiveHelpedPlaybookOutcome(exposure),
      false,
      'a candidate-exposure record must never count as a positive helped outcome',
    );
    // The promotion aggregate for the candidate sees the exposure but counts it
    // toward NEITHER helped NOR decisiveSamples (exposure is non-decisive).
    const candidate = readPlaybooks(root).find((p) => p.id === 'PBP-882')!;
    const aggregate = aggregatePlaybookPromotion(candidate, rows);
    assert.equal(aggregate.helpedCount, 0, 'exposure contributes 0 helped');
    assert.equal(aggregate.decisiveSamples, 0, 'exposure contributes 0 decisive samples');
    assert.equal(aggregate.unknownCount, 1, 'the exposure lands in the non-decisive unknown bucket');
  });

  console.log(`capability-candidate-exposure smoke passed: ${passed} checks`);
} finally {
  for (const dir of cleanup.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
