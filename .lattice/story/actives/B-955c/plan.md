# B-955c Execution Plan

## CHK-001
冻结 Evidence Environment、EEA、Host Adapter、Domain Pack、Evidence Platform、Proof Admissibility 与 Gate 的职责边界；更新架构文档与支持矩阵，禁止把 Adapter 描述为存储、真理或完成权威。

## CHK-002
新增环境 descriptor、invocation、command spec、receipt、normalized envelope 与 reason code 类型；实现只读 registry、legacy execution-boundary 映射、canonical digest 和 fail-closed normalization。

## CHK-003
把现有 policy-authorized DONE-required/validation receipt 适配为 execute-local 参考路径，并把 Quantum 现有 read-receipt-only descriptor 投影到共同契约；不新增 process launcher。

## CHK-004
新增 evidence-environment-adapter smoke，覆盖 registry、确定性、身份错配、错误/超时、receipt-only command 注入、completion 字段、host substitution、伪造 producer 与 distinct-host quorum 等正反用例。

## CHK-005
更新论文面向的执行计划、Evidence Platform 架构与 README，明确 M0-M6 实现证据、当前支持矩阵、限制和外部 manuscript handoff 绑定方法。

## CHK-006
复用 done-required-evidence proof surface、DONE_REQUIRED consumer、Proof Admissibility reason codes 与 blocking projection，让 EEA normalized receipt 只能支持显式 claim/consumer；登记 Gate 消费事实并验证 host substitution 在真实 Gate projection 下不随品牌变化。

## Verification order
先构建，再运行 EEA smoke、Pack framework、Quantum、DONE-required validation 与 process-fact contract；任何 fail-closed 负例回归都返回 DEV 修复。

## Out of scope
不实现 Lean、Rosetta、AlphaFold、PINN solver、browser、database、CI 或 Kubernetes Adapter；不新增远端 Authority；不开放 Pack 驱动的任意命令执行。
