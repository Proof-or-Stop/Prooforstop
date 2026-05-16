# Plan: B-a370 Fix next/session_brief hints for META container stories

## 总览

修复 F-003：`koala next` / `session_brief` 对 `phase=META` 的 meta-story 容器（`B-META-framework-audit`）输出无效 lifecycle 导航。chosen option A：只在 `session.ts` 的 hint 渲染层加 META 识别，零侵入状态机。代码由 koala-implementer 写。两个 item 都触及 `session.ts` / smoke 文件，串行实现。

**硬约束**：只改 `packages/main/src/handlers/session.ts` + 新增 smoke。若 DEV 中发现必须改 `core/machine.ts` / `handlers/story-advance.ts` / `core/command-policy.ts` / `core/lifecycle-registry.ts` / `audit-meta-store.ts` 或任何 phase transition / gate 逻辑——立即停止，把 story 恢复为 high-risk 全流程，不强行绕。

## CHK-001: next 与 session_brief 对 META 容器输出 audit/finding 专用建议

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/session.ts
- Test: packages/main/src/tasks/meta-story-next-hint-smoke.ts

**实现要点**:
- DEV 先复现：确认所有产出无效 META hint 的代码路径——`computeNextStep` 的 `default` 分支（返回「未知 phase: META」），以及 `session_brief` 的 next-step / 「in INIT 但无 worktree」建议排序是否也把 META 容器卷进 `story_advance --phase=INIT_CHECK` 建议。两条路径都要覆盖。
- 在 hint 计算入口识别 `phase === 'META' || storyId.startsWith('B-META-')`，输出 META 专用建议（指向 audit/finding flow，例如「META 容器：用 koala audit / finding flow 处理，不走 story_advance」），绝不输出 `story_advance` / `INIT_CHECK` / 创建 worktree。
- 把 META 容器排除出普通 lifecycle/worktree 建议排序——在进入排序前就过滤掉（纯渲染层过滤，不碰排序算法本身）。
- 只改 `session.ts`。守住上面的硬约束。

**Verify**:
- `koala validate --story=B-a370` 全绿
- `meta-story-next-hint-smoke` 通过

**DoneWhen**:
- META 容器跑 `next` / `session_brief` 不再出现 `story_advance` / `INIT_CHECK` / worktree 引导，改为 audit/finding flow 专用建议
- 普通 active story 的 next hint 不回归

## CHK-002: 增加 smoke 断言 META hint 走 audit/finding flow 不含 lifecycle 推进

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/tasks/meta-story-next-hint-smoke.ts
- Test: packages/main/src/tasks/meta-story-next-hint-smoke.ts

**实现要点**:
- 新增 smoke（沿用 `packages/main/src/tasks/*-smoke.ts` 范式）：构造 `phase=META` 的 meta-story（用 `audit-meta-store` 的 `ensureMetaStory` 或等价容器构造），跑 `next` / `session_brief`。
- 断言：输出不含 `story_advance --phase=INIT_CHECK` 及其它 lifecycle 推进提示；含 audit/finding flow 引导文本。
- 覆盖 `phase === 'META'` 与 `storyId` 以 `B-META-` 开头两种判据（preMortem #1）。
- 覆盖 meta-story 与普通 active story 共存场景，断言 META 不干扰普通建议排序（preMortem #2）。

**Verify**:
- `meta-story-next-hint-smoke` 通过
- `koala validate --story=B-a370` 全绿

**DoneWhen**:
- smoke 覆盖 phase/前缀两种判据 + 共存场景
- 断言确认 META 输出不含 lifecycle 推进、含 audit/finding flow 引导
