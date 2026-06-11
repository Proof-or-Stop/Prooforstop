# Plan: B-1b01 worktree repair terminal cleanup

## CHK-001
Implement doctor repair as the explicit terminal/orphan cleanup surface. It should collect terminal registered worktrees, orphan dirs, and terminal story dirs, attempt bounded git worktree removal, remove stale admin metadata, delete terminal story branches where safe, and quarantine unremovable physical directories with .koala-repair-ignore. Verification will cover doctor output returning zero terminal/orphan counts after repair.

## CHK-002
Harden story_discard worktree cleanup. If git worktree remove/prune leaves a missing-path or malformed registry entry, inspect .git/worktrees metadata by story id, branch ref, and gitdir path, remove matching stale admin dirs, then re-check before writing DISCARDED metadata. Verification will simulate malformed registry cleanup and assert git worktree list no longer reports the story branch.

## CHK-003
Update story residue reporting so quarantined physical directories are not treated as Koala terminal worktree problems. A directory with .koala-repair-ignore means repair already surfaced the deletion failure and the remaining state is a filesystem/OS artifact, not active Koala registry residue. Verification will assert story_list/doctor no longer include these dirs in Terminal worktrees.

## CHK-004
Add a safety smoke around repair boundaries. The test should include an active/non-terminal worktree, a terminal residue target, and an unrelated branch/path, then prove repair touches only the terminal residue. This protects against broad rm/prune behavior and documents the expected safety envelope for future changes.
