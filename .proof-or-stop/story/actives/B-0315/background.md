## Trigger Event
On 2026-07-05 after B-3a4d reached DONE, the user asked why version 0.3.157 did not increase even though the story delivered a user-visible milestone_closeout capability proof. The observed DONE line was version bump skipped because no watched CLI/runtime inputs changed.

## Key Insights
The old policy correctly avoided bumping for arbitrary metadata and experiment files, but it misses a narrower class: CLI capability contract/proof changes. These changes can alter what users can rely on even when runtime source stays unchanged.

## Solution Tradeoffs
Do not make every docs or tests change bump the CLI version. Instead add a bounded watched class for CLI capability contract inputs such as docs/CLI.md and packages/main/tests, while preserving the existing exclusion for experiments and general requirements docs.

## Conversational Texture
The user wants version numbers to reflect delivered Proof-or-Stop capability changes rather than only source-code edits. The implementation should be explicit, test-backed, and not silently turn versioning into noisy repository-wide churn.
