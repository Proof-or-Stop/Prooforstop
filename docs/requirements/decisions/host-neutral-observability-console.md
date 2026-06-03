# Lattice Host-Neutral Observability Console（CLI-backed read-only）

> 状态：**已采纳设计真相源（adopted source-of-truth reference）** · v0 · 2026-06-02 · 位于 `docs/requirements/decisions/`，索引于 `docs/requirements/NAV.md`
> 定位：这是 **Lattice CLI JSON surface 的只读消费层**——不是 Mac Native App，也不是新的 authority；它把参考图的「Claude Code Agent Monitor」从**单 host transcript 监控**重构为 **host-neutral 编排观测台**。
> 数据源：**只能**通过 `lattice ... --format=json`（L0 命令）消费；底层 backing store（worktree / Story store / activity.jsonl）是 backing store，**不直接读 JSON**。
> 红线：全部是 **L0 只读投影**，永不声称 production DONE，权威只认 receipt-backed evidence。
> 落地度：M1-M3 数据能力已就绪（CLI 全在）；M4 投影可做但 Thread/Trajectory schema 未一等化；**M5 取决于 B-2522 的 receipt-backed verifier（README 明确 enforce path 尚未端到端）**；M6 parallel/wave/dispatch 数据面已存在。
> 命名注意：仓库已有的 `lattice dashboard` 是**终端长驻的实时 story 进度看板**，与本文档的多页面只读 console 不是同一物；现有命令仍有 `koala` 命名残留，属本提案外的 follow-up。

---

## 0. 为什么不能照搬参考图

参考图（Claude Code Agent Monitor）的本质是 **transcript 反演**：它读 `~/.claude/projects/*.jsonl` 的 hook 事件，把单个 host（Claude Code）运行时的 token / tool / session 反推成看板。它的「Completed / Error」是 **host runtime 状态**，不是交付权威。

Lattice 的新一代核心是 **Host-Neutral**：把「完成」从 host runtime 彻底解耦。任何 host（Codex、Claude Code、未来的 headless runner）都只是一个 **adapter**，只能执行被授权的任务包并提交**可审计 receipt**。权威层只认 Canonical Story + receipt-backed evidence，host 本地的「绿了」永远只是 `local-evidence`。

> 来源真相：`docs/requirements/decisions/project-vision.md`（host-neutral 通用编排 CLI）、`docs/requirements/decisions/lattice-parallel-wave.md`（Authority Boundary）、`packages/main/src/core/canonical-story.ts`（实际数据结构）。

所以 Dashboard 的语义轴必须从「session 活没活」换成「**authority tier 到哪一层 / 哪里发生了 visible degradation / 能否 recover**」。

---

## 1. 八大 Host-Neutral 核心概念 → 真实数据结构 → Dashboard 表面

下表每一行都锚定到仓库里**已存在的代码或 CLI**，不是设想：

| 概念 | 落地结构（真实） | 产生它的 CLI（L0 只读） | Dashboard 表面 |
|---|---|---|---|
| **Host-neutral State** | `CanonicalStory.authority.tier ∈ {local-evidence, server-record, server-receipt}`；`lifecycle.localDone` vs `lifecycle.productionDone` 双值 | `story_export --format=json` | Overview 顶部「Authority Ladder」三层分布 + localDone↔productionDone 缺口 |
| **Canonical Story** | `schemaVersion:'canonical-story-v0'` + `canonicalStoryDigest` / `gateInputDigest`（sha256 防篡改） | `story_export` | Canonical Story Board（替代 Kanban，按 tier 分列而非按 host 状态） |
| **Capability Contract** | `hostCandidates[].capability status` + Lattice capability registry | `host_list` / `host_probe` / `host_install`(dry-run) / `parallel_wave_create.hostCandidates` | Capability Matrix（host × capability 网格） |
| **Visible Degradation** | `degradations[]`：`{host, capability, reason, fallback, authorityImpact, recovery}`，`authorityImpact ∈ {none, evidence-local-only, verification-evidence-limited, blocks-production-done}` | 内嵌于 `story_export` / `parallel_*` / `conduit_explain` | Degradation Heat（按 authorityImpact 着色，blocks-production-done 为红） |
| **Lineage** | `lineage:{source, storyDir, worktree, processEvents[], artifacts{checklist,processEvents,deliveryCheck}}` + `evidenceRefs`（仅 lineage 引用） | `story_export`、`parallel_report.evidenceSummary` | Lineage Graph（story↔worktree↔evidence↔receipt 溯源链） |
| **Thread** | 单个 host 对**一个任务包**的有界执行：`handoff → story_export.lineage.processEvents 片段 → receipt`（per-agent 线程） | `parallel_dispatch.dispatchEntries`、`story_export.lineage.processEvents` | Thread Inspector（替代参考图的 Conversation，按 host/agent 切线程） |
| **Trajectory** | 生命周期转移 + `story_export.lineage.processEvents` + `mergeOrder` 组成的有序路径：`truth→story→code→extract→gap→converge` | `convergence_check`、`parallel_merge_queue.mergeOrder`、`story_export.lineage.processEvents` | Trajectory Timeline（替代参考图 Timeline，轴是 lifecycle 而非 wall-clock） |
| **Recovery Point** | `lineage.recoveryPoints[]:{id, kind:'story-store', path}` + wave 的 `recoveryRefs` | `story_export`、`parallel_plan.recoveryGuidance` | Recovery Console（每个 story / wave 的可恢复锚点 + resume 指令） |

> 诚实标注：`Thread` 与 `Trajectory` 目前是**在 process-events + lifecycle 之上的投影概念**，尚无独立持久化 struct（`canonical-story.ts` 里只有 `processEvents` 原子事件）。Dashboard 用投影实现它们，里程碑 M4 才把它们提升为一等 schema。`productionDone` 目前**恒为 false**——`buildCanonicalStory` 里 `verifiedReceiptRefs` 始终为 `[]`，直到 B-2522 的 receipt-backed verifier 落地（见 M5）。这个缺口本身就是 Dashboard 要可视化的第一公民。

---

## 2. 数据源：只读消费 Lattice CLI JSON（不碰 transcript，也不直接读 backing store）

```
backing store（仅供理解，adapter 禁止直接读）
├── Story store          .koala/story/actives/B-xxx/{index.json, checklist.json,
│                          process-events.jsonl, delivery-check.json, test-evidence.json}
├── Worktree 现场         .worktrees/B-xxx/  + authority:{main|worktree} + mirror:{phase}
└── 全局心跳              .koala/activity.jsonl / docs/story/activity.jsonl

唯一权威读法 ── CLI L0 投影（adapter 只消费这一层的 --format=json）
    ├── session_brief / status              → ⚠ 目前【只返回 Markdown，无 --format=json】，见 §2.1(0)
    ├── story_export --format=json          → Canonical Story v0（含 8 概念全量；--format=json 已实装）
    ├── parallel_wave_create / _inspect      → Wave 完整 envelope（storyRefs/hostCandidates/mergeOrder/evidenceRefs）
    ├── parallel_plan / _dispatch / _status  → 调度投影（注意 status 不重复完整 envelope）
    ├── parallel_merge_queue / _report       → 合并序 + lineage summary（不重复完整 envelope）
    ├── host_list / host_probe / host_install→ Capability Contract
    ├── authority_status                      → 当前权威层快照
    ├── conduit_status / conduit_explain      → host↔authority 通道 + degradation 解释
    ├── rollout_check                         → 版本/wrapper/managed-assets/runtime 巡检
    └── convergence_check                     → truth↔code 收敛判定（Trajectory 终点）
```

### 2.0 CLI JSON stdout contract（B-7fc2）

Adapter / dashboard / smoke 可以把以下假设当作硬契约：

- **stdout in machine JSON mode is JSON.parse-able as a single document.** 当 caller 传 `--json` 或 `--format=json`，对应命令的 stdout 必须是「**单个 JSON 文档 + 可选末尾换行**」，没有任何 next-step 提示、装饰文本、ANSI 控制字符或第二个 JSON 文档拼接其后。Caller **不需要**做 substring 抽取（`extractFirstJsonObject` / 正则匹配 `\{...\}` 等），直接 `JSON.parse(stdout)` 必须成功。
- **人类可读引导只走 text mode 或 stderr。** `koala validate` / `lattice validate` 等命令的 `→ 验证全绿`、`→ 下一步…` 等 next-step hint 只在**非 JSON 模式**追加。`stderr` 用于日志 / 进度 / 配置 notice（如 `ℹ Reading legacy koala.config.json …`），不污染 stdout 契约。
- **实现选择记录**：契约由 CLI 输出管线（`cli-engine.ts`）的统一 choke point 强制——`wantsMachineJson(args)` 命中即跳过 `decorateResult`，所有注册了 hint 的命令（含 `validate`）自动遵守。后续如新增 `--json` / `--format=json` 命令，命中同 detector 自动获得契约保护，不需要再各自 patch。
- **回归保护**：`tests/cli-json-stdout-contract-smoke.ts`（`packages/main/src/tasks/cli-json-stdout-contract-smoke.ts`）spawn 真实 CLI 子进程，直接 `JSON.parse(stdout)`——任何把 hint 拼回 JSON 模式的回归都会立即烧红 smoke。Text mode 同时被检查必须保留 `→ 验证全绿`，防止「修复 JSON 模式时把人类提示也一并删掉」。

> 实际效果：dashboard / host adapter 把 Lattice CLI 的 `--format=json` / `--json` stdout 当稳定 contract，无需再处理过去 `validate --json` 末尾拼接 `→ 验证全绿。下一步：…` 导致 `JSON.parse` 失败的反模式。

### 2.1 三个 adapter 必须先解决的 schema/authority 陷阱

0. **resolver JSON surface 当前缺失（M1 的真正第一项工作）**：实测 `lattice status --format=json` / `--json` 与 `session_brief` **都忽略该 flag、只返回 Markdown**，`--help` 也无 `--format` 参数。所以 M1 **不是「写 adapter 消费现成 JSON」**，而是先要**新增/扩展一个机器可读 resolver surface**，返回每个 active story 的 `{storyId, authority, mirrorPhase, authoritativePhase, authoritativeCwd, worktreePath}`。在它落地前，让 UI adapter 去 parse Markdown 是脆弱反模式，禁止。
1. **worktree authority vs main mirror（最关键）**：在 repo root 跑 `story_export B-xxx` 读到的是 **main mirror**（常停在 INIT_CHECK，过时）；只有在 `.worktrees/B-xxx` 里跑才是 **authoritative** 阶段。Adapter **必须先用 (0) 的 resolver 拿到 `authoritativeCwd`，再在正确 cwd 下 export**——不能只聚合 root 的 export。
2. **Parallel projection 不共享同一 envelope**：`parallel_wave_create` 有完整 `storyRefs/hostCandidates/mergeOrder`；但 `parallel_status` / `parallel_merge_queue` / `parallel_report` **不重复完整 envelope**（真相源 `lattice-parallel-wave.md` §Projection JSON Contracts 已写明）。Adapter 要按**每个命令的真实 schema** 各写 mapping，不能假设字段都在。

### 2.2 resolver 行 schema（**示例，不放具体 active story**）

> 本文档**刻意不嵌任何具体 story 现场**——active story 阶段分钟级移动（同一天内 B-aa98 已在 DEV↔REVIEW 间反复），写死必过时。下表是 §2.1(0) resolver surface 的**字段契约**，每个字段在渲染时由 resolver 实时填充：

| 字段 | 类型 | 含义 |
|---|---|---|
| `storyId` | string | `B-xxxx` |
| `authority` | `main` \| `worktree` | 权威在主仓还是 worktree |
| `mirrorPhase` | phase | main 元数据镜像阶段（可能滞后） |
| `authoritativePhase` | phase | **真正权威阶段**（worktree 优先） |
| `authoritativeCwd` | path | adapter 必须切到此目录再 `story_export` |
| `worktreePath` | path \| null | `.worktrees/B-xxxx` 或 null |

> 锚定主线（来自 B-aa98 背景，引概念非引现场）：「把 Claude Code 视为另一个 host adapter……外部 host 只能执行被授权的任务包并提交可审计结果」——这正是本 console 要呈现的 host-neutral 主线。

---

## 3. 信息架构（沿用参考图的左导航 + 暗色卡片风格，重构语义）

| 参考图页面 | Lattice 替换页面 | 语义轴从 → 到 | 主数据源 |
|---|---|---|---|
| Dashboard | **Host-Neutral Overview** | host 运行时健康 → Authority Ladder + degradation 缺口 | `story_export` 聚合 + `authority_status` |
| Kanban (Working/Waiting/Completed/Error) | **Canonical Story Board** | host 状态四列 → **tier 三列**（local-evidence / server-record / server-receipt） | `story_export` |
| Sessions | **Wave / Lane View** | 单 session 列表 → 并行 worktree 泳道 + merge queue | `parallel_status` / `parallel_merge_queue` |
| Conversation | **Thread Inspector** | Main Agent 对话流 → per-host 任务包线程（handoff→events→receipt） | `parallel_dispatch` + process-events |
| Timeline | **Trajectory** | wall-clock 事件 → lifecycle 轨迹（truth→…→converge）+ recovery 锚点 | `convergence_check` + process-events |
| Activity Feed | **Lineage & Degradation Feed** | 全 host 事件流 → degradation/authority-change 事件流（按 authorityImpact 着色） | `conduit_explain` + degradations[] |
| Analytics | **Capability & Authority Analytics** | token/cost → capability 覆盖率 / tier 漂移 / productionDone 缺口趋势 | `host_probe` + 历史 export |
| Claude Config | **Host Registry / Conduit** | Claude 配置浏览 → host adapter 注册表 + conduit + rollout 巡检 | `host_list` / `conduit_status` / `rollout_check` |
| Run Claude | **Dispatch Console** | 跑 Claude → 生成任务包给 overflow host（needs runner confirm，spawned=false） | `parallel_dispatch`（`requiresRunnerConfirmation=true`） |
| Settings | **Authority Boundary & Pricing** | 定价 → 权威边界开关只读展示 + 定价 | `lattice_config_doctor` |

**新增页面**：**Recovery Console**（无参考图对应）——聚合所有 `recoveryPoints` + `recoveryGuidance`，一键给出 `cd .worktrees/B-xxx` / 重新 `story_export` 的 resume 路径。

---

## 4. 关键面板规格（ASCII mockup，沿用暗色 / 卡片 / 进度条风格）

> **以下所有 mockup 仅作布局示意（illustrative only）**，里面的数字与 storyId 全是占位符 `<...>`，**不是真实计数**，渲染时由 resolver/`story_export` 实时填充。文档不嵌任何会过时的具体现场。

### 4.1 Host-Neutral Overview — Authority Ladder（替代 Health Score 圆环）

```
┌─ AUTHORITY LADDER ────────────────────────  <totalStories> stories ─┐
│                                                                      │
│  server-receipt   ▓                          <receiptCount>   (n%)   │  ← productionDone 真值
│  server-record    ▓▓                         <recordCount>    (n%)   │
│  local-evidence   ████████████████████████   <localEvidenceCount>(n%)│  ← localDone 但未 receipt
│  in-flight        ▓▓▓                         <activeCount> (active)  │
│                                                                      │
│  ⚠ localDone↔productionDone GAP: <localEvidenceCount> 本地绿、零 receipt│
│    authorityImpact=blocks-production-done                            │
└──────────────────────────────────────────────────────────────────────┘
```

> 这一格是整个 console 的论点：参考图会把 `<localEvidenceCount>` 个标成「Completed」绿色，Lattice 把它们标成「local-evidence」——**还没拿到 server receipt，不算 production done**。

### 4.2 Canonical Story Board（替代 Kanban，按 tier 分列）

```
 LOCAL-EVIDENCE        SERVER-RECORD       SERVER-RECEIPT      DEGRADED ⚠
 ┌───────────────┐    ┌──────────────┐    ┌──────────────┐   ┌────────────────┐
 │ <storyId>     │    │  (empty until│    │  (empty until│   │ <storyId>      │
 │ <title>       │    │   server-    │    │   receipt    │   │ missing-server │
 │ wt:<worktree> │    │   record)    │    │   verified)  │   │ -receipt       │
 │ digest:<d4>.. │    │              │    │              │   │ impact: BLOCKS │
 │ evidence:<n>  │    └──────────────┘    └──────────────┘   │ -production    │
 └───────────────┘                                           │ recovery: run  │
 │ <storyId>     │                                            │ receipt flow   │
 │ wt:<worktree> │                                            └────────────────┘
 └───────────────┘
```

每张卡显示：`storyId · phase · worktree · canonicalStoryDigest 前 4 字节 · evidence 数 · 最高 authorityImpact`。点开 = `story_export` 全文。

### 4.3 Capability Matrix（替代 Subagent Effectiveness）

```
┌─ CAPABILITY CONTRACT ─────────── host × capability ────────────┐
│ host            story  scope  receipt  diff-apply  job-claim    │
│ codex           ✓ ok   ✓ ok   ✓ ok     ✓ ok        ✓ ok         │
│ claude-code     ✓ ok   ✓ ok   ⚠ DEGR   ⛔ none      ⚠ DEGR       │
│ headless-runner ✓ ok   ✓ ok   ✓ ok     ✓ ok        ✓ ok         │
│                                                                 │
│ ⚠ claude-code/receipt-verify → fallback: keep local-evidence   │
│   authorityImpact: blocks-production-done                       │
└─────────────────────────────────────────────────────────────────┘
```

数据来自 `host_probe` + `parallel_wave_create.hostCandidates`。每个 ⚠/⛔ 悬停 = `conduit_explain` 的 degradation reason/fallback/recovery。

### 4.4 Trajectory + Recovery（替代 Timeline）

```
<storyId> TRAJECTORY    truth ──► story ──► code ──► extract ──► gap ──► converge
                       ✓        ✓        ◉<phase>  ·          ·        ·
                                         │
 RECOVERY POINTS ──────────────────────┤
   • <storyId>:story-store  kind=story-store  <lineage.recoveryPoints[].path>
   • resume: cd <authoritativeCwd> && lattice story_export --storyId=<storyId> --format=json
```

---

## 5. Host-Neutral 与参考图的本质差异（一句话能讲清的论点）

| 维度 | 参考图（transcript monitor） | Lattice Host-Neutral Dashboard |
|---|---|---|
| 数据源 | `~/.claude/projects/*.jsonl` hook 事件 | worktree + Story store + L0 CLI 投影 |
| 「完成」定义 | host runtime 标 Completed | **receipt-backed `server-receipt` tier** |
| host 绑定 | 强绑 Claude Code | adapter 化（codex / claude-code / runner 平权） |
| 失败表达 | Error 红卡 | **Visible Degradation**（带 fallback + recovery + authorityImpact） |
| 可恢复 | 无 | **Recovery Point** 一等公民 |
| 防篡改 | 无 | `canonicalStoryDigest` / `gateInputDigest` sha256 |
| 权威 | 监控即真相 | **只读投影，永不授权**（`authority.productionDone=false` 硬编码） |

---

## 6. 里程碑（锚定真实 story 进度）

> 每个里程碑都映射真实 CLI + 当前 story 状态，不引入新权威路径。

| M | 名称 | 交付（全 L0 只读） | 依赖真实 story | 出口判据 |
|---|---|---|---|---|
| **M1** | Resolver surface + Read-only adapter | **先补一个机器可读 resolver JSON surface**（返回 active stories 的 `storyId/authority/mirrorPhase/authoritativePhase/authoritativeCwd/worktreePath`），再封装 `story_export`/`parallel_*`/`host_*`/`authority_status` adapter，零写入 | `status`/`session_brief` 现仅 Markdown（需扩展）；其余 CLI 已存在 | **第一验收项**=resolver JSON surface 存在且 UI 不需 parse Markdown；8 概念字段都能从 CLI JSON 取到 |
| **M2** | Authority Ladder + Story Board | Overview 三层 ladder + tier 分列看板 + degradation 着色 | M1 resolver + `story_export` 聚合 | `localEvidenceCount` 正确落在 local-evidence 列；localDone↔productionDone GAP 卡显示 |
| **M3** | Capability & Conduit | Capability Matrix + Host Registry + `conduit_explain` 悬停 | B-aa98（Host Overflow adapter） | claude-code 的 receipt-verify 降级可见且带 recovery |
| **M4** | Thread + Trajectory 提升为一等 schema | 在 `story_export.lineage.processEvents` 之上定义 Thread / Trajectory 投影 schema；Thread Inspector + Trajectory Timeline | B-5cdc（runner job claim / provider event flow，**已 DONE 可作基座**） | 单 host 任务包线程可回放；lifecycle 轨迹连通 |
| **M5** | Recovery Console + productionDone 真值打通 | recoveryPoints/guidance 聚合；当 B-2522 receipt-backed verifier 落地，server-receipt 列首次非空 | **B-2522（receipt-backed verifier + local/enforce E2E）；README 明确 enforce path 尚未端到端** | 至少 1 story 进入 `server-receipt` tier，缺口指标变化可见 |
| **M6** | Wave 调度视图 + Dispatch Console | 并行泳道 + merge queue + 任务包派发（`spawned=false` / `requiresRunnerConfirmation=true`） | parallel-wave 全套（已存在） | 派发投影不自动 spawn、不自动合并、不提交 receipt |

**关键顺序**：M1→M2 先把「host 本地绿 ≠ production done」这个论点立起来（数据已经现成）；M5 才是 Host-Neutral 闭环的高光时刻——B-2522 一旦提交可验证 receipt，Dashboard 的 `server-receipt` 列**第一次亮灯**，整张表从「全是 local-evidence 的诚实焦虑」走向「有据可查的 production done」。

---

## 7. 权威边界红线（不可越）

1. **Dashboard 是 L0 只读投影**：可写 caller 请求的 export 文件，但**绝不**改 story metadata / process evidence / lifecycle / receipt / authority / 不 spawn runner。
2. **永不声称 production DONE**：所有投影硬带 `authority.productionDone=false`、`authorityChanged=false`、`receiptRefs=[]`，除非 export 里出现**已验证** receipt。
3. **本地 PASS 不升级**：host 本地「绿」永远停在 `local-evidence`，rollout_check / wave / handoff 都不能把它提升为 production authority。
4. **降级必须可见**：任何 capability gap 都进 `degradations[]` 并标 `authorityImpact`，不静默吞。
5. **防篡改**：展示 `canonicalStoryDigest`，diff 不符即告警，不信任「被改过的 Canonical Story」。
6. **enforce 尚未闭环**：README 明确 `enforce` path「Not implemented end-to-end yet」；即便配了 Python authority env，`shadow` 模式的 `accepted:true` 只是 `thin-client-transport-accepted`，**不是 verified receipt**。在 B-2522 receipt 流打通前，`server-receipt` 列必须保持空、`productionDone`/`receiptVerified` 保持 `false`。Dashboard 不得把 shadow accepted 渲染成「已完成」。

> 真相源以 `docs/requirements/decisions/lattice-parallel-wave.md` 的 Authority Boundary、`packages/main/src/core/canonical-story.ts`、以及 `README.md`（Authority modes off/shadow/enforce）为准。本文档是只读 console 设计投影，不修改任何权威语义。

---

## 8. 采纳状态与下一步

**本文档已采纳为设计真相源**：位于 `docs/requirements/decisions/host-neutral-observability-console.md`，登记在 `docs/requirements/NAV.md` 的 decisions 列表，可被其它 story / decision 引用为 implementation contract。它已完成去硬编码（无具体 active story 现场）、去 legacy command 示例（统一 `lattice ... --format=json`）。

**下一步 = M1 实现 story**（参见 §6 里程碑表）：`Read-only adapter skeleton + worktree-authority resolver`。

- **第一验收项**：§2.1(0) 的 **resolver JSON surface**——`status`/`session_brief` 当前仅返回 Markdown，必须先补一个机器可读 surface 返回 `{storyId, authority, mirrorPhase, authoritativePhase, authoritativeCwd, worktreePath}`，避免 UI adapter parse Markdown。
- M1 落地后再按 M2→M6 推进；M5（`server-receipt` 列首次亮灯）阻塞在 B-2522 的 receipt-backed verifier。
