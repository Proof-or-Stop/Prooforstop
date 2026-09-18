# Lab host-activity-log-during-validation: detailed record

## Problem
The Claude Code PostToolUse hook (`.claude/hooks/log-tools.cjs`, copied into every project by
`proof-or-stop init`) appended one line per tool call into the repository
(`docs/story/activity.jsonl`) even while that same worktree was running a validation. Validation
fixtures that guard the worktree against mutation observed the host's own bookkeeping: on
2026-09-17 a quorum smoke run with 73/73 cases passing was reported FAIL for exactly this reason.

## Behavior change
A line is written ONLY while the hook holds the product's own workspace validation capacity
ticket, so a validation can never overlap the write.

- The destination is resolved first and every decision is made about it rather than about the
  path that produced it. A symlinked log is refused outright (the hook never follows one), and so
  is anything that is not a plain file.
- The append itself goes through a verified descriptor: opened without following a final symlink,
  required to be a regular file with a single link (a hard link would change another repository's
  file), with the parent directory's identity captured before the open and re-checked after it,
  the descriptor confirmed to be exactly the file the path names, and the parent canonicalized
  again so an ancestor replaced by a link during admission cannot redirect the write.
- Queue holder records are opened non-blocking and no-follow and must be bounded regular files, so
  a FIFO named holder.json cannot hang the hook while it holds its own ticket.
- The destination's OWNER is established before anything is created and again before the write:
  the canonical parent must still belong to the worktree whose ticket is held (or to no repository
  at all when none is held). Containment alone is not ownership - a nested repository inside the
  same tree has its own capacity - and a destination that becomes part of a repository after
  discovery is refused rather than written without that repository's ticket.
- The repository that owns the resolved destination decides: outside every repository the line is
  appended directly; inside one it is written under that worktree's capacity ticket, published
  with the product's own protocol (announce, number, publish, admit).
- Whenever capacity cannot be held - a validation is running or arriving, a capacity record is
  unreadable, discovery is uncertain, or the destination escapes its worktree - the line is
  DROPPED. The activity log is advisory host bookkeeping (a `session_brief` freshness hint), so
  losing lines during a validation is acceptable; delaying or disturbing a validation is not.
- Git lookups ignore inherited repository-selection variables (GIT_DIR, GIT_WORK_TREE and the
  rest), and only git's "(or any of the parent directories)" wording proves a non-repository.
- Missing destination directories are created one component at a time without following links: a
  component that already exists must be a real directory, so an ancestor replaced by a symlink
  refuses the creation instead of creating inside the link's target. The walk starts at the
  filesystem root itself (`/`, a drive root such as `C:\` or a UNC share root such as
  `\\server\share\`), which is never created, so Windows drive and UNC paths work.

Accepted limitation, stated in the code and not to be read as a guarantee: Node exposes no
openat/mkdirat, so every step names a path. A local process that renames an ancestor at exactly
the right instant can still move where a create or an append lands. The window is narrowed to the
smallest it can be without those syscalls - per-component no-follow creation, an open that refuses
a symlink, a descriptor checked against the path it should be, a single-link requirement, and
ownership established before anything is created and again immediately before the write - and it
is not closed. The threat this Lab addresses is the operator's own tools racing a validation, not
an adversary racing the hook.

No durable queue is used. An earlier candidate deferred the lines into a spool and replayed them
after the validation; sixteen consecutive independent audits each found real defects in that
machinery (concurrency, symlinks, cross-filesystem migration, crash recovery, canonicalization),
because a crash-safe ordered queue is a far larger problem than the one this Lab exists to solve.
On the operator's decision that deferral was withdrawn in favor of dropping the lines. The audit
records for those rounds remain under `.git/lab-maintenance/host-activity-log-during-validation-audits/`.

## Verification
RED/GREEN: `node scripts/verify-host-activity-log-during-validation.mjs` (the real hook script,
disposable repositories and a disposable HOME).

- Before (main's hook): 29 failing expectations - two lines and three entries created inside the
  validating worktree, plus every ticket, symlink, discovery and Windows-root expectation.
- After: 83 checks. Every hook invocation must now finish on its own with exit 0 (synchronous
  calls within 10 s); a timeout, signal or nonzero exit is a failed expectation, so a hook that
  hung under contention can no longer pass merely because its log stayed empty. Only the two FIFO
  scenarios, which measure blocking themselves, opt out. A mutated hook that waits for a live
  holder instead of dropping fails 8+ of these expectations. A live validation, one arriving during the hook's choosing window, and an
  unreadable capacity holder each keep the hook out entirely (a full recursive snapshot of the
  worktree shows no new entry at all); logging resumes once the validation ends.
- Interoperability is exercised against the PRODUCT's own `withWorkspaceValidationCapacity` in a
  competing process, in both acquisition orders and in a linked worktree: with the allocator
  holding capacity the hook writes nothing, and with the hook's ticket published first the
  allocator is not admitted until that ticket is gone.
- Destination controls: a directory symlink, an existing log symlink, a dangling log symlink, a
  two-hop symlink chain and a cross-repository hard link all refuse to touch another validating
  repository; a log symlink pointing at a FIFO does not block; a directory outside any repository
  whose `docs` points into a validating repository is refused and written only once nothing is
  validating; replacing the log or its parent with a link into a validating repository WHILE the
  hook is admitted still writes nothing there, and a swap whose directories do not exist creates
  no entry at all; a redirect into a NESTED validating repository, and a non-repository
  destination that becomes part of a validating repository after discovery, both leave that
  repository untouched - the last two synchronize on a barrier the hook reaches after establishing
  the destination's owner and before appending, so the redirect really happens inside that window; a FIFO holder record neither blocks the hook nor leaves its ticket behind.
- Discovery controls: a Git failure with no diagnostic and one naming a path ("not a git
  repository: /work/.git") are both treated as uncertain; GIT_DIR/GIT_WORK_TREE pointing at
  another repository do not redirect the decision.
- Windows roots: native Windows is not available to this verifier, so the hook's own
  `createDirectoryChain` is driven with `path.win32` and a recording filesystem. `C:\repo\docs\story`
  creates only `C:\repo`, `C:\repo\docs`, `C:\repo\docs\story`; `\\server\share\repo\docs` creates
  only paths under `\\server\share\`. The previous candidate tried `\C:` first and dropped the UNC root.
- Unchanged behavior: with no ticket, a dead holder, a ticket for another worktree, or a directory
  outside any repository, the line is written immediately.

## Measured data
The 2026-09-17 quorum smoke run that motivated this Lab passed 73/73 cases and was reported FAIL
solely because of these appends. With the repair the same operator activity produces no repository
write while that worktree validates (0 entries created in the recursive snapshot), and the sibling
Lab quorum-smoke-host-activity-temp-overlap keeps its guard fail-closed, so an append during a
validation would still be a mutation if a host without this repair produced one.
