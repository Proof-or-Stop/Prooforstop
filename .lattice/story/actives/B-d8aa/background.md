## 触发事件
2026-05-17 convergence_check 在 B-4bae 修复 META audit 容器后，仍因 B-4622、B-d7af、B-da5b 这些 INIT authority=main backlog 显示未收敛，同时 B-6974 是 authority=worktree 且疑似由其他 Claude Code 执行中。用户明确要求不要碰 B-6974，也不要把 parked backlog 和正在执行的 story 混在一起。

## 关键洞察
当前 convergence_check 的“所有 Story 完成”只按 phase 终态判断，无法区分正在执行的 active worktree story 和没有 worktree 的 parked main backlog。这样会把长期停放的 backlog 当成必须立刻完成的红项，导致 convergence 的语义从“当前工作是否收敛”滑向“历史 backlog 是否清空”。

## 方案取舍
不选择直接完成或丢弃 B-4622、B-d7af、B-da5b，因为这会替用户做产品取舍；也不触碰 B-6974，因为它有 .worktrees/B-6974 和 main mirror metadata。选择给 convergence_check 增加明确 parked backlog 口径：parked backlog advisory，active worktree 仍 blocking。

## 对话纹理
上一轮 B-4bae 已把 B-META-framework-audit 从普通 story 完成检查中剥离，并单独增加 Audit backlog。用户随后核验到只剩 4 个 story，其中 B-6974 可能正在被其他 Claude Code 执行，另外三个是 parked backlog。这个 story 只处理这三个 parked backlog 的 convergence 口径，不顺手改任何具体 backlog 内容。
