## 触发事件
2026-05-12 在 B-8bb5 修复 finding_cluster 被 DEV phase gate 错挡之后，继续检查同类漂移风险，发现 test_auto/test_story/fixture_batch_add 等旧流程命令在文档里仍被推荐，但当前 active phase matrix 里没有可用阶段。这说明命令可用性、流程事实等级和文档提示之间存在可再次复发的漂移面。

## 关键洞察
这类问题不是普通 prompt 文案问题，而是流程事实问题。只靠 reviewer prompt 或 AGENTS 文案约束，agent 仍可能在错误 phase 调用旧命令，最后得到低质量的“命令不可用”报错。正确边界应该由 CLI、handler 和 gate 在代码里机械判定，同时让 prompt/docs 指向相同事实源。
补充：用户价值不是“内部多一张表”，而是当本地其他项目的 agent 调错命令时，能立即知道这是旧流程入口、root-only 命令还是当前 phase 错误，并得到不会破坏工作区的替代路径。

## 方案取舍
不能把所有旧 test/fixture 命令直接放开，因为部分命令带有清理、回滚或旧生命周期假设，盲目开放可能破坏当前 INIT→INIT_CHECK→PLAN→DEV→REVIEW→TEST→DONE 流程。更稳妥的方案是建立命令生命周期策略表，区分 supported/rootOnly/retired/replacedBy/maintenance/gateEvidence，再用验证脚本防止 registry、phaseTools 和文档继续分叉。
补充：对旧 test/fixture 命令采用保守分流。当前流程需要的验证事实优先走 verificationEvidence 与 validate；保留的兼容命令必须带 destructive guard；被替代的入口用硬编码 replacement hint 拒绝，而不是靠 prompt 记忆。
补充：第一阶段审计范围明确为 CLI TOOLS、DEFAULT_PHASE_TOOLS、PROCESS_FACT_LEVELS 与新增命令策略表之间的一致性；运行时分流优先覆盖 test/fixture legacy 家族，静态验证覆盖所有已注册 CLI 命令。
补充：结构化决策边界固定为三层：CHK-001 只做通用 lifecycle policy 与 phase gate 报错骨架；CHK-002 只做 legacy test/fixture 家族的 replacement、maintenance、gateEvidence 与 destructive guard 特判；CHK-003 只做静态验证，防止前两项终端用户体验回归。

## 对话纹理
用户明确希望 Koala 的所有状态、流程、验证、执行都尽量有硬编码兜底，而不是把正确性寄托在 prompt 自觉上。本次任务延续这个原则：不是为了修一个单点白名单，而是把“流程事实双层契约”落成可检查的代码结构，并让后续本地其他项目使用时得到更清楚的错误和替代提示。
补充：完成标准以用户终端体验和未来维护者验证体验为准：错误信息要能指导下一步，验证脚本要能在新增命令时指出缺失 policy，文档提示不能再把人带回 legacy 流程。
