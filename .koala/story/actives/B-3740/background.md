## 触发事件
2026-05-15 B-c9f5 dirty-gate 系列收尾后启动生命周期治理。现状审查：lifecycle-registry.ts（B-d339 建立）已是 lifecycle fact registry，LIFECYCLE_TRANSITIONS 每条 transition 已含 gates / effects / oracleRows / rendererRow，phase-flow.ts（B-fc3b）与 context.ts 已从 registry 派生 phase 图。

## 关键洞察
registry 仍缺两个维度：phase→commands（哪些命令在哪个 phase 合法）和 phase/transition→artifacts（每阶段产出/消费的 artifact 文件）。这两个事实当前散在 command-policy.ts 的 allowedPhases、config.ts 的 DEFAULT_PHASE_TOOLS、process-fact registry 里，各为独立真相源，registry 无法机械证明它们一致。这正是「两个局部正确叠加成全局漏洞」的温床。

## 方案取舍
本 story 只做 registry V1 单一真相源增强：扩 registry 纳入 commands / artifacts 维度，新增 consistency contract test 让 command-policy / DEFAULT_PHASE_TOOLS / process-fact lifecycle 都被同一 registry 校验。明确不改 public 行为、不改 TEST 语义、不动 legacy 主类型、不拆 story_advance —— 那些是后续 Story 2/3/4 的范围。这是最稳的地基步骤。

## 对话纹理
用户把生命周期治理拆成 4 个 story，要求先做 Story 1（registry V1）+ Story 2（DONE oracle extraction），Story 3/4 暂不碰。强调 Story 1 风险低、给后面拆分和语义迁移铺地基，验收要能证明 phase graph / phase event / command policy / renderer-oracle references 至少被同一 registry 校验。
