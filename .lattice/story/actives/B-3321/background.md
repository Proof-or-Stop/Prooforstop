## Trigger Event
On 2026-06-20, Claude raised the concrete gate concern that DONE only consumes a configured lattice validate subset, so full npm test can be red while a story still merges locally.

## Key Insights
The verified mechanism is a policy gap rather than a single failing test: lattice.config.json defines a subset validate.commands, verifier skips fallback npm test when configured commands exist, TEST writes test-evidence from that subset, and DONE consumes that artifact.

## Solution Tradeoffs
A simple config-only fix could add npm test to validate.commands, but that would make every validation expensive and less portable for external projects. The execution plan should separate normal validation from DONE or release-required validation while keeping evidence hash-bound and fail-closed.

## Conversational Texture
The user is asking for a concrete execution document before code changes, with Lattice core rigor and the existing three-round two-host review discipline preserved so later implementation does not expand scope or weaken DONE semantics.
