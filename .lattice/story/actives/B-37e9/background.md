## 触发事件
2026-05-15 起的生命周期治理 4-story 计划，Story 1（B-3740 Lifecycle Registry V1）已 DONE。Story 2 是计划的第 2 步：从 story-advance.ts 抽出 DONE oracle。现状：buildDoneChecklist（story-advance.ts:306 起约 569 行）+ DoneCheckRow 类型 + doneCheckRow 工厂 + 十余个 DONE row 组装逻辑全部内联在 story-advance.ts。

## 关键洞察
story-advance.ts 是 1640 行的巨型 handler，buildDoneChecklist 占了三分之一。它已被两个消费方调用——story-advance.ts:1127 的 DONE gate 和 session.ts:789 的 session_brief DONE pre-check。抽成独立 done-oracle.ts 是后续 transition orchestrator 拆分（Story 3）收益最大、风险最低的第一刀：纯函数搬家，不改 DONE gate 语义。

## 方案取舍
只做机械抽取：新建 core/done-oracle.ts，把 buildDoneChecklist / DoneCheckRow / doneCheckRow + 其私有 row-builder helper 整体搬过去，story-advance.ts 和 session.ts 改为 import。不改 DONE gate 任何判定逻辑、不改 row 顺序、不改 blocking 语义。新增 contract 证明 DONE gate 与 session_brief 渲染同源（消费同一个 done-oracle）。不碰 TEST 语义、不拆 transition orchestrator——那是 Story 3/4。

## 对话纹理
用户把生命周期治理拆 4 story，要求先做 Story 1+2。Story 2 验收要求：现有 DONE checklist smoke 继续过 + 新增 contract 证明 DONE gate 与 session_brief 渲染同源。强调这一步最稳，给 Story 3 orchestrator 拆分铺地基，不动 TEST 语义。
