## Trigger Event
On 2026-06-22, active Orchestrate stories B-3523 and B-fbb6 were found still running from the retired /Users/jek/Documents/Work/Orchestrate root after the project had moved to /Users/jek/Documents/Work/proofbound.

## Key Insights
Prompt warnings and Git hooks help, but Lattice needs a host-neutral CLI guard so any Host or Agent receives the same fail-closed behavior before writing story metadata or advancing lifecycle state in a retired root.

## Solution Tradeoffs
Keep legacy evidence readable in Orchestrate, but block mutating commands unless an explicit human override is present. Prefer a small config-driven guard over broad repository deletion or ad hoc host-specific prompt rules.

## Conversational Texture
The user was concerned that previous completion claims were too soft, so this story should produce mechanical protection and clear verification rather than another verbal assurance.
