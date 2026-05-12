## 触发事件
2026-05-12 在 B-9e48 和 SimCell B-e101 复盘中确认，DONE cleanup、branch/worktree、review pass、finding schema、express verification policy 都属于流程事实，不能继续只靠 CLAUDE.md 或 reviewer prompt 记忆。用户明确要求同类问题必须编程硬编码，避免再以 warning、残留分支、错误 finding 或文档漂移暴露给使用者。

## 关键洞察
这些问题的共同根因不是某一个 agent 写错话，而是事实源分散：prompt、文档、handler、gate、测试各说各话。只要一个事实会影响 phase、review、test、DONE、evidence、finding/pass、branch/worktree 或 cleanup，就必须有可执行的策略定义和入口校验，否则 reviewer 或主 agent 总会在长流程里漏掉。

## 方案取舍
不把所有文案都做成硬编码规则，只把影响流程判定和审计证据的事实收进 registry/配置表，并在 handler/schema/gate 入口执行。prompt 继续作为行为引导和解释层；代码负责最终判定、归一化、拒绝和测试锁定。这样既避免僵化，也能把历史漂移点变成 regression。

## 对话纹理
用户多次强调‘硬编码兜底 + prompt 辅助’，并追问是不是所有状态、流程、验证、执行、review pass、gate evidence 都要配置化管理。这次 story 的语气应该保持小步、可验证、少承诺绝对零，但要把同类问题从‘靠记忆避免’推进到‘代码入口不允许写坏事实’。
