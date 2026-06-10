## Trigger Event
On 2026-06-10 the user approved the next cross-repo real live smoke and explicitly allowed formal staging verification at https://stagging.hostneutral.net/docs, so this needs a tracked story rather than an ad hoc terminal transcript.

## Key Insights
The smoke is only valid if the server is production-capable, exposes proof bundles, and issues a verified gate_decision receipt consumed by Lattice CLI gates. A reachable staging endpoint is not enough if it advertises a local-test or production-inert signing key.

## Solution Tradeoffs
Prefer a narrow smoke story that records readiness, formal commands, receipt verification, and negative controls. Do not optimize unrelated lifecycle or branding code, and do not mix the existing dirty Orchestrate files into this validation branch.

## Conversation Texture
The user wants practical execution, not another abstract plan. The work should be decisive but honest: run the formal checks, use Claude and Codex as independent hosts, and report blockers as real correctness facts instead of polishing around them.
