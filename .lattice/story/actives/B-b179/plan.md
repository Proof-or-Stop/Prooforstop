## CHK-001
### 目标
定义 V1 StoryReadinessReport 的 `localReady` 和 readiness block predicate。
### 计划
1. 在执行计划文档中补写 `StoryReadinessReport` 字段定义：`claims.localReady` 与 `readiness[].blocking` 的关系。
2. 明确 advisory/warn 与 manual/external 的可见性与 next action 语义。
3. 在验证步骤中给出无 blocking 与有 blocking 的判定例子。

## CHK-002
### 目标
把 `done_prepare` 复用条件从当前 HEAD 驱动，改为可抵抗 main 漂移。
### 计划
1. 在决策文档中写明 `done_prepare` 记录 `mainTipAtPrepare`（或等价 merge base）。
2. 规定 `currentMainTip != recordedMainTip` 时的 stale 判定和重跑建议。
3. 与 `target proof` 文案联动，避免误报“READY”。

## CHK-003
### 目标
统一文本流程、Mermaid、SVG 的 READY 判定与 rollback handoff 文案。
### 计划
1. 替换 `Target proof complete` 等模糊术语为 `Any missing, stale, blocking, manual, or external proof for target?`。
2. 在 STOP/输出文本中加入 `no mutation in V1`，并把 rollback 作为 next action 语义。
3. 检查 step 标签、handoff 文案与示例输出在三类表现形态中的一致性。
