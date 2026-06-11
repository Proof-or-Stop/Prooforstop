## 触发事件
2026-06-02 在 B-29b6 完成 Lattice Parallel Wave create/inspect/plan 后，用户明确提出要继续优化多个 Story 并行执行/合并编排、单 Story 多 implementer 分块、Lattice CLI 自动派 Agent，以及项目公共经验库接入。这说明当前 wave 仍停留在 planning projection，尚不能把规划转成可交接、可审计的执行队列。

## 关键洞察
真正提升效率的不是盲目让一个 Story 里塞更多 Agent，而是把并行规划转成 operator 能执行的 dispatch/status/merge/report 表面，并把项目经验库作为 bounded context pack 引入。现有 dev_memory 已经定义 project/global memory，应该复用而不是再造一套真相源。

## 方案取舍
本 story 优先做 guarded executable operator surfaces：dispatch manifest、wave status、merge queue、evidence report、dev-memory refs。暂不让 CLI 直接 spawn Codex/Claude/Gemini，因为当前 CLI 没有签名 host-runner API，贸然自动派发会制造流程伪造风险。

## 对话纹理
用户关心的是开发效率，但也一直强调流程伪造和事实伪造不能回退。因此输出要像一个清醒的项目经理：给出可执行并行计划、清楚显示阻塞和证据，同时把经验库作为辅助记忆，而不是把自然语言经验当 gate evidence。
