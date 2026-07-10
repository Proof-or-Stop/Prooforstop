## Trigger Event
On 2026-07-10, after B-2861 completed the Proof-or-Stop prompt consolidation execution plan, the user explicitly chose serial development across the 11 milestones to avoid parallel coordination problems. M0 is the first implementation milestone and must establish the current prompt baseline before M0.5 rename compatibility changes begin.

## Key Insights
The plan shows 16 prompt templates with overlapping lifecycle, reviewer, evaluator, legacy, and delivery responsibilities. Later milestones will rename roles and split responsibilities, so M0 needs mechanical baseline evidence rather than prose memory. Baseline hashes, agent_prompt output snapshots, and overlap classification make future diffs reviewable.

## Solution Tradeoffs
This story should avoid editing prompt bodies because that would destroy the baseline it is trying to capture. It may add scripts, fixtures, tests, or generated baseline artifacts when they are explicitly scoped and reproducible. The tradeoff is a little upfront work now for safer M0.5 through M9 changes later.

## Conversational Texture
The user wants steady ordered progress rather than a broad parallel wave. The implementation should therefore keep M0 self-contained, visible, and auditable: capture what exists, prove legacy vocabulary and direct-write risks are mechanically visible, then stop before moving to rename compatibility.
