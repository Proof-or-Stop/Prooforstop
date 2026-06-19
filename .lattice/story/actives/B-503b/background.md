## Trigger Event
On 2026-06-19, a small development task reached DONE without the expected review-assurance rounds, and a bug still appeared. This exposed a real process gap: low-risk classification alone cannot guarantee review coverage for every code-changing story.

## Key Insights
PLAN risk classification is necessary but insufficient. A story can look low risk before implementation and still introduce a correctness bug. Lattice therefore needs a minimum review floor for code diffs plus an automatic escalation path when failures, bugs, findings, or rework appear.

## Solution Tradeoffs
Forcing every code change into full 3x2 would maximize caution but waste token budget and slow small work. A better policy is a one-round minimum for ordinary code changes, automatic 3x1 escalation after real failure signals, and full 3x2 for lifecycle, gate, Authority, or process-fact work.

## Conversational Texture
The user wants this to become a reliable Lattice rule, not an informal habit. The implementation plan must remain host-neutral, preserve local Non-authority versus Authority Server boundaries, and only fix real correctness issues without arbitrary optimization.
