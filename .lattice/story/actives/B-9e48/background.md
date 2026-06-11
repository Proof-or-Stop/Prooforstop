## 触发事件
2026-05-12 SimCell B-e101 DONE output reported git worktree remove on .worktrees/B-e101/PVSC, then left story/B-e101 and the real .worktrees/B-e101 registered. This is a concrete field regression, not a theoretical cleanup concern.

## 关键洞察
The cleanup code treats process.cwd() as the story worktree root, but agents often run project commands from nested package directories such as PVSC. A cwd-in-worktree gate is not enough; cleanup must canonicalize to git rev-parse --show-toplevel before any destructive operation.

## 方案取舍
The conservative fix is to keep the current DONE lifecycle and only replace cwd-derived paths with a canonical worktree root. That avoids changing the merge model while hardening metadata commit, stray cleanup, worktree removal, and branch deletion.

## 对话纹理
The user noticed scary warning output and a leftover branch after a successful DONE. The important product outcome is quiet, trustworthy cleanup: no child directory removal, no stale branch, and no stale TEST metadata after DONE.
