# Plan: B-9027 Extract DONE merge and worktree cleanup effects

## 总览

Option A — behavior-preserving extraction。把 `story-advance.ts` 的 DONE merge/cleanup 抽到新文件 `packages/main/src/handlers/done-effects.ts`，纯机械搬迁、不改 DONE 时序、消除 `globalThis.__koalaDoneChecklistRendered`。代码由 koala-implementer 写。

**抽取设计（两个导出函数，跨 actor.send 边界）**：
- `done-effects.ts` 导出 **`runDonePreMergeGate(...)`** —— 封装块 A：`runDoneOracleGate` + F-020 stray-file dry-run + `assertDoneMergeCanApplyBeforeStateMutation`。**显式 `return` rendered DONE checklist 字符串**（取代 globalThis stash）。story-advance.ts 在 `actor.send` 之前调用它。
- `done-effects.ts` 导出 **`applyDoneMergeEffects(...)`** —— 封装块 B：Step1 清 worktree 字段 / Step2 commit metadata / Step2.5 cleanStrayWorktreeFiles / Step3 merge / Step4 worktree remove / Step5 branch -d / cleanupFailure throw / `maybeTriggerAudit`（non-blocking 原样）。story-advance.ts 在 phase=DONE 落盘后的返回段调用它。
- DONE-only 私有 helper（`detectDoneStoryWorktreeContext` / `assertDoneStoryBranchMatches` / `assertDoneMergeCanApplyBeforeStateMutation` / `assertSafeResidualWorktreeRm` / `isRegisteredWorktree` / `pruneWorktreeRegistry` / autoSyncMain）一并迁入 done-effects.ts。
- `cleanStrayWorktreeFiles` / `STRAY_FILE_WHITELIST` 的 re-export（story-advance.ts ~193 行）必须保留，logicTest 依赖。
- **调用时机逐行不变**：`runDonePreMergeGate` 在 `actor.send` 前、`applyDoneMergeEffects` 在 `writeStory(phase=DONE)` 后——时序与现在完全一致。

CHK-001 与 CHK-004 是同一次结构改动（抽取时自然用返回值取代 globalThis），建议一个 implementer 周期一起做；CHK-002/CHK-003 是结果上的回归测试。

## CHK-001: Extract done-effects.ts DONE merge and worktree cleanup from story_advance.ts

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/handlers/done-effects.ts
- Modify: packages/main/src/handlers/story-advance.ts
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**：按「抽取设计」把块 A + 块 B + DONE-only helper + maybeTriggerAudit 全迁入 `done-effects.ts`（两个导出函数）。机械搬迁——步骤顺序、输出文本、failure 抛错文案逐字不变。保留 ~193 行 `cleanStrayWorktreeFiles`/`STRAY_FILE_WHITELIST` re-export。story-advance.ts 只剩「调 `runDonePreMergeGate` → actor.send → writeStory → 调 `applyDoneMergeEffects`」的瘦壳。

**Verify**：`koala validate --story=B-9027` 全绿；`worktree-authority-smoke` 全过；`grep -n "git worktree remove\|git merge ${branch}" story-advance.ts` 找不到 inline 实现。

**DoneWhen**：done-effects.ts 含完整 DONE pipeline 两函数；story-advance.ts 无 inline DONE merge/cleanup 代码；maybeTriggerAudit 在 done-effects.ts 内保持 non-blocking try/catch；现有 DONE 相关 smoke 不回归。

## CHK-002: CORE ACCEPTANCE — pre-merge gate 失败不写 phase=DONE；post-merge 失败保持现有语义

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-advance.ts, packages/main/src/handlers/done-effects.ts
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**：抽取后校验三条核心语义（见 CHK-002 context）。给 `worktree-authority-smoke.ts` 加回归用例：①三道 pre-merge gate（done oracle / stray offender / merge-tree 冲突）各自失败时断言 `story_get` 仍为 TEST、phase=DONE 未落盘；②真实 merge 失败 → 断言 story 已 DONE 且抛出含 `cd / git merge / git worktree remove / git branch -d` 的错误；③worktree cleanup 失败 → 断言 story 已 DONE+已合并且抛错。

**Verify**：`koala validate --story=B-9027` 全绿；新增回归用例全过。

**DoneWhen**：三道 pre-merge gate 失败路径都被测试断言覆盖且 story 未提前 DONE；post-merge 两类失败的「已 DONE + 抛错 + 手动指引」语义被断言覆盖。

## CHK-003: Regression-prove DONE merge ordering 与成功路径不变

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/tasks/worktree-authority-smoke.ts
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**：扩展 `worktree-authority-smoke.ts` 证明成功 DONE 路径：①Step1-5 顺序不变（metadata commit→merge→worktree remove→branch delete）；②DONE 成功输出 byte-identical（DONE Gate Checklist 段 + `✓ 分支已合并` + `✓ Worktree 已清理` + `✓ 分支已删除` + summary 段）；③`branch -d` 失败仅 warning 不 throw 的现有语义不变；④`story-advance.ts` 不再含 inline DONE merge 实现（结构断言）。

**Verify**：`worktree-authority-smoke` 全过；`koala validate --story=B-9027` 全绿。

**DoneWhen**：成功路径顺序 + 输出文本 byte-identical 被断言；story-advance.ts 无 inline DONE merge 实现的结构断言通过。

## CHK-004: 消除 globalThis.__koalaDoneChecklistRendered，改显式返回值/参数

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-advance.ts, packages/main/src/handlers/done-effects.ts
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**：`runDonePreMergeGate` 显式 `return` rendered DONE checklist 字符串；story-advance.ts 用局部变量持有，传给 DONE 返回段（拼进成功消息）。全仓删除 `__koalaDoneChecklistRendered` 的 set/get/delete 三处。CHK-001 抽取时即按此设计落地——CHK-004 是其验证项。

**Verify**：`grep -rn "__koalaDoneChecklistRendered" packages/main/src/` 0 命中；`worktree-authority-smoke` 断言 DONE 成功输出仍含完整 checklist 段；`koala validate --story=B-9027` 全绿。

**DoneWhen**：`__koalaDoneChecklistRendered` 全仓 0 命中；DONE checklist 经显式返回值/参数流到成功消息，文本不丢、位置不变。
