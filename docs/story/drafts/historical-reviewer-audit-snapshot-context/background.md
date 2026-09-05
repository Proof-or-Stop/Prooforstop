## Trigger Event
On 2026-09-05, B-212f F-009 repair exposed scope expansion from restoring historical DONE presentation into adding complete historical reviewer eligibility replay. The user explicitly approved the narrow presentation boundary and continuation until DONE.

## Key Insights
Source evidence: packages/main/src/core/review-incremental-context.ts:758-760 reads current HEAD hashes; lines 973-983 compute live main-to-HEAD changes and fixture closure. ReviewRun and PromptEnvelope store signed hashes and digests but do not by themselves reconstruct every historical selection input. Observe with sed -n 970,987p packages/main/src/core/review-incremental-context.ts. Expected observation includes main and HEAD arguments.

## Solution Tradeoffs
B-212f must restore its pre-existing historical artifact and assurance behavior while strictly sharing every active TEST-to-DONE predicate. It must not claim a new historical reviewer PASS. Any complete historical reviewer audit belongs to this pending human-approved follow-up and requires its own design, compatibility policy, RED/GREEN, and immutable snapshot inputs. This is not dismissal or deferral of F-009, which remains current-Story repair.

## Conversational Texture
The user challenged avoidable elapsed time and token usage, then explicitly accepted narrowing to active gate parity and preserving original historical query semantics. Owner: this draft backlog pending human prioritization. Impact: future historical reviewer-audit capability, not the approved current active-admission result. Reassess immediately if evidence makes it a current acceptance blocker. Initial gap_log archival failed closed with invalid_binding_shape; this CLI-created draft preserves the trace without repairing unrelated provenance infrastructure.
