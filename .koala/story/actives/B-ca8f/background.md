## 触发事件
2026-05-24 B-6bfd 推进 DONE 并合并到 main 后，convergence_check 仍返回 converged=false，唯一失败项是代码注释合规，具体为 3 个注释错误。cli-validate 精确指出 guard-session.ts、review-scope-binding.ts、semantic-scope-gate.ts 的 @task 注释缺少 @changes 字段。

## 关键洞察
这是 B-6bfd 的元数据收敛缺口，不是运行时行为失败。semantic scope guard 功能、delivery_check_set、summary_set 和 DONE gate 都已经通过；剩余问题只影响 Koala 的 annotation compliance gate，会让项目整体收敛报告保持失败。

## 方案取舍
采用最小修复：只补三个新 core 文件顶部 @task 注释里的 @changes 字段，不修改函数逻辑、命令策略、scope gate、review binding 或 guard session 行为。验证只跑 annotation validation、相关 smoke tests 和 convergence_check，避免扩大改动面。

## 对话纹理
用户明确要求 Koala CLI 项目必须遵循 Koala 开发流程，不能绕过 story，也要求 Claude Code CLI 执行实现、Codex 只做监工和验证。因此本修复作为独立 story 处理，确保后续 Agent 不会把这类元数据修补当成外来改动。
