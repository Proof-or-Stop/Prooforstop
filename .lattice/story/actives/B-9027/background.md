## 触发事件
2026-05-16 Lifecycle Phase 2 三步拆分（3a/3b/3c）的第 2 步。Story 3a 抽出 phase-gates + transition-effects 后，story_advance.ts 里仍内联着 DONE merge / worktree cleanup 的全部实现——这是整个 story_advance 中顺序最敏感、风险最高的一段。

## 关键洞察
DONE merge cleanup 的风险不是代码复杂度，而是顺序语义。当前实现必须严格保持：DONE worktree context 检测 → pre-merge stray file 检查 → metadata commit → merge story 分支到 main → 移除 worktree → 删除分支 → 失败信息整形。一旦先把 phase 落成 DONE 再发现 merge 或 pre-cleanup 失败，story 状态就坏了。把它单独抽成一个 story，让 reviewer 把全部注意力集中在「phase 不提前落盘 + merge/cleanup 失败不被吞」这一条不变式上，而不是埋在多模块大 diff 里被「结构变清楚了」的表象带过。

## 方案取舍
新建 done-effects.ts，机械搬入 DONE merge/worktree cleanup 全流程，逐字保持现有顺序与失败语义。story_advance.ts 改为调用 done-effects.ts。不改任何 DONE gate 判定（done-oracle 已在 Phase 1 抽出）、不改 merge 冲突处理行为、不改失败文案。不碰 orchestrator 收口（3c）、不碰 TEST 语义（Story 4）。

## 对话纹理
用户明确指出 3b 必须单独审：DONE merge 的致命细节是「phase 是否提前落盘」，混进 gates/effects/orchestrator 大 diff 里 reviewer 极易漏看。要求 3b 的 checklist 把「不提前落 phase=DONE」列成核心验收项。串行执行，3a 稳定后才做 3b。
