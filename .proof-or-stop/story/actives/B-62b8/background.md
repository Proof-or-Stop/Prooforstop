## Trigger Event
During B-c163 recovery, the same Codex task entered the same story worktree from a different shell and derived a new PPID-based session id. The new process was treated as a foreign owner and required a stale-lease takeover even though it was the same task context.

## Key Insights
PPID identifies a short-lived process-parent relationship, not a durable task or agent identity. Stability requires two independent dimensions—task identity and agent or role identity—so shell changes remain stable without collapsing implementer, reviewer, delivery, or unrelated task authority.

## Solution Tradeoffs
A repository-global token is simple but unsafe because unrelated tasks and roles would share ownership. A task id alone is also insufficient for role separation. The selected direction keeps explicit LATTICE_SESSION_ID first, prefers validated adapter task-plus-agent inputs, uses a bounded generated fallback, and leaves derived-ppid as a visible warned degradation.

## Conversational Texture
The user observed repeated owner-lease friction while asking the remediation program to run unattended and explicitly identified derived-ppid self-conflict as avoidable workflow waste. They approved the sequence that handles stable owner identity after the closeout-convergence story and before canonical scope and AST-anchor work.
