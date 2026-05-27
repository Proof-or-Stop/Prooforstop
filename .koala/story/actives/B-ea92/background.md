## 触发事件
B-7e38 在 2026-05-27 完成 PD-2 Milestone 0，只记录了 ordinary koala 与 future koala authority enforce 的边界，没有实现任何命令。用户已经同意继续做 authority enforce 子系统，因此下一步需要一个可审计的只读发现入口。

## 关键洞察
Python authority 的 cord-team 仓库已经暴露 GET /v1/authority/policy，合约版本是 authority-policy.v1，purpose 是 discovery，并且测试要求它不能包含 receipt、receiptId、gatePassed 或 accepted。CLI 侧可以消费这个合约，但不能把发现结果当成 receipt。

## 方案取舍
本 story 只实现 policy discovery：HTTP GET、schema/format、CLI 输出和 smoke tests。我们不实现 actor key、runner heartbeat、job claim、provider execution、full EvidenceEnvelope、AuthorityReceipt verification 或 evidence submission。若 nested CLI 解析成本过高，可以用明确的 flat command 并保留 alias 作为受控范围。

## 对话纹理
此前用户反复强调防止流程伪造和事实伪造，也要求 Koala CLI 开发必须遵循 Koala story 流程并由 Claude Code CLI 实现、Codex 验证。这个 story 继续沿用 B-7e38 的边界纪律：先证明只读发现不会变成生产权威路径，再考虑后续里程碑。
