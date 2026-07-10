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

## Host-B (codex) cross-vendor review — response record

An independent codex host-B review (2026-07-10, read-only, live-CLI probes)
returned FAIL with six findings after the seven claude-side rounds passed:

- **Finding 1 (fixed here; revised after round 2)**: the CHK-003 narrowing
  lost sentences the bare trigger used to catch when modifiers sit between
  `remaining` and the scope noun. Round-2 probing showed a fixed
  modifier-word count also fails (>3 modifiers, comma-separated modifiers,
  unicode dashes), so the final fix is a bounded SAME-SENTENCE character
  window: `remaining(?:\.(?!\s)|[^.!?;:\n]){1,60}?<scope-noun>` with
  alphanumeric lookarounds on the noun. Covered by five must-fire window
  cases (including codex's round-1 and round-2 sentences) plus two negative
  controls (no noun in window; noun only in the next sentence). NOTE (F-011):
  the first version of these smoke cases was observed RED pre-fix but was
  reverted by a concurrent reviewer cleanup before the commit landed — they
  are now committed.
- **Finding 5 (fixed here)**: ambiguous unanchored quantifiers made the strip
  scan superlinear (~6.4s on a 40k-char hyphen run). Fix: whitespace-split
  tokenization with anchored per-token tests — measured 8ms on the same input;
  a pathological-input timing assertion now lives in the smoke.
- **Findings 2, 3, 4 (out of scope, follow-up)**: `not yet covered` (adverb
  insertion), `partially` and `excludes` (inflections) were NEVER matched by
  the pre-story regex — these are pre-existing recall gaps in the trigger
  vocabulary, and the user-confirmed scope boundary explicitly excludes
  vocabulary changes beyond the `remaining` decision. Recorded for a follow-up
  vocabulary-recall story rather than silently expanded here.
- **Finding 6 (environmental)**: smoke could not run inside codex's read-only
  sandbox (mkdtemp EPERM); it runs green outside it and in validate.

A second codex host-B round (post-fix) re-verified findings 1 and 5 as fixed
for its round-1 sentences, then found the fixed-word-count window still missed
longer/comma/unicode-dash modifier prose (folded into the revised Finding-1 fix
above) and flagged whitespace-free backticked trigger tokens
(`` `deferred` ``). The backtick class strips BY REQUIREMENT — the original
user request names backticked spans explicitly — and the claim verb in such
sentences ("left to a follow-up") is part of the verb-recall follow-up story;
the direction is pinned by the backtickTriggerTokenDone smoke case.

The quality lane then filed F-012 (a raw character window fires on scope nouns
in a DIFFERENT clause — "remaining flaky tests, unrelated to this fix, cover
edge cases" — reviving the CHK-003 false-positive class), and a third codex
round showed pure word-count windows fail in the other direction (a genuine
7-modifier chain with "and"; heading-style "Remaining:"). Word count cannot
separate those cases — the distinguishing feature is CLAUSE STRUCTURE. A
fourth codex round ("remaining set of cases", "remaining UI/UX cases") and
quality finding F-013 (", and" bridging independent clauses) refined the
chain-word taxonomy once more. Final form: the chain allows up to eight
modifier words; stop words mark a clause (verbs of being, state verbs like
exist/linger/persist/continue/remain, pronouns, prepositions — but NOT "of",
which is noun-phrase internal); conjunctions AND bare "not" pass only WITHOUT a preceding
comma (bare "and"/"not" sit inside noun phrases — "remaining not yet
supported functionality" — while ", and"/", not" coordinate clauses);
modifier words accept '/' (UI/UX); coordinate-adjective commas and a heading
colon are accepted; sentence punctuation blocks the chain; line wraps do not
(fail-safe); the scope noun must terminate the chain. Both directions are
pinned: ten must-fire window claims and six cross-clause must-not-fire
controls.

**Convergence statement**: the chain-word taxonomy is a documented lexical
heuristic, not a parser. The review floor for this story is: a change is
blocking only if it is a VERIFIED regression vs pre-story behavior (a sentence
the bare trigger caught that now escapes, or a false-positive class CHK-003
was written to eliminate that returns). Marginal precision/recall cases
beyond that floor (novel verbs, rare constructions, typography) belong to the
follow-up vocabulary story, not to further rounds of this one.

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
  use a dotted/prefix-qualified path, both of which strip. TWO residual
  false-negative classes, both by design not accident:
  1. Prose hidden inside a fenced code block is treated as code — a summary
     whose ONLY shrinkage claim lives inside a fenced block is adversarial
     authoring, outside the honest-summary threat model.
  2. (Recorded by the delivery review) A trigger-stemmed FILE NAME with an
     unambiguous extension (`deferred-query.sql`, `partial-config.json`) is
     stripped BY REQUIREMENT — it is shape-identical to
     `partial-done-recovery.ts`, the exact token class B-d6a0 demands stay
     silent, so no shape rule can keep one and drop the other. In natural
     sentences of this class ("The deferred-query.sql export was skipped for
     this delivery.") the shrinkage meaning is carried by the VERB (skipped /
     removed / dropped), which the trigger vocabulary has never covered — that
     verb-recall expansion belongs to the follow-up vocabulary story together
     with host-B findings 2/3/4. Both directions are pinned by smoke cases.
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
