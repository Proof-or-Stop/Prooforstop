## Trigger Event

During B-9ff1's closing review on 2026-08-18, the test-coverage lane (pass B-9ff1:RP-034) audited the
story's two waivers on their merits instead of accepting their stated rationale. Both waivers assert
that the underlying tooling gap "is filed as its own task". The reviewer searched story_list and
bug_list and found no such story or bug. The waivers were justifying themselves by pointing at a
follow-up that did not exist. This story is that follow-up, created so the claim becomes true.

## Key Insights

The reviewer also established, by re-running the harnesses rather than reading the waiver text, that
neither waiver hides a coverage hole. CHK-012:edge:1 pins the selector ".lattice tree byte-identical
after 7 invocations" while red-w2d-command-readonly.mjs now prints 8 DIRECT handler invocations.
CHK-013:adversarial:0 pins "25 tagged rejection fixtures" while red-evidence-envelope-smoke.js now
prints 33. In both cases the command still exits 0 and the behaviour is still proven; only a counted
literal drifted past its pin.

The immutability is not a bug. checklist.ts rejects a mismatched selector (receipt_selector_mismatch,
near line 749) precisely so a caller cannot retroactively rewrite what was proven, and
verification_intent_repair (near line 2131) is scoped to backfilling MISSING intents rather than
correcting existing pins. The failure is that the only disposition left for a stale-but-passing pin
is a waiver, which discards a coverage claim that is in fact satisfied.

## Solution Tradeoffs

Any repair path is a hole in the immutability the receipt's trustworthiness rests on, so the design
question is not whether to allow repair but how to make repair unable to launder a failing intent
into a passing one. The intended shape is: re-execute the pinned command, derive the verdict from
the fresh receipt only, never accept a caller-supplied result, and record the superseded selector
next to the new one so an auditor sees what changed. The alternative - leave the gap and keep
waiving - was rejected because it silently converts satisfied coverage into declared non-coverage,
which is worse than an audited repair.

A second, cheaper option is available and is in scope: refuse or warn at PIN time when a candidate
selector contains a bare integer, so counted literals never get pinned. B-3434 recorded the same
lesson independently for its own selectors. Doing only the repair path leaves new counted pins being
created; doing only the pin-time guard leaves the existing two stranded.

## Conversational Texture

This story exists because a reviewer refused to take a waiver's word for its own justification. The
waivers were correct on the facts and wrong about the paperwork, and the cheapest honest fix was to
create the missing follow-up rather than to edit the waiver text - editing it would have moved
storyFilesHash and cost B-9ff1 a full re-review cycle for a claim that was about to become true
anyway.
