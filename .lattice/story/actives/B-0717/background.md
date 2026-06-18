## Trigger Event
2026-06-18 P4 audit called out packages/main/src/cli-engine.ts as a god file that is still growing: 4450 lines now versus 4365 earlier, despite handlers already living under packages/main/src/handlers. The user asked for an execution document and strong Lattice Authority Server verification before starting this major architecture split.

## Key Insights
The risky center is not business handler code anymore; it is the CLI shell layer that still combines MAIN_TOOLS schemas, command aliases, help rendering, flag parsing, root/worktree resolution, owner lease gates, read-only reviewer gates, activity logging, hooks, and INIT_CHECK special orchestration. A safe plan must split those seams without weakening process-fact gates.

## Solution Tradeoffs
A big-bang rewrite would reduce line count quickly but risks breaking command-policy coverage, JSON stdout contracts, INIT_CHECK metadata sync, and Authority receipt boundaries. A staged execution plan keeps public exports stable first, then moves schemas/help/flags/aliases, then runtime gates, and only later the lifecycle special dispatchers. Strong verification is slower but appropriate for this risk class.

## Conversational Texture
The conversation has been focused on raising assurance rather than rushing code: the user explicitly asked whether this should have an execution document, 3 round x 2 host confirmation, and Lattice Authority Server strong verification because this is a major architectural decomposition. The plan should therefore be reviewable before implementation and honest about local 3x1 degraded fallback being lower assurance.
