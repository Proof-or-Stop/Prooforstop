## Trigger Event
On 2026-06-14, audit of B-2c0c found that decision-doc 3x2 quorum currently counts distinct hostId strings but does not prove independent host/session/key identity. The user then set a broader policy: normal development starts with ordinary REVIEW, but if the first REVIEW round finds two or more problems, the story must automatically escalate to three review rounds with two independent hosts per round.

## Key Insights
The existing lifecycle already has signed reviewer runs, findings with evidenceState, review passes, local host_verdict events, and DONE gate consumption. The missing design is a mechanical escalation artifact plus a stronger host-independence predicate that is shared by decision-doc quorum and the new escalation gate. Prompt-only instructions are not enough because lifecycle facts must be enforced by handlers and gates.

## Solution Tradeoffs
Forcing 3x2 on every story would slow normal work and create review fatigue. Keeping it decision-doc-only would miss risky implementation stories whose first review round exposes multiple real problems. The balanced rule is threshold-based escalation: keep one-round REVIEW as the default, always require 3x2 for decision-doc changes, and require 3x2 for any story whose first REVIEW round records at least two verified findings.

## Conversational Texture
The user wants an open-source-quality workflow rule that is explicit, auditable, and easy to explain to future contributors. The plan should be written as an execution document, not a vague recommendation: it must say what files to change, which artifacts to add, which tests prove the rule, and how reviewers can see why a story was or was not escalated.
