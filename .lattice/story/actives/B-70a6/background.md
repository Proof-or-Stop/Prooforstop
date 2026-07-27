## Trigger Event
On 2026-07-25, a codex host-B review of story B-8b69 (merged as 8091f0e0, CLI 0.3.238) reported three LOW-severity findings against the gated PLAN->INIT reopen it had just landed. The primary finding: the mandatory reopen `reason` is validated in transition-orchestrator.ts but never written anywhere durable.

## Key Insights
buildPhaseTransitionProcessEvent omitted `reason` entirely and its single call site never passed one, so the reason existed only for the duration of the guard check. Because phase_transition events are append-only and appended only after a successful writeStory, carrying the reason there yields a per-reopen history rather than a single last-write-wins field, and needs no new event type or storage. ProcessEvent uses an open index signature and no consumer hashes or key-set-validates the event, so additive fields are backward compatible.

## Solution Tradeoffs
Rejected: a dedicated `reopenReason` field on the story index, which would keep only the most recent reopen and split audit data across mutable fields. Rejected: adding actor/eventId provenance plumbing, which exceeds what this LOW finding requires (YAGNI). Chosen: strictly additive optional fields on the existing append-only event, set only on REOPEN so every normal transition keeps a byte-identical event shape. The two comment corrections are deliberately kept out of the behavioral change so a documentation nit cannot block the audit fix.

## Conversational Texture
The user reviewed the codex findings, judged the main fix worth doing at 8.5/10, and directed that the audit-event persistence be the single main task while the atomicity-comment and worktree-prune notes be handled as separate low-priority items rather than folded into one commit. The user then correctly challenged an attempt to treat the CLI version bump as a user decision, pointing out that it belongs to the mechanical Proof-or-Stop release path rather than to a prompt.
