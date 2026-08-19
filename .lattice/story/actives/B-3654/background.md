## Trigger Event

B-9ff1's review filed F-014 on 2026-08-18 after an empirical read-only check: running
`node bin/lattice.js red_evidence_envelope_check` against a story DID append a row to
.lattice/activity.jsonl, directly contradicting the literal comment at
packages/main/src/cli/activity-policy.ts:23-25 — "It must append NOTHING (no hook, no activity log,
no process event)". B-9ff1 deferred it as out of its own file scope and claimed it was filed as
follow-up; its concept lane established in B-9ff1:F-064 that no such artifact existed. This is that
artifact.

## Key Insights

The finding was established by execution, not by reading: the command was run against a story that
is genuinely stale in REVIEW, and the activity row appeared. The check was also confirmed unaffected
by the concurrent main-merge — cli-engine.ts and stale-detector.ts had zero commits in the merged
range — so the contradiction is a standing property of the code, not a merge artifact.

The stated root cause is that cli-engine.ts's writeLog is gated on shouldWriteActivityLog(...), and
whatever that predicate consults does not agree with the read-only classification that
activity-policy.ts documents. So the defect is not specific to red_evidence_envelope_check: any
command the policy classifies as append-nothing is exposed to the same divergence, which is why
B-9ff1 characterised it as a systemic cross-command telemetry bypass rather than a one-command bug.

Why it matters beyond tidiness: a command documented as writing nothing is relied on as safe to run
during REVIEW and TEST, when a metadata write moves storyFilesHash and can stale reviewer passes and
verification evidence. This story's whole programme has repeatedly paid the cost of unexpected
metadata writes; a read-only command that is not read-only is that cost with no visible cause.

## Solution Tradeoffs

Two shapes. Either make the runtime obey the documented classification — one predicate, consulted by
both the policy and cli-engine's writeLog, so the classification cannot drift from the behaviour —
or, if some of those writes are genuinely wanted, correct activity-policy.ts's comment and state
which commands write what. The first is preferable because the comment is the contract other stories
have relied on, but the second must be considered honestly rather than assumed wrong: it is possible
the activity row is deliberate telemetry that the comment simply never described.

What must NOT happen is closing this by editing the comment to match whatever the code currently
does without deciding which is correct — that is the same move the sibling spec story exists to
avoid, and it would silently retire a guarantee.

## Conversational Texture

This is the fifth deferred item from B-9ff1 to be given a real home, after a reviewer checked whether
"filed as follow-up" had actually filed anything and found it had not, four times over. The defect
itself is low severity and small; the reason it gets a story rather than a comment in a closed
finding is that nobody greps closed findings.
