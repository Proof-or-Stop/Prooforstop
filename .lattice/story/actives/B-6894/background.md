## 触发事件
2026-05-27 分析 SimCell 的 B-4f98 时，Koala 正确显示该 story 已通过 init_check_repair 进入 PLAN，但我把「验证 fallback 合规」误延伸成「接下来继续开发 SimCell」。这个具体对话暴露出 B-4f98 类外部 story 的 session_brief/next-step 文案容易诱导 Agent 跨项目续做。

## 关键洞察
init_check_repair 是合法 fallback，但它只修复 INIT_CHECK gate；它不是 independent reviewer，也不是用户授权继续实现当前 story。Koala 需要把 fallback/manual attestation、后续 gate 不降级、以及外部项目需明确授权继续这三个事实放在恢复入口的显眼位置。

## 方案取舍
优先做文案和 smoke test 的低风险改进：在 session_brief/story_get/init_check_repair 输出里增加清晰 warning，不新增硬 blocker，不改签名域和 lifecycle gate。这样能减少误导，又不会影响无 subagent 环境的合法 repair 流程。

## 对话纹理
用户关心的不是 SimCell 本身，而是 Koala 该如何避免 Agent 看见某个外部 story 的下一步就自动接手。回答和验收都要围绕「分析可以，开发必须另有明确授权」这个操作边界。
