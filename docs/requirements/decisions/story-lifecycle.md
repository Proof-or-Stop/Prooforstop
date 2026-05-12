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
| INIT_CHECK | worktree bootstrap | init reviewers / draft gate 通过，git 可用 | `.worktrees/B-xxx`、`story/B-xxx` |
| PLAN | 拆解和验收意图 | cwd 在 worktree；高风险 story 要 understanding + decision/preMortem | understanding、checklist、verificationIntent、decision |
| DEV | 实现和记录证据 | PLAN/review gate 允许 | 代码、checklist status、verificationEvidence |
| REVIEW | 独立审查 | DEV checklist 已完成、改动已提交 | reviewer findings、coverage reviewer result / review pass |
| TEST | 自动验证 | REVIEW blocker 已解决，preflight gate 通过 | `koala validate` evidence、bug/test runs |
| DONE | 收束 | validate PASS、bug fixed、evidence fresh、summary/delivery gate 通过、branch 包含 main | merge main、清理 worktree、summary |
| DISCARDED | 已废弃 | `story_discard` | discard event、清理结果 |

## 自动回退

- **REVIEW fail**：finding 或 coverage reviewer lane 发现问题时回 DEV。
- **TEST fail**：`koala validate` 失败后写 bug/evidence，修复路径回 DEV。
- **DONE gate fail**：保留在 TEST，按 DONE checklist 的失败项补 evidence、summary、delivery check、main sync 或 git clean。

回退后主 agent 应先读失败证据，再决定改代码、补 evidence、补文档还是调整 checklist。不要用解释替代修复。

## Worktree 隔离

每个 story 在独立 worktree 中开发，分支名 `story/{storyId}`。多并发 session 互不干扰。

- `story_advance -> INIT_CHECK`：自动创建 worktree + 切分支。
- `story_advance -> DONE`：自动 merge 回主分支 + 清理 worktree + 删分支。失败返回错误提示由 agent 处理。

通过 `git rev-parse --abbrev-ref HEAD` 检测当前分支，`story/` 开头则提取 storyId 识别 active story。

主目录 `session_brief` 必须同时看主目录 story metadata 和 linked worktree 内的真实 story metadata。如果两者 phase 不一致，输出应采用：

```text
B-xxxx REVIEW (authority:worktree, mirror:INIT_CHECK)
→ cd /path/to/.worktrees/B-xxxx
```

这表示继续工作时以 worktree phase 为准；main phase 只是滞后索引，不应该触发重复推进。

## 设计决策

- **Story 即 Feature**：Story 是最小可追踪单元。
- **状态机管理**：使用 xstate，而不是散落的手写 if。
- **门禁不可跳过**：REVIEW/TEST/DONE 都必须由确定性 gate 判定。
- **verificationIntent 前置**：PLAN 记录 happy/edge/adversarial 验收意图。
- **verificationEvidence 跟随实现**：DEV/REVIEW/TEST 挂真实证据，不再把测试阶段拆成旧 `TEST_CASE` 流程。
- **evidence kind 允许自然 aliases**：持久化 kind 仍是 `logic_test` / `manual_transcript` 等规范值；CLI 接受 `logic`→`logic_test`、`cli`→`manual_transcript`，避免 plan.md 和命令表面口径打架。
- **DONE evidence 必须新鲜**：`koala validate --story` 写入测试运行时的 git HEAD/material hash。DONE gate 比对当前 story 分支，验证语义相关文件变化会让旧 evidence stale。
- **stale evidence 不能被“测试通过”覆盖**：`koala validate` 如果发现 verification coverage missing/stale，JSON 必须是 `allPass:false`，提示也必须指向补 evidence，而不是说“验证全绿”。可用 `verification_evidence_refresh_stale --storyId=B-xxx --dryRun` 查看需刷新项；重跑对应验证命令后去掉 dryRun 刷新 metadata。
- **Gate oracle 与 renderer 分离**：DONE pre-check 等 gate 输出必须先形成稳定 row contract（`id/status/detail/hint/source/blocking`），`status` / `session_brief` / `next` 只渲染这些 row。展示层不能用 phase 或 label 文案复制一份 gate 规则。
- **下一步提示必须 phase-aware**：`koala validate` 通过只代表验证命令通过，不代表可以跨过当前 phase。DEV 通过后提示 commit + REVIEW，REVIEW 通过后提示 TEST，TEST 通过后仍要渲染 DONE pre-check 的失败 row 和补救 hint。
- **流程事实必须双层保护**：prompt 只负责指导 agent 调用正确命令；CLI / handler / gate 必须硬编码兜底，负责 schema、runtime 归一、签名、hash、evidence fresh check 和拒绝策略。该原则只覆盖流程事实：phase / state transition、pass / no-issue confirmation、finding category / role / severity、verification evidence、init / scope / delivery check、REVIEW / TEST / DONE gate artifact。普通解释性 prose 不应被当作流程证据。
- **流程事实需要 typed registry**：`packages/main/src/core/process-fact-registry.ts` 从 `COMMAND_POLICIES` 与 `PROCESS_FACT_LEVELS` 机械组装 command fact，并显式覆盖 reviewer lane、artifact、required semantic facts（如 validation-status、verification-evidence、review-pass、finding-state）。维护者新增 gate、reviewer lane 或 artifact 时，必须先让 registry 和 contract verifier 同步更新。
- **Pass 结论不是 finding**：reviewer 没有 finding 时必须写 `review_pass_set`。为了兼容旧 prompt 或误用，pass-only `finding_add`（如 no findings、检查通过、PASS/PASSED）在 handler 里转成 review pass；含“但是/failed/issue found”等歧义失败语义时仍保留为 finding。
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
| `truth_*` / `gap_*` / `arch_trace` | 分析参考，只读 |
| `session_brief` / `status` / `next` | 恢复现场和下一步建议，不推进 phase |

### PLAN

| 工具 | 行为 |
|---|---|
| `story_update` | 编辑 story |
| `story_review` | 对抗审查 |
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

`koala-review-test-coverage` 是 REVIEW 阶段的 reviewer agent/lane 名称，不是 `koala` CLI 命令或 phase tool。它检查 `verificationIntent` / `verificationEvidence` 覆盖；无 blocker 时通过 `review_pass_set` 写 review pass，内部 coverage validation 消费这些结构化 evidence。

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
- `process-fact-registry` + `verify-process-fact-contract`：静态 contract 负责校验 MAIN_TOOLS、DEFAULT_PHASE_TOOLS、reviewer lanes、signed/gate artifacts、L4 gate evidence 与 required semantic facts 是否一致；fail 文案必须直接点名 `missing from PROCESS_FACT_REGISTRY` 或 `required process fact missing`，避免维护者只看到 prompt 漂移。

## 三方制衡

- **主 agent**：写需求、拆 checklist、写代码、补 evidence、修 bug。
- **test-intent / verification-intent agent**：写验收标准，逼出 edge/adversarial。
- **reviewer**：审实现和覆盖；`koala-review-test-coverage` 是其中一个 reviewer lane。无 blocker 时写 `review_pass_set`，有 blocker 时独立记录 finding / delivery check。
- **用户**：最终产品价值裁决者。

主 agent 不是裁判。reviewer fail 了，正确反应是读懂反馈并修复，而不是解释到 pass。
