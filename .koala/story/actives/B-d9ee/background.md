## 触发事件
2026-05-15 用户要求把 mattpocock/skills 里的 grill-me 思路融合进 Koala，并明确不能破坏 Koala 核心 lifecycle 管理和 evidence 管理。这个请求需要沉淀为可追踪的 B-story，而不是口头方案。

## 关键洞察
grill 的价值在于 PLAN 前后的需求澄清、术语统一和设计树追问；它应该帮助 understanding、decision、checklist 和 verificationIntent 更准确，但不能证明行为已经实现。

## 方案取舍
本 story 选择实现 Koala 原生 planning artifact 和 CLI 命令，并让 PLAN review 只做 advisory 消费。暂不把 grill transcript 接入 DONE gate，也不新增 lifecycle phase 或 verificationEvidence kind。

## 对话纹理
用户先询问 mattpocock/skills 尤其 grill-me 对 Koala 的借鉴价值，再追问方案是否只是 skill，最终要求按 skill + CLI artifact + advisory 消费的边界实现一个版本。
