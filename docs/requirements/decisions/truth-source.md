# 真相源管理

## 定义

- **真相源** = `docs/requirements/decisions/*.md`（人的讨论和决策——为什么做）
- **反向提取** = `docs/requirements/extracted/*.md`（从代码/Story 自动提取的参考）
- **Story 不是真相源**——Story 是执行计划，真相源是需求和决策

## 设计原则

- 真相源是 Markdown 文件，不转 JSON
- 每次从 md 文件实时扫描提取，无中间缓存
- 自动创建的 Story 不纳入真相，避免循环依赖
- 创建 Story 时讨论要点自动沉淀到 `docs/requirements/decisions/B-xxx.md`

## 闭环流程

```
truth_scan（扫描需求）
  → truth_analyze（分析矛盾/模糊/缺失）
  → truth_to_story（拆解为 Story）
  → 开发 → task_scan/flow_list（提取代码现实）
  → gap_analyze（对比差距）
  → convergence_check（判断收敛）
```

## MCP 工具

| 工具 | 用途 |
|---|---|
| `truth_scan` | 扫描 docs/requirements/ 提取需求/决策/约束 |
| `truth_nav` | 生成/更新 NAV.md 导航索引 |
| `truth_analyze` | 分析矛盾/模糊/缺失 |
| `truth_to_story` | 需求收敛后拆解为 Story |
| `gap_analyze` | 真相源 vs 代码现实差距报告 |
| `convergence_check` | 判断是否收敛 |
