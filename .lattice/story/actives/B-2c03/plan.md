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

- (Revised after F-001 and F-002) The sanitizer only strips unambiguously
  path-shaped tokens: backticked spans, tokens containing `/`, and dotted
  tokens ending in a KNOWN FILE EXTENSION (`partial-done-recovery.ts`,
  `name.test.mjs`). Hyphen-only tokens are KEPT (F-001) so hyphenated trigger
  prose (`deferred-for-now`, `excluded-here`) still matches. Dotted tokens with
  a non-extension suffix are KEPT (F-002) so `partial-release.rc1` /
  `deferred-work.next` still match their trigger segment. Residual accepted
  tradeoffs: a bare extensionless hyphenated file name
  (`partial-done-recovery`) and a dotted identifier with a non-extension tail
  (`config.partial.enabled`) can still false-positive — authors can backtick
  such tokens or use the full path, both of which are stripped.
- Guard-weakening risk is covered by adversarial smoke controls (prose claim
  next to a path token; `remaining <scope-noun>`; existing `partial` verdict
  control at the narrow-delivery case).

## Out of scope

- Strict milestone-path DONE equivalence and every other DONE-gate check.
- Any vocabulary change beyond the `remaining` decision.
- NLP/LLM-based classification.
