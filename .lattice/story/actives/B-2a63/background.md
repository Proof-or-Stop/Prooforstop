## 触发事件
2026-06-09 用户在 B-d4dd 完成 deterministic virtual corpus harness 后指出：还需要产出真实数据进行 baseline 验证，否则只能证明 scoring contract，不能证明当前仓库里的 lifecycle memory facts 能被真实导出、召回和关联证据。

## 关键洞察
上一版 memory_benchmark_run / memory_benchmark_compare 已经固定了权重、阈值、hard checks 和 non-authority boundary，但数据仍是 virtual corpus。新的正确性缺口不是提高分数，而是需要从项目真实 lifecycle 数据源导出 corpus/gold/query/result，让 baseline 可以被审计和复跑。

## 方案取舍
选择新增 real-data baseline 输出，而不是改掉 existing deterministic compare 语义。scoreable truth 只来自 activity/story/checklist/summary 等 lifecycle 事实；dev-memory 和 host transcript 只能作为 boundary-only/advisory，用来验证不越权。输出可以 stdout，也可以写 artifact，但不能成为 Koala gate authority。

## 对话纹理
用户持续强调不要为了优化而优化、不要随意优化、只修真实 correctness issue 和保持逻辑一致性。这里的新增能力应当回应证明问题：真实数据、真实 gold、真实 query、真实结果，而不是换一个漂亮的 synthetic 分数。
