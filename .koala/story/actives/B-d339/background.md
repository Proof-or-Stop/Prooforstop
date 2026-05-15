## 触发事件
2026-05-15 用户确认执行 Koala 框架治理建议，问题集中在 phase graph、machine gate、story_advance preflight、validate evidence 和 managed asset drift 多处事实源分散，容易在生命周期改动时漏改。

## 关键洞察
当前不是单点 bug，而是流程事实没有被一个 typed lifecycle registry 机械约束。短期最危险的是 validate/preflight 异常仍可能推进阶段，以及 koala check 已经报告管理资产漂移。

## 方案取舍
本 story 只做 V0 止血和 V1 只读 registry 基础，不立刻大拆 story_advance。这样能先关闭 fail-open 风险，并用 registry/contract test 建立后续 V2 拆分的安全支点。

## 对话纹理
用户同意先执行，不需要再写厚重多版本计划。交付应该体现为 koala check 漂移被处理、validate 异常会阻塞 TEST、生命周期事实开始有单一 registry 可追踪。
