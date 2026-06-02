## 触发事件
2026-06-02 用户批准 8 个 authority-runner milestones，并要求走 Lattice CLI 流程验证多 story / 多 agent 并行能力。

## 关键洞察
B-7e38 和 B-ea92 已经完成边界与 policy discovery，但 TS CLI 仍是 workflow thin client；真正的 headless runner 需要先有可测试的合同模型、canonical signing 和 endpoint client。

## 方案取舍
先做 contract/signing/client primitives，不直接执行 provider，也不让普通 verification_evidence_add 变成生产 authority。这样后续执行和 receipt gate 可以依赖一个小而稳定的底座。

## 对话纹理
用户反复强调不能伪造流程和事实，同时服务器未来可能收费，所以开发必须同时保留本地 off/local 路径和显式 enforce 路径，不能让未付费/未配置服务器的用户被卡住。
