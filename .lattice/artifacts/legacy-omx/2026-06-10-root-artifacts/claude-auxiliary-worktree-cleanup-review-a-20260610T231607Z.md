# Claude Review Artifact: Auxiliary Worktree Cleanup A

## Original User Task

Use two Claude CLI reviewers and Codex CLI host review to check whether the Lattice auxiliary agent worktree cleanup decision document is executable, host-neutral, and logically consistent. Apply only real correctness fixes; do not optimize for optimization's sake.

## Final Prompt Sent To Claude CLI

Reviewer A: executable correctness only. Return concrete findings only. Check this Lattice auxiliary worktree cleanup decision against implementability and safety. Do not suggest style or speculative optimization. Only real correctness/logical-consistency issues.

## Claude Output Raw

Reviewer A reported these concrete findings:

- Medium: branch deletion should use `git branch -d` first, with `-D` fallback only after patch-equivalence proof still passes.
- Low: `git status --porcelain -uall` is consistent with existing programmatic dirty checks, but could be noted as intentional.
- Medium: candidate discovery must not rely only on path basename because registered worktree paths may be canonicalized; branch discovery and path discovery should be independent inputs.
- Informational: adding a third `story_reconcile` section is architecturally correct and should not modify zombie detection.
- Medium: `git cherry` and `git log --cherry-pick` may disagree in edge cases; disagreement should classify as `unknown`.
- High: `story_reconcile {"dryRun":false}` must acquire the main write lock before deleting branches/worktrees, consistent with DONE and `done_recover`.
- Low: if doctor shares the cleanup primitive, delete behavior should be explicit so terminal-story force cleanup does not accidentally weaken or strengthen auxiliary cleanup semantics.

Reviewer A found no overall blocker once the main-write-lock issue is fixed.

## Concise Summary

The important correctness fixes are: lock standalone repair, classify patch-equivalence disagreement as unsafe, discover candidates through branch and path scans, and use safe branch deletion before force deletion.

## Action Items / Next Steps

- Add main-write-lock requirement to the decision.
- Add immediate re-classification before mutation.
- Change branch deletion policy to `-d` first, `-D` only after proof.
- Add unknown classification for patch-equivalence disagreement.
- Clarify independent candidate discovery inputs.

