## 触发事件
2026-06-03 after B-7fc2 delivery we found two concrete acceptance pitfalls: global lattice in a story worktree could still execute the main checkout dist, and the Codex adapter gate could tell developers to run node bin/lattice-codex.js verify_codex even when that wrapper does not exist.

## 关键洞察
The product contract is not to force every global lattice install to point at the active story worktree. The correct boundary is to make gate evidence and remediation hints resolve the current worktree local CLI or actually available wrapper, while treating global lattice as heartbeat or post-merge main verification unless proven current.

## 方案取舍
We will keep the change narrow: add wrapper-aware command selection for Codex adapter evidence, strengthen current-worktree entrypoint guidance and tests, and avoid unrelated config migration such as koala.config.json to lattice.config.json in this story.

## 对话纹理
The user explicitly rejected Swift or Mac Native App as new-product validation evidence and asked for Claude Code CLI implementation under the Lattice CLI development flow. The output should be mechanical, reviewable, and centered on commands a developer can actually run.
