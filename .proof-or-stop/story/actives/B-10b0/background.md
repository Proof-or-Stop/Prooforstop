## Trigger Event
Story B-3aec reached correct business behavior and passed focused, routine 46-command, and DONE-required validation, yet closeout metadata writes repeatedly invalidated reviewer receipts. The workflow required several DEV to REVIEW re-attestation loops even though materialHash and storyFilesHash stayed unchanged.

## Key Insights
The failure is not slow tests or reviewer indecision. Review binding retention does not consistently recognize canonical writers for test-evidence, done-required evidence, live-smoke transcript, summary, and delivery-check. REVIEW to TEST also writes validation after review receipts, while delivery dispatch and delivery_check_set expose incompatible legal phases. Concept deletion detection separately mistakes body edits for declaration removal.

## Solution Tradeoffs
The fix must preserve fail-closed behavior for source, configuration, command-set, policy, or story-owned material drift. Only registry-declared closeout artifacts from canonical command writers and trusted metadata lineage may retain receipts. A single shared classifier is preferable to adding per-artifact exceptions. True symbol deletion with residual references must continue blocking.

## Conversational Texture
The user explicitly asked to solve this before continuing the planned backlog because nobody can watch the workflow and repeatedly approve metadata-only re-reviews. Success means the normal unattended path converges without asking for human confirmation, without rerunning unchanged suites, and without weakening real review or delivery assurance.
