## 触发事件
2026-05-16 Lifecycle Phase 2 三步拆分（3a/3b/3c）的第 3 步、收口步。Story 3a 抽出 phase-gates + transition-effects，Story 3b 抽出 done-effects 后，story_advance.ts 里只剩协调逻辑——但仍是内联的，没有独立的 orchestrator 层。

## 关键洞察
前两步把 gate runner、非 DONE effects、DONE merge cleanup 都抽成了独立模块，但「组织一次 transition」的协调流程（读 story → 定 event → 调 gate runner → 触发 state mutation → 调 transition/done effects → 返回成功/失败结构）还嵌在 story_advance handler 里。新建 transition-orchestrator.ts 把这段协调收口，story_advance.ts 才能真正变成 thin handler——只做 CLI 入参解析和把活交给 orchestrator。

## 方案取舍
新建 transition-orchestrator.ts 收口协调流程，消费已抽出的 phase-gates / transition-effects / done-effects / machine / registry / done-oracle。story_advance.ts 退化为 thin handler。第一版只迁移组织逻辑，不改判断结果、不改 CLI 行为、不改 TEST 语义、不动 legacy phase、不动 workflow profile。orchestrator 依赖前两步的模块已存在且稳定，所以必须 3a→3b→3c 串行，3c 最后做。

## 对话纹理
用户把 Phase 2 拆成风险递增三步，3c 是收口。强调 orchestrator 收口前要让 gates/effects/done-effects 先各自过一轮独立 REVIEW 稳定下来。用户作为裁判会检查 story_advance.ts 是否真的 thin（而非只是移注释）、新模块无循环 import、没有顺手改 StoryPhase/legacy/TEST 语义/workflow profile。
