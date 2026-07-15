## Trigger Event
B-ccb6 reproduced the Workstream A failure and then exposed a bootstrap deadlock: the old candidate router expanded six explicit documents into 117 required full reads. Commit eb839537ad fixed that routing defect, while B-ccb6 was discarded because its INIT execution boundary could not be expanded in PLAN.

## Key Insights
The 240000ms outer phase ceiling is shorter than the legal sequential DONE-required command budgets of 290000ms and 1200000ms. Direct done_required_validate already generates heartbeat events internally, but without a supplied progress reporter those events never reach ctx.log and the five-minute CLI idle watchdog can terminate productive work.

## Solution Tradeoffs
The replacement keeps three independent safety layers: each command timeout, a derived sequential phase deadline with bounded grace, and the CLI absolute maximum. Receipt reuse is fail-closed and separately disableable. Exact HEAD cannot simply equal the receipt head after evidence metadata is committed, so accepted lineage must be limited to structurally verified metadata-only movement while material, story-files, policy, commands, schema, and build proof remain current.

## Conversational Texture
The user explicitly asked to execute the remediation program and use the process to find loops. They rejected another hour of disproportionate assurance work. The desired experience is visible convergence: six relevant documents remain six, legal long tests show progress, and repeated done_prepare runs explain whether validation executed, reused, skipped, timed out, or failed.
