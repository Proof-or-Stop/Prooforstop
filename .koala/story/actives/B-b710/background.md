## 触发事件
2026-06-02 用户明确要求：服务器后续可能收费，所以不开 authority 时 Lattice CLI 必须仍可本地自己跑起来。

## 关键洞察
当前 authority_status 可以显示 not-configured，但后续加 runner 后容易把 missing server 变成全局 blocker；必须把 local/off、shadow、enforce runner 三条路径机械分开。

## 方案取舍
本 milestone 只增强 readiness/status、config normalization 和 tests，不实现 runner 执行本身；它作为并行 story 可以和 contract primitives 同时推进。

## 对话纹理
用户想要强防伪，但也不希望普通编程流程因为未配置 Python authority 而误拒绝；输出必须说明何时只是 local evidence，何时才是 production receipt。
