## Trigger Event
On 2026-07-08, docs/requirements/decisions/pos-agent-drivability-optimization.md recorded a transcript-grounded failure where a rule-free autonomous agent spent 93 bash commands and never reached DEV on the trivial fix-git task.

## Key Insights
The failure was not caused by missing lifecycle gates. The correct aggregator command already exists as init_preflight, but the high-traffic surfaces an agent follows during INIT still route it into one-at-a-time story_advance failures.

## Solution Tradeoffs
This story intentionally implements only M0-M1. It should improve discoverability and exact next-step routing while leaving reviewer, scope, verificationIntent, review, and DONE evidence contracts untouched.

## Conversational Texture
The user agreed that the roadmap document belongs in docs/requirements/decisions and asked to open a Story to begin the repair. The first useful move is a tight implementation slice that can be verified without re-litigating the larger M2-M7 plan.
