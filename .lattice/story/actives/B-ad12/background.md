## 触发事件
2026-05-13 用户追问 reviewer 是否真的新上下文是否也可以硬编码兜底。B-69bf 已经把 runtime artifact 分类做成硬编码，但 reviewer fresh context 仍主要依赖 prompt 纪律和 currentReviewRound。

## 关键洞察
真实模型认知隔离不能被完全机械证明，但 Koala 可以硬编码一个 process boundary：每条 reviewer evidence 必须来自本轮独立 review run，并绑定 lane、round、prompt hash、head/material hash。

补充：用户可见成功条件不是多一个内部文件，而是 maintainer 在 REVIEW→TEST 被拒绝时能看到明确原因：缺少 fresh reviewer run、run 与 lane/round/hash 不匹配，或证据来自旧轮次；通过时则能从 review status 看出每个 lane 都有本轮 run-bound evidence。

## 方案取舍
不尝试证明模型脑内状态，而是把可证明的流程事实收紧成 registry/handler/gate contract。旧 story 可以兼容，但新 REVIEW round 应优先甚至要求 run-bound evidence，避免旧 pass 或口头 pass 混入。

## 对话纹理
用户明确要求流程状态、验证、review pass、gate evidence 这类事实都用硬编码兜底，prompt 只能辅助。本次要继续沿用这个原则，把 fresh reviewer 从信任声明升级为可审计运行事实。
