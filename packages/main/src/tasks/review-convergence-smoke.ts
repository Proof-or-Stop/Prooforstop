#!/usr/bin/env node
/**
 * B-cfdd CHK-003 — proves the SOFT REVIEW convergence-stall advisory FIRES on a
 * stalled story and NEVER blocks a transition.
 *
 * The crux this smoke guards (the no-op bug):
 *   At REVIEW-entry render time, the just-entered round's REVIEW/advance event is
 *   ALREADY counted by resolveReviewRoundCount, so roundCount includes the CURRENT
 *   round — but that round's reviewers have not run, so its blocking count is
 *   structurally 0. assessReviewConvergence has a `recentRoundClean (window[last]
 *   === 0) => not stalled` carve-out. If the raw dense per-round counts (whose
 *   trailing entry is the always-empty current round) were fed in, the advisory
 *   would NEVER fire. assessReviewConvergenceAtEntry must therefore drop the
 *   trailing current round and assess the COMPLETED rounds only.
 *
 * Cases:
 *   (a) STALLED: entered REVIEW 4 times, 3 completed rounds [2,2,1] (current 4th
 *       empty) -> assessReviewConvergenceAtEntry returns stalled=true WITH the
 *       advisory message. THE KEY TEST that catches the no-op bug.
 *   (b) CONVERGING: completed rounds strictly decreasing [2,1,0] -> stalled=false.
 *   (c) BELOW THRESHOLD: entered REVIEW only 3 times -> stalled=false.
 *   (d) SINGLE CLEAN ROUND: entered REVIEW once -> stalled=false.
 *   (e) NON-BLOCKING PROOF: the wiring path used at REVIEW-entry only APPENDS the
 *       advisory text onto the next-step string; the value the transition uses is
 *       unaffected. We assert the advisory append produces text only and yields no
 *       error / blocking signal, mirroring the transition-effects.ts append.
 *
 * Function-level + injectable: drives a synthetic in-memory StoryStore (only the
 * two methods the assess path reads — readStory + readFindings) so it runs
 * in-process without a real repo and without shelling out to the global proofOrStop.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  assessReviewConvergence,
  assessReviewConvergenceAtEntry,
  collectReviewConvergenceInputs,
  STALL_MIN_ROUNDS,
} from '../core/review-convergence.js';
import type { StoryStore } from '../core/store.js';
import type { Finding, StoryInfo, StoryEvent } from '../core/types.js';

/** Marker line printed by the smoke so `proof-or-stop validate` output is greppable. */
const MARKER = 'review-convergence-smoke:';

/** A fixed base time so synthetic round timestamps are deterministic + ordered. */
const BASE_MS = Date.parse('2026-06-16T00:00:00.000Z');

/** ISO timestamp for review round n (1-based), strictly increasing. */
function roundTs(n: number): string {
  return new Date(BASE_MS + n * 60_000).toISOString();
}

/**
 * Build a synthetic store for a story that has entered REVIEW `reviewRounds`
 * times, where `completedBlocking[i]` open CRITICAL findings were filed against
 * round i+1. CRITICAL is blocking in every round under every profile and never
 * decays to advisory, so the resulting per-round blocking counts are exactly the
 * input array regardless of the on-disk workflow profile.
 *
 * The trailing (current) round is left with zero findings — exactly the
 * render-time reality the windowing must account for.
 */
function buildStore(reviewRounds: number, completedBlocking: number[]): StoryStore {
  const events: StoryEvent[] = [];
  for (let r = 1; r <= reviewRounds; r++) {
    events.push({ phase: 'REVIEW', action: 'advance', timestamp: roundTs(r) } as StoryEvent);
  }

  const findings: Finding[] = [];
  let seq = 1;
  completedBlocking.forEach((count, idx) => {
    const round = idx + 1; // round 1..reviewRounds-1 (completed rounds)
    for (let i = 0; i < count; i++) {
      findings.push({
        id: `B-cfdd:F-${String(seq++).padStart(3, '0')}`,
        desc: `synthetic blocking finding round ${round}`,
        severity: 'critical',
        category: 'missing',
        status: 'open',
        reviewRound: roundTs(round),
      } as Finding);
    }
  });

  const story: StoryInfo = {
    storyId: 'B-cfdd',
    name: 'synthetic-convergence-story',
    title: 'synthetic convergence story',
    type: 'feature',
    priority: 'high',
    phase: 'REVIEW',
    events,
  } as unknown as StoryInfo;

  return {
    readStory: (id: string) => {
      if (id !== story.storyId) throw new Error(`unexpected storyId ${id}`);
      return story;
    },
    readFindings: (id: string) => {
      if (id !== story.storyId) throw new Error(`unexpected storyId ${id}`);
      return { findings };
    },
  } as unknown as StoryStore;
}

/**
 * Mirrors the transition-effects.ts REVIEW-entry append: take a base next-step
 * string, soft-append the advisory when stalled, never throw. Returns the
 * resulting text plus a flag proving the call path produced no error/blocking
 * signal. The base string is what the transition actually uses; appending the
 * advisory cannot change the transition outcome.
 */
function appendAdvisory(store: StoryStore, storyId: string, base: string): {
  text: string;
  appended: boolean;
  errored: boolean;
} {
  let text = base;
  let appended = false;
  let errored = false;
  try {
    const convergence = assessReviewConvergenceAtEntry(store, storyId);
    if (convergence.stalled && convergence.message) {
      text += `\n\n${convergence.message}`;
      appended = true;
    }
  } catch {
    errored = true;
  }
  return { text, appended, errored };
}

function run(): void {
  // ---- (a) STALLED: 4 rounds, completed [2,2,1], current round empty. ----
  {
    const store = buildStore(4, [2, 2, 1]);
    // Confirm the dense, round-aligned inputs are what we expect: the current
    // (4th) round is structurally empty at render time.
    const inputs = collectReviewConvergenceInputs(store, 'B-cfdd');
    assert.equal(inputs.roundCount, 4, '(a) roundCount must include the current round');
    assert.deepEqual(
      inputs.perRoundBlockingCounts,
      [2, 2, 1, 0],
      '(a) dense per-round counts: completed [2,2,1] + empty current round 0',
    );

    const assessment = assessReviewConvergenceAtEntry(store, 'B-cfdd');
    // THE KEY ASSERTION: if windowing fed the raw [2,2,1,0] (trailing 0) to the
    // pure assessor, recentRoundClean would short-circuit to stalled=false and
    // the advisory would silently never fire. Assessing over completed rounds
    // [2,2,1] (last=1, not strictly decreasing) yields stalled=true.
    assert.equal(assessment.stalled, true, '(a) FAIL — advisory did not fire (the no-op bug: current empty round leaked into the window)');
    assert.ok(assessment.message, '(a) stalled assessment must carry an advisory message');
    assert.match(
      assessment.message as string,
      /review convergence stall/,
      '(a) advisory message must contain the stall marker',
    );
    // Both escalation hints present (Debugging Contract + dismiss-don't-re-round).
    assert.match(assessment.message as string, /Debugging Contract/, '(a) advisory must include the Debugging Contract escalation hint');
    assert.match(assessment.message as string, /dismiss/i, '(a) advisory must include the dismiss-don\'t-re-round hint');
    console.log(`${MARKER} (a) STALLED fires — advisory present:`);
    console.log((assessment.message as string).split('\n').map(l => `      ${l}`).join('\n'));
  }

  // ---- (b) CONVERGING: 4 rounds, completed [2,1,0] strictly decreasing. ----
  {
    const store = buildStore(4, [2, 1, 0]);
    const inputs = collectReviewConvergenceInputs(store, 'B-cfdd');
    assert.deepEqual(inputs.perRoundBlockingCounts, [2, 1, 0, 0], '(b) dense counts');
    const assessment = assessReviewConvergenceAtEntry(store, 'B-cfdd');
    assert.equal(assessment.stalled, false, '(b) strictly-decreasing completed rounds must NOT stall');
    assert.equal(assessment.message, undefined, '(b) converging story must carry no advisory message');
    console.log(`${MARKER} (b) CONVERGING [2,1,0] -> stalled=false, no advisory`);
  }

  // ---- (c) BELOW THRESHOLD: entered REVIEW only 3 times. ----
  {
    const store = buildStore(3, [2, 2]); // completed rounds 1,2 both flat-blocking
    const inputs = collectReviewConvergenceInputs(store, 'B-cfdd');
    assert.equal(inputs.roundCount, 3, '(c) roundCount');
    assert.ok(inputs.roundCount < STALL_MIN_ROUNDS, '(c) precondition: below STALL_MIN_ROUNDS');
    const assessment = assessReviewConvergenceAtEntry(store, 'B-cfdd');
    assert.equal(assessment.stalled, false, '(c) below STALL_MIN_ROUNDS must NOT stall even with flat blocking');
    console.log(`${MARKER} (c) BELOW THRESHOLD (3 < ${STALL_MIN_ROUNDS} rounds) -> stalled=false`);
  }

  // ---- (d) SINGLE CLEAN ROUND: entered REVIEW once, no findings. ----
  {
    const store = buildStore(1, []);
    const inputs = collectReviewConvergenceInputs(store, 'B-cfdd');
    assert.equal(inputs.roundCount, 1, '(d) roundCount');
    assert.deepEqual(inputs.perRoundBlockingCounts, [0], '(d) single round, no blocking');
    const assessment = assessReviewConvergenceAtEntry(store, 'B-cfdd');
    assert.equal(assessment.stalled, false, '(d) single clean round must NOT stall');
    console.log(`${MARKER} (d) SINGLE CLEAN ROUND -> stalled=false`);
  }

  // ---- (e) NON-BLOCKING PROOF: append path is text-only, never errors. ----
  {
    const base = '→ Active reviewers: concept, quality, test-coverage\n→ launch the above reviewers in parallel';

    // Stalled story: the advisory IS appended, but the base (what the transition
    // uses) is preserved verbatim as a prefix — appending cannot alter the
    // transition outcome.
    const stalledStore = buildStore(4, [2, 2, 1]);
    const stalled = appendAdvisory(stalledStore, 'B-cfdd', base);
    assert.equal(stalled.errored, false, '(e) stalled append must not error');
    assert.equal(stalled.appended, true, '(e) stalled story should append the advisory');
    assert.ok(stalled.text.startsWith(base), '(e) base next-step text must be preserved verbatim (append-only)');
    assert.ok(stalled.text.length > base.length, '(e) advisory text must be appended after the base');
    assert.match(stalled.text, /review convergence stall/, '(e) appended text carries the advisory');

    // Healthy story: nothing appended, no error, text unchanged.
    const healthyStore = buildStore(4, [2, 1, 0]);
    const healthy = appendAdvisory(healthyStore, 'B-cfdd', base);
    assert.equal(healthy.errored, false, '(e) healthy append must not error');
    assert.equal(healthy.appended, false, '(e) healthy story must not append an advisory');
    assert.equal(healthy.text, base, '(e) healthy story leaves the next-step text unchanged');

    console.log(`${MARKER} (e) NON-BLOCKING PROOF: append path is text-only, base preserved, no error/blocking signal`);
  }

  // ---- (f) SHORT-WINDOW PRECONDITION (F-001): a trailing window shorter than
  // STALL_WINDOW is conservatively NOT a stall, even for a genuinely-decreasing
  // sequence. This guards the pure assessor against the false positive a direct
  // caller could hit; the production entry point always supplies a full window. ----
  {
    // Genuinely decreasing 2-element window: must NOT be a false-positive stall.
    const decShort = assessReviewConvergence(4, [2, 1]);
    assert.equal(decShort.stalled, false, '(f) short decreasing window [2,1] must NOT stall (no short-window false positive)');
    assert.equal(decShort.message, undefined, '(f) short-window not-stalled carries no advisory message');

    // Flat 2-element window: also NOT a stall (insufficient history to assert one).
    const flatShort = assessReviewConvergence(4, [2, 2]);
    assert.equal(flatShort.stalled, false, '(f) short flat window [2,2] must NOT stall (insufficient completed-round history)');

    // Full-window classifications must remain IDENTICAL (production path unchanged):
    //   [2,2,1] -> last=1, not strictly decreasing -> stalled=true
    //   [2,1,0] -> last=0 (clean tail) / strictly decreasing -> stalled=false
    const fullStall = assessReviewConvergence(4, [2, 2, 1]);
    assert.equal(fullStall.stalled, true, '(f) full window [2,2,1] must still stall (unchanged)');
    assert.ok(fullStall.message, '(f) full-window stall still carries an advisory message');
    const fullConverge = assessReviewConvergence(4, [2, 1, 0]);
    assert.equal(fullConverge.stalled, false, '(f) full window [2,1,0] must still converge (unchanged)');

    console.log(`${MARKER} (f) SHORT-WINDOW PRECONDITION: [2,1]->false, [2,2]->false; full windows unchanged ([2,2,1]->true, [2,1,0]->false)`);
  }

  console.log(`\n${MARKER} PASS — convergence-stall advisory fires on stalled stories (case a), stays silent on healthy/below-threshold/single-clean stories, treats short trailing windows as not-stalled (case f), and only appends text (never blocks a transition).`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  run();
}
