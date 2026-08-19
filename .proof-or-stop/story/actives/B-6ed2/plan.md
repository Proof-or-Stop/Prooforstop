# B-6ed2 Execution Plan

## CHK-001

Create a focused worktree-local smoke that prepares a real REVIEW story with current signed reviewer passes, runs the built local quorum_submit, and records the pre/post HEAD, process-events bytes, git status and emitted verdicts. Commit the test while it is RED. The RED passes only when exactly six current-material verdicts are emitted but process-events.jsonl remains dirty, and a following validation persistence attempt refuses rather than minting a false PASS. Keep fixture counters and temporary repositories outside the product worktree.

## CHK-002

Reuse the proven exact metadata transaction primitives. Capture clean bounded entry bytes and HEAD before the first verdict append, emit all planned verdicts, validate the exact causal suffix and current HEAD, then stage and commit only the story process-events path. On pre-dirty input, foreign append, HEAD movement, hook/commit/CAS failure or rollback conflict, return a classified failure and restore all framework-owned quorum bytes without staging, deleting or overwriting competing data. Never teach validate to accept quorum-shaped dirt.

## CHK-003

Extend the focused smoke into a table-driven adversarial matrix: clean six-row success and clean worktree; exact bindings and 3x2 count; same-material duplicate refusal; pre-dirty staged/unstaged rows; concurrent foreign append and HEAD race; hook/commit failure; rollback conflict preserving competing bytes; retry after failure; no partial quorum satisfying assurance. Update the L4 process-fact registry/contract and canonical review-assurance documentation only for the new durability guarantee. Run build, focused quorum smoke, process-fact contract, diff check, then routine/DONE-required lifecycle verification during closeout.
