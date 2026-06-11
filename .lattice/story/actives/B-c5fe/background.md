## Trigger Event
B-4a53 在 2026-06-10 验证出当前没有真实 Authority URL、actor key、runner id、session id、server public key，因此没有真实 job、没有 verified receipt，也没有 lifecycle gate 消费强证据。用户随后确认 session ID 只是 identity 字段，不是完整强证据链路。

## Key Insights
后续工作需要跨 Python Authority Server、runner host、Lattice CLI 和 cross-repo validation 四层协作。Lattice CLI 文档必须把 session identity lifecycle、job/evidence envelope binding、receipt refs、gate predicate 和 fail-closed 行为拆清楚，避免把 readiness 或 local diagnostic receipt 误读为 production authority。

## Solution Tradeoffs
本 story 只写执行文档，不实现任何 server、runner 或 gate 行为。这样可以先冻结职责边界、依赖顺序、机械验收和 rollout 检查点，降低后续多仓实现时的重复设计与越权实现风险。

## Conversational Texture
用户关注的是以后不用人陪着的端到端强证据链路，而不是新增一个配置字段。文档要用工程执行语言写清楚什么算完成、什么只是诊断增强、哪些能力必须分仓完成。
