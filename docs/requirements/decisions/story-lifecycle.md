# Story 生命周期

> 当前主流程使用第二版 Koala flow：
>
> `INIT -> INIT_CHECK -> PLAN/快速跳过 -> DEV -> REVIEW -> TEST -> DONE`
>
> 旧 `TEST_CASE` / `TEST_CASE_REVIEW` / `testIntent` 只作为 legacy 兼容数据保留。当前活跃口径是 checklist item 上的 `verificationIntent`，DEV/REVIEW/TEST 阶段记录的 `verificationEvidence`，REVIEW 阶段的 reviewer agent/lane（包含 `koala-review-test-coverage` 覆盖审查 lane），以及 TEST 阶段的 `koala validate`。

## 阶段流转

```text
INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE
                              ^        |        |
                              |        v        v
                              +------ DEV <-----+
```

快速通道可以在 gate 允许时跳过部分计划材料，但不能跳过 worktree、review、validate、DONE evidence 等确定性状态。

## Phase 编号与健康检查

Koala 给可执行主流程 phase 一个稳定编号，用于 `koala status` 展示进度：

| 编号 | Phase | 说明 |
|---:|---|---|
| 1/8 | IDEA | 需求还未形成 checklist，兼容旧数据和草稿入口 |
| 2/8 | INIT | story 已创建，尚未 bootstrap worktree |
| 3/8 | INIT_CHECK | worktree bootstrap 检查/创建阶段 |
| 4/8 | PLAN | 理解快照、checklist、verificationIntent、必要 decision |
| 5/8 | DEV | 实现代码并记录 verificationEvidence |
| 6/8 | REVIEW | reviewer 审实现，coverage reviewer lane 审 verificationIntent 覆盖 |
| 7/8 | TEST | `koala validate` 写 validation evidence / bug |
| 8/8 | DONE | 完成、合并、清理 worktree |

`DISCARDED` 是终止态，不参与主流程进度百分比。`TEST_CASE` 和 `TEST_CASE_REVIEW` 是 legacy phase，只为旧 story 可读和迁移保留；新的 story 不应主动进入它们。

编号只用于可观察状态，不用于判断是否异常。Koala 的流程允许合法回退，因此不能用“当前编号必须等于上个编号 + 1”来判错。健康检查必须使用合法 transition graph：

- 正向：`INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE`
- 兼容正向：`IDEA -> INIT`、`IDEA -> PLAN`
- 快速通道：`INIT_CHECK -> DEV` 可在策略允许时进入实现
- 合法回退：`DEV -> PLAN`、`REVIEW -> DEV`、`TEST -> DEV`
- Legacy 兼容：`TEST_CASE -> DEV`、`TEST_CASE_REVIEW -> DEV`、`TEST_CASE_REVIEW -> TEST_CASE`、`TEST_CASE_REVIEW -> TEST`
- 终止：任何未完成 story 可通过 `story_discard` 进入 `DISCARDED`

`koala status` / `koala session_brief` 应展示当前编号、allowed next、allowed rollback，并在 main metadata 与 linked worktree phase 不一致时明确执行权威：

- 有 linked worktree 时，worktree 内 story metadata 是执行权威。
- main metadata 只作为索引和恢复入口，可能滞后。
- 输出必须给出下一步应该 `cd` 到哪个 worktree。
- Dashboard / `session_brief` 的 DONE 展示必须区分 lifecycle 与 outcome：`Lifecycle DONE: N/M` 只说明 phase 已 DONE；`DONE-success/default`、`DONE-blocked`、`DONE-audit-only` 才说明终态性质。旧 summary 没有 `outcomeKind` 时进入 success/default 兼容桶。

## Phase 职责和门禁

| Phase | 含义 | 进入门禁 | 产物 |
|---|---|---|---|
| INIT | story 已创建 | `story_create` 成功 | story metadata、background |
| INIT_CHECK | worktree bootstrap | init reviewers / draft gate 通过（或受控 `init_check_repair` fallback），git 可用 | `.worktrees/B-xxx`、`story/B-xxx` |
| PLAN | 拆解和验收意图 | cwd 在 worktree；高风险 story 要 understanding + decision/preMortem | understanding、checklist、verificationIntent、decision |
| DEV | 实现和记录证据 | PLAN/review gate 允许 | 代码、checklist status、verificationEvidence |
| REVIEW | 独立审查 | DEV checklist 已完成、改动已提交 | reviewer findings、coverage reviewer result / review pass |
| TEST | 自动验证 | REVIEW blocker 已解决，preflight gate 通过 | `koala validate` evidence、bug/test runs |
| DONE | 收束 | validate PASS、bug fixed、evidence fresh、summary/delivery gate 通过、branch 包含 main | merge main、清理 worktree、summary |
| DISCARDED | 已废弃 | `story_discard` | discard event、清理结果 |

### INIT_CHECK 无 subagent 受控 fallback（B-95d8）

正常路径下 `INIT → INIT_CHECK` 要求独立 INIT reviewer（`koala-review-story-init` + `product-reviewer`）通过 `init_check_set` 写签名 `init-check.json`。无法 spawn subagent 的环境（CI sandbox / 无 subagent runner）此前没有合法出口，story 永久卡在 `[missing_init_check]`。

`koala init_check_repair` 提供**显式、可审计、不削弱签名**的 fallback（INIT 阶段，`ownershipClass: storyScopedMutating`，owner-gated 的人工 override，不是 reviewer-lane write）：

- **默认禁用**：缺 `acknowledge:true` 或 `fallbackReason` < 30 字符即拒绝，不产出文件、不改 phase。
- **复用 `signInitCheck`**：签名域不变；事后改 background/title/description/checklist 任一仍触发 `[init_check_tampered]`。
- **不放宽 gate**：必需 reviewer 覆盖记成 `<required>@fallback`（`initCheckAgentMatches` 认前缀），既满足校验又与独立 reviewer 机械可区分；人工 attest 的 high/critical issue 仍走 `blockingInitCheckIssues` 自我阻塞。
- **审计**：写 `init-check.json.fallback`（mode/reason/evidenceRefs/actor/session/attestedAt/headHash/materialHash）+ `init_check_fallback` process event；`story_get` 暴露 `initCheckAttestation`（`fallback`/`independent`）+ `initCheckFallback` 块供 dashboard/report 区分。
- 不引入 agentId 机械校验（EXP-001 已证伪调用方机械可区分性）。

canonical 命令模板与设计约束详见 CLAUDE.md「INIT→INIT_CHECK 硬门槛」段。

## 自动回退

- **REVIEW fail**：finding 或 coverage reviewer lane 发现问题时回 DEV。
- **TEST fail**：`koala validate` 失败后写 bug/evidence，修复路径回 DEV。
- **DONE gate fail**：保留在 TEST，按 DONE checklist 的失败项补 evidence、summary、delivery check、main sync 或 git clean。

回退后主 agent 应先读失败证据，再决定改代码、补 evidence、补文档还是调整 checklist。不要用解释替代修复。

## 合并态组合审查（流程框架并行 story）

> 本节是该规则的 **canonical 详细版**。`CLAUDE.md` 只保留短摘要并 see-also 指向这里；两份不是独立等价副本。

这是一条 **advisory 流程纪律**，不是 CLI gate，不会被状态机自动强制。它补的是单 story REVIEW 结构性看不到的盲区。

### 为什么需要

单 story REVIEW 永远只看一个 story 自己的 diff，看不到「两个各自局部正确的 story 叠加后形成全局漏洞」这类跨 story 交互缺陷。

**起源 incident**：2026-05-15 的 hotfix B-8db9 修复了一个 CRITICAL gate 绕过——B-cf60（declared artifact 声明）与 B-4b22（把 `declared_artifact_changes` 设为 non-blocking 的 dirty-gate-policy）各自 DONE 时单 story REVIEW 都独立通过，但合并到 main 后两者叠加形成 DONE dirty gate 绕过：agent 可以声明脏 source 文件绕过 gate。这个漏洞完全靠一次事后的合并态只读审查才被发现。

### 触发范围

当**多个「流程框架类」story 并行开发并合并到 main** 时触发。流程框架类 story 指触及以下任一资产的 story：

- dirty / 工作区状态 classifier（各类别如何被判定）
- gate policy（某类改动是 blocking 还是 non-blocking）
- 命令入口门禁（handler 入口的拒绝规则）
- auto-commit（自动提交逻辑、与 dirty 状态的交互）
- DONE merge 语义（合并回 main 时哪些东西会被带过去）

### 规则

合并后必须对 main 的**合并态**（即并行 story 全部合并进 main 之后的实际状态）做一次只读 combination review。这是只读审查，不改代码，目的是发现叠加缺陷，发现问题再走正常 story 流程修。

### 枚举检查清单

combination review 必须逐项过下面这张清单——这是为了防止 combination review 退化成橡皮图章：

1. **分类优先级顺序**：classifier 各类别的判定先后是否仍自洽？某个 story 新增的类别有没有把另一个 story 依赖的判定顺序顶掉？
2. **gate policy 表**：把所有受影响类别的 blocking / non-blocking 取值列出来，确认叠加后没有出现「本该 blocking 的类别被某个并行 story 改成了 non-blocking」。
3. **命令入口门禁**：各 handler 入口的拒绝规则叠加后是否仍然完整？有没有某个 story 放宽的入口正好是另一个 story 假设会被拦住的路径？
4. **auto-commit / dirty 状态交互**：auto-commit 行为与 dirty 状态分类叠加后，会不会让本该被 dirty gate 拦住的改动被自动提交掉、或被归类成无害？
5. **DONE merge 语义**：声明物 / 未提交文件在 DONE merge 时是否会被带进 main？某个 story 新增的「声明即放行」语义叠加另一个 story 的 merge 行为，会不会让脏文件静默进 main？

### Out of scope

普通业务 story **不触发** combination review。本规则只针对流程框架类 story（上述触发范围列举的资产）。对普通业务 story 强加合并审查只会制造 review 疲劳，反而让规则被整体忽略。

## Worktree 隔离

每个 story 在独立 worktree 中开发，分支名 `story/{storyId}`。多并发 session 互不干扰。

- `story_advance -> INIT_CHECK`：自动创建 worktree + 切分支。
- `story_advance -> DONE`：自动 merge 回主分支 + 清理 worktree + 删分支。失败返回错误提示由 agent 处理。
- `story_advance -> DONE` 在触发任何 main-affecting preflight 前必须持有统一的 main write lock，canonical 路径 `.koala/locks/main-write.lock/`（B-f60c 起；旧 `.koala/runtime/done-main-merge.lock` 已退役、无 alias）。锁覆盖 main divergence check / autoSyncMain / DONE pre-merge gate / phase 写入 / main merge / worktree cleanup / branch delete；拿不到 live lock 时必须在写 `phase=DONE` 前失败并提示稍后重试。stale lock 可由锁原语回收。canonical 锁路径定义见 `session-ownership-and-write-leases.md` 的 Storage 节。
- **story owner lease（B-c55d 起）**：单 story 的 authoring / lifecycle mutation 由 per-story owner lease 串行化，与 main write lock 正交——main write lock 管跨 session 的 main / B-META 共享写，owner lease 管「一个 story 一个 mutating owner」。lease 落盘 `.koala/story/actives/<storyId>/owner-lease.json`（运行时产物，DONE 前不留脏写）。第一条 story-scoped mutating 命令 acquire lease，owner 命令刷新 heartbeat，DONE/DISCARDED+cleanup 成功时 release。非 owner 的 storyScopedMutating / dangerousMutating 命令在单一 CLI choke-point gate（`enforceStoryOwnerLeaseGate`，按 `CommandPolicy.ownershipClass` 判定）fail-closed 拒绝，错误消息含被 own 的 storyId / owner sessionId / cwd / heartbeat age / stale 标志 / 下一步动作；read-only 命令永不被拦。heartbeat 超 30 分钟无刷新判为 stale，可 `--takeover` 转移；活跃 lease 需 `--forceTakeover`（人工批准），两种转移都记 `story-owner-lease-takeover` audit event。`session_brief` 渲染 `## Story ownership` 段（owner session/cwd/heartbeat age/stale|active/是否本 session/推荐动作）；B-META 容器单独渲染 `## Shared audit state (B-META)` 段且不建议 story_advance。完整规则见 `session-ownership-and-write-leases.md`。
- 如果 post-merge 路径失败导致 story 分支已经写入 `phase=DONE`、但 `story/B-xxx` 尚未合并进 main，这叫 partial-DONE。`koala doctor` 必须在 `Partial-DONE scan` 中列出这类 story，并给出 `koala done_recover --storyId=B-xxx`。`done_recover` 自身也必须先拿同一把 `.koala/locks/main-write.lock/`，然后只在 main clean、story worktree clean、story branch 存在且 `merge-tree main story/B-xxx` 可干净应用时执行；它会完成 merge、worktree remove、worktree prune 和 branch delete。它不是通用冲突解决器，也不会删除带本地改动的 story worktree；冲突或脏 worktree 仍要求人工处理。

通过 `git rev-parse --abbrev-ref HEAD` 检测当前分支，`story/` 开头则提取 storyId 识别 active story。

主目录 `session_brief` 必须同时看主目录 story metadata 和 linked worktree 内的真实 story metadata。如果两者 phase 不一致，输出应采用：

```text
B-xxxx REVIEW (authority:worktree, mirror:INIT_CHECK)
→ cd /path/to/.worktrees/B-xxxx
```

这表示继续工作时以 worktree phase 为准；main phase 只是滞后索引，不应该触发重复推进。

### Convergence 中的 parked backlog

`koala convergence_check` 的硬性 `所有 Story 完成` 口径只统计正在执行或已进入 worktree 流程的非终态 story。`phase=INIT`、没有记录 `worktree.path`、且 `git worktree list` 中也没有 linked `story/<id>` 分支的 story 视为 parked backlog：它仍会在独立的 `Parked backlog` advisory 行展示，提醒用户后续完成、废弃或排期，但不会单独让 convergence 变红。

一旦 story 有 recorded `worktree.path`、linked git worktree branch，或 phase 已推进到 `INIT_CHECK` / `PLAN` / `DEV` / `REVIEW` / `TEST` 等非终态执行阶段，它就是 active blocker，必须继续完成、回退修复或明确 discard。`META` audit 容器和 `DONE` / `DISCARDED` 终态 story 不进入这个 hard completion check。

## 设计决策

- **Story 即 Feature**：Story 是最小可追踪单元。
- **状态机管理**：使用 xstate，而不是散落的手写 if。
- **门禁不可跳过**：REVIEW/TEST/DONE 都必须由确定性 gate 判定。
- **verificationIntent 前置**：PLAN 记录 happy/edge/adversarial 验收意图。
- **verificationEvidence 跟随实现**：DEV/REVIEW/TEST 挂真实证据，不再把测试阶段拆成旧 `TEST_CASE` 流程。
- **Grill 只澄清意图**：`grill_start` / `grill_record` / `grill_close` 写 PLAN 阶段的 `grill.json` planning artifact，`grill_get` 可全阶段读取。Grill clarifies intent; evidence proves behavior. Grill transcript 不能替代 `verificationEvidence`、review pass、delivery check 或 `koala validate` validation evidence。
- **evidence kind 允许自然 aliases**：持久化 kind 仍是 `logic_test` / `manual_transcript` 等规范值；CLI 接受 `logic`→`logic_test`、`cli`→`manual_transcript`，避免 plan.md 和命令表面口径打架。
- **DONE evidence 必须新鲜**：`koala validate --story` 写入测试运行时的 git HEAD/material hash。DONE gate 比对当前 story 分支，验证语义相关文件变化会让旧 evidence stale。
- **stale evidence 不能被“测试通过”覆盖**：`koala validate` 如果发现 verification coverage missing/stale，JSON 必须是 `allPass:false`，提示也必须指向补 evidence，而不是说“验证全绿”。可用 `verification_evidence_refresh_stale --storyId=B-xxx --dryRun` 查看需刷新项；重跑对应验证命令后去掉 dryRun 刷新 metadata。
- **Gate oracle 与 renderer 分离**：DONE pre-check 等 gate 输出必须先形成稳定 row contract（`id/status/detail/hint/source/blocking`），`status` / `session_brief` / `next` 只渲染这些 row。展示层不能用 phase 或 label 文案复制一份 gate 规则。
- **下一步提示必须 phase-aware**：`koala validate` 通过只代表验证命令通过，不代表可以跨过当前 phase。DEV 通过后提示 commit + REVIEW，REVIEW 通过后提示 TEST，TEST 通过后仍要渲染 DONE pre-check 的失败 row 和补救 hint。
- **流程事实必须双层保护**：prompt 只负责指导 agent 调用正确命令；CLI / handler / gate 必须硬编码兜底，负责 schema、runtime 归一、签名、hash、evidence fresh check 和拒绝策略。该原则只覆盖流程事实：phase / state transition、pass / no-issue confirmation、review run / finding category / role / severity、verification evidence、init / scope / delivery check、REVIEW / TEST / DONE gate artifact。普通解释性 prose 不应被当作流程证据。
- **流程事实需要 typed registry**：`packages/main/src/core/process-fact-registry.ts` 从 `COMMAND_POLICIES` 与 `PROCESS_FACT_LEVELS` 机械组装 command fact，并显式覆盖 reviewer lane、artifact、required semantic facts（如 validation-status、verification-evidence、review-pass、finding-state）。维护者新增 gate、reviewer lane 或 artifact 时，必须先让 registry 和 contract verifier 同步更新。
- **生命周期事实需要 typed registry**：`packages/main/src/core/lifecycle-registry.ts` 是 phase/order、legacy alias、transition event、rollback edge、gate/effect/oracle row id 的只读登记表。`phase-flow.ts`、`handlers/context.ts` 和 focused smoke 必须从这张表投影或校验；维护者改 phase/event/command policy 时，测试失败应直接点名 `Lifecycle registry mismatch`，不能让多张表静默漂移。
- **运行环境事实单独登记**：CLI entrypoint、global core realpath、project-local bin、Node/package version、validate source、external-reference-policy 等 runtime/environment facts 不进入流程事实 registry。它们登记在 `packages/main/src/core/runtime-fact-registry.ts`，由 `doctor` 的 `Runtime scan:` 展示，并由 `scripts/verify-runtime-fact-contract.mjs` 验证 registry / checker / doctor 输出一致。外部项目对 Orchestrate-local realpath/symlink 期望只 warn/advisory；`external-reference-policy` 是 bounded policy scan，不做 connectivity pass。
- **运行时文件事实单独登记**：`.koala/activity.jsonl`、legacy `docs/story/activity.jsonl`、`.koala/runtime/`、`.koala/traces/`、`.koala-serve.json`、debug/browser logs 等 runtime artifacts 登记在 `packages/main/src/core/runtime-artifact-registry.ts`。freshness、baseline risk、`story_sync_main`、`koala init` 和 `doctor` 必须消费这张表，避免 activity log 之类运行时文件被误当成 material change；`.koala/story/` 仍是流程证据，不属于 runtime artifact。
- **Pass 结论不是 finding**：reviewer 没有 finding 时必须写 `review_pass_set`。为了兼容旧 prompt 或误用，pass-only `finding_add`（如 no findings、检查通过、PASS/PASSED）在 handler 里转成 review pass；含“但是/failed/issue found”等歧义失败语义时仍保留为 finding。
- **REVIEW evidence 先绑 reviewer run**：`review_run_start` 写 signed `review-runs.json`，记录 `reviewRunId / lane / reviewRound / headHash / materialHash / promptHash`。当前 REVIEW round 的 `finding_add` / `review_pass_set` 必须携带 `reviewRunId`，gate 只接受 lane 匹配、reviewRound 匹配、签名有效、且仍 fresh 的最新 reviewer run。
- **Finding category 不扩散**：当前 canonical category 是 `happy|edge|adversarial|missing`。已知 legacy category（`cleanup|doc-promise-undelivered|doc-code-drift|spec-boundary`）只作为兼容输入归一到 `missing`，不得作为 active reviewer prompt 示例或新流程语义继续传播。
- **用户价值验收优先**：DONE 前必须能说清楚“用户看到什么变化、怎么使用、证据在哪里”。工程链路通过不等于任务真正完成。
- **用户价值验收结构化**：`summary_set` 必须记录 `expectedOutcome`、`actualTranscript`、`outcomeDiff`、`acceptanceVerdict`，并可记录 `outcomeKind=success|blocked|audit_only`。DONE gate 消费这些字段，缺失时不能进入 DONE；缺 `outcomeKind` 的 legacy summary 按 success/default 展示。
- **统一推进命令**：`story_advance` 统一处理所有阶段推进。

## Phase-Aware 工具过滤

在 CLI 层按当前 story phase 过滤可用命令。无 active story（主分支）时全量可用。

### 全阶段可用

| 工具 | 行为 |
|---|---|
| `story_get` / `story_list` | 只读查看 |
| `story_discard` | 任何阶段可废弃 |
| `task_scan` / `task_detail` | 了解项目，只读 |
| `checklist_get` | 只读查看 |
| `grill_get` | 只读查看 PLAN 阶段写入的 grill planning context；不产生 gate evidence |
| `truth_*` / `gap_*` / `arch_trace` | 分析参考，只读 |
| `session_brief` / `status` / `next` | 恢复现场和下一步建议，不推进 phase |

### PLAN

| 工具 | 行为 |
|---|---|
| `story_update` | 编辑 story |
| `story_review` | 对抗审查 |
| `grill_start` / `grill_record` / `grill_close` | PLAN-only mutating grill commands；记录非门禁 grill planning context；开放 session / unresolved question 只会在 `story_review` 中 advisory 提示 |
| `story_advance -> DEV` | 通过 gate 后进入实现 |
| `checklist_add` | 追加 item |
| `checklist_update` | 补 verificationIntent / metadata，不应标 done |
| `testintent_handoff` | legacy 名称，实际用于生成 verificationIntent 交接上下文 |

### DEV

| 工具 | 行为 |
|---|---|
| `checklist_add` | 必要时追加 item，并补 verificationIntent；PLAN 阶段必须提供 replan/scope audit reason |
| `checklist_update` | 可改 status + verificationIntent + verificationEvidence |
| `fixture_batch_add` / `fixture_update` | legacy/compat 维护入口，只用于旧 fixture 或迁移；新流程用 `checklist_update` 补 `verificationEvidence` |
| `koala validate` | 可手动预检，正式 evidence 在 TEST gate 写入 |
| `story_advance -> REVIEW` | checklist 完成且改动提交后推进 |

### REVIEW

| 工具 | 行为 |
|---|---|
| `finding_*` | reviewer 记录 findings |
| `reviewer_list` | 查看需要哪些 reviewer |
| `story_advance -> TEST` | blocker 解决、preflight 通过后推进 |
| `story_advance -> DEV` | 有问题时回实现 |

`koala-review-test-coverage` 是 REVIEW 阶段的 reviewer agent/lane 名称，不是 `koala` CLI 命令或 phase tool。它检查 `verificationIntent` / `verificationEvidence` 覆盖；先 `review_run_start` 拿当前 round 的 `reviewRunId`，无 blocker 时通过 `review_pass_set` + `reviewRunId` 写 review pass，内部 coverage validation 消费这些结构化 evidence。

### TEST

| 工具 | 行为 |
|---|---|
| `koala validate` | 标准验证，写 validation evidence |
| `verification_evidence_refresh_stale` | 根据 coverage 报告刷新 stale evidence 的 HEAD/material hash |
| `bug_report` / `bug_update` / `bug_list` | 管理验证失败产生的 bug |
| `summary_set` | 写 DONE 前用户价值、actual transcript、diff、outcomeKind 和使用说明 |
| `delivery_check_set` | 记录 delivery reviewer 签名 |
| `story_advance -> DONE` | DONE checklist 全通过后合并清理 |

### 关键行为差异

- `koala validate`：TEST gate 消费其结果作为 validation evidence。
- `verification_evidence_refresh_stale`：只刷新已经 stale 且原 evidence 仍存在的 intentRef；它不会替你证明测试真的跑过，因此 dry-run 输出里的 command 应先重跑。
- `fixture_*`：legacy/compat 维护入口；DEV 如需迁移旧 fixture 可用，但新 story 不应把它当作标准验证流。REVIEW/TEST 主要读取 `verificationEvidence`，不应绕过 review 改行为。
- `checklist_update`：PLAN 补 intent，DEV 补 status/evidence，其余阶段谨慎使用。
- `summary_set`：不是形式总结，DONE gate 和最终用户交付都要消费。
- `grill_start` / `grill_record` / `grill_close`：PLAN-only mutating planning context。`story_review` 可展示 open session / unresolved question advisory，但 `blockerCount` 不因 grill 增加；`grill.json` 不进入 validation evidence，也不进入 checklist `verificationEvidence`。
- `grill_get`：全阶段只读查看 grill planning context；读不存在的 artifact 返回 empty，读到损坏或不可读的既有 `grill.json` 必须 fail-fast 暴露问题，不能被当作缺失后覆盖。
- `process-fact-registry` + `verify-process-fact-contract`：静态 contract 负责校验 MAIN_TOOLS、DEFAULT_PHASE_TOOLS、reviewer lanes、signed/gate artifacts、L4 gate evidence 与 required semantic facts 是否一致；fail 文案必须直接点名 `missing from PROCESS_FACT_REGISTRY` 或 `required process fact missing`，避免维护者只看到 prompt 漂移。
- Flow fact policy 必须硬编码在 `packages/main/src/core/flow-fact-policy.ts` 并登记进 `process-fact-registry` / `process-fact-levels`。当前明确登记：`flow-policy:review-pass`、`flow-policy:finding`、`flow-policy:pass-only-normalization`、`flow-policy:review-round-iso-string`、`flow-policy:express-verification-policy`。
- `reviewRound: string (ISO 8601 review round id)`。review pass / finding / delivery check 的签名域消费这个字符串，不能退回 number round。
- `story_review.planReviewRound: number (PLAN review round count)`。这是 PLAN 阶段 story review 轮次数字，来自 `review.json.reviews.length`；`story_review.reviewRound` 仅是 legacy numeric PLAN review alias，不能解释成 signed artifact `reviewRound`。
- pass-only finding_add 归一化：low severity 且 agent 为 `koala-review-*` 的 pass-only `finding_add` 机械转成 `review_pass_set`；ambiguous pass+failure、非 reviewer、非 low severity 都是真 finding。
- review run freshness：同一 reviewer lane 在当前 REVIEW round 可多次 `review_run_start`；只有该 lane 最新 signed run 仍是 current。代码/文档 material 改动后旧 run 会 stale，必须重跑 `review_run_start` 再提交 finding/pass。
- Express exemption 是机器策略不是口头解释：express channel 且 zero `verificationIntent` 时输出 `Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped)`；fast / normal zero intent 不显示 `express-exempt`。

## 三方制衡

- **主 agent**：写需求、拆 checklist、写代码、补 evidence、修 bug。
- **test-intent / verification-intent agent**：写验收标准，逼出 edge/adversarial。
- **reviewer**：审实现和覆盖；`koala-review-test-coverage` 是其中一个 reviewer lane。先 `review_run_start` 建当前 REVIEW round 的 reviewer run；无 blocker 时写 `review_pass_set` + `reviewRunId`，有 blocker 时独立记录 `finding_add` + `reviewRunId` / delivery check。
- **用户**：最终产品价值裁决者。

主 agent 不是裁判。reviewer fail 了，正确反应是读懂反馈并修复，而不是解释到 pass。
