# Plan: B-f60c Implement the main write lock for DONE / B-META / shared-main writes

## 总览

session-ownership-and-write-leases.md（B-8596 已固化为真相源）rollout step 3 的实现。把所有
**共享 main 写入口**串行化到一把统一锁，并修复 F-008（partial-DONE）。**不**实现 story owner
lease / takeover / session_brief ownership UX——那是后续第二个 implementation story。

**决策（decision.json，chosen = opt-migrate-mkdir-lock）**：
- 复用 `core/mkdir-lock.ts` 既有 primitive，泛化成统一 main write lock。
- **canonical 锁路径 = `.koala/locks/main-write.lock/`**（用户裁定迁移）。旧
  `.koala/runtime/done-main-merge.lock` 退役、**不留 alias**——除非测试证明有现存
  runtime-cleanup / doctor 依赖必须兼容。
- 同步更新 `docs/requirements/decisions/story-lifecycle.md`，与 session-ownership 文档锁路径一致。
- 迁移范围窄：只改锁路径 + 串行化覆盖 + F-008 修复 + 锁内 idempotency。

**F-008 根因（已坐实）**：`done-effects.ts:356-362` 注释明示——INIT_CHECK 把
`story.worktree`+phase 写进 **main 仓库**的 `.koala/story/actives/<id>/index.json` 却不提交；
该未提交/未跟踪镜像在 DONE 于 main 仓 `git merge story/<id>` 时阻塞自己 → partial-DONE
（B-6974 / B-ad12 真机复现，B-META-framework-audit:F-008 verified）。修复必须从 INIT_CHECK
**写入侧**根治，光串行化不能关闭 F-008。

**B-META** = `B-META-framework-audit` meta-story 容器，`gap_log` 与 `audit --framework`
的 finding 都写入它的 `findings.json`。

**硬约束**：非并发路径外部 CLI 行为 byte-identical（锁对单 session 透明）；不扩到 owner lease。

## CHK-001: Implement the core main write lock primitive

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/mkdir-lock.ts（泛化为统一 main write lock helper）
- Modify: packages/main/src/handlers/done-effects.ts（`acquireDoneMainMergeLock` 迁到新路径/新 helper）
- Modify: packages/main/src/handlers/done-recover.ts（改用新锁）
- Modify: packages/main/src/core/runtime-artifact-registry.ts（登记 `.koala/locks/main-write.lock`）
- Modify: docs/requirements/decisions/story-lifecycle.md, docs/requirements/decisions/session-ownership-and-write-leases.md（锁路径同步）
- Test: packages/main/src/tasks/（新增锁 primitive 的 logic/smoke）

**实现要点**:
- 统一 main write lock：原子 mkdir-style acquire；按 mtime stale-reclaim（沿用现 120s 量级，DEV 据现状定）；acquire 失败 = blocking，不乐观放行（doc Main Write Lock Rules 1-3,6）。
- canonical 路径 `.koala/locks/main-write.lock/`。全仓 grep 旧 `.koala/runtime/done-main-merge.lock` 所有引用并迁移；旧路径不留 alias，除非测试证明现存 cleanup/doctor 依赖。
- 同步 story-lifecycle.md 与 session-ownership-and-write-leases.md 锁路径，消除两份真相源矛盾。

**Verify**:
- `koala validate --story=B-f60c` 全绿
- `rg "runtime/done-main-merge.lock" packages/main/src/` 0 残留（或仅测试证明的 alias）
- 锁 primitive 的 logic test 覆盖 acquire/release/stale-reclaim/并发互斥

**DoneWhen**:
- 统一 main write lock 在 `.koala/locks/main-write.lock/` 工作；stale-reclaim 与 blocking-on-held 成立
- 旧路径引用全迁移；两份决策文档锁路径一致
- 无并发双重持锁

## CHK-002: Hold the lock across the DONE critical section and fix F-008

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/done-effects.ts, packages/main/src/handlers/transition-orchestrator.ts
- Modify: packages/main/src/handlers/worktree.ts（或 INIT_CHECK 实际写 main-side index.json 的 handler——DEV 按 Debugging Contract 坐实）
- Test: packages/main/src/tasks/worktree-authority-smoke.ts

**实现要点**:
- DONE 全程持 main write lock：pre-merge final check → merge → worktree cleanup 都在锁内（rule 4），沿用现 transition-orchestrator 单一 try/finally scope。
- 修复 F-008：先按 Debugging Contract 定位 INIT_CHECK 写 main-side `index.json` 的确切代码点；从写入侧根治——不让未提交的 main-side index.json 镜像残留到 DONE（候选手法：不写 main 镜像 / 写后即 commit / DONE 锁内 reconcile，DEV 选定并说明根因+复现+为何有效）。
- 单 session DONE 成功路径外部行为不变。

**Verify**:
- `koala validate --story=B-f60c` 全绿
- worktree-authority-smoke 新增 F-008 复现用例通过：DONE 前 main 工作区有 INIT_CHECK 期未提交 index.json 镜像 → DONE 不自阻塞、正常合并

**DoneWhen**:
- DONE 全程在锁内；F-008 从 INIT_CHECK 写入侧根治；INIT_CHECK 不再留未提交 main-side 镜像
- 两个并发 DONE 串行化、无 partial-DONE；post-merge 失败语义保持
- 有 root-cause 说明 + 复现测试（Debugging Contract）

## CHK-003: Apply the lock + in-lock idempotency to shared-write commands

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/gap-log.ts, audit.ts, story-create.ts, finding.ts, done-recover.ts
- Modify: packages/main/src/core/audit-meta-store.ts
- Test: packages/main/src/tasks/gap-log-smoke.ts（更新 dedup 断言）

**实现要点**:
- 把 main write lock 应用到 `gap_log` / B-META `finding_*` 写 / `audit --framework` / `story_create` / `done_recover` / main-mirror 写（rule 5）。
- 锁内执行 doc Idempotency Requirements：`gap_log` 按 normalized title+category+source+evidence fingerprint dedup——**反转**当前刻意的非 dedup 行为，需同步更新 `gap-log-smoke.ts:316`（原断言"相同内容写两条"）并新增"不同 gap 不被 fingerprint 误并"断言；`story_create` dedup；finding 写拒绝重复 active finding；DONE recovery 检出已合并/已删 worktree。
- 审计所有 main-write 命令调用图，避免嵌套自死锁（同进程可重入或内层走已持锁路径）。

**Verify**:
- `koala validate --story=B-f60c` 全绿
- gap-log-smoke 更新后通过：并发同 gap → 一条；并发不同 gap → 两条

**DoneWhen**:
- 上述命令的共享 main 写都在锁内；gap_log dedup 生效且 fingerprint 不误并
- 无嵌套 main-write 自死锁

## CHK-004: doctor stuck-lock check and lock-contention error UX

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/doctor（stuck-lock 检查）
- Modify: 锁 primitive / 各 shared-write 命令的 contention 错误渲染
- Test: packages/main/src/tasks/（doctor smoke）

**实现要点**:
- doctor 检出 `.koala/locks/main-write.lock/` 的 stale/stuck 锁并报告；不把正常持有中的活跃锁误报为 stuck。
- 锁竞争产出清晰 blocking 错误，按 doc Error UX 'main lock contention' 范例：持有方 session、正在跑的命令、heartbeat age、重试指引。
- **不**实现 session_brief ownership rendering（owner-lease story 范围）。

**Verify**:
- `koala validate --story=B-f60c` 全绿
- doctor 对 stale 锁有报告、对活跃锁不误报；contention 错误消息字段齐全

**DoneWhen**:
- doctor stuck-lock 检查成立、无误报
- lock-contention 错误消息含 holder/命令/heartbeat/重试指引
- 无 session_brief ownership UX 引入（机械可查）

## CHK-005: Multi-session regression smoke proving F-008 is closed

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Create/Modify: packages/main/src/tasks/（多 session 锁 smoke，新建或扩展 worktree-authority-smoke.ts）
- Test: 同上

**实现要点**:
- smoke 覆盖：两个并发 DONE 串行化、无 partial-DONE race；并发 `gap_log` 同一问题 dedup 成一条 canonical finding；stale 锁被 reclaim。
- **关键**：一条回归断言证明 partial-DONE 不再由 stale main-mirror 自阻塞产生（确切 F-008 场景）。
- 跑回归套件确认无回归。

**Verify**:
- `koala validate --story=B-f60c` 全绿（含新增 multi-session smoke）
- F-008 回归断言通过

**DoneWhen**:
- 多 session 锁 smoke 全过；F-008 回归断言覆盖确切复现场景
- koala validate 全绿、无既有 smoke 回归
