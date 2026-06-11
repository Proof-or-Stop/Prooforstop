## 触发事件
2026-05-20 用户指出 Koala CLI 项目必须在 /Users/jek/Documents/Work/Orchestrate 下面通过 Koala 创建 Story 并在 Story worktree 中开发，否则后续 Koala Agent 会把直接写在主目录的 CLI 改动视为无 owner、无 checklist evidence、无 lifecycle provenance 的外来物。

## 关键洞察
Verification Context Pack 不是普通工具命令，而是 Python authority server 证据链的客户端组成部分。Koala CLI 必须机械生成 pack、计算 digest、绑定 evidence，并通过 command policy 和 handler registry 暴露，否则 verifier 仍可能只靠自然语言验证结论或自由读仓库。

## 方案取舍
这次不再使用事后 DONE backfill 作为实现依据，而是创建真实 Story worktree，把当前 root 中暂存的实现迁入 worktree 内完成。B-7f2d 只作为背景审计记录，真正代码归属、测试和 verificationEvidence 由本 Story 承担。

## 对话纹理
用户连续追问文档备份、是否必须遵循 Koala CLI 开发流程、既有 CLI 修改是否需要补 Story，最终明确要求按他们的流程实现。这个 Story 的重点是把跨仓库 authority sync 从口头确认变成 Orchestrate 自己能审计、能验证、能追踪的项目事实。
