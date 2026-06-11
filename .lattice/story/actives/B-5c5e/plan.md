# B-5c5e Plan: command lifecycle policy

## CHK-001 通用 phase gate 报错由 lifecycle policy 骨架驱动

实现一个代码内 lifecycle policy 事实源，描述命令的通用状态：supported、rootOnly、legacy/retired、maintenance、gateEvidence、allowed phases、reason、replacement。phase gate 仍由 isCommandAllowed/phaseTools 决定是否放行；policy 只在拒绝路径补充用户可执行解释，不改变已有 allow/block 语义。验收重点是普通非 test/fixture 命令在错 phase 被挡时，终端能展示 lifecycle、allowed phases、reason 和通用下一步。

风险边界：不在本项写 test_auto/test_story 等旧验证入口的专门 replacement 文案；这些特判只属于 CHK-002。项目级 phaseTools override 必须继续生效。

## CHK-002 旧 test/fixture 家族在运行时被专门安全分流

只覆盖 legacy test/fixture 家族：test_auto、test_story、test_fixture、fixture_batch_add、fixture_update、test_add、task_coverage。为这些命令声明 replacement/maintenance/gateEvidence/destructiveRisk 组合，并让 phase gate 拒绝时输出当前流程替代路径：validate、verification_evidence_add、verification_evidence_batch_add 或 checklist_update 的 verificationEvidence。

风险边界：不通过简单加白名单修复旧命令不可用；test_auto 的 confirm 和 koala 自身项目拒绝全量自测的 guard 不能退化。test_story/test_add 若仍被 PROCESS_FACT_LEVELS 标为 L4，需要么有明确生产 phase，要么有 replacement 说明。

## CHK-003 静态验证防止前两项用户体验回归

扩展 process-fact contract 和 flow-stability smoke。静态验证以 CLI TOOLS、DEFAULT_PHASE_TOOLS、PROCESS_FACT_LEVELS、command lifecycle policy 为权威清单，检查所有注册命令都有 policy；L4 gate evidence 有生产阶段或 replacement；legacy test/fixture 家族保留 replacement/destructiveRisk；workflow family 不半开半关；文档/prompt 不把 retired 命令作为当前推荐路径。

风险边界：验证脚本必须服务 CHK-001/CHK-002 的终端体验，不做脱离用户价值的纯内部检查。失败信息必须点名具体命令和缺失字段，让维护者能修。
