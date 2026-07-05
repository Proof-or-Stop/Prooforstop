## Trigger Event
B-3a4d proved that milestone closeout snapshots can survive DONE merge cleanup, but the next product gap is live visibility: after state changes, the host may still forget to print the milestone table.

## Key Insights
The durable closeout foundation is present, so this story should focus on the CLI consumption layer. The acceptance must require stdout to include the consumed milestone_status table, not just an internal function call.

## Solution Tradeoffs
A post-command hook keeps behavior mechanical across hosts and avoids relying on final-response discipline. The hook should be narrow enough to run only for story-scoped commands with an existing milestone ledger, so ordinary output stays predictable.

## Conversational Texture
The user explicitly clarified that the consumed milestone table itself must be output. This means Completed, Current, and Remaining must be visible in command output after a relevant state mutation.
