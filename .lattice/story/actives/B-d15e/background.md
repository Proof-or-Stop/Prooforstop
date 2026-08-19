## Trigger Event
During B-7dff closeout on 2026-08-18, the full-suite JSON result still reported performanceBudgetMs=300000 after the runtime policy had moved to 1200000, creating contradictory evidence for every consuming story.

## Key Insights
The runtime predicate already has one canonical source, FULL_SUITE_BUDGET_MS. The defect is a numeric shadow copy in artifact construction, so the narrow repair is to derive telemetry from that constant and mechanically reject another copy.

## Solution Tradeoffs
A one-line writer change alone is fast but can regress silently. Adding one source-level smoke assertion costs almost nothing and protects the mapping without rerunning the entire full suite or rewriting frozen historical B-9812 receipts.

## Conversational Texture
The operator needs a fast repository-wide convergence fix, not another performance investigation. Keep this story to one production substitution and one focused regression assertion, then let dependent stories merge main normally.
