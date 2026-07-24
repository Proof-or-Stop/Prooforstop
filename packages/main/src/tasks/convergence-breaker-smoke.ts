#!/usr/bin/env node
/**
 * B-bbaf CHK-005: convergence + takeover circuit breaker smoke.
 *
 * Replays the B-f458 death-loop signature (89 advances / 131:31 review / 65
 * takeovers) against the pure core and the on-disk state machine, and asserts a
 * healthy converging control never trips. Also covers the fourth signal
 * (repeated-identical-gate-failure), the env-threshold resolver, the human-ack
 * refusal under autopilot, and the gitignored-artifact registration.
 *
 * No CLI spawn: the pure functions are exercised directly, and the I/O helpers
 * against a throwaway temp story dir.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessBreaker,
  resolveConvergenceThresholds,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  resumeBreakerState,
  isInteractiveAckAllowed,
  gateFailureDigest,
  normalizeGateReason,
  extractGateBlockSignals,
  listSubstantiveIdPrefixes,
  bumpGateFailureCount,
  resetGateFailureCounts,
  readGateFailureCounts,
  maxGateFailureCount,
  readBreakerState,
  writeBreakerState,
  bumpTakeoverCount,
  readTakeoverCount,
  collectBreakerCounters,
  enforceConvergenceBreakerGate,
  type BreakerCounters,
} from '../core/convergence-breaker.js';
import {
  findRuntimeArtifactEntry,
  isMaterialExcludedRuntimeArtifactPath,
  listRuntimeArtifactIgnorePatterns,
} from '../core/runtime-artifact-registry.js';
import { recordStoryResumeHumanConfirmation } from '../handlers/story.js';

const T = DEFAULT_CONVERGENCE_THRESHOLDS;

// The B-f458 storm fixture.
const STORM: BreakerCounters = {
  advanceCount: 89,
  reviewRunCount: 131,
  reviewPassCount: 31,
  takeoverCount: 65,
  maxGateRepeat: 3,
};
// A healthy converging control: 8 advances, passing reviews, ~1 takeover, no repeats.
const HEALTHY: BreakerCounters = {
  advanceCount: 8,
  reviewRunCount: 12,
  reviewPassCount: 11,
  takeoverCount: 1,
  maxGateRepeat: 0,
};

{
  const events: Array<Record<string, unknown>> = [];
  const store = {
    readStory: () => ({ phase: 'TEST', currentReviewRound: 'round-1' }),
    appendProcessEvent: (_storyId: string, event: Record<string, unknown>) => events.push(event),
  } as unknown as import('../core/store.js').StoryStore;
  recordStoryResumeHumanConfirmation(store, 'B-human-confirmation', 'human reviewed the convergence freeze');
  assert.deepEqual(events, [{
    type: 'human_confirmation',
    storyId: 'B-human-confirmation',
    attemptId: 'round-1',
    command: 'story_resume',
    confirmation: 'convergence_breaker_resume',
    reason: 'human reviewed the convergence freeze',
    phase: 'TEST',
    reviewRound: 'round-1',
  }], 'successful story_resume must emit a typed durable human confirmation');
}

// ── 1. assessBreaker: storm trips on all four reasons; healthy never trips ────
{
  const a = assessBreaker(STORM, resolveConvergenceThresholds({}), null);
  assert.equal(a.tripped, true, 'storm must trip');
  const joined = a.reasons.join(' | ');
  assert.match(joined, /advance-count 89>20/, 'advance reason');
  assert.match(joined, /takeover 65>5/, 'takeover reason');
  assert.match(joined, /pass-rate 31\/131=24%<35%/, 'pass-rate reason');
  assert.match(joined, /gate-repeat 3>=2/, 'gate-repeat reason');
  // Budget available (spent 0) => first trip auto-recovers, does not freeze.
  assert.equal(a.action, 'auto-recover', 'first trip auto-recovers');
  assert.equal(a.nextState.frozen, false, 'first trip not frozen');
  assert.equal(a.nextState.autoRecoveriesSpent, 1, 'recovery spent');
  assert.equal(a.nextState.advanceBaseline, 89, 're-baselined to current advances');
}
{
  const a = assessBreaker(HEALTHY, resolveConvergenceThresholds({}), null);
  assert.equal(a.tripped, false, 'healthy control never trips');
  assert.equal(a.action, 'proceed', 'healthy proceeds');
}

// ── 2. Graduated: first trip auto-recovers, re-trip freezes ───────────────────
{
  const first = assessBreaker(STORM, T, null);
  assert.equal(first.action, 'auto-recover');
  // After re-baseline, advances keep climbing past baseline+maxAdvance -> re-trip.
  const worse: BreakerCounters = { ...STORM, advanceCount: 89 + 25 };
  const second = assessBreaker(worse, T, first.nextState);
  assert.equal(second.action, 'freeze', 're-trip freezes after budget spent');
  assert.equal(second.nextState.frozen, true, 'frozen after re-trip');
  // An already-frozen state stays frozen.
  const third = assessBreaker(worse, T, second.nextState);
  assert.equal(third.action, 'freeze', 'stays frozen');
}

// ── 3. Auto-recovery genuinely rescues a healthy-but-long story ───────────────
{
  // A story that trips once then STOPS growing (delta back under threshold) must
  // not freeze on the next assessment.
  const first = assessBreaker(STORM, T, null); // auto-recover, baseline=89
  const steady: BreakerCounters = { advanceCount: 92, reviewRunCount: 131, reviewPassCount: 130, takeoverCount: 1, maxGateRepeat: 0 };
  const next = assessBreaker(steady, T, first.nextState);
  assert.equal(next.tripped, false, 'after recovery a now-healthy story does not trip');
  assert.equal(next.action, 'proceed');
}

// ── 4. Threshold resolver: defaults, override, typo fallback ──────────────────
{
  assert.equal(resolveConvergenceThresholds({}).maxAdvance, 20, 'default maxAdvance');
  assert.equal(resolveConvergenceThresholds({ LATTICE_CONVERGENCE_MAX_ADVANCE: '5' }).maxAdvance, 5, 'override');
  for (const bad of ['abc', '-1', '1e9', '', '  ']) {
    assert.equal(
      resolveConvergenceThresholds({ LATTICE_CONVERGENCE_MAX_ADVANCE: bad }).maxAdvance,
      20,
      `garbage ${JSON.stringify(bad)} falls back to default`,
    );
  }
  // With MAX_ADVANCE=5 a story trips at 6 advances (delta 6>5) but not at 5.
  const th = resolveConvergenceThresholds({ LATTICE_CONVERGENCE_MAX_ADVANCE: '5' });
  const at5: BreakerCounters = { advanceCount: 5, reviewRunCount: 0, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: 0 };
  const at6: BreakerCounters = { ...at5, advanceCount: 6 };
  assert.equal(assessBreaker(at5, th, null).tripped, false, '5 advances does not trip at MAX_ADVANCE=5');
  assert.equal(assessBreaker(at6, th, null).tripped, true, '6 advances trips at MAX_ADVANCE=5');
}

// ── 5. Pass-rate min-sample gate: low sample never trips ──────────────────────
{
  const lowSample: BreakerCounters = { advanceCount: 0, reviewRunCount: 1, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: 0 };
  assert.equal(assessBreaker(lowSample, T, null).tripped, false, '0/1 (below min-sample) never trips pass-rate');
}

// ── 6. Fail-open on malformed input ───────────────────────────────────────────
{
  const junk = { advanceCount: NaN, reviewRunCount: undefined, reviewPassCount: null, takeoverCount: 'x', maxGateRepeat: Infinity } as unknown as BreakerCounters;
  const a = assessBreaker(junk, T, null);
  assert.equal(a.tripped, false, 'malformed input fails open (no trip, no throw)');
}

// ── 7. Fourth signal: digest grouping, bump-to-threshold, reset ───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-'));
  try {
    // Same command + reason that differs only in a volatile TIMESTAMP => same
    // digest. The retry ordinal is held CONSTANT here so this assertion isolates
    // the ISO rule; the ordinal's own collapse is asserted separately as matrix
    // case `bare-attempt-ordinal` in section 7b, which is the shape B-cc54's
    // CHK-001:adversarial:0 requires. The printed counterpart of THIS pair is
    // matrix case `iso-timestamp-only`.
    const d1 = gateFailureDigest('story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)');
    const d2 = gateFailureDigest('story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 3)');
    assert.equal(d1, d2, 'digest collapses volatile ISO timestamps to the same key');
    const d3 = gateFailureDigest('story_advance', 'a completely different failure reason');
    assert.notEqual(d1, d3, 'different reasons yield different digests');

    // Two failures with the same digest => count 2 => trips gate-repeat.
    bumpGateFailureCount(dir, 'story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)');
    bumpGateFailureCount(dir, 'story_advance', 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 3)');
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 2, 'same-reason repeats accumulate to 2');
    const trip: BreakerCounters = { advanceCount: 0, reviewRunCount: 0, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: maxGateFailureCount(readGateFailureCounts(dir)) };
    assert.equal(assessBreaker(trip, T, null).tripped, true, 'gate-repeat 2>=2 trips');

    // (B-bf52: the former `reason ALPHA` / `reason BETA` distinctness fixture
    // lived here. Both strings were too short to reach the truncation and
    // contained none of the collapsing token shapes, so the guard could not
    // exercise the failure it claimed to guard — it passed even while every real
    // DEV-gate rejection for a story collapsed to one key. It is replaced by the
    // two-direction matrix in section 7b below, which drives the real counter
    // for every case.)

    // Reset (as on a successful advance) clears the counter.
    resetGateFailureCounts(dir);
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 0, 'reset clears the gate-failure counter');

    // Missing file fails open to 0.
    const emptyDir = mkdtempSync(join(tmpdir(), 'cbreaker-empty-'));
    assert.equal(maxGateFailureCount(readGateFailureCounts(emptyDir)), 0, 'missing counter file reads as 0');
    rmSync(emptyDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 7b. B-bf52: substantive-vs-incidental gate-failure digest matrix ──────────
//
// gateFailureDigest is the key under which gate rejections are COUNTED, and the
// count is what freezes a story. Two directions must therefore hold at once:
//
//   must-differ         substantively different rejections must keep separate
//                       keys, so a story that fixes one gap and then hits a
//                       different one is NOT read as one gate failing twice
//                       (the false freeze observed on B-d877 and B-956f, each of
//                       which cost an interactive human TTY acknowledgement);
//   must-still-collapse rejections differing only in incidental detail must keep
//                       ONE key, so a genuine livelock still accumulates and the
//                       breaker still fires. This is the guard on the inverse
//                       risk: the fix makes the breaker fire LESS often, and
//                       left unchecked that would hand a stuck agent back the
//                       unbounded retry loop the breaker exists to stop.
//
// Every case drives the REAL bumpGateFailureCount / maxGateFailureCount path in
// its own throwaway story dir and asserts the resulting COUNTER (and, for the
// collapse lane, that assessBreaker still trips), because the operator-visible
// failure is a frozen story, not a string mismatch.
//
// SCOPE. Against main this story changes exactly TWO rules of the normalizer and
// leaves the rest of the chain (`0x`, the `\b[0-9a-f]{7,}\b` hex rule, the ISO
// timestamp rule, the 200-character prefix and the signals-based hash basis)
// byte-identical:
//
//   POSIX path rule   narrowed to TOKEN START, fixing C2 (`DEV/REVIEW` vs
//                     `DEV/TEST`) and C4 (`src/core/alpha.ts` vs `beta.ts`),
//                     which main's `\/[^\s"']+` collapsed by rewriting from ANY
//                     slash in a token;
//   digit rule        `/\d+/g` replaced by an allowlist over this repo's own
//                     lifecycle-artifact id vocabulary, fixing C3 (`CHK-001` vs
//                     `CHK-002`).
//
// The story ALSO originally targeted the 200-character truncation (its C1a/C1b
// classes: every ProofStory DEV-gate rejection for one story collapsed onto one
// key because the invariant banner alone exceeds the cut). B-cc54 landed on main
// first and fixed that class by a BETTER route — it leaves the truncation and
// the normalization rules alone and folds structurally-extracted gap-id signals
// into the hash basis, so distinctness comes from STRUCTURE rather than from
// classifying free-text tokens. Those cases are owned by
// tasks/gate-repeat-block-smoke.ts (B-cc54's suite, a registered
// doneRequiredCommand) and are deliberately NOT duplicated here; asserting them
// twice would pin the same contract to a mechanism this story does not supply.
//
// WHY THE DIGIT RULE IS AN ALLOWLIST AND NOT A SYNTACTIC TEST. Earlier rounds of
// this story tried to separate substantive from incidental digits by SHAPE —
// "identifier-attached digits are substantive, standalone digits are not". That
// predicate is unsound, and B-cc54 is the proof: its CHK-002:adversarial:2
// requires `gate blocked for b-1234` and `... b-5678` to keep ONE key, and
// `b-1234` is identifier-attached in exactly the way `CHK-001` is. No syntactic
// rule separates them, so the shape-based draft was mutually exclusive with a
// landed gate contract. The separation is SEMANTIC instead: an ordinal that
// names WHICH lifecycle artifact the gate refused on is substantive, every other
// digit run is noise, and this repo mints those ids from a fixed vocabulary
// (SUBSTANTIVE_ID_PREFIXES in core/convergence-breaker.ts) — so the vocabulary
// IS the rule. That is the same kind of structured, repo-specific knowledge
// B-cc54's own extractGateBlockSignals relies on, not a guess about free text.
//
// A round-4 draft went further still and DELETED the general digit rule outright,
// on the premise that the shape `(attempt N)` had no real producer. That premise
// is false and the draft is REVERTED: B-cc54's CHK-001:adversarial:0 requires
// `attempt 7` and `attempt 91` to digest identically. The two `bcc54-*` cases
// below reproduce B-cc54's own fixtures INSIDE this story's matrix, so neither
// the deletion nor a widened allowlist can be re-attempted without failing in
// the suite that proposes it, rather than only in a neighbouring one.
//
// `guardedBy` names the one normalizer rule each case — in BOTH lanes — is bound
// to. Reverting that rule alone must fail exactly the cases naming it and leave
// the rest passing, so a regression localizes to the rule that caused it rather
// than failing as one opaque block. A tag names a rule AND the DIRECTION in
// which the case depends on it, because the two directions have OPPOSITE reverts
// (found in review round 2 by cross-host codex, which observed that a bare
// `path-rule` tag conflated them: deleting the POSIX path rule fails only the
// three collapse cases, while `phase-pair` and `in-repo-file-path` depend on
// that rule being NARROW, not on it existing, and keep passing):
//
//   path-rule-collapse / digit-rule-collapse / hex-rule-collapse /
//   iso-or-digit-rule-collapse
//                            the case fails if the rule is DELETED or narrowed;
//   path-rule-overreach /
//   substantive-id-allowlist the case fails if the rule is reverted to the WIDER
//                            form main has — the slash-anywhere path rule, or
//                            `/\d+/g` with no allowlist;
//   substantive-id-token-head-exact /
//   substantive-id-token-tail-exact /
//   substantive-id-doubled-prefix /
//   substantive-id-colon-composite-cost
//                            the case fails if the WHOLE-TOKEN test is loosened,
//                            so that an id welded into a larger token is
//                            protected again — the worse-than-main direction. The
//                            colon tag is the F-052 member of this group and is
//                            ALSO the record of what closing that hole costs; see
//                            its declaration for why one tag carries both;
//   substantive-id-no-reduction
//                            F-054, and the tag that replaces the three strip tags
//                            of round 12 (`substantive-id-wrapper-pair-strip`,
//                            `…-sentence-punct-strip`,
//                            `…-balanced-wrapper-strip`), which are deleted rather
//                            than renamed because the rule they named is gone. The
//                            case fails if ANY reduction is re-introduced in front
//                            of the whole-token test — a trailing punctuation strip
//                            in any character set, a wrapper peel balanced or not,
//                            the independent-run form of rounds 9-11 — so that a
//                            token which merely ENDS IN or is WRAPPED BY
//                            punctuation reduces to an id. That is the
//                            worse-than-main direction: `bug-2:` and `bug-5:` are
//                            ordinary TAP subtest names main collapses. Its cases
//                            are ALSO the record of what the deletion costs, since
//                            seven of them were must-differ cases in round 12;
//   allowlist-boundedness    the case fails if the allowlist GROWS past the
//                            lifecycle-artifact vocabulary (adding `b-` is the
//                            concrete mistake it stops), and is the inverse
//                            revert of `substantive-id-allowlist` on the same
//                            rule.
//
// MEASURED OVERLAPS, RE-DERIVED FROM SCRATCH IN ROUND 13 (F-054) against the
// current 51-case set. Every row below was produced by mutating the BUILT
// normalizer in a detached, freshly built worktree's dist and reading back the
// failing case names, and NOT ONE ROW WAS CARRIED FORWARD from round 12. That
// re-derivation is not ceremony: the matrix itself changed shape — seven cases
// moved lanes, four were added — so a carried-forward row would have described a
// matrix that no longer exists. A tag names the revert a case is HERE to catch,
// not the only revert that can fail it, and pretending otherwise is how the false
// ISO claim and the false trailing-`\b` claim both got written.
//
//   digit rule DELETED        fails 33 of 51 — the whole collapse lane's digit
//                             group, `bcc54-*`, the review-bookkeeping cases, every
//                             `embedded-test-output-*` case, the whole
//                             `substantive-id-no-reduction` group and all three
//                             colon-composite cases, because with no digit rule
//                             EVERY ordinal survives (it also fails B-cc54's own
//                             suite). It does NOT fail either `prefix-window-residual`
//                             case: those two collapse on the WINDOW, which no
//                             normalizer rule reaches;
//   hex rule DELETED          fails `hex-id` and `bcc54-cross-vendor-noise`;
//   path rule DELETED         fails the three `path-rule-collapse` cases and
//                             `bcc54-cross-vendor-noise`;
//   path rule WIDENED to
//   main's slash-anywhere     fails exactly `phase-pair`, `in-repo-file-path` and
//                             `signal-less-long-rejection`;
//   ISO rule deleted ALONE    fails NOTHING (it is redundant with the digit rule
//                             for a pure-digit timestamp — see `iso-timestamp-only`).
//                             LOCALIZATION CAVEAT, measured this round rather than
//                             assumed: deleting BOTH the ISO and the digit rule does
//                             not name `iso-timestamp-only` either — it aborts the
//                             run at section 7's own ISO assertion, which sits ABOVE
//                             this matrix. So the disjunction the tag names has no
//                             mutation that reaches the matrix at all. That is the
//                             same class of broken localization promise the
//                             empty-allowlist row below records, and it is stated
//                             here instead of being left as an implied guarantee;
//   id HEAD anchor `^`
//   DROPPED                   fails exactly `embedded-test-output-hyphen-compounds`,
//                             `…-slash-joined-names`, `…-doubled-prefix`,
//                             `…-unmatched-open-paren`, `…-unmatched-open-quote`,
//                             `open-blocking-finding-composite-id` and
//                             `embedded-test-output-label-qualified-id` — seven,
//                             unchanged in COUNT from round 12 but re-measured, not
//                             restated. The two unmatched-wrapper names are still in
//                             it: with the head anchor gone the id is found inside
//                             the token again, so `(bug-2` is protected by that
//                             mutation even though nothing peels the paren;
//   id TAIL anchor `$`
//   DROPPED                   fails 13 — `embedded-test-output-digit-letter-tail`,
//                             `…-slash-welded-tail`, `…-dot-welded-tail`,
//                             `…-hyphen-welded-tail`, `…-non-ascii-welded-tail`,
//                             `…-unmatched-close-paren`, `…-trailing-colon-name`,
//                             `…-trailing-comma-name`, `…-trailing-period-name`,
//                             `checklist-not-done-comma-list`,
//                             `scope-extension-proposal-sentence-final-period`,
//                             `blocking-finding-desc-semicolon-attached-id` and
//                             `verification-intent-ref-lane-suffix`. This ROW GREW
//                             from seven to thirteen and the growth is the F-054
//                             deletion showing through: every punctuation-attached
//                             shape is now held apart from an id by the TAIL ANCHOR
//                             ALONE, where round 12 held it apart by a balance rule
//                             as well. Worth knowing when reading a failure report —
//                             a group this large means the anchor, not the matrix;
//   doubled-prefix lookahead
//   DROPPED                   fails exactly `embedded-test-output-doubled-prefix`;
//   `<label>:` QUALIFIER
//   RE-ADDED, once
//   (the F-052 revert)        fails exactly `open-blocking-finding-composite-id` and
//                             `embedded-test-output-label-qualified-id`;
//   TRAILING `:`-segments
//   ADMITTED
//   (`(?::[a-z0-9-]+)*$`,
//   the suffix rescue)        fails exactly `verification-intent-ref-lane-suffix`.
//                             With the row above, this is what makes the
//                             colon-composite tag a real guard in BOTH directions:
//                             no interior `:` structure can be re-added at either end
//                             without failing a named case;
//   SENTENCE-punct strip
//   RESTORED
//   (`[,;:.!?]+$`, THE F-054
//   REVERT)                   fails exactly six — `embedded-test-output-trailing-colon-name`,
//                             `…-trailing-comma-name`, `…-trailing-period-name`,
//                             `checklist-not-done-comma-list`,
//                             `scope-extension-proposal-sentence-final-period` and
//                             `blocking-finding-desc-semicolon-attached-id`. The
//                             first three are NON-ids and are the leak itself; the
//                             last three are REAL ids and are the cost. One mutation,
//                             both halves of the trade, which is the honest shape of
//                             this decision;
//   BALANCED wrapper peel
//   RESTORED                  fails exactly `embedded-test-output-balanced-paren-wrapped-id`
//                             and `…-bracketed-and-quoted-id`;
//   ROUND-12 REDUCTION
//   RESTORED IN FULL
//   (sentence strip THEN
//   balanced peel)            fails exactly ten: the six of the sentence row, the two
//                             of the peel row, plus
//                             `excluded-keyword-parenthesized-item-id` and
//                             `embedded-test-output-balanced-wrapper-then-sentence-punct`
//                             — the two tokens that are BOTH wrapped and
//                             punctuation-terminated, which neither half reduces
//                             alone. This is the exact revert this round exists to
//                             stop, and it is the row to check first if the
//                             `substantive-id-no-reduction` group ever goes red;
//   ROUND-11 REDUCTION
//   RESTORED
//   (the two independent runs
//   `^[("'[{<]+` and
//   `[)"'\]}>,;:.!?]+$`)      fails exactly fourteen: the ten above plus the four
//                             unmatched-wrapper cases. The nesting is the point —
//                             each older reduction fails a SUPERSET of the newer
//                             one's cases, so the group size localizes WHICH
//                             reduction came back;
//   whole-token BODY reduced
//   to `\d+` (the F-032
//   prefix-before-digits
//   revert)                   fails exactly `embedded-test-output-bare-compound-id`.
//                             This ROW SHRANK from two cases to one, and the reason
//                             is the F-054 cost: the two `SEP-…` must-differ cases it
//                             used to fail are now collapse cases, so the compound
//                             body's only guard is the bare-id case built from the
//                             embedded-output channel;
//   allowlist EMPTIED         fails 7 — every must-differ case whose distinctness
//                             comes from a protected id (`checklist-ordinal`,
//                             `checklist-ordinal-at-reason-start`, `finding-ordinal`,
//                             `unfixed-bug-ordinal`, `checklist-not-done-final-bare-id`,
//                             `embedded-test-output-bare-compound-id`,
//                             `blocking-finding-cited-id-within-window`) — and
//                             NOTHING else, with the suite still reaching and naming
//                             them. It was 12 in round 12; the five fewer are exactly
//                             the wrapped and punctuation-attached must-differ cases
//                             the deletion moved to the collapse lane, which is the
//                             cost showing up as a smaller blast radius;
//   placeholder alphabet made
//   DECIMAL                   fails the SAME 7. The two mutations are
//                             indistinguishable by case name, which is honest to
//                             state: both destroy id protection outright, one by
//                             refusing to protect and one by making every restored
//                             token identical;
//   allowlist WIDENED with
//   `b-`                      fails `bcc54-story-id-digits` and, incidentally,
//                             `embedded-test-output-bare-compound-id` (its compound
//                             body starts `b-`, so the doubled-prefix lookahead then
//                             refuses `sep-b-bf52-001`), plus B-cc54's own suite;
//   allowlist WIDENED with
//   `rr-`/`rp-`/`rl-`/`i-`    fails exactly `init-check-issue-ordinal` — and NOTHING
//                             ELSE. Re-measured from scratch: `rr-` alone, `rp-`
//                             alone and `rl-` alone each fail NOTHING, and only `i-`
//                             alone fails a case. The cause is that every
//                             RR-/RP-/RL- render site welds the id behind a `:` or an
//                             `=` (`B-bf52:RR-002`, `loopId=B-bf52:RL-001,`), so under
//                             a form with no interior structure and no reduction those
//                             tokens are not ids whether or not their prefix is
//                             allowlisted. The exclusions still stand on their own
//                             reasoning and the two collapse assertions are still
//                             TRUE; they simply have no single-mutation guard.
//                             Measured compositely, and quoted with everything each
//                             composite fails rather than only the interesting name:
//                             `rr-` allowlisted AND the qualifier re-added fails
//                             `stale-review-run-evidence` plus the two colon-composite
//                             cases the qualifier alone already fails (3 total);
//                             `rl-` allowlisted AND the head anchor dropped now fails
//                             only the seven head-anchor cases and NOT
//                             `review-loop-ordinal` — a CHANGE from round 12, because
//                             `loopid=b-bf52:rl-001,` ends in a comma that used to be
//                             stripped first. The composite that fails it is `rl-`
//                             allowlisted AND the head anchor dropped AND the sentence
//                             strip restored (14 total). Three mutations to reach one
//                             case is not a guard, and this row says so rather than
//                             implying one;
//   prefix cut made
//   UNCONDITIONAL 200         fails exactly `signal-less-long-rejection`;
//   prefix cut WIDENED to 592
//   on the signals branch
//   (592 is the widest legal
//   value — B-cc54's
//   CHK-002:adversarial:1
//   breaks at 593)            fails exactly `blocking-finding-cited-id-past-window`.
//                             This is a NEW row and the reason the F-033 residual
//                             changed producer: measured on the round-12 `SEP-…`
//                             pair the same mutation failed NOTHING, because after
//                             the deletion neither half of that pair keys apart at
//                             any window. It also does not fail
//                             `requirement-ordinal-past-window`, even composed with a
//                             restored sentence strip (that composite fails 7 cases
//                             and not this one), because the `REQ-` ordinal would sit
//                             at normalized character 753 — past every legal cut;
//   signals FOLD collapsed
//   to prefix alone           fails exactly `proofstory-gap-signal-set` (and
//                             B-cc54's own suite).
//
// The empty-allowlist row is a CORRECTION carried by the CODE, not by this
// comment (F-041). Before the explicit empty branch in
// core/convergence-breaker.ts, emptying the set built a pattern whose empty
// alternation matched at every hyphen — so an ISO timestamp's own `-07-14…`
// became a "protected id", an assertion above this matrix blew up BEFORE the
// matrix ran, and the mutation named ZERO cases while the evidence claimed it
// "fails the substantive-id cases". Localization is a promise this suite makes,
// and a mutation that kills the run before the matrix is a promise broken. The
// row above is the re-measurement: 7 cases, named, suite intact.
//
// Localization therefore works by GROUP, which is what the grouped failure report
// prints: a single group means that rule regressed, and a case failing alone means
// the rule its tag names.
//
// The closing banner's inventory is DERIVED from these arrays, never hand-typed:
// a hand-written count is the first thing to go stale when a case is added, and a
// stale count in a PASS line is a false attestation about what was checked.
let digestMatrixSummary = '';
{
  const CMD = 'story_advance';

  // A reason far larger than any realistic gate message (an embedded transcript).
  const TRANSCRIPT = `gate BLOCKED for B-bbaf:\n${'  at frame /Users/jek/Documents/Work/proofbound/packages/main/dist/core/machine.js:179:11\n'.repeat(5_000)}`;
  assert.ok(TRANSCRIPT.length > 200_000, 'the pathological fixture is genuinely oversize');

  // ── A real production rejection message ────────────────────────────────────
  // Reproduced from its build site, not invented. formatLeaseAge renders the
  // heartbeat age as a digit run WELDED to a unit letter (`45s`, `8m`, `2h`);
  // the pair below varies ONLY that age, so it is the same failure retried —
  // exactly the runaway the breaker must catch. Under the allowlist the digits
  // carry no prefix, so `45` and `52` both normalize to `#` and the unit letter
  // is left alone, which is how main's `/\d+/g` behaved too. (An earlier draft
  // needed a dedicated duration rule because it had narrowed the digit rule to
  // STANDALONE numbers, which a welded unit letter defeats. The allowlist does
  // not narrow by position, so that rule is gone and this pair is guarded by the
  // digit rule itself.)
  // F-011: `storyScopedMutating` is verbatim, not a paraphrase —
  // formatNonOwnerError interpolates `ctx.ownershipClass`, and story_advance's
  // real class is `storyScopedMutating` (core/command-policy.ts:152, one of the
  // five OwnershipClass values at :66-71). The former `mutating` is not a member
  // of that enum and never appears in a rendered message.
  const leaseNonOwner = (age: string): string => // core/story-owner-lease.ts:616-640
    `B-bf52 is owned by Proofbound session main-agent-s2s1-stable-f93ff408f3, heartbeat ${age} ago ` +
    `(owner cwd: /Users/jek/Documents/Work/proofbound/.worktrees/B-bf52). "story_advance" is an owner-gated storyScopedMutating command, ` +
    `so this session (worker-s2s1) cannot run it. The owner lease is still ACTIVE. ` +
    `Use read-only commands, wait for the owner, or rerun with --forceTakeover to seize the active lease (a deliberate human override).`;

  // ── B-cc54's own fixtures, quoted VERBATIM ─────────────────────────────────
  // CC54_NOISE_A/B are CHK-001:adversarial:0 and CC54_STORY_A/B are
  // CHK-002:adversarial:2 of tasks/gate-repeat-block-smoke.ts. They are
  // duplicated here deliberately rather than imported: B-cc54's suite is a
  // separate landed contract, and this story must be structurally unable to
  // regress it from inside its OWN matrix — the noise pair pins the digit rule
  // against deletion, and the story-id pair pins the allowlist against growth.
  const CC54_NOISE_A = 'GATE blocked at /Users/jek/x/y.ts 2026-07-23T12:00:00Z id a1b2c3d4e5f6 attempt 7';
  const CC54_NOISE_B = 'gate BLOCKED at /var/tmp/other.ts 2026-01-02T03:04:05Z id f6e5d4c3b2a1 attempt 91';
  const CC54_STORY_A = 'gate blocked for b-1234';
  const CC54_STORY_B = 'gate blocked for b-5678';

  // ── The real REVIEW→TEST stale-evidence rejection ──────────────────────────
  // core/review-run.ts:1442 renders `${kind} ${id} bound reviewRunId ${runId} is
  // stale: ${reason}. ${staleMaterialHint(...)}`; core/machine.ts:1181 wraps the
  // verdict as `Cannot enter TEST: ${message} [${code}]`. Composed here as it
  // renders, hint text verbatim from staleMaterialHint (core/review-run.ts:830).
  const staleReviewEvidence = (runOrdinal: string): string =>
    `Cannot enter TEST: pass B-bf52:RP-001 bound reviewRunId B-bf52:${runOrdinal} is stale: HEAD moved since the run was started. ` +
    `→ The reviewRunId's HEAD/materialHash is stale and cannot be fixed by repeatedly running review_run_start within the same REVIEW round; ` +
    `first return to DEV to fix and commit, then run lattice story_advance '{"storyId":"B-bf52","phase":"REVIEW"}' to enter a new currentReviewRound, ` +
    `and subsequently run lattice review_run_start '{"storyId":"B-bf52","agent":"lattice-review-code"}' [review_evidence_invalid]`;

  // ── A real SIGNAL-LESS scope-gate rejection (F-031 / CHK-001) ──────────────
  // The advice sentence is verbatim from nextActionForViolation
  // (core/scope-contract.ts:308) and the enforce-mode framing from
  // violationStatus above it. Deliberately carries NO bracketed reason code, no
  // bulleted snake_case gap id and no missing_/invalid_/stale_ inline token, so
  // extractGateBlockSignals returns [] and the length cut alone decides the key.
  // The offending path is LAST, past character 200, which is what makes the two
  // variants collapse under an unconditional 200-character prefix.
  const scopeGateBlock = (path: string): string =>
    `Cannot enter TEST: the scope gate is blocking for B-bf52. The story scope contract is in enforce mode, so every changed path must be ` +
    `declared by the contract, covered by a shared classifier rule, or carry an explicit acknowledgement that a reviewer can see. ` +
    `Run scope_contract_acknowledge with a reviewer-visible reason, add the path to the contract, or revert it. Blocking path: ${path}`;

  // ── The real pending scope-extension-proposal rejection (F-032) ────────────
  // core/machine.ts:269 renders `Cannot enter INIT_CHECK: ${pending.length} scope
  // extension proposal(s) are still pending: ${ids}. [scope_extension_proposal_pending]`
  // plus its next-action line; handlers/scope-anti-expansion.ts:120 mints the ids
  // as `SEP-${storyId}-${NNN}`. Composed here as it renders.
  //
  // This is the COMPOUND-id shape that defeated the first mechanism: the ordinal
  // `-001` is preceded by `bf52-`, not by `sep-`, so a rule that inspects only
  // the prefix immediately before a digit run left it unprotected even with
  // `sep-` allowlisted.
  //
  // F-054 COST, stated where the producer is quoted rather than only in the case:
  // this render joins its ids with `, ` and closes the list with `.`, so EVERY
  // `SEP-` token it emits has punctuation attached and NONE of them is the whole
  // token. With the reduction deleted, no id in this real rejection is protected
  // any more, and both of the cases built from it are in the must-still-collapse
  // lane. The compound BODY is still guarded — by
  // `embedded-test-output-bare-compound-id`, from the one channel that can carry a
  // bare compound id.
  const scopeExtensionPending = (ids: string[]): string =>
    `Cannot enter INIT_CHECK: ${ids.length} scope extension proposal(s) are still pending: ${ids.join(', ')}. [scope_extension_proposal_pending]\n` +
    `→ Run scope_extension_decide for each proposal, then rerun scope_freeze_check.`;

  // ── The real DONE test-evidence rejection (F-043) ──────────────────────────
  // core/machine.ts:1190 returns `Cannot enter DONE: test ${evidence.result}:
  // ${evidence.output}` — it embeds the RAW test output, so arbitrary third-party
  // text reaches the digest. That is the path on which the `\b` leading guard was
  // measurably WORSE than main: a hyphen is a non-word character, so `\b` matched
  // at the seam of every HYPHEN-JOINED compound and `de-bug-2` kept an
  // allowlisted-looking, protected tail. Two runs of the same failing suite whose
  // only difference was such an embedded ordinal then minted two keys and the
  // repeat never accumulated, while main (which rewrites every ordinal to `#`)
  // collapsed them correctly.
  //
  // The three compound shapes below are the measured ones, one per allowlisted
  // stem that a test name can plausibly end on: `-f-N`, `-bug-N`, `-req-N`. None
  // of them is an artifact id — they are ordinary hyphenated test-case names — so
  // all three must normalize away.
  const doneTestFailure = (fOrd: string, bugOrd: string, reqOrd: string): string => [
    'Cannot enter DONE: test FAIL: # tests 3',
    '# pass 0',
    '# fail 3',
    `not ok 1 - scenario-${fOrd} rejects an unsigned receipt`,
    `not ok 2 - de-${bugOrd} reproducer still red`,
    `not ok 3 - over-${reqOrd} milestone binding`,
    `  at: tests/red/scenario-${fOrd}.test.ts:41:7`,
  ].join('\n');

  // ── The same DONE rejection, two shapes the NEGATIVE guard still admitted ───
  // F-048, cross-host codex round 9. `(?<![\w-])` enumerated the characters that
  // must not precede an allowlisted stem, and an enumeration only ever covers
  // what it lists:
  //
  //   (a) a SLASH is neither a word character nor a hyphen, so `scenario/bug-2`
  //       walked straight through the lookbehind and was protected as an id;
  //   (b) the search began at the FIRST allowlisted prefix it found, so a DOUBLED
  //       prefix — `BUG-BUG-2` — satisfied the lookbehind at the head of the token
  //       and was protected too.
  //
  // Neither is an artifact id, and main collapses both (it rewrites every ordinal
  // to `#`), so both were strictly WORSE THAN MAIN — the one direction this story
  // is not allowed to be. Slash-separated test names are routine in failed-test
  // output, which core/machine.ts:1190 embeds RAW into `Cannot enter DONE: test
  // ${evidence.result}: ${evidence.output}`, so the same underlying failure minted
  // a fresh key on every retry and evaded the brake entirely.
  //
  // Both fixtures use that same real producer and vary ONLY the embedded ordinal.
  const doneTestFailureSlashName = (ord: string): string => [
    'Cannot enter DONE: test FAIL: # tests 2',
    '# pass 0',
    '# fail 2',
    `not ok 1 - scenario/bug-${ord} still red`,
    `not ok 2 - suite/req-${ord} binding`,
    `  at: tests/red/scenario/bug-${ord}.test.ts:41:7`,
  ].join('\n');

  const doneTestFailureDoubledPrefix = (ord: string): string => [
    'Cannot enter DONE: test FAIL: # tests 1',
    '# pass 0',
    '# fail 1',
    `not ok 1 - BUG-BUG-${ord} reproducer still red`,
  ].join('\n');

  // ── The same DONE rejection, the TOKEN-END leak (F-051) ───────────────────
  // The fourth leak in this guard, and the one that ended the boundary era.
  // Rounds 7-9 each fixed the HEAD of the token and left the TAIL as an
  // ASSERTION — a trailing `\b` — which succeeds between a digit and ANY
  // non-word character. So the substring `bug-2` inside `bug-2/x`, `bug-2.x`,
  // `bug-2-x` and `bug-2é` was protected as though the whole label were an
  // artifact id, and only `bug-2x` (a following ASCII word character, the one
  // shape the round-9 case covered) was refused.
  //
  // Cross-host codex measured all four as WORSE THAN MAIN, which rewrites every
  // ordinal to `#` and collapses them. Same real producer as above:
  // core/machine.ts:1190 embeds RAW test output, and every one of these is an
  // ordinary test-case name.
  //
  // One parameterized fixture with one welded tail per case, so each punctuation
  // shape is named separately in the failure report rather than hidden inside a
  // bundle. Under the whole-token rule none of them is an id, because an id
  // welded into a larger token is no longer the whole token.
  const doneTestFailureWeldedTail = (ord: string, tail: string): string => [
    'Cannot enter DONE: test FAIL: # tests 1',
    '# pass 0',
    '# fail 1',
    `not ok 1 - bug-${ord}${tail} reproducer still red`,
  ].join('\n');

  // The same producer once more, for the COLON-welded head (F-052) — the leak the
  // round-10 qualifier introduced, quoted in the shape cross-host codex reported
  // it. `timeout:bug-2` is an ordinary TAP subtest name: a lane label joined to a
  // case label by a colon, in exactly the raw test output core/machine.ts:1190
  // embeds. `(?:[a-z0-9-]+:)?` accepted `timeout:` as freely as it accepted a
  // story id, so this pair keyed apart on that branch and collapses on main.
  //
  // It replaces the round-10 fixture `a:b:bug-N`, which exercised only the
  // REPEATABLE variant of the same fragment and so passed while the single-segment
  // variant leaked. One colon is the sharper fixture, because one colon is what
  // the rule actually allowed.
  const doneTestFailureLabelQualified = (ord: string): string => [
    'Cannot enter DONE: test FAIL: # tests 1',
    '# pass 0',
    '# fail 1',
    `not ok 1 - timeout:bug-${ord} reproducer still red`,
  ].join('\n');

  // The same producer once more, for the two WRAPPING positions this tree has no
  // first-party producer for. Stated plainly rather than dressed up: no
  // story_advance rejection in core/ or handlers/ renders an artifact id inside
  // brackets or quotes of its own — the brackets in core/machine.ts:756 and
  // core/verification.ts:216 wrap a SEVERITY or a STATUS, and the quotes in
  // core/machine.ts:203 wrap a keyword. The channel that really does deliver an
  // id inside arbitrary punctuation is core/machine.ts:1190's embedded test
  // output, which is where all four leaks in this guard were found, and a TAP
  // line naming the checklist item it failed on is ordinary output. Both
  // wrappings ride in ONE fixture because both are in the same character class:
  // a single mutation (narrowing the opening-punctuation class) fails both, so
  // splitting them would name two cases for one revert.
  const doneTestFailureWrappedItemId = (id: string): string => [
    'Cannot enter DONE: test FAIL: # tests 2',
    '# pass 0',
    '# fail 2',
    `not ok 1 - [${id}] has no passing verification evidence`,
    `not ok 2 - "${id}" is not waived`,
  ].join('\n');

  // ── The same producer once more, for ATTACHED PUNCTUATION (F-053, F-054) ───
  // The sixth and seventh leaks, both in the REDUCTION that used to run in front
  // of the whole-token test rather than in the id pattern.
  //
  //   F-053  rounds 9-11 stripped a leading run of opening characters and a
  //          trailing run of closing characters INDEPENDENTLY, so half a wrapper
  //          came off as readily as a whole one: cross-host codex measured
  //          `not ok 1 - (bug-2 reproducer still red` against its `(bug-5` sibling
  //          digesting APART on this branch while main collapses both, because the
  //          leading strip deleted an UNMATCHED `(` and reduced the NON-id token
  //          `(bug-2` to the id `bug-2`. `bug-2)` was the mirror.
  //   F-054  round 12 fixed the wrapper half by requiring BALANCE and left the
  //          other half an unconditional `[,;:.!?]+$` strip, so the arbitrary TAP
  //          subtest name `bug-2:` reduced to `bug-2` and was protected —
  //          `not ok 1 - bug-2: reproducer still red` and its `bug-5:` sibling
  //          digested APART here while main collapses them.
  //
  // Same producer as every other leak in this guard — core/machine.ts:1190 embeds
  // RAW test output — and none of these shapes is exotic there: TAP names carry
  // unbalanced parens, shell fragments and trailing colons all the time, and a
  // list of test names puts a comma against the last character of each entry.
  //
  // ONE parameterized fixture spans every attached-punctuation shape, balanced and
  // unbalanced, leading and trailing, so all of them are built from the same bytes
  // and differ only in the punctuation attached. It is named for what it does
  // rather than for wrappers (its round-12 name was `doneTestFailureWrappedTail`),
  // because under the deletion a wrapper is not a special kind of attachment: an
  // id with anything attached is simply not the token.
  const doneTestFailurePunctuated = (ord: string, lead: string, trail: string): string => [
    'Cannot enter DONE: test FAIL: # tests 1',
    '# pass 0',
    '# fail 1',
    `not ok 1 - ${lead}bug-${ord}${trail} reproducer still red`,
  ].join('\n');

  // ── The same producer, carrying a BARE COMPOUND id (F-032 under F-054) ─────
  // The compound body `[a-z0-9-]*\d` in SUBSTANTIVE_ID_RE exists so that
  // `SEP-B-bf52-001` — whose ordinal is preceded by `bf52-`, not by `sep-` — is
  // protected. Stated plainly, because the deletion moved it: the FIRST-PARTY
  // producer of that id (core/machine.ts:273) renders its whole pending list with
  // a trailing sentence period and comma separators, so no `SEP-` token in a
  // story_advance rejection is ever bare, and none of them is protected any more.
  // The channel that can still deliver a bare compound id is the one that has
  // delivered every leak in this guard: core/machine.ts:1190 embeds RAW test
  // output, and a TAP line naming the proposal a test asserted on is ordinary.
  // That is where the compound body is pinned now, and the case says so.
  const doneTestFailureBareCompoundId = (proposalId: string): string => [
    'Cannot enter DONE: test FAIL: # tests 1',
    '# pass 0',
    '# fail 1',
    `not ok 1 - ${proposalId} was never decided before the freeze check`,
  ].join('\n');

  // ── The real REVIEW checklist-not-done rejection (F-051) ───────────────────
  // core/machine.ts:1169 renders `Cannot enter REVIEW: ${pending.length}
  // checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`, composed
  // here as it renders. With more than one item pending, every id except the
  // last arrives COMMA-ATTACHED — the trailing-punctuation position — and the
  // last arrives at the very end of the reason. Holding the second id constant
  // isolates the comma-attached one.
  const checklistNotDone = (ids: string[]): string =>
    `Cannot enter REVIEW: ${ids.length} checklist item(s) not done: ${ids.join(', ')}`;

  // ── The real excluded-scope-keyword rejection (F-051) ──────────────────────
  // core/machine.ts:202-206: `const source = ... ${issue.itemId ? ` (${issue.itemId})` : ''}`
  // then `Cannot enter INIT_CHECK: excluded scope keyword ${keyword} appears${source}.
  // [excluded_keyword]`, followed by its next-action line. The checklist item id
  // is therefore PARENTHESIZED and the closing paren is followed by the sentence
  // period, so this one render exercises an opening delimiter and a two-character
  // closing run at once. It is the only first-party producer in this tree that
  // wraps an artifact id in punctuation of its own.
  const excludedScopeKeyword = (itemId: string): string =>
    `Cannot enter INIT_CHECK: excluded scope keyword "quantum" appears in checklist (${itemId}). [excluded_keyword]\n` +
    `→ Remove the expansion from the frozen INIT text, or record a scope_extension_proposal and explicit decision before rerunning scope_freeze_check.`;

  // ── The real REVIEW verification-intent rejection (F-051/F-052 cost) ───────
  // core/machine.ts:1173 renders `Cannot enter REVIEW: ${n} required verification
  // intent(s) lack passing evidence or waiver:` plus one `  - ${issue}` line per
  // issue, and core/verification.ts:216 builds each issue as
  // `${e.intentRef} [${e.status}] ${e.desc}` where core/verification.ts:22-24
  // mints intentRef as `${itemId}:${lane}:${index}`.
  //
  // So a checklist ordinal reaches the digest as `CHK-001:happy:0` — an id with a
  // colon-separated LANE SUFFIX welded on. Composed here as it renders, and
  // deliberately placed in the COLLAPSE lane; the case says what that costs. It is
  // the SUFFIX member of the three-form colon-composite cost F-052 makes symmetric.
  const verificationIntentUnmet = (intentRef: string): string =>
    `Cannot enter REVIEW: 1 required verification intent(s) lack passing evidence or waiver:\n` +
    `  - ${intentRef} [missing] the acceptance check has no passing evidence\n` +
    `→ Run verification_evidence_add to record logic/integration/browser/manual evidence, or use waiver to explicitly exempt`;

  // ── The real REVIEW→TEST open-blocking-finding rejection (F-048/F-051) ─────
  // core/machine.ts:753 renders `${blocking.length} open blocking finding(s):
  // ${id} [${severity}] ${desc}` and core/machine.ts:1181 wraps it as
  // `Cannot enter TEST: ${message} [${code}]`. handlers/finding.ts:552 mints the
  // id as `${storyId}:F-${NNN}`, so the finding id arrives as ONE token with the
  // story id welded onto its head — `B-bf52:F-012`.
  //
  // That composite is the render round 10 added an optional `<label>:` QUALIFIER
  // to SUBSTANTIVE_ID_RE to rescue, and F-052 is the measurement that the rescue
  // admitted arbitrary non-ids (`timeout:bug-2`). The qualifier is gone, so under
  // the bare whole-token test this token is not an id and the pair COLLAPSES —
  // not worse than main, which collapses it too, but no better either. It is the
  // PREFIX member of the three-form colon-composite cost. Everything except the
  // finding ordinal is held constant so the case isolates that one position.
  const openBlockingFinding = (findingOrdinal: string): string =>
    `Cannot enter TEST: 1 open blocking finding(s): B-bf52:${findingOrdinal} [high] ` +
    `the substantive-id guard admits a non-id [review_finding_blocking]`;

  // ── The SAME producer with TWO blocking findings (F-051, semicolon) ────────
  // core/machine.ts:756 joins the findings with `'; '`, and `${f.desc}` is
  // reviewer-written free text in which citing the checklist item under review is
  // routine. So an artifact id lands SEMICOLON-ATTACHED at the seam between two
  // findings. The second finding is held constant so the differing token is the
  // semicolon-attached one.
  const twoBlockingFindings = (citedItemId: string): string =>
    `Cannot enter TEST: 2 open blocking finding(s): B-bf52:F-012 [high] no passing evidence for ${citedItemId}; ` +
    `B-bf52:F-013 [high] the second blocker is held constant [review_finding_blocking]`;

  // ── The SAME producer with the cited id in the LAST finding (F-054/F-033) ──
  // core/machine.ts:753-756 renders EVERY open blocking finding, joined by '; ',
  // and core/machine.ts:1181 wraps the whole list as
  // `Cannot enter TEST: ${message} [${code}]`. So the LAST finding's description
  // is followed by a space and the bracketed reason code, and a checklist id cited
  // at the end of that description arrives BARE — the one position in this render
  // that survives the F-054 deletion, and a real one, because `${f.desc}` is
  // reviewer-written free text in which citing the item under review is routine.
  //
  // HOW MANY findings are open is the one realistic parameter, and it is what
  // moves the cited id across the 200-character prefix window: with no other
  // finding open the id lands well inside it, with two the identical id lands
  // outside. That builds both halves of the F-033 residual out of ONE real
  // producer rather than out of a contrived pad, and both halves carry the SAME
  // non-empty signal set (`review_finding_blocking`), so the window — not the
  // signal fold — is what decides. The fixture precondition after the matrix
  // asserts the two character positions rather than assuming them.
  //
  // It replaces the `scopeExtensionPending` pair that carried the residual through
  // round 12: every `SEP-` token in that render is comma- or period-attached, so
  // under the deletion neither of its halves keys apart and the pair could no
  // longer measure the window at all.
  const blockingFindingsCitingLast = (leadingCount: number, citedItemId: string): string => {
    const rows = [];
    for (let i = 0; i < leadingCount; i += 1) {
      rows.push(`B-bf52:F-0${20 + i} [high] a separate blocker that is held constant in this fixture`);
    }
    rows.push(`B-bf52:F-012 [high] no passing verification evidence for ${citedItemId}`);
    return `Cannot enter TEST: ${rows.length} open blocking finding(s): ${rows.join('; ')} [review_finding_blocking]`;
  };

  // ── The real INIT_CHECK reviewer-issue rejection (F-034, and the F-033 pair) ─
  // core/machine.ts:1042-1046, composed as it renders. `${issue.id}` is the
  // reviewer's self-assigned id, whose declared shape is `I-1` (the init_check_set
  // schema in cli/command-catalog.ts) — NOT the `INIT-001` shape minted by
  // handlers/draft-check.ts:81, which ids draft-check issues and is never read by
  // a transition guard. That mix-up is why `init-` used to sit in the allowlist
  // protecting a shape no story_advance rejection can contain.
  //
  // The agentId is a parameter because its LENGTH is what makes this producer
  // straddle the 200-character prefix window, which is how the two F-033 cases
  // below are built from one real message rather than from a contrived pad.
  const initCheckBlockingIssues = (agentId: string, ids: string[]): string => [
    'Cannot enter INIT_CHECK: init-check reviewer recorded high/critical issues; you must fix them and re-run the corresponding reviewer first. [init_check_blocking_issues]',
    ...ids.map((id) => `  - ${agentId}: high ${id} the story boundary is not decidable from the description`),
  ].join('\n');

  // ── The real open-review-loop rejection (F-036) ────────────────────────────
  // core/machine.ts:640-661 builds `active review loop(s): loopId=${loopId}, ...`
  // and core/machine.ts:1192 wraps it as `Cannot enter TEST: ${message} [${code}]`.
  // handlers/review-loop.ts:141 mints the id as `${storyId}:RL-${NNN}`.
  const openReviewLoop = (loopOrdinal: string): string =>
    `Cannot enter TEST: active review loop(s): loopId=B-bf52:${loopOrdinal}, decision=revise, ` +
    `nextAction={phase=DEV, owner=lattice-implementer} [open_review_loop]`;

  // ── The real ProofStory DEV-gate rejection (signals fold) ──────────────────
  // Preamble verbatim from core/machine.ts:179, body in the exact shape
  // renderProofStoryDiagnosticReport emits (core/proofstory.ts:1890-1920), with
  // trigger codes/messages from proofstory.ts:712-743 and gap codes/messages
  // from proofstory.ts:1127-1141. Only the ONE gap line varies, which is what a
  // story clearing one precondition at a time actually produces.
  const proofStoryDevGateBlock = (gapCode: string, gapArtifact: string, gapMessage: string): string => [
    'Cannot enter DEV: ProofStory DEV gate is enforce and required intent artifacts are incomplete.',
    'ProofStory diagnostics for B-bf52',
    'Mode: enforce',
    'Status: fail',
    'Blocking: yes',
    'Hardening level: high_assurance',
    'Ledger: missing, 0/5 milestone threshold (within_threshold)',
    'Trigger reasons (3):',
    '  - high_assurance_risk: High-risk or gate/security wording selects high-assurance intent hardening.',
    '  - collision_required_high_assurance: High-assurance work requires an independent intent-collision result.',
    '  - red_evidence_required: Bug, regression, security/auth/session, benchmark, or explicit behavior-change work should have red evidence.',
    'Diagnostic gaps (1):',
    `  - ${gapCode} [warn; ${gapArtifact}]: ${gapMessage}`,
  ].join('\n');
  const PROOFSTORY_COLLISION_GAP = proofStoryDevGateBlock(
    'missing_intent_collision', 'intent-collision.json',
    'Intent collision is triggered but no pass decision with acceptedInterpretation is present.',
  );
  const PROOFSTORY_RED_GAP = proofStoryDevGateBlock(
    'missing_red_evidence', 'red-evidence.json',
    'Red evidence is triggered but no current red evidence record binds baseline head/material to the correct acceptance target and green relation.',
  );

  // ── The real ProofStory milestone-binding gap (F-051, the `req-` member) ───
  // core/proofstory.ts:1026 renders `${milestone.id} references sourceRequirementId
  // ${milestone.sourceRequirementId}, which is not in original intent
  // keyRequirementIds.` and the DEV gate surfaces it as one diagnostic gap line
  // inside the report above. This is the ONLY story_advance-reachable producer of
  // a `REQ-` ordinal in this tree, which is why it is quoted here — and why the
  // case built from it is in the COLLAPSE lane. See that case for the
  // measurement.
  const proofStoryRequirementGap = (requirementId: string): string => proofStoryDevGateBlock(
    'milestone_source_requirement_unbound', 'milestone-ledger.json',
    `M1 references sourceRequirementId ${requirementId}, which is not in original intent keyRequirementIds.`,
  );

  // ── Fixture PRECONDITIONS, asserted against the REAL normalizer ────────────
  // A matrix case only proves what its fixtures actually exercise. The
  // `bcc54-cross-vendor-noise` case was described (in an earlier draft of this
  // story's evidence) as this story's guard against regressing B-cc54's signals
  // FOLD; it is not, and the test-coverage lane demonstrated it by collapsing
  // `basis` to `prefix` alone, rebuilding, and watching the entire matrix still
  // pass — extractGateBlockSignals returns [] for BOTH noise fixtures, so that
  // case never reaches the fold at all. These assertions exist so the same
  // mistake cannot be made silently again: each fixture pair states, mechanically,
  // WHICH mechanism it is positioned to exercise.
  const norm200 = (s: string): string => normalizeGateReason(s).slice(0, 200);
  {
    // signals fold: identical 200-char normalized prefixes, DIFFERENT non-empty signal sets.
    const sigA = extractGateBlockSignals(normalizeGateReason(PROOFSTORY_COLLISION_GAP));
    const sigB = extractGateBlockSignals(normalizeGateReason(PROOFSTORY_RED_GAP));
    assert.equal(
      norm200(PROOFSTORY_COLLISION_GAP), norm200(PROOFSTORY_RED_GAP),
      'signals-fold fixture: the two DEV-gate rejections must share their first 200 normalized characters, or the case proves nothing about the fold',
    );
    assert.ok(sigA.length > 0 && sigB.length > 0, 'signals-fold fixture: both reasons must extract a NON-EMPTY signal set');
    assert.notDeepEqual(sigA, sigB, 'signals-fold fixture: the two signal sets must differ');
    assert.ok(sigA.includes('missing_intent_collision'), 'signals-fold fixture: gap code A is extracted');
    assert.ok(sigB.includes('missing_red_evidence'), 'signals-fold fixture: gap code B is extracted');
    console.log(
      `  fixture-precondition signals-fold: shared 200-char prefix, signals A=[${sigA.join(',')}] B=[${sigB.join(',')}]`,
    );
  }
  {
    // signal-less long rejection: NO signals on either side, divergence past char 200.
    const a = normalizeGateReason(scopeGateBlock('packages/main/src/core/alpha.ts'));
    const b = normalizeGateReason(scopeGateBlock('packages/main/src/core/beta.ts'));
    assert.deepEqual(extractGateBlockSignals(a), [], 'signal-less fixture: reason A must extract NO signals');
    assert.deepEqual(extractGateBlockSignals(b), [], 'signal-less fixture: reason B must extract NO signals');
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
    assert.ok(i > 200, `signal-less fixture: the two reasons must diverge PAST character 200 (diverged at ${i}) or the 200-char cut was never the cause`);
    console.log(`  fixture-precondition signal-less: no signals on either side, normalized divergence at char ${i} (length ${a.length})`);
  }
  {
    // stale-review-evidence pair: the RR- ordinal is the ONLY difference.
    const a = staleReviewEvidence('RR-002');
    const b = staleReviewEvidence('RR-003');
    assert.equal(a.replace('RR-002', 'RR-00X'), b.replace('RR-003', 'RR-00X'), 'stale-evidence fixture: the pair must differ ONLY in the review-run ordinal');
    console.log('  fixture-precondition stale-evidence: the pair differs only in the RR- ordinal');
  }
  type GuardRule =
    | 'path-rule-overreach'
    | 'path-rule-collapse'
    | 'substantive-id-allowlist'
    // F-032: fails if a substantive id is matched by the prefix immediately
    // before its digit run instead of as a WHOLE TOKEN — the revert under which
    // a COMPOUND id such as `SEP-B-bf52-001` loses its trailing ordinal even
    // though `sep-` is allowlisted. The simple-id cases above do NOT fail under
    // that revert, which is why this tag is separate from the allowlist tag.
    | 'substantive-id-whole-token'
    // ── the F-051 shape change: four tags replacing three boundary-era ones ──
    //
    // The three tags this family replaces (`substantive-id-token-start`,
    // `…-token-start-overstrict`, `…-token-end`) named the halves of a BOUNDARY
    // ASSERTION around the id, and that assertion leaked four times to four
    // different punctuation characters. The guard is now a WHOLE-TOKEN TEST —
    // `SUBSTANTIVE_ID_RE`, anchored `^…$`, applied to one whitespace-delimited
    // token EXACTLY AS IT ARRIVES (F-054 deleted the punctuation reduction that
    // ran in front of it) — so the reverts worth naming are the parts of THAT,
    // and the old tags are deleted rather than renamed, because a tag that
    // outlives its rule attests to a guard nobody has.
    //
    // Fails if the HEAD anchor `^` is dropped, i.e. if the id is allowed to be
    // found anywhere inside the token again. That is precisely the revert under
    // which every head-welded shape comes back: `de-bug-2` (F-043),
    // `scenario/bug-2` (F-048 a), `suite_bug-2`, `over-req-3`.
    | 'substantive-id-token-head-exact'
    // Fails if the TAIL anchor `$` is dropped. That is the F-051 revert: with
    // the tail unanchored the substring `bug-2` inside `bug-2/x`, `bug-2.x`,
    // `bug-2-x`, `bug-2é` and `bug-2x` is protected as though the label were an
    // id. It is a SEPARATE mutation from the head anchor and it has its own
    // cases, because rounds 7-9 fixed the head three times while leaving this
    // end open.
    | 'substantive-id-token-tail-exact'
    // Fails if `(?!(?:<stems>)-)` is dropped, under which the doubled prefix
    // `BUG-BUG-2` is protected (F-048 b). Retained from the previous revision
    // and now standing alone, because it is a statement about the id's own
    // shape rather than about its surroundings — the one part of the old guard
    // that was never a boundary assertion.
    | 'substantive-id-doubled-prefix'
    // F-052, THE ACCEPTED COST, named as a cost rather than as a guard.
    //
    // Round 10 carried an optional `<label>:` QUALIFIER — `(?:[a-z0-9-]+:)?` — in
    // front of the stem, added to rescue the composite render `B-bf52:F-012`.
    // Cross-host codex measured what it actually admitted: ANY label, so
    // `timeout:bug-2` and `timeout:bug-5` in the raw test output
    // core/machine.ts:1190 embeds keyed APART on that branch while main collapses
    // them. It was an unbounded enumeration re-introduced inside a form whose
    // entire justification was having no enumeration left to leak, so it was
    // DELETED and the whole-token test now has zero interior structure.
    //
    // Deleting it costs every colon-joined composite symmetrically, which is why
    // ONE tag covers all three of them: the branch now TIES with main on the real
    // PREFIX composite (`B-bf52:F-012`, handlers/finding.ts:552), on the real
    // SUFFIX composite (`CHK-001:happy:0`, core/verification.ts:22-24) and on the
    // forged one, instead of beating main on the first two while leaking on the
    // third.
    //
    // A case carrying this tag fails if ANY interior `:` structure is re-admitted
    // to SUBSTANTIVE_ID_RE — a leading `(?:[a-z0-9-]+:)?` or `(?:[a-z0-9-]+:)*`
    // for the prefix forms, a trailing `(?::[a-z0-9-]+)*` for the suffix form. So
    // the three cases are simultaneously the record of what the deletion costs and
    // the standing guard against paying it back.
    | 'substantive-id-colon-composite-cost'
    // ── the F-054 deletion: ONE tag replacing three ────────────────────────
    //
    // The three tags this family replaces (`substantive-id-wrapper-pair-strip`,
    // `…-sentence-punct-strip`, `…-balanced-wrapper-strip`) named the parts of a
    // REDUCTION that ran in front of the whole-token test: trailing `[,;:.!?]+$`
    // removed unconditionally, then matched wrapper pairs peeled one at a time.
    // Those tags are DELETED rather than renamed, because the rule they named is
    // gone and a tag that outlives its rule attests to a guard nobody has.
    //
    // WHY THE REDUCTION WENT AWAY INSTEAD OF BEING FIXED AGAIN. Seven rounds of
    // this guard were broken in the same place, and every break was in the step
    // that REDUCES a token before testing it: `\b`, then `(?<![\w-])`, then the
    // trailing `\b`, then the optional `<label>:` qualifier, then the unmatched
    // wrapper, and finally (F-054) the unconditional trailing sentence-punctuation
    // strip, which turns the arbitrary TAP subtest name `bug-2:` into `bug-2`, so
    // `not ok 1 - bug-2: reproducer still red` and its `bug-5:` sibling digest
    // APART here while main collapses them. Enumerating SAFER punctuation does not
    // close that class: the identical manufacture works with a trailing comma in a
    // list of test names, and core/machine.ts:1190 embeds raw third-party output,
    // which can place any punctuation character against any name. So the reduction
    // is deleted outright and the class is closed BY CONSTRUCTION — with no
    // reduction there is no step in which a non-id can become an id — rather than
    // by getting the character set right on the seventh attempt.
    //
    // A case carrying this tag fails if ANY reduction is re-introduced in front of
    // SUBSTANTIVE_ID_RE: a trailing punctuation strip in any character set, a
    // wrapper peel balanced or not, the independent-run form of rounds 9-11, or a
    // `<label>:` qualifier. Its cases are therefore also THE RECORD OF WHAT THE
    // DELETION COSTS — every one of them is a shape that WAS protected in round 12
    // and now ties with main — which is why they sit in the must-still-collapse
    // lane rather than being described only in prose. The different reductions fail
    // different SUBSETS of them, and the section header states which, measured.
    | 'substantive-id-no-reduction'
    | 'allowlist-boundedness'
    // F-033, the ACCEPTED residual: fails if the 200-character prefix cut on the
    // signals branch is WIDENED. It is the direction B-cc54's
    // CHK-002:adversarial:1 also depends on, and it is the case that documents
    // where this branch stops being better than main (it never becomes worse).
    | 'prefix-window-residual'
    | 'digit-rule-collapse'
    // Volatile timestamps must collapse. Measured: the ISO rule and the bare-digit
    // rule are redundant for a pure-digit timestamp, so this fails only when BOTH
    // are deleted — it is a disjunction, not a single-rule guard, and the tag says
    // so rather than overclaiming.
    | 'iso-or-digit-rule-collapse'
    | 'hex-rule-collapse'
    // F-031: fails if the signals-conditional prefix is reverted to an
    // unconditional 200-char cut (the signal-less pair then collapses).
    | 'signals-conditional-prefix'
    // Test-coverage lane: fails if the (prefix, signals) fold is collapsed to
    // `prefix` alone — the ONLY case that genuinely exercises B-cc54's C1
    // mechanism from inside this suite (the noise pair does not).
    | 'signals-fold'
    // F-030 / F-036 / F-044: the inverse-risk DIRECTION. An id that a retry
    // RE-MINTS must keep collapsing, or a host that repeats the remediation the
    // rejection prints mints a fresh key every attempt and the breaker never trips
    // on an unbounded loop (review_run_start for `rr-`, "re-run the corresponding
    // reviewer" for `i-`, opening another loop for `rl-`).
    //
    // MEASURED CAVEAT, F-052 round 11 — and this tag is now weaker than its name
    // suggests, so the weakening is stated instead of implied. Of the three cases
    // carrying it, only ONE is a standing single-mutation guard on the allowlist:
    //
    //   init-check-issue-ordinal   REAL guard. `  - product-reviewer: high I-1 …`
    //                              renders the id BARE, so `i-` alone fails it.
    //   stale-review-run-evidence  DIRECTION only, as of round 11. core/review-run.ts
    //                              renders `bound reviewRunId B-bf52:RR-002`, a
    //                              COLON composite; with the F-052 qualifier gone
    //                              that token is not an id whether or not `rr-` is
    //                              allowlisted, and `rr-` alone now fails NOTHING
    //                              (it failed this case in round 10). Measured
    //                              compositely: `rr-` allowlisted AND the qualifier
    //                              re-added is what fails it.
    //   review-loop-ordinal        DIRECTION only, since round 10. core/machine.ts:646
    //                              renders `loopId=B-bf52:RL-001,` — welded behind an
    //                              `=` AND terminated by a comma — so `rl-` alone
    //                              fails nothing. RE-MEASURED IN ROUND 13, and the
    //                              composite GREW: `rl-` allowlisted AND the id-head
    //                              anchor dropped no longer fails it either, because
    //                              the trailing comma is no longer removed. It takes
    //                              THREE simultaneous mutations — `rl-` allowlisted,
    //                              head anchor dropped, sentence strip restored — to
    //                              reach this case, which is no guard at all, and the
    //                              row is quoted that way rather than rounded down.
    //
    // This is a real cost of the F-052 and F-054 deletions and it is recorded as one:
    // two of the three exclusions lost their single-mutation test. Buying them back means
    // re-admitting interior `:` structure, which is the leak itself, so the
    // exclusions keep standing on their own reasoning (a review run and a review
    // loop are both re-minted on retry) and on the completeness guard in section 7c,
    // which still requires `rr-`/`rp-`/`rl-`/`i-` to be CLASSIFIED. The two
    // assertions remain TRUE and worth pinning — they are what the code does at real
    // render sites — they are simply no longer what would catch a re-add.
    | 'review-bookkeeping-not-allowlisted';
  interface DigestCase { name: string; a: string; b: string; guardedBy: GuardRule }

  const MUST_DIFFER: DigestCase[] = [
    {
      // C2. Depends on the path rule being NARROW (token-start anchored), not on
      // it existing: deleting the rule leaves this pair passing.
      name: 'phase-pair',
      guardedBy: 'path-rule-overreach',
      a: 'transition refused: phase DEV/REVIEW is blocked by an unmet gate',
      b: 'transition refused: phase DEV/TEST is blocked by an unmet gate',
    },
    {
      // C4: main's rule was greedy from the FIRST slash, so both of these became
      // `src#` and two different out-of-contract files counted as one violation
      // repeated.
      name: 'in-repo-file-path',
      guardedBy: 'path-rule-overreach',
      a: 'scope violation: story touched src/core/alpha.ts outside its contract',
      b: 'scope violation: story touched src/core/beta.ts outside its contract',
    },
    {
      // C3, the headline class: under `/\d+/g` both became `chk-#`, so clearing
      // CHK-001 and then tripping on CHK-002 read as one gate failing twice.
      // This and the two below fail if the digit rule is reverted to `/\d+/g` or
      // the allowlist is emptied; DELETING the digit rule leaves them passing,
      // which is why they carry the `-overreach`-direction tag and the collapse
      // lane carries `digit-rule-collapse` on the same rule.
      name: 'checklist-ordinal',
      guardedBy: 'substantive-id-allowlist',
      a: 'verification gap: missing evidence coverage for CHK-001',
      b: 'verification gap: missing evidence coverage for CHK-002',
    },
    {
      // F-051. The same class with the id as the FIRST token of the reason, so
      // there is no preceding character at all. Under the token walk that is not
      // a special position — the first token is a token — but it WAS a special
      // position under every boundary-era guard (each of them carried an
      // explicit `^` alternative), and dropping it silently would have been
      // invisible. This case is what makes string-start a measured property
      // rather than an assumed one.
      name: 'checklist-ordinal-at-reason-start',
      guardedBy: 'substantive-id-allowlist',
      a: 'CHK-001 has no passing verification evidence and no waiver [verification_evidence_missing]',
      b: 'CHK-002 has no passing verification evidence and no waiver [verification_evidence_missing]',
    },
    {
      // Two different open findings. A reviewer round that resolves F-012 and
      // then blocks on F-013 is progress, not a repeat.
      //
      // F-052: this case is ALSO what BOUNDS the colon-composite cost, and it is
      // deliberately the same artifact kind as the case that pays it. Deleting the
      // qualifier makes `B-bf52:F-012` collapse
      // (`open-blocking-finding-composite-id`, collapse lane); a BARE `F-012` in
      // ordinary delimiter position is unaffected and still keys apart. Without
      // this pair the honest reading of the deletion would be "finding ordinals
      // stopped mattering", which is not what was measured. The same bound is
      // asserted for checklist ids by `checklist-ordinal` and its
      // punctuation-position siblings; this is the finding-id half of it.
      name: 'finding-ordinal',
      guardedBy: 'substantive-id-allowlist',
      a: 'review blocker: finding F-012 is still open and unresolved',
      b: 'review blocker: finding F-013 is still open and unresolved',
    },
    {
      // Two different open bugs (F-029). The producer is core/machine.ts:1195,
      // `Cannot enter DONE: ${n} unfixed bug(s): ${ids}`, quoted here as it
      // renders. Under `/\d+/g` both became `bug-#`, so fixing BUG-001 and then
      // being blocked by BUG-002 — substantive progress — read as one gate
      // failing twice. `BUG-` was MISSING from the first draft of the allowlist,
      // which is why section 7c now reconciles the allowlist against the
      // artifact-id prefixes production source actually emits.
      name: 'unfixed-bug-ordinal',
      guardedBy: 'substantive-id-allowlist',
      a: 'Cannot enter DONE: 1 unfixed bug(s): BUG-001',
      b: 'Cannot enter DONE: 1 unfixed bug(s): BUG-002',
    },
    {
      // F-051, the LAST id of a real list render — and, after F-054, the position
      // that carries the checklist class. core/machine.ts:1169 joins the pending
      // ids with `, ` and adds NO trailing period, so the last id in the list is
      // the whole token while every earlier one is comma-attached. The FIRST id is
      // held constant so the differing token is the bare one.
      //
      // It is the real-producer twin of `checklist-ordinal` above (whose reason
      // text is illustrative rather than quoted), and it is the must-differ half of
      // `checklist-not-done-comma-list` in the collapse lane: the same producer,
      // the same two ids, differing only in WHICH list position varies. Read
      // together the two cases say exactly what the deletion costs and what it
      // keeps.
      name: 'checklist-not-done-final-bare-id',
      guardedBy: 'substantive-id-allowlist',
      a: checklistNotDone(['CHK-009', 'CHK-001']),
      b: checklistNotDone(['CHK-009', 'CHK-002']),
    },
    {
      // F-032 under F-054. `SEP-B-bf52-001` is a COMPOUND id: its ordinal is
      // preceded by `bf52-`, not by `sep-`, so the mechanism that inspected the
      // single prefix in front of a digit run left it unprotected — allowlisting
      // `sep-` changed nothing and the two proposals still shared a key.
      //
      // This case is the ONLY one that fails when the whole-token BODY is reverted
      // to prefix-before-digits (`\d+`) while the allowlist itself is left intact,
      // which is what makes it the single-rule guard on that mechanism.
      //
      // WHY IT IS BUILT FROM EMBEDDED TEST OUTPUT AND NOT FROM THE `SEP-` PRODUCER,
      // stated rather than quietly swapped: through round 12 this case used
      // core/machine.ts:273's pending-proposal render, which was protected only
      // because a punctuation strip removed the list comma or the sentence period
      // first. That strip is deleted (F-054), so no `SEP-` token in that rejection
      // is the whole token and the pair now collapses — it is a
      // `substantive-id-no-reduction` cost case in the other lane. The channel that
      // still delivers a BARE compound id is core/machine.ts:1190's raw test
      // output, the same channel every leak in this guard was found in, and a TAP
      // line naming the proposal under test is ordinary there.
      name: 'embedded-test-output-bare-compound-id',
      guardedBy: 'substantive-id-whole-token',
      a: doneTestFailureBareCompoundId('SEP-B-bf52-001'),
      b: doneTestFailureBareCompoundId('SEP-B-bf52-002'),
    },
    {
      // F-033, the WITHIN-window half of the accepted residual, rebuilt on a
      // producer whose id survives the F-054 deletion.
      //
      // core/machine.ts:753-756 renders every open blocking finding and :1181
      // appends the bracketed reason code, so a checklist id cited at the end of
      // the LAST finding's description is followed by a space and is therefore the
      // whole token. With no other finding open it lands at normalized character
      // ~107, well inside the 200-character prefix cut, and the pair keys apart.
      // Its past-window twin (`blocking-finding-cited-id-past-window`, the SAME
      // producer with two more findings open) is where that stops being true; the
      // fixture precondition after the matrix asserts both character positions.
      name: 'blocking-finding-cited-id-within-window',
      guardedBy: 'substantive-id-allowlist',
      a: blockingFindingsCitingLast(0, 'CHK-001'),
      b: blockingFindingsCitingLast(0, 'CHK-002'),
    },
    {
      // F-031 / CHK-001: a SIGNAL-LESS rejection that is byte-identical for its
      // first 200 normalized characters and only then names the offending path.
      // The body is the real scope-gate advice (nextActionForViolation in
      // core/scope-contract.ts) and carries no bracketed reason code, no bulleted
      // snake_case gap id and no missing_/invalid_/stale_ token, so
      // extractGateBlockSignals returns NOTHING and B-cc54's structural mechanism
      // supplies no distinctness at all — the 200-character cut alone decided the
      // key, and two different out-of-contract paths collapsed onto it.
      //
      // This case fails if the truncation is reverted to an unconditional
      // `slice(0, 200)`. It is the INVERSE revert of B-cc54's
      // CHK-002:adversarial:1, which requires the signals branch to KEEP the cut,
      // so the two together pin the conditional in both directions.
      //
      // Localization caveat, measured: the two variants differ only in a
      // repo-relative PATH, so reverting the path rule to main's slash-anywhere
      // form also fails this case (both sides become `packages#`). It therefore
      // fails alone only when the signals-conditional prefix regresses; when it
      // fails together with the `path-rule-overreach` group, the path rule is the
      // cause. The grouped failure report prints exactly that distinction.
      name: 'signal-less-long-rejection',
      guardedBy: 'signals-conditional-prefix',
      a: scopeGateBlock('packages/main/src/core/alpha.ts'),
      b: scopeGateBlock('packages/main/src/core/beta.ts'),
    },
    {
      // B-cc54's C1 mechanism, exercised for real. Both reasons carry signals and
      // share their first 200 normalized characters (asserted above as a fixture
      // precondition), so the 200-char prefix is IDENTICAL and ONLY the folded
      // signal set can tell them apart: this case fails the moment `basis`
      // collapses to `prefix` alone.
      //
      // It exists because the test-coverage lane disproved the claim that
      // `bcc54-cross-vendor-noise` guarded this — that pair extracts an EMPTY
      // signal set on both sides, so it never reaches the fold, and the whole
      // matrix stayed green while the fold was disabled. A story clearing
      // missing_intent_collision and then tripping on missing_red_evidence is the
      // real sequence (it is what B-cc54 itself hit), and reading it as one gate
      // failing twice is the false freeze both stories exist to kill.
      name: 'proofstory-gap-signal-set',
      guardedBy: 'signals-fold',
      a: PROOFSTORY_COLLISION_GAP,
      b: PROOFSTORY_RED_GAP,
    },
  ];

  const MUST_COLLAPSE: DigestCase[] = [
    {
      name: 'machine-absolute-path',
      guardedBy: 'path-rule-collapse',
      a: 'validation lock held at /Users/jek/Documents/Work/proofbound/.lattice/locks/validate',
      b: 'validation lock held at /private/var/folders/zz/T/lattice-abc/.lattice/locks/validate',
    },
    {
      // A machine-specific root that continues into repo-relative segments must
      // be normalized in ONE match, leaving no per-host remainder behind.
      name: 'machine-path-into-repo-relative-segments',
      guardedBy: 'path-rule-collapse',
      a: 'ENOENT reading "/Users/jek/Documents/Work/proofbound/packages/main/src/core/machine.ts"',
      b: 'ENOENT reading "/private/var/folders/zz/T/wt-9c1/packages/main/src/core/machine.ts"',
    },
    {
      // A path introduced by `=` (or `:` / `,`) with no separating space is
      // still a machine-specific path. This is the case that forces the
      // narrowed rule to keep its delimiter lookbehind rather than anchoring
      // only at whitespace.
      name: 'delimiter-attached-absolute-path',
      guardedBy: 'path-rule-collapse',
      a: 'story lock cwd=/Users/jek/Documents/Work/proofbound/.worktrees/B-bf52 is held elsewhere',
      b: 'story lock cwd=/private/var/folders/zz/T/wt-9c1/.worktrees/B-bf52 is held elsewhere',
    },
    {
      // B-cc54 CHK-001:adversarial:0, verbatim. It additionally depends on the
      // path, ISO and hex rules, each of which has its own single-rule case in
      // this lane; a failure HERE unaccompanied by a failure in those therefore
      // still localizes to the digit rule.
      name: 'bcc54-cross-vendor-noise',
      guardedBy: 'digit-rule-collapse',
      a: CC54_NOISE_A,
      b: CC54_NOISE_B,
    },
    {
      // B-cc54 CHK-002:adversarial:2, verbatim, and the reason the digit rule is
      // an allowlist rather than a syntactic test: `b-1234` is identifier-attached
      // exactly as `CHK-001` is, yet must COLLAPSE. It fails the moment `b-` (or
      // any other non-artifact prefix) is added to SUBSTANTIVE_ID_PREFIXES, which
      // is the inverse revert of the three must-differ ordinal cases.
      name: 'bcc54-story-id-digits',
      guardedBy: 'allowlist-boundedness',
      a: CC54_STORY_A,
      b: CC54_STORY_B,
    },
    {
      // F-030, the inverse-risk guard. This case PREVIOUSLY lived in the
      // must-differ lane as `review-run-ordinal`, asserting that two stale-
      // evidence rejections differing only in their RR- ordinal must key
      // DIFFERENTLY — i.e. it asserted the UNSAFE direction as desired. Cross-host
      // codex (round 5) showed why that is wrong: "review evidence ... bound
      // reviewRunId B-bf52:RR-002 is stale" is NOT repaired by starting another
      // reviewer run (staleMaterialHint says the fix is to return to DEV), so if
      // RR-002 and RR-003 keyed apart, a host repeating review_run_start then
      // story_advance would mint a fresh key on every attempt and the breaker
      // would never trip on that unbounded loop. `rr-`/`rp-` were therefore
      // REMOVED from SUBSTANTIVE_ID_PREFIXES, and this pair must COLLAPSE so the
      // retry accumulates and the breaker still fires.
      //
      // WHAT THIS CASE NO LONGER PROVES (F-052 round 11, measured — the same
      // correction `review-loop-ordinal` already carries). It used to fail the
      // moment `rr-` or `rp-` was re-added. It does not any more: core/review-run.ts
      // renders the id as `bound reviewRunId B-bf52:RR-002`, a COLON composite, and
      // with the round-10 qualifier deleted that token is not an id whether or not
      // its prefix is allowlisted. Measured directly, and RE-MEASURED FROM SCRATCH
      // in round 12 rather than carried forward: `rr-` alone fails NOTHING, `rp-`
      // alone fails NOTHING; `rr-` allowlisted AND the qualifier re-added is what
      // fails this case (together with the two colon-composite cases the qualifier
      // alone already fails). The assertion below is still TRUE and still worth
      // pinning — it is what the code does at a real render site — but the allowlist
      // exclusion it was built to guard now rests on its reasoning and on the
      // section 7c completeness guard rather than on this case.
      name: 'stale-review-run-evidence',
      guardedBy: 'review-bookkeeping-not-allowlisted',
      a: staleReviewEvidence('RR-002'),
      b: staleReviewEvidence('RR-003'),
    },
    {
      // F-036, and the SAME risk as `rr-`/`rp-` above. `Cannot enter TEST: active
      // review loop(s): loopId=B-bf52:RL-001 …` is a real story_advance rejection
      // and `RL-` is really minted with an ordinal, so the earlier justification
      // for excluding it ("no gate-reachable producer") was simply FALSE. The
      // DIRECTION is still right, for the honest reason: a review loop is re-minted
      // on retry exactly as a review run is, so a host that closes one loop, opens
      // another and retries would mint a fresh key every time and the breaker would
      // never trip.
      //
      // The cost of collapsing is real and accepted: two loops opened for genuinely
      // DIFFERENT triggers share one key, so clearing one and being blocked by the
      // next reads as a repeat. For a circuit breaker that is the fail-safe error —
      // it fires early — whereas the opposite error lets an unbounded retry loop run
      // forever, which is the failure this module exists to stop.
      //
      // WHAT THIS CASE NO LONGER PROVES (F-051 round 10, measured). It used to fail
      // the moment `rl-` was added to the allowlist. It does not any more, and the
      // reason is the shape change: core/machine.ts:646 builds the id as
      // `loopId=${loopId}`, so the token reaching the digest is
      // `loopid=b-bf52:rl-001,` — an id WELDED behind an `=`, which is not wrapping
      // punctuation. The whole-token rule therefore refuses it for the same reason
      // it refuses `bug-2/x`, and it would refuse it with `rl-` allowlisted too.
      // Mutation testing confirms, re-measured from scratch in round 12: `rl-`
      // alone fails nothing here; `rl-` plus a dropped id-head anchor is what fails
      // this case (together with the seven cases the head anchor alone already
      // fails, four of them head-welded and two of them F-053 unmatched wrappers,
      // which is why the composite is quoted with its whole failure set rather than
      // only its interesting name). The assertion below is
      // still TRUE and still worth pinning — it is what the code does at a real
      // render site — but the tag's own comment now says which revert it does and
      // does not catch.
      name: 'review-loop-ordinal',
      guardedBy: 'review-bookkeeping-not-allowlisted',
      a: openReviewLoop('RL-001'),
      b: openReviewLoop('RL-002'),
    },
    {
      // F-044, the inverse-risk guard on `i-`, and the SAME class as `rr-`/`rp-`/
      // `rl-` above. Two INIT_CHECK reviewer issues whose ids differ.
      //
      // An earlier round of this story had this pair in the MUST-DIFFER lane, on
      // the strength of the render site being real — core/machine.ts:1044 does
      // interpolate `${issue.id}`. But a real render site was never the criterion;
      // SURVIVING THE RETRY is. `I-N` fails that on all three counts at once:
      // cli/command-catalog.ts:2315 declares `issue.id` OPTIONAL and reviewer-self-
      // assigned free text, handlers/init-check.ts:139-142 drops the calling agent's
      // previous record and rewrites its issues wholesale on every init_check_set,
      // and the remediation this very rejection prints — "re-run the corresponding
      // reviewer" — is the action that renumbers them. A reviewer re-run that
      // reports the SAME unfixed problem as `I-2` instead of `I-1` would therefore
      // mint a fresh key on every attempt, which is the unbounded retry loop this
      // module exists to stop. `i-` was removed from the allowlist and this pair
      // must now COLLAPSE; it fails the moment `i-` is re-added (re-measured from
      // scratch in round 12: `i-` ALONE still fails exactly this case).
      //
      // As of F-052 this is the ONLY case on the `review-bookkeeping-not-allowlisted`
      // tag that is still a single-mutation guard, and the reason is a property of
      // the render rather than of the id: `  - product-reviewer: high I-1 …` puts the
      // id in the reason BARE, while every RR-/RP-/RL- producer welds its id behind
      // a `:` or an `=`. See the tag's declaration for the two that lost their guard.
      //
      // Bookkeeping, not a durable artifact id: the thing the operator must FIX is
      // the story boundary described in the issue text, which is what still
      // separates two genuinely different init-check blockers.
      name: 'init-check-issue-ordinal',
      guardedBy: 'review-bookkeeping-not-allowlisted',
      a: initCheckBlockingIssues('product-reviewer', ['I-1']),
      b: initCheckBlockingIssues('product-reviewer', ['I-2']),
    },
    {
      // F-043, the direction in which this story was WORSE THAN MAIN, pinned so it
      // cannot come back. Real producer: core/machine.ts:1190 embeds the raw test
      // output in `Cannot enter DONE: test FAIL: …`, so ordinary hyphenated
      // test-case names reach the digest. `scenario-f-2`, `de-bug-2` and
      // `over-req-3` are NOT artifact ids, but under a `\b` leading guard each one
      // matched from its interior seam (a hyphen is a non-word character, so it
      // MAKES the boundary `\b` wants) and was protected as though it were.
      //
      // Two runs of the same red suite then keyed apart on nothing but the embedded
      // ordinals, the repeat never accumulated, and the brake never fired — while
      // main, whose `/\d+/g` rewrites every ordinal, collapsed them correctly.
      //
      // Under the whole-token rule none of the three is a candidate at all, because
      // none of them IS the token. Measured revert: this pair fails when the HEAD
      // anchor `^` is dropped from SUBSTANTIVE_ID_RE, i.e. when the id is allowed to
      // be found somewhere inside a token again — which is what every boundary
      // assertion in rounds 7-9 permitted.
      name: 'embedded-test-output-hyphen-compounds',
      guardedBy: 'substantive-id-token-head-exact',
      a: doneTestFailure('f-2', 'bug-2', 'req-3'),
      b: doneTestFailure('f-5', 'bug-7', 'req-9'),
    },
    {
      // F-048 (a), the SLASH-JOINED shape, and the one that made the leak
      // routine rather than theoretical. Same producer as the case above —
      // core/machine.ts:1190 embeds RAW test output — but the ordinal is welded
      // into a PATH SEGMENT (`scenario/bug-2`, `suite/req-2`,
      // `tests/red/scenario/bug-2.test.ts`). A slash is neither a word character
      // nor a hyphen, so `(?<![\w-])` admitted every one of them and two runs of
      // the SAME failing suite keyed apart on nothing but the embedded number;
      // main collapses them. Slash-separated test names are ordinary output, so
      // this was the shape most likely to be hit in practice.
      //
      // Measured revert: fails when the HEAD anchor `^` is dropped from
      // SUBSTANTIVE_ID_RE — the same single mutation that brings back the
      // hyphen-compound case above, since both are head-welded shapes.
      name: 'embedded-test-output-slash-joined-names',
      guardedBy: 'substantive-id-token-head-exact',
      a: doneTestFailureSlashName('2'),
      b: doneTestFailureSlashName('5'),
    },
    {
      // F-048 (b), the DOUBLED-PREFIX shape. Same producer again. When the guard
      // searched for an id inside the token it started at the FIRST allowlisted
      // stem it found, so `BUG-BUG-2` presented one at a position the negative
      // lookbehind was happy with and the label was protected as though the whole
      // thing were an artifact id. It is not one — no producer mints `BUG-BUG-N` —
      // and main collapses it.
      //
      // It keeps its own case because the `(?!(?:<stems>)-)` lookahead is the one
      // part of the old guard that was never a boundary assertion: it is a
      // statement about the id's own shape, and it survives the shape change
      // unchanged. Measured: dropping the lookahead fails this case and nothing
      // else; dropping the HEAD anchor fails it too, along with the other
      // head-welded cases.
      name: 'embedded-test-output-doubled-prefix',
      guardedBy: 'substantive-id-doubled-prefix',
      a: doneTestFailureDoubledPrefix('2'),
      b: doneTestFailureDoubledPrefix('5'),
    },
    {
      // The TOKEN-END group (F-051), five welded tails from one producer, one
      // case each. Rounds 7-9 fixed the HEAD of the token three times and left
      // the TAIL as a `\b` assertion, which succeeds between a digit and any
      // non-word character — so four of these five leaked, and cross-host codex
      // measured all four as WORSE THAN MAIN.
      //
      // Only `bug-2x` was refused, and only because a letter is a word
      // character. It is kept here, first, as the case that was already true, so
      // the group reads as what it is: one shape covered and four missed by an
      // enumeration.
      name: 'embedded-test-output-digit-letter-tail',
      guardedBy: 'substantive-id-token-tail-exact',
      a: doneTestFailureWeldedTail('2', 'x'),
      b: doneTestFailureWeldedTail('5', 'x'),
    },
    {
      // F-051 (a). A SLASH after the ordinal — the shape the finding named
      // first, and the likeliest in practice: `bug-2/x` is an ordinary
      // subtest path in TAP output, and core/machine.ts:1190 embeds that output
      // raw.
      name: 'embedded-test-output-slash-welded-tail',
      guardedBy: 'substantive-id-token-tail-exact',
      a: doneTestFailureWeldedTail('2', '/x'),
      b: doneTestFailureWeldedTail('5', '/x'),
    },
    {
      // F-051 (b). A DOT after the ordinal — a file extension or a dotted test
      // name.
      name: 'embedded-test-output-dot-welded-tail',
      guardedBy: 'substantive-id-token-tail-exact',
      a: doneTestFailureWeldedTail('2', '.x'),
      b: doneTestFailureWeldedTail('5', '.x'),
    },
    {
      // F-051 (c). A HYPHEN after the ordinal. This one is the sharpest
      // illustration of why a boundary assertion was the wrong shape: the
      // hyphen-JOINED head (`de-bug-2`) had already been fixed twice, and the
      // identical character on the other side of the ordinal was still open.
      name: 'embedded-test-output-hyphen-welded-tail',
      guardedBy: 'substantive-id-token-tail-exact',
      a: doneTestFailureWeldedTail('2', '-x'),
      b: doneTestFailureWeldedTail('5', '-x'),
    },
    {
      // F-051 (d). A NON-ASCII letter after the ordinal. `\b` is defined on
      // `[A-Za-z0-9_]`, so `é` is a non-word character and the boundary
      // succeeded in front of it — the same leak as the punctuation shapes,
      // reached through a letter. It is the case that shows the enumeration
      // could never have been completed by listing punctuation, because the
      // leaking character class was not punctuation at all.
      name: 'embedded-test-output-non-ascii-welded-tail',
      guardedBy: 'substantive-id-token-tail-exact',
      a: doneTestFailureWeldedTail('2', 'é'),
      b: doneTestFailureWeldedTail('5', 'é'),
    },
    // ── F-053/F-054: the NO-REDUCTION group, and what the deletion costs ──────
    //
    // Every case in this group is a token with punctuation ATTACHED to an artifact
    // id. Through round 12 a reduction ran in front of the whole-token test and
    // some of these were protected while others leaked; the reduction is deleted
    // (F-054), so ALL of them collapse and this group is simultaneously:
    //
    //   the GUARD   — re-introducing any reduction (a trailing punctuation strip
    //                 in any character set, a wrapper peel balanced or not, the
    //                 independent-run form of rounds 9-11, a `<label>:` qualifier)
    //                 makes some subset of these pairs key APART again, which is
    //                 the worse-than-main direction: `bug-2:` and `bug-5:` are
    //                 arbitrary TAP subtest names that main collapses, and a retry
    //                 loop whose embedded output carries one would mint a fresh key
    //                 on every attempt and never trip the breaker;
    //   the COST    — the first seven cases were MUST-DIFFER cases in round 12,
    //                 protected by that reduction. They are re-decided to collapse
    //                 and moved here rather than deleted, so the price of closing
    //                 the class is visible in the matrix instead of only in prose.
    //                 On all of them this branch now TIES with main (main's
    //                 `/\d+/g` collapses them too); it is never worse.
    //
    // The bound on that cost is the must-differ lane: a BARE id — the whole
    // whitespace-delimited token — is still protected in every position, including
    // the LAST id of the real checklist list render and a cited id in front of the
    // bracketed reason code.
    {
      // THE COST (was must-differ in round 12). core/machine.ts:202-206 renders
      // `… appears in checklist (CHK-001). [excluded_keyword]` — the only
      // first-party producer in this tree that wraps an artifact id in punctuation
      // of its own. The token is `(chk-001).`, which is not an id, so two different
      // checklist items carrying an excluded keyword now share one key.
      name: 'excluded-keyword-parenthesized-item-id',
      guardedBy: 'substantive-id-no-reduction',
      a: excludedScopeKeyword('CHK-001'),
      b: excludedScopeKeyword('CHK-002'),
    },
    {
      // THE COST (was must-differ in round 12). The BRACKETED and QUOTED positions
      // in the embedded-test-output channel. Both were balanced pairs the round-12
      // peel removed.
      name: 'embedded-test-output-bracketed-and-quoted-id',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailureWrappedItemId('CHK-001'),
      b: doneTestFailureWrappedItemId('CHK-002'),
    },
    {
      // THE COST (was must-differ in round 12). A BALANCED paren pair, `(bug-2)`.
      // It is kept as a case, rather than dropped as "just another wrapper",
      // because it is the byte-for-byte twin of the unmatched shapes below: read
      // together they show the rule no longer turns on BALANCE at all — it turns on
      // whether anything is attached.
      name: 'embedded-test-output-balanced-paren-wrapped-id',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '(', ')'),
      b: doneTestFailurePunctuated('5', '(', ')'),
    },
    {
      // THE COST (was must-differ in round 12). A balanced pair followed by a list
      // comma, `(bug-2),` — the shape that used to pin the ORDER of the two strip
      // steps. There is no order left to pin, and the case says so by collapsing.
      name: 'embedded-test-output-balanced-wrapper-then-sentence-punct',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '(', '),'),
      b: doneTestFailurePunctuated('5', '(', '),'),
    },
    {
      // THE COST (was must-differ in round 12). The COMMA-attached position from
      // the real producer at core/machine.ts:1169: with two items pending the
      // first id renders as `CHK-001,`. Its must-differ twin
      // `checklist-not-done-final-bare-id` varies the LAST id of the same list
      // instead, which has no comma and is still protected — the two cases are the
      // same producer and the same ids, and the only difference between them is
      // whether a comma is attached.
      name: 'checklist-not-done-comma-list',
      guardedBy: 'substantive-id-no-reduction',
      a: checklistNotDone(['CHK-001', 'CHK-009']),
      b: checklistNotDone(['CHK-002', 'CHK-009']),
    },
    {
      // THE COST (was must-differ in round 12). The SENTENCE-FINAL-PERIOD position
      // from the real producer at core/machine.ts:273
      // (`… are still pending: ${ids.join(', ')}.`). The last id in that list is
      // the one followed by the period, so every `SEP-` token this rejection can
      // emit is punctuation-attached and none is protected.
      name: 'scope-extension-proposal-sentence-final-period',
      guardedBy: 'substantive-id-no-reduction',
      a: scopeExtensionPending(['SEP-B-bf52-009', 'SEP-B-bf52-001']),
      b: scopeExtensionPending(['SEP-B-bf52-009', 'SEP-B-bf52-002']),
    },
    {
      // THE COST (was must-differ in round 12). The SEMICOLON-attached position:
      // core/machine.ts:756 joins two blocking findings with `'; '`, so an id cited
      // at the end of the FIRST finding's description lands in front of that
      // separator. Cited at the end of the LAST description it is bare instead,
      // which is the must-differ `blocking-finding-cited-id-within-window`.
      name: 'blocking-finding-desc-semicolon-attached-id',
      guardedBy: 'substantive-id-no-reduction',
      a: twoBlockingFindings('CHK-001'),
      b: twoBlockingFindings('CHK-002'),
    },
    {
      // F-054 (a), THE LEAK ITSELF, quoted in the shape cross-host codex reported
      // it. `not ok 1 - bug-2: reproducer still red` is an ordinary TAP subtest
      // name — a case label followed by a colon — in exactly the raw test output
      // core/machine.ts:1190 embeds. The round-12 strip removed that colon
      // unconditionally, `bug-2:` reduced to the id `bug-2`, and this pair keyed
      // APART on that branch while main collapses it. Worse than main, through the
      // one piece of the rule that was still an enumeration.
      name: 'embedded-test-output-trailing-colon-name',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '', ':'),
      b: doneTestFailurePunctuated('5', '', ':'),
    },
    {
      // F-054 (b), and the reason a SAFER punctuation set would not have closed
      // the class. A trailing COMMA is what a list of test names puts against every
      // entry but the last, and it was in the same stripped class as the colon. Any
      // enumeration that keeps the comma — and a comma is the one character the
      // real checklist render actually emits — keeps this manufacture available.
      name: 'embedded-test-output-trailing-comma-name',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '', ','),
      b: doneTestFailurePunctuated('5', '', ','),
    },
    {
      // F-054 (c). A trailing PERIOD, the third character the round-12 strip
      // removed unconditionally and the one the real `SEP-` list render ends on. It
      // has its own case because the three stripped characters were three separate
      // opportunities and the leak history in this guard is rounds of closing one
      // and leaving the next.
      name: 'embedded-test-output-trailing-period-name',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '', '.'),
      b: doneTestFailurePunctuated('5', '', '.'),
    },
    {
      // F-053 (a). An UNMATCHED OPENING paren, the shape cross-host codex
      // measured in round 12: `not ok 1 - (bug-2 reproducer still red` and its
      // `(bug-5` sibling digested APART under the independent-run strip —
      // `^[("'[{<]+` deleted the `(` without asking whether anything closed it —
      // while main collapses both. An unbalanced paren is ordinary in TAP names,
      // shell fragments and truncated expressions.
      //
      // It is RETAGGED, not re-decided: the code collapsed it in round 12 (the
      // balanced peel refused it) and collapses it now (nothing is peeled at all).
      // The tag changes because the rule it was guarding no longer exists.
      name: 'embedded-test-output-unmatched-open-paren',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '(', ''),
      b: doneTestFailurePunctuated('5', '(', ''),
    },
    {
      // F-053 (b). The MIRROR: an UNMATCHED CLOSING paren. `bug-2)` was stripped
      // by the old trailing run `[)"'\]}>,;:.!?]+$` with nothing opening it, so the
      // same defect ran from the other end. It keeps its own case because the two
      // ends were separate character classes and separate mutations — the leak
      // history in this guard is round after round of fixing one end and leaving
      // the other open.
      name: 'embedded-test-output-unmatched-close-paren',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '', ')'),
      b: doneTestFailurePunctuated('5', '', ')'),
    },
    {
      // F-053 (c). A token with one opener and one closer that do NOT match:
      // `(bug-2]`. Under the round-11 strip both runs fired and the token reduced
      // to an id, and under a naive "strip one leading and one trailing punctuation
      // character" repair it still would. It is the shape a hand-written repair is
      // most likely to miss.
      name: 'embedded-test-output-mismatched-wrapper-pair',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '(', ']'),
      b: doneTestFailurePunctuated('5', '(', ']'),
    },
    {
      // F-053 (d). An unmatched opening QUOTE. The quote characters are the ones
      // whose opener and closer are the SAME byte, which is what made a
      // balanced-pair rule delicate; with no peel at all the delicacy is gone.
      // `"bug-2` is what a truncated TAP name looks like, and it collapses on main.
      name: 'embedded-test-output-unmatched-open-quote',
      guardedBy: 'substantive-id-no-reduction',
      a: doneTestFailurePunctuated('2', '"', ''),
      b: doneTestFailurePunctuated('5', '"', ''),
    },
    // ── F-052: the THREE colon-composite forms, one accepted cost ─────────────
    // Round 10 protected the first two of these and LEAKED the third, because the
    // qualifier that rescued them accepted any label at all. Deleting it collapses
    // all three, so the three sit together, in the lane that states what the code
    // does, under one tag that names the cost. Grouped rather than scattered so the
    // SYMMETRY is visible in the suite: this is not two wins and one bug fix, it is
    // one rule that now ties with main in every colon position.
    {
      // The PREFIX composite, and the render the qualifier existed for. The real
      // REVIEW→TEST rejection (core/machine.ts:753, wrapped by :1181) names the
      // blocking finding by the id handlers/finding.ts:552 mints as
      // `${storyId}:F-${NNN}`, so the whole token is `B-bf52:F-012`.
      //
      // This pair was a MUST-DIFFER case named
      // `open-blocking-finding-delimiter-attached-id` in round 10, and asserting it
      // is exactly what required the qualifier. The assertion was not wrong about
      // what is DESIRABLE — resolving F-012 and then being blocked by F-013 really
      // is a reviewer round making progress — but the only available mechanism for
      // it was an unbounded label enumeration, and that mechanism protected
      // non-ids. The pair is therefore RE-DECIDED to collapse and moved here.
      //
      // The cost is real and bounded: two different blocking findings share one
      // key, so the breaker fires EARLIER on a REVIEW→TEST retry loop. That is the
      // fail-safe direction, main collapses this pair too (`b-#:f-#` on both
      // sides), and a BARE `F-012` is still protected — `finding-ordinal` in the
      // must-differ lane is the standing proof of that bound.
      name: 'open-blocking-finding-composite-id',
      guardedBy: 'substantive-id-colon-composite-cost',
      a: openBlockingFinding('F-012'),
      b: openBlockingFinding('F-013'),
    },
    {
      // The SUFFIX composite. Already pinned in round 10 (under
      // `substantive-id-token-tail-exact`) because the qualifier only ever
      // rescued the head end; it is RETAGGED here, not re-decided, since the code
      // does the same thing to it before and after F-052.
      //
      // core/verification.ts:22-24 mints an intentRef as `${itemId}:${lane}:${index}`
      // and core/verification.ts:216 renders it into the REVIEW rejection at
      // core/machine.ts:1173, so a checklist ordinal reaches the digest as
      // `CHK-001:happy:0` — an id with a colon-separated LANE SUFFIX welded on. The
      // whole-token rule refuses it and the token normalizes to `chk-#:happy:#`.
      //
      // WHY IT IS NOT CLOSED, and now the same answer as for the other two. The
      // only way to protect a colon-SUFFIXED composite is to admit trailing
      // `:`-joined segments — `(?::[a-z0-9-]+)*$` — which re-admits `:` as an
      // interior welding character, which is the exact class of defect F-051 and
      // F-052 both are. Enumerating a lane vocabulary instead
      // (`happy|edge|adversarial`) would work but adds a second hand-written
      // vocabulary with its own drift, and it is out of scope.
      name: 'verification-intent-ref-lane-suffix',
      guardedBy: 'substantive-id-colon-composite-cost',
      a: verificationIntentUnmet('CHK-001:happy:0'),
      b: verificationIntentUnmet('CHK-002:happy:0'),
    },
    {
      // The FORGED composite — codex's F-052 reproducer, and the one round 10 got
      // WRONG rather than merely paid for. Same producer as every other leak in
      // this guard: core/machine.ts:1190 embeds RAW test output into `Cannot enter
      // DONE: test ${evidence.result}: ${evidence.output}`, and `timeout:bug-2` is
      // an ordinary TAP subtest name — a lane label joined to a case label — not an
      // artifact id any producer in this tree mints.
      //
      // Under the qualifier `(?:[a-z0-9-]+:)?` the label `timeout:` was accepted as
      // freely as a story id, so `timeout:bug-2` and its `timeout:bug-5` sibling
      // digested APART on that branch and COLLAPSE on main — the worse-than-main
      // direction, reached through the one piece of interior structure the
      // whole-token form still had.
      //
      // This case is the reason the qualifier cannot come back in any form: it
      // fails the moment a leading `<label>:` segment is re-admitted, whether once
      // or repeatably. It replaces round 10's `embedded-test-output-repeated-
      // qualifier`, which only caught the REPEATABLE variant and passed happily
      // while the single-segment variant leaked.
      name: 'embedded-test-output-label-qualified-id',
      guardedBy: 'substantive-id-colon-composite-cost',
      a: doneTestFailureLabelQualified('2'),
      b: doneTestFailureLabelQualified('5'),
    },
    {
      // F-051, and the honest measurement of the `req-` allowlist member. Its
      // ONLY story_advance-reachable producer is core/proofstory.ts:1026,
      // surfaced as a diagnostic gap line inside the ProofStory DEV-gate report
      // — and that report's fixed banner alone runs well past the 200-character
      // prefix cut, so the differing `REQ-` ordinal never reaches the hash and
      // the pair collapses even though `req-` IS allowlisted and the id IS
      // protected by the normalizer.
      //
      // Same accepted residual as `blocking-finding-cited-id-past-window` and the
      // same direction (main collapses it too), but worth its own case because it
      // says something the allowlist alone does not: `req-` is allowlisted and
      // protects NOTHING that this tree currently renders.
      //
      // MEASURED CAVEAT, F-054, and it WEAKENS this case rather than restating it.
      // proofstory.ts:1026 renders `… sourceRequirementId REQ-001, which is not in
      // original intent keyRequirementIds.`, so the token is `req-001,` — COMMA
      // ATTACHED. With the reduction deleted, the two sides now normalize
      // IDENTICALLY (measured: divergence index 804 of a 804-character normalized
      // reason, i.e. no divergence at all), so the window is not what collapses
      // them and NO widening of any size would change that.
      //
      // It is therefore no longer a single-mutation guard on the prefix window, and
      // it is not one on the reduction either: with a sentence strip restored the
      // ordinal survives but lands at normalized character 753 (measured), past
      // every ADMISSIBLE cut — B-cc54's CHK-002:adversarial:1 caps the signals
      // window at 592, so 592 is the widest legal value. Measured directly: the
      // composite `prefix cut widened to 592 AND sentence strip restored` fails
      // seven cases and NOT this one. The standing single-mutation guard on the
      // window is `blocking-finding-cited-id-past-window` below.
      //
      // What this case still pins, and why it is kept: `req-` is allowlisted and
      // protects NOTHING this tree renders. That is a fact about the allowlist, not
      // about the window, and it is worth failing on if it changes — if the gap
      // line ever moves inside the window AND the id is ever rendered bare, this
      // pair starts keying apart and fails here.
      name: 'requirement-ordinal-past-window',
      guardedBy: 'prefix-window-residual',
      a: proofStoryRequirementGap('REQ-001'),
      b: proofStoryRequirementGap('REQ-002'),
    },
    {
      // F-033, the ACCEPTED residual, pinned in its own direction.
      //
      // Same producer and same cited item ids as the must-differ
      // `blocking-finding-cited-id-within-window` case; the ONLY change is two more
      // open blocking findings in front of the cited id, which pushes it past the
      // 200-character prefix cut (measured: normalized character 107 with none in
      // front, 257 with two). Both sides extract the IDENTICAL signal set
      // (`review_finding_blocking`), so nothing else can tell them apart and they
      // collapse.
      //
      // WHY THIS PRODUCER AND NOT THE `SEP-` ONE, which carried this residual
      // through round 12: every `SEP-` token in core/machine.ts:273's render is
      // comma- or period-attached, so after the F-054 deletion neither half of that
      // pair keys apart and widening the window would not change either — the pair
      // stopped being able to measure the window at all. This producer renders the
      // cited id BARE in front of the bracketed reason code, so the window is again
      // the only thing deciding.
      //
      // This is asserted as COLLAPSE because that is what the code does, and saying
      // so here is the point: it marks exactly where the improvement stops. main
      // collapses this pair too — main truncates at 200 unconditionally AND rewrites
      // every ordinal to `#` — and main additionally collapses the within-window
      // pair that this branch keeps apart. So the change is strictly better inside
      // the window and equal outside it: bounded, never regressive.
      //
      // Widening the window is not IMPOSSIBLE, and an earlier revision of this
      // comment overstated it as unavailable (F-042). MEASURED, both bounds:
      // B-cc54's CHK-002:adversarial:1 requires a signal-free tail past its banner
      // to leave the key UNCHANGED, and that banner fixture normalizes to exactly
      // 592 characters — so a cut of 593 or more admits the noise tail and breaks
      // B-cc54's suite, while any cut from 216 (this pair's divergence point) up to
      // 592 would fix the case illustrated HERE without breaking B-cc54 at all.
      // The honest statement is therefore "a 376-character window exists and is not
      // taken", not "widening is unavailable".
      //
      // 200 is kept anyway, for the reason already stated in
      // core/convergence-breaker.ts a few lines above the cut: on the signals branch
      // every key must stay BYTE-IDENTICAL to the ones B-cc54 landed, and this
      // story's one-line claim is that it never changes a signals-branch key. Buying
      // a bounded residual back at the cost of rekeying every ProofStory rejection
      // in the system is not a trade this story gets to make for a residual it has
      // already shown is never worse than main.
      name: 'blocking-finding-cited-id-past-window',
      guardedBy: 'prefix-window-residual',
      a: blockingFindingsCitingLast(2, 'CHK-001'),
      b: blockingFindingsCitingLast(2, 'CHK-002'),
    },
    {
      // A bare ordinal carries no artifact prefix, so it is noise. This is the
      // shape B-cc54's noise fixture embeds; it is asserted separately here so a
      // digit-rule deletion is attributable without decoding the noise pair.
      name: 'bare-attempt-ordinal',
      guardedBy: 'digit-rule-collapse',
      a: 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)',
      b: 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 41)',
    },
    {
      // The real non-owner rejection, varying ONLY the welded heartbeat age.
      // `45s` / `52s`: the digits have no prefix, so both become `#s`. If they
      // did not, the most common ownership-contention message in the system
      // would mint a fresh key on every retry and a genuine livelock would never
      // accumulate — the breaker's whole purpose.
      name: 'lease-heartbeat-age',
      guardedBy: 'digit-rule-collapse',
      a: leaseNonOwner('45s'),
      b: leaseNonOwner('52s'),
    },
    {
      // A progress counter embedded in the reason. `0/4` and `1/4` are the same
      // unmet floor observed at two moments; the slash here is NOT a path (no
      // delimiter precedes it), so this pair also pins the narrowed path rule
      // against over-anchoring.
      name: 'lane-counts',
      guardedBy: 'digit-rule-collapse',
      a: 'review assurance floor is unmet: 0/4 reviewer lanes have a current-round pass',
      b: 'review assurance floor is unmet: 1/4 reviewer lanes have a current-round pass',
    },
    {
      name: 'hex-id',
      guardedBy: 'hex-rule-collapse',
      a: 'material digest mismatch a1b2c3d4e5f6789',
      b: 'material digest mismatch f6e5d4c3b2a1987',
    },
    {
      // The retry ordinal is held CONSTANT and only the ISO timestamp varies, so
      // volatile timestamps alone must not mint a second key. Section 7 above
      // asserts the same pair silently; this case PRINTS both literal values.
      //
      // Localization, MEASURED and CORRECTED. An earlier revision of this comment
      // claimed the case was a single-rule guard on the ISO rule and that the
      // claim had been "verified separately". Mutation testing says otherwise:
      // deleting the ISO rule alone fails NOTHING in this suite (exit 0), and so
      // does deleting the bare-digit rule alone. The reason is that the two rules
      // are REDUNDANT for a pure-digit timestamp — with the ISO rule gone,
      // `/\d+/g` still rewrites `2026-07-14t00:00:00z` and `2026-07-14t09:59:59z`
      // to the same `#-#-#t#:#:#z`. The pair therefore only splits when BOTH rules
      // are gone, which is what the tag now says. No case in this matrix is bound
      // to the ISO rule alone, and pretending otherwise was a false verification
      // claim sitting in a comment.
      name: 'iso-timestamp-only',
      guardedBy: 'iso-or-digit-rule-collapse',
      a: 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)',
      b: 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 3)',
    },
  ];

  const ZERO: BreakerCounters = {
    advanceCount: 0, reviewRunCount: 0, reviewPassCount: 0, takeoverCount: 0, maxGateRepeat: 0,
  };

  /** Drive the real on-disk counter for one case in its own throwaway story dir. */
  const drive = (a: string, b: string): { counter: number; keys: number } => {
    const caseDir = mkdtempSync(join(tmpdir(), 'cbreaker-matrix-'));
    try {
      bumpGateFailureCount(caseDir, CMD, a);
      bumpGateFailureCount(caseDir, CMD, b);
      const counts = readGateFailureCounts(caseDir);
      return { counter: maxGateFailureCount(counts), keys: Object.keys(counts).length };
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  };

  // B-bf52 F-008: every case prints the two literal reason values it compared,
  // not just its abstract tag, so a human reading the console output can see
  // WHICH values were held to differ or to collapse (`DEV/REVIEW` vs `DEV/TEST`,
  // `/Users` vs `/private/var`, `CHK-001` vs `CHK-002`) instead of having to open
  // this file to decode a tag. A reason longer than the preview budget prints a
  // window centred on the FIRST character at which the pair diverges, together
  // with that index: the lease-contention pair is byte-identical for its first
  // ~80 characters and then differs by two characters inside a 500-character
  // message, so a head-truncated preview would print two identical windows and
  // show nothing.
  const PREVIEW_CHARS = 150;
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const firstDiffIndex = (a: string, b: string): number => {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a[i] === b[i]) i += 1;
    return i;
  };
  const previewLines = (a: string, b: string): string[] => {
    const fa = flat(a);
    const fb = flat(b);
    const diffAt = firstDiffIndex(fa, fb);
    const render = (label: string, s: string): string => {
      if (s.length <= PREVIEW_CHARS) return `        ${label}: "${s}"`;
      const start = Math.max(0, Math.min(diffAt - 40, s.length - PREVIEW_CHARS));
      const end = Math.min(s.length, start + PREVIEW_CHARS);
      const head = start > 0 ? '...' : '';
      const tail = end < s.length ? '...' : '';
      return `        ${label} [chars ${start}-${end} of ${s.length}]: "${head}${s.slice(start, end)}${tail}"`;
    };
    return [
      `        compared values share their first ${diffAt} chars, then diverge (lengths ${fa.length} vs ${fb.length})`,
      render('a', fa),
      render('b', fb),
    ];
  };

  // Every case is evaluated even after one fails, and the failures are reported
  // together grouped by guard. A matrix that aborted on the first failing
  // assertion could not show WHICH subset regressed, which is the whole point of
  // the guardedBy tagging: reverting one rule must name its own cases and leave
  // the rest reported as passing.
  const failures: Array<{ lane: string; name: string; guardedBy: string; message: string }> = [];
  const runCase = (lane: string, c: DigestCase, body: () => string): void => {
    const { name, guardedBy } = c;
    try {
      console.log(`  ${lane.padEnd(19)} ${name} [guard: ${guardedBy}] ${body()}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ lane, name, guardedBy, message });
      console.log(`  ${lane.padEnd(19)} ${name} [guard: ${guardedBy}] FAIL — ${message}`);
    }
    for (const line of previewLines(c.a, c.b)) console.log(line);
  };

  for (const c of MUST_DIFFER) {
    runCase('must-differ', c, () => {
      const where = `must-differ ${c.name} (guarded by ${c.guardedBy})`;
      const { counter, keys } = drive(c.a, c.b);
      assert.notEqual(
        gateFailureDigest(CMD, c.a), gateFailureDigest(CMD, c.b),
        `${where}: two substantively different rejections share one digest key`,
      );
      assert.equal(keys, 2, `${where}: expected two counter keys, got ${keys}`);
      assert.equal(
        counter, 1,
        `${where}: counter reached ${counter}, so incremental progress accumulates toward a freeze`,
      );
      const assessed = assessBreaker({ ...ZERO, maxGateRepeat: counter }, T, null);
      assert.equal(
        assessed.tripped, false,
        `${where}: the breaker tripped on two DIFFERENT failures — this is the false freeze`,
      );
      return `keys=${keys} counter=${counter} breaker=proceed -> the two values DIGEST DIFFERENTLY`;
    });
  }

  for (const c of MUST_COLLAPSE) {
    runCase('must-still-collapse', c, () => {
      const where = `must-still-collapse ${c.name}`;
      const { counter, keys } = drive(c.a, c.b);
      assert.equal(
        gateFailureDigest(CMD, c.a), gateFailureDigest(CMD, c.b),
        `${where}: an incidental-only difference produced two digest keys`,
      );
      assert.equal(keys, 1, `${where}: expected one counter key, got ${keys}`);
      assert.equal(
        counter, 2,
        `${where}: the repeat did not accumulate (counter ${counter}), so a genuine livelock would never be caught`,
      );
      const assessed = assessBreaker({ ...ZERO, maxGateRepeat: counter }, T, null);
      assert.equal(
        assessed.tripped, true,
        `${where}: two repeats of one failure no longer trip the breaker`,
      );
      assert.match(
        assessed.reasons.join(' '), /gate-repeat 2>=2/,
        `${where}: the trip must be attributed to gate-repeat`,
      );
      return `keys=${keys} counter=${counter} breaker=trips -> the two values DIGEST IDENTICALLY`;
    });
  }

  if (failures.length > 0) {
    const byGuard = new Map<string, string[]>();
    for (const f of failures) {
      byGuard.set(f.guardedBy, [...(byGuard.get(f.guardedBy) ?? []), f.name]);
    }
    const localization = [...byGuard.entries()]
      .map(([guard, names]) => `${guard} -> ${names.join(', ')}`)
      .join(' | ');
    assert.fail(
      `B-bf52 digest matrix: ${failures.length} of ${MUST_DIFFER.length + MUST_COLLAPSE.length} cases failed. ` +
      `Failing cases grouped by the normalizer rule that guards them — ${localization}. ` +
      `A single group here means that one rule regressed; the collapse-lane group instead means the ` +
      `normalizer became too fine-grained and the breaker will fire less often than it must. ` +
      `Details: ${failures.map((f) => `[${f.lane} ${f.name}] ${f.message}`).join(' ;; ')}`,
    );
  }

  // Fixture precondition for the F-033 pair, deliberately placed AFTER the matrix
  // rather than with the other preconditions above.
  //
  // It asserts a tight character-index boundary (87 vs 215 around a 200-char cut),
  // and measurement showed that several UNRELATED reverts — an emptied allowlist,
  // a corrupted placeholder encoding, a whole-token protection reduced to
  // prefix-before-digits — stop protecting the `SEP-…` ordinal entirely, which
  // makes both sides normalize identically and pushes the "divergence index" to
  // the end of the string. Run BEFORE the matrix, this block threw first and
  // aborted the whole run, so an operator who emptied the allowlist saw a
  // character-index message instead of the four cases that name the allowlist.
  // Placed here, a rule regression localizes to its own cases exactly as this
  // section promises, and the measurement is still pinned on every green run.
  {
    // F-033 residual, MEASURED. One real producer, two open-finding counts, and
    // the 200-character prefix window falls between them: with no other finding
    // open the cited `CHK-NNN` ordinal lands inside the window and the pair keys
    // apart, with two more findings in front of it the identical ordinal lands
    // outside and the pair collapses. Both pairs carry the SAME non-empty signal
    // set (`review_finding_blocking`), so B-cc54's mechanism supplies no
    // distinctness in either case and the window alone decides.
    //
    // These assertions pin the measurement itself, so any later edit to this
    // fixture's wording or finding count that moves either side across the
    // boundary fails HERE, naming the character index, instead of silently turning
    // one of the two matrix cases into a copy of the other.
    //
    // It also pins the BARE position the whole pair depends on after F-054: the
    // cited id is the last thing in the last finding's description, so it is
    // followed by a space and the bracketed reason code rather than by punctuation.
    // If a later edit attaches anything to it, the within-window half stops keying
    // apart and this block reports it as a character index at the end of the
    // string.
    const divergeAt = (a: string, b: string): number => {
      const na = normalizeGateReason(a);
      const nb = normalizeGateReason(b);
      let i = 0;
      while (i < Math.min(na.length, nb.length) && na[i] === nb[i]) i += 1;
      return i;
    };
    const withinA = blockingFindingsCitingLast(0, 'CHK-001');
    const withinB = blockingFindingsCitingLast(0, 'CHK-002');
    const pastA = blockingFindingsCitingLast(2, 'CHK-001');
    const pastB = blockingFindingsCitingLast(2, 'CHK-002');
    for (const [label, x, y] of [['within', withinA, withinB], ['past', pastA, pastB]] as const) {
      const sx = extractGateBlockSignals(normalizeGateReason(x));
      const sy = extractGateBlockSignals(normalizeGateReason(y));
      assert.ok(sx.length > 0, `prefix-window fixture (${label}): the pair must carry signals, or it exercises the signal-less branch instead`);
      assert.deepEqual(sx, sy, `prefix-window fixture (${label}): both sides must extract the IDENTICAL signal set, or the signal set — not the window — is what separates them`);
    }
    const withinAt = divergeAt(withinA, withinB);
    const pastAt = divergeAt(pastA, pastB);
    assert.ok(withinAt < 200, `prefix-window fixture: the within-window pair must diverge BEFORE character 200 (diverged at ${withinAt})`);
    assert.ok(pastAt > 200, `prefix-window fixture: the past-window pair must diverge AFTER character 200 (diverged at ${pastAt})`);
    assert.match(
      normalizeGateReason(withinA), /chk-001 \[review_finding_blocking\]$/,
      'prefix-window fixture: the cited id must survive normalization BARE (followed by the bracketed reason code), or the pair measures the reduction rather than the window',
    );
    console.log(
      `  fixture-precondition prefix-window: same producer (1 vs 3 open blocking findings), ` +
      `identical signal sets, cited id diverges at char ${withinAt} (within) vs ${pastAt} (past) around the 200-char cut`,
    );
  }

  const inventory = (lane: string, cases: DigestCase[]): string =>
    `${cases.length} ${lane} [${cases.map((c) => `${c.name} (${c.guardedBy})`).join(', ')}]`;
  digestMatrixSummary =
    `${inventory('must-differ counter=1', MUST_DIFFER)} + ${inventory('must-still-collapse counter=2 breaker-trips', MUST_COLLAPSE)}`;

  // A pathological oversize reason must not throw and must still key. This is a
  // SHAPE check only. F-031 made the prefix cut SIGNALS-CONDITIONAL: a reason
  // that carries structured signals keeps B-cc54's 200-character prefix exactly,
  // and a signal-less reason is bounded at 16,384 characters — a sanity ceiling
  // so a pathological transcript stays cheap to hash, NOT a distinctness claim.
  // TRANSCRIPT carries no signal, so it exercises the 16,384 branch.
  assert.deepEqual(
    extractGateBlockSignals(normalizeGateReason(TRANSCRIPT)), [],
    'the oversize fixture must be signal-less so it exercises the 16,384 sanity-bound branch',
  );
  assert.match(
    gateFailureDigest(CMD, TRANSCRIPT), /^story_advance\/[0-9a-f]{12}$/,
    'a pathological oversize reason still produces a well-formed digest and does not throw',
  );
  console.log(
    `  oversize-reason     ${TRANSCRIPT.length}-char reason digests to ` +
    `${gateFailureDigest(CMD, TRANSCRIPT)} without throwing`,
  );
}

// ── 7c. B-bf52 F-029/F-035: the allowlist's BIDIRECTIONAL completeness guard ──
//
// The allowlist SUBSTANTIVE_ID_PREFIXES is hand-written, and F-029 is the proof
// that a hand-written enumeration cannot see its own gaps: `bug-` was missing,
// so `Cannot enter DONE: 1 unfixed bug(s): BUG-001` and its BUG-002 variant
// collapsed, and fixing one bug then being blocked by the next read as one
// repeated failure. One more entry does not fix the CLASS; a guard that makes
// the gap DETECTABLE does.
//
// The first version of this guard was one-directional — it failed only when a
// scanned producer's prefix was unclassified — and six review rounds showed that
// half the errors run the OTHER way: `ab-` and `oq-` were allowlisted with no
// producer anywhere in the tree, `init-` was allowlisted for a shape no
// transition guard can render, and `sep-` was excluded on a premise that its own
// producer contradicts. None of those were visible from the producer side,
// because there was nothing to see. The guard is therefore bidirectional: a
// producer with no classification AND a classification with no producer both
// fail here. That does not make the enumeration provably complete — no scan can
// invent a prefix no producer emits yet — but it bounds its DRIFT, which is the
// property this story can actually deliver.
//
// This guard scans production source (core + handlers) for the artifact-id
// ordinal shapes the finding names — `PREFIX-${…}` id-MINT templates (the
// authoritative producers of every id that can appear, interpolated, in a
// runtime rejection) and, additionally, literal `PREFIX-<digit>` ordinals that
// appear INSIDE a story_advance-reachable rejection literal (one carrying a
// transition-guard rejection marker). Every discovered prefix must be classified
// as EITHER substantive (in the live allowlist) OR a member of an explicit,
// commented exclusion category below. A prefix in NEITHER fails this guard,
// naming itself — so the next time a producer like machine.ts:1195 introduces a
// gate-reachable ordinal, the suite refuses to stay green until someone decides.
{
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const SCAN_DIRS = ['src/core', 'src/handlers'];

  // Explicit, commented exclusion categories. The reason lives with the category.
  //
  // (a) F-030 / F-036 / F-044: review BOOKKEEPING ids. `rr-` (review run), `rp-`
  // (review pass), `rl-` (review loop) and `i-` (INIT_CHECK reviewer issue) all
  // name a record that is RE-MINTED on retry
  // rather than the artifact that must be fixed, so allowlisting them lets a host
  // mint a fresh digest key on every attempt and the breaker never trips on an
  // unbounded retry loop. Guarded, in the inverse direction, by the must-collapse
  // `stale-review-run-evidence`, `review-loop-ordinal` and
  // `init-check-issue-ordinal` cases above.
  //
  // `i-` joined this category in round 8, reversing the F-034 over-correction.
  // F-034's real content — that `init-` is DEAD CONFIG, since the only `INIT-${…}`
  // mint (handlers/draft-check.ts:81) ids draft-check issues that no transition
  // guard reads — stands, and `init-` remains excluded below. What F-034 got wrong
  // was the replacement: it allowlisted `i-` because the RENDER site is real, but
  // the criterion is whether the ordinal survives the retry the rejection demands.
  // It does not. cli/command-catalog.ts:2315 makes `issue.id` OPTIONAL and
  // reviewer-self-assigned free text; handlers/init-check.ts:139-142 drops the
  // calling agent's previous record and rewrites its issues wholesale on every
  // init_check_set; and core/machine.ts:1036-1044 prints "re-run the corresponding
  // reviewer" as the fix — which is exactly the call that renumbers the ids. Same
  // class as `rr-`/`rp-`/`rl-`, therefore same treatment.
  //
  // `rl-` is here on that ground and ONLY that ground. Its earlier justification
  // — that no story_advance rejection can contain a review-loop id — was false:
  // core/machine.ts:640-661 renders `active review loop(s): loopId=${loopId}` and
  // core/machine.ts:1192 wraps it as a `Cannot enter TEST` rejection, while
  // handlers/review-loop.ts:141 mints the id as `${storyId}:RL-${NNN}`. The
  // accepted COST of collapsing is that two loops opened for genuinely different
  // triggers share one key; that cost is taken because it makes the breaker fire
  // EARLY, which is the fail-safe direction for a breaker, while the opposite
  // error makes it never fire at all.
  const EXCLUDED_REVIEW_BOOKKEEPING = new Set(['i-', 'rl-', 'rp-', 'rr-']);
  // (b) The story-id prefix itself is not an artifact ordinal; it must normalize
  // like any other bare id (guarded by the must-collapse `bcc54-story-id-digits`).
  const EXCLUDED_STORY_ID = new Set(['b-']);
  // (c) F-034: a prefix whose minted shape is CONFUSABLE with a gate-reachable one
  // but is not the same id. `INIT-001` is minted by handlers/draft-check.ts:81 for
  // draft-check issues, and core/machine.ts never reads draft-check.json, so no
  // `INIT-…` id can appear in a transition-guard rejection. The INIT_CHECK
  // rejection that DOES name issue ids (core/machine.ts:1042-1046) renders
  // init-check.json reviewer issues, whose declared shape is `I-1`. `init-` is
  // excluded here rather than silently dropped, because a silent drop is
  // indistinguishable from an oversight. (`i-` is excluded too, but on the
  // DIFFERENT ground recorded in category (a): its shape is gate-reachable, its
  // ordinal simply does not survive the retry.)
  const EXCLUDED_SHAPE_CONFUSABLE = new Set(['init-']);
  // (d) Ids minted by subsystems whose records are NEVER emitted by a
  // story_advance transition-guard rejection: playbook / learning / capability /
  // handoff / autopilot / dispatch / cluster / planner / grill / review-escalation
  // / test-run / session-label producers. If any of these ever starts appearing in
  // a transition-guard rejection whose ordinal marks progress (clear one, hit the
  // next), it must MOVE to the allowlist with its own must-differ case — this
  // guard is exactly what will force that decision.
  const EXCLUDED_NON_GATE_SUBSYSTEM = new Set([
    'ap-', 'ar-', 'auto-', 'cl-', 'd-', 'ddp-', 'done-', 'gq-', 'grill-', 'hp-',
    'override-', 'pba-', 'pbd-', 'pbh-', 'pbls-', 'pbo-', 'pbp-', 'pbs-',
    'pbsrc-', 'pcr-', 'pol-', 'ref-', 'rhp-', 's-', 'src-',
    'tea-', 'test-', 'timer-',
  ]);

  const allowlist = new Set(listSubstantiveIdPrefixes());
  // Where each classified prefix is DECLARED, so the reverse direction of the
  // guard can tell an operator which file to edit when an entry goes dead.
  const CLASSIFICATION_SETS: Array<{ label: string; file: string; set: Set<string> }> = [
    { label: 'SUBSTANTIVE_ID_PREFIXES', file: 'src/core/convergence-breaker.ts', set: allowlist },
    { label: 'EXCLUDED_REVIEW_BOOKKEEPING', file: 'src/tasks/convergence-breaker-smoke.ts', set: EXCLUDED_REVIEW_BOOKKEEPING },
    { label: 'EXCLUDED_STORY_ID', file: 'src/tasks/convergence-breaker-smoke.ts', set: EXCLUDED_STORY_ID },
    { label: 'EXCLUDED_SHAPE_CONFUSABLE', file: 'src/tasks/convergence-breaker-smoke.ts', set: EXCLUDED_SHAPE_CONFUSABLE },
    { label: 'EXCLUDED_NON_GATE_SUBSYSTEM', file: 'src/tasks/convergence-breaker-smoke.ts', set: EXCLUDED_NON_GATE_SUBSYSTEM },
  ];
  const isClassified = (p: string): boolean => CLASSIFICATION_SETS.some(({ set }) => set.has(p));

  // CALLER-SUPPLIED id shapes have no `PREFIX-${…}` mint template anywhere,
  // because the id is written by the caller and the code only interpolates it. The
  // scan below cannot see them, so the reverse direction of the guard would report
  // them as dead config. Each therefore carries a CITATION instead of a producer:
  // the file that declares the shape and the file that renders it into a
  // story_advance rejection, both checked literally. If either citation stops
  // resolving — a renamed schema description, a deleted render site — this guard
  // fails, so the entry cannot quietly rot into the `ab-`/`oq-` state.
  const CALLER_SUPPLIED_ID_SHAPES: Array<{
    prefix: string; shapeFile: string; shapeNeedle: string; renderFile: string; renderNeedle: string; note: string;
  }> = [
    {
      prefix: 'i-',
      shapeFile: 'src/cli/command-catalog.ts',
      shapeNeedle: 'Reviewer self-assigned ID, for example I-1',
      renderFile: 'src/core/machine.ts',
      renderNeedle: 'Cannot enter INIT_CHECK: init-check reviewer recorded high/critical issues',
      note:
        'EXCLUDED, not substantive (F-044). The citation is kept because the shape and the render site are both ' +
        'real — this is the entry proving the guard can tell "gate-reachable" from "substantive", which are not ' +
        'the same test. Guarded in the collapse direction by the must-still-collapse init-check-issue-ordinal case.',
    },
    {
      prefix: 'req-',
      shapeFile: 'src/core/proofstory.ts',
      shapeNeedle: '"sourceRequirementId": "REQ-001"',
      renderFile: 'src/core/proofstory.ts',
      renderNeedle: 'references sourceRequirementId ',
      note:
        'MEASURED INERT at its only render site: the ProofStory diagnostic report preamble exceeds 200 ' +
        'normalized characters even in its minimal form, so the REQ ordinal always lands past the F-033 ' +
        'prefix window and two unbound requirements collapse anyway. Kept because the render site is real ' +
        'and the ordinal genuinely names WHICH requirement is unbound; it protects nothing today, and it ' +
        'has no must-differ matrix case for exactly that reason.',
    },
  ];

  // Comment-aware tokenizer: yields string + template literal bodies, skipping
  // comments so a prefix mentioned only in prose does not count as a producer.
  const scanLiterals = (src: string): string[] => {
    const out: string[] = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        const q = c;
        const start = ++i;
        while (i < n) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === q) break;
          if (q !== '`' && src[i] === '\n') break;
          i += 1;
        }
        out.push(src.slice(start, i));
        i += 1;
        continue;
      }
      i += 1;
    }
    return out;
  };

  const listTsFiles = (dir: string): string[] => {
    const acc: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d).sort()) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) acc.push(p);
      }
    };
    walk(dir);
    return acc;
  };

  // The mint shape the finding names: a prefix immediately followed by `-${`.
  const MINT_RE = /(?:^|[^A-Za-z0-9_])([A-Z]{1,10})-\$\{/g;
  // The literal-ordinal shape, restricted to rejection text so the scan targets
  // "story_advance-reachable rejection text" and not the baseline/doc fixtures.
  const LITERAL_ORDINAL_RE = /(?:^|[^A-Za-z0-9_])([A-Z]{1,10})-\d/g;
  // Markers a story_advance transition guard (core/machine.ts) or the gates it
  // calls actually emit. A literal carrying one is treated as rejection text.
  const REJECTION_MARKER = /cannot enter|unfixed bug|is stale|bound reviewrunid|not the (?:current|latest) run|still open|proposal\(s\) are still pending|checklist item\(s\) not done|scope gate is blocking/i;

  const discovered = new Map<string, string>(); // prefix -> first "file: snippet"
  let fileCount = 0;
  for (const rel of SCAN_DIRS) {
    for (const file of listTsFiles(join(packageRoot, rel))) {
      fileCount += 1;
      const src = readFileSync(file, 'utf8');
      const shortName = file.slice(packageRoot.length + 1);
      for (const body of scanLiterals(src)) {
        const isRejection = REJECTION_MARKER.test(body);
        const record = (m: RegExpMatchArray): void => {
          const prefix = `${m[1].toLowerCase()}-`;
          if (!discovered.has(prefix)) {
            discovered.set(prefix, `${shortName}: «${body.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 30).replace(/\s+/g, ' ')}»`);
          }
        };
        for (const m of body.matchAll(MINT_RE)) record(m);
        if (isRejection) for (const m of body.matchAll(LITERAL_ORDINAL_RE)) record(m);
      }
    }
  }

  // The guard must actually be scanning something, and must have SEEN the real
  // F-029 producer prefix `bug-` (test-story.ts mints `BUG-${…}`) and the two
  // deliberately-excluded review-bookkeeping prefixes — otherwise a broken
  // tokenizer could pass this section vacuously.
  assert.ok(fileCount > 100, `completeness scan must cover the source tree (saw ${fileCount} files)`);
  for (const anchor of ['bug-', 'rr-', 'rp-', 'chk-', 'f-', 'sep-', 'rl-', 'init-']) {
    assert.ok(discovered.has(anchor), `completeness scan must discover the ${anchor} producer, or it is not scanning the real id-mint sites`);
  }

  // Every citation must resolve, literally, before it is allowed to excuse a
  // missing producer. A citation that no longer matches its file is drift, and
  // drift is the whole thing this section exists to catch.
  const citedPrefixes = new Set<string>();
  for (const c of CALLER_SUPPLIED_ID_SHAPES) {
    assert.ok(
      isClassified(c.prefix),
      `B-bf52 completeness guard: ${c.prefix} carries a caller-supplied-shape citation but is itself unclassified — the citation cannot excuse an entry that does not exist`,
    );
    for (const [kind, rel, needle] of [['shape', c.shapeFile, c.shapeNeedle], ['render', c.renderFile, c.renderNeedle]] as const) {
      const abs = join(packageRoot, rel);
      assert.ok(existsSync(abs), `B-bf52 completeness guard: ${c.prefix} cites ${rel} for its ${kind}, but that file does not exist`);
      assert.ok(
        readFileSync(abs, 'utf8').includes(needle),
        `B-bf52 completeness guard: ${c.prefix}'s ${kind} citation no longer resolves — ${rel} does not contain «${needle}». ` +
        `Re-verify whether the prefix still has a story_advance-reachable id shape, then update the citation or remove the entry.`,
      );
    }
    citedPrefixes.add(c.prefix);
  }

  // ── Direction 1: a scanned producer whose prefix nobody classified ──────────
  const unclassified = [...discovered.entries()].filter(([p]) => !isClassified(p)).sort();
  // ── Direction 2: a classified prefix with no producer and no citation ───────
  //
  // This is the direction F-035 needed and did not have. `ab-` and `oq-` sat in
  // the allowlist for six review rounds asserting that acceptance-basis and
  // open-question ordinals are substantive, while NO producer in the tree emits
  // either shape into a rejection — dead config that made the enumeration look
  // better evidenced than it was, and that nothing could have flagged because the
  // guard only ever looked from producers towards the classification. It is also
  // the direction that would have caught `init-`, whose producer exists but mints
  // an id no transition guard can render. Together the two directions bound the
  // enumeration's DRIFT: a newly minted id prefix and a newly dead one both fail
  // here, so neither waits for the next round of review to be noticed.
  const producerless = CLASSIFICATION_SETS
    .flatMap(({ label, file, set }) => [...set].map((p) => ({ prefix: p, label, file })))
    .filter(({ prefix }) => !discovered.has(prefix) && !citedPrefixes.has(prefix))
    .sort((x, y) => x.prefix.localeCompare(y.prefix));

  if (unclassified.length > 0 || producerless.length > 0) {
    const parts: string[] = [];
    if (unclassified.length > 0) {
      parts.push(
        `UNCLASSIFIED (${unclassified.length}): ${unclassified.map(([p, where]) => `${p} (${where})`).join(' ;; ')}. ` +
        `Decide each one: allowlist it (with a must-differ matrix case) if its ordinal names WHICH artifact the gate ` +
        `refused on, or add it to an exclusion category with a reason.`,
      );
    }
    if (producerless.length > 0) {
      parts.push(
        `NO PRODUCER (${producerless.length}): ${producerless.map(({ prefix, label, file }) => `${prefix} (declared in ${label}, ${file})`).join(' ;; ')}. ` +
        `Nothing in src/core or src/handlers mints or renders this shape, so the entry is asserting a classification ` +
        `about ids that do not exist. Delete it, or — if the id is caller-supplied and therefore has no mint template — ` +
        `add it to CALLER_SUPPLIED_ID_SHAPES with a citation that resolves.`,
      );
    }
    assert.fail(`B-bf52 bidirectional completeness guard: ${parts.join(' | ')}`);
  }
  const excludedCount = CLASSIFICATION_SETS
    .filter(({ set }) => set !== allowlist)
    .reduce((sum, { set }) => sum + set.size, 0);
  console.log(
    `  completeness-guard  scanned ${fileCount} files, ${discovered.size} id-prefix producers, ` +
    `bidirectionally reconciled (${allowlist.size} substantive, ${excludedCount} excluded, ` +
    `${citedPrefixes.size} caller-supplied with resolving citations, 0 unclassified, 0 producerless)`,
  );
}

// ── 8. State + takeover I/O round-trip ────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-io-'));
  try {
    assert.equal(readBreakerState(dir), null, 'no state file => null');
    assert.equal(readTakeoverCount(dir), 0, 'no takeover file => 0');
    bumpTakeoverCount(dir);
    bumpTakeoverCount(dir);
    assert.equal(readTakeoverCount(dir), 2, 'takeover counter increments');

    const frozen = assessBreaker({ ...STORM, advanceCount: 200 }, T, { advanceBaseline: 0, autoRecoveriesSpent: 1, frozen: false, trippedReasons: [] });
    assert.equal(frozen.action, 'freeze');
    writeBreakerState(dir, frozen.nextState);
    const round = readBreakerState(dir);
    assert.ok(round && round.frozen === true, 'frozen state round-trips');

    // Ack clears it and re-baselines ALL signals to the current counts.
    const resumed = resumeBreakerState({ ...STORM, advanceCount: 200 });
    assert.equal(resumed.frozen, false, 'resume clears frozen');
    assert.equal(resumed.autoRecoveriesSpent, 0, 'resume restores the recovery budget');
    assert.equal(resumed.advanceBaseline, 200, 'resume re-baselines advance to current');
    assert.equal(resumed.takeoverBaseline, 65, 'resume re-baselines takeover to current');
    assert.equal(resumed.reviewRunBaseline, 131, 'resume re-baselines review runs to current');

    const resumedFromZero = resumeBreakerState({
      advanceCount: 0,
      reviewRunCount: 0,
      reviewPassCount: 0,
      takeoverCount: 0,
      maxGateRepeat: 0,
    });
    assert.deepEqual(resumedFromZero, {
      advanceBaseline: 0,
      takeoverBaseline: 0,
      reviewRunBaseline: 0,
      reviewPassBaseline: 0,
      autoRecoveriesSpent: 0,
      frozen: false,
      trippedReasons: [],
      counterSnapshot: undefined,
    }, 'resume derives clean defaults from zero counters without prior state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 9. Human-ack refusal under autopilot / non-interactive ────────────────────
{
  assert.equal(isInteractiveAckAllowed({}, true), true, 'interactive TTY, no autopilot => allowed');
  assert.equal(isInteractiveAckAllowed({}, false), false, 'no TTY => refused');
  assert.equal(isInteractiveAckAllowed({ LATTICE_AUTOPILOT: '1' }, true), false, 'autopilot marker => refused even at a TTY');
  assert.equal(isInteractiveAckAllowed({ CI: 'true' }, true), false, 'CI marker => refused');
  assert.equal(isInteractiveAckAllowed({ LATTICE_AUTOPILOT: '0' }, true), true, 'falsey autopilot marker => allowed');
}

// ── 10. Gitignored-artifact registration (F-008 DONE-merge safety) ────────────
{
  for (const f of ['breaker-state.json', 'takeover-count.json', 'gate-failure-counts.json']) {
    const entry = findRuntimeArtifactEntry(`.lattice/story/actives/B-bbaf/${f}`);
    assert.ok(entry, `${f} is registered as a runtime artifact`);
    assert.equal(isMaterialExcludedRuntimeArtifactPath(`.lattice/story/actives/B-bbaf/${f}`), true, `${f} is material-hash excluded`);
  }
  const patterns = listRuntimeArtifactIgnorePatterns();
  for (const glob of ['**/breaker-state.json', '**/takeover-count.json', '**/gate-failure-counts.json']) {
    assert.ok(patterns.includes(glob), `ignore pattern ${glob} is listed`);
  }
}

// ── 11. F-003 regression: takeover (and pass-rate) re-baseline on recovery ────
// A lifetime-monotonic takeoverCount that stays elevated after the one auto-
// recovery must NOT permanently re-freeze a story that has otherwise gone quiet.
{
  // Storm trips (takeover 65>5 among others) and auto-recovers -> baselines set
  // to the current counts (incl. takeoverBaseline=65).
  const recovered = assessBreaker(STORM, T, null);
  assert.equal(recovered.action, 'auto-recover');
  assert.equal(recovered.nextState.takeoverBaseline, 65, 'takeover baseline captured on recovery');
  assert.equal(recovered.nextState.reviewRunBaseline, 131, 'review-run baseline captured on recovery');

  // Now the story goes quiet: SAME elevated takeoverCount, no new takeovers, a
  // couple more advances, reviews now passing. It must NOT re-freeze.
  const quiet: BreakerCounters = { advanceCount: 91, reviewRunCount: 135, reviewPassCount: 134, takeoverCount: 65, maxGateRepeat: 0 };
  const next = assessBreaker(quiet, T, recovered.nextState);
  assert.equal(next.tripped, false, 'F-003: unchanged elevated takeoverCount does not re-trip after recovery');
  assert.equal(next.action, 'proceed');

  // But if the takeover storm genuinely CONTINUES (>maxTakeover new takeovers past
  // the baseline), it freezes (budget already spent).
  const moreStorm: BreakerCounters = { ...quiet, takeoverCount: 65 + 6 };
  const refroze = assessBreaker(moreStorm, T, recovered.nextState);
  assert.equal(refroze.action, 'freeze', 'a genuine continued takeover storm still freezes after recovery');
  assert.match(refroze.reasons.join(' '), /takeover 6>5/, 'takeover reason reports the DELTA past baseline');
}

// ── 12. F-007: collectBreakerCounters derives counters from a real store shape ─
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-store-'));
  try {
    bumpTakeoverCount(dir); // takeover-count.json = 1
    const fakeStore = {
      storyDirPath: (_id: string) => dir,
      readStory: (_id: string) => ({ events: [
        { action: 'create' }, { action: 'advance' }, { action: 'advance' },
        { action: 'discard' }, { action: 'advance' },
      ] }),
      readReviewRuns: (_id: string) => ({ runs: [{}, {}, {}, {}] }),
      readReviewPasses: (_id: string) => ({ passes: [{}] }),
    } as unknown as import('../core/store.js').StoryStore;
    const c = collectBreakerCounters(fakeStore, 'B-test', dir);
    assert.equal(c.advanceCount, 3, 'advanceCount = # of action==="advance" events (not create/discard)');
    assert.equal(c.reviewRunCount, 4, 'reviewRunCount = review-runs ledger length');
    assert.equal(c.reviewPassCount, 1, 'reviewPassCount = review-passes ledger length');
    assert.equal(c.takeoverCount, 1, 'takeoverCount = per-story counter');

    // A store whose reads throw must fail open to zeros (never throw).
    const throwingStore = {
      storyDirPath: (_id: string) => dir,
      readStory: () => { throw new Error('boom'); },
      readReviewRuns: () => { throw new Error('boom'); },
      readReviewPasses: () => { throw new Error('boom'); },
    } as unknown as import('../core/store.js').StoryStore;
    const z = collectBreakerCounters(throwingStore, 'B-test', dir);
    assert.equal(z.advanceCount, 0, 'store read errors fail open to 0 advances');
    assert.equal(z.reviewRunCount, 0, 'store read errors fail open to 0 runs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 13. F-006: enforceConvergenceBreakerGate integration (frozen blocks, ack) ──
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-gate-'));
  try {
    const store = {
      storyDirPath: (_id: string) => dir,
      readStory: (_id: string) => ({ events: [] }),
      readReviewRuns: (_id: string) => ({ runs: [] }),
      readReviewPasses: (_id: string) => ({ passes: [] }),
    } as unknown as import('../core/store.js').StoryStore;
    const base = { command: 'story_advance', store, env: {}, isTakeoverCommand: false, storyId: 'B-gate' };

    // Healthy story: gate does not throw and writes NO state file (byte-identical).
    enforceConvergenceBreakerGate(base);
    assert.equal(readBreakerState(dir), null, 'healthy advance writes no breaker-state');

    // A non-advance, non-takeover command is ignored entirely.
    enforceConvergenceBreakerGate({ ...base, command: 'summary_set' });
    assert.equal(readBreakerState(dir), null, 'non-gated command untouched');

    // Plant a frozen state: story_advance is hard-blocked.
    writeBreakerState(dir, { advanceBaseline: 0, takeoverBaseline: 0, reviewRunBaseline: 0, reviewPassBaseline: 0, autoRecoveriesSpent: 1, frozen: true, trippedReasons: ['takeover 65>5'] });
    assert.throws(() => enforceConvergenceBreakerGate(base), /FROZEN/, 'frozen story_advance is hard-blocked');
    // F-004: a takeover-carrying command is ALSO blocked while frozen.
    assert.throws(() => enforceConvergenceBreakerGate({ ...base, command: 'story_reconcile', isTakeoverCommand: true }), /FROZEN/, 'frozen takeover command is hard-blocked');
    // A plain read-ish non-gated command still passes.
    enforceConvergenceBreakerGate({ ...base, command: 'summary_set', isTakeoverCommand: false });

    // Ack clears it: the gate then proceeds again.
    const cleared = resumeBreakerState(collectBreakerCounters(store, 'B-gate', dir));
    writeBreakerState(dir, cleared);
    enforceConvergenceBreakerGate(base); // must not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 14. F-005: resetGateFailureCounts never creates a spurious empty file ──────
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-reset-'));
  try {
    // No file yet -> reset must be a no-op (not create an empty {} file).
    resetGateFailureCounts(dir);
    assert.equal(existsSync(join(dir, 'gate-failure-counts.json')), false, 'reset does not create a file when none exists');
    // With real content -> reset clears to empty.
    bumpGateFailureCount(dir, 'story_advance', 'some gate reason');
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 1, 'bump created a count');
    resetGateFailureCounts(dir);
    assert.equal(maxGateFailureCount(readGateFailureCounts(dir)), 0, 'reset cleared the counts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 15. F-009: canonical-id guard rejects a non-canonical storyId ─────────────
// The breaker gate must never derive a story path from a path-traversal / non-
// canonical id, even if a direct caller supplies one (in production the owner-
// lease gate validates first, but this is the breaker's own defense-in-depth).
{
  const dir = mkdtempSync(join(tmpdir(), 'cbreaker-guard-'));
  try {
    let storyDirCalledWith: string | null = null;
    const store = {
      // If the guard fails, storyDirPath would be called with the evil id.
      storyDirPath: (id: string) => { storyDirCalledWith = id; return dir; },
      readStory: (_id: string) => ({ events: [] }),
      readReviewRuns: (_id: string) => ({ runs: [] }),
      readReviewPasses: (_id: string) => ({ passes: [] }),
    } as unknown as import('../core/store.js').StoryStore;

    for (const evil of ['../../outside', 'a/b', '..', 'B-bad/../../x', 'B bad']) {
      storyDirCalledWith = null;
      // Must NOT throw and must NOT derive a path from the non-canonical id.
      enforceConvergenceBreakerGate({ command: 'story_advance', storyId: evil, isTakeoverCommand: false, store, env: {} });
      assert.equal(storyDirCalledWith, null, `non-canonical storyId ${JSON.stringify(evil)} is rejected before storyDirPath`);
    }
    // A canonical id is NOT rejected by the guard (control): storyDirPath is reached.
    enforceConvergenceBreakerGate({ command: 'story_advance', storyId: 'B-canon1', isTakeoverCommand: false, store, env: {} });
    assert.equal(storyDirCalledWith, 'B-canon1', 'a canonical storyId passes the guard and derives its path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  'PASS convergence-breaker: storm trips 4 signals + auto-recover->freeze->ack, healthy control clean, '
  + 'gate-repeat digest/reset, B-bf52 digest matrix reconciled with B-cc54 — '
  + digestMatrixSummary
  + ' — plus the BIDIRECTIONAL completeness guard (an unclassified producer AND a producerless '
  + 'classification both fail; caller-supplied shapes carry resolving citations), thresholds, autopilot '
  + 'refusal, gitignored state, F-003 takeover re-baseline, collectBreakerCounters derivation, '
  + 'enforce-gate frozen-block + takeover-block, no-spurious-reset, canonical-id guard rejection',
);
