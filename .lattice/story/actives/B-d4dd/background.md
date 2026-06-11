## 触发事件
2026-06-09 用户确认 baseline 文档已有后，进一步要求做真实 benchmark harness：不能只停留在公式和说明，要能用 baseline 跑记忆召回百分比对比，证明 Lattice 的记忆是否真的找得回、答得准、能关联证据。

## 关键洞察
当前 Lattice-lifecycle-memory-Evolving.md 定义了 MemoryScore、HistoricalRetrievalScore、10k/100k/1M 阈值和 hard fail，但这些只是未来验证契约。真实证明需要一个可运行 harness，把 corpus、gold queries、retrieval result 和分数计算落成机械证据。

## 方案取舍
先做 host-neutral、本地 deterministic benchmark：用 lifecycle-style synthetic corpus 和可追溯 gold facts 验证公式、规模和边界；不引入外部 provider、vector DB 或 embedding model，避免把 benchmark 分数误写成 gate authority。

## 对话纹理
用户关心的是“是否真的被记住”，不是又写一段漂亮文档。因此输出需要有可运行命令、可读 JSON/表格结果、测试覆盖和多 host 审查记录，让用户看到 10k、100k、1M 的召回百分比和 MemoryScore 是怎么算出来的。
