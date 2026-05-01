## 触发事件
2026-05-01 在 Prodenovo 仓库验证 B-e8bb 和 B-96c1 后，koala doctor 仍显示 terminal registered、orphan dirs、terminal dirs，story_list 仍显示 Terminal worktrees，说明 DONE/DISCARDED 后的 repair 链路没有完整覆盖异常 registry 和物理残留。

## 关键洞察
只读命令副作用已经收敛，但 cleanup 问题不在查询层，而在 git worktree registry、story terminal branch、以及 macOS/iCloud 不可删除目录的组合状态。repair 必须可超时、可兜底清理 admin dir，并对不可删除残留做显式 quarantine。

## 方案取舍
优先修 doctor --repair 和 story_discard 的清理职责，让 mutation 命令负责恢复 registry；story_list 只识别健康状态并跳过已 quarantine 的物理残留。这样避免把无法删除的文件系统问题继续冒充 Koala worktree 问题。

## 对话纹理
用户明确指出只读副作用已经修好，但 DONE/DISCARDED worktree 清理和 repair 还没有修好，并要求继续修复。修复目标是让用户看到 doctor/story_list/worktree list 都回到可解释、可重复的干净状态。
