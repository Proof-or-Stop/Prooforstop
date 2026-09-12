# Reviewed source binding reconciliation

## Scope and anchors

The original repair below records its 0.3.323 baseline. The final integration
refresh against 0.3.330 is documented at the end; original counts and commands
are historical evidence, not an assertion of current-main freshness.

This bounded maintenance Lab starts from local main
`a7b2194acce4dfea6986954fc25f81a0b2d39e68` (0.3.323). It repairs four stale
source inventory bindings without changing product source, Story state, identity
classification, accepted tokens, occurrence counts, or verification predicates.
The Lab is `identity-reviewed-source-bindings-20260911`. This is not Story DONE
or a remote release. Integration and a version bump are separate operations.

## Root cause and review

The source reader deliberately binds the entire file, exact line, line position,
and occurrence count. Committed source changes were not accompanied by a complete
review of the data -> reader digest -> scanner reader-witness chain. Removing
whole-file or line checks would hide future drift, so this repair retains them.

Each old source was recovered from Git by matching its recorded SHA-256, then
compared with this Lab's base. The review covered the complete file diff, not
just a replacement digest:

| Source under packages/main/src | Matching historical commit | Review result |
| --- | --- | --- |
| core/process-fact-levels.ts | 4f94fb6ddb23a08e0bdd79f41129b423a598a9c9 | External worktree projection rationale changed and a repository baseline fact was added. The already classified target sentence is byte-identical; its line moved 495 -> 496. |
| core/prompt-registry.ts | 63b563d625f80de779319cdce80dc81da7fef398 | Dynamic Finding guidance gained guarded recovery and collection instructions. The acceptance amendment prompt now explicitly requires the strict parser's flat final-object fields and embeds its JSON Schema. The existing private run-id binding remains single-occurrence and unchanged in meaning; only that row's line digest needs renewal, at 520 -> 521. |
| core/runtime-artifact-registry.ts | d66ffc6a7abfdb17bfa412f23fa705b3e6fbf6f2 | Signed controller projection checks and value-checked matcher normalization were added. The historical path explanation is byte-identical and moved 324 -> 367; the occurrence count remains three. |
| cli/command-catalog.ts | 3adf7bd961dd2007c66ffdd0052adc0fb1926ab6 | Scorecard guidance and explicit plan owner dispositions changed. The private managed-worker run-id description is byte-identical and moved 3421 -> 3422. |

The existing `verify-amendment-prompt-output-shape.mjs` test exercises both host
projections against the strict parser: flat output is accepted; nested binding
and mismatched subjects are rejected. It passes unchanged on this candidate.
This does not migrate or broaden the private worker protocol.

Only four of 54 inventory rows change. All paths, tokens, classifications,
reasons and counts remain identical; the other 50 rows are byte-equivalent as
parsed records. The reader's pinned inventory digest and the scanner's pinned
reader digest are updated together. No generic repin command or runtime
auto-approval is introduced.

## RED and GREEN evidence

The initial RED at `e7044365ee` used the combined inventory suite and exposed
the four source failures. A pre-fix test-only commit `84d743d4b0` then isolated
the source acceptance command:

```sh
node scripts/verify-reviewed-source-bindings.mjs
```

The official Lab RED recorded exit 1 and
`REVIEWED_SOURCE_BINDINGS_MUST_MATCH_CURRENT_SOURCE`, with all four paths.
The uncommitted exploratory repair was removed before that test-only commit and
RED, then reapplied. Both RED records remain in the official Lab history.
The pinned command is not replaced by a weaker passing command after repair.

| Measurement/control | Before | Repaired candidate |
| --- | --- | --- |
| Source binding failures | 4 | 0 |
| Inventory rows | 54 | 54 |
| Exact current source positives | Initial freshness assertion fails | 54 pass |
| Unknown path/token, modified source/line, moved line, duplicate-token controls | Not reached | 324 refusals pass |
| Empty and missing source controls | Not reached | 52 refusals pass |
| Outer scanner reader bindings | Existing chain valid before renewal | All three current readers match |
| Source data tamper | Existing protections retained | Original imports; row deletion and duplication both refuse |

A partial-repair check was also performed: after refreshing the data and inner
reader but before changing the outer scanner pin, source failures were zero yet
`REVIEWED_READER_CHAIN_MUST_MATCH` failed. This proves that the new target catches
the specific incomplete-chain mistake. This intermediate run is diagnostic
evidence, not a separately signed Lab RED.

The combined `verify-identity-reviewed-contexts.mjs` imports the focused check
and retains every previous fixture/JSON assertion. Its original loop still stops
at the fixture baseline; only the focused source controls run before that stop.
No fixture failures are converted to PASS. The 324 refusals count observations,
not independent isolation of every internal predicate: whole-file digest and
line-consistency checks can reject a mutant before later predicates execute.
Similarly, the inventory tamper tests prove the byte-digest refusal, not separate
coverage of every inner structural check. No synthetic override of trusted hashes
is introduced to make those narrower tests claim broader authority.

## Preserved unrelated fixture baseline

On both unchanged main and this candidate, `validateReviewedFixtureSources`
returns the same ten errors over two other files:

- `scripts/verify-process-fact-contract.mjs`: 7242, 6489, 6491, 6498, 6506,
  6516, 6525, 7264 and 7293.
- `scripts/verify-acceptance-prompt-projection.mjs`: 20.

They are independently reproducible fixture-inventory bindings, not these four
source rows. Their later appearance in the combined suite was masked by its
earlier source assertion. They remain unmodified and the combined suite remains
FAIL. Follow-up ownership belongs to fixture identity-inventory maintenance;
this audit entry is not a signed Finding routing receipt or formal deferral.
Reproduce with the unchanged exported fixture validator, inspect the historical
source diffs, and renew only independently justified fixture bindings in a
separate bounded repair. No broad whole-repository PASS is claimed here.

## Independent Claude CLI review

Claude CLI session `34b0b7a6-dc22-4130-859d-728f244c6219` returned code-review
PASS. Its first execution attempts appended an unapproved shell status command
and were denied by the exact command allowlist. Those attempts are not test
evidence. A follow-up in the same session executed the two original commands
without additions; both returned exit 0, with no permission denials:

```text
node scripts/verify-reviewed-source-bindings.mjs
reviewedSourceBindingFailures: 0
PASS scanner reader bindings: 3 exact current modules
PASS source: 54 exact positives, 324 mutation refusals, 52 empty/missing controls
PASS source inventory byte integrity: original accepted, deleted and duplicate rows refused

node scripts/verify-amendment-prompt-output-shape.mjs
AMENDMENT_OUTPUT_SETUP PASS flat accepted; nested and mismatched subjects rejected
AMENDMENT_PROMPT_OUTPUT_SHAPE PASS both hosts; strict parser controls unchanged
```

The review's coverage-accounting observations are addressed above: refusal
counts are not independent predicate-isolation claims, and new duplicate
controls were removed from the already-blocked combined loop. The original
combined assertions remain unchanged; it only imports the new focused test.
The pre-existing compact formatting of the scanner row was not reformatted.
The reviewer checked the four target contexts and unchanged allowance fields;
the complete historical diff review is the implementer's evidence, not a claim
that Claude independently reviewed all historical file diffs.

A further read-only diagnostic exposed the actual scanner's private
`verifyReviewedContextReaders` and `verifyScannerRetiredContexts` functions using
an ephemeral module hook. Since this Lab has no built dist, its existing source
loader plus a bounded source resolution hook was used; no scanner file was
modified and no full built-CLI acceptance is claimed. On current main the actual
reader consumer returned four source plus ten fixture errors; in Lab it returned
only the same ten fixture errors. Scanner self-inventory checks returned no
errors on either tree. This corroborates the three-level binding repair without
concealing the unrelated fixture baseline or rewriting its pins.

## Latest-main integration refresh (2026-09-12)

The operator authorized local integration, patch release, and eventual approved
main publication. Fetch confirmed local main
`f958df46a2f6129504a661fc92ebcb31a949ac9b` (0.3.330) contains origin/main
(0.3.320); local main was 85 commits ahead and zero behind. The official Lab
sync merged that local baseline at `b7bbaa02de`. No other active Lab was imported.

The unchanged targeted command reproduced two remaining failures after sync:
`process-fact-levels.ts:496` and `runtime-fact-registry.ts:473`. This RED is
recorded against the synchronized committed tree. Untouched main has five
source-row failures; three earlier repairs still matched its bytes, one earlier
target drifted again, and one new source row drifted.

The complete two-file diff from the original base was inspected. Process facts
changed only the repository-default baseline rationale, describing the already
merged local-ahead linked-worktree preference. Its classified target at line
496 and occurrence count are unchanged, so only the whole-file digest changes.
Runtime facts added mandatory independent vendor audit settings and schema-3
Lab policy. The existing environment-marker line is byte-identical and moves
473 -> 479, with its occurrence count unchanged. Its file digest and line
position are renewed without altering classification or allowing new tokens.

Relative to 0.3.330 main, exactly five of the existing 54 source rows now have
reviewed binding updates. The data digest, reader digest and outer scanner
witness remain coupled. No identity-runtime implementation or Story state is
changed. A subsequent audit repair below additionally registers one test-resource
policy row; the official release helper owns the ordinary version changes.

The same focused test reports zero source binding errors, all three reader
bindings current, 54 exact positives, 324 observed mutation refusals and 52
empty/missing controls. The amendment prompt/parser shape regression also
passes unchanged. These controls retain the evidence limitations recorded above.

The current unrelated fixture baseline is now eleven entries over three files:
the prior ten plus `packages/main/src/tasks/finding-identity-lineage-smoke.ts:139`.
These bindings remain out of scope and unchanged; this repair does not claim
full identity-suite success. The earlier ten-entry baseline is retained above
as an explicitly dated historical comparison, not rewritten as if it included
the later change.

The earlier direct Claude audit is historical supporting evidence only. Current
Lab policy additionally requires a fresh tool-owned different-vendor audit of
the prepared release candidate. Official finish must capture that audit before
local integration; failed or stale audit evidence cannot be reused as approval.
Remote push separately requires the human-created one-shot approval bound to
the final main SHA. No old approval or Story lifecycle result substitutes for it.

## Prepared-candidate audit findings and bounded repair

The first mandatory tool-owned audit of candidate `52192ccc17` failed with
three findings, despite confirming the binding repair's structural correctness.
Its record is retained under audit run `d8e7870d-e4e2-4daa-928f-4d1dc38c9fd8`.
The candidate was reopened using the official command, not rerolled unchanged.

1. The new controls needed a routine execution path. Test-only commit
   `9c55f76682` added a failing registration assertion, and official RED recorded
   `REVIEWED_SOURCE_TEST_MUST_BE_IN_ROUTINE_SUITE`. The repair adds the exact npm
   entry, includes it once at the start of `test:serial-reference`, and supplies
   a repository-read-only row in `full-suite-runner.ts`. The focused test checks
   the exact npm command and unique serial-chain membership. The existing full
   suite inventory builder independently rejects missing/extra policy rows before
   execution; its normal inventory contract covers this new member. Resource
   classification uses a shared Git resource and unique temporary roots. Direct
   resource-inventory validation uses compiled output after a fresh build; the
   focused source check does not load the whole Story engine or pretend a text
   search proves policy behavior. The unrelated fixture checks remain unchanged.
2. The prompt row needed byte-verifiable before/after evidence. The following
   two expressions reconstruct the complete original and current source lines,
   including indentation and trailing comma. `reviewedRunIdToken` means exactly
   the unchanged `token` field of the unique source-inventory row whose path is
   `packages/main/src/core/prompt-registry.ts`; it is not a wildcard or redaction.
   Interpolation avoids creating an additional unclassified retired-token literal
   in a current document. The executable target contains these same expressions,
   checks their fixed SHA-256 values, and compares the entire current line with
   the actual source. It also asserts the unchanged classification
   `private_protocol_preserve_or_coordinated_versioned_migration` and count 1.
   In both versions the token occurs inside a quoted prompt string telling the
   reviewer which existing private environment value to echo, not in a new
   environment lookup, role alias or authority-granting expression.

```js
const before = `      'Use schemaVersion proof-or-stop.acceptance_amendment_review_final.v1; runId must equal environment ${reviewedRunIdToken}; include the exact storyId and binding below, decision approve or reject, substantive rationale and nonempty readRefs.',`;
const after = `      'Use schemaVersion proof-or-stop.acceptance_amendment_review_final.v1; runId must equal environment ${reviewedRunIdToken}. Return exactly these top-level fields: schemaVersion, runId, storyId, amendmentId, amendmentDigest, baseDigest, submitterSessionId, decision, rationale, readRefs. Copy amendmentId, amendmentDigest, baseDigest and submitterSessionId from the input binding object into those top-level fields; do not return a binding object. decision must be approve or reject; rationale must be substantive and readRefs must be nonempty.',`;
```

Before SHA-256: `0f6764f3315b51cacb403a7e6b427bd2f06a96bf07369e1c1dd40b1aef3ab251`.
After SHA-256: `648c58818e33cfbdc6a47d8df9e5e805bdacffff9dde01d558055596fc6491bb`.
The substantive change replaces ambiguous nested-binding instructions with the
existing parser's explicit flat fields and JSON Schema; it does not change the
token's syntactic role or exemption category.

3. The out-of-tree release notes' redundant H1 heading was removed. Official
   finish will regenerate the entry beneath its own H2 heading. No historical
   changelog text is edited manually.

These changes address the actual rejected content and add executable proof.
The earlier audit remains FAIL; a new prepared candidate must earn a fresh audit.
