# B-d925 Plan

## CHK-001

Classify the current main worktree dirty state without changing it. Use git status and git diff summaries to group paths into baseline artifacts, decision docs, B-d925 story metadata, and untracked documents. The output must identify which groups are candidates for commit, restore, or defer. Do not touch .omx.

## CHK-002

Run two independent host audits. Claude CLI and Codex CLI must review the same classification and recommend whether each dirty group should be committed, restored, or deferred. If they disagree on a group, stop and resolve the disagreement before mutating main. Host verdicts are review evidence only, not Authority Server receipts.

## CHK-003

Apply the smallest reconciliation that makes main clean and preserves useful Lattice evidence. Prefer a separate cleanup commit for valid assets. Restore only groups proven to be stale scratch or exact duplicates. After main is clean, retry B-9d6c DONE from its worktree and report whether DONE succeeds or exposes a new explicit blocker.
