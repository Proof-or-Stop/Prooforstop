## Trigger Event
On 2026-09-09, direct execution of `proof-or-stop validation_plan --storyId=B-dcf9 --tier=fast --json` requested Story-fast but returned repository-full with all current inventory rows selected. The user asked for this concrete gap and its RED/GREEN proof to be written as an executable Markdown plan and audited by Claude CLI and Agy CLI.

## Key Insights
The repository contains two planning surfaces: the explain-only tier planner currently widens every request to repository-full, while the production Story-aware validator owns selection, receipts, and authority checks without exposing the same three-tier result. A credible solution must unify those paths, produce deterministic tier sets, and prove every non-executed responsibility through current closure and receipt evidence.

## Solution Tradeoffs
The plan will not prescribe a path-name heuristic or enable enforcement immediately. It will prefer one canonical selector, explicit impact and command identity contracts, deterministic subset invariants, targeted RED/GREEN fixtures, mutation tests, and observe-to-shadow-to-enforce rollout. This costs more design discipline but avoids an unsafe test-filter shortcut.

## Conversational Texture
The user wants a plain, operational answer to whether fast, intermediate, and full are real rather than labels, how fewer commands can remain trustworthy, and exactly what RED and GREEN demonstrate. The document must stay concrete enough for another implementer to execute and for two independent CLIs to challenge.
