## Trigger Event

Three stories froze on the convergence breaker on 2026-09-04. Their owner leases were held by reviewer sessions that had finished hours earlier, so they were stale. The human ran story_resume from the main checkout and was refused by the lease gate, which told them to rerun with --takeover. They reran with --takeover from each worktree and were refused by the freeze gate, which told them to run story_resume. Each message was correct about its own gate and wrong about the way out.

## Key Insights

story_resume is owner-gated, so a stale lease makes it unreachable without a takeover. enforceConvergenceBreakerGate blocks every command carrying --takeover or --forceTakeover while a story is frozen, precisely so a runaway agent cannot keep seizing leases; that block does not exempt story_resume. The two rules are each sound and together produce a loop with no supported exit. The observed escape, that the lease transfer was applied before the freeze check threw so a third attempt without the flag succeeded, depends on evaluation order and is not a path anyone should rely on.

## Solution Tradeoffs

Exempting story_resume from the takeover block is the smaller change but widens the escape hatch slightly. Letting story_resume implicitly acquire a stale lease, and never an active one, keeps the takeover block intact for everything else and matches the intent that a human, not an agent, clears a freeze. The second is preferred. Either way the regression must prove that an active lease is still not seized and that non-resume takeover commands are still blocked while frozen.

## Conversational Texture

The human asked what the messages meant, since both read as authoritative. The agent driving the stories had told them to add --takeover, which is what tripped the second gate, so the agent owns half of this confusion. The stories are unfrozen now; this draft exists so the next person does not have to discover the ordering accident to get out.
