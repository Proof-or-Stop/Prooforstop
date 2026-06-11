## 触发事件
2026-05-11 在完成 B-5d29 后继续复盘，发现核心 gate 已经有硬编码兜底，但 phaseTools 配置异常、validate fallback、test_auto 递归跳过等边缘执行语义仍然缺少统一分级说明。用户明确同意建立统一分级表和配置表，用配置状态管理流程事实。

## 关键洞察
Koala 现在已经把 pass-only finding_add、review_pass_set、verification evidence、init/scope/delivery check 等关键事实写进硬编码，但这些约束散落在 handler、machine 和 contract script 里。缺少一张统一 registry 时，新增命令很容易只补 prompt 或只补测试，而忘记声明它到底是提示、状态、验证还是 gate 事实。

## 方案取舍
最小可行方案不是马上把所有 runtime 都改成配置驱动状态机，而是先建立 L0-L4 process fact registry，列出 command、level、owner、category、rationale 和 gate 消费关系，再让 contract test 从 registry 推导覆盖。这样能先防漂移，同时避免一次性重构生命周期核心。

## 对话纹理
这次需求来自多轮 Koala reviewer 行为观察：docs reviewer 曾把通过记录写成 finding，随后又讨论了所有流程执行、确认、验证都应该有硬编码兜底加 prompt 指路。用户倾向于能硬编码就硬编码，所以交付重点应是机器可检查的事实源，而不是只更新提示词。
