## Trigger Event
On 2026-07-05 after commit d3d8b3b83, the user asked how to record provenance when DONE skips the CLI patch bump for non-runtime experiment/protocol artifacts. The exact symptom was a successful DONE merge with no semver increase.

## Key Insights
The CLI patch version is a runtime capability marker, not a repository-wide artifact ledger. Expanding the bump predicate to all docs or experiments would create noisy version churn and blur the boundary between runtime behavior and research/product artifacts.

## Solution Tradeoffs
Add a separate append-only artifact release ledger for DONE-delivered non-runtime artifacts. Keep packages/main runtime bump rules intact, exclude story metadata and runtime internals, and make the provenance record inspectable by CLI instead of overloading package semver.

## Conversational Texture
The user wants proof that important work was delivered even when semver does not move. The implementation should be explicit, host-neutral, and auditable, while avoiding arbitrary optimization or noisy automatic version changes.
