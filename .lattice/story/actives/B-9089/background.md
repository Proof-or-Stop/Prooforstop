## Trigger Event
On 2026-06-20 after B-a781 produced the Owner Session Contract Execution Plan, the user asked to execute the runtime code work from that document and open an implementation story. The specific trigger is the previously observed ppid-changing shell invocation risk for local story owner leases across Codex, Claude Code, and Antigravity/agy.

## Key Insights
The important invariant is not a provider-specific workaround; it is a canonical local owner-session contract. Generic owner-lease and lifecycle code should consume one resolver result, while host-specific session signals live at adapter boundaries. Local session ids coordinate writes but do not prove Authority or reviewer identity.

## Solution Tradeoffs
A single large implementation story gives one coherent migration across resolver, adapters, lifecycle reads, runtime artifacts, and tests, but it raises review risk. The mitigation is to split checklist items by slices, require two-host plan review evidence before code, and keep behavior-preserving tests around the existing owner-lease smoke.

## Conversational Texture
The user is prioritizing parallel multi-host development reliability over narrow Claude-only fixes. They explicitly called out that future hosts should not require a new core exception each time, so this story should favor host-neutral contracts and mechanical guardrails over ad hoc branching.
