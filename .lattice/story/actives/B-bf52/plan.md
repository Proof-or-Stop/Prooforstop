# Plan — B-bf52: gate-failure digest precision

## 1. Problem

`gateFailureDigest` (packages/main/src/core/convergence-breaker.ts) is the key under which
`bumpGateFailureCount` counts gate rejections. `maxGateFailureCount` feeds `assessBreaker`, which
trips the convergence breaker at a repeat count of 2 and freezes the story, requiring an interactive
human TTY acknowledgement to clear. The function's own doc comment states the contract it must
honor: reasons differing only in *incidental* detail collapse to one key. Four reproduced classes
violated that contract by collapsing *substantively* different rejections:

| Class | Cause | Observed |
| --- | --- | --- |
| C1 | the 200-character cut, applied to the normalized reason | A real DEV-gate rejection's fixed header measures 257 normalized characters (preamble plus the report's six header lines), and 433 by the point the first gap row begins in a two-trigger report, so the cut landed *before* the `Diagnostic gaps` list and every rejection for one story shared one key regardless of which gaps were outstanding |
| C2 | the path regex `/\/[^\s"']+/g` rewrites ANY slash-bearing token | `DEV/REVIEW` and `DEV/TEST` both become `dev#` |
| C3 | the digit regex `/\d+/g` runs inside identifier tokens | `CHK-001` and `CHK-002` both become `chk-#` |
| C4 | the same path regex is greedy from the first slash | `src/core/alpha.ts` and `src/core/beta.ts` both become `src#` |

C1 is what froze B-d877 (2026-07-18) and B-956f (2026-07-23): fixing gap one and then hitting gap
two read to the breaker as one gate failing twice.

## 2. What this story delivers, and what it does not

**C1 is NOT delivered by this story.** While this branch was in review, story B-cc54 landed on main
(v0.3.231) and fixed the C1 class by a better route: it leaves normalization alone, keeps the
200-character prefix, and folds structurally-extracted gap-id signals into the hash basis —
`const basis = signals.length > 0 ? JSON.stringify([prefix, signals]) : prefix` — so distinctness
comes from STRUCTURE rather than from classifying free-text tokens. Running this story's RED harness
against main after B-cc54 gives C1a and C1b PASSING. CHK-001's user-visible outcome is therefore
already true on main; this story is not what made it true, and it does not change the truncation.

**C2, C3 and C4 ARE delivered by this story.** They still fail against current main, and they are
what this branch now ships:

1. The POSIX path rule is narrowed to a *token start* — preceded by string start, whitespace, quote,
   parenthesis, bracket, colon, equals or comma. A mid-token slash (`DEV/REVIEW`) and a relative path
   (`src/core/alpha.ts`) are no longer touched, while `/Users/...` and `/private/var/...` still
   collapse to one token.
2. The digit rule is scoped by SEMANTICS rather than syntax: an ordinal that names WHICH lifecycle
   artifact failed is substantive; every other digit run is noise. A bounded allowlist over this
   repo's own artifact-id vocabulary (`chk-`, `f-`, `rp-`, `rr-`, `ab-`, `oq-`, `init-`, `req-`)
   preserves those ordinals and normalizes everything else.

## 3. Why the digit rule is semantic and not syntactic

This is the story's central finding, and it cost four review rounds to establish.

Every syntactic narrowing created a case where the breaker silently NEVER TRIPS: unit-suffixed
durations (`heartbeat 0s` vs `1s`), sentence-final numbers, review-run ids, ppid-derived session ids.
Every syntactic widening created a case where two SUBSTANTIVELY different failures FALSELY FREEZE a
story: dotted versions, identifier-attached decimals, and ports/percentages/decimal thresholds in
real test-evidence output (which reaches a DONE rejection at `packages/main/src/core/machine.ts`).
The oscillation is not a sequence of implementation mistakes — a bare number in free text is simply
not syntactically decidable as substantive or volatile. `CHK-002` and `RR-002` share a shape with
`b-1234`; `attempt 3` shares a shape with `port 3000`.

The proof that no syntactic rule can work came from the collision with B-cc54's own landed suite:
`gate-repeat-block-smoke.ts` asserts that `gate blocked for b-1234` and `b-5678` MUST collapse, which
is the identical `<word>-<digits>` shape as `CHK-001` and `CHK-002`, which this story requires to stay
distinct. Measured, not inferred: widening the number rule back to `/\d+/` is the only *syntactic*
configuration in which B-cc54's suite passes.

The allowlist resolves it because it does not classify text — it consults the repo's own vocabulary
of artifact ids, the same kind of structured knowledge B-cc54 uses in `extractGateBlockSignals`.
`b-` is not an artifact-id prefix, so B-cc54's fixture still collapses; `chk-` is, so C3 is delivered.
No file of B-cc54's is modified.

## 4. Designs this story tried and abandoned

Recorded because the review record cites them, and because each was abandoned for a measured reason
rather than a change of taste.

- **Remove the truncation, keep a 16,384-character sanity bound.** Superseded: main keeps the prefix
  deliberately and B-cc54's suite depends on it.
- **Narrow the path and digit rules syntactically** (standalone numbers, token-start paths). The path
  half survives and ships; the digit half oscillated as described in section 3.
- **Add a duration/size rule, dot-adjacency lookarounds, identifier-attachment guards on the hex
  rule.** All were repairs to the syntactic digit rule. With the allowlist they are unnecessary:
  `45` in `heartbeat 45s` carries no artifact-id prefix and normalizes to `#`, so the F-007 class does
  not recur.
- **Delete the general bare-number rule entirely** (review round 4). Its premise was that the shape
  `(attempt N)` has no real producer in this repo. B-cc54's suite falsifies that premise directly, so
  the policy is reverted in full. Two findings that this policy had superseded, F-003 (negatives) and
  F-015 (sentence-final numbers), are correspondingly un-superseded; both concerned bare numbers with
  no named producer and neither is a defect under the allowlist.
- **An attached-hash rule keyed on the presence of an a-f letter.** Cross-host review showed it both
  over-collapses a real ownership change and misses all-decimal digests; removed.

## 5. Honest residuals

- The digest still cannot distinguish a substantive from a volatile bare number outside the
  artifact-id vocabulary. Two different ports or percentages in test output still share a key. This is
  bounded in practice because the rejections that actually caused false freezes carry gap codes, and
  B-cc54's signals mechanism distinguishes those structurally.
- The allowlist is an enumeration and will not cover an artifact-id prefix added later. A prefix added
  without updating it degrades to the current behaviour, never worse.
- **There is no automatic backstop for under-normalization.** An earlier revision of this plan claimed
  the residual runaway risk was bounded by this repo's burn-alert system. That claim was false and is
  retracted: burn scanning runs only through `doctor` and `usage_sweep`, labels itself advisory,
  supplies no gate evidence, never changes exit status, cannot stop a session, and is disabled by
  `LATTICE_BURN_ALERT_RECENT_HOURS=0`. The counter also resets only on a SUCCESSFUL `story_advance`
  (`packages/main/src/cli-engine.ts`), deliberately, so nothing clears a stuck loop for free.

## 6. Process failure this story exposed

This branch sat 98 commits behind main through four review rounds and never merged. B-cc54 landed the
C1 fix during that window. Four rounds and roughly twenty findings were therefore spent refining a
text-classification approach that main had already superseded, and round 4 adopted a policy that a
landed, DONE-gating suite on main contradicts. The reconciliation was forced only when a reviewer
checked this branch against current main rather than against the branch's own merge base.

The countermeasure is not more review depth — three independent reviewers and a real cross-host codex
run all missed it for three rounds because they were all reading the same stale tree. It is to merge
main before each review round, and to re-verify the story's RED evidence against current main rather
than against the pinned baseline whenever a round begins.

## 7. Verification

- `packages/main/tests/red/red-s3-digest-collapse.mjs` asserts the corrected behaviour. C1a and C1b
  are removed from it because B-cc54 delivers that class.
- `packages/main/src/tasks/convergence-breaker-smoke.ts` carries the matrix: named cases, explicit
  `guardedBy` tags, literal printed values, and every case driving the real
  `bumpGateFailureCount` / `maxGateFailureCount` / `assessBreaker` path so the counter consequence is
  asserted rather than the hash alone. It includes two cases that reproduce B-cc54's own fixtures, so
  this story cannot regress what B-cc54 requires from inside its own suite.
- `packages/main/dist/tasks/gate-repeat-block-smoke.js`, B-cc54's suite, must pass byte-unmodified.
- Each changed rule, reverted alone, must fail a named subset of the matrix and leave the rest passing.
