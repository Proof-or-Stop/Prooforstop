## Trigger Event
On 2026-09-11, benchmark Story B-3a63 completed and committed its Go implementation but stopped in DEV: metadata auto-commit rejected the primary-root Story directory as outside the linked worktree, configuration snapshot discovery could not see the controller configuration, and pre-review reported an unsupported discovery profile.

## Key Insights
The CLI already distinguishes metadataRoot from signedWorkspaceRoot, but metadata writers and discovery readers do not share one root-source model. The acceptance discovery implementation recognizes TypeScript projects only, while the flat enforce consumer treats unsupported coverage and topology-specific mutation proof as mandatory for every project.

## Solution Tradeoffs
Preserve branch isolation and fail-closed evidence integrity. Introduce an explicit controller-to-worktree configuration and metadata projection or equivalent digest binding rather than committing files across Git worktrees. Add a language-neutral registered-command profile for Go and retain strict topology and mutation requirements where the TypeScript ProofStory profile actually applies.

## Conversational Texture
The user wants the benchmark agent to finish valid work without bypass flags or empty patches. Passing focused tests must not become a blanket waiver: missing, failing, stale, or mismatched Go command evidence must still block, and existing TypeScript high-assurance behavior must remain unchanged.
