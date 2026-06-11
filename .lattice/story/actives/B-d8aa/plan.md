# B-d8aa Plan

## CHK-001
Update `checkConvergence` so non-terminal stories are split into hard active blockers and parked backlog. A parked backlog story is exactly `phase === INIT` with no recorded `worktree.path`; it is excluded from `所有 Story 完成`. Any other non-terminal non-META story, including stories with linked worktree metadata, remains a hard blocker. Preserve DONE/DISCARDED terminal filtering and META exclusion.

## CHK-002
Add a separate `Parked backlog` check to the convergence output. The check always passes, reports `无 parked backlog` when empty, and otherwise lists the parked story ids as advisory so humans can decide whether to complete, discard, or schedule them later. Document the semantic distinction in `docs/requirements/decisions/story-lifecycle.md`.

## CHK-003
Extend the convergence smoke with DONE, DISCARDED, META, parked INIT, active worktree, no-parked, and audit backlog regression assertions. The smoke should prove parked backlog does not flip `converged` false while active worktree still does.
