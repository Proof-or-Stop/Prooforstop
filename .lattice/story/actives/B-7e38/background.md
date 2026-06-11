## 触发事件
2026-05-27 用户同意把 thin local/shadow client 路线推进为隔离的 koala authority enforce 子系统，但要求先按 Koala 流程执行，避免把普通 workflow CLI 错升成生产 authority client。

## 关键洞察
真正的风险不是功能缺失，而是边界混淆：普通 verification_evidence_add 的 accepted true、local JSON 或 shadow evidence 一旦被误读为 receipt-backed L2+，就会重新打开流程伪造空间。

## 方案取舍
本 story 只落 Milestone 0，先记录 PD-2 边界、命名约束和机械防过度声称测试；actor key、job claim、full envelope、receipt verification 都留给后续独立 story。

## 对话纹理
用户明确希望获得无 Mac/CI/headless 场景的 authority 能力，同时保留 Mac Runner 和 Python authority 的现有分工，所以这一步必须温和推进而不是大爆炸式改造。
