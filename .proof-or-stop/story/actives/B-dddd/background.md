## Trigger Event
On 2026-07-02, the reviewed plan docs/requirements/decisions/playbook-promotion-worker-execution-plan.md identified that Proofbound can propose candidate playbooks, but V1 still needs a disciplined outcome ledger before any safe recommendation or rejection loop can exist.

## Key Insights
Candidate playbooks are learning material, not runtime proof. The implementation must preserve the host-neutral core, keep candidates out of active runtime memory packs, and distinguish explicit exposure outcomes from ordinary DONE success.

## Solution Tradeoffs
Start with M0-M2 only: red/repro tests, learning-store write discipline, and explicit outcome recording. Defer later lifecycle surfaces so this story fixes real correctness gaps without arbitrary optimization.

## Conversational Texture
The user wants Proofbound to learn from repeated work, but not at the cost of turning advisory learning into a hidden gate or host-specific behavior. The work should stay simple, auditable, and aligned with the product philosophy.
