## Trigger Event

On 2026-08-18, B-9ff1 reached its DONE gate and was refused with missing_dev_memory_finish_decision.
Recording that decision honestly required first capturing the story's reusable lessons, which writes
.lattice/dev-memory/experience.jsonl. The scope gate then reported blocking: "path gate fail
(out-of-scope diff)". The delivery reviewer traced it rather than accepting the story owner's
lifecycle-required framing, and found the actual cause in
packages/main/src/core/runtime-artifact-registry.ts: there is an explicit registry entry
`dev-memory-finish-decision` (prefix `.lattice/dev-memory/finish-decisions/`, materialHash 'exclude'),
which is why the finish-decision file passed silently - and NO equivalent entry for its sibling
`.lattice/dev-memory/experience.jsonl`, so the unknown path fails closed as OUT_OF_SCOPE.

## Key Insights

The registry entry's own comment records that this exact class of problem was already hit and fixed
once, for the sibling path: it notes that including the finish-decision file "broke delivery-check
materialHash freshness" and that excluding it from materialHash was the fix. The same reasoning
applies unchanged to experience.jsonl - it is the one designed, git-tracked, cross-agent ledger that
dev_memory_capture writes to - but the registration was never extended to it.

This is a standing tax rather than a B-9ff1 quirk. Every story that captures a dev-memory lesson
writes this file, so every story that reaches DONE with something worth recording hits the same
blocking scope report. The workaround available today is worse than the bug: report
`dev_memory_finish_decision --decision=no-reusable-lesson` and skip the capture, which clears the gate
by declining to record what the story learned. A gate whose cheapest satisfying path is the dishonest
one is mis-designed.

A second, separable mechanics gap surfaced alongside it: `scope_contract_acknowledge` is not available
in TEST phase (allowed phases are INIT, PLAN, DEV), and the scope gate's own remediation text tells the
operator to run exactly that command. So the advice printed at the point of failure cannot be followed
from the phase in which the failure occurs; the only route is a TEST -> DEV -> REVIEW -> TEST
re-anchor, which invalidates every reviewer pass and the verification evidence.

## Solution Tradeoffs

The narrow fix is a sibling registry entry for `.lattice/dev-memory/experience.jsonl` mirroring the
finish-decisions one, materialHash 'exclude', with the same rationale comment. That is small and
almost certainly right, but it is worth asking first whether the registry should be keyed on the
`.lattice/dev-memory/` PREFIX rather than on two individually-registered children, since a third
dev-memory artifact would reproduce this exactly. Registering the parent trades a little precision for
not needing this story again.

The scope_contract_acknowledge phase availability is a separate decision and may be the wrong thing to
change: allowing scope acknowledgements in TEST could let a story quietly widen its contract after
review. The alternative is to fix the remediation TEXT so it names a route that actually exists from
TEST. Deciding which is in scope here; implementing both is not required.
CORRECTION (cross-vendor review host B, 2026-08-18): the tradeoff text above states that scope_contract_acknowledge allows phases INIT, PLAN, DEV. That is WRONG - packages/main/src/core/command-policy.ts:411 declares allowedPhases: ['DEV', 'REVIEW']. The error was transcription, not reading: INIT/PLAN/DEV is checklist_update's phase list, quoted verbatim from the refusal seen while trying to write a userSees field in TEST, and two commands' phase lists were conflated while writing this background. The central gap is unaffected and remains genuine - scope_contract_acknowledge is still unavailable in TEST, the phase where the scope gate reports the violation and prints remediation naming that command. Whichever route is chosen, read the actual allowedPhases at command-policy.ts rather than trusting any phase list quoted in prose, including this one.

## Conversational Texture

This was found because a delivery reviewer declined to accept "lifecycle-required infrastructure
write" as an explanation and went looking for the mechanism. The story owner had argued the same
conclusion in a scope acknowledgement; the reviewer produced the registry line number instead. One is
a defence, the other is a defect that can be fixed.
