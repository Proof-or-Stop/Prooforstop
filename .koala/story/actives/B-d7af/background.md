## 触发事件
2026-05-16 在 B-37e9（DONE Oracle Extraction）的 R1 finding F-001 修复过程中，发现并修掉了 core/done-oracle.ts → handlers/delivery-check.js 的 core→handlers layer violation。同次审查 implementer 报告 core/machine.ts:8 仍有同型违规：import blockingInitCheckIssues / missingRequiredInitCheckAgents / recomputeInitCheckHash from ../handlers/init-check.js。

## 关键洞察
core/ 模块依赖 handlers/ 模块是向上层依赖违规——core 是平台无关逻辑核心，不应反向依赖 handler 壳。这三个 init-check primitive（gate 判定 + hash 重算）本身只用 StoryStore + crypto 等纯 core 依赖，和 B-37e9 已修的 delivery-check hash 完全同型，可用同样手法抽到 core。machine.ts 是 xstate 状态机配置，被它拖着反向依赖 handler 尤其不该。

## 方案取舍
本 backlog 只记录不修。修复方向：把 recomputeInitCheckHash / blockingInitCheckIssues / missingRequiredInitCheckAgents 抽到 core/init-check-hash.ts（或 core/init-check-gate.ts），handlers/init-check.ts 和 core/machine.ts 都改从 core 消费，单一实现。不改 INIT_CHECK 阶段语义、不改 reviewer 流程。低优先级，不阻塞 main。

## 对话纹理
用户在 B-37e9 收尾核查时确认这条 layer violation 真实存在，明确要求另建独立 backlog story（与 B-4622 / B-da5b 同处理方式），停在 INIT 不现在修，并指出当前生命周期治理第一阶段已够稳，不急着进 Story 3/4。
