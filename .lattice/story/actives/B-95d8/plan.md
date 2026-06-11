# Plan: B-95d8 INIT_CHECK no-subagent fallback/repair + checklist_update post-write reload hints

> 通道：按 checklist 项数(2)+无 riskSignals 实时判定为 quick，但 priority=high 触发高风险 gate（decision + ≥3 preMortem 已落）。本 plan.md 为高风险 story 的执行手册，非必需但保留以约束 DEV。源码实现属后续里程碑，本里程碑(Milestone 2)只产 PLAN 产物。

## CHK-001: 为无 subagent 环境提供 INIT_CHECK fallback/repair 路径

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/init-check.ts（复用 signInitCheck，新增 fallback/repair 入口或受控分支）
- Modify: packages/main/src/registry.ts（注册新命令，若选独立命令形态）
- Modify: packages/main/src/core/guard-utils.ts（确认 fallback 产物经现有 missing_init_check/init_check_tampered 校验，不放宽）
- Modify: docs/requirements/decisions/story-lifecycle.md, CLAUDE.md（同步 INIT_CHECK 段流程事实）
- Test: packages/main/tests/（fallback 产物签名一致 + 受控条件拒绝 + 篡改仍 tampered 的逻辑测试）

**Verify**:
- `koala validate` 全绿
- repair 产出 init-check.json 后 `koala story_advance --storyId=<id> --phase=INIT_CHECK` 不报 [missing_init_check]
- `npm run test:process-fact-contract` 通过（流程事实双层契约）

**DoneWhen**:
- fallback/repair 走显式命令路径，复用同一 signInitCheck（不复制签名逻辑、不扩签名域）
- 受控/opt-in 条件不满足时拒绝并打印清晰错误，不产出文件、不改 phase
- 每次 fallback 写审计事件（actor/mode）
- 不引入 agentId 校验
- 单测覆盖：产物 _hash 重算一致并通过 canEnterInitCheck；篡改 background/title/description/checklist 后旧 init-check 仍判 init_check_tampered

## CHK-002: checklist_update 写入后输出 post-write reload 提示

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/checklist.ts（update 分支写后追加 reload 软提醒）
- Test: packages/main/tests/（提示出现 + stdout 不被污染 + 写语义不变）

**Verify**:
- `koala validate` 全绿
- `koala checklist_update ...` 输出结论后含 reload 软提醒行
- `koala checklist_update ... | tail` 管道只取 stdout 结论仍正确（提示不污染 stdout）

**DoneWhen**:
- reload 软提醒在写入成功后输出，引导重新加载 story 状态
- 提示走 stderr 或与结论明确分隔，遵循 B-6812 advisory-to-stderr 先例
- 不改变 checklist_update 写语义：写入字段持久化结果与无提示版本逐字段一致
- 单测断言 stdout 仅含结论、提示不混入
