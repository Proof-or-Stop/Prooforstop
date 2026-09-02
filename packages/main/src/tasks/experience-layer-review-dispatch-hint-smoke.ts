#!/usr/bin/env node
/**
 * B-5a48 CHK-003: smoke suite for surfacing the A/B-gated Experience-Layer hints
 * in the REVIEW reviewer-launch guidance (buildNextSteps) via the shared firing
 * leaf core/experience-hint-surface.ts.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `experience-layer-review-dispatch-hint smoke passed (N checks)` at the end):
 *   (a) ON-arm story (sha256 first byte EVEN) WITH finding-signals → buildNextSteps
 *       REVIEW guidance CONTAINS the rendered hints section (after the
 *       Agent({proof-or-stop-review-*}) lines) AND records exactly one
 *       experience_hint_surfaced event with hintMode:'on' + the full hintIds.
 *   (b) OFF-arm story (sha256 first byte ODD) → buildNextSteps REVIEW guidance is
 *       BYTE-IDENTICAL to the no-signals/no-hints baseline (no section) AND records
 *       exactly one event hintMode:'off' carrying the FULL hintIds (lossless).
 *   (c) CROSS-SITE DEDUP: a PLAN story_review fires a `plan:<phase>` event; the
 *       SAME story advanced to REVIEW + buildNextSteps fires its OWN single event
 *       under the ISO currentReviewRound key (disjoint from plan:<phase>); a SECOND
 *       buildNextSteps in the same round adds NO event; the REVIEW event.reviewRound
 *       EQUALS the ISO currentReviewRound (NOT plan:<phase>).
 *   (d) INVARIANT: resolveReviewPromptHash is byte-identical for an ON vs OFF story
 *       with identical other inputs (hint content NEVER enters the signed prompt).
 *   GOLDEN: story_review's _reviewPrompt bytes + the experience_hint_surfaced event
 *       payload are byte-identical to captured literals on BOTH arms — proving the
 *       CHK-001 leaf extraction is behavior-preserving.
 *
 * Runs entirely in OS temp dirs; saves/restores config cache; never pollutes the repo.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveHintMode } from '../core/hint-mode.js';
import type { HintMode } from '../core/hint-mode.js';
import type { FindingSignal, FindingSignalsCache } from '../core/experience-layer-types.js';
import { FINDING_SIGNALS_FILENAME, LEARNING_DIR, writeFindingSignals } from '../core/learning-store.js';
import { surfaceExperienceHints } from '../core/experience-hint-surface.js';
import { resolveReviewPromptHash } from '../core/review-run.js';
import { readActivityLogTail } from '../core/activity-log.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
import { buildNextSteps } from '../handlers/transition-effects.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const PINNED_NOW = '2026-06-17T00:00:00.000Z';
const SECTION_LABEL = 'Project experience hints (advisory only):';

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

const tmpRoots: string[] = [];
function mkTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'b5a48-review-hint-'));
  tmpRoots.push(root);
  return root;
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf-8');
}

/** Build a FindingSignal with sensible defaults; override what each test needs. */
function signal(over: Partial<FindingSignal> & { localSignature: string }): FindingSignal {
  return {
    category: 'edge',
    fileKinds: ['ts'],
    counts: {
      resolved: 0,
      dismissed: 0,
      falsePositive: 0,
      acceptedRisk: 0,
      unclear: 0,
      partiallyMitigated: 0,
    },
    signalScore: 0,
    support: 0,
    exampleStoryIds: ['B-src1'],
    exampleFindingIds: ['F-001'],
    ...over,
  };
}

function cacheOf(signals: FindingSignal[]): FindingSignalsCache {
  return { schemaVersion: 1, updatedAt: PINNED_NOW, signals };
}

/** A signal set that yields a single recurring hint with id `recAB`. */
function hintYieldingSignals(): FindingSignal[] {
  return [
    signal({
      localSignature: 'recAB',
      signalScore: 0.9,
      support: 4,
      counts: { resolved: 4, dismissed: 0, falsePositive: 0, acceptedRisk: 0, unclear: 0, partiallyMitigated: 0 },
    }),
  ];
}

function seedSignals(root: string, signals: FindingSignal[]): void {
  writeFindingSignals(root, cacheOf(signals));
}

/** Minimal proof-or-stop.config.json so StoryStore + config resolve in the temp root. */
function writeProofOrStopConfig(root: string): void {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();
}

/**
 * Seed a story in the given phase. REVIEW-phase stories carry a stable
 * currentReviewRound (the ISO dedup key buildNextSteps reuses). PLAN-phase
 * stories have none, so the dedup key falls back to `plan:<phase>`.
 */
function seedStory(store: StoryStore, storyId: string, phase: 'PLAN' | 'REVIEW' | 'DEV'): void {
  const now = PINNED_NOW;
  const story: StoryInfo = {
    storyId,
    name: storyId,
    title: 'AB shadow-gate smoke story',
    description: 'Synthetic story for the A/B shadow-gated experience-hint display.',
    type: 'chore',
    phase,
    priority: 'medium',
    ...(phase === 'REVIEW' ? { currentReviewRound: now } : {}),
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase, action: 'advance', timestamp: now }],
  } as StoryInfo;
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'A real checklist item',
      context: 'Enough context to pass split-quality checks.',
      userSees: 'The smoke asserts the advisory section is gated by the A/B arm.',
      status: phase === 'REVIEW' ? 'done' : 'pending',
      startTime: phase === 'REVIEW' ? now : null,
      endTime: phase === 'REVIEW' ? now : null,
    }],
  } as ChecklistData;
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'shadow-gate advisory hints',
    outcome: 'ON arm shows section; OFF arm hides it; both emit the event',
    facts: ['hints are advisory only'],
    constraints: [],
    unknowns: [],
    touchpoints: [],
    timestamp: now,
  });
}

function runStoryReview(root: string, storyId: string): any {
  const store = new StoryStore(root);
  return createStoryReviewHandlers({
    store,
    root,
    scanRoot: join(root, 'packages/main'),
  }).story_review({ storyId }) as any;
}

function reviewNextSteps(root: string, storyId: string): string {
  const store = new StoryStore(root);
  return buildNextSteps(store, root, storyId).REVIEW;
}

/**
 * Select the DEV guidance from the SAME buildNextSteps object. Because the
 * object literal eagerly evaluates ALL its values (including the REVIEW IIFE),
 * this call exercises the exact eager-evaluation path the F-001 phase guard
 * protects against (the REVIEW IIFE runs even though we only read .DEV).
 */
function devNextSteps(root: string, storyId: string): string {
  const store = new StoryStore(root);
  return buildNextSteps(store, root, storyId).DEV;
}

function surfacedEvents(root: string): Array<Record<string, unknown>> {
  return readActivityLogTail(root, 500).filter((e) => e.event === 'experience_hint_surfaced');
}

/** Find a storyId that maps to the requested arm (ON = even first byte). */
function findStoryIdForArm(arm: HintMode): string {
  for (let i = 1; i <= 100000; i++) {
    const id = `B-arm${i}`;
    if (resolveHintMode(id) === arm) return id;
  }
  throw new Error(`could not find a storyId for arm ${arm}`);
}

// ─── GOLDEN literals captured BEFORE the CHK-001 leaf extraction ───────────────
// `B-arm1` is the ON arm (sha256 first byte even); `B-arm2` the OFF arm. The
// _reviewPrompt + event payload must remain byte-identical after the refactor.
const GOLDEN_ON_ID = 'B-arm1';
const GOLDEN_OFF_ID = 'B-arm2';
const GOLDEN_ON_REVIEWPROMPT = 'Please review the PLAN-phase artifacts of the following story. Focus on:\n  1. Whether understanding is genuine (whether unknowns contradict facts, whether touchpoints are real)\n  2. Whether the decision choice is reasonable (why other options were not chosen, whether rationale echoes drivers)\n  3. Whether the checklist covers all scenarios in description + truth docs\n  4. Whether preMortem lists real failure modes (not filler)\n\n---\nStory: AB shadow-gate smoke story\nDescription: Synthetic story for the A/B shadow-gated experience-hint display.\nPriority: medium\n---\nUnderstanding Snapshot:\ntask: shadow-gate advisory hints\noutcome: ON arm shows section; OFF arm hides it; both emit the event\nfacts:\n  - hints are advisory only\nconstraints:\n  (none)\nunknowns:\n  (none)\ntouchpoints:\n  (none)\n---\nDecision: (not provided)\n---\nProject experience hints (advisory only):\nDerived from past findings. These are nudges, not gates — they never block this review.\nRecurring issues to watch for:\n  - [recAB] score 0.9 · support 4 fixed / 0 false-positive · Source: B-src1\n---\nChecklist:\n- CHK-001: A real checklist item (Enough context to pass split-quality checks.)';
const GOLDEN_OFF_REVIEWPROMPT = 'Please review the PLAN-phase artifacts of the following story. Focus on:\n  1. Whether understanding is genuine (whether unknowns contradict facts, whether touchpoints are real)\n  2. Whether the decision choice is reasonable (why other options were not chosen, whether rationale echoes drivers)\n  3. Whether the checklist covers all scenarios in description + truth docs\n  4. Whether preMortem lists real failure modes (not filler)\n\n---\nStory: AB shadow-gate smoke story\nDescription: Synthetic story for the A/B shadow-gated experience-hint display.\nPriority: medium\n---\nUnderstanding Snapshot:\ntask: shadow-gate advisory hints\noutcome: ON arm shows section; OFF arm hides it; both emit the event\nfacts:\n  - hints are advisory only\nconstraints:\n  (none)\nunknowns:\n  (none)\ntouchpoints:\n  (none)\n---\nDecision: (not provided)\n---\nChecklist:\n- CHK-001: A real checklist item (Enough context to pass split-quality checks.)';

function eventSansTimestamp(e: Record<string, unknown>): Record<string, unknown> {
  const { timestamp, ...rest } = e;
  void timestamp;
  return rest;
}

// ─── (a) ON-arm: buildNextSteps REVIEW contains the section + one on-event ─────

check('CHK-002 happy:0 — ON-arm REVIEW guidance contains the hints section after the Agent({proof-or-stop-review-*}) lines + one on-event', () => {
  const onId = findStoryIdForArm('on');
  assert.equal(resolveHintMode(onId), 'on', 'precondition: onId is ON arm (sha256 first byte even)');
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  seedStory(new StoryStore(root), onId, 'REVIEW');
  seedSignals(root, hintYieldingSignals());

  const text = reviewNextSteps(root, onId);
  assert.ok(text.includes(SECTION_LABEL), 'ON arm: REVIEW guidance contains the advisory section');
  assert.ok(text.includes('[recAB]'), 'ON arm: hint id rendered in REVIEW guidance');
  // The section must follow the Agent({proof-or-stop-review-*}) launch lines.
  const agentIdx = text.lastIndexOf('Agent({ subagent_type: "proof-or-stop-review-');
  const sectionIdx = text.indexOf(SECTION_LABEL);
  assert.ok(agentIdx >= 0, 'ON arm: reviewer-launch Agent lines present');
  assert.ok(sectionIdx > agentIdx, 'ON arm: hints section physically follows the Agent launch lines');

  const events = surfacedEvents(root);
  assert.equal(events.length, 1, 'ON arm: exactly one experience_hint_surfaced event');
  assert.equal(events[0].hintMode, 'on', "ON arm: event hintMode === 'on'");
  assert.deepEqual(events[0].hintIds, ['recAB'], 'ON arm: event carries the full hint set');
});

// ─── (b) OFF-arm: REVIEW guidance byte-identical to baseline + one off-event ───

check('CHK-002 edge:0 — OFF-arm REVIEW guidance is BYTE-IDENTICAL to the no-hints baseline + one off-event with full hintIds (lossless)', () => {
  const offId = findStoryIdForArm('off');
  assert.equal(resolveHintMode(offId), 'off', 'precondition: offId is OFF arm (sha256 first byte odd)');

  // Baseline: same OFF story, NO signals seeded => no hints at all.
  const baselineRoot = mkTempRoot();
  writeProofOrStopConfig(baselineRoot);
  seedStory(new StoryStore(baselineRoot), offId, 'REVIEW');
  const baseline = reviewNextSteps(baselineRoot, offId);
  assert.equal(surfacedEvents(baselineRoot).length, 0, 'baseline: no hints => no event');

  // OFF arm WITH signals: section must be suppressed → byte-identical guidance.
  const offRoot = mkTempRoot();
  writeProofOrStopConfig(offRoot);
  seedStory(new StoryStore(offRoot), offId, 'REVIEW');
  seedSignals(offRoot, hintYieldingSignals());
  const offText = reviewNextSteps(offRoot, offId);

  assert.ok(!offText.includes(SECTION_LABEL), 'OFF arm: advisory section ABSENT from REVIEW guidance');
  assert.equal(offText, baseline, 'OFF arm REVIEW guidance == no-hints baseline (byte-identical)');

  const events = surfacedEvents(offRoot);
  assert.equal(events.length, 1, 'OFF arm: exactly one experience_hint_surfaced event (fires on both arms)');
  assert.equal(events[0].hintMode, 'off', "OFF arm: event hintMode === 'off'");
  assert.deepEqual(events[0].hintIds, ['recAB'], 'OFF arm: event carries the FULL hint set (lossless)');
});

// ─── (c) CROSS-SITE DEDUP: PLAN plan:<phase> vs REVIEW ISO key, disjoint ───────

check('CHK-003 edge:0 — cross-site dedup: PLAN plan:<phase> event vs REVIEW ISO-key event are disjoint; second REVIEW buildNextSteps adds no event; REVIEW reviewRound == ISO currentReviewRound', () => {
  const onId = findStoryIdForArm('on');
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  const store = new StoryStore(root);
  // Start in PLAN so story_review keys on plan:<phase>.
  seedStory(store, onId, 'PLAN');
  seedSignals(root, hintYieldingSignals());

  // 1) PLAN story_review → a single plan:PLAN event.
  runStoryReview(root, onId);
  let events = surfacedEvents(root).filter((e) => e.storyId === onId);
  assert.equal(events.length, 1, 'PLAN: exactly one event');
  assert.equal(events[0].reviewRound, 'plan:PLAN', 'PLAN: event keyed on plan:<phase>');

  // 2) Advance the SAME story to REVIEW with an ISO currentReviewRound.
  const isoRound = '2026-06-18T09:00:00.000Z';
  const advanced = store.readStory(onId);
  store.writeStory(onId, { ...advanced, phase: 'REVIEW', currentReviewRound: isoRound } as StoryInfo);

  // 3) buildNextSteps REVIEW → its OWN single event under the ISO key.
  reviewNextSteps(root, onId);
  events = surfacedEvents(root).filter((e) => e.storyId === onId);
  assert.equal(events.length, 2, 'after REVIEW buildNextSteps: PLAN + REVIEW events, disjoint');
  const reviewEvents = events.filter((e) => e.reviewRound === isoRound);
  const planEvents = events.filter((e) => e.reviewRound === 'plan:PLAN');
  assert.equal(planEvents.length, 1, 'PLAN event preserved');
  assert.equal(reviewEvents.length, 1, 'REVIEW event under the ISO currentReviewRound key');
  assert.notEqual(reviewEvents[0].reviewRound, 'plan:PLAN',
    'REVIEW event.reviewRound is the ISO key, NOT plan:<phase> (guards the ordering dependency)');
  assert.equal(reviewEvents[0].reviewRound, isoRound, 'REVIEW event.reviewRound == ISO currentReviewRound');

  // 4) A SECOND buildNextSteps in the same REVIEW round adds NO new event.
  reviewNextSteps(root, onId);
  events = surfacedEvents(root).filter((e) => e.storyId === onId);
  assert.equal(events.length, 2, 'second REVIEW buildNextSteps in the same round adds NO event (dedup)');
});

// ─── F-001 REGRESSION: non-REVIEW transition must NOT fire the side-effecting ──
// experience_hint_surfaced event ─────────────────────────────────────────────
//
// CHK-002 adversarial:1. The REVIEW branch of buildNextSteps is a value in an
// object literal, so JS EAGERLY evaluates the REVIEW IIFE on EVERY buildNextSteps
// call regardless of which phase's guidance the caller selects. Before the phase
// guard, that eager evaluation called surfaceExperienceHints — a SIDE-EFFECTING
// leaf that appends the experience_hint_surfaced A/B event — even when the story
// was entering a NON-REVIEW phase (e.g. DEV), writing a spurious event keyed on
// plan:DEV and polluting the A/B measurement. This check seeds an ON-arm story
// WITH finding-signals in the DEV phase, calls buildNextSteps (which eagerly
// evaluates the REVIEW IIFE) and asserts (1) ZERO experience_hint_surfaced events
// were written and (2) the selected DEV guidance carries no hints section.
// It FAILS against the pre-fix code (the event fires spuriously) and PASSES after
// the `if (story.phase === 'REVIEW')` guard.

check('CHK-002 adversarial:1 — buildNextSteps does NOT fire experience_hint_surfaced on a non-REVIEW phase (F-001 regression: REVIEW IIFE is eagerly evaluated)', () => {
  const onId = findStoryIdForArm('on');
  assert.equal(resolveHintMode(onId), 'on',
    'precondition: onId is ON arm (would render + fire a hint if the REVIEW IIFE ran unguarded)');

  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  // Seed the story in a NON-REVIEW phase (DEV) WITH finding-signals: if the
  // eager REVIEW IIFE fired surfaceExperienceHints, it would write an event keyed
  // on plan:DEV and (on the ON arm) render a section.
  seedStory(new StoryStore(root), onId, 'DEV');
  seedSignals(root, hintYieldingSignals());

  // buildNextSteps eagerly evaluates ALL branches (including the REVIEW IIFE);
  // we select the DEV guidance the caller would actually use for a DEV transition.
  const devText = devNextSteps(root, onId);

  // (1) No side-effecting event fired on the non-REVIEW path.
  assert.equal(surfacedEvents(root).length, 0,
    'F-001: ZERO experience_hint_surfaced events on a non-REVIEW (DEV) buildNextSteps call (the eager REVIEW IIFE must not fire the event)');

  // (2) The selected DEV guidance contains no hints section.
  assert.ok(!devText.includes(SECTION_LABEL),
    'F-001: DEV guidance contains no experience-hints section');
  assert.ok(!devText.includes('[recAB]'),
    'F-001: DEV guidance does not render any hint id');
});

// ─── (d) INVARIANT: resolveReviewPromptHash byte-identical ON vs OFF ───────────

check('CHK-003 adversarial:0 — INVARIANT: resolveReviewPromptHash byte-identical for ON vs OFF (hint content never enters the signed prompt)', () => {
  const onId = findStoryIdForArm('on');
  const offId = findStoryIdForArm('off');

  // The signed reviewer prompt is a SEPARATE channel from the advisory guidance.
  // For identical reviewer-prompt text the hash must not depend on the arm, on
  // hint presence, or on hint content.
  const reviewerPrompt = 'REVIEW reviewer prompt: examine the diff for the story.';

  const onRoot = mkTempRoot();
  writeProofOrStopConfig(onRoot);
  seedStory(new StoryStore(onRoot), onId, 'REVIEW');
  seedSignals(onRoot, hintYieldingSignals());
  reviewNextSteps(onRoot, onId); // surface ON-arm hints (non-empty render)
  const onHash = resolveReviewPromptHash(reviewerPrompt);

  const offRoot = mkTempRoot();
  writeProofOrStopConfig(offRoot);
  seedStory(new StoryStore(offRoot), offId, 'REVIEW');
  seedSignals(offRoot, hintYieldingSignals());
  reviewNextSteps(offRoot, offId); // surface OFF-arm hints (empty render)
  const offHash = resolveReviewPromptHash(reviewerPrompt);

  assert.equal(onHash, offHash, 'resolveReviewPromptHash byte-identical for ON vs OFF (same reviewer prompt)');
});

// ─── GOLDEN: leaf extraction is behavior-preserving (both arms) ────────────────

check('CHK-001 edge:0 (GOLDEN) — story_review _reviewPrompt bytes + event payload byte-identical to pre-extraction literals on the ON arm', () => {
  assert.equal(resolveHintMode(GOLDEN_ON_ID), 'on', 'golden precondition: GOLDEN_ON_ID is ON arm');
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  seedStory(new StoryStore(root), GOLDEN_ON_ID, 'PLAN');
  seedSignals(root, hintYieldingSignals());

  const result = runStoryReview(root, GOLDEN_ON_ID);
  assert.equal(result._reviewPrompt, GOLDEN_ON_REVIEWPROMPT,
    'ON arm: _reviewPrompt bytes unchanged after the leaf extraction');

  const events = surfacedEvents(root);
  assert.equal(events.length, 1, 'ON arm golden: exactly one event');
  assert.deepEqual(eventSansTimestamp(events[0]), {
    event: 'experience_hint_surfaced',
    storyId: GOLDEN_ON_ID,
    reviewRound: 'plan:PLAN',
    hintMode: 'on',
    hintIds: ['recAB'],
  }, 'ON arm: event payload (sans timestamp) unchanged after the leaf extraction');
});

check('CHK-001 edge:1 (GOLDEN) — story_review _reviewPrompt bytes + event payload byte-identical to pre-extraction literals on the OFF arm (lossless event)', () => {
  assert.equal(resolveHintMode(GOLDEN_OFF_ID), 'off', 'golden precondition: GOLDEN_OFF_ID is OFF arm');
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  seedStory(new StoryStore(root), GOLDEN_OFF_ID, 'PLAN');
  seedSignals(root, hintYieldingSignals());

  const result = runStoryReview(root, GOLDEN_OFF_ID);
  assert.equal(result._reviewPrompt, GOLDEN_OFF_REVIEWPROMPT,
    'OFF arm: _reviewPrompt bytes unchanged after the leaf extraction (section suppressed)');

  const events = surfacedEvents(root);
  assert.equal(events.length, 1, 'OFF arm golden: exactly one event');
  assert.deepEqual(eventSansTimestamp(events[0]), {
    event: 'experience_hint_surfaced',
    storyId: GOLDEN_OFF_ID,
    reviewRound: 'plan:PLAN',
    hintMode: 'off',
    hintIds: ['recAB'],
  }, 'OFF arm: event payload (sans timestamp) unchanged after the leaf extraction (lossless)');
});

// ─── (e) DIRECT LEAF happy: surfaceExperienceHints ON-arm returns + fires ─────
//
// CHK-001 happy:0 was previously only exercised transitively (through
// buildNextSteps/story_review). This calls the leaf surfaceExperienceHints
// DIRECTLY against a temp root seeded with finding-signals, asserting the full
// returned object on the ON arm + the single on-event it appends.

check('CHK-001 happy:0 — surfaceExperienceHints leaf ON-arm returns rendered section + fires one on-event (fired=true)', () => {
  const onId = findStoryIdForArm('on');
  assert.equal(resolveHintMode(onId), 'on', 'precondition: onId is ON arm (sha256 first byte even)');
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  // NOTE: the leaf reads .proof-or-stop/learning/ at the canonical main-repo root when
  // the temp root is a git worktree, but these temp roots are NON-git dirs, so
  // resolveLearningRoot falls back to the temp root itself and the seeded signals
  // are read back here. (Same assumption every check in this file already relies on.)
  seedSignals(root, hintYieldingSignals());

  const hintRoundKey = 'round-happy-leaf';
  const result = surfaceExperienceHints(root, { storyId: onId, hintRoundKey });

  assert.equal(result.hintMode, 'on', "leaf ON arm: hintMode === 'on'");
  assert.ok(result.renderedSection.length > 0, 'leaf ON arm: renderedSection is non-empty');
  assert.ok(result.renderedSection.includes(SECTION_LABEL),
    'leaf ON arm: renderedSection contains the section label');
  assert.ok(result.renderedSection.includes('[recAB]'),
    'leaf ON arm: renderedSection contains the rendered hint id');
  assert.deepEqual(result.hintIds, ['recAB'], 'leaf ON arm: hintIds is the full expected set');
  assert.equal(result.fired, true, 'leaf ON arm: fired === true (a new event was appended)');

  const events = surfacedEvents(root);
  assert.equal(events.length, 1, 'leaf ON arm: exactly one experience_hint_surfaced event appended');
  assert.equal(events[0].hintMode, 'on', "leaf ON arm: event hintMode === 'on'");
  assert.equal(events[0].reviewRound, hintRoundKey, 'leaf ON arm: event keyed on the supplied hintRoundKey');
  assert.deepEqual(events[0].hintIds, ['recAB'], 'leaf ON arm: event carries the full hintIds');
});

// ─── (f) DIRECT LEAF adversarial: a track failure inside the try/catch is swallowed ─
//
// CHK-001 adversarial:0. The malformed-cache route is NOT usable here:
// readFindingSignals swallows JSON.parse errors and returns null (graceful), so
// loadExperienceHints never throws on bad data — it returns empty buckets (the
// no-hints path, NOT the catch path). To genuinely exercise the leaf's try/catch
// we make the TRACK (appendActivityLog) path throw: seed VALID signals (so
// hasExperienceHints is true and the leaf reaches the append), then occupy the
// runtime activity-log path .proof-or-stop/activity.jsonl with a DIRECTORY. appendFileSync
// against a directory throws EISDIR INSIDE the try block; the catch must swallow it
// and early-return renderedSection='' / fired=false with NO partial event.
// (If the leaf's try/catch were removed, this EISDIR would propagate and the
// try-wrapper below would catch the throw and fail the check.)

check('CHK-001 adversarial:0 — a load/track failure inside surfaceExperienceHints is swallowed (renderedSection empty, fired=false, no throw, no partial event)', () => {
  const onId = findStoryIdForArm('on');
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  seedSignals(root, hintYieldingSignals()); // valid hints => the leaf reaches the append/track step

  // Occupy the runtime activity-log path with a DIRECTORY so appendActivityLog's
  // appendFileSync throws EISDIR from inside the leaf's try block.
  mkdirSync(join(root, '.proof-or-stop', 'activity.jsonl'), { recursive: true });

  let threw = false;
  let result: ReturnType<typeof surfaceExperienceHints> | undefined;
  try {
    result = surfaceExperienceHints(root, { storyId: onId, hintRoundKey: 'round-adv-leaf' });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'leaf adversarial: surfaceExperienceHints must NOT throw (failure swallowed)');
  assert.ok(result, 'leaf adversarial: a result object is returned');
  assert.equal(result!.renderedSection, '', 'leaf adversarial: renderedSection is empty after a swallowed failure');
  assert.equal(result!.fired, false, 'leaf adversarial: fired === false (nothing was tracked)');

  // No partial/garbage event was written for this root (the append threw before
  // any record landed; the activity-log path is a directory so the tail is empty).
  assert.equal(surfacedEvents(root).length, 0,
    'leaf adversarial: no partial experience_hint_surfaced event was written');
});

// ─── ADVERSARIAL: a thrown error inside the hint block never blocks REVIEW ─────

check('CHK-002 adversarial:0 — a hint-surface failure never blocks/alters the REVIEW transition; active-reviewer set unchanged', () => {
  const onId = findStoryIdForArm('on');

  // Baseline REVIEW guidance with NO signals (no hints, no event).
  const baselineRoot = mkTempRoot();
  writeProofOrStopConfig(baselineRoot);
  seedStory(new StoryStore(baselineRoot), onId, 'REVIEW');
  const baseline = reviewNextSteps(baselineRoot, onId);

  // Corrupt the finding-signals cache so loadExperienceHints/track would throw —
  // the leaf's try/catch must swallow it, leaving the guidance byte-identical to
  // the no-hints baseline and the transition unaffected.
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  seedStory(new StoryStore(root), onId, 'REVIEW');
  write(root, join(LEARNING_DIR, FINDING_SIGNALS_FILENAME), '{ not valid json');
  const text = reviewNextSteps(root, onId);

  assert.equal(text, baseline, 'corrupt cache: REVIEW guidance byte-identical to baseline (failure swallowed)');
  assert.ok(text.includes('Active reviewers:'), 'active-reviewer set still rendered');
  // The corrupt cache yields no hints => no event (no partial event).
  assert.equal(surfacedEvents(root).length, 0, 'corrupt cache: no partial experience_hint_surfaced event');
});

// ─── ADVERSARIAL (transition layer): an APPEND/track failure driven THROUGH ────
// buildNextSteps never blocks the REVIEW transition ─────────────────────────────
//
// CHK-002 adversarial:0. The sibling check above exercises the corrupt-cache
// route (loadExperienceHints yields no hints → the leaf never reaches the append).
// This one exercises the TRANSITION-EFFECTS layer with the SAME failure injection
// as CHK-001 adversarial:0 (the leaf-level direct check): seed VALID finding
// signals on an ON-arm REVIEW story so the leaf REACHES the failing track step,
// then occupy the runtime activity-log path .proof-or-stop/activity.jsonl with a
// DIRECTORY so appendActivityLog's appendFileSync throws EISDIR INSIDE
// surfaceExperienceHints. Crucially we drive it through buildNextSteps (the REVIEW
// branch), NOT the leaf directly, to prove the transition guidance + reviewer-
// launch lines survive a hint-path failure. The leaf's try/catch swallows the
// EISDIR (renderedSection='') and the buildNextSteps hint block's own try/catch
// appends nothing — so the REVIEW guidance keeps its Agent({ subagent_type:
// "proof-or-stop-review-* }) launch lines (active-reviewer set unchanged, transition not
// blocked) and no rendered hints section is appended for that failed call.

check('CHK-002 adversarial:0 — a hint-path failure inside buildNextSteps never blocks the REVIEW transition (guidance returned, reviewer-launch lines intact)', () => {
  const onId = findStoryIdForArm('on');
  assert.equal(resolveHintMode(onId), 'on', 'precondition: onId is ON arm (the leaf reaches the failing track step)');

  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  seedStory(new StoryStore(root), onId, 'REVIEW');
  seedSignals(root, hintYieldingSignals()); // valid hints => the leaf reaches the append/track step

  // SAME failure injection as CHK-001 adversarial:0: occupy the runtime
  // activity-log path with a DIRECTORY so appendActivityLog throws EISDIR from
  // inside surfaceExperienceHints. (readActivityLogTail's dedup scan swallows the
  // directory gracefully; it is the append that throws, INSIDE the leaf try.)
  mkdirSync(join(root, '.proof-or-stop', 'activity.jsonl'), { recursive: true });

  // Drive the failure THROUGH buildNextSteps (the REVIEW branch), NOT the leaf.
  let threw = false;
  let text: string | undefined;
  try {
    text = reviewNextSteps(root, onId);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'buildNextSteps must NOT throw when the hint path fails (hint failure never blocks the transition)');
  assert.ok(text, 'buildNextSteps returns its REVIEW guidance despite the hint-path failure');

  // The reviewer-launch lines are intact => active-reviewer set unchanged /
  // transition not blocked or garbled by the hint failure.
  assert.ok(text!.includes('Active reviewers:'),
    'REVIEW guidance still renders the active-reviewer set after the hint-path failure');
  assert.ok(text!.includes('Agent({ subagent_type: "proof-or-stop-review-'),
    'REVIEW guidance still contains the reviewer-launch Agent({ subagent_type: "proof-or-stop-review-* }) lines');

  // Because the leaf swallowed the failure, no rendered hints section was appended
  // for that failed call (and the run did not crash).
  assert.ok(!text!.includes(SECTION_LABEL),
    'no rendered hints section appended for the failed call (the leaf swallowed the failure)');
  assert.equal(surfacedEvents(root).length, 0,
    'the failed append wrote no partial experience_hint_surfaced event');
});

// ─── summary ──────────────────────────────────────────────────────────────────

try {
  console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (passed !== total) {
    process.exitCode = 1;
  } else {
    console.log(`✓ experience-layer-review-dispatch-hint smoke passed (${total} checks)`);
  }
} finally {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
