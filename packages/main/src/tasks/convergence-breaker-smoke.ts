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
//   iso-timestamp-rule       the case fails if the rule is DELETED or narrowed;
//   path-rule-overreach /
//   substantive-id-allowlist the case fails if the rule is reverted to the WIDER
//                            form main has — the slash-anywhere path rule, or
//                            `/\d+/g` with no allowlist;
//   allowlist-boundedness    the case fails if the allowlist GROWS past the
//                            lifecycle-artifact vocabulary (adding `b-` is the
//                            concrete mistake it stops), and is the inverse
//                            revert of `substantive-id-allowlist` on the same
//                            rule.
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

  type GuardRule =
    | 'path-rule-overreach'
    | 'path-rule-collapse'
    | 'substantive-id-allowlist'
    | 'allowlist-boundedness'
    | 'digit-rule-collapse'
    | 'iso-timestamp-rule'
    | 'hex-rule-collapse';
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
      // Two different open findings. A reviewer round that resolves F-012 and
      // then blocks on F-013 is progress, not a repeat.
      name: 'finding-ordinal',
      guardedBy: 'substantive-id-allowlist',
      a: 'review blocker: finding F-012 is still open and unresolved',
      b: 'review blocker: finding F-013 is still open and unresolved',
    },
    {
      // Two different review runs. Re-binding evidence from RR-002 to RR-003 is
      // a different rejection, not the same one retried.
      name: 'review-run-ordinal',
      guardedBy: 'substantive-id-allowlist',
      a: 'review pass is bound to review run RR-002, not the current run',
      b: 'review pass is bound to review run RR-003, not the current run',
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
      // this is the matrix's only single-rule guard on the ISO rule. Section 7
      // above asserts the same pair silently; this case PRINTS both literal
      // values.
      //
      // Localization caveat, measured not assumed: deleting the ISO rule makes
      // section 7's bare `assert.equal` throw FIRST, so the run aborts before
      // this matrix reports and the operator sees section 7's message ("digest
      // collapses volatile ISO timestamps to the same key") rather than a
      // grouped matrix failure. Verified separately that this case does fail on
      // its own under that revert, so the tag is accurate; the ISO rule is
      // simply the one rule whose regression is reported by an earlier section.
      name: 'iso-timestamp-only',
      guardedBy: 'iso-timestamp-rule',
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

  // A pathological oversize reason must not throw and must still key. This is a
  // SHAPE check only, and is deliberately not presented as evidence about any
  // length bound: main's design keeps the 200-character normalized prefix (a
  // round-4 draft of this story replaced it with a 16,384-character sanity bound,
  // which is reverted — B-cc54's suite depends on the prefix, and the signals
  // folded into the hash basis are what supply distinctness past it).
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

console.log('PASS convergence-breaker: storm trips 4 signals + auto-recover->freeze->ack, healthy control clean, gate-repeat digest/reset, B-bf52 digest matrix reconciled with B-cc54 (5 must-differ counter=1 + 10 must-still-collapse counter=2 breaker-trips: the C2/C3/C4 normalizer-overreach classes this story owns — slash-bearing phase pairs, in-repo relative file paths, and the checklist/finding/review-run ordinals separated by the SUBSTANTIVE_ID_PREFIXES allowlist — against machine-absolute + delimiter-attached POSIX paths, free-standing hex ids, ISO timestamps, a welded lease heartbeat age, embedded lane counts, a bare attempt ordinal, and B-cc54\'s own cross-vendor noise and story-id-digit fixtures quoted verbatim so the allowlist cannot be widened past that vocabulary from inside this suite), thresholds, autopilot refusal, gitignored state, F-003 takeover re-baseline, collectBreakerCounters derivation, enforce-gate frozen-block + takeover-block, no-spurious-reset, canonical-id guard rejection');
