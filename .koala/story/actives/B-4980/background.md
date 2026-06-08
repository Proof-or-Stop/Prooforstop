## 触发事件
2026-06-08 用户在 B-ec81 文档完成后继续确认：memory baseline 需要能用分数证明记忆能力，尤其是历史精确召回、精确答案命中、答案关联证据，以及 10 万和 100 万数据规模下的表现。

## 关键洞察
现有 Lattice-lifecycle-memory-Evolving.md 已经定义了 future-only Memory Recall Validation Contract，但 Scoring and thresholds 还偏向指标清单，缺少用户可直接理解和复用的 100 分制权重公式。

## 方案取舍
只在当前文档中补齐评分 baseline，不实现检索 harness、不选择存储后端、不引入外部 provider，也不把 benchmark score 变成生产授权；这样符合只修真实 correctness gap 的约束。

## 对话纹理
用户关心的不是炫技优化，而是如何证明 Lattice 的 6 层记忆真的能找回、答准、举证并保持权威边界。最终文案要能直接解释为什么这个评分能验证记忆能力。
