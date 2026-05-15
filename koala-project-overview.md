# Koala 项目详细说明 & 与 Claude Code / Codex 对比

> 基于项目根 `CLAUDE.md` 整理，日期 2026-05-15。

---

## 一、项目核心定位

**Koala** 是一套**强流程驱动的 story 化开发框架**：把"一个需求"建模为有状态的 story，用 CLI 工具 + 状态机 + 多层 reviewer + 硬门槛 gate 来强制开发流程不被绕过；同时配套一套"Core/Shell 分层 + Data/Machine/Fn 三原子"的代码范式，要求所有可建模代码必须能被状态机黑盒驱动测试。

---

## 二、项目能力总表

### 2.1 流程层（Story Lifecycle）

| 维度 | 内容 |
|---|---|
| **状态机** | `INIT → INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE`（正常通道） |
| **快速通道** | `INIT → INIT_CHECK → DEV → REVIEW → TEST → DONE`（跳过 PLAN） |
| **通道判定** | checklist ≤ 2 项 且 无 riskSignals → 快速通道；否则正常通道。实时计算，不存储 |
| **worktree 隔离** | 每个 story 一个独立 worktree（`.worktrees/B-xxx/`），分支 `story/B-xxx`，cwd 门禁保证主 agent 在正确目录 |
| **DONE 合并门禁** | 要求 story 分支已包含 main 所有提交；分支不匹配拒绝写状态、拒绝 merge、拒绝清理 |

### 2.2 各阶段产物（正常通道）

| 阶段 | 必产物 | 校验要点 |
|---|---|---|
| **INIT** | `index.json` + `background.md` + checklist 初版 | `story_create` 写入；自动扫高风险关键词 elevate priority |
| **INIT_CHECK** | `init-check.json`（reviewer 签名） | 必须由 `koala-review-story-init` reviewer 调 `init_check_set`；签名失配 / 缺失 / critical-high issue 全部 block |
| **PLAN** | `understanding.json` + `decision.json` + `checklist.json`（含 `verificationIntent`） + `plan.md` + `scope-check.json` | `story_review` issueCount=0；scope-check 覆盖 covered/excluded/gap/orphan/drift/openQuestions 六通道；OQ 必须用 `scope_question_resolve` 书面消解（≥20 字符 trim） |
| **DEV** | 代码 + 测试 + `verificationEvidence`（covers must intent） | DEV→REVIEW 阻塞缺失 must evidence 的 intent；正常通道代码必须由 koala-implementer 写（非主 agent） |
| **REVIEW** | reviewer findings + 全部 resolve | CLI gate（channel/concept/lint/docs-drift/codex-adapter）+ LLM reviewer（baseline 三件套 + 按 riskSignals opt-in），任一 fail 阻 REVIEW→TEST |
| **TEST** | `koala validate` 全绿 + bug 全 fixed + `delivery-check.json` | delivery-check 由 `koala-review-delivery` 签名；docsPromises 必须 verifiedBy 或 waiver（≥30 字符理由） |
| **DONE** | 合并回 main + 清理 worktree + 触发 audit 提示 | 按 `.koala/audit-config.json` 触发跨 story 框架自省 |

### 2.3 PLAN 阶段三件套结构化要求

| 产物 | 字段 | 约束 |
|---|---|---|
| **understanding** | task / outcome / facts / constraints / unknowns / touchpoints | task ≥ 5 字符；unknowns 非空建议先调研 |
| **decision** | principles / drivers / options / chosen / rationale / preMortem | principles 3–5 条；options ≥ 2；chosen ∈ options；rationale ≥ 10 字符；高风险 story preMortem ≥ 3 条 |
| **plan.md** | 每个 CHK-xxx 一个章节：Owner / DependsOn / Files / Verify / DoneWhen | 不允许孤儿章节；DependsOn 不能有环；DEV 后冻结 |
| **checklist 单项** | title / context / userSees / relatedDocs / verificationIntent | userSees 必含精确输出；relatedDocs 触发三次软提醒；verificationIntent 含 happy/edge/adversarial 三栏 |

### 2.4 REVIEW 阶段双层 gate

#### CLI Gate（机械判定，秒级）

| Gate | 命令 | 作用 |
|---|---|---|
| channel | `koala validate --channel --story=B-xxx` | 正常通道必须有 dispatch/subagent_result 结构化证据 |
| concept | `koala validate --concept` | 扫 `git diff main...HEAD` 抽 deleted symbols + 残留引用 ≥5 触发 concept reviewer |
| lint | `koala validate --lint` | 递归 monorepo 所有子包 tsc + ruff + import-graph（shells 不可 import fn.ts） |
| docs-drift | `docs-drift` preflight | reviewer 文档引用的 koala 命令必须与 registry 对齐 |
| codex-adapter | `koala-codex verify_codex` | 触及 Codex adapter 入口时强制 adapter 证据 |

#### LLM Reviewer（按 riskSignals opt-in）

| Reviewer | 挂载条件 | 职责 |
|---|---|---|
| concept | baseline 永远开 | 概念删除残留 |
| quality | baseline 永远开 | 主观质量项（lint 已绿前提下） |
| test-coverage | baseline 永远开 | verificationIntent → verificationEvidence 覆盖 |
| behavior | riskSignals 含 `state machine` / `guard` / `gate` | 行为正确性 |
| docs | touchpoints 含 `.md` 文件 | 文档同步 |

### 2.5 Finding / Cluster / 轮次递减

| 机制 | 说明 |
|---|---|
| **Finding 签名** | reviewer finding 带 `_hash + reviewRound`，gate 验签，主 agent 不能伪造 |
| **Cluster 聚簇** | files 交集 ≥50% + severity 一致 → 自动合簇；commit `Resolves: CL-xxx` 自动 resolve |
| **派发统一** | `koala dispatch` 接 itemId/findingId/clusterId 互斥参数 |
| **Round 1 blocking** | strict: critical+high+medium / balanced: critical+high |
| **Round 2 advisory** | medium → `[R2-ADVISORY]`，不阻塞 |
| **Round 3 advisory** | high → `[R3-ADVISORY]`，medium 已 advisory |
| **硬规则** | critical 任意轮次必修；high 前两轮必修；medium/low 看 profile |

### 2.6 代码范式

| 原子 | 文件 | 规则 |
|---|---|---|
| **Data** | `data.ts` | 纯类型 / 接口 / 常量，`readonly` |
| **Machine** | `machine.ts` | 纯配置对象，零函数定义 |
| **Fn** | `fn.ts` | 纯函数，无副作用、无 I/O |
| **Bridge** | `bridge.ts` | Local/WS bridge 接口，shell 只允许 import 这层 |
| **I/O 壳** | `main.ts` / `ui.ts` | 只做输入输出，禁止业务逻辑、禁止 import fn.ts |

### 2.7 Core/Shell 分层

| 层 | 职责 | 不做 |
|---|---|---|
| `core/app.ts` | `createApp()` → 创建 bridge + IO 调度 | WS / fs / 渲染 |
| `core/debug.ts` | 调 `devHost()`（3 行模板） | 自己写 WS / fs |
| `core/machines/*` | 状态机 + 纯函数 + bridge | I/O |
| `core/io/*` | LLM / 网络 / 文件 | 状态管理 |
| `shells/cli` / `shells/web` | 渲染 + 输入采集 | import fn.ts、持业务状态、调 I/O |

启动三模式：`npm start`（Vite + LocalBridge）/ `npm run serve`（Core + WS + Dashboard）/ `npm run serve:cli`（带 CLI 壳）。端口基于 projectRoot 路径哈希自动分配，写 `.koala-serve.json`，多 worktree 不冲突。

### 2.8 角色分工

| 角色 | 职责 | 是否写代码 |
|---|---|---|
| 主 agent | PLAN + plan.md + 分配 + 验收（REVIEW/TEST/DONE） | 仅快速通道 |
| koala-implementer | 按 plan.md 章节实现单个 checklist item | 正常通道必须 |
| koala-review-\* | INIT_CHECK / scope-plan / concept / quality / test-coverage / behavior / docs / delivery 等多类 reviewer | 否 |
| koala-evaluator / -cli | 产品质量打分 | 否 |

**fresh worker per item**：每个 CHK-xxx 派一个新的 koala-implementer，不复用上下文。并行需同时满足：DependsOn 已满足 + Files 写集不重叠 + 不共享稀缺资源。

### 2.9 验证与调试

| 命令 | 用途 |
|---|---|
| `koala validate` | 静态 + 逻辑 + 集成测试 |
| `koala validate --full` | 含真机测试 |
| `koala validate --json` | 结构化输出 + verification coverage |
| `koala validate --channel/--concept/--lint` | 单独跑某个 CLI gate |
| `koala status` | 一屏看当前 story 状态 |
| `koala serve` | HTTP API 调试（自动从 machine.ts 生成端点） |
| `koala session_brief` | 每次新 session 第一条命令；Claude prompt hook 60 分钟无记录会软提醒 |

**Debugging Contract**（硬规则）：Observe → Hypothesize → Isolate → Confirm。没有复现不进入修复；没有根因不算完成；用 `bug_update --evidence` 投影调试结论。

### 2.10 框架自省 audit

`.koala/audit-config.json`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `auditTriggerWindow` | balanced=5 | 完成多少 story 触发一次自省提示 |
| `requireClaudeMdDiff` | true | 窗口内 CLAUDE.md 有改动才提示 |
| `mode` | `semi-auto` | semi-auto / full-auto / off |

无专用 CLI（YAGNI，改动频率极低）。

### 2.11 Pre-push 外部防线（自举开发）

`.githooks/pre-push` 完全不调用 `koala` 命令，只用 `npx tsc --noEmit`，防止"全局 koala 可执行文件版本错位"翻车（B-9bd9 事故根因）。递归扫所有子包 tsconfig，黑名单：`node_modules/dist/build/.worktrees/.git`。

---

## 三、Koala vs Claude Code vs Codex 对比

> Claude Code = Anthropic 出的命令行编码 CLI；Codex = OpenAI 系编码 agent / 工具（含 Codex CLI、Codex adapter 等）。下表对比三者在**软件开发流程协助**这件事上的能力切面。

| 维度 | Koala | Claude Code | Codex |
|---|---|---|---|
| **定位** | 强流程 story 化开发框架（CLI 工具 + 状态机 + reviewer + gate） | 通用编码助手 CLI，对话式驱动，工具调用灵活 | 通用代码生成/编辑 agent，CLI 形态 |
| **流程模型** | 显式状态机（INIT→INIT_CHECK→PLAN→DEV→REVIEW→TEST→DONE），硬门槛 gate | 无显式流程模型，依赖 prompt + TodoWrite 等软约束 | 无显式流程模型 |
| **任务追踪** | story 文件系统（`docs/story/actives/B-xxx/`）+ checklist 真相源 | TodoWrite/TodoRead 临时任务（会话内） | 临时任务列表 |
| **阶段门禁** | 多个硬 gate（INIT_CHECK / scope-check / verificationEvidence / delivery-check / CLI gate / LLM reviewer），无法被 prompt 绕过 | 无硬门禁；建议性提醒 | 无硬门禁 |
| **代码评审** | CLI gate（lint/channel/concept/docs-drift）+ 多类 LLM reviewer 并行，finding 带签名 | 用户/CI 手动评审，可让 AI 协助 | 用户/CI 手动评审 |
| **Worktree 隔离** | 每 story 一个 worktree，cwd 门禁强制隔离 | 无内建支持 | 无内建支持 |
| **代码范式约束** | 强制 Data/Machine/Fn 三原子 + Core/Shell 分层（shells 不可 import fn.ts，validate 检查） | 无范式约束 | 无范式约束 |
| **测试纪律** | verificationIntent（PLAN 阶段三栏必填）→ verificationEvidence（DEV 写证据）→ gate 校验覆盖 | 建议但不强制；TodoWrite 提醒 | 建议但不强制 |
| **风险检测** | story_create 自动扫高风险关键词（auth/migration/destructive/...）elevate priority + 触发 preMortem | 无自动风险扫描 | 无自动风险扫描 |
| **子 agent 分发** | 正常通道强制 fresh worker per item（不复用上下文）+ Files 写集不重叠才并行 | Task tool 派子 agent（自由度大） | Task tool 派子 agent |
| **文档漂移检测** | `docs-drift` CLI gate + docsPromises 必须 verifiedBy 或 waiver；自动 audit | 无内建机制 | 无内建机制 |
| **概念删除残留** | `koala validate --concept` 自动扫 deleted symbols + 全仓 grep 残留引用 | 需要手动 grep | 需要手动 grep |
| **调试纪律** | Debugging Contract 硬规则（Observe→Hypothesize→Isolate→Confirm + bug_update --evidence） | 无强制纪律；prompt 软引导 | 无强制纪律 |
| **REVIEW 轮次递减** | 框架自动 `[R2-ADVISORY]` / `[R3-ADVISORY]` 标签 + gate 同源判定 | 不适用 | 不适用 |
| **签名防伪** | finding/init-check/scope-check/delivery-check 都带 `_hash + reviewRound`，主 agent 不能伪造 reviewer 结论 | 无 | 无 |
| **状态机自动调试 API** | `koala serve` 自动从 machine.ts 生成 HTTP 端点（`/bridge/event /state /events /replay /reset`）+ Dashboard | 无 | 无 |
| **多 worktree 端口分配** | 路径哈希自动分配 + `.koala-serve.json` 发现文件 | 无 | 无 |
| **外部 pre-push 防线** | `.githooks/pre-push` 独立于 koala 自身（防自举翻车） | 无 | 无 |
| **集成方式** | 既能与 Claude Code 配合（subagent 类型 `koala-review-*` / `koala-implementer`），也提供 `koala-codex` adapter（CLI gate codex-adapter） | 自己就是 CLI agent | 自己就是 CLI agent |
| **数据持久化** | 文件系统（`docs/story/actives/*` + `.koala/*.json`） + git 提交 | 会话内（除非自己写文件） | 会话内 |
| **典型用户** | 强纪律工程团队 / 长期维护项目 / 高风险系统 | 个人开发 / 通用编码任务 / 灵活探索 | 个人开发 / 通用编码任务 |

---

## 四、一句话总结三者关系

**Claude Code / Codex** 是"通用编码 agent"——你给它对话，它写代码，纪律靠你和 prompt 维持。

**Koala** 是"在 Claude Code 之上加一层流程外骨骼"——它不是替代 Claude Code，而是把"故事化需求管理 + 多层 gate + 签名防伪 + 范式约束"做成 CLI 工具和 subagent，让 Claude Code（或 Codex via adapter）在它的轨道里跑，从而把"AI 容易在长程任务里偷懒/漂移/绕规"的问题压住。

类比：Claude Code 是"会写代码的实习生"，Koala 是"代码评审 + 流程经理 + QA + 部门规章手册"的合集，强制实习生按章办事。
