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
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessBreaker,
  resolveConvergenceThresholds,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  resumeBreakerState,
  isInteractiveAckAllowed,
  gateFailureDigest,
  normalizeGateReason,
  extractGateBlockSignals,
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
  assert.equal(resolveConvergenceThresholds({ PROOF_OR_STOP_CONVERGENCE_MAX_ADVANCE: '5' }).maxAdvance, 5, 'override');
  for (const bad of ['abc', '-1', '1e9', '', '  ']) {
    assert.equal(
      resolveConvergenceThresholds({ PROOF_OR_STOP_CONVERGENCE_MAX_ADVANCE: bad }).maxAdvance,
      20,
      `garbage ${JSON.stringify(bad)} falls back to default`,
    );
  }
  // With MAX_ADVANCE=5 a story trips at 6 advances (delta 6>5) but not at 5.
  const th = resolveConvergenceThresholds({ PROOF_OR_STOP_CONVERGENCE_MAX_ADVANCE: '5' });
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
//                       risk: a normalizer that is too fine-grained hands a stuck
//                       agent back the unbounded retry loop the breaker exists to
//                       stop.
//
// Every case drives the REAL bumpGateFailureCount / maxGateFailureCount path in
// its own throwaway story dir and asserts the resulting COUNTER (and, for the
// collapse lane, that assessBreaker still trips), because the operator-visible
// failure is a frozen story, not a string mismatch.
//
// ── SCOPE: WHAT THIS STORY CHANGES AGAINST MAIN, AND WHAT IT DOES NOT ─────────
//
// Exactly TWO things change; every other rule of the chain (`0x`, the
// `\b[0-9a-f]{7,}\b` hex rule, the ISO timestamp rule, the bare `/\d+/g` digit
// rule, the whitespace fold, the 200-character prefix on the signals branch and
// the signals-based hash basis) is byte-identical to main:
//
//   POSIX path rule   narrowed to TOKEN START, fixing C2 (`DEV/REVIEW` vs
//                     `DEV/TEST`) and C4 (`src/core/alpha.ts` vs `beta.ts`), which
//                     main's `\/[^\s"']+` collapsed by rewriting from ANY slash in
//                     a token;
//   prefix cut        made SIGNALS-CONDITIONAL (F-031), so a rejection carrying NO
//                     structured signal is bounded at 16,384 characters instead of
//                     200 and its late divergence reaches the hash. A rejection
//                     that DOES carry signals keeps B-cc54's 200-character prefix
//                     exactly, so no key B-cc54 landed is rekeyed.
//
// The story ALSO originally targeted the 200-character truncation in general (its
// C1a/C1b classes: every ProofStory DEV-gate rejection for one story collapsed onto
// one key because the invariant banner alone exceeds the cut). B-cc54 landed on main
// first and fixed that class by a BETTER route — it leaves the truncation and the
// normalization rules alone and folds structurally-extracted gap-id signals into the
// hash basis, so distinctness comes from STRUCTURE rather than from classifying
// free-text tokens. Those cases are owned by tasks/gate-repeat-block-smoke.ts
// (B-cc54's suite, a registered doneRequiredCommand) and are deliberately NOT
// duplicated here.
//
// ── C3 IS NOT DELIVERED, AND THIS MATRIX IS WHERE THAT IS RECORDED (F-058) ────
//
// C3 was "`CHK-001` and `CHK-002` are two different gate failures, so they must not
// share one counter key". It is withdrawn, on a PROOF that it cannot be done from
// message text — not on a budget, a deferral or a preference.
//
// core/machine.ts:1190 renders `Cannot enter DONE: test ${evidence.result}:
// ${evidence.output}`, i.e. it interpolates RAW third-party test output into the
// text the digest keys on. In that channel the bare token `bug-2` — an ordinary TAP
// subtest name or a parameterized-test label — is TEXTUALLY IDENTICAL to a bare
// artifact ordinal. `not ok 1 - bug-2 reproducer still red` and
// `Cannot enter DONE: 1 unfixed bug(s): BUG-002` present the SAME string shape to
// the normalizer, so any rule that recognises the second recognises the first, and
// any rule that refuses the first refuses the second. There is no third option, and
// eight rounds of pattern refinement (rounds 7-14: a wider lookbehind, a token-start
// anchor, a balanced-wrapper rule, a deleted punctuation strip, a pure-ordinal body)
// are eight measurements of that, not eight oversights.
//
// The tie breaks toward COLLAPSING, because for a circuit breaker over-recognising
// is the dangerous direction: too fine a key lets a stuck agent mint a fresh key on
// every retry and the brake never fires, while too coarse a key makes it fire early
// at the cost of one human acknowledgement. That is the same principle every
// exclusion decision on this story used (`rr-`, `rp-`, `rl-` and `i-` were all
// excluded because a retry re-mints them), and applied consistently it removes the
// artifact-id allowlist itself.
//
// Three cases in the collapse lane are the standing record of that decision, and
// they are meant to be read TOGETHER: `embedded-test-output-third-party-label`
// (codex's `bug-2`/`bug-5` reproducer), `checklist-ordinal` (C3's headline pair) and
// `unfixed-bug-ordinal` (the same class from a real first-party producer,
// core/machine.ts:1195). The first collapses because collapsing it is the fail-safe
// choice; the other two collapse because they are the SAME STRING SHAPE and cannot
// be separated from it. Delivering C3 needs a different design — the digest
// consulting STORY STATE rather than message text, so `CHK-002` is recognised
// because this story HAS such a checklist item — which is named as a follow-up in
// the F-058 note in core/convergence-breaker.ts and is out of scope here.
//
// ── THE ROUND-15 RETIREMENT REGISTER (F-058) ──────────────────────────────────
//
// The substantive-id apparatus is deleted from core/convergence-breaker.ts — the
// allowlist, the id pattern, the whole-token walk and the placeholder encode/decode
// — and with it go 46 matrix cases and 11 guard tags whose only purpose was to
// police that apparatus. They are retired rather than left passing, because a case
// that can no longer fail for the reason its tag names is a false attestation; the
// full round-14 set is in git history at the round-14 commit if a later reader wants
// the leak fixtures themselves. What left, by group:
//
//   the allowlist group        every case whose distinctness came from a protected
//                              ordinal (`checklist-ordinal-at-reason-start`,
//                              `checklist-not-done-final-bare-id`,
//                              `blocking-finding-cited-id-within-window`) plus the
//                              boundedness guard `bcc54-story-id-digits`. Two of the
//                              lane's cases SURVIVE, re-decided into the collapse
//                              lane (`checklist-ordinal`, `unfixed-bug-ordinal`), and
//                              `bcc54-story-id-digits` survives as a digit-rule case;
//                              tags `substantive-id-allowlist`, `allowlist-boundedness`;
//   the token-walk group       the head/tail anchor cases and every welded-token case
//                              (`embedded-test-output-hyphen-compounds`,
//                              `…-slash-joined-names`, `…-doubled-prefix`, the five
//                              welded-tail cases); tags
//                              `substantive-id-token-head-exact`,
//                              `substantive-id-token-tail-exact`,
//                              `substantive-id-pure-ordinal-body`;
//   the reduction group        the thirteen attached-punctuation cases; tag
//                              `substantive-id-no-reduction`;
//   the composite group        `verification-intent-ref-lane-suffix` and
//                              `embedded-test-output-label-qualified-id`; tag
//                              `substantive-id-colon-composite-cost`;
//   the retired-prefix group   `bare-finding-ordinal` and
//                              `embedded-test-output-bare-requirement-ordinal`; tag
//                              `retired-prefix-not-allowlisted`;
//   the bookkeeping group      `stale-review-run-evidence` retires (its `rr-` pair
//                              collapsed on the digit rule alone once the allowlist
//                              was gone, so it duplicated `review-loop-ordinal`);
//                              `review-loop-ordinal` and `init-check-issue-ordinal`
//                              SURVIVE, retagged onto the digit rule that now
//                              collapses them; tags
//                              `review-bookkeeping-not-allowlisted`,
//                              `pinned-behaviour-documentation`.
//
// Section 7c went with them: it was the BIDIRECTIONAL completeness guard that
// reconciled the allowlist against the artifact-id prefixes production source emits,
// and it is deleted rather than kept, because a guard policing a set that no longer
// exists asserts a contract nobody has.
//
// The F-033 window residual is REBUILT rather than retired. It used to be measured
// with a cited CHECKLIST ORDINAL past the prefix cut; that ordinal now collapses on
// the digit rule, so the pair would have collapsed for a reason that has nothing to
// do with the window and its tag would have been a lie. It is rebuilt on a cited
// in-repo PATH — which the narrowed path rule preserves — so the window is again the
// only thing deciding.
//
// ── THE TAG VOCABULARY ────────────────────────────────────────────────────────
//
// `guardedBy` names the one normalizer rule each case — in BOTH lanes — is bound to.
// Reverting that rule alone must fail exactly the cases naming it and leave the rest
// passing, so a regression localizes to the rule that caused it rather than failing
// as one opaque block. A tag names a rule AND the DIRECTION in which the case
// depends on it, because the two directions have OPPOSITE reverts:
//
//   path-rule-collapse / digit-rule-collapse / hex-rule-collapse /
//   iso-or-digit-rule-collapse
//                            the case fails if the rule is DELETED or narrowed;
//   path-rule-overreach      the case fails if the path rule is reverted to the
//                            WIDER slash-anywhere form main has. It depends on that
//                            rule being NARROW, not on it existing: deleting the
//                            rule outright leaves these cases passing;
//   signals-conditional-prefix
//                            F-031: fails if the prefix cut is reverted to an
//                            unconditional 200-char slice, so a signal-less pair
//                            diverging past 200 collapses again;
//   signals-fold             fails if the (prefix, signals) fold is collapsed to
//                            `prefix` alone — B-cc54's C1 mechanism, exercised from
//                            inside this suite by the ONLY pair here that reaches it;
//   prefix-window-residual   F-033, the ACCEPTED residual: fails if the
//                            200-character cut on the SIGNALS branch is WIDENED. It
//                            is the direction B-cc54's CHK-002:adversarial:1 also
//                            depends on, and it marks where this branch stops being
//                            better than main (it never becomes worse).
//
// MEASURED LOCALIZATION, re-derived from scratch in round 15 against the current
// case set by mutating the BUILT normalizer in a detached, freshly built worktree's
// dist and reading back the failing case names. NOT ONE ROW IS CARRIED FORWARD from
// round 14: the matrix lost 46 cases this round, so a carried-forward row would
// describe a matrix that no longer exists.
//
//   digit rule DELETED        fails 10 of the 16 collapse cases, and it also fails
//                             B-cc54's own suite: `bare-attempt-ordinal`,
//                             `bcc54-cross-vendor-noise`, `bcc54-story-id-digits`,
//                             `checklist-ordinal`,
//                             `embedded-test-output-third-party-label`,
//                             `init-check-issue-ordinal`, `lane-counts`,
//                             `lease-heartbeat-age`, `review-loop-ordinal` and
//                             `unfixed-bug-ordinal`. THREE NAMES ARE ABSENT AND EACH
//                             ABSENCE IS THE POINT: `iso-timestamp-only` does NOT
//                             fail, because the ISO rule still collapses that pair
//                             on its own (the two rules are redundant for a
//                             pure-digit timestamp, which is the same measurement
//                             the `iso-or-digit-rule-collapse` tag rests on);
//                             `blocking-finding-cited-path-past-window` does not,
//                             because it collapses on the WINDOW, which no
//                             normalizer rule reaches; and the three
//                             `path-rule-collapse` cases do not, because their pairs
//                             differ in a machine path rather than in a digit run;
//   hex rule DELETED          fails `hex-id` and `bcc54-cross-vendor-noise`;
//   path rule DELETED         fails the three `path-rule-collapse` cases and
//                             `bcc54-cross-vendor-noise`;
//   path rule WIDENED to
//   main's slash-anywhere     fails exactly `phase-pair`, `in-repo-file-path`,
//                             `signal-less-long-rejection` and
//                             `blocking-finding-cited-path-within-window`;
//   ISO rule deleted ALONE    fails NOTHING (it is redundant with the digit rule for
//                             a pure-digit timestamp — see `iso-timestamp-only`).
//                             LOCALIZATION CAVEAT, re-measured rather than carried:
//                             deleting BOTH the ISO and the digit rule does not name
//                             `iso-timestamp-only` either — it aborts the run at
//                             section 7's own ISO assertion, which sits ABOVE this
//                             matrix. The disjunction the tag names therefore has no
//                             mutation that reaches the matrix at all, and the tag
//                             says so instead of implying a guarantee;
//   prefix cut made
//   UNCONDITIONAL 200         fails exactly `signal-less-long-rejection`;
//   prefix cut WIDENED to 592
//   on the signals branch
//   (592 is the widest legal
//   value — B-cc54's
//   CHK-002:adversarial:1
//   breaks at 593)            fails exactly
//                             `blocking-finding-cited-path-past-window`, with
//                             B-cc54's suite still GREEN;
//   prefix cut WIDENED to 593
//   on the signals branch     fails the same one case AND breaks B-cc54's suite.
//                             This row is why "592 is the widest legal value" is a
//                             measurement rather than an assertion: 592 and 593 were
//                             both run, and the pair of results is the bound;
//   signals FOLD collapsed
//   to prefix alone           fails exactly `proofstory-gap-signal-set` (and
//                             B-cc54's own suite).
//
// Localization therefore works by GROUP, which is what the grouped failure report
// prints: a single group means that rule regressed, and a case failing alone means
// the rule its tag names.
//
// The closing banner's inventory is DERIVED from these arrays, never hand-typed: a
// hand-written count is the first thing to go stale when a case is added, and a
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
  // exactly the runaway the breaker must catch. `45` and `52` both normalize to
  // `#` and the unit letter is left alone, byte-for-byte as main behaves.
  // F-011: `storyScopedMutating` is verbatim, not a paraphrase —
  // formatNonOwnerError interpolates `ctx.ownershipClass`, and story_advance's
  // real class is `storyScopedMutating` (core/command-policy.ts:152, one of the
  // five OwnershipClass values at :66-71). The former `mutating` is not a member
  // of that enum and never appears in a rendered message.
  const leaseNonOwner = (age: string): string => // core/story-owner-lease.ts:616-640
    `B-bf52 is owned by Proof-or-Stop session main-agent-s2s1-stable-f93ff408f3, heartbeat ${age} ago ` +
    `(owner cwd: /Users/jek/Documents/Work/proofbound/.worktrees/B-bf52). "story_advance" is an owner-gated storyScopedMutating command, ` +
    `so this session (worker-s2s1) cannot run it. The owner lease is still ACTIVE. ` +
    `Use read-only commands, wait for the owner, or rerun with --forceTakeover to seize the active lease (a deliberate human override).`;

  // ── B-cc54's own fixtures, quoted VERBATIM ─────────────────────────────────
  // CC54_NOISE_A/B are CHK-001:adversarial:0 and CC54_STORY_A/B are
  // CHK-002:adversarial:2 of tasks/gate-repeat-block-smoke.ts. They are
  // duplicated here deliberately rather than imported: B-cc54's suite is a
  // separate landed contract, and this story must be structurally unable to
  // regress it from inside its OWN matrix.
  const CC54_NOISE_A = 'GATE blocked at /Users/jek/x/y.ts 2026-07-23T12:00:00Z id a1b2c3d4e5f6 attempt 7';
  const CC54_NOISE_B = 'gate BLOCKED at /var/tmp/other.ts 2026-01-02T03:04:05Z id f6e5d4c3b2a1 attempt 91';
  const CC54_STORY_A = 'gate blocked for b-1234';
  const CC54_STORY_B = 'gate blocked for b-5678';

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

  // ── The real DONE test-evidence rejection ──────────────────────────────────
  // core/machine.ts:1190 returns `Cannot enter DONE: test ${evidence.result}:
  // ${evidence.output}` — it embeds the RAW test output, so arbitrary third-party
  // text reaches the digest. This is the channel every one of the eight leaks in
  // the deleted substantive-id guard was found on, and it is the channel the F-058
  // proof is about: a TAP subtest name and an artifact ordinal arrive here as the
  // same kind of token.
  const doneTestFailureBareToken = (token: string): string => [
    'Cannot enter DONE: test FAIL: # tests 1',
    '# pass 0',
    '# fail 1',
    `not ok 1 - ${token} reproducer still red`,
  ].join('\n');

  // ── The real INIT_CHECK reviewer-issue rejection ───────────────────────────
  // core/machine.ts:1042-1046, composed as it renders. `${issue.id}` is the
  // reviewer's self-assigned id, whose declared shape is `I-1` (the init_check_set
  // schema in cli/command-catalog.ts:2315, where it is OPTIONAL free text).
  const initCheckBlockingIssues = (agentId: string, ids: string[]): string => [
    'Cannot enter INIT_CHECK: init-check reviewer recorded high/critical issues; you must fix them and re-run the corresponding reviewer first. [init_check_blocking_issues]',
    ...ids.map((id) => `  - ${agentId}: high ${id} the story boundary is not decidable from the description`),
  ].join('\n');

  // ── The real open-review-loop rejection ────────────────────────────────────
  // core/machine.ts:640-661 builds `active review loop(s): loopId=${loopId}, ...`
  // and core/machine.ts:1192 wraps it as `Cannot enter TEST: ${message} [${code}]`.
  // handlers/review-loop.ts:141 mints the id as `${storyId}:RL-${NNN}`.
  const openReviewLoop = (loopOrdinal: string): string =>
    `Cannot enter TEST: active review loop(s): loopId=B-bf52:${loopOrdinal}, decision=revise, ` +
    `nextAction={phase=DEV, owner=proof-or-stop-implementer} [open_review_loop]`;

  // ── The real blocking-finding rejection, CITING A CHANGED PATH (F-033) ─────
  // core/machine.ts:753-756 renders every open blocking finding, joined by '; ',
  // and core/machine.ts:1181 wraps the whole list as
  // `Cannot enter TEST: ${message} [${code}]`. `${f.desc}` is reviewer-written free
  // text in which naming the offending FILE is routine.
  //
  // HOW MANY findings are open is the one realistic parameter, and it is what moves
  // the cited path across the 200-character prefix window: with no other finding
  // open the path lands well inside it, with two the identical path lands outside.
  // That builds both halves of the F-033 residual out of ONE real producer rather
  // than out of a contrived pad, and both halves carry the SAME non-empty signal set
  // (`review_finding_blocking`), so the window — not the signal fold — is what
  // decides. The fixture precondition after the matrix asserts the two character
  // positions rather than assuming them.
  //
  // IT CITES A PATH, NOT A CHECKLIST ORDINAL, AND THAT IS THE ROUND-15 REBUILD
  // (F-058). Through round 14 this pair varied `CHK-001` vs `CHK-002`. With the
  // artifact-id allowlist deleted those two normalize to the same `chk-#`, so the
  // pair would collapse at EVERY window and could no longer measure the cut — the
  // same defect that retired the `SEP-…` pair it replaced in round 13. A repo-
  // relative path is preserved by the narrowed path rule, so the window is again the
  // only thing deciding.
  const blockingFindingsCitingPath = (leadingCount: number, citedPath: string): string => {
    const rows = [];
    for (let i = 0; i < leadingCount; i += 1) {
      rows.push(`B-bf52:F-0${20 + i} [high] a separate blocker that is held constant in this fixture`);
    }
    rows.push(`B-bf52:F-012 [high] no passing verification evidence for the change to ${citedPath}`);
    return `Cannot enter TEST: ${rows.length} open blocking finding(s): ${rows.join('; ')} [review_finding_blocking]`;
  };

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
  type GuardRule =
    | 'path-rule-overreach'
    | 'path-rule-collapse'
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
    | 'signals-fold';
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
      // F-033, the WITHIN-window half of the accepted residual, and C4 reached
      // through a REAL producer rather than an illustrative sentence.
      //
      // core/machine.ts:753-756 renders every open blocking finding and :1181
      // appends the bracketed reason code, so a path named in the LAST finding's
      // description diverges at normalized character 124, well inside the
      // 200-character prefix cut, and the pair keys apart. Its past-window twin
      // (`blocking-finding-cited-path-past-window`, the SAME producer with two more
      // findings open) is where that stops being true; the fixture precondition
      // after the matrix asserts both character positions.
      //
      // Localization: it fails on the same single mutation as the two cases above —
      // the path rule widened back to main's slash-anywhere form, which turns both
      // sides into `src#`.
      name: 'blocking-finding-cited-path-within-window',
      guardedBy: 'path-rule-overreach',
      a: blockingFindingsCitingPath(0, 'src/core/alpha.ts'),
      b: blockingFindingsCitingPath(0, 'src/core/beta.ts'),
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
      a: 'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate',
      b: 'validation lock held at /private/var/folders/zz/T/proof-or-stop-abc/.proof-or-stop/locks/validate',
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
      // B-cc54 CHK-002:adversarial:2, verbatim, and half of the F-058 proof stated
      // as a test: `b-1234` is identifier-attached in EXACTLY the way `CHK-001` is,
      // and a landed gate contract requires it to COLLAPSE. Round 6 of this story
      // read that correctly — no syntactic rule separates the two — and then tried
      // to separate them SEMANTICALLY with an id allowlist. F-058 is the finding
      // that the semantic route fails too, for a reason this case cannot show on
      // its own: see `embedded-test-output-third-party-label` below.
      name: 'bcc54-story-id-digits',
      guardedBy: 'digit-rule-collapse',
      a: CC54_STORY_A,
      b: CC54_STORY_B,
    },
    {
      // F-058, AND THE PERMANENT RECORD OF WHY C3 IS NOT DELIVERED. This is
      // cross-host codex's exact reproducer, kept verbatim.
      //
      // `not ok 1 - bug-2 reproducer still red` is an ordinary TAP subtest name — or
      // a parameterized-test label — in exactly the raw third-party output
      // core/machine.ts:1190 interpolates into `Cannot enter DONE: test
      // ${evidence.result}: ${evidence.output}`.
      //
      // THIS SHAPE IS TEXTUALLY INDISTINGUISHABLE FROM AN ARTIFACT ORDINAL. Read it
      // beside `unfixed-bug-ordinal` two cases below, which is a REAL first-party
      // render (core/machine.ts:1195, `Cannot enter DONE: 1 unfixed bug(s):
      // BUG-002`): lower-cased and whitespace-delimited, the token under decision is
      // the same string in both. No property of the message text separates them,
      // because there is no difference in the message text to find. Any rule that
      // recognised the artifact ordinal would recognise this label too — which is
      // precisely what happened, eight times, in rounds 7-14.
      //
      // COLLAPSING IS THE FAIL-SAFE CHOICE FOR A BRAKE. If this pair keyed apart, a
      // stuck agent whose embedded test output carries a varying label would mint a
      // fresh counter key on every retry and the breaker would never fire — the
      // unbounded loop this module exists to stop. Collapsing it makes the breaker
      // fire early on two genuinely different failures instead, which costs one
      // human acknowledgement. This case asserts the second, and it fails the moment
      // anything in core/convergence-breaker.ts starts recognising a
      // `<stem>-<digits>` token again.
      name: 'embedded-test-output-third-party-label',
      guardedBy: 'digit-rule-collapse',
      a: doneTestFailureBareToken('bug-2'),
      b: doneTestFailureBareToken('bug-5'),
    },
    {
      // C3's headline pair, RE-DECIDED into this lane in round 15 (F-058). Through
      // round 14 this was the first must-differ case of the matrix: `CHK-001` and
      // `CHK-002` name two different checklist items, so clearing one and tripping
      // on the next is progress and must not read as one gate failing twice. That
      // reading is still TRUE about the world; it is simply not decidable from the
      // message, because `chk-001` is the same shape as the third-party label above.
      //
      // It stays in the matrix — rather than being deleted with the rest of the
      // allowlist group — because the COST of the F-058 decision has to be visible
      // in the suite and not only in prose. This is the false freeze the story set
      // out to fix and did not.
      name: 'checklist-ordinal',
      guardedBy: 'digit-rule-collapse',
      a: 'verification gap: missing evidence coverage for CHK-001',
      b: 'verification gap: missing evidence coverage for CHK-002',
    },
    {
      // The same cost, from a REAL first-party producer. core/machine.ts:1195
      // renders `Cannot enter DONE: ${n} unfixed bug(s): ${ids}`, and this is the
      // exact shape the F-058 proof compares the third-party label against: the
      // ordinal here is BARE, purely numeric and leading-zeroed, which is the most
      // id-like a token in this tree ever gets — and it is still the same string
      // shape as `bug-2`. RE-DECIDED into this lane in round 15 with
      // `checklist-ordinal`.
      name: 'unfixed-bug-ordinal',
      guardedBy: 'digit-rule-collapse',
      a: 'Cannot enter DONE: 1 unfixed bug(s): BUG-001',
      b: 'Cannot enter DONE: 1 unfixed bug(s): BUG-002',
    },
    {
      // A review-loop id, from the real producer at core/machine.ts:640-661 wrapped
      // by :1192. It must collapse for a reason that survives F-058 independently: a
      // review loop is RE-MINTED on retry, so a host that closes one loop, opens
      // another and retries would mint a fresh key every time and the breaker would
      // never trip. The cost — two loops opened for genuinely different triggers
      // share one key — is the fail-safe direction for a breaker.
      //
      // RETAGGED IN ROUND 15 (F-058). Through round 14 this carried
      // `pinned-behaviour-documentation`, because with an id allowlist in place it
      // took three coordinated mutations to make it fail. With the allowlist deleted
      // it is a plain digit-rule case: deleting `/\d+/g` fails it.
      name: 'review-loop-ordinal',
      guardedBy: 'digit-rule-collapse',
      a: openReviewLoop('RL-001'),
      b: openReviewLoop('RL-002'),
    },
    {
      // An INIT_CHECK reviewer-issue id, from the real producer at
      // core/machine.ts:1042-1046. Same class as the review loop above, and the
      // exclusion argument is the sharpest in the tree: cli/command-catalog.ts:2315
      // declares `issue.id` OPTIONAL and reviewer-self-assigned free text,
      // handlers/init-check.ts:139-142 rewrites the calling agent's issues wholesale
      // on every init_check_set, and the remediation this very rejection prints —
      // "re-run the corresponding reviewer" — is the action that renumbers them. An
      // id that the demanded retry re-mints must collapse, or the retry never
      // accumulates.
      //
      // RETAGGED IN ROUND 15 (F-058) from `review-bookkeeping-not-allowlisted`,
      // which named a set that no longer exists.
      name: 'init-check-issue-ordinal',
      guardedBy: 'digit-rule-collapse',
      a: initCheckBlockingIssues('product-reviewer', ['I-1']),
      b: initCheckBlockingIssues('product-reviewer', ['I-2']),
    },
    {
      // F-033, the ACCEPTED residual, pinned in its own direction.
      //
      // Same producer and same cited paths as the must-differ
      // `blocking-finding-cited-path-within-window` case; the ONLY change is two
      // more open blocking findings in front of the cited path, which pushes it past
      // the 200-character prefix cut (measured: normalized character 124 with none
      // in front, 274 with two). Both sides extract the IDENTICAL signal set
      // (`review_finding_blocking`), so nothing else can tell them apart and they
      // collapse.
      //
      // This is asserted as COLLAPSE because that is what the code does, and saying
      // so here is the point: it marks exactly where the improvement stops. main
      // collapses this pair too — main truncates at 200 unconditionally AND rewrites
      // every slash-bearing token from its first slash — and main additionally
      // collapses the within-window pair that this branch keeps apart. So the change
      // is strictly better inside the window and equal outside it: bounded, never
      // regressive.
      //
      // Widening the window is not IMPOSSIBLE, and an earlier revision of this
      // comment overstated it as unavailable (F-042). MEASURED, both bounds:
      // B-cc54's CHK-002:adversarial:1 requires a signal-free tail past its banner
      // to leave the key UNCHANGED, and that banner fixture normalizes to exactly
      // 592 characters — so a cut of 593 or more admits the noise tail and breaks
      // B-cc54's suite, while any cut from 275 (this pair's divergence point) up to
      // 592 would fix the case illustrated HERE without breaking B-cc54 at all. The
      // honest statement is therefore "a 318-character window exists and is not
      // taken", not "widening is unavailable".
      //
      // 200 is kept anyway, for the reason stated in core/convergence-breaker.ts a
      // few lines above the cut: on the signals branch every key must stay
      // BYTE-IDENTICAL to the ones B-cc54 landed. Buying a bounded residual back at
      // the cost of rekeying every ProofStory rejection in the system is not a trade
      // this story gets to make for a residual that is already never worse than main.
      name: 'blocking-finding-cited-path-past-window',
      guardedBy: 'prefix-window-residual',
      a: blockingFindingsCitingPath(2, 'src/core/alpha.ts'),
      b: blockingFindingsCitingPath(2, 'src/core/beta.ts'),
    },
    {
      // A bare ordinal carries no artifact prefix, so it is noise under every
      // revision this story ever shipped. This is the shape B-cc54's noise fixture
      // embeds; it is asserted separately here so a digit-rule deletion is
      // attributable without decoding the noise pair.
      name: 'bare-attempt-ordinal',
      guardedBy: 'digit-rule-collapse',
      a: 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)',
      b: 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 41)',
    },
    {
      // The real non-owner rejection, varying ONLY the welded heartbeat age.
      // `45s` / `52s`: both become `#s`. If they did not, the most common
      // ownership-contention message in the system would mint a fresh key on every
      // retry and a genuine livelock would never accumulate — the breaker's whole
      // purpose.
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
  // rather than with the other preconditions above: it asserts a tight character-
  // index boundary around the 200-char cut, and a rule regression that moves both
  // sides of the pair would throw HERE and abort the whole run before the matrix
  // could localize itself. Placed after, a rule regression localizes to its own
  // cases exactly as this section promises, and the measurement is still pinned on
  // every green run.
  {
    // F-033 residual, MEASURED. One real producer, two open-finding counts, and
    // the 200-character prefix window falls between them: with no other finding
    // open the cited PATH lands inside the window and the pair keys apart, with two
    // more findings in front of it the identical path lands outside and the pair
    // collapses. Both pairs carry the SAME non-empty signal set
    // (`review_finding_blocking`), so B-cc54's mechanism supplies no distinctness in
    // either case and the window alone decides.
    //
    // These assertions pin the measurement itself, so any later edit to this
    // fixture's wording or finding count that moves either side across the boundary
    // fails HERE, naming the character index, instead of silently turning one of the
    // two matrix cases into a copy of the other.
    //
    // The last assertion pins the thing the whole pair depends on: the cited path
    // must SURVIVE normalization. If the path rule is ever widened back, both sides
    // become `src#`, the within-window half stops keying apart, and this block
    // reports it as a divergence index at the end of the string.
    const divergeAt = (a: string, b: string): number => {
      const na = normalizeGateReason(a);
      const nb = normalizeGateReason(b);
      let i = 0;
      while (i < Math.min(na.length, nb.length) && na[i] === nb[i]) i += 1;
      return i;
    };
    const withinA = blockingFindingsCitingPath(0, 'src/core/alpha.ts');
    const withinB = blockingFindingsCitingPath(0, 'src/core/beta.ts');
    const pastA = blockingFindingsCitingPath(2, 'src/core/alpha.ts');
    const pastB = blockingFindingsCitingPath(2, 'src/core/beta.ts');
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
      normalizeGateReason(withinA), /src\/core\/alpha\.ts \[review_finding_blocking\]$/,
      'prefix-window fixture: the cited path must survive normalization intact, or the pair measures the path rule rather than the window',
    );
    console.log(
      `  fixture-precondition prefix-window: same producer (1 vs 3 open blocking findings), ` +
      `identical signal sets, cited path diverges at char ${withinAt} (within) vs ${pastAt} (past) around the 200-char cut`,
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
  assert.equal(isInteractiveAckAllowed({ PROOF_OR_STOP_AUTOPILOT: '1' }, true), false, 'autopilot marker => refused even at a TTY');
  assert.equal(isInteractiveAckAllowed({ CI: 'true' }, true), false, 'CI marker => refused');
  assert.equal(isInteractiveAckAllowed({ PROOF_OR_STOP_AUTOPILOT: '0' }, true), true, 'falsey autopilot marker => allowed');
}

// ── 10. Gitignored-artifact registration (F-008 DONE-merge safety) ────────────
{
  for (const f of ['breaker-state.json', 'takeover-count.json', 'gate-failure-counts.json']) {
    const entry = findRuntimeArtifactEntry(`.proof-or-stop/story/actives/B-bbaf/${f}`);
    assert.ok(entry, `${f} is registered as a runtime artifact`);
    assert.equal(isMaterialExcludedRuntimeArtifactPath(`.proof-or-stop/story/actives/B-bbaf/${f}`), true, `${f} is material-hash excluded`);
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
      readConvergenceProgress: (_id: string) => null,
    } as unknown as import('../core/store.js').StoryStore;
    const base = { command: 'story_advance', store, env: {}, isTakeoverCommand: false, storyId: 'B-gate' };

    // Healthy story: gate does not throw and writes NO state file (byte-identical).
    enforceConvergenceBreakerGate(base);
    assert.equal(readBreakerState(dir), null, 'healthy advance writes no breaker-state');

    // A non-advance, non-takeover command is ignored entirely.
    enforceConvergenceBreakerGate({ ...base, command: 'summary_set' });
    assert.equal(readBreakerState(dir), null, 'non-gated command untouched');

    // Historical counter freezes do not prove two complete stagnant review epochs.
    writeBreakerState(dir, { advanceBaseline: 0, takeoverBaseline: 0, reviewRunBaseline: 0, reviewPassBaseline: 0, autoRecoveriesSpent: 1, frozen: true, trippedReasons: ['takeover 65>5'] });
    assert.doesNotThrow(() => enforceConvergenceBreakerGate(base), 'legacy count-only freeze is diagnostic without completed epochs');
    // The same epoch-based decision applies to takeover-carrying commands.
    assert.doesNotThrow(() => enforceConvergenceBreakerGate({ ...base, command: 'story_reconcile', isTakeoverCommand: true }), 'legacy count-only takeover freeze is diagnostic');
    // The sole human recovery command can carry a takeover to acquire a newly
    // created terminal session's lease; its own handler still validates TTY,
    // --ack, and a reason before clearing the breaker.
    enforceConvergenceBreakerGate({ ...base, command: 'story_resume', isTakeoverCommand: true });
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
      readConvergenceProgress: (_id: string) => null,
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
  + ' — plus thresholds, autopilot '
  + 'refusal, gitignored state, F-003 takeover re-baseline, collectBreakerCounters derivation, '
  + 'shared-gate count-only freeze migration, no-spurious-reset, canonical-id guard rejection',
);
