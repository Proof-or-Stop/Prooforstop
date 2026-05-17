# Plan: B-6974 Introduce transition orchestrator and thin story_advance handler

## 总览

Option A — **behavior-preserving explicit orchestrator**。新建 `packages/main/src/handlers/transition-orchestrator.ts`，把 `story-advance.ts` 从 transition 协调中枢重构成 thin handler。外部 CLI 行为 / phase 写入时机 / DONE pre-post-merge 语义 byte-identical。代码由 koala-implementer 写。

**抽取设计**：
- `transition-orchestrator.ts` 导出 `runStoryTransition(...)` —— 协调一次 transition：读 story → meta/cwd/deps/session 守卫 → 算 event（含回退映射）→ actor create/start → pre gate（guard / REVIEW→TEST preflight / validate / DONE pre-merge gate）→ actor.send → writeStory（state mutation）→ post effects（metrics / hooks / metadata commit / docs / nextSteps / DONE applyDoneMergeEffects）→ 返回结构（含各 advisory 段）。
- orchestrator **显式 own** actor 全生命周期 + DONE merge lock scope（单 try/finally）+ state-mutation/writeStory 顺序 + pre/post gate 顺序。
- `phase-gates.ts` / `done-effects.ts` 内的 `actor.stop()` 调用**移除**，actor 由 orchestrator 在所有路径统一 stop。
- `story-advance.ts` 终态：参数入口 + `runStoryTransition(...)` + 返回文本格式化 + 必要 re-export。

## 4 个硬验收（用户点名，DEV 必须满足）

1. **actor 生命周期唯一 owner**：DEV 后 `rg "actor\.stop" packages/main/src/` 只在 `transition-orchestrator.ts` 命中；`phase-gates.ts` / `done-effects.ts` 不再有 `actor.stop()`。create/start/send/stop 全归 orchestrator。
2. **DONE merge lock scope 结构化**：`acquireDoneMainMergeLock` / release 在 orchestrator **一个 try/finally** 内；scope 全程覆盖 `runDonePreMergeGate → actor.send → writeStory → applyDoneMergeEffects`。
3. **phase timing 不变**（尤其 DONE）：pre-merge gate 失败 → story 仍 TEST；pre-merge gate 通过后 → 仍「先写 phase=DONE，再做真实 merge/cleanup」；post-merge failure → story 已 DONE、错误显式抛出。
4. **thin handler 可机械检查**：`story-advance.ts` 不再出现 inline git merge / git worktree remove / actor transition 编排 / gate 串接；只允许 re-export 与 response formatting。

## CHK-001: Introduce transition-orchestrator.ts coordinating one transition

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/handlers/transition-orchestrator.ts
- Modify: packages/main/src/handlers/phase-gates.ts, packages/main/src/handlers/done-effects.ts
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**：
- 新建 `transition-orchestrator.ts` 导出 `runStoryTransition(...)`，按「抽取设计」协调一次 transition。
- orchestrator 显式 own actor 全生命周期：create/start、send、并在**所有出口路径**（成功 / guard 失败 / gate 失败 / 异常）统一 `actor.stop()`。
- 从 `phase-gates.ts`（`resolveGuardFailure`）与 `done-effects.ts`（stray-offender 路径等）**移除** `actor.stop()` 调用——这些函数不再自行停 actor。
- DONE merge lock：`acquireDoneMainMergeLock` / release 收进 orchestrator 一个 `try/finally`，scope 覆盖 `runDonePreMergeGate → actor.send → writeStory → applyDoneMergeEffects` 全程（与现 story-advance.ts try/finally 等价）。
- 保持 `pre-merge gate → actor.send → writeStory(phase=DONE) → post effects` 顺序逐行不变。
- 4 段 inline advisory（deps/session/baseline-risk/init-check）作为 orchestrator 返回结构的字段，文本计算逻辑原样搬入、内容不变。

**Verify**：
- `koala validate --story=B-6974` 全绿
- `worktree-authority-smoke` 全过
- 硬验收①：`rg "actor\.stop" packages/main/src/` 只命中 transition-orchestrator.ts
- 硬验收②：lock acquire/release 在 orchestrator 单一 try/finally，scope 覆盖 4 段全程

**DoneWhen**：
- 硬验收①actor.stop 唯一 owner 成立
- 硬验收②DONE lock scope 结构化成立
- 硬验收③phase timing 不变：pre-merge gate 失败 story 仍 TEST / pre-merge 通过后先写 phase=DONE 再 merge / post-merge 失败 story 已 DONE 且显式抛错
- 无循环 import（orchestrator 单向 import gate/effect 模块）

## CHK-002: Reduce story_advance.ts to a thin handler delegating to the orchestrator

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-advance.ts
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**：
- `story-advance.ts` 的 `story_advance` handler 改成：解析参数 → 调 `runStoryTransition(...)` → 把返回结构格式化成 CLI 文本 → return。
- 保留 `cleanStrayWorktreeFiles` / `STRAY_FILE_WHITELIST` / `buildDoneChecklist` 等必要 re-export。
- 移除 story-advance.ts 内所有 inline transition 协调：actor 生命周期、event-type/回退映射、gate 串接、state 持久化、DONE pre-check 串接、merge/cleanup——全部归 orchestrator。

**Verify**：
- `koala validate --story=B-6974` 全绿
- 硬验收④：`grep` story-advance.ts 找不到 inline `git merge` / `git worktree remove` / `actor.send`/`actor.start` 编排 / gate 串接

**DoneWhen**：
- 硬验收④thin handler 可机械检查成立——story-advance.ts 只剩参数入口 + runStoryTransition 调用 + 返回格式化 + re-export
- 各 transition 外部行为不变

## CHK-003: Regression-prove zero CLI/semantics change and no circular imports

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/worktree-authority-smoke.ts
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**：
- 扩展 `worktree-authority-smoke.ts`：证明每个 transition（INIT_CHECK/PLAN/DEV/REVIEW/TEST/DONE 及合法回退）的外部 CLI 输出 byte-identical；DONE 成功/失败路径不变；4 段 advisory 文本不变。
- 跑回归套件：build + flow-stability + validation-protocol + lifecycle-registry-contract + process-fact-contract + runtime-fact-contract + worktree-authority-smoke。
- 断言无循环 import、无 global/shared hidden handoff。

**Verify**：
- 回归套件全过
- `koala validate --story=B-6974` 全绿

**DoneWhen**：
- 4 个硬验收都有回归断言覆盖（actor.stop 唯一 owner / lock scope 结构化 / phase timing 不变 / thin handler）
- 各 transition 外部行为 byte-identical；TEST/legacy/profile 语义未变；StoryPhase 类型未碰
- 无循环 import、无 global/shared hidden handoff
