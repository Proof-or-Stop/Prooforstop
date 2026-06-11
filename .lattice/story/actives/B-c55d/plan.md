# Plan: B-c55d Implement the story owner lease (local session ownership)

## 总览

session-ownership-and-write-leases.md 的 **story owner lease** 部分（main write lock 部分
已由 B-f60c 完成；二者实现顺序为 lock-first，与文档 rollout 编号无关）。实现本地 Koala
session 所有权协调，让多 session 并行时「一个 story 一个 mutating owner」由 Koala 机械保证。

**决策（decision.json，chosen = opt-ownershipclass-central-gate）**：
- 命令分类落进 `CommandPolicy.ownershipClass`（单一权威来源），gate 在单一 choke-point 按
  ownershipClass 判；**不**在各 handler 散落硬编码、**不**手写会漂移的命令表。
- owner-lease.json（`.koala/story/actives/<storyId>/owner-lease.json`）+ sessionId +
  heartbeat + stale/takeover。
- 与 B-f60c main write lock **正交**：owner lease 管 intra-story authoring 权，main write
  lock 管 cross-session 共享写串行化——不合并、不重构。

**核心原则（decision principle）**：owner lease 保护的是「story authoring / lifecycle
mutation ownership」，**不取消 reviewer/verifier 的独立写入权**——reviewer writes 走自己
的 phase / reviewer-run / `_hash` / signature / lane gate，不归 main-agent owner lease。

### ownershipClass 5 类（写进 CommandPolicy，contract test 强制全覆盖）

| class | 是否 owner-lease-gated | 说明 |
|---|---|---|
| `readOnly` | 否，永不拦 | 不 mutate story/main/B-META；`story_get` / `checklist_get` / `finding_list` / `session_brief` / `*_get` / `convergence_check` / `dispatch` … |
| `storyScopedMutating` | **是** | 写单 story 的 metadata/checklist/evidence/lifecycle；`checklist_*` / `understanding_set` / `decision_set` / `story_advance` / `grill_*` / `verification_evidence_*` / `summary_set` / `background_set` / `plan_set` / `bug_*` … |
| `reviewerWrite` | 否（窄豁免） | reviewer lane 写评审证据；豁免 owner lease 但**仍受** phase/reviewer-run/`_hash`/signature/lane 约束并记录 sessionId/actor |
| `mainSharedMutating` | 否（走 main write lock） | 写 main / B-META / audit 共享态；已由 B-f60c main write lock 串行化 |
| `dangerousMutating` | 是 + 显式意图 | force takeover / discard 他人 story / 合并到 main 的 recovery / 删 worktree·branch |

**用户裁定的边界规则（gate 必须按此实现）**：
1. `finding_resolve` / `finding_dismiss` = `storyScopedMutating`（owner-gated）——它们改
   blocker 状态、影响 REVIEW gate，应由 story owner 负责。**例外**：B-META finding 的
   resolve/dismiss = `mainSharedMutating`，走 B-f60c main write lock，不走 story owner lease。
2. `validate --story=B-xxx` = `storyScopedMutating`（owner-gated）——它经
   `persistStoryValidationEvidence` 写 TEST/DONE gate 消费的 story evidence、并同步 cluster
   resolve。**例外**：不带 `--story` 的纯诊断型 validate 不要求 story owner lease。
3. `reviewerWrite` 豁免集：`review_run_start` / `review_pass_set` / reviewer-lane
   `finding_add` / `init_check_set` / `draft_check_set` / `draft_issue_resolve` /
   `scope_check_save` / `scope_question_resolve` / `delivery_check_set`。豁免 ≠ 自由写：
   仍须证明是当前 lane 的合法 reviewer（phase/reviewer-run/`_hash`/signature）并记录 sessionId。
4. `delivery_check_set` 仅在 actor/lane = delivery reviewer 语义下算 `reviewerWrite`；
   否则按 `storyScopedMutating` 处理或拒绝——不得让 main agent 借它绕过 owner lease。
5. **未分类**（缺 ownershipClass）的命令 gate **fail-closed**，不默认放行；contract test
   枚举真实 command registry 断言每个 command 都有 ownershipClass。

**硬约束**：本地 session 协调、非强身份安全（sessionId 不是 crypto identity，无 key/server
authority/attestation）；非并发路径外部 CLI 行为 byte-identical；不重构 B-f60c main write lock。

## CHK-001: Implement sessionId and the owner-lease.json core

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/story-owner-lease.ts
- Modify: packages/main/src/registry.ts
- Test: packages/main/src/tasks/story-owner-lease-smoke.ts

**实现要点**:
- 稳定 sessionId（本地流程协调 ID，进程内一致；非 crypto identity）。
- `owner-lease.json` schema：sessionId/hostname/pid/cwd/command/acquiredAt/heartbeatAt/可选 label。
- 第一条 story-scoped mutating 命令 acquire lease；owner 命令刷新 heartbeatAt；DONE/DISCARDED+cleanup 成功时释放。
- lease 是进程元数据：session_brief 可见，不计入 verification evidence。
- owner-lease.json 不得在 DONE 前留未提交脏写（防 F-008 同类）。

**Verify**: `koala validate --story=B-c55d` 全绿；story-owner-lease-smoke 覆盖 acquire/heartbeat/release。

**DoneWhen**: owner-lease.json 按 schema 落盘；首命令 acquire、owner 命令刷新 heartbeat、终态释放；无 DONE 前脏写。

**实现说明（DEV 中追加，用户裁定 2026-05-19）**:
- **choke-point 文件修正**：plan.md 原写 `Modify registry.ts`，实际单一 choke-point 是 `cli-engine.ts` 的 `run()` wrapper（registry.ts 仅是 handler 注册表）。owner-lease acquire/refresh 注入 cli-engine.ts run()，不散落进各 handler。
- **sessionId anchor（3 源优先级链，用户裁定 2026-05-19，实测修正）**：
  `sessionId = KOALA_SESSION_ID ?? CLAUDE_CODE_SESSION_ID ?? deriveLocalSessionId(hostname, projectRoot/worktreeRoot, process.ppid)`。
  - **实测反证 ppid 不稳定**：Claude Code 环境每次 Bash tool 调用都是新 shell（新 ppid）。验证连续 4 次调用 ppid 89439→89466→89513→89529 全不同。故 `process.ppid` 只能做**最后 fallback**，不能做主 anchor——否则 agent 第 2 条 storyScopedMutating 命令会被自己上一条的 lease 当 foreign 拒绝，gate 上 main 后 brick agent 工作流。
  - 不能用 `process.pid`：koala CLI 每次调用是新进程，pid 锚定让每条命令 sessionId 都变。
  - **优先级 1** `KOALA_SESSION_ID`（sessionSource=`koala-env`）：Koala 自己未来 adapter/server 注入的 canonical override，最高优先级。
  - **优先级 2** `CLAUDE_CODE_SESSION_ID`（sessionSource=`claude-code-env`）：已存在、实测稳定的 per-Claude-Code-session UUID，无需新 plumbing。Claude Code env 是已知 adapter env，**不是 Koala 强身份认证**。
  - **fallback** `deriveLocalSessionId(hostname, root, ppid)`（sessionSource=`derived-ppid`）：服务普通 terminal / CI / 非 Claude 环境（shell 持久、ppid 稳定）。
  - lease 记录 `sessionSource`（`koala-env` / `claude-code-env` / `derived-ppid`）供 session_brief 与 debug。
  - 这不是强身份、不防伪，只是本地 session 协调（硬边界 1）。fallback 下 ppid 复用 / shell 死亡的退化由 stale-lease 判定 + takeover（CHK-003）兜底。

## CHK-002: ownershipClass classification + non-owner rejection gate

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/command-policy.ts, packages/main/src/cli-engine.ts, packages/main/src/handlers/finding.ts, packages/main/src/handlers/delivery-check.ts, packages/main/src/handlers/validate.ts, packages/main/src/core/main-write-lock.ts
- Create: packages/main/src/tasks/command-ownership-contract.ts
- Test: packages/main/src/tasks/command-ownership-contract.ts

**实现要点**:
- `CommandPolicy` 加 `ownershipClass` 字段（5 类 enum）；为**全部**已注册命令补 ownershipClass。
- 非 owner story-scoped/dangerous mutating 命令在单一 choke-point fail-closed 拒绝；read-only 永不拦。
- 按「总览」边界规则实现：finding_resolve/dismiss owner-gated + B-META 例外走 main write lock；validate --story owner-gated + 诊断 validate 豁免；reviewerWrite 窄豁免（验 lane/run/hash/signature）；delivery_check_set 仅 delivery reviewer 语义算 reviewerWrite。
- contract test：枚举真实 command registry，断言每命令都有 ownershipClass，缺一即 fail；未分类命令 gate fail-closed。
- 遵守 CLAUDE.md「Handler 编码约定」。

**实现边界（DEV 前 PLAN clarification）**:
- **owner gate single choke-point**：owner-lease 判定只在 **CLI dispatch / command-policy ownership gate** 一处统一做（按 `CommandPolicy.ownershipClass` 判），**不散落进各 handler**。handler 不得各自硬编码 owner 检查；gate 是唯一判定点。
- **delivery_check_set 的 reviewerWrite 判定机制**：`delivery_check_set` **只有**在 `agentId` / `KOALA_AGENT` 解析为 `koala-review-delivery`、**且**满足现有 delivery evidence 的签名 / phase 规则时，才算 `reviewerWrite`（豁免 owner lease）；否则按 `storyScopedMutating` 处理（需 owner lease）或拒绝。不得让 main agent 借 `delivery_check_set` 绕过 owner lease。

**Verify**: `koala validate --story=B-c55d` 全绿；command-ownership contract 全命令覆盖通过；非 owner story-scoped mutating 被拒、read-only 放行的 smoke 通过。

**DoneWhen**: 全命令有 ownershipClass + contract test 强制；gate 按 ownershipClass 与边界规则判；reviewer-write 豁免窄且仍受 lane/run/hash 约束；未分类 fail-closed。

## CHK-003: Stale lease detection and takeover

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/story-owner-lease.ts, packages/main/src/cli-engine.ts
- Test: packages/main/src/tasks/story-owner-lease-smoke.ts

**实现要点**:
- heartbeatAt 超 30 分钟无刷新 → stale。
- `--takeover`：转移 stale lease 给当前 session，记录 takeover event。
- `--forceTakeover`：转移非 stale（活跃）lease，视为人工批准。
- 无 takeover flag 不转移；takeover 走 dangerousMutating 纪律。

**Verify**: `koala validate --story=B-c55d` 全绿；smoke 覆盖 stale 判定 / --takeover / --forceTakeover / 无 flag 不转移。

**DoneWhen**: 30min stale 判定成立；stale 仅 --takeover 可转移（含 event）；活跃 lease 需 --forceTakeover。

## CHK-004: Ownership-aware error UX and session_brief rendering

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/handlers/session-brief.ts, docs/requirements/decisions/session-ownership-and-write-leases.md, docs/requirements/decisions/story-lifecycle.md
- Test: packages/main/src/tasks/story-owner-lease-smoke.ts

**实现要点**:
- 非 owner mutation 错误消息（doc Error UX）：哪个 story 被 own、owner sessionId/cwd/last-heartbeat、是否 stale、允许的下一步。
- session_brief ownership 渲染：owner session/cwd/heartbeat age/stale|active/当前是否 owner/推荐动作。
- B-META 在 session_brief 单独显示 shared audit state，不建议 story_advance。
- reviewer read-only flow 不被 owner lease 阻断。
- 同步 session-ownership-and-write-leases.md（Status：story owner lease 已实现）与 story-lifecycle.md。

**Verify**: `koala validate --story=B-c55d` 全绿；smoke 覆盖错误消息字段 + session_brief 渲染 + reviewer read-only 放行。

**DoneWhen**: 错误消息与 session_brief 渲染字段齐全；B-META 单独显示；reviewer read-only 不被拦；两份文档同步。

## CHK-005: doctor stale-lease check and multi-session regression smoke

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Modify: packages/main/src/handlers/doctor.ts
- Create: packages/main/src/tasks/story-owner-lease-smoke.ts
- Test: packages/main/src/tasks/story-owner-lease-smoke.ts

**实现要点**:
- doctor 检出并报告 stale story owner lease。
- 多 session 回归 smoke（doc Acceptance Criteria）：两 session 同 story → 第二个被拒；不同 story → 都通过；stale takeover 允许（带 event）；active takeover 拒绝（除非 forceTakeover）；session_brief 引导非 owner wait/read-only；reviewer read-only + reviewer-write（合法 run 下）仍工作。
- F-008 同类回归断言：owner-lease.json 在 DONE 前后无未提交脏写。

**Verify**: `koala validate --story=B-c55d` 全绿（含新增 smoke 与 contract）；doctor 报 stale owner lease。

**DoneWhen**: doctor stale-lease 检查成立；多 session smoke 全过；F-008 同类回归断言通过；validate 全绿。
