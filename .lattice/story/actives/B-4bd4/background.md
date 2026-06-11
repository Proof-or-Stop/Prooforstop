## 触发事件
2026-05-25 B-0f04 完成 cross-end authority contract audit，发现 FU-1/FU-2/FU-3 都取决于同一个 PD-1 决策：Koala CLI 到底是 thin local/shadow client，还是 first-class enforce-mode authority client。

## 关键洞察
如果不先冻结 CLI 角色，后续开发会在错误抽象上投入：thin client 不需要 runner heartbeat 和 L2 signing，而 enforce-mode client 必须满足 Python authority 的 handshake、actor key、run binding、provider diversity 和 receipt 边界。

## 方案取舍
本 story 只做决策和合同冻结，不做实现。Claude Code CLI 负责梳理证据和写决策材料，Codex 只做 PM/verifier，确保不把产品取舍偷换成代码实现。

## 对话纹理
用户明确同意按分工推进：Claude Code CLI 执行，Codex 做项目经理和验证者。用户关心的是防流程欺骗、事实欺骗和后续多仓库开发不要做错方向，因此 Milestone 1 必须先给出可审查的决策依据。
