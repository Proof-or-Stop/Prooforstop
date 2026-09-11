# Reviewed source binding reconciliation

## Scope and anchors

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
