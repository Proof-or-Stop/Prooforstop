## 触发事件
2026-04-27 用户反馈 B-3145 / B-ee6b 流程中出现两个 Koala 框架问题：verification evidence 在记录后只改 findings、summary 等 story metadata 就被判 stale，且 PLAN 阶段调用 testintent_handoff 报未知命令。该问题会导致 agent 重复记录 12 条 evidence，降低流程可信度。

## 关键洞察
这不是业务代码错误，而是 Koala 框架把 git HEAD 等同于代码状态导致 metadata-only commit 误伤 evidence freshness；同时 testintent_handoff 源文件存在但命令不可用，说明 registry、schema 或 phase allowlist 存在漂移。两者都会让正确流程被工具自身阻塞。

## 方案取舍
优先采用语言无关、项目无关的修复：freshness 判断以 evidence commit 之后是否存在代码相关变更为准，而不是简单比较 HEAD；testintent_handoff 通过正式 CLI registry 和阶段可用性恢复，不做单 story 特判。保留代码变更导致 stale 的保护，避免过度放行。

## 对话纹理
用户明确要求继续推进，并把这两个实际使用中遇到的 Koala bug 一起优化进去。前序 B-952f 已修复 convergence false blocker，本轮继续沿用 Koala 流程自身验证 Koala，要求结果能给其他项目稳定复用，而不是靠手动绕过。
