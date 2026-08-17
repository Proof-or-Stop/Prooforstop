# Plan: B-08be

## CHK-001

Route lifecycle gate code inspection through the authoritative story worktree cwd. The concrete failure to prevent is a clean story worktree being blocked by unrelated dirty or untracked files in metadataRoot. Investigate `packages/main/src/handlers/scope-contract.ts` and `packages/main/src/handlers/phase-gates.ts`, then patch only the call sites that choose the working directory for git diff, lint, or scope rows. Preserve metadataRoot for story metadata, process events, material hash exclusions, and cross-worktree state.

Verification will include a regression path where metadataRoot contains unrelated dirt and the story worktree remains clean. The expected user-facing result is that the downstream terminal no longer reports unrelated metadata-root paths during REVIEW-to-TEST preflight.

## CHK-002

Apply Proofbound CLI patch-version discipline because this changes runtime lifecycle behavior. Bump the root package, packages/main package, and `LATTICE_CLI_VERSION` brand constant by one patch version. Rebuild the CLI and verify the executable reports the bumped version.

This story must not touch downstream Ranking release versions. It also must not claim DONE merely from code edits; TEST, summary, delivery, and done_prepare still have to pass.
