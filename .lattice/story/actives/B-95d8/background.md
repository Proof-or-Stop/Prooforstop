## 触发事件
2026-05-21 在执行 Milestone 1 时确认 B-e71f 落地的 INIT→INIT_CHECK 硬门槛（init-check.ts signInitCheck + guard-utils.ts 的 missing_init_check blocker）依赖 koala-review-story-init subagent 调 init_check_set 产出 init-check.json；在无法 spawn subagent 的运行环境里该 gate 没有合法出口，story 永久停在 INIT。同时 checklist.ts 的 update 分支写后只回结论文本，没有 post-write reload 提示。
（用户可见痛点，去机制化表述）改造前：在无法 spawn subagent 的环境里，用户跑 story_advance INIT_CHECK 永远撞 missing_init_check blocker，story 卡死在 INIT、无任何合法出口；checklist_update 写完后用户看不到任何提示，长会话里容易拿着写前的旧快照继续操作而不自知。改造后用户应能：在受控条件下走一条显式可审计的命令把 init-check 补齐并继续推进，且每次 checklist_update 写入后看到一行 reload 软提醒。

## 关键洞察
两个问题共享同一根因家族：流程入口对运行环境能力（能否 spawn subagent）与会话状态新鲜度（写后是否重读）做了隐含假设。fallback 不能削弱 init-check 的签名/反自豁免完整性——EXP-001 已证伪 subagent 与主 agent 在 CLI 视角下机械可区分，所以任何 fallback 仍须保持签名机制 + 模板 fence + 行为规约三层，只是补一条在受控条件下可用的 repair 通道，并给 checklist_update 写后加可见 reload 提示。
（出处补注）EXP-001 指 B-e71f 的实验文档 docs/story/actives/B-e71f/experiments/exp-001.md，结论：subagent 与主 agent 在 Bash CLI 视角下无可机械区分的差异（同 PPID / 同 env / 同 shell snapshot），故 init_check_set 不校验 agentId，反自豁免完全依赖签名 + 模板 fence + 行为规约三层。

## 方案取舍
倾向最小侵入：fallback/repair 走显式、可审计的命令路径而非默默放行 gate；reload 提示走返回文本/stderr 的软提醒而不改变写语义。避免引入新的 agentId 校验（已被 EXP-001 否定）或破坏现有 init-check.json 签名域。具体取舍留待 PLAN 阶段 decision_set 定。

## 对话纹理
用户在 Milestone 1 要求只创建/选定 story 并推进到正确 worktree/phase，明确不在本里程碑改源码，且若 INIT_CHECK reviewer gate 阻塞则如实报告 blocker 与命令、不得绕过。说明用户关注的是流程可用性与诚实的 gate 行为，而非急于落地实现。
（里程碑定义）本 story 分两个里程碑执行：Milestone 1 = 仅创建/选定 story 并推进到正确 worktree 与 phase（不改源码，遇 gate 阻塞如实报告 blocker 与命令、不绕过）；Milestone 2（本次）= 仅完成 PLAN 产物（understanding / decision / verificationIntent / plan.md / scope-plan gate），仍不改源码，story_review 通过后才进 DEV。后续里程碑才落实现代码。
