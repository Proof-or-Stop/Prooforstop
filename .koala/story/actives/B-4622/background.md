## 触发事件
2026-05-15 在 B-c9f5 dirty-gate 系列 story（B-6326/B-a2f1/B-3506/B-cf60/B-4b22/B-8db9）开发过程中观察到一个框架 evidence-hygiene gap：command-policy.ts 把 scope_check_save 的 allowedPhases 限定为 ['PLAN']，config.ts 也只在 PLAN phase tools 列表里登记它。

## 关键洞察
当 story 从 TEST 回滚 DEV 加挂 checklist item（checklist_add 在 DEV 允许）导致 scope 变化时，scope-plan reviewer 无法重写带签名的 scope-check.json，只能口头 pass。scope-check.json 的 gate 只在 PLAN→DEV 由 story_review 消费，后续 phase 不再 re-check，所以这不影响 gate 正确性，损失的只是回滚后 re-scope 的机械证据。

## 方案取舍
本 backlog 只记录不修。修复方向待分析：是保留 scope_check_save PLAN-only，还是拆成两个命令——PLAN 阶段的 planning scope 写入，与 later-phase 的 evidence/scope acknowledgment 写入。属于低优先级 maintenance，不阻塞当前 main，不影响 B-c9f5 dirty gate 闭环。

## 对话纹理
用户明确要求把这个 LOW severity gap 变成可追踪 backlog，不要现在修，不要混进 B-8db9 hotfix，也不要伪造手写的 B-META 容器 ID——交给 story_create 自动生成标准 ID。
