# B-2c03 Plan — claimsShrinkage path-token false positive

## Problem

The lightweight DONE intent-equivalence path (`evaluateDoneIntentEquivalence`,
`packages/main/src/core/proofstory.ts` ~line 1427) joins
`summary.changes + actualTranscript + outcomeDiff + limitations` into
`narrowingText` and tests
`/\b(?:partial|narrow(?:er|ed)?|shrink(?:age|s|ing)?|out of scope|not covered|deferred|remaining|excluded)\b/i`.
JS `\b` treats `-`, `/`, and `.` as word boundaries, so literal file names such
as `core/partial-done-recovery.ts` match `\bpartial\b` and block DONE with
`unconfirmed_single_outcome_shrinkage` (observed on B-d6a0, 2026-07-09).

## Execution order

1. **CHK-002 (RED, done in PLAN)** — regression cases added to
   `packages/main/src/tasks/proofstory-intent-hardening-smoke.ts` before the fix:
   - file-name summary (`core/partial-done-recovery.ts`) must NOT trip the gap;
   - backticked span + slash path must NOT trip;
   - prose shrinkage claim next to a path token MUST still trip;
   - bare `remaining` about pre-existing failures must NOT trip;
   - `remaining <scope-noun>` MUST still trip.
   RED observed: `node packages/main/dist/tasks/proofstory-intent-hardening-smoke.js`
   fails with "a summary naming core/partial-done-recovery.ts is not a shrinkage
   claim (B-d6a0 false positive)". Bound in red-evidence.json.
2. **CHK-001 (DEV)** — add a small pure sanitizer applied to `narrowingText`
   before the trigger regex:
   - strip fenced/backticked spans (```...``` and `...`);
   - strip whitespace-delimited tokens containing `/` (path segments);
   - strip tokens of shape `word(-or-.word)+` (hyphenated/dotted file-name or
     identifier tokens, e.g. `partial-done-recovery.ts`, `name.test.mjs`).
   Replacement is a single space so surrounding prose is preserved.
3. **CHK-003 (DEV)** — implement the PLAN decision on `remaining` (below).
4. Rebuild, run the smoke GREEN, run the package test suite, commit, REVIEW.

## CHK-003 decision (made in PLAN)

**NARROW** bare `remaining` to shrinkage-flavored phrases:
`remaining` followed by a scope noun
(`work|scope|item(s)|case(s)|task(s)|milestone(s)|feature(s)|functionality|coverage|requirement(s)|deliverable(s)`).
(Revised after F-003) The connector between `remaining` and the scope noun is
`[\s_-]+`, not just whitespace, so `remaining-scope` / `remaining_work`
phrasings — which survive the sanitizer unstripped — still match.

Rationale:
- The observed false-positive class ("Two remaining suite failures are
  pre-existing upstream issues") describes environment state, not scope
  shrinkage of the story.
- Genuine shrinkage sentences using `remaining` name the leftover scope noun
  ("remaining cases/work/items") or co-occur with other trigger words
  (`deferred`, `not covered`, `out of scope`), so recall loss is minimal.
- Keep / drop were rejected: keep preserves a known false-positive class; drop
  loses a real signal that appears in genuine narrow-delivery summaries.

## Risk notes

- (Revised after F-001, F-002, F-005, F-006) The sanitizer only strips tokens
  that are unambiguously code/path-shaped, never prose:
  - fenced code blocks (``` ... ```);
  - inline backtick spans ONLY when whitespace-free (`` `deferred` `` strips;
    `` `the remaining scope items were deferred` `` is quoted prose and KEPT —
    F-006.1);
  - slash tokens ONLY with an EXPLICIT path marker: a leading `./`, `../`,
    `~/`, `/` prefix, a URL scheme (`https://...`), or a final segment ending
    in a known file extension, ignoring trailing sentence punctuation
    (`core/partial-done-recovery.ts` strips; `remaining/scope` prose is KEPT —
    F-006.2; slash COUNT alone is never sufficient, so enumerations like
    `excluded/deferred/partial` are KEPT — F-007; an incidental dotted segment
    like `excluded/deferred/v2.1` does NOT make it a path — F-009);
  - dotted tokens ONLY with a known UNAMBIGUOUS extension (F-005: `go`, `c`,
    `h`, `m`, `log`, `map`, `sh`, `zip`, ... are excluded from the whitelist)
    AND a code-shaped stem — a hyphen/underscore or a second dot
    (`partial-done-recovery.ts`, `name.test.mjs` strip; `partial.md`
    mid-sentence is ambiguous and KEPT — F-006.3).
  Hyphen-only tokens are always KEPT (F-001: `deferred-for-now` matches);
  dotted tokens with non-extension suffixes are KEPT (F-002:
  `partial-release.rc1` matches).
  Residual accepted tradeoffs are all false-POSITIVE direction (`partial.md`,
  `deferred.ts`, `excluded-approach.log`, `partial-done-recovery` extensionless,
  `config.partial.enabled`, and extensionless prefix-free directory paths like
  `a/deferred/queue` — F-007 direction): authors can backtick single tokens or
  use a dotted/prefix-qualified path, both of which strip. One residual false-negative by
  convention: prose hidden inside a fenced code block is treated as code — a
  summary whose ONLY shrinkage claim lives inside a fenced block is adversarial
  authoring, outside the honest-summary threat model of this heuristic.
- (F-003 class, applied to all multi-word triggers; extended by F-008) `out of
  scope`, `not covered`, and `remaining <scope-noun>` accept `[\s./_-]+`
  connectors so hyphen/underscore/slash/dot compounds (`out-of-scope`,
  `not-covered`, `remaining-scope`, `remaining/scope`, `remaining.scope`,
  `out.of.scope`) cannot slip past the vocabulary. Dot-glued compounds are
  never stripped first because their suffix is not a file extension.
- Guard-weakening risk is covered by adversarial smoke controls (prose claim
  next to a path token; `remaining <scope-noun>`; existing `partial` verdict
  control at the narrow-delivery case).

## Out of scope

- Strict milestone-path DONE equivalence and every other DONE-gate check.
- Any vocabulary change beyond the `remaining` decision.
- NLP/LLM-based classification.
