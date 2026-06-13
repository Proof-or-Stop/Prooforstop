# 项目文档导航

---

## 项目简要说明

本项目采用软件工程来管理 AI 自动化生成、优化、维护一个完整的编程项目。以 Claude Code CLI、Codex CLI、LLM API 为核心来做大模型开发编排，在不同的场景合理接入不同的大模型，满足开发需要、成本、效率、生产质量这四个维度，在这四个维度做最佳决策。从参与人员提出需求到文档落地，再到任务拆分，最后交付形成开发闭环。最终实现一个可长时间维护，自动调节和自动升级的系统。

---

## 重要说明

`关键名称：`

* 消耗资源可度量，维度可包含 CPU时间、Token（如果没有可使用 FunctionCall 调用次数来衡量，最少为 1）
* 必须要生产和维护数据（包括代码、文档、日志等），如果没有不能独立存在。
* 总产出衡量：多少文档，多少代码，提了多少 bug。实际产出量：代码出了多少 bug，多少 bug 实际有效。
* bug 提炼：每个 bug 都需要详细记录，由哪个角色提出，时间，相关的代码，git 版本，原因，处理过程（解决方案），处理结果，关键词（重现后可快速定位）。
* Sub Agent 考核，需要详细记录每个 Agent 消耗了多少资源，产生了多少内容，多少有效内容。
* 整个开发过程 以及 Stroy 生命周期由程序管理，底层 Agent 或 llm 思考来做决策。整个开发过程的推进就像呼吸一样是不能停和出错的（相对来说也很固定），所以不能由 Agent 做主。
* 每个 Sub Agent 可调，无论是上下文，还是职责范围，工作强度，是否参与都需要动态可调，每一个 Stroy 的开发节奏都需要根据系统的运行和监控情况进行动态调整，不能太死板。

---

## 目录

---

## Lattice CLI Rollout

`lattice` 是当前主命令入口。项目本地开发、
巡检和恢复现场时优先使用：

```bash
lattice check
lattice doctor --format=json
lattice session_brief
lattice host status --host=claude-code --format=json
lattice rollout_check --projects /path/to/project --json
```

开发 Lattice CLI 自身后，本地/全局刷新流程是：

```bash
npm --prefix packages/main run build
npm install -g ./packages/main
lattice --version
lattice check
lattice doctor --format=json
lattice rollout_check --projects "$(pwd)" --json
```

`rollout_check` 是只读跨项目巡检：它读取 git 状态、managed asset 状态、
runtime footprint、story/transcript scope readiness，并输出每个项目的
`status` 与 `nextAction`。它不会执行 `check --apply`、`check --upgrade`、
repair/fix、第三方安装、evidence submit 或 receipt verify。主仓可以是
PASS；外部项目、旧 wrapper 或非 git 项目会被解释成 WARN/FAIL 加下一步，
而不是让用户逐个手跑 doctor/check 后猜原因。

### Authority 模式：off / shadow / enforce

`KOALA_AUTHORITY_MODE` 控制 CLI 是否与 Python authority 交互。**三种模式
都不会阻塞本地 Story 工作流**：本地 lifecycle gates（`story_advance`、
`verification_evidence_add`、DONE）不读 server receipt，所以
`authority_status` 永远报 `localWorkflowUsable: true`；enforce 缺前置只会
进 `readinessWarnings` / `nextActions`，不会变成全局 blocker。

| 模式 | 何时使用 | CLI 行为 | 是否构成生产 authority |
|------|----------|----------|------------------------|
| `off`（默认） | 普通本地 Koala/Lattice story 开发，**免费、纯本地**。 | 完全不发起网络请求；本地 evidence + DONE gate 行为不变。 | 否：`productionDone=false`、`receiptVerified=false`。 |
| `shadow` | 想观察 Python authority 的响应但保留本地行为。 | 尽力 observational POST；失败仅 stderr warning，不影响本地写入。 | 否：transport `accepted: true` 是 `thin-client-transport-accepted`，不是受签的 receipt。 |
| `enforce` | isolated headless runner / Authority job path，**需要** Python authority server + customer API key + 注册过的 actor key + runner identity + project id + pinned server key。 | `authority enforce runner --dry-run` 投影 readiness；`--live` 签名原生 envelope、注册/心跳 runner、claim job。Authority job execution consumes typed `plannedSteps[]`, uploads evidence, requests server `gate_decision`, verifies the native receipt, and then completes or releases the lease according to policy. | 只有验签通过的原生 `gate_decision` receipt 可支持 per-run `authorityDone`；`fullAuthorityDone` 还需要最终 multi-host certification。runner 心跳/claim 本身不构成生产 authority。 |

查看本地 CLI 看到的 authority 表面：

```bash
# 默认 off：不需要任何 env
lattice authority status --json

# shadow / enforce 缺前置时会看到 readinessWarnings + nextActions
KOALA_AUTHORITY_MODE=shadow lattice authority status --json
KOALA_AUTHORITY_MODE=enforce lattice authority status --json

# Conduit 视图镜像同一份 readiness 字段
lattice conduit status --json
lattice conduit explain --json
```

`authority status --json` 字段速查：

- `mode` — `off` | `shadow` | `enforce`
- `localWorkflowUsable: true` — 本地 story workflow 永远不被 authority 阻塞
- `authorityUrlConfigured` — `LATTICE_AUTHORITY_URL` / `KOALA_AUTHORITY_URL` 是否已配置
- `customerApiKeyConfigured` — `LATTICE_AUTHORITY_CUSTOMER_API_KEY` / `_PATH` 是否已配置
- `customerApiKeySource` — `env` | `path` | `authority_md` | `missing`
- `customerApiKeyValid` — live probe 前只能是 unknown，不能只因存在就推断有效
- `actorKeyConfigured` — `LATTICE_AUTHORITY_ACTOR_KEY` / `_PATH` 是否已配置
- `actorKeyRegistered` — actor public key 是否已在 Authority server 注册
- `serverPublicKeyPinned` — receipt server public key 是否已固定/验证
- `runnerConfigured` — `LATTICE_AUTHORITY_RUNNER_ID` 是否已配置
- `readinessWarnings: string[]` — 只在 shadow/enforce 缺前置时填充
- `nextActions: string[]` — 对应的 env / 命令建议
- `productionDone: false`、`receiptVerified: false`、`canClaimProductionDone: false`

**重要边界**：本地 JSON 或文本输出**不是** authority evidence。只有 Python
authority 颁发并由 runner / 客户端验签的 `AuthorityReceipt` 才算受签的生产
authority。即使 `KOALA_AUTHORITY_URL`、`KOALA_AUTHORITY_ACTOR_KEY`、
`KOALA_AUTHORITY_RUNNER_ID` 都配齐，`productionDone` 仍保持 `false`，直到一份
签名的原生 Lattice Authority `gate_decision` receipt 被验签为止。完整的
`fullAuthorityDone` 还需要最终 multi-host certification。
PD-1 / PD-2 的
trust boundary 见
[`requirements/decisions/authority-client-role.md`](requirements/decisions/authority-client-role.md)。

### Autopilot modes: local / shadow / authority

`lattice autopilot` is the unattended-development control surface. It keeps the
local workflow available by default and only uses Python authority in the
explicit authority mode.

```bash
lattice autopilot status --json
lattice autopilot doctor --json
lattice autopilot run --mode=local --storyId=B-xxxx --until=TEST --json
lattice autopilot execute --mode=local --storyId=B-xxxx --until=TEST --maxSteps=20 --json
lattice autopilot run --mode=authority --storyId=B-xxxx --until=DONE \
  --receiptFile=receipt.json --serverPublicKey="$SERVER_PUBLIC_KEY_HEX" \
  --receiptKind=gate_decision --receiptProjectId="$PROJECT_ID" \
  --receiptStoryId=B-xxxx --serverKeyId="$SERVER_KEY_ID" \
  --expectedDecisionDigest="$DECISION_DIGEST" --json
```

- `local` is the default and never requires Python authority.
- `shadow` reports authority readiness warnings without blocking local work.
- `authority` fail-closes on missing Python authority readiness; `DONE` also
  requires a signed native `gate_decision` receipt, server public key, and
  explicit project/story/server-key/decision binding before reporting
  `status: pass`. Legacy `subjectId` / `subjectKind` receipts do not satisfy
  native authority DONE.
- `autopilot_run` is dry-run by default. Only `--dryRun=false` records an
  `autopilot_projection` process event, and that projection is not gate
  evidence or production authority.
- `autopilot_execute` is the true bounded executor loop. Non-dry-run execution
  requires `--storyId`, runs only argv-mapped Lattice commands, records a
  non-authoritative `autopilot_execution` event, and only invokes Claude Code
  CLI repair when `--allowClaudeRepair=true` is explicit.

### Planner：自然语言 → Story + 计划

`lattice planner ...` 是 Lattice 原生的 planner 入口：把一句自然语言需求转成
Lattice Story 草稿、checklist、verification intent 和带类型的 `plannedSteps[]`，
供 autopilot 执行器消费。它不会把 Story / job / receipt authority 交给外部框架。

```bash
lattice planner draft --request="Add a hello command that prints hi" --json
lattice planner review --draftFile=draft.json --json
lattice planner status --runId=<plannerRun> --json
lattice planner source-manifest --sourceRepo=<path> --json
lattice planner run --request="<一句话>" --mode=local --until=DONE --json
lattice planner run --request="<一句话>" --mode=authority --until=DONE --json
```

边界：

- `planner draft` / `review` / `status` / `source-manifest` 只读；
  `planner create-story` / `create-job` 只通过 Lattice 命令写状态。
- 交互模式 `--interactionMode=autonomous|interview|decision-gated`（默认
  `autonomous`）；暂停的 run 用 `planner answer` / `planner decision submit` /
  `planner resume` 续跑。
- `planner run` 串起 draft → review → Story → job/local plan → 执行器，但 DONE
  仍受与 autopilot 相同的 gate 约束：`local` 最多到本地认证完成，authority DONE
  仍需验签的原生 `gate_decision` receipt。planner 仍在按 fixtures 收敛，请把它
  当作规划入口，而不是无人值守 DONE 的保证。

### 多主机 verdict 与运行状态

发布认证可能要求独立主机 verdict。存在两条 verdict 路径，且刻意不可互换：

```bash
# Authority（服务器背书）路径
lattice authority verdict submit --jobId=<job> --runId=<run> --verdictFile=<verdict.json> --json
lattice authority verdict list   --jobId=<job> --json
lattice authority job status      --jobId=<job> --json

# 本地（non-authority）路径
lattice autopilot review submit --storyId=<story> --runId=<run> --verdictFile=<verdict.json> --json
lattice autopilot review status --storyId=<story> --runId=<run> --json

# 只读地解析 planned step 的 worktree / phase
lattice story resolve --storyId=<story> --json
```

边界：

- `authority verdict submit` 是 Authority 路径；`autopilot review submit` 是本地
  路径。本地路径只把 verifier verdict 记进按 `storyId` / `runId` 索引的本地 run
  state，永远不创建 Authority receipt，也不置 Authority DONE 标志。
- `authority verdict list` / `authority job status` / `story resolve` 均只读。
  `authority job status` 汇总 host-verdict 状态，不铸造也不替换原生 receipt；在
  真正满足 Authority 条件前，`multiHostVerified` / `fullAuthorityDone` 保持
  `false`。

### Source-Aligned Redevelopment Workflow

`planner run --workflow=source-aligned-redevelopment` 组合源码对齐重开发计划：
把一份已授权的源码工程，在目标工程与目标语言中复刻其模块、函数、行为与细节，
并按项目名做标识符重命名。

```bash
lattice planner run --workflow=source-aligned-redevelopment \
  --sourceRepo=<path-or-ref> --targetProject=<path> --targetProjectName=<name> \
  --sourceLanguage=typescript --targetLanguage=rust \
  --mode=local --until=DONE --json
```

边界：

- 它是一种开发 workflow，不是新的交互模式；运行在 `autonomous` / `interview` /
  `decision-gated` 之一，以及 `local` 或 `authority` 之一下。
- 源码是只读输入；目标文件只通过 story worktree 和正常 lifecycle gate 写入。
  workflow 与语言对无关（如 `typescript -> rust`、`swift -> kotlin`）。
- 它保留 license/署名声明，并把 secrets、`.git`、缓存和构建产物排除在
  prompt/输出/证据之外。它产出证据背书的对齐，而非完美语义等价的承诺；范围内
  无法验证的细节记为显式 gap。这是按 fixtures 收敛中的当期能力，尚不属于已发布
  baseline。

### CHK-002 enforce matrix smoke

`npm run test:authority-enforce-matrix` 通过一个纯 in-process 矩阵验证以下五个格：

- **local/off 保持 free/local** — `loadAuthoritySettings({})` 返回 `mode: off`；`classifyCliAuthoritySubmission('off', …)` 返回 `local-only`，不触网。
- **shadow 只是 warning** — 服务器失败时 `proceed=true` + stderr `[warning]`，不抛异常，不阻塞本地写入。
- **enforce fake receipt 只有经过 receipt verification 才能分类为 L2+** — 普通 CLI 提交永远是 `thin-client-transport-accepted`；只有把完整绑定的 envelope + 签名的 `AuthorityReceipt` 传入 `classifyReceiptBackedEvidence` 并验签通过，才能达到 `receipt-backed-l2-plus`。
- **enforce 缺 server 时 runner/submission 路径 fail-closed** — `createAuthoritySubmitter(enforce, 无 baseURL).submitSingle(…)` 返回 `proceed=false`，不触网。
- **parallel_report 始终 non-authoritative** — `buildParallelReport(wave)` 的 `authority.productionDone` 永远是 `false`，`authority.authorityChanged` 永远是 `false`，`authority.receiptRefs` 永远为空。

## Host Overflow

Lattice Host Overflow 是 **manual-first** 的 bounded overflow 流程：
Lattice 持有 story / scope / receipt / merge authority，Claude Code 只是执行 host，
不是 production authority。

建议顺序：

```bash
lattice host_status --host=claude-code --json
lattice handoff_create --storyId=B-xxxx --fromHost=codex --toHost=claude-code --json
lattice handoff_worktree_create --file=handoff-pack.json --json
lattice host_dispatch --host=claude-code --file=handoff-pack.json --mode=supervised --json
lattice handoff_receipt_submit --file=receipt.json --json
```

关键边界：

- `host_status` 只报告 overflow readiness，不授予 authority。
- `handoff_create` 生成 bounded pack，包含 `packId`、`packHash`、`baseSha`、
  `allowedPaths`、`deniedPaths`、required commands 和 execution instructions。
- `handoff_worktree_create` 只投影 worktree/branch/cleanup guidance，不自动创建、
  合并、清理或信任结果。
- `host_dispatch` 只返回 `planned|unavailable` 和 `nextAction`，不 auto-trust、
  不 submit evidence、不 verify receipt、也不声明 `productionDone`。
- `handoff_receipt_submit` 只接收本地 diagnostic receipt；即使
  `accepted-local`，仍然保持 `receiptVerified=false`、`productionDone=false`。

后续 `dispatch_plan` / `dispatch_prepare` / `dispatch_run` 也必须遵守同一条边界：

- 只能做 supervised、visible automation。操作员必须能看见目标 host、计划、
  receipt、status 和 review/merge guidance。
- 如果目标 host 缺少对应 CLI/runtime，结果必须 degrade 成 `unavailable` 或
  diagnostic `nextAction`，不能偷偷换成别的 host 或静默跳过。
- 即使是 fake/local receipt，也不能 auto-merge、不能 verify authority
  receipt、不能把 `productionDone` 改成 `true`。

详细架构说明见
[`requirements/decisions/host-overflow.md`](requirements/decisions/host-overflow.md)。

### Unattended dispatch — `dispatch_auto` (policy-authorized)

`dispatch_auto` 是 **policy-authorized 的 unattended scheduler**，是
`overflow_auto` 的扩展路径。与 `overflow_auto` 的区别：

| | `overflow_auto` | `dispatch_auto` |
|---|---|---|
| 默认模式 | suggest-only（需要 `--approve --start` 才真正启动） | policy-gated（检查通过后自动启动 worker） |
| 是否需要 policy | 否 | 是（缺 policy 或未授权则 refuse） |
| Host safety check | 否 | 是（`unattendedSafe=false` 则 refuse） |
| 是否 unattended | 否 | 是 |

如果已经在用 `overflow_auto`，想要 unattended workers，先定义 dispatch policy，
再迁移到 `dispatch_auto`。`overflow_auto` 的 `nextAction` 字段会指向 `dispatch_auto`。

**完整 opt-in 顺序：**

```bash
# 1. 定义 dispatch policy（只需一次）
lattice dispatch_policy_create --policy=my-policy \
  --allowedHosts=fake --allowedPaths=packages/main/src/generated/ \
  --maxParallel=2 --maxRuntimeMinutes=30 --maxBudgetUSD=5.0 \
  --network=none --commandAllowlist='node -e "process.exit(0)"' \
  --requireReceipt=true --requireReview=true \
  --allowAutoMerge=false --allowProductionDone=false

# 2. 验证 policy 授权
lattice dispatch_policy_check --policy=my-policy --format=json

# 3. 探测 host capability（不启动外部进程；CLI 不在 PATH 时返回 unavailable）
lattice host_runtime_probe --host=claude-code --json

# 4. 启动 policy-authorized unattended workers
lattice dispatch_auto --storyId=B-xxxx --policy=my-policy --format=json

# 5. 查看 lifecycle / runner 状态
lattice dispatch_watch --dispatchId=D-xxxx --format=json

# 6. 取消（evidence 不会被删除）
lattice dispatch_cancel --dispatchId=D-xxxx --format=json

# 7. 人工 review：transcript / diff / receipt / runner evidence
lattice dispatch_review --dispatchId=D-xxxx --format=json

# 8. 人工 merge（dispatch 完成 ≠ production authority）
lattice dispatch_merge_plan --dispatchId=D-xxxx --format=json
```

**Unattended mode 仍然是 user-authorized、authority-safe：**

- `dispatch_auto` 在以下情况下 **refuse**（显式拒绝，不假装执行）：
  - 缺 `policy` 参数
  - policy 不存在或未授权（`authorized=false`）
  - host 不可用（`status=unavailable`）或 `unattendedSafe=false`
  - host 不在 policy `allowedHosts` 列表
  - 超过 policy `maxParallel` 限制
- Worker 输出只是 evidence candidate，不构成 gate authority。
- `dispatch_merge_plan` 永远是 `manualOnly=true`，不自动 merge、不自动 DONE。
- 所有 authority 字段固定为 `false`：`productionDone=false`、
  `receiptVerified=false`、`authorityChanged=false`。

## 代码与文档的结合

生成了代码但是需要同步生成这份代码的文档，为 JSON 格式。每次修改了代码都必须同步更新代码的文档说明，细到每一个 Class 和 函数，Class 的定下来就不会变，但函数的说明必须每次更新。做这个的目的是为了实时提取项目的整个状态，方便分析任务完成情况，需要和资料挂钩，以及动态及时更新。每段代码需求来自哪里，经过多少次更新，每次更新内容最好都做记录，被删除，废弃的代码也不要删除，都需要保留历史。很多主观内容，需要加上自动化脚本验证。

## 测试

包含白盒和黑盒测试，每条测试都需要有详细的跟踪，时间，内容，测试代码引用（{featureId}-{name}），是否验证，验证结果。

## 使用 mcp 来调用脚本，不要让 llm 直接调用某个脚本，需要写成 mcp 服务，否则服务会很难用
