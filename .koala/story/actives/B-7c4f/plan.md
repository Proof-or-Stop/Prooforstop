# Plan: B-7c4f

## Goal

Fix three Koala workflow regressions observed during B-ef9c:

- `session_brief` must work in every phase as a read-only recovery command.
- REVIEW gates must use the actual opt-in reviewer set instead of a hardcoded count of five.
- DONE worktree cleanup must not leave the global `koala` command linked to a deleted story worktree.

## Approach

1. Add an always-available read-only command path for `session_brief` without loosening mutation command phase gates.
2. Reuse the opt-in reviewer matching logic for REVIEW round 1 in the state machine path.
3. Add a safe global-link guard around worktree cleanup: only repair links that clearly point into the worktree being deleted.
4. Add a focused smoke test for all three regressions using temporary/synthetic state where possible.

## Verification

- `npm run build`
- `npm run test:flow-stability-smoke`
- `koala session_brief` from this worktree phase
- `koala story_review` / `koala story_advance` gates during this story
