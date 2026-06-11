## 触发事件
2026-06-02 用户明确授权执行 Host Overflow 方案：当 Codex/Claude Code 遇到多个任务、Codex agent 调度不够时，希望 Lattice 可以调度 Claude Code agent 来承接部分任务，并要求执行到开发完成、测试验证、交付收口。

## 关键洞察
这不是要让 Lattice 重造 Codex 或 Claude Code runtime，而是要把 Claude Code 视为另一个 host adapter。Lattice 的权威层仍然只负责 story、handoff、scope、receipt、evidence 和 gate，外部 host 只能执行被授权的任务包并提交可审计结果。

## 方案取舍
第一版必须优先 manual handoff 和 receipt 可信度，supervised dispatch 只做保守投影或可用性检测，不自动信任外部结果、不自动合并 diff、不提交 production authority。这样可以增加并行能力，同时避免多个 host 互相覆盖状态。

## 对话纹理
用户关心的是当 Codex agent 数量不够时能不能继续推进多个任务，而不是增加一个复杂 Mac App 或自研 runner。交付需要用简单 CLI 表达：生成任务包、给 Claude Code 执行、提交 receipt、由 Lattice gate 验收。
