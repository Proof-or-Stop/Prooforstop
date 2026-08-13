## Trigger Event
On 2026-07-25, running `node packages/main/dist/tasks/command-catalog-smoke.js` on a clean main tree exits 1 with `AssertionError: registered lattice-review-channel example field agentType must be schema-valid`. This pre-existing failure is unrelated to story B-e10d and is not currently caught because the smoke is absent from validate.commands.

## Key Insights
The command catalog is already correct: dispatch.agentType (command-catalog.ts:2415) derives its enum from AGENT_DISPATCH_ACCEPTED_TYPES, which deliberately filters out lattice-review-channel because that lane is retired from runtime dispatch and retained only for read-only historical classification. resolveAgentDispatchType throws a `retired` error for it. The real defect is in the smoke: it iterates the full AGENT_DISPATCH_REGISTRY (which still contains the retired entry) and asserts every canonicalName must be schema-valid AND satisfy the runtime contract, directly contradicting the retirement design.

## Solution Tradeoffs
Fix the smoke, not the catalog. Merely skipping the retired entry would let a future stale non-dispatchable agent leak into the enum unnoticed, so instead assert bidirectional consistency: dispatchable entries must be schema-accepted AND runtime-valid, while retired entries must be schema-rejected AND runtime-rejected. Also wire the smoke into validate.commands on the normal tier (it spawns CLI subprocesses, so not the fast set) so this class of catalog/registry divergence is caught going forward; the build it depends on already runs as validate's first step.

## Conversational Texture
The user reviewed the originally-proposed fix (add the agent to the enum) and, through their own bidirectional-consistency acceptance criteria, steered toward fixing the guard instead. They explicitly asked to evaluate the validate.commands cost before bundling it, and to route the change through a proper Lattice story rather than a direct edit.
