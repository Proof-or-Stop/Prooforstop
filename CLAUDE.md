<!-- proof-or-stop:start -->
# CLAUDE.md

## 行为准则

0. **每次新 session 或恢复中断工作时，第一条命令先 `proof-or-stop session_brief`**
1. 任何需求先走完整 Story 流程，除非用户明确说"立刻改"
2. 行动前先 `proof-or-stop session_brief`（项目状态 + 下一步提示），再酌情 Read 关键文件
3. 输出要简洁，但推理要彻底
4. 优先编辑而不是重写整个文件
5. 在宣布完成前测试你的代码：`proof-or-stop validate`
6. 保持解决方案简单直接
7. 用户指令始终覆盖此文件
8. **禁止直接读写 `docs/story/` 目录下的文件**。所有 story 操作走 `proof-or-stop story_create` 等/`proof-or-stop checklist_*`/`proof-or-stop bug_*` 命令
9. **代码验证统一用 `proof-or-stop validate`**

## Story 阶段流转

两条通道，状态机自动判定：

```
正常通道：  INIT → INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE
快速通道：  INIT → INIT_CHECK ──────→ DEV → REVIEW → TEST → DONE
                                     (跳过 PLAN)
```

**快速通道条件**：checklist ≤ 2 项 且 无 riskSignals。

| 阶段 | 做什么 |
|---|---|
| **INIT** | `story_create` 创建 story |
| **INIT_CHECK** | `story_advance INIT_CHECK` 创建 worktree，提示 cd |
| **PLAN** | understanding → decision → checklist + `verificationIntent` → plan.md（正常通道）→ scope-plan reviewer（`scope-check.json`，balanced/strict 必需）→ `story_review` 审查通过后进 DEV（快速通道跳过 PLAN） |
| **DEV** | 写代码 + 写测试，给 must intent 记录 `verificationEvidence`，checklist 全 done 后进 REVIEW |
| **REVIEW** | 按 riskSignals / touchpoints 自动挂载 LLM reviewer（baseline concept+quality+test-coverage，其他按信号 opt-in，详见下方「Reviewer opt-in 路由」）+ CLI preflight gate（`validate --channel` / `--concept` / `--lint` / `docs-drift`，触及 Codex adapter 时另加 `codex-adapter`）在 REVIEW→TEST 自动跑；`proof-or-stop-review-channel` 已退役（S1），由 CLI 接管。主 agent 验收：`finding_list` 确认 reviewer finding 注册 → 逐条 resolve → blocking finding 全 resolved 后经 inventory + PRE_CERT 进 TEST（CLI gate 任一 fail 会直接 block）；整个 REVIEW→TEST 顺序由 `proof-or-stop next --storyId=<id>` 逐步给出 |
| **TEST** | routine `proof-or-stop validate` 已在 REVIEW 的 PRE_CERT 之后跑过一次，TEST 只消费该 PASS；完成 live smoke / delivery reviewer / finish decision / summary / review assurance floor、bug 全 fixed 后进 DONE（`proof-or-stop next --storyId=<id>` 逐步给出每一步） |
| **DONE** | `story_advance DONE` 合并回 main 并清理 worktree。DONE 成功后按 `.proof-or-stop/audit-config.json` 触发 audit 提示（semi-auto 模式在输出末追加 audit 建议；详见「框架自省 audit 配置」段） |

### REVIEW → DONE is framework-driven: `proof-or-stop next --storyId=<id>`

After DEV (every checklist item done and committed), run `proof-or-stop next --storyId=<id>` from the Story worktree and execute the one command it prints, then ask again. It is read-only, decides each step from the real gate predicates (evidence-chain check, REVIEW verdict, reviewer batch plan, inventory status, PRE_CERT admit predicates, certification status, DONE oracle), and labels it `framework` (mechanical, including a managed launch fully bound to this Story's own earlier host/model/effort and the wait on it; `proof-or-stop next --storyId=<id> --run` executes them through the normal CLI, all waits of one call within one 285 s budget, and prints `paused:` to rerun it), `agent` (code, a first or replacement managed launch, authored text or a host verdict; `<...>` placeholders name the fields to author, each with a one-line description, and a `batch` step lists several authoring commands to run in one turn, e.g. TEST's finish decision + summary) or `human`. Prefer `next --run`; no command `next` prints needs `--help`. It covers REVIEW entry, every review round (prepare → launch all prepared lanes, historically slowest first → import each lane as it ends → wait on the rest; old-PoS run 34), the inventory epoch and critic, remediation back to DEV (repair → evidence refresh → `finding_resolve`, a framework step with framework-authored resolutions since old-PoS run 34), the review reopen back to DEV when material was committed during REVIEW with no open finding (old-PoS run 25: one framework step `review_reopen`, then DEV refreshes the evidence and REVIEW starts a fresh round; do not edit code or tests during REVIEW, a needed change goes through it), PRE_CERT (fast check → `certification_window_begin` → routine `validate`), TEST (live smoke, delivery reviewer, finish decision + summary as one step, review assurance floor; on a single host that is one framework step, `quorum_submit` with `singleHost:true`) and DONE. It also drives INIT from `story_create` on (lab `owner-init-and-worker-prompt`): with no unfinished Story, `proof-or-stop next` prints the one complete `story_create` template (boundaries inline, every placeholder hinted); then `next --storyId=<id> --run` records the scope freeze check, launches both managed INIT reviewers in parallel (their first launch uses the Story's selection, else the qualified managed-reviewer default; none under the EXPERIMENTAL A/B switch `plan.reviewMerge=on`, where the plan is reviewed once in PLAN), waits, and runs `story_advance` INIT_CHECK and PLAN; called outside the Story worktree it runs there and prints the `cd`. In PLAN it names the DEV entry too: the dev-memory acknowledgement, under `plan.pinProbe=on` the pins the Story base or a request-literal example contradicts (`pin_probe_mismatch`), the deterministic PLAN authoring batch, the scope-plan reviewer launch (or relaunch of a stale verdict), then `story_advance --phase=DEV` or the DEV guard's own Next (a `story_review` round older than the inputs it judged is rerun by the framework, `story_review_rerun`; old-PoS run 34). In DEV, after an intent amendment that adopted the value the implementer declared under `[intent-conflict]`, it runs the item's pinned verifier itself (`verification_run`) and marks the item done; only a failing verification relaunches the implementer (old-PoS run 34). Its commands accept trailing flags such as `--json`. Do not reorder these steps or probe `story_advance` ahead of it. Decision table: `docs/CLI.md` ("`next --storyId`").

**Framework owner driver (`next --untilAgent`, `owner.driver`; owner-driver lab).** `proof-or-stop next --storyId=<id> --untilAgent` (no `--storyId`: the one unfinished Story; when Stories exist and every one is DONE the terminal `outcome: done` naming the last DONE Story, never the `story_create` template (old-PoS run 65: the template made the driver create two more Stories for the finished task); the template only for a project with no Story) repeats `next --run` in child processes, with no agent turn in between (pauses at the wait budget and `maxSteps` are driven again), until a step needs the agent, a step is refused, a human step or DONE, and prints that ONE step (`--json`: `proof-or-stop.next_drive.v1` with `outcome` agent|stopped|framework_blocked|human|done|watchdog|error|budget). It never runs a step `next --run` would not run, so a judgment step always reaches the agent. Each call runs in its own process group under a stall watchdog: silent for 180 s with no step process below it (old-PoS run 55: `next --run` sat 25.8 min after a completed wait) or 20 min with one (`PROOF_OR_STOP_DRIVE_STALL_MS` / `_DRIVE_STEP_STALL_MS`) = killed and decided again; three kills in a row end the drive (`watchdog`). With `owner.driver: framework` in the project config (default `llm`: unchanged) an external driver (the bench adapter) runs it and resumes the owner only with the returned step: `story_create` then says `Next: end your turn now`, and after the handed-back step the agent ends its turn instead of running `next --run`. Under `owner.driver: framework` every step text `next` hands back (also the `story_create` template) ends with "end your turn" and never tells the owner to run `next --run` / `next --untilAgent` (`frameworkOwnerWhy`; old-PoS run 65: the TEST authoring text did, the owner ran it and it executed `enter_done`), and `story_create` refuses a request whose digest equals a DONE Story's `request.md` (`[request_already_delivered]`; under `llm` only an advisory note). Since old-PoS run 64, `owner.driver: framework` also makes `dev_memory_preflight_ack`, the first `scope_plan_review_launch` and the first default `live_smoke` capture framework steps `next --run` executes (llm default unchanged). Decision table and measurements: `docs/CLI.md` ("`next --untilAgent`").

### 如何选通道

- **小改动**（bug fix、文案修改、配置调整）：创建 story 时只写 1-2 条 checklist，worktree 创建后直接 `story_advance DEV`，主 agent 自己做
- **正常改动**（新功能、重构、多文件改动）：走完整 PLAN（understanding_set + decision_set + checklist + plan.md + scope-plan reviewer + story_review），拆给 subagent

## Proof-or-Stop CLI 速查

```bash
proof-or-stop story_create '{"name":"xxx","title":"...","description":"...","type":"feature","priority":"high","checklist":[{"title":"做什么","context":"上下文"}]}'
proof-or-stop story_review '{"storyId":"B-xxx"}'
proof-or-stop story_advance '{"storyId":"B-xxx","phase":"DEV"}'
proof-or-stop story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'       # routine read-only status
proof-or-stop checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'              # routine read-only status
proof-or-stop story_get '{"storyId":"B-xxx"}'                                                           # full output before evidence/mutations
proof-or-stop checklist_get '{"storyId":"B-xxx"}'                                                       # full output before evidence/mutations
proof-or-stop checklist_update '{"storyId":"B-xxx","itemId":"CHK-001","status":"done"}'

# 验证
proof-or-stop validate              # 静态 + 逻辑 + 集成测试
proof-or-stop validate --full       # 含真机测试
proof-or-stop validate --json       # 结构化输出
proof-or-stop status                # 工作中快速状态一屏看
proof-or-stop serve                 # HTTP API 调试
proof-or-stop serve --dev="..."     # 带浏览器代理

# PLAN 阶段产物
proof-or-stop understanding_set '{"storyId":"B-xxx","task":"...","outcome":"...","facts":[],"constraints":[],"unknowns":[],"touchpoints":[]}'
proof-or-stop decision_set '{"storyId":"B-xxx","principles":[],"drivers":[],"options":[],"chosen":"A","rationale":"..."}'
```

## Claude Prompt Hook

`.claude/settings.json` 安装了 `UserPromptSubmit` hook：每次 Claude Code 收到用户 prompt 时，会读取仓库 `.proof-or-stop/activity.jsonl`，并兼容读取旧版 `docs/story/activity.jsonl` 及 story-scoped `docs/story/actives/*/activity.jsonl` heartbeat。默认 60 分钟内跑过 `proof-or-stop session_brief` 就静默；超过 60 分钟、没有记录或没有任何 activity 文件时，只输出软提醒：

```text
建议先运行 proof-or-stop session_brief 恢复现场
```

阈值可用 `PROOF_OR_STOP_SESSION_BRIEF_FRESH_MINUTES` 配置；旧环境变量不再读取。hook 对 malformed stdin、缺文件、解析失败都零退出，不阻塞 prompt。每个 host 的 hook/settings 都是框架在 `proof-or-stop init` 时按 host 生成的 managed asset：Claude host 落在 `.claude/`（如 `.claude/hooks/proof-or-stop-scope-pretool.cjs`，已纳入 git），Codex adapter 落在其各自的 adapter 目录（同样由框架生成对应的 scope-guard hook）。这些是框架管理的生成产物，不要手写或手改；要调整 hook 行为请改生成源（`init-assets` / `core/managed-assets`），而不是直接编辑产物。

## 框架自省 audit 配置

B-9bd9 引入了「跨 story 框架自省 audit」机制（定期扫 CLAUDE.md 承诺 vs 实际代码行为）。运行参数由 `resolveAuditConfig(profile, projectRoot)` 解析，**无专用 CLI 命令**（改的频率极低，手改 JSON 即可——YAGNI）。

**三个字段含义**：

| 字段 | 类型 | 含义 |
|---|---|---|
| `auditTriggerWindow` | number | 每完成多少个 story 触发一次 audit 提示（与 CLAUDE.md diff 条件双触发） |
| `requireClaudeMdDiff` | boolean | 是否要求"窗口内 CLAUDE.md 有改动"才提示 audit（避免空跑） |
| `mode` | `"semi-auto"` / `"full-auto"` / `"off"` | 半自动=只提示不跑；全自动=DONE 后同进程跑；off=完全关闭 |

**优先级（高 → 低）**：

| 层 | 来源 | 说明 |
|---|---|---|
| 1 | `<projectRoot>/.proof-or-stop/audit-config.json` | 项目级覆盖，按字段逐项覆盖 |
| 2 | profile 默认 | `auditTriggerWindow`：light=10 / balanced=5 / strict=3（其他字段所有 profile 共用第 3 层硬编码） |
| 3 | 硬编码兜底 | `{auditTriggerWindow:5, requireClaudeMdDiff:true, mode:"semi-auto"}` |

**手改配置**：直接编辑 `<projectRoot>/.proof-or-stop/audit-config.json`（如需）：

```json
{
  "auditTriggerWindow": 3,
  "requireClaudeMdDiff": true,
  "mode": "semi-auto"
}
```

**失败策略**：
- 文件不存在 → 静默使用 profile 默认
- JSON 解析失败 / 不是对象 → 一次性 `console.warn` + fallback 到 profile 默认
- `mode` 字段非法值 → warn + fallback `"semi-auto"`
- 其他字段类型错误 → 静默忽略该字段

**为何不提供 `proof-or-stop audit_config_set` CLI**：改动频率极低（多数项目一辈子改 0～1 次），专门造命令反而增加记忆负担；直接手编 JSON 即可，schema 在 `packages/main/src/core/audit-config.ts` 里一眼看完。

## 代码范式（Data / Machine / Fn）

所有可建模的代码分为三种原子：

| 原子 | 文件 | 规则 |
|---|---|---|
| **Data** | `data.ts` | 纯类型/接口/常量，`readonly` |
| **Machine** | `machine.ts` | 纯配置对象，零函数定义 |
| **Fn** | `fn.ts` | 纯函数，无副作用、无 I/O |

I/O 壳（main.ts / ui.ts）只做输入输出，不含业务逻辑。

## Core/Shell 分层架构

### 核心思想

项目分 **core**（逻辑核心，平台无关）和 **shells**（纯表现层）。Shell（CLI/Browser）只 import bridge.ts，**不 import fn.ts**。

```
src/
├── core/                          # 逻辑核心（平台无关）
│   ├── app.ts                     # 应用组装：createApp() → { bridge }
│   ├── debug.ts                   # 调试入口：devHost(createApp, Machine)
│   ├── machines/<name>/           # 状态机模块
│   │   ├── data.ts / machine.ts / fn.ts / bridge.ts
│   └── io/                        # I/O（LLM、网络、文件）
├── shells/                        # 纯表现层（只做渲染 + 输入采集）
│   ├── cli/main.ts
│   └── web/ui.ts
└── validate.ts
```

### 职责分工

| 层 | 职责 | 不做什么 |
|---|---|---|
| **app.ts** | 创建 bridge + 注册 IO 调度（AI 等） | 不做 WS/fs/process，不做渲染 |
| **debug.ts** | 调用框架 `devHost()`，挂壳 | 不写 WS/fs 逻辑（框架负责） |
| **machines/** | 状态机 + 纯函数 + bridge 接口 | 不做 I/O |
| **io/** | 外部 I/O（LLM API 调用等） | 不做状态管理 |
| **shells/** | 渲染 + 用户输入采集 | 不 import fn.ts，不持有业务状态，不调 I/O |
| **WS server** | **框架**：`proof-or-stop serve` 自动启动 WS bridge + proxy | 项目不需要写 WS server |
| **调试 API** | **框架**：`proof-or-stop serve` 自动从 machine.ts 生成端点 | 项目不需要写 HTTP server |

**关键：项目只写 LocalBridge（同进程直连）。WS 通道和调试 API 由框架统一提供。**

### app.ts 是什么

`app.ts` 是项目写的核心组装文件，**平台无关**（浏览器和 Node.js 都能跑）：

```typescript
// core/app.ts
export async function createApp() {
  const bridge = createLocalBridge();

  // IO 调度：PvE 模式白方自动调 AI
  bridge.onStateChange((state) => {
    if (state.mode === 'pve' && state.currentPlayer === 'white') {
      getAIMove(state.board, state.lastMove).then(pos => bridge.sendEvent('MOVE', pos));
    }
  });

  return { bridge };
}
```

- **浏览器正式运行**：`ui.ts` import `createApp()` → LocalBridge 直连，零 WS
- **Node.js 调试运行**：`debug.ts` import `createApp()` → 框架套 WS server

### debug.ts 是什么

项目的调试入口，**3 行**，框架负责所有基础设施：

```typescript
// core/debug.ts
import { devHost } from '@proof-or-stop/core/dev-host';
import { createApp } from './app.js';
import { GameMachine } from './machines/game/machine.js';

const app = await devHost(createApp, GameMachine);

if (process.env.PROOF_OR_STOP_SHELL === 'cli') {
  const { startCliShell } = await import('../shells/cli/main.js');
  startCliShell(app.bridge);
}
```

框架的 `devHost()` 负责：杀旧进程 → 创建 app → 启动 bridge-host WS → 写 `.proof-or-stop-serve.json` → cleanup。

### Bridge 接口

```typescript
// core/machines/game/bridge.ts
interface GameBridge {
  sendEvent(event: string, input: any): boolean;
  onStateChange(cb: (state: GameState) => void): () => void;
  getState(): GameState;
  getMachineState(): string;
  reset(): void;
}

// createLocalBridge：在 bridge.ts 中实现，import machine.ts + fn.ts
// createWSBridge：浏览器端使用，连接 proof-or-stop serve 提供的 WS server
// createBridge：自动选择（检测 window.__PROOF_OR_STOP_WS_PORT）
```

### 三种运行模式

```
正式运行：   npm start / vite           → app.ts 里 LocalBridge 直连
开发调试：   proof-or-stop serve / proof-or-stop serve --dev="npx vite"   → core 进程 + WS bridge + Dashboard
             CLI/浏览器同时连同一个逻辑实例
纯浏览器：   vite build                 → LocalBridge 打包进浏览器
```

启动命令：

```bash
npm start                     # vite（Web 壳 + app.ts 浏览器内直连）
proof-or-stop serve                 # core + Dashboard
proof-or-stop serve --dev="npx vite"  # core + vite + Dashboard
proof-or-stop serve --port=N        # 显式端口（可选）
```

### 端口发现（多 worktree 安全）

端口基于 projectRoot 路径哈希自动分配，**不同 worktree / main 分支互不冲突**。

启动时自动写 `.proof-or-stop-serve.json` 到项目目录：

```json
{
  "pid": 12345,
  "wsPort": 14926,
  "api": "http://localhost:22845",
  "dashboard": "http://localhost:22845/"
}
```

**Claude Code 调试流程**：

1. 读 `.proof-or-stop-serve.json` → 拿到 `api` URL
2. 文件不存在或 pid 已死 → 先启动 `proof-or-stop serve`
3. 用读到的 URL 调 Bridge API / 打开 Dashboard

不需要记端口号。`.proof-or-stop-serve.json` 已加入 `.gitignore`，进程退出时自动清理。

### Core 完整性原则

**Core test 覆盖所有 transition，cli/web 按需。**

```
测试层次：
✓ 逻辑测试（白盒）   — fn.ts 纯函数，内存走 machine path
✓ core test（黑盒）  — 通过 bridge API 驱动，不经过壳，验证 guard/state 集成
✓ cli test（黑盒）   — spawn CLI 进程（按 shells 声明）
✓ browser test（黑盒）— 浏览器 + vite（按 shells 声明）
```

- core test 必须覆盖所有 machine transitions
- 如果某个功能 core test 跑不了 → 逻辑漏进了壳或 Bridge 接口没暴露完整
- validate 默认要求 core test 覆盖所有 transition，cli/web 覆盖按 `shells` 声明
- core test 不 spawn 进程，比 CLI/browser test 快

### UI 纯渲染规则

**UI 层禁止有业务状态。** 所有业务状态在 Bridge 这边，UI 纯渲染。

- 只通过 `bridge.sendEvent()` 触发动作
- 只通过 `bridge.onStateChange()` 接收状态
- 可以有纯 UI 状态（tooltip 显隐、动画帧），不允许管理业务状态
- validate 检查：shell 文件不 import fn.ts

### 调试 API（proof-or-stop serve 自动生成）

`proof-or-stop serve` 读取项目的 machine.ts，自动生成以下端点，**零配置**：

```
POST /bridge/event    { event: "move", input: { x: 1 } }   → sendEvent
GET  /bridge/state                                          → 当前 machine state + game state
GET  /bridge/events                                         → 所有合法 event 列表
POST /bridge/replay   [{ event: "start" }, { event: "move" }]  → 重置后批量重放
POST /bridge/reset                                          → 重置到初始状态
```

**反向控制 UI**：API 和 UI 点击走同一个 Bridge。curl 发事件 → UI 自动更新。事件源对 UI 透明。

典型调试流程：

```bash
# 启动（端口自动分配，写入 .proof-or-stop-serve.json）
proof-or-stop serve --dev="npx vite"

# 另一个终端，从发现文件读端口
API=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.proof-or-stop-serve.json','utf-8')).api)")
curl -X POST $API/bridge/event -d '{"event":"MOVE","input":{"row":7,"col":7}}'
curl $API/bridge/state
curl -X POST $API/bridge/replay -d '[{"event":"MOVE","input":{"row":7,"col":7}}]'
# 或直接打开 Dashboard URL（.proof-or-stop-serve.json 里的 dashboard 字段）
```

## Story 图谱（`proof-or-stop graph`）

交互式 story + evidence 图谱，读本仓 story 状态、建全文索引、起 HTTP 服务、开浏览器。
由 B-3e16 从独立仓 `proof-or-stop-graph` 迁入，行为与源仓一致（未重写 web shell）。

```bash
proof-or-stop graph                  # 默认端口 8731，自动开浏览器
proof-or-stop graph --port=9000      # 显式端口
proof-or-stop graph --no-open        # 不开浏览器
proof-or-stop graph --json           # 只打印状态 JSON 并退出（不起服务）
proof-or-stop graph --root=<dir>     # 指定仓库（默认从 cwd 向上找）
proof-or-stop graph --story=B-xxxx   # 直接打开该 story 的 dossier 详情页
```

| Flag | 含义 |
|---|---|
| `--root=<dir>` | 要读的仓库（默认：从 cwd 向上找最近的 Proof-or-Stop 根） |
| `--port=<n>` | HTTP 端口（默认 8731） |
| `--no-open` | 不启动浏览器 |
| `--json` | 打印状态 JSON 后退出，不起服务 |
| `--story=<id>` | 直接打开该 story 的 dossier 详情页（`/story/<id>`），而不是图谱首页。未知 id 在服务器 listen 之前就被拒绝，并列出相近候选（与 `--root` 的既有先例一致） |

页面提供 d3 图谱视图、FTS5 全文搜索、单 story detail drawer、mermaid 相位流程图，以及
timeline playback（含 MP4/GIF 导出，需 Chrome/Edge）。

**Story dossier（详情页）**：drawer 头部的 `open dossier` 按钮、或命令行 `--story=<id>`，打开
单个 story 的全窗口详情页——finding map、七相 lifecycle loop、依赖 web、checklist/outcome、
findings feed、dispatch swarm、pulse 图和 wire log。它有自己的 URL `/story/<id>`（与 `/` 同一个
server、同一份 app.html），可直接按路径打开、分享、用浏览器前进后退驱动。全部面板由客户端从
既有的 `/api/story` 明细派生，不新增服务端接口。

**worktree 优先级是关键**：从 PLAN 起 story 的实时产物在它自己的 linked worktree 里，主
checkout 只留 INIT_CHECK 快照。只读主 checkout 会把所有在飞 story 都报成 INIT_CHECK。

**不脏工作树**：Proof-or-Stop 的 DONE 门禁要求干净工作树，所以索引缓存放在用户 cache 目录
（按仓库根路径的 sha256 分目录），不写任何文件进被检查的仓库——因此它**不需要**
`runtime-artifact-registry` 条目（`serve` 需要，因为它往项目里写 `.proof-or-stop-serve.json`）。

**代码位置**：`packages/graph`（子包），`packages/main` 只有一个 thin handler 调它的
library surface（`createApp` / `startServer`）。`packages/graph/assets/` 是 gitignored 的
build 产物（`app.html` 由 `scripts/build-web.mjs` 组装，vendor bundle 从 node_modules 复制），
由 `npm --prefix packages/graph run build` 重新生成，**不入 git**。

**Node 版本**：全文索引用 `node:sqlite`，要求 Node ≥ 22.5（`packages/graph` 是本仓第一个
声明 `engines` 的包）。

设计决策真相源：`docs/requirements/decisions/graph-command-migration.md`。

## 目录结构

所有源码统一放在 `src/` 下。逻辑核心放 `core/`（平台无关），表现层放 `shells/`。

### 单模块项目

```
project/
├── src/
│   ├── core/
│   │   ├── app.ts                     # createApp()：bridge + IO 调度
│   │   ├── debug.ts                   # devHost() + 可选 CLI 壳（3 行模板）
│   │   ├── machines/
│   │   │   └── game/                  # Machine 模块（可多个）
│   │   │       ├── data.ts            # Data（纯类型/常量）
│   │   │       ├── machine.ts         # Machine（纯配置）
│   │   │       ├── fn.ts              # Fn（纯函数）
│   │   │       └── bridge.ts          # Bridge（LocalBridge + WSBridge）
│   │   └── io/                        # 纯 I/O（LLM 调用等）
│   │       └── ai.ts
│   ├── shells/
│   │   ├── cli/
│   │   │   └── main.ts               # CLI shell（纯表现，覆盖所有 transition）
│   │   └── web/
│   │       └── ui.ts                 # Browser shell（纯渲染，只通过 bridge 交互）
│   └── validate.ts                    # 验证汇总入口
├── index.html                         # Web 入口（引用 src/shells/web/ui.ts）
├── package.json
├── tsconfig.json
├── vite.config.ts
└── CLAUDE.md
```

### 多模块项目

```
project/
├── src/
│   ├── core/
│   │   ├── app.ts                     # createApp()
│   │   ├── debug.ts                   # devHost()
│   │   ├── machines/
│   │   │   ├── game/
│   │   │   │   ├── data.ts / machine.ts / fn.ts / bridge.ts
│   │   │   └── chat/
│   │   │       ├── data.ts / machine.ts / fn.ts / bridge.ts
│   │   └── io/                        # 纯 I/O
│   ├── shells/
│   │   ├── cli/main.ts
│   │   └── web/
│   │       ├── components/            # 纯 UI 元素
│   │       ├── pages/                 # 每个绑一个 bridge
│   │       └── hooks/                 # 框架适配（useGameBridge 等）
│   └── validate.ts                    # 汇总所有模块
├── index.html
└── CLAUDE.md
```

## Worktree 生命周期

每个 story 一个独立 worktree，互不干扰。这里的并行是 **本地 git worktree + 本地分支**，不是 GitHub/origin 分支；agent 不要创建或 push 远端 feature branch：

1. `story_create` → 停在 **INIT**（在 main 分支上写 story 文件；用户原话以 `request`/`requestFile` 逐字传入，写成 `request.md`，见下文「verbatim request」）
2. `story_advance INIT_CHECK` → 自动创建 `.worktrees/B-xxx/`，分支 `story/B-xxx`
3. **`cd .worktrees/B-xxx`**（必须切，否则 cwd 门禁拒绝）
4. `story_advance PLAN` → 正式进入开发流程
5. PLAN / DEV / TEST 全部在 worktree 里完成
6. `story_advance --phase=TEST` → 推进 TEST
7. `story_advance --phase=DONE` → 合并回本地 integration branch 并清理 worktree（可从 worktree 子目录触发，清理目标仍是 git 顶层 worktree）；如果需要远端发布，只在本地 integration branch（通常为 `main` 或 `master`）干净且已验证后，由人类显式运行 `proof-or-stop release_approve_push --confirm` 创建短 TTL 一次性 approval，再执行命令返回的 `git push`

**cwd 门禁**：PLAN 起所有 `story_advance` 都校验 cwd 是 story 的 worktree。

**远端写入纪律**：Proof-or-Stop 的 story 分支是本地实现细节，用于隔离 worktree 和 DONE merge；不要把 `story/*`、`codex/*`、`lab/*` 等任务分支推到 GitHub。并行任务完成后的收束路径是本地 merge integration branch + 清理 worktree，不是开远端 PR 分支。任何远端 publish 都默认被 `.githooks/pre-push` 拒绝；只有人类在干净本地 integration branch 上运行 `proof-or-stop release_approve_push --confirm` 后，hook 才允许一次 exact resolved branch + exact SHA 的 push。

**版本递增纪律**：每个会改变 Proof-or-Stop CLI / runtime 行为的 story 合并回本地 `main` 后，必须把 CLI patch 版本递增 1（例如 `0.3.6` → `0.3.7`），同步根目录 `package.json`、`packages/main/package.json`、对应 lockfiles 和 `packages/main/src/core/proof-or-stop-brand.ts` 中的 `PROOF_OR_STOP_CLI_VERSION`，运行 `npm --prefix packages/main run build`，并确认 `proof-or-stop --version` 输出新版本。纯文档、story metadata-only、review evidence-only 合并不强制 bump，避免无意义消耗版本号。

Use the atomic DONE/Lab version workflow to keep those inputs together. A compiled/runtime package mismatch now refuses CLI startup, including help and version; it is not only a doctor warning. If the source constant also disagrees with the runtime manifest, rebuilding alone cannot recover. See [CLI runtime synchronization](docs/cli-runtime-sync.md).

**Host DONE convergence / drift handling（DONE 收束纪律）**：并行 story 收束时按此操作，避免在 DONE 前反复撞。这是对既有机制的**投影**，规则源以下列决策文档为准、不在此重定义：`docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md`、`docs/requirements/decisions/story-files-hash-material-drift.md`、`docs/requirements/decisions/done-prepare-automation-execution-plan.md`、`docs/requirements/decisions/review-assurance-floor-execution-plan.md`，以及 `proof-or-stop done_prepare --help`。

1. **TEST→DONE 先 done_prepare，不要直接撞 `story_advance DONE`**：先运行 `proof-or-stop done_prepare --storyId=B-xxxx --mergeMain --refreshStale --validate`（会 merge main、安全 refresh stale evidence、validate，并聚合下一步 blocker）；只有 `DONE prepare: PASS` 后再 `proof-or-stop story_advance --phase=DONE`。
2. **Host 不自判 freshness**：读 `done_prepare` / freshness-reader 的分类结果，不要拿原始 hash 自己判 pass。
3. **headHash-only drift** 通常是 metadata / provenance 移动，**不是**强重跑信号。
4. **materialHash-only drift + storyFilesHash 不变**：unrelated whole-tree drift 候选（以下为当前 warn/advisory 投影，enforce 模式落地后可能收紧）：
   > materialHash-only drift with unchanged storyFilesHash is usually unrelated whole-tree drift. In current warn/advisory paths, Proof-or-Stop may downgrade this to re-attestation advisory instead of forcing full re-review/quorum. Host must follow done_prepare / freshness-reader output, not self-classify it as pass.
5. **storyFilesHash drift** 才是 story-owned material drift 的**强信号**：review pass / quorum / delivery 可能需要重新绑定（消费方不同：reviewer-pass 严格，floor / escalation / delivery-check 在 storyFilesHash 不变时降级接受）。
6. **done_prepare 不是万能豁免**：它能自动化 merge / refresh / validate / next-action，但**跳不过 related drift**——若 merge main 改到了当前 story-owned files（storyFilesHash 真变），仍需重 review / 重 quorum / 重 delivery。
7. **metadata-only dirty** 的处理：
   > Metadata-only dirty handling is governed by done_prepare/lifecycle_check; see B-9dfb once merged. Host must not manually bypass cleanTree.

**依赖准备（INIT_CHECK 后，F-003）**：git worktree **不**继承主仓 gitignored 的 `node_modules`，新 worktree 默认缺依赖，直接跑 tsc / `proof-or-stop validate` 会因解析不到模块而失败。worktree 创建时若缺依赖会输出告警：

```text
⚠ worktree 缺 node_modules: worktree 根
  缺依赖会导致 tsc / proof-or-stop validate 解析不到模块而失败。
  → 补救（推荐）：cd <worktree> && npm install
  → 高级可选：手动 symlink 主仓 node_modules 到此 worktree
```

- **首选补救**：`cd .worktrees/B-xxx && npm install`（monorepo 子包同理，按告警列出的缺失路径分别安装）。这是默认且唯一推荐路径——每个 worktree 拥有独立、隔离的依赖副本。
- **不默认 symlink**：框架**不**自动 symlink 主仓 `node_modules`（PLAN 决策）。手动 symlink 仅作为高级可选，且**会让多个 worktree 共享同一份可变依赖状态**——一个 worktree 里 `npm install` / 升级依赖会污染其它 worktree 与主仓，调试困难。仅在明确理解此风险、且磁盘 / 安装耗时是硬约束时才考虑，不要当默认做法。

**DONE 门禁**：进入 DONE 前要求 story 分支已包含 main 的所有提交（`git merge-base --is-ancestor`）。DONE 必须在期望的 `story/<storyId>` 分支对应 worktree 中执行；若 linked worktree 当前分支不匹配或不是 story 分支，CLI 会在写入 DONE 状态、merge、删除分支或清理 worktree 前拒绝。有冲突在 worktree 里 `git merge main` 解决。

**Sub agent 工作目录约定**：sub agent（proof-or-stop-implementer 等）在主 agent 的 worktree 中工作，通过 `proof-or-stop validate` 验证后提交。

### 多 session 写协调（设计真相源）

Proof-or-Stop 支持多 worktree 并行，写权限的跨 session 协调按 rollout 分步落地。**main write lock（rollout step 3）已实现（B-f60c）**：`core/main-write-lock.ts` 统一锁，canonical 路径 `.proof-or-stop/locks/main-write.lock/`，DONE / done_recover / gap_log / audit / story_create / B-META finding 写均持锁，锁内强制 idempotency，doctor 有 stuck-lock 检查。**story owner lease（rollout step 2）已实现（B-c55d）**：`core/story-owner-lease.ts` 的 per-story owner lease + `cli-engine.ts` 的单一 choke-point gate `enforceStoryOwnerLeaseGate`（按 `CommandPolicy.ownershipClass` 分类，非 owner 的 story-scoped / dangerous 变更命令被拒绝）、stale-lease 检测 + `--takeover` / `--forceTakeover`、ownership-aware 拒绝错误、`session_brief` ownership 渲染（`renderOwnershipBlock`），以及 `proof-or-stop doctor` 的 stale story-owner-lease 检查。rollout step 1-6 已全部完成（B-8596 / B-f60c / B-c55d），其中 step 5（stuck-lock + stale story-owner-lease 检查）与 step 6（多 session 收敛 / 回归 smoke）由 B-c55d 收口。设计真相源：`docs/requirements/decisions/session-ownership-and-write-leases.md`。涉及并行开发、写协调或 DONE / main / B-META 写入语义时以该文档为准。

## Checklist 写法

```json
{
  "title": "做什么（一句话）",
  "context": "根因/参考方案",
  "userSees": "用户看到 \"✓ 文件已创建: hello.txt\" 然后返回提示符",
  "relatedDocs": ["requirements/foo.md", "CLAUDE.md#section"]
}
```

- title 描述「做什么」，不描述「怎么做」
- context 给执行 agent 提供决策上下文
- **userSees**：用户完成此 item 后看到的具体文本（必须含精确输出，不能是"功能正常"这类抽象描述）
  - `dispatch`（itemId 的 implementer prompt，以及 findingId 的 finding-repair prompt：finding desc 点名的 CHK-NNN 或 files 与 finding 重叠的 item）会把精确字符串逐字放进 "Exact required output — must match byte-for-byte" 段：userSees 与 verificationIntent desc 里的 `反引号` / "双引号" 字面量（含空格、`:` 或 `=`）、``` 代码块里的输出行（`$ ` / `> ` 开头的命令行除外），以及 cli/browser/manual intent 的 pinned 输出 selector。只摘字面量，不改写不补造；最多 24 条 / 4000 字符，超出注明省略条数。所以精确报错文本要用引号或反引号写进 userSees / intent desc。
- **relatedDocs**：关联文档路径数组，触发三次提醒

### relatedDocs 三次提醒（软提醒，不阻塞）

1. **PLAN→DEV 推进时**：列出全部 relatedDocs 去重清单
2. **`checklist_update` 标 done 时**：列出该 item 的关联文档
3. **DONE 推进时**：列出 `git diff main...HEAD` 没出现过的文档

### English authoring and legacy relatedDocs recovery

English-artifact gates scan all recursively scanned string leaves of story metadata. The listed examples (`excludes`, `files`, `reason`, `verificationEvidence`) are non-exhaustive. Recover leftover CJK in relatedDocs and other leaves before REVIEW→TEST. Captured program output is not authored text and is exempt (verification `outputTail` / `stdout` / `stderr` / `output` / `observedOutput`, the summary's observed `actualTranscript`; old-PoS runs 20 and 25: `go test -v` of the task's own Unicode tests). Never edit source or tests to satisfy this gate: each refusal names the framework command that rewrites the authored text (`checklist_update`, `summary_set`, `background_set`, ...) and the code points (`U+XXXX`) to quote a required non-English literal by.

## PLAN 阶段产物

### understanding_set（理解快照）

| 字段 | 含义 |
|---|---|
| `task` | 一句话描述要解决的问题（≥ 5 字符） |
| `outcome` | 完成后能观察到什么变化（≥ 5 字符） |
| `facts` | 已知事实 |
| `constraints` | 必须遵守的规则 |
| `unknowns` | 还没想清楚的问题（非空时建议先调研再拆 checklist） |
| `touchpoints` | 可能受影响的代码文件（可写自由文本，如 "ast/ast.go IndexExpression and String" 或逗号列表；candidate routing 只把能解析成真实文件的开头路径 token 当 protected source，其余只做排序种子，run 17） |

### decision_set（结构化决策）

```json
{
  "principles": [".."],
  "drivers": [".."],
  "options": [
    {"name": "A", "pros": [".."], "cons": [".."]},
    {"name": "B", "pros": [".."], "cons": [".."]}
  ],
  "chosen": "A",
  "rationale": "选 A 因为...",
  "preMortem": [{"scenario":"..","trigger":"..","consequence":"..","mitigation":".."}]
}
```

校验规则：principles 3-5 条 / options ≥ 2 / chosen ∈ options / rationale ≥ 10 字符。
高风险 story（riskSignals 非空）：preMortem ≥ 3 条。

### plan.md（执行计划）

正常通道必须在 checklist 拆完后、`story_review` 之前产出 plan.md。快速通道可省略。

**plan.md 是执行手册，checklist 是任务真相源。** plan.md 描述"怎么执行最稳"，checklist 决定"有没有完成"。

模板（按 CHK-xxx 组织，每个 item 一个章节）：

```markdown
# Plan: B-xxxx <story title>

## CHK-001: <checklist item title>

**Owner**: proof-or-stop-implementer | main-agent
**DependsOn**: none | CHK-002, CHK-003
**Files**:
- Modify: src/foo.ts, src/bar.ts
- Create: src/baz.ts
- Test: tests/foo.test.ts

**Verify**:
- `proof-or-stop validate` 全绿
- `npx tsx src/main.ts` 输出含 "xxx"

**DoneWhen**:
- foo 函数处理 edge case 返回 null
- 测试覆盖 happy path + error path

## CHK-002: ...
```

字段说明：

| 字段 | 必填 | 含义 |
|---|---|---|
| Owner | 是 | 谁执行：proof-or-stop-implementer（正常通道）或 main-agent（快速通道/文档类） |
| DependsOn | 是 | 依赖哪些 CHK-xxx 先完成，none 表示无依赖 |
| Files | 是 | 要改/建/测的文件路径 |
| Verify | 是 | 验证命令和期望输出 |
| DoneWhen | 是 | 完成判定条件（具体、可检查） |

**存储位置**：由 `proof-or-stop.config.json` 的 `storyDir` 决定（本仓库为 `.proof-or-stop/story/actives/B-xxxx/plan.md`），和 understanding.json / decision.json / checklist.json 同级。读取必须使用 `proof-or-stop plan_get '{"storyId":"B-xxxx"}'`；写入必须使用 `proof-or-stop plan_set` 并按 `proof-or-stop plan_set --help` 传参，禁止直接读取或编辑 StoryStore 文件。

规则：
- 每个 checklist item 都必须有对应章节，不允许孤儿章节
- DependsOn 不能有环
- DEV 阶段主 agent 按 plan.md 分配任务，不自由发挥
- DEV 开始后 plan.md 默认冻结；如需修改须在 commit message 里说明理由

### INIT→INIT_CHECK 硬门槛（B-e71f）

**触发**：所有 INIT → INIT_CHECK 转换（`story_advance INIT_CHECK`）。其他来源（IDEA→INIT_CHECK 等）不门禁。

**机制**：`story_create` 完成后停在 INIT 阶段。主 agent 分别以 `host_run ... "managedDispatch":true` 启动两个 reviewer；PoS 从 canonical `dispatch` envelope 派生 prompt，通过受控 provider stdin 交付，并返回非空 runId。reviewer 在该 live provider process group 内调用 `init_check_set`。每条结果写入 `deliveryRunId`，`story_advance INIT_CHECK` 在 xstate guard `canEnterInitCheck` + `getGuardFailureReason` 中重新校验完成态 receipt。

**签名域**（真相源是 [init-check-gate.ts](packages/main/src/core/init-check-gate.ts) 的 `INIT_CHECK_SIGNATURE_DOMAIN`；`describeInitCheckSignatureDomain()` 渲染当前列表，别照抄下面这行）：

```
sha256(`${storyId}:${sha256(background.md)}:${title}:${description}:${sha256(checklist.items[*].{title,context})}:${reviewRound}:${verdictHash}:proof-or-stop-init-check-integrity-v1`)
```

`verdictHash`（B-8df9 CHK-002 加入）= `computeInitCheckVerdictHash` 对 gate 实际判定的两个字段的摘要：`agentResults`（`missingRequiredInitCheckAgents` 读）和 `issues`（`blockingInitCheckIssues` 读）。**加入前 reviewer 结论本身不在签名域内**——手改 `agentResults` 注入一个从没跑过的 reviewer、或删掉一条 critical issue，签名照样有效、gate 照样放行。

**这个属性的边界**：`INIT_CHECK_SALT` 是导出的源码常量，`signInitCheck` 也是导出函数——能改文件的人就能用产品自己的函数重新签名并通过 gate。所以签名域买到的是 **tamper-evidence**（挡住误改、损坏、不重签的手改），**不是**「reviewer 覆盖可信」，也挡不住蓄意行为者。任何暗示 reviewer 覆盖因此变可信的表述都是错的。

**Blocker 类型**（[guard-utils.ts](packages/main/src/core/guard-utils.ts) INIT_CHECK 分支）：

- `[missing_init_check]` — init-check.json 不存在（reviewer 没跑或没调 init_check_set）
- `[init_check_tampered]` — `_hash` 与重算结果不符（签名域内任一组件改了：background / title / description / checklist / reviewRound / reviewer verdict）。注意 `recomputeInitCheckHash` 是对 story **当前**内容重算的，而 story 内容在 PLAN/DEV 会正常演进——所以 INIT 之后 `_hash` 失配是**预期常态**，不是损坏；gate 只在 phase === `INIT` 时读它，其他 phase 直接 early-return
- `[missing_init_check_agent]` — 必需 reviewer 没有记录结果
- `[delivery_not_acknowledged]` — reviewer 结果没有匹配的受控派发、完成态 receipt 或 Story/role 绑定
- `[init_check_blocking_issues]` — init-check.json 中存在适用于 INIT、且 kind 属于提交 reviewer 的允许集合、requirementRef 精确指向权威 INIT 输入的 critical/high issue；`kind: post_implementation_evidence_missing` 会延后到实现后的验证阶段

**issues gate**：`init-check.json` 中适用于 INIT 的 critical/high issues 只有在 kind 属于提交 reviewer 的角色允许集合、且 requirementRef 精确解析到 Story/checklist/verification intent/scope/execution/repository guide 的权威 INIT 输入时才会阻塞 INIT_CHECK。新提交的 kind 缺失、越权 kind 或无效 requirementRef 会被 handler 规范化为 medium advisory，并保留 `reportedSeverity` 与 `dispositionReason`；已持久化且签名有效的旧版 kind-less high 记录在该 reviewer lane 重写前仍按旧语义 fail-closed。`kind: post_implementation_evidence_missing` 表示只有实现后才能取得的证据，在 INIT 中延后且不阻塞；其他 medium/low 为 advisory。Reviewer 无论 pass/fail 都必须调用 `init_check_set` 记录结果。

**存量语料迁移立场**：不迁移，接受失效——理由和重新测得的计数见 `docs/requirements/decisions/story-lifecycle.md` 的「init-check signature domain widened to the reviewer verdict — migration position」节。

**Causal identity v2 存量立场**：`ce:v1:*` 只保留为历史审计记录，不迁移、不复用为当前 PASS；当前证据必须通过正式 evidence 命令重新执行获得。设计理由、2026-09-14 语料计数和操作步骤见 `docs/requirements/decisions/story-lifecycle.md` 的「Causal execution identity v2 migration position」节。

**反自豁免设计**：EXP-001 证明裸 Bash actor label 不能证明 subagent 独立性。当前 `init_check_set` 拒绝 payload/omitted identity，并要求当前 CLI 进程属于唯一 live `managed_dispatch` provider group；gate 随后校验 digest-bound terminal receipt。裸 `agentId`、手工设置 `PROOF_OR_STOP_AGENT` 或伪造 `deliveryRunId` 都不能满足 required reviewer lane。

**调用模板**：

```bash
# owner 启动；保留两个不同的非空 runId，并用 host_run_status 做有界等待
proof-or-stop host_run '{"host":"codex","storyId":"B-xxx","agentType":"proof-or-stop-review-story-init","managedDispatch":true,"detach":true,"json":true}'
proof-or-stop host_run '{"host":"codex","storyId":"B-xxx","agentType":"proof-or-stop-product-reviewer","managedDispatch":true,"detach":true,"json":true}'
```

**无 subagent 环境的受控 fallback（B-95d8 CHK-001）**：

某些环境（CI sandbox、无 subagent 能力的 runner）根本无法 spawn INIT reviewer，此前没有合法出口、story 永久卡在 `[missing_init_check]`。`proof-or-stop init_check_repair` 提供一条**显式、可审计、不削弱签名**的 fallback：

```bash
proof-or-stop init_check_repair '{
  "storyId":"B-xxx",
  "acknowledge":true,
  "fallbackReason":"为何 INIT reviewer 无法运行 + 你人工核查了什么（≥30 字符，作为 durable 审计 attestation）",
  "mode":"repair",            // 可选，默认 repair；fallback/repair 语义等价仅审计分类
  "evidenceRefs":["..."],     // 可选，人工核查依据
  "issues":[]                 // 可选；适用于 INIT 的 high/critical 仍阻塞，post_implementation_evidence_missing 延后
}'
```

设计约束（与上面反自豁免架构一致）：

- **默认禁用**：缺 `acknowledge:true` 或 `fallbackReason` < 30 字符 → 拒绝、不产出文件、不改 phase。
- **不绕过签名**：复用同一 `signInitCheck`，跟普通 `init_check_set` 用**同一个**签名域，fallback 不因此签得更弱。B-8df9 CHK-002 后该域已包含 reviewer verdict（`agentResults` + `issues`），事后改任一签名内容仍触发 `[init_check_tampered]`；域的当前列表以 `describeInitCheckSignatureDomain()` 为准。
- **No reviewer-coverage relaxation**: `initCheckAgentMatches` accepts only byte-exact `<required>` or `<required>@fallback`, rejects `<required>@operator` and `<required>@fallback-extra`; recording fallback agentResults as `<required>@fallback` satisfies required reviewer coverage while remaining mechanically distinguishable from independent reviewers. Human-attested high/critical issues that apply to INIT still block through `blockingInitCheckIssues`; `kind: post_implementation_evidence_missing` follows the same explicit phase deferral as the independent-review path.
- **严格校验 agentId，但不把它误当调用方身份证明**：writer 只接受已注册的 byte-exact canonical INIT reviewer identity；EXP-001 仍说明 shell 调用方身份本身不能仅靠 `agentId` 机械证明。
- **可审计**：写 `init-check.json.fallback` 块（mode/reason/evidenceRefs/actor/session/attestedAt/headHash/materialHash）+ `init_check_fallback` process event。`proof-or-stop story_get` 返回 `initCheckAttestation: "fallback" | "independent"` 与 `initCheckFallback` 块，dashboard/report 据此把人工 fallback 与独立 reviewer 区分开。

`[missing_init_check]` / `[missing_init_check_agent]` 诊断信息会同时列出缺失的必需 reviewer、fallback 是否可用、以及 `init_check_repair` 的精确命令形态。

### story_create 前置 draft gate

B-9975 引入 `story_draft` + `story_create --from-draft` 两阶段创建流程。与 B-e71f `init-check.json` 架构同构（同签名结构 + reviewer subagent + 反自豁免设计），区别在 gate 点更前——物化动作本身。

#### 签名结构

`draft-check.json` 签名域：`draftName:backgroundHash:title:description:checklistHash:reviewRound:DRAFT_CHECK_SALT`

不入签名域（反自豁免）：`resolutions`、`agentId`、`checkedAt`

#### 三层 gate blocker

| blocker | 触发条件 | 消解方式 |
|---|---|---|
| `missing_draft_check` | `draft-check.json` 不存在 | spawn reviewer 调 `draft_check_set` |
| `draft_check_tampered` | 重算 `_hash` 与存储值不匹配 | 重跑 reviewer（draft 内容已变） |
| `draft_check_blocking_issues` | critical/high issue 未 resolve | `draft_issue_resolve` 逐条响应 |

#### 反自豁免设计

- `resolutions` 字段不入 `_hash` 签名域（主 agent 写 resolution 不触发签名失配）
- Reviewer 签名覆盖 background + title + description + checklist（主 agent 改内容 → 签名失配 → 强制重审）
- medium/low severity 不阻塞物化（advisory 模式）

see story/B-9975

### scope-plan reviewer PLAN→DEV 硬门槛

正常通道 PLAN 阶段必须跑 `proof-or-stop-review-scope-plan` 产出 `scope-check.json`。是否必需由 `core/plan-scope-check-requirement.ts` 一处判定（`story_review`、DEV 入口 gate、`next` 共用）：

- checklist 非空，且满足任一：存在 `understanding`；policy `plan.requireUnderstanding: 'always'`（balanced、strict）；`'high_risk'` 且 Story 高风险；存在 `request.md` 且 policy 不是 `'never'`。此时 `scope-check.json` 缺失 → `story_review` 报 `missing_scope_check` **blocker**；DEV 入口 gate 本身也拒绝（`[missing_scope_check]`，最后一行唯一 `Next:` 是 managed scope-plan reviewer 的 `host_run`），即使最近一次 `story_review` 记录是干净的
  - 例外（仅在 A/B 开关 `plan.scopeDeferral=on` 时；old-PoS run 33 起默认 off：DEV 入口在 PLAN 里等 live run 的裁决）（v4.1 N8，`core/scope-plan-deferral.ts`）：裁决缺失但 PLAN 里启动的 managed scope-plan run 仍在跑、且 reviewer 没有 pin audit 要做时（没有 intent 钉住 request.md 未原文引用的期望值，request 也没有 "same ... semantics as" / "works like" / "consistent with" 句；否则 DEV 入口等这个 run 的裁决，`scopeVerdictDeferral` = held，pin-audit gap 在任何 item 按错 pin 实现之前出现），`story_review` 只报 advisory `scope_check_pending`，DEV 入口放行，第一个 implementer 与 reviewer 并行；该 run 在 DEV 里保存裁决（run 33 前 CLI phase gate 的 `DEFAULT_PHASE_TOOLS.DEV` 缺 `scope_check_save`，真实 Story worktree 里这次保存都被拒；已修，smoke 现从 Story 分支保存；`scope_check_save` 在 DEV 只接受这个 run 的 managed invocation，candidate 绑定按它启动时的 commit 校验），DEV→REVIEW 要求裁决存在、签名与交付有效、无 gap（`[scope_check_pending]` / `[scope_gap]`），DEV 中发现的 gap 由 `next` 送回 PLAN（`scope_verdict_replan`）
  - 不再依赖 `understanding_set`（run 16：owner 没调这个 advisory，PLAN 只跑了 `story_review` 就进了 DEV，没有 scope-plan reviewer；修复 lab `scope-check-required`）。`next` 在 PLAN 里（dev-memory ack 之后）先把确定性 PLAN blocker 作为一个 `plan_authoring` batch 给出（run 19 P1：每个 item 一条精确 `checklist_update`（lab initplan 起是 `intentRows` 行补丁，只改列出的行、追加新行），覆盖缺失的 intent lane、未 pin 的 intent、缺失的 userSees、缺少有效 `derivation` 的例子、以及没有任何 item 写出 / excludes 点名的 request 字面量），这些清零后才启动这个 reviewer（沿用 owner 自己的 host/model），reviewer 只在最终 checklist 上跑一次；run 进行中时给 `host_run_status --untilTerminal`。light（`'never'`）和 express 通道不变
  - 已有裁决需要重跑（有 gap 且裁决后 checklist 改过，或 reviewRound 过期；`scopePlanRerunReason`）时，`next` 直接给出 reviewer 重新启动（run 19 P2），不再把 owner 送回 `story_review`；selection 已绑定且上一次 run 完成并交付了这个过期裁决时是 framework 步骤
  - reviewer 的 dispatch prompt 只在 `understanding.json` 存在时读它
  - DEV 入口 gate 因 `story_review` 无记录或有 blocker 拒绝时，最后一行是 `Next: proof-or-stop story_review --storyId=<id>`
- 有可执行 must/should intent 没有 `verification:{command,selector}` → `missing_verification_pin` **blocker**（见「证据链检查」一节）
- 已有 scope-check.json 但签名失效 / review round 过期 → 要求重跑
- 有未消解 gap / excluded 无证据 / orphan-suspect → blocker
- 有未 resolved OpenQuestion → blocker（见下节）

即「PLAN 完成标志 = `scope-check.json` 存在且所有通道均已清账」。

**PLAN 内的排除声明（run 15 修复）**：PLAN 门槛要求的每一项排除都在 PLAN 内完成，绝不需要回 INIT 改 scope boundary（`scope_boundary_set` 仍然只限 INIT，也不是这些门槛检查的输入；scope-plan reviewer 的 prompt 只把它的 excluded 列为「已确认约束」，见下文 run 17）。
- `touchpoint_uncovered`：touchpoint 要么在某个 item 的 `files.modify/create/test` 里，要么被某个 item 的 `excludes` 条目**写出确切路径并给出理由**（如 `"docs/x.md: reference only, not changed"`）；只写路径不算。动作：`proof-or-stop checklist_update --storyId=<id> --itemId=<CHK> --excludes='[...现有 excludes, "<path>: <理由>"]'`。
- `scope_gap`：是 scope-plan reviewer 签名的裁决，`story_review` 不会自己重判。修法：在 checklist item 里覆盖它，或对仅供参考的材料 / 已确认的约束（「do not …」句）在某 item 的 `excludes` 追加写明该点和理由的条目（`pin-audit` / `asymmetric-example` gap 则改 intent 行本身）；然后运行 `proof-or-stop next --storyId=<id> --run`：它在最终 checklist 上重跑一次 scope-plan reviewer 并重跑 story_review（old-PoS run 40 之前提示给的是 owner 手动执行的 managed `host_run` 命令）。`scope_check_save` 记录 reviewer 当时可见 checklist 的 `checklistDigest`（仅用于提示措辞，不在签名域内）；checklist 在裁决后已改动时，提示只给一个动作：这次重跑，`next` 也直接给出这次重跑。最新 story_review 轮次是当前的且有 blocker 时，`next` 给 `plan_review_blockers`：列出 blocker 和唯一的 `next --run`，不再让 owner 手动跑 `story_review`。brief 版 `story_review` 永不截断 issue 的 `Next` 补救文本（相同补救只打印一次，后续写 `Next: same as above.`）。

### verbatim request（request.md）与 PLAN 追溯

- `story_create` 接收 `request`（或 `requestFile`）：用户请求**原文**，不是转述；通用用户场景要向用户索取原话。写入 Story 目录 `request.md`（上限 16 KB，超出带显式截断标记），`request.json` 记 sha256 / 来源 / amendments；`request.md` 进入 INIT_CHECK 签名域（无 request.md 的 Story 哈希不变）。
- `story_request_set`：无 `storyId` 时暂存到 `.proof-or-stop/runtime/staged-story-request.md`，下一次 `story_create` 消费一次（benchmark adapter 用这条路记录任务原文）；有 `storyId` 时记录/修订，仅限 IDEA/INIT/INIT_CHECK/PLAN，替换已有原文或 INIT 之后首次记录都必须带 `amendmentReason`（≥30 字符）。手改 request.md 会被识别为与 request.json 不符、不作为权威输入。
- scope-plan reviewer 的 dispatch prompt 内联 request 原文：每个规范性句子、每个「for example」、每个枚举变体集都是独立 feature 行，只有某条 `userSees`/`verificationIntent` 写出该确切变体或确切输出才算 covered，否则是 gap；另附机械预检：request 中反引号字面量没有出现在任何 checklist title/userSees/verificationIntent 里的逐个列出；以及 pin audit 与 same-semantics 规则（见下文「钉住值的推导」）。
- `story_create` / `story_request_set` 同样列出这些未写出的字面量，并给每个 item 一条精确的 `checklist_update '{"storyId":...,"itemId":"CHK-xxx","userSees":"<...>"}'`：userSees（和 verificationIntent 一样）在 INIT 和 PLAN 可改、DEV 起冻结（例外：review 要求的 Story 元数据更正，`metadataCorrection: true`，见「Story 元数据 finding」），所以在同一个 Story 上补上即可，绝不需要重建 Story（run 18 曾因此重建）。PLAN 里仍未写出（也没被 excludes 点名）的字面量由 `next` 的 pre-scope `plan_authoring` 步骤列出。
- `story_create` 对入口 intent 执行与 PLAN 相同的 metadata 规则（`core/verification-intent-classification.ts`）：每行 `verificationIntent` 必须带 `scope`/`expectation`/`requirementSource`，否则 `story_create REFUSED, nothing was written ... [verification_intent_metadata_required]`，逐行写出缺的字段（如 `CHK-001:happy:0 (missing requirementSource)`）并给一行可复制的已分类 row；`checklist_update`（verification-intent 角色、owner proposal）与 `plan_acceptance_*` 的拒绝文本相同（run 19：第一批 intent 因缺 requirementSource 被拒，owner 脚本只打 stdout 没看到）。
- **old-PoS run 34 的确定性收尾**：`story_create` 被拒时一次列出所有 item 的所有未分类行与未推导行，把提交的 payload 暂存到 `.proof-or-stop/runtime/story-create/payload.json`，唯一 `Next:` 是「只改列出的行，再 `proof-or-stop story_create @<该文件>`」（run 34 每被拒一层就重发 14-17k token 的整份 payload）。exact-text 覆盖行若已带字符串但没写精确比较，gap 会点名该行、原因与可接受的写法（exact / equals / whole error / ==），不用读框架源码。pin audit 的确定性检查按 token 边界比较（单字符值不再在 `"abcdef"` 里误配而回退到重跑 scope-plan）。DEV guard 的 why 不再是空的「Cannot enter DEV:」；`story_review` 轮次旧于其输入时由 `next` 作为 framework step 重跑（`story_review_rerun`）。
- **old-PoS run 40**：参数校验拒绝（如行 `type` 不在 `logic|cli|browser|manual|docs` 内，story_create 模板 step 的 why 现在列出这些值）也暂存 payload，唯一 `Next:` 同上；exact-text 门按行、按操作数归因（只有 prefix / contains 调用的操作数就是期望文本时才算；同一测试函数里用精确类型值或自己的 table loop / keyed field 精确比较的行不算 gap；对期望文本做相等比较、再对位置行做 prefix 检查的 helper 算精确），reopen 与 implementer 重启都是 `next --run` 的 framework step；delivery reviewer prompt 带本 Story 的 `delivery_check_set` 骨架和四个 canonical report 命令（只读命令，不是文件）；`quorum_submit --singleHost` 遇到其它 framework writer 在提交窗口内追加 process-events 导致的整批回滚时，等 Story 元数据干净后重做（最多 2 次，最多等 20 s；3x2 quorum 仍 fail-closed）。
- **old-PoS run 43（两个检测开关原默认 on，`off` 为回滚并记入 `abVariantEvidence`；畸形值保持默认。old-PoS run 58 起 `review.siblingParity` 默认 off，`on` 为记录的 A/B arm：开启时 run 46/47/58 用时 131 min / 超时 / 超时，而 run 58 里单靠 `plan.baseDisagreement` 就钉住了 run 43/46 漏掉的单下标写）**：(1) `review.siblingParity`：test-coverage 与 quality lane 的 dispatch prompt 带 sibling-parity 检查（`core/sibling-parity.ts`）——diff 新增或改动的每个入口，找出它的 sibling 路径（同一数据的对应读/写、其它 receiver 类型上的同一操作、原有变体，含未改动文件），对 sibling 特判的每类操作数（越界、符号、空、null/省略、类型）在两边各跑至少一个探针，request 与 checklist 都没写明的差异是 finding（category edge，至少 medium），pass note 列出探过的配对；(2) `plan.exclusionRationaleCheck`（`core/scope-exclusion-rationale.ts`）：scope-plan 行所指行为若被本 Story 另一个 item 新增或改动（item 的 title / userSees / modify·create 文件名与该行的内容词至少共享 2 个且 ≥60%），excludes 不能关闭它：`scope_check_save` 拒绝这种 `excluded` 行（`[scope_exclusion_contradicted]`，应存为点名该 item 的 gap，或有行写明时存 covered），`story_review` 对早先存下的此类裁决给唯一 `Next:`（给该 item 加覆盖行、删掉那条 excludes，再 `next --run`），普通 `scope_gap` 若所指行为被某 item 改动则补救语点名该 item、不再提供 excludes 出路；scope-plan dispatch 带一行 `Exclusion check`。另：exact-text 门把对实际文本「切下一段、丢弃其余」的相等比较（`strings.SplitN(x, sep, 2)[0]` 等 split 下标、内联或经变量、`strings.Cut` 头、first-line helper、`expect(<cut>).toBe(...)`）也算 prefix 比较（无开关）；整份 split 存进变量且其它部分或长度也被检查时仍算精确。
- **old-PoS run 44（全部 detection-neutral，无开关）**：(1) 纯文本元数据更正不再使本轮 lane 证据失效：每次已应用的更正记 `metadata_correction_applied`（userSees 改前/改后文本，intent 行只记 hash），证据校验按检查点回退 userSees 重放更正前的 envelope，不需要抽出 reviewer 的值；intent 行（钉住的期望值）更正与其它改动照样失效。被引用的短字面量（如 `"x"`）扩成字段里包住它的陈述（反引号片段或所在短句），reviewer 句子只在该槽位不同即为更正值；仍在期望侧写着已应用更正之错误字面量的 intent 行成为待办的 intent 行更正。(2) REVIEW 没有循环指针：REVIEW→DEV 只因本轮缺 remediation receipt 被拒且本轮没有活着的 epoch 时，`next` 给 `inventory_begin`（`reviewDevHop`）；只因 taskSemanticDigest 失效的 open finding 像 stale_run 一样被带上；remediation gate 与已消费 receipt 的 Next 都是 `next --run`；同一目标的 ReviewRun 仍活着（无证据、未启动或仍在跑）时再 `review_run_start` 被拒（`[review_run_live]`，唯一 Next `next --run`）。(3) `metadata_correction_plan` 是 framework step（REVIEW→DEV→PLAN，一次 `next --run`），REVIEW 里 intent 行更正的拒绝指向 `next --run`。(4) finding-repair prompt 要求 grep 同一代码路径修整个缺陷族（每种 receiver/目标/操作数形态，含嵌套与计算出的），最终报告每个形态一行 `[family] ...`。(5) duplicate 的 duplicate 在同一 batch 里对整条链的已 resolve 根关闭（`duplicateRootOf`）。(6) exact-text 门：对「返回其参数一段切片」的测试 helper 的调用结果做相等比较算 prefix 比较（与 helper 名无关）。测试：`run44-fixes-smoke`（M1-M5、X4/X5、D、R），harness NMS / NMD / NMP。
- **old-PoS run 46/47/55（lab `codex/lab-run46-fixes`）**：(1) `review.siblingParity` 改为排序 oracle：请求句或 checklist 行优先，否则以**同一 receiver 已有的对偶操作**（新写对应它的读）为主参照，其它 receiver 的同名操作只是次参照；新路径与主参照不同才是 finding；主次参照在 base 里本就不一致时不是新路径的缺陷，只报一条 `[precedent-conflict]` 问题，绝不要求向次参照对齐；每条 finding 写 `Repro:`。(2) 新开关 `plan.baseDisagreement`（默认 on，`off` 回滚并记入证据）：scope-plan dispatch 多一行 Base-disagreement check，对每个新操作在 base 上探测其先例，请求与 checklist 都没定的分歧存为 `Precedent conflict:` gap，补救是钉住哪个先例的 covering row，不能 excludes。(3) 已 resolve finding 回归守卫（无开关）：repair 被接受时，凡引用文件自其 resolve 以来变过的已 resolve finding，按 resolve 时记录的测试源（临时 detached worktree 恢复当时的测试文件）重跑其覆盖测试；失败则拒收碰过这些文件的 repair（其提交按「无 repair 提交」计：重启一次后回 PLAN），并开一条 `[regression-of <id>]` finding（ledger 每条 finding 只允许一个终态迁移，所以 reopen = 新的 open finding）；事件 `resolved_finding_guard_checked`。(4) duplicate 关闭要求 canonical 的修复仍 live（repair 的非测试 hunk 未被后续提交改写，或其记录的覆盖测试现在仍通过；run-44 的链根路径同样检查）且 coverage 跑到该 duplicate 自己的 repro；拒绝记为失败的 coverage run，`next` 改派它自己的 repair。(5) REVIEW lane prompt 列出带 repro 的已 resolve finding，要求重跑而不是信 `resolved`，失败报 `[regression-of <id>]`。(6) finding 冲突（`[precedent-conflict]`、被守卫拒收的 repair、或在同一 case 上重判已 resolve finding 而不声称回归）不派 repair，`next` 给 owner 一步 `finding_conflict_pin`（回 PLAN 钉住），钉住后按钉子修。(7) repair prompt 列出同文件的已 resolve finding（不要反转）、被拒的 repair、并说明新增的失败测试是产品缺陷的证据，绝不删除或削弱；repair 自己的提交删掉本次新加的测试、或删掉跑该 finding repro 的测试行，则不算 repair（run 55）。(8) 活着的 managed writer 把 Story worktree 置为 detached 时，controller projection 复用现有投影而不是拒绝（run 47 §3.4）。未实现：run 47 §7 第 3 条「同 material 不开空转轮」——lane 证据绑定在 inventory wave 上，在 REVIEW 内关闭 finding 会使同一轮的 lane 重跑（harness 试验 83 次 lane 运行的循环）；run 47 的空转轮由 (4)(6) 消除。测试：`run46-fixes-smoke`（S、B、G1/G2、R、D1-D5、C1/C2、W、T1/T2、L），harness NRG。回滚：`POS_AB_FLAGS='{"review.siblingParity":"off","plan.baseDisagreement":"off"}'`。
- **old-PoS run 58（lab `codex/lab-run58-fixes`，无开关）**：(A) 回归守卫只跑 finding 自己 repro 的测试行（`filterGoTestRows`：修复提交改过的 Go 测试函数里写出该 repro 的函数，表驱动测试里只留写出 repro 的行；finding 没写 repro 或测试里找不到时才跑整个函数，事件记 `scope`）；(B) 定罪前先看当前 checklist 对该 case 的 pin（pin 的值记录的测试行里没有 → `excused: checklist_pin`）和 Story base（无 pin 时在 base 的临时 worktree 上跑同一份记录测试，失败行与当前代码完全相同即代码保持 base 行为 → `excused: story_base`；base 编译不了的新行为测试永不豁免）；(C) checklist epoch：resolve 之后该 case 的行被改成记录测试没写的值 → 守卫退役（`resolved_finding_guard_retired`）；(D) PLAN 改 done item 的 intent 时先跑其行的 pinned test（`verification` command + selector），全过且新改的行都被一个 pinned test 写出 case 与值 → 保持 done（`status kept done`），依赖它的 done item 同理（仅当被改的 item 自己保持 done，否则依赖项照旧 pending），否则才 pending；(E) DEV 之后（process events 里有到 DEV 的 phase_transition；story events 里的 DEV 不算，被拒的 DEV 入口也会留下它）回 PLAN 时改动已有行钉住的值必须在该行写 `re-pin: <case> was <old>, now <new>`，否则拒绝 `[pin_reversal_unstated]`，拒绝文本与 `finding_conflict_pin` 都给 oracle 顺序；(F) `finding_conflict_pin` 一次列出所有未钉住的冲突（同一 case 的重复 finding、suspected `[precedent-conflict]` 也算，不再等一轮），当前已有行钉住该 case 时不再要求钉；(G) `plan.baseDisagreement` 要求把特判情形单独和组合起来探测（负/省略边界配负步长等）；(H) `review_round_prepare` 遇到只是变 stale 的 full-scan 路由时用框架理由重路由。另：resolve 时没有修复的 canonical（`preexisting_out_of_scope`、`accepted_risk`）不能作为 duplicate 关闭目标（bench-int harness NPXRE）。
- **framework 串行时间（lab `codex/lab-framework-perf`，detection-neutral，开关 `PROOF_OR_STOP_GIT_READ_CACHE=0` 关闭）**：`next --run` 每个 step 是独立 CLI 进程，原来每个进程把同样的 git 只读查询重问一遍（本地 harness 中 CLI 时间 57% 是 git 子进程，其中 55% 是重复）。现在 `core/git-read-cache.ts` 在 CLI 启动时包住 `execFileSync`/`spawnSync` 的 git 调用，只在精确 witness 不变时复用答案（对象 id 且对象必须仍存在、具名 ref 的解析链、ref 前缀、仓库布局/配置、带 rename 检测的版本间 name-status diff 加上其输出路径的 attributes、否则整个 ref 状态；key 含 git 可执行文件、编码与 config 内容，有 include 则不缓存；时钟/缩写 id/notes/decoration 输出不缓存；每个答案在运行后重新取证），跨进程持久化在 `<common git dir>/info/proof-or-stop-cache/`；index/工作区读取、失败（除 is-ancestor / symbolic-ref -q 的无输出 exit 1）、`withFreshGitReads` 内的启动时重读永远真跑 git；不缓存任何裁决。`next --run` 的每个决策与 step 记入 `runtime/next-run/diagnostics.jsonl`（wall、git 子进程数、缓存命中、子进程 boot）。harness：ND-run 111→76 s，git 子进程 5544→2333；next-driver-cost golden 与全量 harness 通过（docs/CLI.md「Framework serial time」）。
- **old-PoS runs 61/63/64（lab `codex/lab-neutral-64`，全部 detection-neutral，无新开关）**：(1) scope-plan excludes 循环（run 61/63 各 3–6 轮相同 scope-plan，约 7 分钟/轮）的根因：reviewer 按 `plan.baseDisagreement` 存 `Precedent conflict: ...` gap（补救是钉住哪个先例的 covering row，不能 excludes），但 `story_review` 的通用 scope_gap 文案给出 "append an excludes entry"（确定性 exclusion 匹配器匹配不了长句），owner 照框架办，reviewer 正确地保留 gap，框架又在判定内容（title/userSees/verificationIntent）没变的 checklist 上重跑。现在 precedent-conflict gap（及命名某 item 所改行为的 gap）只给唯一的 `Next:`（在新增该操作的 item 上加 covering row），不提供 excludes 路径；`plan_review_blockers` 头部在所有 open gap 都不能被 excludes 关闭时去掉 "or add an excludes entry"；`scope-check.json` 记录 `checklistCoreDigest`（不含 excludes 的 checklist digest，签名域外），只改 excludes 且每个 open gap 都是 excludes 关不掉的 gap 时 `scopePlanRerunReason` 不重跑 reviewer（改了 covering row、可被 excludes 关闭的普通 gap、没有 digest 的旧 verdict 照旧重跑）；重跑 prompt 完整列出 owner 新增的 excludes（原先 diff 截成 200 字符）并附框架的确定性检查结果；`scope_exclusion_contradicted` 拒绝与 reviewer 自己的规则不变。(2) `plan.rowBudget`（仍无 cap、无 gate）：advisory 被忽略（run 64：44→51 行），现在 `next` 在 PLAN 的 authoring 之后、scope-plan reviewer 之前给唯一一步可跳过的 `plan_row_trim`（每个 item 一条精确 `checklist_update` 删除重复行；同一组行只提一次，每 Story 至多两次，记入 `runtime/plan-row-budget/<storyId>.jsonl` 的 `at: next_offer`；再跑 `next --run` 即跳过；框架从不自己删行），`story_create` 的 note 以一条 `Next (optional, skippable)` 结尾。(3) 跨进程 git 缓存本来就共享（落盘于 `<common git dir>/info/proof-or-stop-cache/`；run 62-64 分析里"随进程消亡"的说法不对）；绕过它的是 shell 字符串探测（`gitProbe('git rev-parse --abbrev-ref HEAD' | '--show-toplevel' | 'git worktree list --porcelain -z')` 用 `execSync(string)`，缓存从不应答，每个 CLI 进程重 spawn，一次 harness 约 270 次）：`plainGitArgv` 让纯 `git <words>` 走 `execFileSync`，`rev-parse --abbrev-ref` 作为 ref 名读（完整 ref-state witness；`--abbrev=N` 仍拒绝）可缓存；ND-run 真实 git 子进程约 2070→1780（-14%）。未删除任何"重复校验"：用 `go` PATH shim 对 harness 与 run 63 step 计时核对，每次 `go test` 都在不同 tree 或不同命令上（每次 repair 后的 pinned test、仅一次的 routine validation）；唯一相同的一对（routine `validate` 与 owner 的同命令 `live_smoke_transcript` capture）是 delivery reviewer 读的证据，换成 validation 输出会改变其来源。(4) `owner.driver=framework`（默认 `llm` 路径与 next-driver golden 不变）：run 64 的三个机械 owner 回合成为 `next --run` 执行的 framework step——`dev_memory_preflight_ack`、第一次 `scope_plan_review_launch`（`plan.reviewMerge` 下没有 INIT reviewer，无已有 managed run 可绑定 selection，改用合格默认 selection，与 INIT reviewer 首次启动一致）、第一次默认 `live_smoke` capture（项目第一条 validate 命令；失败的 transcript 或无 validate 命令仍归 owner）；首次 `story_create` 的 `[intent_derivation_required]` 拒绝逐行给出最接近的 request.md 原句，`plan_authoring` batch 把它预填为 `requestQuote`（computation 仍由 owner 写）。harness `NOD` 期望 framework 模式的 owner 步骤为 llm 模式去掉 `live_smoke`。测试：`neutral64-fixes-smoke`（E1-E5、R1-R5、O1-O5、C1）、`git-read-cache.test.mjs`（32）。
- **old-PoS run 68（lab `codex/lab-run68-fixes`，全部 detection-neutral，无新开关）**：(1) REVIEW 中需要 PLAN 的 Story-metadata 更正（`[review_metadata_correction_open]`，intent 行）不再走 stale-wave stop-loss：不取消 epoch、不重跑 lane；本波 lane 跑完，本轮 epoch 由框架跑 critic 并 finalize，然后一次框架跳转 REVIEW->DEV->PLAN（harness NMW；base 上两次 cancel、三波 lane、`guard_dev_blocked`）。(2) 本轮 epoch 为 OPEN 时 REVIEW->DEV 被拒不再给只带只读 `review_inventory_status` 的 `guard_dev_blocked`，而是该 epoch 的下一个框架步骤（`openEpochStep`：critic、缺失 lane、finalize）；REVIEW 中 `guardStep` 不再给只含只读状态命令的步骤；remediation gate 对 OPEN epoch 的 Next 改为 `next --run`（review-inventory-epoch.ts 已 repin）。(3) `finding_resolve` 接受修复时读修复提交自己的测试 diff（`core/repair-value-change.ts`：测试文件中只差一个字符串字面量的删/增行对），若当前 intent 行对同一 case 仍钉旧值，则记 `repair_expected_value_changed` 事件并成为开放的 intent 行更正：`next` 框架跳到 PLAN 并由框架自己执行 `checklist_update {intentRows, metadataCorrection}`，行写明 `re-pin: <case> was <old>, now <new>`（保留 requestQuote，满足 run-58 `pin_reversal_unstated` 规则）；request 字面写明旧值的 case 永不改，过不了 derivation 规则的行留给 owner（harness NRV）。(4) `[intent-conflict]` 按模式传播：`conflictPinnedForm` 把 pin 与 request 中的字面量遮蔽后比较，若差别不只在字面量，则任何 item 中以同一形式（任意字面量）钉住的行都进同一个 `intent_conflict_amend` 步骤；PLAN 增加一次可跳过的 `exact_error_pin_check`（`core/exact-error-pin-lint.ts`：钉「完整错误文本」的行；request 要求精确匹配的消息不列；有 probeRunner/pinOracle 时在 Story base 上跑并引用带尾部装饰的错误作证，否则仅为提示）。测试：`run68-fixes-smoke`（G1、X1-X5、P1-P5）。详见 docs/CLI.md「Old-PoS run 68」。
- **old-PoS run 73（lab `codex/lab-run73-fixes`，全部 detection-neutral，无新开关）**：(A) 复检被拒（失败/refusal 的 duplicate-coverage 记录）或标 `[regression-of F-x]`（F-x 已 resolved）的 finding 并入同一个 grouped repair run，且不再走 duplicate 覆盖路径（`regressionOfResolvedFinding`、`duplicateJoinsRepairGroup`；每个 finding 仍各自 commit、各自 resolve；harness NRF，base 上先 `finding_duplicate_resolve_batch` 再多一个 round-2 run）。(B) regression finding 的 repair prompt 带上前一次 repair 的 diff 和 repro，要求一个覆盖所有 call site/目标形态的 family 测试并在报告里写 `[family-test]` 行（`core/regression-family-brief.ts`，grouped 段里每个成员同样带）。(D) PLAN：可跳过的 `request_pin_check`（pin 与 request 字面例子矛盾的行、回答 scope gap 的新增/改动行其 derivation 没引用最接近的 request 句），`plan_review_blockers` 和 scope-plan rerun 上下文要求引用决定该 case 的 request 句；仅字面例子可机械判定，其余只是 prompt（`core/request-pin-audit.ts`）。(E) 通过的 resolved-finding guard 按 package 合并成一次 `go test`（记录/断言不变，失败则回退逐个；`unionGuardPasses`）；“只刷新文件变化的 evidence 行”未做（需 dependency manifest，见 docs/CLI.md）。测试 `run73-fixes-smoke`、harness NRF。docs/CLI.md「Old-PoS run 73」。
- **round-cut（lab `codex/lab-round-cut`；评审轮数决定墙钟时间，runs 59-75 中 3-5 轮的 run 占 81% 超额分钟）**：(N1，开关 `dev.removedGuardScan`，默认 `advisory`) DEV 结束时框架对 Story base→HEAD diff 做确定性扫描：在仍存在的函数里被删除或削弱的操作数守卫（null/省略、负数、越界、空；`err != nil` 不算，移位/反转的守卫不算），且没有 checklist 行或 request 句子说明该变化；advisory 时每个 review lane prompt 都列出（base 行号、置信度、该类的 base 测试行），`on` 时证据明确（函数仍用该操作数、diff 中没有别处新增同类守卫）的会在 REVIEW 前重开声明该文件的 item 并由框架重启其 implementer（每个守卫集合一次，`removed_guard_reopen`；有意改变时报告 `[guard-intended] <file>:<line> <why>`），证据弱（守卫移入 helper、操作数不再使用）的只作 advisory；`off` 不扫描（`core/removed-guard-scan.ts`，harness NRC / NRC-ADV）。(N2) finding 位于对多个操作数分支（或同一操作数两种形式）的 helper 中时，repair prompt 带 bound matrix（helper、每个分支行），要求本次修复测试每个分支并每个操作数报告一行 `[branch-test] <fn> <operand>=<case>: <test> -> <result>`，lab run89 起 prompt 给出每个操作数的确切行，缺行由 managed worker 在同一会话里补问（不再判修复不被接受、不重启、不回 PLAN），单操作数的 type switch 是分派表、不要求该行（`core/bound-matrix.ts`、`core/repair-report-lines.ts`，harness NRM / NFR / NTS）。(N3) critic duplicate 的 repro 出现在 canonical 修复提交新增/修改的 Go 测试里时，由框架步骤关闭（同样的 coverage 运行与拒绝路径，`core/duplicate-auto-coverage.ts`，harness NRD）。(N3b) implementer 与 repair prompt 启动时就带 request 的精确文本字面量（整串相等断言规则）。(N4) pin probe：赋值右侧的内联下标/范围后缀不再被丢弃；request 例子定义的写入形式（下标/成员目标的形状）算新行为，只作 advisory；`next` 生成的整份 intent 载荷带 `intentBasis`，行在此后被改过则 `checklist_update` 拒绝 `[authoring_payload_stale]`（Next：`next --run`；checklist.ts 已 repin）。测试 `round-cut-smoke`（G1-G4、M1-M2、D1、X1、P1-P3）。docs/CLI.md「Lab round-cut」。
- **initplan（lab `codex/lab-initplan`；INIT+PLAN 的 owner 轮次，initplan-breakdown.md §5）**：(行级编辑) `checklist_update {intentRows}` 支持 `ref: "CHK-NNN:<lane>:+"` 追加新行（已有行的 ref 不变）；框架给出的每个行级修复都是行补丁而不是整份 verificationIntent：`plan_authoring`、`counterpart_coverage_missing`（及 DEV gate 的 Next）、`pin_oracle_mismatch`、story_review 的 pin-audit / covering-row `scope_gap` 补救（`--intentRows='[...]'`），`plan_review_blockers` 现在是这些补丁的 batch（每个 item 一条）；`checklist_update` 的 `[intent_derivation_required]` 拒绝给出同一行补丁加 derivation 占位，整份 intent 写入则把载荷存到 `.proof-or-stop/runtime/checklist-update/<storyId>-<itemId>.json`，Next 是 `checklist_update @<file>`。(一次报全) story_create intake 拒绝同时列出 CJK 字段；checklist_update 的 CJK 拒绝同时列出缺 derivation 的行。(PLAN lint 合并) `next` 在 PLAN 把同时到期的确定性 lint（pre-scope authoring、exact whole-error pin、row-vs-request audit、开关打开时的 counterpart coverage）合成一个 agent step，按 item 合并调用，每个检查语义不变（gate 照拒、可跳过的仍可跳过、各自记录 offer）；story_create 与 INIT 内改 intent/userSees 的 checklist_update 一次性打印同样的 lint（「PLAN pre-check」，`core/plan-lint-preview.ts`）；dev-memory preflight pack 为空时 ack 是 framework step。(基线验证) 第一个无 Story 的 `next` / `session_brief`（最迟 story_create）在后台对 base 跑一次项目 `validate.commands`（`core/base-validation.ts`，记录 `.proof-or-stop/runtime/base-validation/`，`PROOF_OR_STOP_BASE_VALIDATION=0` 关闭），模板与 story_create 输出结果，owner 不必自己再跑；不读任何 gate。(INIT 启动) 两个 INIT reviewer 一步并行启动。(开关 `plan.reviewerPreload`，EXPERIMENTAL，默认 off) scope-plan reviewer 的 dispatch prompt 内联 background.md、checklist 行、plan.md/decision.json/understanding.json 与 validate 配置，不再重读（`core/scope-plan-preload.ts`）。测试 `initplan-smoke`（R1-R5、L1-L3、B1、P1），harness NIP / NIP-M。docs/CLI.md「Lab initplan」。
- **run88/89（lab `codex/lab-run89`；检测中性，无开关；run88-89-analysis.md §5）**：(1) PLAN 行若期望输出是输入的重新渲染（同样的词与顺序，去掉空格和括号后字符相同），且某个二元运算符的空格写法与 Story base 打印器不同（证据：base 测试文件里的字面量对 `{"<输入>", "<渲染>"}`，至少两例、九成一致），而 request 没有给出这种写法，则 PLAN pre-check 与一个可跳过的 PLAN lint 步骤 `pin_base_form_check` 列出它，附 base 样例（`file:line`）和具体的行补丁（base 形式、保留原 request 引文、computation 引用 base 样例）（`core/pin-base-form.ts`）。implementer / repair 遇到这种 pin 时不为它造机制，而是报告 `[pin-doubt] <ref> | base prints: <x> | request: silent`；框架核实（行存在、request 未写该值），base 打印器能确认时由框架步骤 `pin_doubt_plan`（DEV->PLAN）和 `pin_doubt_amend`（行补丁到 base 形式、item 回 pending）处理，否则给 owner 行补丁。(2) bound matrix：type switch 的分支不是操作数分支（分派表，只要求 `[family]` 行）；`err != nil` 类不是操作数；prompt 给出确切的 `[branch-test]` 行；finding repair 封存前 managed worker 在同一会话里只补问缺的报告行（最多 2 轮），有提交的修复无论如何都接受（缺行记日志）；`finding_repair_replan` 列出每个 run 不被接受的原因；路由允许的那一次重启由框架启动。(3) 同一链第二个 `[regression-of]` 起，repair prompt 加机制级块：用 `[mechanism]` 行说明哪句 request 或哪一行要求这个机制，都没有就删掉机制恢复 base 行为，只有行要求就报 `[pin-doubt]`；缺行或引文不在 request 里时同样由 worker 补问。(5) story_create 模板说明长载荷用 `story_create @<file.json>`、story_create 自己会报所有规则，不必读安装的框架源码。(6) `exact_error_pin` 不再列出实例化 request 精确模板（`<X>`、`{n}`、`%s`）的行。测试 `run89-fixes-smoke`（B1-B2、D1、T1-T3、C1-C3、E1-E2），harness NPB / NPD / NTS / NFR / NRX。docs/CLI.md「Old-PoS runs 88 / 89」。
- **runs 93-96（lab `codex/lab-run95`；除 EXPERIMENTAL A/B 开关 `plan.disputeConfirm`（默认 off）外均检测中性；run93-96-analysis.md §7）**：(1a) PLAN 行若钉住一段精确文本（期望侧三个词以上的字面量），而 request 没有原文写出、Story base 源码里也没有（相同字符串、它实例化的格式串如 `"... %s"`、≥12 字符的消息前缀），或者它是 request 模板（`<X>`、`{n}`、`%s`）的实例、回应 scope-plan 结论（结论之后新增/改动）且 derivation 没有引用该模板的 request 作用域行（模板所在行及引出它的列表行，run 95 的形态），则 PLAN pre-check `[unstated_pin]` 与可跳过的合并 PLAN lint 步骤 `unstated_pin_check` 列出，并给出现成的行补丁：错误行保留用例、只钉「报错」（`<case> -> error`），其它行删除（`core/unstated-pin.ts`）；exact whole-error lint 把这些行让给它。(1b) `checklist_update {intentRows}` 新增删除操作 `{ref, remove: true}`（`drop: true` 同义），其后的行下标前移并在输出中列出；不是行字段的键被拒绝 `[intent_rows_invalid]`、不写入（run 95 的 `drop` 曾被当成字段写入并打印 updated）；模板文案不再用 drop 表示「从补丁里去掉」。(1c) scope-plan reviewer 连续两次结论都指向同一行时，`next` 返回 `plan_pin_dispute`：每个争议行一条无需填写的命令（精确错误文本放宽为 `<case> -> error`；值行删除并排除该用例、同一调用里改掉 userSees 中提到它的子句（lab run102 起对 counterpart 门要求的用例绝不如此，见 runs 100-103）；若该 item 自己新增了该用例则改钉 request/base 探针给出的值），先于 pin-audit 值修正与通用 `plan_review_blockers`；重跑的 prompt 写明争议行与补救（`core/pin-dispute.ts`）；EXPERIMENTAL A/B `plan.disputeConfirm=on` 让这次重跑成为确认式复审（ADR-043，可能漏掉未改行的新 gap，故默认 off）。(1d) INIT/PLAN 的 checklist_update 若留下一个 excludes 条目、而同一 item 的 userSees 仍提到该用例（与 scope-plan 排除检查同一判定），输出给出一条同时设置 excludes 和去掉那些子句的 userSees 的命令；标题/文件新增该行为时说明无法排除。(2) pre-existing finding 处置是 framework 步骤，`next --run` 记录后在同一次调用里启动其余 finding 的托管修复；元数据 finding 的关闭、以及需要 owner 关闭的 duplicate，在仍有 finding 需要启动修复时排在修复启动之后（live 与 reference driver；golden 不变）。(4) exact-text 覆盖缺口若 item 已有一行带着该字符串（near miss），给出该行的现成补丁（`(exact: the whole text equals it)`）；story_create 模板写明各检查采用的行规则，scope-plan prompt 与模板都写明安装的框架（`/opt/pos`）不是本项目、不要读；bench 容器里让 `/opt/pos` 不可读不可行（CLI 以同一用户运行、需要读同样的文件），adapter 改为统计每个会话读框架源码的次数（`framework_source_reads`）。测试 `run95-fixes-smoke`（R1-R4、U1-U3、X1、D1-D3、N1、B1、S1、F1），harness NUP / NPR / NPR-C / NPXF。docs/CLI.md「Old-PoS runs 93-96」。
- **runs 100-103（lab `codex/lab-run102`；run100-103-analysis.md §1/§2/§5/§6）**：(1) `plan_pin_dispute` 的补救拿到 counterpart 门的结果后，绝不删除该门要求的行、也不排除其用例（run 102：dispute 删行+排除、counterpart 门又要求同一用例，交替 10 次，owner 按 adapter「stop and report」规则停在 PLAN，reward 0）：counterpart-backed 行（取值等于框架由同一接收者对应操作算出的值）不再争议；在 counterpart 能解析的用例上钉错误、或取值与算出值不同的行，改钉为 counterpart 值（单字符字符串写入直接算出，否则占位符点名 counterpart）；其它错误行放宽为 `<case> -> error` 并保留用例；已只钉「报错」的行保持不变（settle）。`index out of range: N`、`ErrOutOfRange`、`IndexError` 等现在识别为错误钉值。重跑的 scope-plan prompt 说明框架要求该行及原因。(2) PLAN 补救环检测（`core/plan-remedy-cycle.ts`，`runtime/plan-remedy/<storyId>.jsonl`）：要求/删除某用例的补救各记一条（键 `<item>|<operation>|<class>`）；某一步的补救若推翻另一步在同一用例上的补救，按优先级一次性裁决：request 原文 > Story base（counterpart、base 探测）> scope-plan reviewer 意见（平局保留行），胜者的步骤带 `[plan_remedy_cycle]` 说明，记为 settlement，输的 dispute 补救不再给出，其 gap 不再阻塞（framework 步骤 `plan_remedy_settled` 重跑 story_review）；`next` 永不交替，始终有一个可执行步骤。(3) counterpart coverage 变为值感知（`coverageOf`）：对 counterpart 会解析的用例（函数体里用长度回绕操作数 `idx = length + idx` / `i += len(s)`，或 base 探测给出非空值；下标形式要求下标不超过字面量长度，方法形式不超过构造参数个数）钉错误/拒绝的行不算覆盖，拒绝文本点名该行，Next 原地改钉为 counterpart 值；request 有一句同时提到该操作和该类仍可豁免（run 101：正确行被 pin-audit 翻成 `index out of range: -1`，门仍算覆盖，第 8 次同一漏检）。(4) 只引用 counterpart-backed 行的 scope-plan gap 由框架按优先级判定为 settled（story_review advisory `scope_gap_counterpart_settled`，不阻塞；`pin_audit_correction` 与 `plan_pin_dispute` 跳过），scope-plan prompt 在 pin audit 后列出这些行和优先级。(5) `plan.counterpartCoverage` 默认 on：开启的 16 次已评分 abs 试验 14 次 reward 1，两个 0 是 run 101/102，均由本 lab 修复；未开启时同一隐藏测试在 runs 43/46/55/57/71/80 漏检。adapter 指引：只有 `human` 步骤或无可执行步骤才停下报告，`agent` / `framework` 步骤即使重复也照做（guidance hash 重新 pin）。测试 `run102-fixes-smoke`（V1-V4、P1-P2、G1-G2、C1、S1），harness NCD / NCE / NCS。docs/CLI.md「Old-PoS runs 100-103」。
- **lean pipeline（lab `codex/lab-lean`；EXPERIMENTAL 总开关 `pipeline.lean`，默认 off；bench-staging/oldpos/lean-pipeline.md；docs/CLI.md「Lab lean」）**：`on` 对配置里未显式设置的键隐含 `implementation.grouping=story`、`review.laneMerge=on`、`review.deltaRounds=confirm`、`review.criticOnCleanRound=skip`、`plan.reviewMerge=on`、`plan.disputeConfirm=on`（显式键优先，也可显式写生产值退出某一项；证据记录总开关和每个隐含值；格式错误时在消费处为 off）。(1) DEV：一个 implementer run 承担所有打开的 item（`core/lean-story-run.ts` 的 STORY RUN 段：每个其它 item 一节，含 pinned 命令/测试名、精确输出、counterpart 行；每个 item 用含其 id 的 commit 提交），worker 只标记绑定 item done；其它 item 在 run 的某个实质 commit 写出其 id 后由框架步骤 `story_item_done` 标记 done（同样的 done 检查；pinned 收据仍由 DEV→REVIEW evidence chain 生成）；没有 commit 写出其 id 的 item 走自己的 run；有项目 `probeRunner` 时不分组。Story run 对某个成员的 commit 只用一次（lab lean-dev，old-PoS runs 117/118，`storyRunMemberClaimUsed`）：成员被标记 done 之后又被门禁（exact-text、removed-guard、probe 行）重新打开时，不会再用同一个 commit 关闭，`next` 为它启动自己的 implementer run；`host_run --managedDispatch` 在 provider 启动前拒绝为已 done 的 item 启动 implementer（`managed_dispatch_target_already_done`，done→done 的完成调用不绑定结果，只会以 `managed_dispatch_output_missing` 结束），下一步是 `next`，不要手动启动 implementer。测试 `lean-dev-reopen-smoke`、harness NLN-X。(2) REVIEW：第 1 轮及每个完整轮是一个合并会话（有 finding 的轮仍跑 critic，干净轮跳过）；修复后的后续轮是一个 delta 确认会话覆盖所有 lane 关注点（没有 lane 重审整个 Story，runs 53-56 教训），框架重跑已修 finding 的测试；确认会话报告的 finding 若所引位置全部在 delta 范围外（或没有位置），记 `delta_round_escalated`，下一轮为完整轮（`PREVIOUS_ESCALATION`，prompt 要求重审整个 Story）。不设轮数上限。(3) INIT+PLAN：沿用 `plan.reviewMerge`/`plan.disputeConfirm`。(4) TEST：未实现（delivery-check 是 DONE 信任门的签名独立评审，机械化需要新的授权路径，约 1.5-2 min）。(5) 缺陷族按证据关联（`remediation.familyEvidence`，默认 on，`off` 为回滚，仅改 repair prompt）：引用行的最后修改是早先 finding 的 repair commit、引用区间重叠（±3 行）或同一个外层函数即关联；族在第二个轮次出现起给 mechanism-level brief 并要求 `[mechanism]` 行；同轮 duplicate 的 repro 列入 canonical 的 repair prompt。harness：NLN-OFF 12 个 managed session → NLN 6；NLN-E 越界 finding 让下一轮变完整轮；NLN-DF；NLN-I；NLN-X（重开的成员由 next 重新启动 implementer）。测试：`lean-pipeline-smoke`、harness `LN`、`ab-variant-switches` V13。
- **plan-deadend（lab `codex/lab-plan-deadend`；old-PoS run 121，bench-staging/oldpos/run121-analysis.md；除默认 on 的回滚开关 `plan.docDriftSettle` 外均检测中性）**：run 121（`pipeline.lean=on`）在 PLAN 结束：最后一轮 story_review 有三个 `scope_gap` blocker，都没有行补丁（reviewer 以未被 request 提及的文档为来源报告的既有 doc/code 漂移，以及两个任何行模板都不匹配的覆盖缺口），agent step `plan_review_blockers` 没有命令，渲染成 `Next: none runnable (see Why)`，owner 按指引停下（reward 0）；之前每次 `plan_pin_dispute` 都在 scope-plan 等待之后立即依据上一个 verdict 的 story_review 轮次决定，「其余 blocker」是过期的。不是 lean 特有（默认开关同样走这些路径，harness NPDE-D）。(1) `core/plan-gap-remedy.ts` `docDriftSettlement`：来源是文档文件（无来源时为文中点名的文档；request.md/background.md/plan.md 等 Story 工件与 AGENTS.md/CLAUDE.md 不算）、报告与现有行为冲突、request 既未点名（路径或文件名）也未要求修改文档、没有 item 修改它、也没有 item 新增或改变其所述行为（`itemsChangingBehaviour`）的 gap，由 story_review 记为框架裁决 `scope_gap_doc_drift_settled`（advisory，优先级 request 原文 > scope boundary > reviewer 意见）；开关 `plan.docDriftSettle`（默认 on，`off` 回滚）。(2) 其它普通 gap 的 story_review 文案给出唯一的 covering row 行补丁（`<item>:edge:+`，目标为文中首个有效 CHK，否则 title/userSees/文件名共享词最多的 item，否则第一个未完成 item），excludes 路径仍写明在同一 item 上；`plan_review_blockers` 因此总是一批行补丁；open question 附带 `scope_question_resolve` 调用。(3) verdict 与上一个 verdict 指向同一行且最新 story_review 轮次早于其输入时，`next` 先重跑 story_review（framework `story_review_rerun`），`plan_pin_dispute` 合并的是当前轮次的行补丁。(4) 没有命令的 agent step 渲染为「do what Why names ..., then `next --run`」，只有 human step（及 DONE）仍打印 `none runnable`。adapter `AB_FLAGS` 新增 `plan.docDriftSettle`。测试 `plan-deadend-smoke`（D1-D2、R1-R3、N1-N2、S1），harness NPDE / NPDE-D / NPDE-S。docs/CLI.md「Lab plan-deadend」。
- **run 131（lab `codex/lab-run131`；runs 127-131，bench-staging/oldpos/run131-analysis.md、run127-129-phase-cost.md；均检测中性，三个默认 on 的回滚开关 `remediation.scopeGateSettle` / `remediation.conflictSettle` / `plan.intentConflictGuard`）**：(1) reviewer 对 scope gate 放行的文档（`documentation-default` / `allowedModify`，无 protected/excluded）报「scope violation」时，作为 file-state conflict 的输家一次关闭（winner `scope_gate`，原因里记录 gate 结论；导入时或 framework `finding_file_state_settled`），不修复、不要求实质提交、不进 `finding_conflict_pin`、回归守卫跳过；code lane prompt 多一段 `SCOPE-ADMITTED DOCUMENTATION`。(2) implementer 的 `[intent-conflict]` 同时给出钉住值与 request 隐含值时，`intent_conflict_amend` 是一条现成的行补丁（写明 re-pin）；`next` 记录未决冲突（`runtime/intent-conflict`），PLAN 中保留被质疑钉值的 `checklist_update` 若没有 request 原句或 base 检查（counterpart、pin-base-form、`plan.pinProbe` 探针）支持则拒绝 `[intent_conflict_overruled]`，Next 为该补丁；PLAN 的 intent 编辑也打印 PLAN lint 预览。(3) 修复因破坏已解决 finding 的覆盖测试而被拒、且当前行按该测试钉住同一用例时，框架按 request > base > reviewer 一次关闭（`finding_conflict_settled`，`runtime/finding-conflict` 记录配对，之后同用例不再重开）。(4) 第一次 `pin_reversal_unstated` 就给出按 oracle 顺序决定的现成补救（repin/keep/counterpart/relax/exclude）。(5) `metadata_correction` 在 PLAN（及 userSees）给出完整行载荷；`_unchanged` / `_none` 拒绝点名唯一下一条命令。(6) run 127 R2：delta 确认 lane 的拒绝提交（`delta_round_*` 事件）不再使兄弟 lane 的 live binding 失效（`REFUSAL_RECORD_EVENTS`）。(7) 托管运行 150 s 内无 provider item 事件即 `provider_stalled`（`PROOF_OR_STOP_MANAGED_PROVIDER_FIRST_ITEM_MS`，0 关闭），可自动替换的失败 lane 在兄弟 lane 仍在跑时立即 `review_round_prepare {lanes}` 重启；proxy 把首字节前的读超时当作瞬时错误重试（`OPENCODE_PROXY_TRANSIENT_MAX_WAIT_S`，默认 900 s）。测试 `run131-fixes-smoke`、harness NSG NSG-X NIO NFC NPV NMC NDI NSL；docs/CLI.md「Old-PoS run 131」。
- **run 132（lab `codex/lab-run132`；bench-staging/oldpos/run132-analysis.md；均检测中性，一个默认 on 的回滚开关 `init.reviewerCarryForward`）**：(1) Story 元数据编辑命令（`story_update` / `checklist_update` / `checklist_add` / `background_set` / `background_append` / `story_request_set`）遇到未声明的键直接拒绝 `[unknown_argument]`（不写入），点名接收该键的命令（如 `background` → `background_set`，Next 带上原值；拼写错误则给 did-you-mean 的修正调用）；INIT blocker 指引按每条 issue 引用的输入给出确切命令（`core/init-blocker-fix.ts`）。(2) 签名 INIT 输入被改（`[init_check_tampered]`）后，reviewer 的签名 PASS 若其自身判断切片（`judgedSliceHash`；story-init：background.md、index 字段、checklist title/context、仓库指南）未变，则带入下一份签名记录，只重跑过期的 reviewer；记录写入 `_signedInputs`，被手改的记录不带入任何结果。run 132 的三次重跑都改了 story-init 的切片，故该项在 run 132 上无节省，只在 INIT 中重录 request 时生效。(3) `[intent-conflict]` 两个不带反引号、同一文本的变体值视为字面量（现成 amend 补丁），adoption 忽略 `re-pin:` 子句。(4) PLAN 把钉住的消息与打印它的 Story base 格式串比较（固定引号、`%q`、base 测试实例的槽位引号），`pin_base_print_check` / `[pin_base_print]` 给现成行补丁，无 base 实例时仅 `[pin_base_print_unverified]` 提示。测试 `run132-fixes-smoke`、harness NUA NAB NBP NIC NIC-F NIC-OFF；docs/CLI.md「Old-PoS run 132」。
- **runs 133-135（lab `codex/lab-run132` 续；bench-staging/oldpos/run133-analysis.md A-D、run134-analysis.md 1-3（E-G）、run135-analysis.md H-L；六个默认 on 的回滚开关 `review.stragglerVerdict` / `plan.baseEvidence` / `review.deltaSelectorRepair` / `remediation.duplicateReproAppend` / `plan.repinAllRows` / `remediation.baseClaimEvidence`，L 提升检测，其余检测中性）**：
  - (A) `pin_audit_correction` 每个 gap item 一条现成行补丁（值侧与 computation 写请求值，case 侧不变）。确定性检查可部分生效，未改的剩余部分是下一步纠正，不重跑 reviewer。sweep 只覆盖同角色、同 case 的行。`\u` 转义匹配。dispute 只计框架给过纠正的行。解析 run 134 的 `pins <case> -> <value>; request gives <value> because ...` 格式。
  - (B) 只写 base 打印值的 `[pin-doubt]` 给现成行补丁。新增 PLAN lint `empty_collection`。
  - (C) `review.stragglerVerdict`：兄弟 lane 全部结束后，超过 max(8 min, 2×兄弟中位数) 的 review lane 在自己的会话内被要求立即给出结论；会话尚不可恢复时记一次日志并继续轮询；兄弟只认框架封存的 managed run。
  - (D) duplicate 步骤写明各 finding 摘要、canonical 的修复提交与测试，并预填 coverage。
  - (E) `plan.baseEvidence`（`core/pin-base-evidence.ts`）：pin-audit 请求值先查 Story base（request 字面例子 > 声明的求值器 > 写明该 case 的 base 测试）。base 否定则不提供该纠正（settle，story_review 记 `[scope_gap_base_settled]`）；base 给出第三个值则改为 base 值；无证据时照旧。
  - (F) dispute / pin-reversal 补救：base 能决定的既有行为 case 改钉到 base 值，不再排除；只有无 base 证据时才排除。
  - (G) scope-plan / story / delivery prompt 只在 Story 有 plan.md 时才列出它（run 134 的「plan.md absent」OQ）。
  - (H) `review.deltaSelectorRepair`：delta 确认 lane 的 prompt 写明 `[reverified]` 必须是带测试名的行；遇到通用 selector（`PASS`）时，命令只点名一个测试就由它补全，否则在该 lane 自己的会话内纠正一次，再否则用框架重跑输出中唯一一行带测试名的 pass 行；都不成才升级为完整轮次。不读 runtime 文件。
  - (I) `remediation.duplicateReproAppend`：canonical 修复 prompt 列出各 duplicate 的 repro；duplicate 被拒一次 `[duplicate_coverage_lacks_repro]` 后，`next` 给出现成步骤 `duplicate_repro_append`（把 repro 追加到点名的覆盖测试、只提交该文件、重跑、关闭），不再先派 managed repair。
  - (J) `plan_review_blockers` 完整列出全部 blocker（数量在前）；被截断的 Why 指向保存全部内容的绝对路径 `-why.txt`；payload 文件给出 Story git worktree 内的绝对路径；占位覆盖行写明其 gap 的 case（`gapCaseLabel`）。
  - (K) `plan.repinAllRows`：`pin_reversal_unstated` 与该 case 的所有早先 pin 比较（未变的前缀 pin 不算反转）；所有框架 re-pin 补救都经 `closeRepinPatch` 闭合，仍钉旧值的每一行都 re-pin，其它 item 另给现成调用，补丁再过一遍 gate，不通过就不作为现成调用提供。不变量测试 K5 保证框架不会给出被自己 gate 拒绝的补救。
  - (L) `remediation.baseClaimEvidence`：修复报告声称边界 case「already matches the base」时，必须给出 `[base-evidence] <case> :: <base 上运行的命令> -> <输出>`；worker 先在同一会话内追问，仍缺则修复不被接受 `[repair_base_claim_unproven]`。
  - 安全修复：counterpart-coverage / unstated-pin / pin-base-form / pin-base-print / pin-audit-base 的 runtime 证据文件改为只写日志，每个进程重算（进程内 memo），不再回读（owner 可伪造 inputsDigest 相同的文件）。
  - 测试：`run133-fixes-smoke`、`run134-fixes-smoke`（E6/E7 安全）、`review-straggler-smoke`（S5 伪造兄弟）、`run135-hi-smoke`、`run135-jk-smoke`（K5 不变量）、`run135-l-smoke`。docs/CLI.md「Old-PoS runs 133-135」。
- **run 137（lab `codex/lab-run137`；bench-staging/oldpos/run137-analysis.md M-P；两个默认 on 的回滚开关 `remediation.regressionCheck`（M，提升检测）/ `remediation.conflictPin`（N，检测中性），一个默认 off 的 EXPERIMENTAL 开关 `review.classEnumeration`（P，需检测 A/B））**：
  - (M) finding-repair run 封存前，worker 在其提交（launch head..HEAD）上重跑 Story 所有已 resolve finding 的覆盖测试（同 `finding_resolve` 守卫，用一次性事件存储，不记守卫裁决，`finding_resolve` 仍是 gate），以及命令点名本次修改路径的 checklist pin 验证（现在失败且 launch head 通过才算本修复的回归，最多 8 条）。失败在同一会话内恢复一轮（失败检查、命令、输出尾部；只改产品代码，不改已解决的测试；真冲突写一行 `[intent-conflict]`），最多 2 次（`core/repair-regression-check.ts`）。共享 helper（在 Story diff 的改动源文件中有 ≥2 个调用点的非测试函数，`core/shared-helper-callers.ts`）：repair prompt 列出 finding 所在 helper 的全部调用点；修复改了共享 helper 时报告每个调用者一行 `[caller-check] <caller> -> <helper>: <input> base=<result> HEAD=<result> unchanged | changed: <理由>`，缺的在同一会话追问。
  - (N) 没有 checklist 行钉住冲突 case 时，框架按 request 原文 > Story base > reviewer 意见自行裁决（`core/finding-conflict-pin.ts`，每次重算）：request 行给出该表达式的值则 request 决定；否则用未决 finding 写明的 base 值（`on the base \`E\` returns \`V\`` 等），声明的 base 求值器只能否定。胜方 finding 在 DEV 按 `Framework pin (finding_conflict_framework_pin)` 修复，框架自己的 `[regression-of G]`（由守卫的 rejected-repair 记录关联）作为败方由 `finding_conflict_settled`（winner `story_base` / `request`）关闭；不写 checklist，不会让 scope-plan 结论过期。无法裁决时保留 `finding_conflict_pin`，且 PLAN 的第一步就是写 pin（先于 scope-plan 重跑与 lint）。
  - (O) grouped repair 失败且无点名该 finding 的提交后，该 finding 的单独重启是 framework step（`groupSplitRelaunchIsFramework`）；thinking 模式 pass-back 400 归类为 provider transport 错误。run 137 的 2373e8ff 最后一个 item 在退出前 19 s、最大 stdout 间隔 47 s，lab-run131 的 stall 机制无法更早判死；省下的是 owner 一轮。
  - (P) `review.classEnumeration=on`：concept / quality lane 得到 Story 改动的共享 helper 及全部调用点，在自身检查之外逐调用者对 base 枚举每个被改变的行为。new-PoS ADR-089（泛泛的 round-1 family probe 句子）因收窄 lane 而被回滚；本块只给框架算出的具体调用点。
  - adapter `AB_FLAGS` 新增三个开关及 `test_run137_switches_reach_the_pos_config`。测试：`run137-fixes-smoke`（M1-M7、N1-N4、O1-O2、P1-P2，base 全 FAIL），harness NRR NCK NCP NCP-P NGX NCL（base FAIL）与对照 NRR-OFF NCL-OFF。docs/CLI.md「Old-PoS run 137」。
- **run 110（lab `codex/lab-run110`；run110-analysis.md §4/§6；除 EXPERIMENTAL 开关 `review.driftBaseSymbol`（默认 off）外均检测中性）**：run 110 在文档上振荡 6 轮后超时：docs lane 报 `docs/src/docs/types/{array,string}.md` 的既有 doc/code 漂移，Story 的 scope boundary 写了 excluded「changes to docs」，但这句没有进入 scope contract，gate 默认放行文档、repair prompt 还说「文档也被 gate 允许，改了提交」；修复改文档，concept/test/quality lane 报越界，回滚又重现漂移。(1) `scope_contract_set` / `scope_contract_init_from_plan` 把 scope boundary excluded 中纯文档的条目（「changes to docs」等，只由文档词与填充词组成）映射为 explicitExcludes `**/*.{md,mdx,rst,adoc}`，存在于仓库的路径记号映射为该路径（`core/boundary-path-excludes.ts`，开关 `scope.boundaryExcludes` 默认 on、`off` 回滚）；request 要求文档工作、contract 允许某文档、或 boundary allowed 条目涉及文档时不排除（request > boundary），路径记号永不排除 allowed 路径；于是 writer prompt（文档不被允许、只要求改文档的 finding 由框架裁决、测试不得钉住未列出文件的字节/哈希/git 状态）、写时守卫与 REVIEW gate 一致，各 code-review lane prompt 带 `SCOPE-BOUNDARY EXCLUDED FILES` 块。(2) pre-existing 处置：剥离前导 `[...]` 标签；hunk 内代码锚点用 base 探测判定（`driftBaseBehaviour`）；被排除文档的本 Story 修改不再阻塞；被 contract 排除的路径不因 request/boundary 提到而算 in scope。(3) managed writer 新增的测试若读取 scope contract 允许列表之外的文件并以哈希（sha*/md5/checksum/`.Sum*(`/createHash/hashlib）或 git 调用（diff/show/status/log/hash-object/ls-files）钉住它，则为违规 `out_of_scope_pin_test`：同一会话一轮移除，否则该修复不被接受，重启 prompt 给出唯一下一步（删除该测试，scope 由框架 scope gate 检查）（`core/scope-pin-test.ts`，复用 run-55 检查的同一份缓存 `git show`，不增加 spawn）。(4) 文件状态冲突（`core/file-state-conflict.ts`，开关 `remediation.fileStateSettle` 默认 on、`off` 回滚）：finding A 要求改文件 X、boundary 或 finding B 要求 X 不变时，按 request 原文 > scope boundary（contract 的 explicitExcludes/protectedFiles）> reviewer 意见一次裁决：目标全是被排除的文档且 request 未要求修改的 finding 输给 boundary；针对 request 明确要求修改（且未被排除）的文件的 scope finding 输给 request；败方以签名 resolve 关闭（`resolutionType: superseded`、`strong`、理由 `[file_state_conflict] ...` 含 boundary 条目、优先级与 follow-up），lane finding 在 import 时关闭（事件 `finding_file_state_settled`，无 owner 步骤、无额外轮次），否则 framework 步骤 `finding_file_state_settled`（`finding_resolve --disposition=file_state_conflict`，重算裁决，否则拒绝；不带该 disposition 的 `[file_state_conflict]` 开头 resolution 被拒）；裁决记入 `runtime/file-state/<storyId>.jsonl`，每次由 request 与 contract 重算，同一文件状态的后续 finding 得到同一结论；含 in-scope 代码缺陷位点、被排除的非文档文件、request 要求但 contract 排除的文档都不裁决；已裁决 finding 不跑回归守卫、不复验、不作 duplicate 的 canonical 修复、算 delta round 的非修复关闭。(5) EXPERIMENTAL `review.driftBaseSymbol`（默认 off，可能关闭 Story 在同一符号别处造成的漂移）：引用行全部出现在 base 同名符号源码中也算 base 证据。adapter `AB_FLAGS` 新增三个开关及 `test_run110_switches_reach_the_pos_config`。基探针环境加固：所有 base probe（`evaluateInTree` 唯一 spawn 点）只拿白名单环境（PATH、临时 HOME、TMPDIR、TZ、LANG/LC_*、工具链变量、项目声明的 `validate.env`），含 TOKEN/KEY/SECRET/PASSW/PROXY/AUTH 等或 OPENCODE/OPENAI/ANTHROPIC/GH_/GITHUB_/AWS_/SSH_ 前缀的名字及带 userinfo 的 URL 值一律剔除（声明了也剔）；网络未限制（open item）。测试 `run110-fixes-smoke`（B1-B4、D1-D7、P1-P2、F1-F5、S1），harness NFS / NFS-S。docs/CLI.md「Old-PoS run 110」「Probe runner environment」。
- **counterpart coverage（lab `codex/lab-sibling-gate`，开关 `plan.counterpartCoverage`，lab run102 起默认 on（`off` 为回滚，记入 abVariantEvidence；之前为 EXPERIMENTAL、默认 off）；`core/counterpart-coverage.ts`；docs/CLI.md「Lab sibling-gate switch」）**：runs 43/46/55/57/71 同一个隐藏测试漏检：Story 给某接收者类型新增写路径（字符串单下标赋值），request 不提负下标，implementer 照抄另一接收者的写守卫（数组写拒绝负下标），而不是同一接收者已有的读规则（字符串读负下标从尾部数）。开关 on 时 PLAN→DEV 前框架只看 Story base（不看 request、不看任务名）：从 item 自己的行 / 标题找出新增操作（方法形式：item 提到的 base 类型 `T` 有成对操作的另一半 `C` 而缺 `X`，成对词表 get/set、get/put、read/write、load/store、getitem/setitem、peek/poke；下标形式：`v = <字面量>; v[i] = <值>` 单下标写入字符串 / 数组 / map），找同一接收者的对应操作（读）及其特判的操作数类（负数、越界、空、null/省略、类型），证据三种：函数体里对操作数（参数或由其派生的局部变量；重新赋值如 `i = len(s) + i` 仍是操作数，`err != nil` 不算）的条件分支、base 测试对该对应操作的边界调用、声明了 probeRunner/pinOracle 时的 base 探测。置信规则：操作确为新增、只有一个候选接收者、对应操作定义唯一，且两种证据一致（或探测显示负数 / 越界返回值）时，若没有行在新操作上覆盖该类、request 也没有一句同时提到该操作和该类，则拒绝 DEV（`[counterpart_coverage_missing]`，唯一 `Next:` 是每类追加一条占位行的 `checklist_update` 行补丁（lab initplan 起 `intentRows` `<item>:edge:+`，之前是该 item 的全部 intent），oracle 顺序：同一接收者的对应操作优先，其他接收者的同名操作其次），`next` 在 `pin_probe_mismatch` 之后、authoring 与 scope-plan reviewer 之前给出同一步；其余（单一证据、配对不唯一、已有操作的修改）只作 advisory（证据文件、PLAN `story_review` 的 `counterpart_coverage_advisory`、implementer prompt），base 读不了或超上限（4000 文件 / 24 MB）不拒绝。implementer prompt（仅开关 on）要求先在 base 上探测对应操作并报告 `[counterpart] <op> :: <case> -> <base result>`（+553 B 通用 / +669 B 含一个发现；harness NCC +668 B）。证据 `.proof-or-stop/runtime/counterpart-coverage/<storyId>.json`（含 inputsDigest 缓存键与 `abVariant`）。在上游 abs 源码上核对：run-71 形状的 `s = "abc"; s[1] = "x"` 因负数与越界被拒，数组单下标（已有操作）只是 advisory。局限：不扫 Ruby 等 `end` 定界语言、别名操作、把边界处理委托给 helper 的对应操作、范围写入。bench arm：`POS_AB_FLAGS='{"plan.counterpartCoverage":"on"}'`（不声明求值器；加 `"bench.pinOracle":"on"` 才有 base 探测）。测试：`counterpart-coverage-smoke`（S1、D1-D3、N1-N5、T1、I1）、harness NCC（含开关关闭对照 NCC-off）。
- **implementer 收尾一次调用（old-PoS run 34）**：implementer prompt 内联 background.md、该 item 的 plan.md 段与 request.md（DEV 内不变，不再每个 item 重读），完成调用是 `checklist_update {status: done, commit: {files}}`：暂存这些文件、`git diff --cached --check` 有错时拒绝且不提交、以规范 implementer 作者提交，再跑原有 done 检查。implementer 模板不再要求 `[probes]` 行（只属于 `implementation.probeMatrix=on` 的矩阵块）。被修复的 finding 由 `next` 以 framework step 关闭（框架写 resolution，handler 照旧逐条复核自己的修复与被引用文件的改动）；delivery reviewer 的 prompt 内带 `delivery_context_pack` 输出，不再自己摸索框架状态。lane 按历史最慢优先启动（docs、test-coverage、concept、quality），先结束的 lane 立即导入。
- 同一 prompt 列出「Already covered」（run 17，永不算 gap）：PoS 工作流本身保证的交付流程句（在从 main 拉出的新分支上工作、commit everything、合回 main；`covered_by: "proof-or-stop-workflow"`），以及 INIT `scopeBoundary.excluded` / `understanding.constraints` 里已确认的限制性约束（「do not …」句；`covered_by: "init-scope"`）。其余产品要求（行为、输出、错误、例子、兼容性承诺）保持严格。run 17 中 reviewer 因这两类句子报 3 个 `scope_gap`，迫使第二次 reviewer 运行（≈2 min）。
- verification-intent 作者的 prompt 指向 request.md，要求每个例子、每个列出的变体各写一条精确输出 intent，request 未逐字给出的期望值附 `derivation`。INIT product reviewer 只拿到路径。
- **钉住值的推导（old-PoS run 23 源头修复，`core/intent-derivation.ts`）**：Story 有 `request.md` 时，`desc` 是「输入 -> 输出」例子（分隔符 `->`/`→`/`=>`/`==`，否则 returns/yields/gives/prints 等）且期望值具体（反引号字面量，否则引号字符串、`[...]`/`{...}`、数字）、而期望值不是从 request.md 逐字引用（区分大小写，忽略空白）的 intent 行，必须带 `"derivation":{"requestQuote":"<request.md 原句>","computation":"<从该句到钉住值的计算>"}`：`requestQuote` 必须在 request.md 中出现（忽略大小写/空白/反引号，`...` 可省略中间，至少 12 字符），`computation` 必须写出钉住的值。`story_create`、`checklist_add`、`checklist_update`、`plan_acceptance_prepare/apply` 对缺失或无效的推导拒绝（`[intent_derivation_required]`，不写任何东西）；逐字引用的例子不需要。已存储的无推导行（request 之后才记录或修订）是 `missing_intent_derivation` blocker，`next` 的 `plan_authoring` batch 给出带 derivation 占位的精确 `checklist_update`。推导是否**正确**由 scope-plan reviewer 的 pin audit 判断：prompt 列出每一行（ref、desc、requestQuote、computation），reviewer 必须从 request 独立重算，不一致记为阻塞 gap `pin-audit <ref>`；same-semantics 规则：request 有「same ... semantics as X」类句子时至少要有一条输入能区分不同读法的 intent（非对称例子），否则记 `asymmetric-example` gap。这两类 gap 的 `story_review` 提示给出改 intent 的命令，再重跑 reviewer。prompt 代价约 1.1 KB + 每行约 270 B。
  prompt 里有 pin-audit 行（或 request 有 same-semantics 句）时，scope-plan 裁决不会延后到 DEV 之后（N8 例外，`scopeVerdictDeferral` = held）：DEV 入口等它，gap 在任何 item 按错 pin 实现之前出现。
- **request 高于 intent（old-PoS run 23，`core/request-authority.ts`）**：intent / userSees / context / 钉住的测试都是 owner 写的，可能写错。REVIEW 各 lane 与 inventory critic 的 dispatch prompt 内联 request.md 原文 + 共享 rubric：request 规定的行为要自己从原文重新推导期望值；与 request 矛盾的 intent 或测试是 finding（至少 medium），不能以「checklist 是需求来源」放过；critic 不得把这种矛盾记成 note / limitation，声称两种读法在某个钉住的例子上一致时必须给出两边的计算结果。（这推翻了早先「REVIEW lane 不注入 request」的 token 纪律，每个 lane 约 +1k token。）
- implementer 与 finding-repair 的返回必须以 `[intent-conflict]` 段结尾：`none`，或每个冲突一行 `<intentRef> | request: "<原句>" | request implies: <值> | intent pins: <值>`；散文里的「deliberate choice」不被接受（implementer 只写在散文里、且提到 intent/checklist/pin/request 的「deliberate choice」或「deviates from the request」也按冲突处理；普通设计说明不算）。`next` 从运行最后一条 assistant 消息解析：DEV 里返回 `intent_conflict`（`story_advance --phase=PLAN`，DEV 中 intent 冻结），PLAN 里返回 `intent_conflict_amend`（`checklist_update` 新 `verificationIntent`，冲突点名 userSees 时改 `userSees`，+ `reason` + `status: pending`），改完后 DEV 重新实现该 item。old-PoS run 37：pin 不是代码字面量（如引用了 request 未加引号的值的错误文本）时，同一步还列出任何 item 中写着同一错误 pin 片段（`conflictPinnedFragment`：pin 与 request implies 不同的部分加前文）的行，并给每个兄弟 item 一条 `checklist_update {itemId, intentRows}` 行级修补（已 done 的回 pending），一次 PLAN 解决所有 item。单行修改用 `checklist_update {storyId, itemId, intentRows: [{ref: "CHK-002:edge:3", desc: "..."}]}`（ref 为 `CHK-NNN:<lane>:<index>` 或行 id，其余键替换该行字段，null 删除；展开成完整 intent 后所有 intent 检查照常；与 verificationIntent / intentProposalApproval 同用、未知 ref 等拒绝 `[intent_rows_invalid]` 并给一条 `Next:`）。item 的 verificationIntent 或 userSees 与派发时提交的版本不同，或 item 已写出冲突所说 request 推出的值、不再含被钉住的字面量，冲突即解除（old-PoS run 31：冲突点名 userSees、verificationIntent 派发时已正确，旧判定只比 verificationIntent，owner 改了 userSees 也一直卡住）。
- PLAN 里不带 `status` 的 `checklist_update` 改了 done item 的 verificationIntent 语义或 userSees 时，框架把它、以及 context / userSees / intent 里点名它的 done item，自动退回 pending 并在 auditLog 记原因（run 31 owner 曾手动重置）；不要手动重置。
- **pin oracle（old-PoS run 31，`core/pin-oracle.ts`；opt-in，old-PoS run 33 起 bench adapter 只在 `bench.pinOracle=on` 时声明）**：项目可在 `proof-or-stop.config.json` 声明自己的求值器 `pinOracle`（`command`、含 `{file}`/`{tree}` 的 `args`、含 `{input}` 的 `program`、`extension`、可选 `setup`/`skipPattern`/`timeoutMs`/`env`）。声明从 Story base commit 读取，并在该 commit 的 `git archive` 里运行（只跑 base 自己的代码，不跑 Story 改动、隐藏测试或任务答案表）。`<input> -> <value>` 例子行的输入在 base 上算出别的值时，`checklist_update` 拒绝（`[pin_oracle_mismatch]`，给出算出的值和一条 `Next:`），除非该行用 `"baseValue"` 记下这个 base 值（Story 有意改变该行为）；已存储的不一致由 `next` 的 `pin_oracle_mismatch` 在 scope-plan reviewer 之前拦下。base 跑不了的输入（新语法）静默跳过；例外（old-PoS run 32）：声明了可选的 `parseErrorPattern`（命名组 `line`/`col` 给出第一个解析错误的位置）与 `newSyntaxPattern`（request 新语法的正则，按程序行匹配）时，解析错误落在新语法区域内（±1 列）才是预期的跳过，落在区域外则是例子本身写错，报为 mismatch（`parse error outside the new syntax`，`baseValue` 不能豁免）；`probeRunner` 里的同两项驱动 PLAN 的 `probe_row_syntax`。框架从不改写 pin。声明了 oracle 时，scope-plan 的 pin audit 拿到 oracle 命令，用它算 base 支持的子表达式并审核 `baseValue`。
- **INIT+PLAN 减负（lab `codex/lab-plan-light`，三个 EXPERIMENTAL A/B 开关，默认 off，每个 arm 只开一个；`core/plan-pin-probe.ts` / `core/plan-review-merge.ts` / `core/plan-row-budget.ts`；docs/CLI.md「Lab plan-light switches」）**：`plan.pinProbe=on`：PLAN→DEV 前框架用项目声明的求值器（`probeRunner`，否则 `pinOracle`，从 Story base commit 读取）在 Story base 的 archive 上跑每条可抽取的例子行（`itemProbeCases`：箭头、散文连接词、语句与写入，隔离与累积两种运行）；base 能算出值的 case 视为未改变的行为，pin 不一致且该行没有 `baseValue` 时拒绝；错误 pin 只和同一消息族的 base 错误比较（去掉 runner 前缀如 abs `&{` 后至少 12 个前导字符相同）：现有错误格式写错时拒绝并给出 base 错误；其他错误（base 没有该函数、无法解析新语法）、新语法、未绑定名是新行为，跳过。另外（不需要求值器）request 以字面量给出的例子（单个反引号内 `in -> out`，或两个反引号片段由 `->`/`→`/`=>`/returns/gives 等连接）对同一输入的行必须 pin 该输出。DEV gate（在 scope-plan 要求之前）返回 `[pin_probe_mismatch]`，列出行、输入、pin 值与观测值，并给唯一 `Next:`（`checklist_update` 的 `intentRows` 行补丁）；`next` 在 dev-memory ack 之后、scope-plan reviewer 启动之前给出同一步。框架从不改写 pin；记录在 `.proof-or-stop/runtime/plan-pin-probe/<storyId>.json`（含 `abVariant`）。`plan.reviewMerge=on`：不启动 INIT reviewer；当 PLAN scope-plan 裁决对该 Story 必需（`planScopeCheckRequirement`）时，INIT_CHECK gate 不再要求 `init-check.json`，否则 INIT reviewer 仍必需；唯一的 scope-plan 会话在计划完整后运行，prompt 增加「Merged plan review」块，同时回答 INIT 问题（每个 item 有可观察结果和能区分成败的检查、对现有系统的陈述按代码核实），只记录真实 gap 和 owner 必须回答的问题（ADR-040），措辞 / 可读性 / 术语 / 测试穷举类意见不进裁决；request trace、pin audit、exclusion-rationale 检查不变。重跑是 confirmation re-review：prompt 列出变化的 item 与未变 item 的上次 covered/excluded 行（reviewer 原样复制），只重判 flagged 行与变化的 item；无法重建被判 checklist 时退回完整审查。`scope-check.json` 记录 `planReview: "merged"` 与 `abVariant`（签名域外）。`plan.rowBudget=on`：story_create 模板加指引（每个不同行为 / 操作数类一行，不要同一类的多个字面量例子；绝不删 request 字面量例子或 exact-text 行），并做不阻塞的软检查：每个 case 都重复同 item 更早一行的操作数类签名的行，由 `story_create` 列出（`[row_budget]`，每个 item 一条删除这些行的 `checklist_update`），PLAN 的 `story_review` 给 `row_budget` advisory。bench arm：`POS_AB_FLAGS='{"plan.pinProbe":"on"}'`（adapter 同时声明 profile 的 pin oracle）、`'{"plan.reviewMerge":"on"}'`、`'{"plan.rowBudget":"on"}'`。测试：`plan-light-smoke`，harness `PL`（NPP、NPM-I、NPM-P、NRB）。
- finding-repair 改变某个输入的处理方式（null / 0 / 负数 / 空 / 省略 vs 显式）时，要在 Story base 与修复后分别跑该 finding 的输入及其字面变体，request 没改的变体保持 base 行为；reviewer 的「Fix:」只是建议（run 24：按 Fix 把显式 `null` 当成省略，多出第三轮）。
- **implementer 探针矩阵（old-PoS runs 24-30；old-PoS run 33 起为 A/B 开关 `implementation.probeMatrix=on`，默认 off，只留一行：任何合法形式都不得崩溃，显式 null 不等于省略；`[probes]` / `[probe-row]` 报告约定与 `probe_tests_missing` 也只在 on 时）**：DEV implementer prompt 带 `IMPLEMENTER_PROBE_MATRIX` 与 Story base SHA：item 涉及的操作数位置 × 值类（省略、显式 null、等于默认值的显式值（step 1、start 0：走本形式的语义，不走别的形式的路径；run 30 F-004）、0、负数、越界、非数字/错类型、空接收者、多字节文本、被赋值本身别名）× 操作（读、写/赋值、stringify、错误路径、相邻接收者类型）；适用的行在 base 与改动后各跑一次，request 没改的保持 base 结果，任何行不得崩溃或未检查的类型断言，省略与显式 null 按源语法区分，改动决定的行必须有测试（只探针不算）；最终结果报告 `[probes] <n> rows run on base and change; changed: <row: base -> new> | none; tested: <rows> | none; probed-only: <rows> | none; crashes: none`（implementer 模板返回格式同步）。`next` 解析 probed-only：done item 最近一次 completed implementer run 留下未测的已决定行时返回 `probe_tests_missing`（owner 一步 `checklist_update` 回 `in_progress` + reason；重派的 implementer prompt 点名上次 run 与这些行），重派后报同样的行不再重开（交给 REVIEW）。prompt 代价：runs 24-29 版 +1,309 B，run 30 再 +326 B（矩阵段 1,064 → 1,390 B）；模板 +243 B，run 30 再 +138 B。
- **request 锚定探针（old-PoS run 31，`core/request-probes.ts`；old-PoS run 33 起拦截是 A/B 开关 `dev.probeEnforcement=enforce`，默认 `advisory`：done 打印不一致的行、从不拒绝，`next` 从不 reopen / 升级，`probe_row_syntax` 不出现，REVIEW lane 仍拿到表；一行里串起来的独立例子除累积程序外还从行前导单独运行，哪个满足 pin 按哪个判；`[probe-row] <row> | ok: <why>` 也能处置 `pin` 标记）**：intent 行里每个可执行例子（`<input> -> <value>`，一行可多个 `;` 分隔的 case，`over` / `s='hello';` 绑定接收者，写入比较接收者，`error starts with '...'`；行内没绑定的变量借用同 item 其他行最常用的绑定）都是探针 case，经覆盖矩阵（`caseRequirements`，写跟随读时带上读侧句子）锚定到定义它行为的 request 句子；句子给某操作数值类（显式 null、非数字、step 0）一个错误时，该 case「request 期望错误」并带句中引用的错误格式前缀，值 pin 或格式外的错误 pin 即「pin 与 request 矛盾」。scope-plan pin audit 列出这些行和句子（S1..Sn）并标出矛盾（run 31 DEV 起点 checklist：恰好 F-006/F-008 的 8 个 null 行）。无 probe runner 时 implementer prompt 保留矩阵（新增：赋值目标的接收者 identifier / member / index-of-index / call result，以及每个写形式 × 显式 null），加上本 item 的锚定行与 `[probe-row] <row> | request: ... | observed: ... | ok|contradiction` 报告契约；未修复也未列入 `[intent-conflict]` 的 contradiction 让 `next` 返回 `probe_request_mismatch`（重开），重派后同样的 contradiction 升级为 owner intent conflict。项目在 `proof-or-stop.config.json` 声明 `probeRunner`（pinOracle 形状 + 可选 `selfTest`，从 Story base 读取）时：框架在 Story base 与 implementer HEAD 的 archive 上跑本 item 的 case（按 material hash 缓存，setup 每棵树一次），表存在 `.proof-or-stop/runtime/probe-tables/<storyId>/<itemId>.json`；flag 为 `request-error` / `request-format` / `pin`（HEAD 符合 request 而 pin 不符时是 pin 错，应列 `[intent-conflict]`）；`checklist_update status=done` 先跑，每组 flag 拒绝一次（`[probe_request_mismatch]`，不写入，逐行附 request 句子），同组第二次记录并附说明；`next` 在最终 HEAD 复查并重开，重派后仍 flag 的行升级为 owner intent conflict；implementer prompt 去掉矩阵与 base worktree 行，换成紧凑契约（不写探针程序）；REVIEW lane 拿到 `Framework probe evidence`。old-PoS run 32：抽取按顺序保留一行的每条语句（`h.a[0:2]=[9,8]`、`a=f()`、`f(){...}` 整段保留，prose 标签后的赋值保留；行内语句赋值过的裸标识符可作 case），抽不出的有副作用片段记为 dropped，该行不跑、不 flag，并与其他探针不会运行的行一起列在 PLAN `enter_dev` 步骤里；探针表以 HEAD material + base + rowsDigest 为键，行被改成零个可运行 case 时清空表和 flag 集，flag 记录 item 的 intent hash，flag 之后 intent 变了则重开而不升级；声明了 `parseErrorPattern` + `newSyntaxPattern` 时，base 在新语法区域外解析失败的行不算代码 flag，PLAN 返回 `probe_row_syntax`。exact text（run 32 F-001，`core/exact-text-assertions.ts`）：所有 item done 后，Story 新增的测试函数若只通过 prefix / contains（直接或经包装它的 helper，如 `logErrorWithPosition`）比较 request 引用的消息字面量，`next` 返回 `exact_text_prefix_assertion` 重开一个 item（每组一次），重派 prompt 列出测试与 helper；任一精确比较即清除。run 31 回放（abs 镜像，各 item 的 DEV head）：75 个 case，11 个 flag 全部为真（8 个 F-006 null 行 + CHK-005 的 `hooo` / `ABClC` / `éllé` 错 pin），无误报；base 构建 18 s 一次，每个 head 5 s，每 item 运行 0.7-2.3 s，替代 56 个 implementer 回合的手写探针。old-PoS runs 35-39：runs 35/38/39 的 owner 行全是散文（`... returns [1, 3]`、`... evaluates to ...`），探针抽出 0 行且无提示。探针抽取开启时（Story base 声明了 `probeRunner`，或 `implementation.probeMatrix=on`），代码输入之后、具体值之前的散文连接词（returns、yields、evaluates to、produces、gives、prints、outputs、becomes）与箭头同样分隔 case（箭头优先）；关闭时（A0）scope-plan pin audit 仍只抽箭头行。仍抽不出的例子形行在保存时报告：`checklist_update` / `checklist_add` 打印 `N rows not extractable`、原因、接受的形式 `<input> -> <expected>`（如 `f([1, 2]) -> 3`）与一条只修补这些行的 `Next: checklist_update {intentRows}`，`story_create` 给同样的警告；implementer 契约、done 说明与 advisory 下的 `enter_dev` 文本都写明这些行，不再静默打印 0。INIT/PLAN 行提示写明箭头形式和通用例子。
- **PLAN 覆盖矩阵（old-PoS runs 24-30，`core/plan-coverage-matrix.ts`；old-PoS run 33 起为 A/B 开关 `plan.coverageMatrix=on`，默认 off，只保留 exact-text 行）**：有 request.md 时以下确定性检查，只在 request 文本模式命中时触发并列出命中的句子：(1) write mirror：request 有「写跟随读」的 same-semantics 句（赋值小节里提到 read/slicing），读侧 intent 测到或另两条检查要求的每个值类（各操作数位置的 省略/显式 null/0/负数/非数字、多字节、空选择）都要有写侧 intent；(2) 省略组合：request 列出 n 段括号语法的省略形式时，2^n 个省略模式（`[start:end:step]` … `[::]`）各要一条运行时（读或写）intent，request 提到「Negative step」还要负的末位；(3) 枚举域：句子对枚举的操作数位置 / 接收者 / 形式陈述某值类时每个成员一条 intent，可省略的非数字操作数还要显式 null。run 30 新增：(2b) request 规定打印 / stringify 形式时，request 写出的每个省略模式一条 stringify intent（30/F-003 `[:101:2]`）；(3b) 赋值小节列出某接收者的多个多段形式（`n-part` 字样或括号段数）并陈述长度规则（size / length / count mismatch、length must match）或「一个值填入所有选中位置」规则时，每个形式 × 规则一条写 intent（30/F-002）；(4) exact-text：request 某行说字符串 must match exactly 时，其下引用的每个字符串要有一条 intent 带上该串并写明精确比较（exact / equals），test-coverage lane prompt 同时带 exact-text rubric（prefix / contains / regex 断言此类字符串是 finding；只在 request 有这类字符串时出现）；实现者与 repair 的 exact-output 段要求精确比较、不用 prefix / contains helper（30/F-001）。缺的行是 PLAN 里 `story_review` 的 `missing_coverage_row` blocker，也进入 `next` 的 pre-scope `plan_authoring`（按规则一条带 pin 的占位 intent，`requestQuote` 预填触发句）；不适用的行用某 item 的 excludes 条目点名其 key 并写原因。scope-plan prompt 带这些检查的判断版。run 31 新增：(3c) 写目标：列出某接收者赋值形式的小节，每个接收者类型要一条 member/property 写目标（`h.s[0] = ...`）和一条 nested-element 写目标（`a[0][0] = ...`）写 intent，另加一条 call-result（`f()[0] = ...`）（31/F-003）；(3d) 可省略的多段语法 + 列出两种以上多段赋值形式时，每个形式要显式 null 前两个操作数的写 intent（31/F-008）。old-PoS run 40 起发布代码里不再有任务族词汇（形式按段数命名 `1-part (single index) form` / `2-part form` / `3-part form`，类名 `length mismatch`、`one value filled into every selected position`、`member/property write target`、`nested-element write target`、`call-result write target`，操作数名取自 request 的命名形式，否则 `part1..n`；不再匹配 `stepped` / `runes` / `broadcast` / `index-of-index` 字样）；在 runs 27-30 的 abs checklist 上默认开启的 request 锚定 pin audit 与默认关闭的 gap 完全相同。abs 请求要求 60 行（runs 24-29 版 34 行 + run 30 的 15 行 + run 31 的 13 行，合并掉 2 条 write-mirror；run 31 DEV 起点 checklist 缺其中 9 行），runs 27-30 的 owner checklist 缺 23-33 行（run 30 新增 7-12 行，run 30 checklist 新增 7 行，其中 6 行对应 30/F-001..F-003）。

### Open Questions (OQ) 通道（B-ed3e）

scope-plan reviewer 按搜索预算契约（B-cee5：完整枚举 `<requirementsDir>/decisions/` 文件名 + candidateSpecSet 有界全文阅读，全目录全文扫描仅限记录 scanEscalationReason 的升级路径）审阅 decisions/ 时，若发现 checklist / decisions 间有**非典型矛盾**（无法归入 covered/excluded/gap/orphan-suspect/drift 任一档），写入第 6 通道 `openQuestions: OpenQuestion[]`：

```json
{
  "id": "OQ-1",
  "q": "description 说 X，但 decisions/foo.md §2 又说 Y，以哪个为准？",
  "evidence": "引用两处原文",
  "sourcePointers": [".proof-or-stop/story/actives/.../index.json#description", "docs/requirements/decisions/foo.md#section-2"]
}
```

**主 agent 必须用 `scope_question_resolve` 书面消解**（reviewer 不会自己写 resolution——这是防自我赦免的刻意设计）：

```bash
proof-or-stop scope_question_resolve '{
  "storyId":"B-xxx",
  "oqId":"OQ-1",
  "resolution":"以 decisions/foo.md §2 为准，原因：<引原文>",
  "sourcePointers":["docs/requirements/decisions/foo.md#section-2"]
}'
```

规则：
- `resolution` 必填（CLI 校验 ≥ 20 字符）
- `sourcePointers` 应引 decisions/ 原文，让后续 reviewer / reader 能追溯
- 重复 resolve 同 oqId 会 overwrite 原 resolution（返回消息含 "overwritten"）
- resolution **不进 scope-check.json 的 `_hash` 签名域**（reviewer 判定不被 main agent 动作污染）
- **PLAN→DEV gate**：`story_review` 把未 resolved 的 OQ 作为 blocker（`type: scope_open_question_unresolved`），必须全部 resolve 才能进 DEV
- 老 scope-check.json 无 `openQuestions` 字段时视为空集，不触发 gate

### 证据链检查（框架负责，永远不是 review finding）

Review finding 只能是真实的产品缺陷。证据链问题（receipt 过期、intent 没有 pinned command 或没有 receipt、
Story diff 里新增/改动的 Go 测试没有被任何 intent 的 pinned `go test -run` 选中）由
`core/evidence-chain-check.ts`（接线在 `handlers/evidence-chain.ts`）在进 REVIEW 前机械检测，每次只给一个 `Next:`：

- `stale_receipt`（must/should）：阻塞 DEV→REVIEW，Next 固定为 `proof-or-stop verification_evidence_refresh_stale --storyId=<id>`；不要逐条 `verification_evidence_add` 重放。
- `missing_receipt`：must 阻塞、should 只提示；Next 是 `verification_run --pending`（已 pin 的 must，一次跑完）/ `verification_run --intentRef`（已 pin 的 should），未 pin 时是**一条** `verification_evidence_batch_add` 模板，覆盖所有未 pin 的缺 receipt intent，`command`/`selector`/`note` 都是 `<...>` 占位符，由 agent 填写；每个 intent 附带排序后的候选测试（测试体里出现 intent 描述中的代码字面量者优先，其次是测试名与描述共享的词）及理由。
- `unbound_test`：只提示；Next 是带该测试命令的 `verification_evidence_add` 模板，`intentRef` 是列出该 item 未 pin intent 的占位符：只在它确实证明某个 intent 时绑定那一个。全部 intent 已 pin（pin 不可改）时无需动作，除非它是某个 userSees 行为的唯一测试（走 `acceptance_amendment_propose`）。`next` 不再把它作为单独一步，只写进下一步的 `why`。
- **测试与 intent 是否匹配是判断，不是机械操作**（run 16）：框架从不替 agent 选测试，从不生成「X proves: <desc>」备注；带占位符的命令在 `next` 里一定是 `agent` 步骤，`next --run` 不会执行它。此前框架把 item 文件里第一个改动的测试当作 `framework` 步骤提出，`next --run` 会把不相干的测试（只测两段式 range 的 `TestParsingIndexRangeExpressions`）永久 pin 给 `myArray[99 : 101 : 2]`。
- **PLAN 就要 pin**：`story_review` 对每个没有 `verification:{command,selector}` 的可执行（logic/cli/browser）must/should intent 报 `missing_verification_pin` blocker（manual/docs、nice 豁免）；PLAN 里用 `checklist_update` 写 pin（测试可以还不存在，implementer prompt 会要求用这些测试名）。有了 pin，DEV 一条 `verification_run --pending` 记完全部 receipt。跳过 story_review 的路径（express 通道、light profile）仍可能无 pin 进 DEV，此时走上面的 batch 模板。
- 选择集是算出来的，不猜：无法计算的 pinned command（make、shell、模块外 import path 等）会跳过扫描并写明原因；JS/TS 不扫描。
- 输出位置：`pre_review_check` / `pre_review_check_read` 文本末尾的 `Evidence-chain check` 段，以及 `story_advance REVIEW` 的 gate。

test-coverage reviewer 只报产品覆盖缺口。reviewer 若仍报证据链项，用 `category: "evidence_chain"`：
`managed_review_evidence_import` 只导入产品 finding（保留 sealed proposal index），只含证据链项的 proposal 以 pass 导入
（note 由 verifier 从 sealed proposal 重算），每项记为 `review_evidence_chain_reclassified` process event，并打印
`Framework next action:`；native `finding_add` 直接拒绝（`evidence_chain_not_a_finding`）。

### Story 元数据 finding（框架负责，不是产品 finding；old-PoS run 31）

Review finding 只能是产品缺陷。缺陷只在 Story 元数据里（checklist.json 的 userSees / verificationIntent 文本、过期 intent）的 finding 是 owner 的 checklist 更正，不是修复工作（run 31：13 条 finding 里 10 条是同一个错 userSees 字面量 `hooo` 和过期 null intent；当 finding 处理花了两轮修复、两次被写范围拦下的 repair run、一次「加代码测试就关闭」的假关闭，以及一个解析 checklist.json 的测试进了 model.patch）。

- **导入时分类**（`core/metadata-finding-class.ts`，只看 sealed proposal）：lane finding 引用的文件含 `.proof-or-stop/...`、其余只是作佐证的测试文件且正文没有非测试产品文件的 `path:line`、正文点名 `CHK-n` 或 `checklist.json:<行>` → 元数据 finding：不写入 `findings.json`，只含这类项的 proposal 以 pass 导入（note 由 verifier 重算），每项记 `review_metadata_finding_reclassified` process event，带它要求的更正（item、字段、引用的错误字面量、reviewer 的值、被评审文本的 digest；`core/metadata-correction.ts`）。同时引用产品代码的 finding 仍是产品 finding，除非（old-PoS run 33）它要求的每条更正都与某个已被重分类的 lane finding 指向同一 item 字段/行（按更正目标而非 lane 分类，`isMetadataTargetFinding`）：那它也是元数据 finding，不派修复，文本更正后直接 `finding_resolve`。inventory critic 的 proposal 不分流（disposition 按 proposal index 绑定）。
- **一步 owner 更正**：`next` 给 `metadata_correction`：一条 `checklist_update`（`metadataCorrection: true`）改被引用 item 的字段（按 item+字段跨 lane、跨轮去重），并把其它 item 里出现同一错误字面量的字段作为同一步的 batch 调用（literal sweep）。userSees 在 PLAN / DEV / REVIEW 原地改（REVIEW 里 `checklist_update` 只允许这一种）；intent 行在 PLAN 外冻结，intent 行的更正先 `metadata_correction_plan` 回 PLAN（old-PoS run 33：REVIEW 里本轮 inventory epoch 仍 OPEN 或有已验证的阻塞 finding 时它排在后面，`next` 先自己跑 inventory begin 与 critic 的启动/导入/finalize）。框架验证被引用文本确实变了（与被评审文本不同、写出了 reviewer 的值、错误的 `a == b` / `a -> b` 陈述已消失），否则拒绝（`[metadata_correction_unchanged]`）；元数据更正不把 done item 退回 pending。
- **不花 review 轮次**：更正的提交（`record <id> metadata_correction metadata`，checklist 只改 userSees）不破坏本轮 managed pass 的 live binding；route 与 reviewer task digest 把已验证的更正视为未变，所以不重跑 lane、不进 remediation 轮（old-PoS run 44 起按 `metadata_correction_applied` 记录的改前文本回退，不需要抽出 reviewer 的值；intent 行更正不回退）。未完成的更正拦 REVIEW→TEST（`review_metadata_correction_open`）。
- 只引用元数据的已存储 finding（critic 或旧数据）永远不派 finding-repair（`[metadata_finding_not_repair_work]`），更正验证后直接 `finding_resolve`。
- **resolution 完整性**（`core/finding-resolution-integrity.ts`）：`finding_resolve` 拒绝引用内容没变的 resolution（`[finding_resolution_unchanged_citation]`）：引用的 checklist 文本必须已更正（代码测试改不了它，拒绝信息给出 `checklist_update metadataCorrection` 命令）；引用的产品文件自 reviewed head 起都没改时，必须有测试文件改动。disposition 与 duplicate coverage run 用各自证据。`plan_acceptance_prepare` / `plan_acceptance_apply` 拒绝 files 和 verificationIntent 都没变的 batch（`[plan_acceptance_noop]`；userSees 用普通 `checklist_update`），apply 只报告真正改了的 item。
- **产品代码不读 PoS 元数据**：REVIEW/TEST/DONE 入口拒绝新增行引用本 Story 元数据目录（Story id 与 `.proof-or-stop` 或 `story/actives` 同行）的产品文件（`[scope_story_metadata_reference]`，`core/story-metadata-reference.ts`）；implementer 与 finding-repair prompt 写明这条规则。
- **pin audit 值更正不重跑 scope-plan**（`core/pin-audit-correction.ts`）：verdict 的 `pin-audit` gap 由 `pin_audit_correction` 一步改（含 pinned 字面量在其它字段的出现）；checklist 自 verdict 起唯一的改动就是这些被要求的值（把它们换回 pinned 值能还原被评审的 `checklistDigest`）时，gap 直接关闭、不重跑 reviewer；其它任何改动照常重跑。
- **owner 上下文**：可读的 `next` 输出上限约 2k token：长 payload 写到 `.proof-or-stop/runtime/next-steps/*.json`，打印 `proof-or-stop <command> @<file>`（任何命令都接受 `@<file.json>` 作为 JSON payload），Why 超 2,400 字符截断并给全文文件；`--json` 不变。多条指向已 resolve canonical 的 duplicate finding 合成一步 `finding_duplicate_resolve_batch`（每条仍跑自己的 coverage；old-PoS run 44 起 duplicate 的 duplicate 对整条链已 resolve 的根关闭，同一 batch）。

### acceptance basis 与 pre_review_check 的顺序约束（B-45a0 F-435/F-438）

**先 `acceptance_basis_generate`，再 `pre_review_check`，顺序不能反。**

`pre_review_check` 会把当时的 plan `basisDigest` 快照进 `priorPlanBasisDigest`，
而 `basisDigest` 覆盖 `binding`（headHash/materialHash/storyFilesHash）与 `receiptRef`。
所以事后再跑一次 `acceptance_basis_generate`——哪怕 acceptance 语义完全没变——也会移动那个 digest，
把刚拿到的 PASS 打成 `PR_COVERAGE_BASIS_CHANGED`（通常伴随 `PR_ARTIFACT_TAMPERED`），
而 `storyFilesHash` 根本没动。

这是**操作顺序陷阱，不是代码缺陷**：fail-closed 符合 Section 9 Rule 3「never a silent pass」（Rule 9 讲的是 coverage-basis freshness，不是这条）。
但补救只能靠重跑 `pre_review_check`，而它是 `allowedPhases: ['DEV']`——
在 REVIEW 撞上这个的 story 无法自愈，必须回 DEV。

代码里已有 `acceptanceCoverageBasisSemanticDigest`（剥掉 `basisDigest`/`binding`/`receiptRef`）
专门识别这种 hash-only rebinding，`verifyAcceptanceBasisReceipt` 也在用；
但要接进 `PR_COVERAGE_BASIS_CHANGED` 的比较需要持久化一个 semantic digest，
因为 `priorPlanBasisDigest` 只存原始 hash。

真相源：`docs/requirements/decisions/proofstory-acceptance-topology-and-pre-review-gates-execution-plan.md`
Section 9 Rule 10。

### TEST→DONE 硬门槛（delivery-check）

TEST 阶段自动 spawn `proof-or-stop-review-delivery` 产出 `delivery-check.json`。`story_advance DONE` 校验：

- delivery-check.json 缺失 → `missing_delivery_check` blocker
- `_hash` 重算不匹配 → `delivery_check_tampered` blocker
- docsPromises 中存在 `verifiedBy` 为空且无 `waiverReason` 的条目 → `unverified_promise` blocker（用 `delivery_waiver_add` 豁免或让 reviewer 重跑）
- transcript/delivery evidence is required; prompt-only user-value claims are not enough。用户最终说“好了”属于 non-mechanical user approval，Proof-or-Stop 不能完全自动证明；DONE gate 只能消费 transcript、verificationEvidence、delivery-check / product-reviewer evidence 或 waiver，不能把普通文本“用户价值已完成”当证据。

Note: `waiverReason` 长度校验（≥ 30 字符）在 `delivery_check_set` handler 调用时抛错，不是 DONE gate blocker。

**Schema**:

```json
{
  "storyId": "B-xxx",
  "docsPromises": [{ "docPath": "CLAUDE.md#section", "promise": "描述承诺", "verifiedBy": "diff/grep", "evidence": "具体证据", "waiverReason?": "≥30字符豁免理由" }],
  "realMachineTests": [{ "featureId": "CHK-001", "transcript": "测试记录", "waiverReason?": "≥30字符豁免理由" }],
  "closingSelfCheck": { "hasRealMachineTest": true, "hasEdgeCaseCoverage": true, "hasUnresolvedTodos": false, "summary": "一句话总结" },
  "reviewRound": "2026-05-12T21:00:00.000Z",
  "_hash": "sha256-..."
}
```

**签名算法**: `SHA256(storyId + JSON(docsPromises) + JSON(realMachineTests) + JSON(closingSelfCheck) + reviewRound + salt)`，salt = `proof-or-stop-delivery-check-integrity-v1`。

**回炉流程**: gate fail → `story_advance DEV` 回炉 → 补齐承诺/测试 → REVIEW → TEST → 重 spawn delivery reviewer → 重签名 → DONE。

**Waiver**: `proof-or-stop delivery_waiver_add '{"storyId":"B-xxx","promiseId":"...","waiverReason":"≥30字符理由"}'`。waiverReason 入 `_hash` 重签名。

### 高风险关键词自动检测

`story_create` 自动扫描命中以下关键词时 elevate priority 到 high：
auth / password / token / migration / destructive / state machine / guard / gate / git restore / reset / production / incident / hotfix / PII / GDPR / breaking change

该 elevate 使用**有效 priority** 覆盖原始输入；即使调用方传 `priority:"low"`，命中 `hotfix` / `incident` / 破坏性 git 等关键词也按 high-risk story 处理，并触发 decision + ≥3 preMortem 等 gate。

**mention-vs-modify 限制与误报回退（B-30b2）**：检测是纯关键词扫描，**无法区分"提及"与"修改"该领域**（设计如此，不做语义分析）。所以一个只是在 description / checklist 里**提及**风险领域、并不实际改动它的 story 也会被 elevate——这是已知误报。命中时 `story_create`（stderr riskHint）和 `story_review`（`risk_signals` advisory）都会显式输出消解引导：若为误报，用

```bash
proof-or-stop story_review_dismiss '{"storyId":"B-xxx","category":"<命中的分类>","reason":"为何是误报（≥5 字符）"}'
```

驳回。**当全部 auto-elevated 的 riskSignal 都被 dismiss 后**，`priority` 自动回退到 `priorityElevatedFrom`、高风险 gate（missing_decision / ≥3 preMortem）解除（CHK-001 行为）；仅 dismiss 部分分类则保持 elevated。用户显式设置的 high/critical **不受 dismiss 影响**（不写 `priorityElevatedFrom` 标记，不会被误降）。未命中 riskSignal 时不输出该引导（不制造噪音）。

### story_create 重复 / 并发警告走 stderr（B-6812）

`story_create` 的全部 advisory 文本——keyword 重叠 `dupWarning`、高风险 `riskHint`、最近并发 story 提示——走 `process.stderr.write`，**不**拼进 stdout 返回值。stdout 只保留创建结论（`Story B-xxxx created ...`）+ 非 advisory 引导（INIT reviewer 提示等）。原因：`proof-or-stop story_create | tail` 这类管道只消费 stdout，advisory 拼进 stdout 会被静默吃掉；走 stderr 后即使被管道也仍可见。

`story_create` 成功后还会扫 `listStoryIds()`，筛 `createdAt` 在过去 30 分钟内且 phase ∉ DONE/DISCARDED 的其它 story，写 stderr：`⚠ 最近 30 分钟内还创建了 N 个 story：B-xxxx [phase] title`，让操作者及时发现并行 agent 在跑同一 backlog。无并发 story 时不输出（不误报）；终态 story、`createdAt` 缺失或非法的 story 都被跳过。30 分钟窗口为硬编码常量（YAGNI，不做配置项）。

### 对抗审查

checklist + plan.md 写完后必须 `story_review` 通过（issueCount=0）才能进 DEV。
检查内容：item 间交叉场景遗漏、Machine 边界完整性（happy/edge/adversarial）、真相源未覆盖的约束。
正常通道额外检查（主 agent 手动）：plan.md 是否覆盖所有 checklist item、DependsOn 是否有环、每个 item 是否声明了 Files 和 Verify。（当前无框架自动检查，后续按需加 `plan_review` CLI）

## 流程事实双层契约

流程事实需要 prompt guidance + hardcoded CLI/handler/gate fallback 两层。Prompt 告诉 agent 应该调用哪个命令、如何表达范围；代码入口负责最终判定、归一、签名、拒绝和 gate 消费。任何会改变流程状态或审计事实的口径，不能只停在 prompt 里。

范围只限流程事实：phase / state transition、pass / no-issue confirmations、finding category / severity / role / agent、review pass、verificationEvidence、init check、scope check、delivery check、REVIEW / TEST / DONE gate artifact。普通解释性 prose、背景说明、设计 rationale 不属于流程事实，除非被 CLI 或 gate 当作证据读取。

执行规则：
- 无 finding / no blocker / 检查通过 这类 reviewer 结论必须用 `review_pass_set` 记录；如果 reviewer 误用 pass-only `finding_add`，handler 必须转换为 review pass。
- `finding_add` 的 category 只接受当前 canonical `happy|edge|adversarial|missing`，已知 legacy `cleanup|doc-promise-undelivered|doc-code-drift|spec-boundary` 只作为兼容输入归一为 `missing`，不能作为 active prompt 示例继续传播。
- Gate 消费结构化事实：签名、hash、verificationEvidence、review pass、init/scope/delivery check 和 validate evidence。不要让 gate 从普通文本“通过/无问题”推断流程事实。
- 改 reviewer prompt、CLI schema、handler 或 gate 时，运行 `npm run test:process-fact-contract`，确认 prompt 没漂移且 process fact inventory 仍能证明硬兜底存在。

## Handler 编码约定

**约定**：凡 Zod schema 有 `min` / `max` / `enum` / 正则 约束，handler 入口和所有消费该字段的 gate / fn 必须在 runtime 再校验一次（不是只靠 Zod）。

**为什么**：Zod 只保证调用路径经过 schema 解析时成立——但 Proof-or-Stop CLI 里同一字段常有多个读取点（handler 入口 / gate 决策 / 统计计数 / 持久化读出），任一绕开 schema 的路径都会放行非法值。B-ed3e F-005/F-006/F-019 的三连翻车证明此路径未来会被意外添加：

- **反面示例**（B-ed3e F-005/F-006/F-019 旧版 scope-question-resolve）：Zod 定义 `resolution: z.string().min(20)`；但 handler 里仅 `if (!args.resolution) throw` 兜底；`trim().length === 0` 的空白串通过 Zod 后被 gate 统计为 resolved，放行 PLAN→DEV。修补路径：handler 加 `trimmedLen < 20 → throw`，但 gate 侧（story-review 的 resolvedCount 判定）仍仅查字段存在而不复核长度，留下第二个漏斗。F-019 最终一次补齐 handler + gate + Zod 三处同步。
- **正面示例**（修复后的 scope-question-resolve.ts）：
  - scope-question-resolve.ts:28-30 runtime `const trimmedLen = (args.resolution ?? '').trim().length; if (trimmedLen < 20) throw new Error(...)`
  - 同文件 gate 判定点（resolvedCount 统计）按同一 `trim().length >= 20` 标准过滤，不只看字段存在
  - Zod schema 的 `.min(20)` 保留作为 API 文档和第一道防线
  这样任何路径（CLI JSON 入口 / 内部 fn 调用 / 测试 fixture）都无法放行 trim 后 <20 的值。

**检查流程**：

1. 新增或修改 handler 时，列出该 handler 所有字段和 Zod 约束
2. 对每个有 `.min/.max/.regex/.enum` 的字段，grep 全仓同名字段的消费点（`rg '<field>\.' --type ts`）
3. 确认每个消费点都做了同标准 runtime 校验，缺的补
4. 写测试时显式构造绕过 Zod 的假数据（模拟老 JSON 或内部 fn 调用路径），断言仍被拒

**新 handler 提交前的自检清单**：[ ] Zod 约束 [ ] Handler runtime 同约束 [ ] 消费点（gate/fn）同标准

## 角色分工

| 角色 | 职责 | 写代码 |
|---|---|---|
| **主 agent** | 需求管理（PLAN + plan.md）+ 分配任务 + 验收（REVIEW/TEST/DONE） | 仅快速通道 |
| **proof-or-stop-implementer** | 写代码 + 写测试，接受主 agent 按 plan.md 分配的 checklist item | 正常通道必须 |
| **proof-or-stop-review-\*** | REVIEW 阶段按 opt-in 路由并行审查（baseline concept+quality+test-coverage，按 riskSignals / touchpoints 加挂 behavior/docs），各自提 finding。`test-coverage` 继承旧 TEST_CASE_REVIEW 职责，只审产品覆盖缺口（userSees/验收行为没有任何测试、断言没检查该行为、断言值与需求矛盾、缺边界用例）；receipt/pin/测试绑定等证据链项由框架在 REVIEW 前检查，不是 finding；`channel` LLM agent 已退役（S1）由 `validate --channel` CLI 接管；`quality` 假设 lint 已绿只审主观项 | 不写 |
| **proof-or-stop-evaluator** | browser 项目产品质量打分（功能完整性 + 可用性） | 不写 |
| **proof-or-stop-evaluator-cli** | CLI / core 项目产品质量打分（通过 bridge API 驱动状态转换验证） | 不写 |

### 两条通道的角色约束

**快速通道**（checklist ≤ 2 项 且 无 riskSignals）：
- 主 agent 自己写代码 + 写测试，一人完成全部
- REVIEW 阶段 reviewer 不检查 commit author

**正常通道**（> 2 项 或 有 riskSignals）：
- **主 agent 不写业务代码**，只做 PLAN + plan.md + 分配 + 验收
- 代码由 proof-or-stop-implementer subagent 写（在主 agent 的 worktree 里，不额外开 worktree）
- REVIEW 阶段 reviewer 检查 commit author——正常通道全是主 agent 写的 → critical finding → 卡住 REVIEW→TEST

**通道实时计算**：不存储，每次进 DEV 时从 checklist.items.length + story.riskSignals 实时判定。checklist_add/remove 改变 items 数量后自动生效。PLAN 阶段新增 item 必须提供 `reason`（≥10 字符）作为 replan/scope audit 信号，避免用 remove+add 静默绕过 title/context 冻结。

### 主 agent 行为准则

- **正常通道必须分配**：用 `Agent({ subagent_type: "proof-or-stop-implementer", prompt: "..." })` 分配
- **fresh worker per item**：每个 CHK-xxx 派一个新的 proof-or-stop-implementer，不复用上下文。prompt 只给该 item 需要的最小信息（storyId + plan.md 对应章节 + 必读文件），不给整段会话历史
- **fresh worker 机械边界**：prompt-only worker claims are not mechanical evidence。可审计证据只来自 `proof-or-stop dispatch` / dispatch/process-event/commit evidence / commit author 等结构化事实。Proof-or-Stop cannot mechanically prove true subagent context isolation，只能证明可观察 assignment evidence；prompt 里说“已派 fresh worker”不能作为 gate 证据。
- **并行条件**：只有同时满足以下条件的 item 才能并行派发：(1) DependsOn 为空或依赖已 done (2) Files 写集不重叠 (3) 不共享稀缺资源。不满足时串行
- **REVIEW Finding handling**: after reviewers return, use `finding_list` to confirm that every Finding was registered through `finding_add`. Every Finding reported only in reviewer prose must be redispatched for structured registration; prose alone is not a Finding. Process each registered Finding. Decide current-Story repair versus routing from applicability, gate impact, and evidence, never from severity alone or a desire to make the repository globally green.
- **Bounded current-Story repair**: the Story Owner must repair a verified applicable Finding in the current Story when it is critical or high, was introduced or worsened by the current Story, directly blocks acceptance, a verification intent, the core user result, or a public compatibility promise, has known or uncertain protected-surface impact, or would make lifecycle gate evidence or gate truth misleading. Severity and applicability are separate axes: severity alone does not decide scope. Every final applicable assessment binds exactly one `dispositionPlan`: `repair_current` or `defer_with_proof`; only an otherwise eligible verified applicable low or medium Finding may use the latter.
- **Evidence-backed routing, otherwise fail closed**: route a defect only when structured evidence proves that it is not applicable to the current Story, names a traceable owner or route, and proves that it does not block the current gate. Critical or high Findings must never be left without a traceable owner. `not_reproduced_under_current_witness` requires fresh target-bound negative command and runtime receipts, signed command-policy and witness bindings, and a live receipted owner or route; an old DONE result is insufficient. Preserve reproduction evidence, impact, and the original Finding. If a defect would otherwise block and its applicability is unknown, keep it in the current Story, including a medium Finding in a policy round where medium is blocking. In enforce mode, `REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown }` places a verified open high or critical Finding in a transient assessment-integrity floor before severity, round, and advisory policy; it does not itself prove applicability or require current-Story repair. Fresh strong non-applicable proof releases that floor, fresh applicable proof converts high or critical to mandatory repair, and weak or invalid proof remains blocked. Invalid claimed deferral lineage is an independent first floor. Only a fresh signed superseding `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying its independent strong proof contract, a signed `disproven` truth transition with current counter-evidence, or complete repair closure releases that lineage floor. Complete repair closure is a distinct release path and does not weaken the exact allowlist for non-repair supersession. `not_reproduced_under_current_witness` never releases claimed-deferral lineage or mandatory repair. Invalid or exhausted deferral lineage also creates a downstream mandatory-repair classification; once that obligation is active, only a fresh signed `MandatoryRepairClassification(state='closure_proven')` clears it, so lineage-floor superseding proof does not clear the whole block. These machine-owned floors do not authorize Story-scope expansion. Never expand the Story merely to make the repository globally green.
- **Dynamic Finding activation boundary**: the official commands are `finding_applicability_assess`, `finding_applicability_batch`, `finding_deferral_record`, `finding_mandatory_repair_close`, `finding_triage`, and `finding_rollout_scorecard`. `observe` remains the default compatibility result, `warn` compares without changing gates, `enforce` activates signed assessment/disposition authority, and `killSwitch=true` restores the legacy predicate. Only official handlers may sign assessment, route binding, disposition, freshness, lineage, and manifest facts. `finding_dismiss`, gaps, backlog entries, and prompt prose remain compatibility accounting and prove neither applicability, repair, resolution, nor deferral; never use them to erase or rewrite the original observation.

## Agent prompt 资产：host-neutral 单一源（B-097f）

Proof-or-Stop agent prompt 的**正文（body）只有一个真相源**：包内 registry 模板 `packages/main/templates/agents/*.md`（其指纹清单 = `promptRegistryManifest()`，仅元数据非正文）。**任何宿主目录都不物化正文**——每个宿主只留一层 thin 适配，正文经 `proof-or-stop agent_prompt`（内部 `readPromptTemplate` 读模板原文）现取。改模板 → 所有宿主下次取到的就是新正文，不存在陈旧快照。

| 宿主 | 项目/全局里的薄适配 | 正文来源 |
|---|---|---|
| Claude | `.claude/agents/*.md` thin-shim（frontmatter `name`/`description`/`tools` + body 写「run `proof-or-stop agent_prompt --role=<name>`」，**无正文**） | `proof-or-stop agent_prompt`（registry） |
| Codex | `.proof-or-stop-codex/proof-or-stop.json` manifest（`promptMode: 'registry'`，B-4ee0） | 同一 registry |

- **取正文命令**：`proof-or-stop agent_prompt --role=<name>`（如 `proof-or-stop-implementer` / `proof-or-stop-review-concept`），从 registry 吐角色正文；非法 role 列出可用 role。Claude shim 取它，Codex manifest 指它，两者 byte-equal 同源。
- **spawn**：主 agent 使用 `Agent({ subagent_type: "proof-or-stop-review-*" })`。shim 的 `tools:` frontmatter 保留宿主**只读沙箱**（reviewer 改不了文件）；被 spawn 的 reviewer/implementer **第一步运行 `proof-or-stop agent_prompt --role=<自身角色>` 取权威指令**再执行。
- **init 行为**：`proof-or-stop init` 往**项目里写 0 个 agent 文件**；17 个 thin-shim 一次性放在全局 `~/.claude/agents`，所有项目共用。
- **迁移显式**：已有 project-local 管理文件时，普通 `init` 只 WARN 不删；删除/迁移仅在 `proof-or-stop init --upgrade`，且只删 17 个管理 basename、保留用户自建文件。`proof-or-stop doctor` 报 `agentAssetMode: runtime-owned`。
- **角色数量**：registry 共 **17** 个 role 模板（`scripts/verify-proof-or-stop-prompt-baseline.mjs` 的 `EXPECTED_ROLE_COUNT = 17` 钉住），其中 **13** 个带 `proof-or-stop-` 前缀。这 13 个 role ID 是当前 `subagent_type` 值，旧前缀 role 不再解析。
- 真相源：`docs/requirements/decisions/lifecycle-artifact-scope.md` →「Policy: host-neutral prompt content, thin host adapters (B-097f)」+ runtime-owned Agent assets 的当前实现状态。

## REVIEW 阶段规则（框架实现）

### Verification Intent / Evidence

第二套流程不恢复 `TEST_CASE` / `TEST_CASE_REVIEW` 两个 phase；旧 testIntent 的纪律折叠进 checklist：

| 字段 | 阶段 | 含义 |
|---|---|---|
| `verificationIntent` | PLAN | 每个 item 的 happy / edge / adversarial 验证意图；normal/high-risk/strict story 三栏必填 |
| `verificationEvidence` | DEV/REVIEW/TEST | 覆盖某条 intent 的证据，可为 logic_test/integration_test/browser_test/manual_transcript/docs_check/waiver；CLI 也接受 `logic`→`logic_test`、`cli`→`manual_transcript` aliases |

Express channel（≤2 checklist items 且无 active riskSignals）允许 PLAN 阶段 intentionally skipped `verificationIntent`。这不是 reviewer 文案豁免，而是硬编码 flow fact policy：`flow-policy:express-verification-policy` / `express-exempt`。用户可见输出必须是：

```text
Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped)
```

fast / normal channel 的 zero intent 只能显示普通缺失文案，不能显示 `express-exempt`。

常用命令：

```bash
proof-or-stop checklist_update '{"storyId":"B-xxx","itemId":"CHK-001","verificationIntent":{"happy":[{"desc":"正常输入返回成功","type":"cli","priority":"must"}],"edge":[{"desc":"空输入给出清晰错误","type":"cli","priority":"must"}],"adversarial":[{"desc":"非法状态不会写坏数据","type":"logic","priority":"must"}]}}'
proof-or-stop verification_evidence_add '{"storyId":"B-xxx","itemId":"CHK-001","intentRef":"CHK-001:happy:0","kind":"integration_test","file":"validate.ts","command":"proof-or-stop validate --story=B-xxx","result":"pass","note":"integration test 直接覆盖正常输入路径"}'
```

`DEV→REVIEW` 会阻塞缺失 must evidence/waiver 的 intent；`proof-or-stop validate --story=B-xxx --json` 会输出 verification coverage，并写入 TEST evidence 供 DONE gate 展示。

#### Narrowing-only re-pin of a proof selector (B-1482)

The pin an executable intent carries (`verification:{command, selector}`) is
immutable, and **loosening it stays refused everywhere** — no phase, caller, flag,
waiver or reason accepts a selector that matches strictly more runs, and the pinned
command never changes. Exactly one movement is allowed: a re-pin to a STRICTER
selector on the SAME command, via `verification_pin_narrow`.

```bash
proof-or-stop verification_pin_narrow '{"storyId":"B-xxxx","itemId":"CHK-001","intentRef":"CHK-001:happy:0","selector":"status: plan","reason":"the pinned selector is printed on every branch, so it matched a failing run; re-pin to the status discriminator"}'
```

It exists for the B-a745 class: a selector pinned to a string the command prints on
every branch matches runs that genuinely failed, so the receipt records a
passing-shaped match for a failing run.

**The proof reads current signed V5 receipts only.** Legacy combined and Bundle V2/V3/V4
receipts remain readable for audit but cannot authorize narrowing, even when they
carry a plausible selector. There is no transcript, output or
receipt parameter; a request carrying one is refused before any proof is attempted
(`narrowing_caller_output_not_admissible`), so an offered rendering can never be
considered and then ignored. The caller supplies only the story, item, intentRef,
candidate selector and a reason of at least 30 characters — the reason is retained
for attribution and is never itself the proof. A narrowing is accepted only when
recorded receipts show the candidate ABSENT from the complete authenticated output
of at least one recorded FAILING render the current selector matched, PRESENT in
EVERY recorded passing receipt, and recorded on the same story material. Every
direction, presence, and absence check uses the complete authenticated output artifact,
including selectors before its retained-tail boundary. `outputTail` is a bounded
display-only projection and must equal the canonical tail derived from that artifact;
a mismatched projection is refused with `narrowing_recorded_receipt_invalid`.

**Bound: a recorded-receipt set admits at most one narrowing.** The set's digest is
retained on the accepted record and re-checked FIRST, before the proof — so a second
narrowing against unchanged receipts is refused even when it would be provable
against exactly those receipts. Unlocking another one requires new recorded
evidence: a genuine failing run the already-narrowed selector still matched.

Refusal codes: `narrowing_caller_output_not_admissible`,
`narrowing_unknown_input_field`, `narrowing_selector_empty`,
`narrowing_reason_too_short`, `intent_ref_unresolved`,
`narrowing_intent_not_executable`, `narrowing_intent_not_pinned`,
`narrowing_receipt_set_unchanged`, `narrowing_selector_loosens`,
`narrowing_selector_not_discriminating`, `narrowing_no_recorded_failing_render`,
`narrowing_no_recorded_passing_receipt`,
`narrowing_selector_absent_from_passing_receipt`,
`narrowing_receipt_selector_unknown`, `narrowing_receipt_material_mismatch`,
`narrowing_selector_unchanged`, `narrowing_no_recorded_receipts`,
`narrowing_receipt_not_predating_request`, `narrowing_recorded_receipt_invalid`,
`narrowing_recorded_receipt_not_authoritative`.

**What is and is not bounded.** Mechanically enforced: the witness must be a current
signed, authoritative V5 receipt of the same pinned command, judged and matched by the current
pin, recorded on the same story material as the compared passing receipts, and
predating the request; the candidate must also match every recorded passing receipt;
and the set is spent afterwards. Not bounded: an operator who can drive that command
to fail on the same material, because no receipt records why a run failed. That is
an **accepted limitation**, not a bound — do not describe it as prevented, detected
or ruled out. Full record: `docs/requirements/decisions/narrowing-only-evidence-repin.md`.

#### pinned command 超时：独立报错 + 有界受审计的 timeout override（B-cdf6 / B-META F-012）

executable intent（logic|cli|browser）的 evidence 会真的 **执行** pinned command 并按实际 exit + selector 命中派生 `result`。该执行有一道 **wall-clock 上限**：`DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS = 270_000`（`core/validation-executor.ts`）。

- **超时是独立报错，不再伪装成 selector 问题**：命令被上限杀掉时抛 `[receipt_command_timeout]`，并写明**实际武装的预算**与已耗时；不再落到 `[receipt_selector_absent]`。原因：被杀的进程根本没来得及打印判定行，selector 必然缺失，旧文案会把「预算不够」误导成「selector 写错了」（F-012 记录了连续三次在 ~270.3s 被拒、先误判为 stdout 捕获问题、再误判为 clean-tree 断言的过程）。跑完但确实没打印 selector 的命令**仍然**报 `[receipt_selector_absent]`。
- **有界受审计的 override**：`verification_evidence_add` / `verification_evidence_batch_add` 接受 `commandTimeoutMs` + `commandTimeoutReason`，让「根 DONE-blocking 测试套件（21-24 分钟）」这类合法长证据也能挣到**真 receipt**，而不是被迫走 `nonMechanicalReason` 或 waiver（`deferred_gate_evidence` waiver 不计入 acceptance coverage，story 会死锁）。

| 约束 | 规则 |
|---|---|
| 上限 | `EVIDENCE_COMMAND_TIMEOUT_CAP_MS = 21_600_000`（6h）——覆盖完整的历史回放与成对动态验证保证活动；**边界含等号**（恰好等于上限允许） |
| 超上限 | **拒绝**（`[command_timeout_above_cap]`），**不静默 clamp** |
| 理由 | `commandTimeoutReason` 必填且 trim 后 ≥ 30 字符（同 `nonMechanicalReason` 口径），否则 `[command_timeout_reason_too_short]`；只给理由不给预算 → `[command_timeout_reason_without_override]` |
| gate 可见 | 武装的预算记在 **tool-owned receipt** 上：`receipt.timeoutMs` 恒记录，raise 时另加 `receipt.timeoutOverride{timeoutMs, defaultTimeoutMs, reason}`。receipt 块被所有 caller-facing schema `.strip()`，故**无法被 caller 注入**到实际按默认预算挣到的 receipt 上；handler 输出也追加 `timeoutOverride=<n>ms` |
| 不削弱既有检查 | selector 仍必填必命中；`result` 仍由真实 exit + selector 派生；矛盾的 caller `pass` 仍被拒 |
| 默认路径不变 | 不传 timeout 时行为与 B-cdf6 前**逐字节一致**（270s 默认、不写 override 块） |
| refresh 不衰减 | `verification_evidence_refresh_stale` 从上一份 receipt **继承**该 override（否则 raise 会变成一次性：下次 refresh 按 270s 重跑被杀 → 静默降级） |
| `verification_run` | **刻意不提供** override（它的卖点就是 caller 什么都不写、命令只来自 pin），保持默认预算；超时同样报 `[receipt_command_timeout]` |

**双层校验（Handler 编码约定）**：Zod（`command-catalog.ts` 的 `.int().positive().max(CAP)` / `.min(30)`）只是第一道防线；`resolveEvidenceCommandTimeout` 在**两个 handler 入口**和**共享执行边界 `enforceAndStampEvidence`** 各再校验一次，故绕开 Zod 的内部 fn 调用 / 老 JSON 同样被拒。cap 与 default 常量由 `core/validation-executor.ts` 单点导出、schema 与 handler 同时 import，两层不会漂移。

**注意外层 CLI watchdog 仍然生效**：默认 5 分钟无输出 / 15 分钟总时长即被外层 watchdog 杀掉（`cli-engine.ts`）。所以一条静默跑多分钟的 pinned command，除了 `commandTimeoutMs` 还需为同一次调用抬高 `PROOF_OR_STOP_IDLE_TIMEOUT_MS` / `PROOF_OR_STOP_MAX_TIMEOUT_MS`。超时报错文案里会提示这一点。

#### verify_codex heartbeat 超时：独立报错 + 有界受审计的 override（B-cdf6 / B-META F-013）

`verify_codex` 的 **Global fallback heartbeat** check 会执行真实安装的 `proof-or-stop session_brief` 来证明 global-fallback 入口**有响应且会记 activity**。该执行的默认预算是 `DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS = 30_000`（`core/codex-adapter-checks.ts`）。

- **超时是独立报错，不再伪装成 adapter 缺陷**：命令被预算杀掉时报 `[heartbeat_command_timeout]`，写明**实际武装的预算**、已耗时、以及「这是预算结果、不是入口坏了」。旧文案把被杀进程的 stderr 进度行原样当失败原因输出（`heartbeat command failed: [0.1s] running session_brief...`），读起来像 adapter / 品牌缺陷，导致排查方向完全跑偏。**真的跑完并报错**的命令仍然报原来的 `heartbeat command failed`。
- **为何不换更便宜的探针**：`session_brief` 是 `classifyRuntimeEntrypointAuthority`（`core/runtime-environment-checks.ts`）里**唯一**被硬编码豁免 `stale_global_runtime_in_worktree` 拦截的命令（`input.command === 'session_brief' && CODEX_ENTRYPOINT === 'global-fallback'`）。在 story worktree 里，global CLI 跑 `status` / `next` / `help` 全部在 dispatch 前被拦掉、**不写任何 activity 行**，因此无法当 liveness 探针；`runtime-entrypoint-authority-smoke.ts` 还显式断言 `help` / `version` / `check --help` **不得**成为 fallback 豁免。换便宜命令 = 要拓宽一个刻意收窄的安全豁免面，所以**刻意保留完整 `session_brief`**，只把预算做成有界可审计的。
- **成本来源是仓库规模**：`session_brief` 要先聚合所有 active story 才写 heartbeat（本仓 319 条 → ~101s），CLI 启动只占 0.45s。

| 约束 | 规则 |
|---|---|
| 参数 | `verify_codex` 新增 `--heartbeatTimeoutMs` + `--heartbeatTimeoutReason`（只影响 global-fallback，不放宽 10s 的本地 wrapper 探针） |
| 上限 | `GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS = 600_000`（10 分钟，默认值的一个数量级以上）；**边界含等号** |
| 超上限 | **拒绝**（`[heartbeat_timeout_above_cap]`），**不静默 clamp** |
| 理由 | `heartbeatTimeoutReason` 必填且 trim 后 ≥ 30 字符，否则 `[heartbeat_timeout_reason_too_short]`；只给理由不给预算 → `[heartbeat_timeout_reason_without_override]`；非正整数 / 字符串 → `[heartbeat_timeout_invalid]` |
| 可见 | 武装的预算 + 理由追加进该 check 的 detail：`(heartbeatTimeoutMs=<n>ms override armed, default 30000ms; reason: ...)` |
| 不削弱既有检查 | 仍要求 activity 行存在、`source=codex`、entrypoint 匹配、session token 已脱敏；非零退出 / 无 activity 仍 fail |
| 默认路径不变 | 不传 override 时行为与 F-013 前**逐字节一致**（30s 默认、detail 无后缀） |

**双层校验（Handler 编码约定）**：Zod（`command-catalog.ts` 的 `.int().positive().max(CAP)` / `.min(30)`）只是第一道防线；`resolveGlobalFallbackHeartbeatTimeoutMs` 在 **`verify_codex` handler 入口**和 **`runCodexAdapterChecks` 核心入口**各再校验一次，故绕开 Zod 的内部 fn 调用 / 老 JSON 同样被拒。cap / default / 最小理由长度由 `core/codex-adapter-checks.ts` 单点导出、schema 与 handler 同时 import，两层不会漂移。回归 smoke：`packages/main/src/tasks/codex-heartbeat-timeout-smoke.js`（含被杀 → 报超时、真坏 → 仍 fail 的负向用例）。

### CLI gate（REVIEW→TEST preflight，机械判定，秒级返回）

进入 REVIEW 后由 `story_advance --phase=TEST` 自动跑 CLI gate，任一 fail 即 block 推进：

| gate | 命令 | 职责 | 失败处理 |
|---|---|---|---|
| channel | `proof-or-stop validate --channel --story=B-xxx` | 正常通道必须有 dispatch/subagent_result 结构化证据；commit author 仅作 legacy fallback | fail → block REVIEW→TEST |
| concept | `proof-or-stop validate --concept` | 扫 `git diff main...HEAD` 抽 deleted symbols + 全仓 grep 残留引用 | ≥ 5 残留 → 触发 concept reviewer；< 5 → skip |
| lint | `proof-or-stop validate --lint` | tsc / ruff / import-graph（shells 不得 import fn.ts） | fail → block；工具缺失 → skip |
| docs-drift | `docs-drift` preflight | 校验 reviewer/流程文档引用的 proof-or-stop 命令与 registry 对齐 | fail → block REVIEW→TEST |
| codex-adapter | `node bin/proof-or-stop-codex.js verify_codex` | 仅当 story 触及 Codex adapter 入口资产时要求 adapter 证据 | 缺失或 stale → block REVIEW→TEST |
| english-artifacts | `english-artifacts` preflight (B-5f42, no standalone flag; standalone `npm run test:legacy -- english-only-guards`) | 本分支 commit + 当前 story 元数据必须英文(CJK 触发 fail); captured program output (`outputTail`/`stdout`/`stderr`/`actualTranscript`, ...) is exempt; each failure line names the framework fix command and never asks to edit source or tests | fail → block REVIEW→TEST (and TEST→DONE) |
| proof-or-stop-residue | `proof-or-stop-residue` preflight (standalone `npm run test:proof-or-stop-residue`) | 仅 PoS 源码仓库通过 `reviewPreflight.proofOrStopResidue: "enforce"` 显式启用；普通 consumer repo 默认 `skipped`，无需携带维护脚本。启用后执行四个独立 check（见 `scripts/verify-proof-or-stop-residue.mjs`）：**[koala]** 对 product runtime source 零容忍扫无关产品残留；**[brand-prose]** 扫 active docs 与 host Agent mirrors，拒绝仍在教用户调用已退役命令的文案；**[brand-exec]** 扫可执行入口，拒绝退役命令；**[brand-decision]** 扫 product runtime source 的路径判定点，拒绝退役路径参与常规读写。历史签名 salt、不可变证据和显式 one-shot migration 输入由 identity-cutover verifier 的逐文件逐 token 规则校验，不是 active alias。 | 未启用 → skip；启用后缺脚本、配置非法或任一 check fail → block REVIEW→TEST |

`proof-or-stop-review-channel` LLM agent 已退役（S1），由 `proof-or-stop validate --channel --story=<id>` CLI gate 接管；`proof-or-stop-review-concept` 按需 spawn（CLI 残留 ≥ 5 时）；`proof-or-stop-review-quality` 假设 lint 已绿只审主观项。

### REVIEW→TEST gate behavior (`canPassReviewGuard`) + incremental review context (B-f675)

The structured `canPassReviewGuard` gate (`core/machine.ts`, consumed by the REVIEW→TEST transition) decides on reviewer evidence + findings, NOT on free text. Its accurate semantics:

- **An invalid (stale / unknown-run / tampered) current-round binding blocks in ALL rounds.** `collectReviewerEvidenceState` validates every reviewer finding / review-pass against its bound `reviewRunId` (signature, lane, current round, fresh head/material hash, scope binding; plus — for an open FINDING only — the lane's current-latest run, since a PASS is accepted on any current-round fresh run). If any current-round reviewer evidence is invalid, the gate fails closed BEFORE the round split — round 1 and round 2+ alike.
- **Every round: requires a valid current-round verdict from EVERY required lane, plus quorum.** The required set is `computeFinalReviewRoster` (`core/machine.ts` `evaluateReviewVerdict`): the opt-in active reviewers `proof-or-stop reviewer_list` reports (baseline concept + quality + test-coverage, plus behavior/docs by riskSignals / `.md` touchpoints), or — after one consumed remediation inventory — the signed post-remediation selection, which narrows to impacted lanes only on a complete supported impact closure and otherwise keeps every active lane. The round number never narrows the set (the former "round 2+ needs only `>= 1` receipt" shortcut is removed). EXPERIMENTAL `review.deltaRounds=on` (default off, `core/review-delta-round.ts`, docs/CLI.md "Detection A/B variant switches"): a round after a consumed remediation receipt is a delta round whose signed selection (`delta-round`) is the lanes that raised findings last round (in full) plus ONE confirmation lane over the repair scope; it narrows on that evidence, not on the round number, and falls back to the full set on a large repair (> 50% of the Story diff lines), a file outside the previous material, or a pass-verdict confirmation gap; a findings-verdict gap (old-PoS run 52: the confirmation lane's findings proposal now keeps its note, so complete coverage lines are no gap) launches no late lane and makes the NEXT round full (`PREVIOUS_CONFIRMATION_GAP`); a lane whose last-round findings were all closed without a repair (pre-existing, accepted risk, duplicate) is not a raiser. EXPERIMENTAL `review.laneMerge=on|split` (default off, `core/review-lane-merge.ts`, docs/CLI.md "Detection A/B variant switches"): every round's signed selection (`lane-merge`) is the carrier lane of each merged session (`on`: ONE session over every dimension; `split`: TWO run in parallel, concept + quality and test-coverage + docs (+ behavior)), plus the dimensions that run as their own lane (forced, or left uncovered by a merged session's coverage lines: per-checkpoint `[checked]` with a file:line or command output, per-dimension `[read]` list backed by `readManifest.filesReadFully`); an uncovered dimension is never passed, a carrier that left its own dimension uncovered gets its pass refused and every dimension of its session runs separately, and while it is set `review.deltaRounds` is not applied. Missing any required lane, or failing quorum, blocks.
- **Every verified open critical / high / medium finding blocks, in every profile and whichever round raised it (no round decay).** `status=open` AND severity in the closure set (`core/finding-closure-severities.ts`: critical+high+medium in light, balanced and strict alike — every preset's `blockingSeverities` is derived from it, so `workflow_show` reports exactly this set; low is always advisory; the same set in every round) AND `evidenceState` verified-or-missing. Findings from EARLIER rounds count: REVIEW→TEST, DONE's review-verdict predicate, `certification_window_begin` and lifecycle readiness all read every round's findings (`core/finding-closure.ts`). A finding is closed only by `finding_resolve` with repair evidence (incl. `--resolutionType=accepted_risk`, the named accepted-risk record), `finding_resolve --disposition=preexisting_out_of_scope` (old-PoS run 30: the cited `path:line` defect sites are unchanged since the Story base and no scope-contract path, checklist file, scope-boundary entry or request sentence covers them; the framework recomputes that evidence and records it with a follow-up, severity unchanged; `next` proposes it instead of a repair, and `finding_applicability_assess --verdict=pre_existing_unaffected --proposalRef=<finding id>` is the same disposition; old-PoS run 52: a later lane finding whose every defect site is a site of such a disposition that still holds is closed by the framework at import as a recurrence — same signed transition, reason prefix `[preexisting_out_of_scope] Recurring pre-existing finding, closed by the framework at import (recurrence of <ids>)`, no owner step, not a verified family of its wave so a recurrence-only round needs no remediation round; a site the Story edited or a new site stays open; later-round lane prompts list the dispositioned sites), `review_remediation_close`, or an existing `finding_dismiss` record (REVIEW only, never critical). A managed repair run that ends without a commit is relaunched once with its report in the prompt; after a second one `next` returns the Story to PLAN (`finding_repair_replan`). The refusal prints one `Next:` naming the ids and the exact `proof-or-stop finding_resolve --storyId=<id> --findingId=<id> --resolution="<repair commit + passing focused evidence>"` (from TEST: `story_advance --phase=DEV` first). A `finding_resolve` metadata commit in REVIEW is authenticated review bookkeeping (signed open→resolved transitions + their `findings.json` mirror only), so it does not break the managed-review live-head lineage. `suspected` / `disproven` never block. There is no review-round limit.
- **Severity rubric (shared, run 16).** One text, `REVIEW_SEVERITY_RUBRIC` (`core/finding-closure-severities.ts`), is carried verbatim by the REVIEW triage contract (every active lane), the topology/inventory critic template and the managed final-proposal schema's `severity` description: a confirmed regression of existing behavior (a base-to-head behavior change the request did not ask for, documented or not) or a wrong result on a documented or tested path is at least medium; low is only for cosmetic or non-behavioral issues. Low stays advisory (never blocks), but `next` proposes `finding_resolve` in DEV for an open low/suspected finding whose own managed finding-repair completed (`managedFindingRepairState`, same per-finding rule as medium) before `story_advance --phase=REVIEW`, so DONE does not leave a repaired finding open. After DONE, `finding_resolve` / `finding_dismiss` refuse with one `Next:` (the findings belong to the merged DONE record; a write would stay uncommitted on main).

**`proof-or-stop review_incremental_context --storyId=B-xxx --role=<reviewer>`** is a strictly read-only advisory: it returns the reviewer's prior verdict, the `headHash` that verdict was bound to, and the MATERIAL files changed since (rename-aware `git diff --name-status -M`, so a renamed file still counts as changed), plus `scopeChanged` / `isFirstPass`. A first-timer (no prior pass) gets `isFirstPass=true` and the full `main...HEAD` material diff. **It writes nothing and changes none of the gate inputs above** (findings / review-passes / review-runs / currentReviewRound); calling it does not alter `canPassReviewGuard` (proven by `test:review-incremental-context-smoke`).

`isFirstPass=true` is the authoritative "no usable incremental baseline" signal and covers TWO sub-cases: (a) the reviewer never passed before, AND (b) a prior verdict exists but the run it was bound to has an unresolvable `headHash`. In sub-case (b) `priorVerdict` is non-null (informational) while `priorHeadHash` is null and `changedFiles` is the full `main...HEAD` diff — so a JSON consumer must key off `isFirstPass` (not `priorVerdict`) to decide whether an incremental baseline exists. Likewise `scopeChanged` is forced to true whenever `isFirstPass=true`, so it may be true even when `changedFiles` is empty; only when `isFirstPass=false` does `scopeChanged === (changedFiles.length > 0)`.

**Round 2+ scope-change advisory (context only):** when entering REVIEW for round >= 2 the next-step output appends the active reviewers whose scope changed since their last pass (`proof-or-stop review_incremental_context --role=<name>` inspects each). It does not relax the gate: every required lane (see `proof-or-stop reviewer_batch`) still needs a valid current-round verdict.

### Reviewer opt-in 路由（按 riskSignals 挂载）

除了 CLI gate，Round 1 的 LLM reviewer 集合不再硬要 5 个。框架按 story 的 riskSignals / touchpoints 自动挂载 reviewer 子集，基础集合永远开，其余按信号挂载：

| reviewer | 挂载条件 |
|---|---|
| **concept** | baseline（永远开） |
| **quality** | baseline（永远开） |
| **test-coverage** | baseline（永远开，审承诺的行为是否真有测试覆盖，以及断言值是否与需求矛盾；stale/缺失 receipt 与未绑定测试属框架的证据链检查，不报 finding） |
| **behavior** | 某个 riskSignal category 按 `/` 拆分、忽略大小写后含 `state machine` / `guard` / `gate`（story_create 检测器产出 `State Machine/Gate` 即命中；其他类别不挂载） |
| **docs** | touchpoints 含 `.md` 文件 |

**查看当前 story 的 reviewer 名单**：

```bash
proof-or-stop reviewer_list '{"storyId":"B-xxx"}'               # 文本: Active reviewers: concept, quality, test-coverage, behavior (riskSignal: state machine)
proof-or-stop reviewer_list '{"storyId":"B-xxx","json":true}'   # 结构化: {reviewers:[{name,reason}]}
proof-or-stop reviewer_list '{"storyId":"B-xxx","forceReviewer":"docs,behavior"}' # 手动加挂（写 story.events）
```

`story_advance REVIEW` 会 echo 当前 reviewer 名单。gate（`canPassReview`）按 opt-in 实际名单校验，不再硬编码 5。

**Finding 签名验证**：reviewer 的 finding 带签名（`_hash` + `reviewRound`），gate 验签，主 agent 无法伪造。`reviewRound: string (ISO 8601 review round id)`，来自 `story.currentReviewRound`；`finding_add` 自动注入当前 review round 和签名。手动 `finding_add` 伪造 reviewer finding 绕过 gate 不允许。

**story_review 轮次命名**：`story_review.planReviewRound: number (PLAN review round count)` 是 PLAN 阶段 `review.json.reviews.length` 的 1-based 数字计数。`story_review.reviewRound` 只作为 legacy numeric PLAN review alias 保留给旧调用方；它不是 finding / review pass / delivery check 里的签名 `reviewRound`。签名 artifact 的 `reviewRound` 仍必须是 `reviewRound: string (ISO 8601 review round id)`。

**pass-only finding_add 归一化**：low severity 且 agent 为 `proof-or-stop-review-*` 的 pass-only `finding_add`（如 no findings / PASS / 检查通过）由 `core/flow-fact-policy.ts` 的 `flow-policy:pass-only-normalization` 机械转成 `review_pass_set`，写 `review-passes.json`，不写 open finding。含 pass 但同时含 failure / blocker / 缺少 / 失败 等矛盾语义的记录仍是真 finding；非 reviewer 或非 low severity 也不能当作 pass。

### Cluster 聚簇（finding 批量处理）

**一次改动能同时解决多条 finding 时合成一个 cluster**，派一个 implementer 处理整簇，commit 带 `Resolves: CL-xxx` 自动 resolve 簇内全部 finding，避免逐条 resolve。

**自动聚簇依据**：files 交集 ≥50% + severity 完全一致（severity 不同绝不合并，防时序 bug 被并入文件名同簇）。

> B-9d95 CHK-004 起派发统一走 `proof-or-stop dispatch`（itemId / findingId / clusterId 互斥参数）；旧的 `story_dispatch` / `finding_dispatch` alias 已于 B-a4e3 移除（不再可用），一律用 `proof-or-stop dispatch`。

```bash
proof-or-stop finding_cluster '{"storyId":"B-xxx"}'                        # 自动聚簇（按 files ∩ severity）
proof-or-stop finding_cluster '{"storyId":"B-xxx","merge":["F-001","F-002"]}'  # 手动合并
proof-or-stop finding_cluster '{"storyId":"B-xxx","split":"CL-001"}'           # 拆分
proof-or-stop finding_list '{"storyId":"B-xxx","cluster":true}'            # 按 cluster 列表视图
proof-or-stop dispatch '{"storyId":"B-xxx","clusterId":"CL-001"}'  # 输出 implementer prompt（复制给 Agent）
```

**commit 自动 resolve**：commit message 写 `Resolves: CL-001` → `proof-or-stop validate` / `finding_list` 入口自动扫 `git log main..HEAD`，匹配后在 finding 加 `resolvedBy: "CL-001@<sha7>"` 审计字段。引用不存在的 clusterId 输出 warning 不阻塞。`proof-or-stop validate --noSync` 跳过扫描。

**finding_add 传 files**：`proof-or-stop finding_add '{"storyId":"B-xxx","files":["src/foo.ts"],...}'`。旧 finding 无 files 时 auto-cluster 用 desc 正则抽路径兜底。

#### finding_list 返回值结构（F-014 文档化）

`finding_list` 的返回对象随 CHK-003 / CHK-007 扩展，**向后兼容**——`findings` 数组原样保留，新字段为附加元数据：

**默认视图（无 `cluster`）**：

```ts
{
  findings: Finding[],            // 每条 finding 带 evidenceState（缺失按 verified 渲染）
  attention: { suspected: string[], disproven: string[] }, // 非 blocking 的 open finding
}
```

**Cluster 视图（`cluster: true`）**：

```ts
{
  clusters: Array<{
    clusterId, rootCause, findingCount, severity, files, findingIds,
    reviewRound: string,          // reviewRound: string (ISO 8601 review round id)
  }>,
  ungrouped: Finding[],
  reviewRound: string,            // reviewRound: string (ISO 8601 review round id)
}
```

**兼容性承诺**：
- 默认视图的 `findings` 数组始终存在，字段 `id/desc/severity/category/status/agent/createdAt/reviewRound/_hash` 稳定。
- 附加字段（`attention` 等）纯附加，调用方若只读 `findings` 无需适配。没有按轮次的 advisory 标签（轮次递减已移除）。
- Cluster 视图的 `clusters[]/ungrouped[]` 字段保留；`reviewRound` 为附加元数据。
- 严格类型检查的调用方应按 `Record<string, unknown>` 处理新字段，或跟进此文档的 schema 定义。

### REVIEW finding 关闭规则（无轮次递减）

轮次递减（Round 2 只拦 critical+high、Round 3+ 只拦 critical）**已移除**。每一轮、每个 profile（light / balanced / strict）都要求 verified 的 critical + high + medium 关闭（`core/finding-closure-severities.ts` 的 closure 集合；三个 preset 的 `blockingSeverities` 都由它派生，`workflow_show` / `workflow_set` / 同步到 CLAUDE.md 的 profile 段落显示的就是这个集合；low 永远 advisory），共享函数 `isFindingBlocking` / `isDynamicFindingBlocking` 不再随轮次变化，`core/finding-closure.ts` 是唯一来源。

**硬规则**：
- 任何轮次提出的 verified open blocking finding，都必须在 TEST 与 DONE 之前关闭；早先轮次的 finding 同样计数，后续轮次 all-pass 不会让它过期。
- 关闭方式：`finding_resolve` + 修复证据（`--resolution`；接受风险用 `--resolutionType=accepted_risk`）、`finding_resolve --disposition=preexisting_out_of_scope`（old-PoS run 30：finding 引用的 `path:line` 缺陷行自 Story base 起未变，且 scope contract、checklist 文件、scope boundary、request 都不覆盖该文件；框架自行重算证据并连同 follow-up 记入签名 resolve 记录，severity 不变；`next` 直接给出这一步而不派修复（lab run95 起是 framework 步骤：`next --run` 自己记录它，并在同一次调用里启动其余 finding 的托管修复，不要自己修代码），`finding_applicability_assess --verdict=pre_existing_unaffected --proposalRef=<finding id>` 是同一处置；old-PoS runs 36/37：`doc-code-drift:` finding 只把文档锚点当缺陷行，代码锚点是证据，也必须在 Story base 起未变（落在 Story hunk 里则仍修复；lab run110 起 hunk 内的代码锚点改由 base 行为判定：项目声明的 probeRunner 在 Story base 与 HEAD 上跑 finding 自己的 repro，结果相同即算 base 证据、不同即为本 Story 的漂移，无结论时仍按行规则；EXPERIMENTAL `review.driftBaseSymbol` 另接受引用行都在 base 同名符号源码中），被引用的文档若被本 Story 改过也仍修复（lab run110 起 scope contract 排除的文档被改不算，那是 gate 拒绝的越界修改）；lab run110 起前缀前的 `[...]` 标签（如 `[regression-of F-005]`）先剥离再判断；`finding_resolve --disposition=file_state_conflict`（lab run110：唯一补救是修改 scope boundary 排除的文档的 finding，按 request 原文 > scope boundary > reviewer 意见一次裁决关闭，`resolutionType: superseded`、理由前缀 `[file_state_conflict]`，lane finding 在 import 时即由框架关闭，否则为 framework 步骤 `finding_file_state_settled`；含 in-scope 代码缺陷位点的 finding 永不如此关闭）；old-PoS run 52：之后某 lane 重报的 finding，若其每个缺陷位点都属于某个仍成立的 preexisting_out_of_scope 处置（Story base 起未变、不在任何 Story hunk 内），框架在 import 时直接以同一签名 resolve 关闭（理由前缀 `[preexisting_out_of_scope] Recurring pre-existing finding, closed by the framework at import (recurrence of <ids>)`），无 owner 步骤、不派修复，且不计入该 wave 的 verified family，只有此类 finding 的轮次不再开新一轮；Story 改过的位点或新位点仍是 finding；之后各轮 lane prompt 列出已处置位点，要求不要重报）、`review_remediation_close`，或既有的 `finding_dismiss`（仅 REVIEW，critical 不可 dismiss）。
- 修复 run 结束却没有提交：`next` 只重派一次，新 prompt 带上一次 run 的最终报告；第二次仍无提交则 `next` 给出 `finding_repair_replan`（`story_advance --phase=PLAN`），不再重复同一修复。
- `suspected` / `disproven` 保持 advisory，不阻塞。
- critic `duplicate`（run 17 Q1）：REVIEW inventory critic 把 finding B 标成 canonical A 的 `duplicate`（同一根因）时，A 未关闭前 B 不单独派修复；A 修复并 resolve 后，`next` 给出 `finding_duplicate_resolve`：`finding_resolve` 带 `duplicateOf: A` 和 agent 填写的 `coverage: {command, selector}`（跑 B **自己**的 case：A 的修复为它加的测试，或 B 的复现测试）。框架在 Story worktree 用 project `validate.env` 执行这条 allowlisted 命令，exit 0 且输出含 selector 才关闭 B（`resolutionType: duplicate`，receipt 附在 resolution 里）；`ok`/`PASS` 之类泛化 selector 被拒。绝不只凭 critic 标签关闭：失败的运行记入 `duplicate-finding-coverage.json`，`finding_resolve` 拒绝 `[duplicate_coverage_failed]` 并给 `Next: proof-or-stop next`，随后 `next` 给 B 派它自己的 managed finding-repair（why 写明失败的 coverage）。已经绑定了自身修复 run 的 duplicate 走普通修复规则。
- 严重度标尺（run 16，`REVIEW_SEVERITY_RUBRIC`，`core/finding-closure-severities.ts`，原文同时写入各 REVIEW lane 的 triage contract、topology/inventory critic 模板和 managed final-proposal schema 的 severity 描述）：已确认的既有行为回归（请求未要求的 base→head 行为变化，无论是否有文档）或文档/测试路径上的错误结果至少为 medium；low 只用于外观/无行为影响的问题。
- low 仍是 advisory，但 owner 修复了的 low（绑定该 finding 的 managed finding-repair 已完成，`managedFindingRepairState`）会在 DEV 由 `next` 提议 `finding_resolve`，再进入 REVIEW，DONE 不会留下已修复却未关闭的 finding。DONE 之后 `finding_resolve` / `finding_dismiss` 拒绝执行并给出一个 `Next:`（否则元数据会以未提交状态留在主 checkout）。
- light profile 不要求 reviewer，但已记录的 verified critical/high/medium finding 同样须在 TEST/DONE 前关闭。profile 之间不再有 blocking severity 差异（切换 profile 不改变 finding 关闭规则）；`closureBlockingSeverities` 对手工构造的 policy 仍取并集，只能加、不能减。
- 不设 review 轮次上限。

## 合并态组合审查（流程框架并行 story）

单 story REVIEW 只看单个 story 的 diff，看不到「两个各自局部正确的 story 叠加成全局漏洞」的跨 story 交互。**当多个流程框架类 story（触及 dirty/状态 classifier、gate policy、命令入口门禁、auto-commit、DONE merge 语义任一）并行合并到 main 时**，合并后应对 main 的合并态做一次只读 combination review，逐项过分类优先级顺序 / gate policy 表 / 命令入口门禁 / auto-commit-dirty 交互 / DONE merge 语义。普通业务 story 不触发。这是 advisory 流程纪律，不是 CLI gate。规则来自 B-8db9 incident（B-cf60 + B-4b22 各自单 story review 通过、合并 main 后叠加成 CRITICAL gate 绕过）。

> 这里是短摘要。**canonical 详细版（含完整枚举检查清单与 incident 溯源）在 `docs/requirements/decisions/story-lifecycle.md` 的「合并态组合审查」节** —— 以那份为准，本段只作快速提示。

## Defect triage discipline

Fix major or acceptance-blocking defects on the spot. Record non-major, non-blocking
defects with evidence and defer them. Never widen scope to chase all-green.

### Step 1 — classify before acting

For every new defect found during development, first decide: is this a major risk to
the current story, or does it block its acceptance? Do not start fixing before this
question is answered. The reviewer's job is to find; the main agent's job is to triage.

### Step 2 — fix in the current story

Mandatory when the defect is any of:

- verified critical / high / medium severity
- security, data integrity, or destructive-compatibility impact
- blocks the current story's acceptance, REVIEW, TEST, or DONE
- makes already-registered evidence false (a selector that cannot match the real
  verdict, a receipt claiming `pass` for a command that failed) — this is the subtlest
  case and the easiest to wave past

Action: fix, add the regression test, `finding_resolve` with mechanical evidence — the
command run and its actual output, not a description of it.

### Step 3 — record and defer

Applies when the defect is medium / low **and** all of:

- not a direct regression of the current acceptance scope
- does not affect the user's core outcome
- does not distort a lifecycle gate

Action: preserve reproduction steps, evidence, blast radius, and a recommended fix.
Record it in a finding / gap / backlog entry and name the follow-up story that owns it.
Do not widen the current story's scope. Convenience is not a reason to fix out-of-scope
work.

### Step 4 — deferral must be traceable, and is reversible

A deferral decided verbally does not count. It needs a durable, followable record:
`finding_add`, `gap_log`, or a follow-up `story_create` with the evidence linked, plus a
line in this story's resolution or summary saying it was recorded and deferred.

If later evidence shows the severity was underestimated, or the defect turns out to
block acceptance after all, pull it back into the current story immediately. Step 3 is a
classification, not a commitment.

### Why rule 3 has teeth

Green is not the goal; trustworthy evidence is. Never make a check pass by relaxing its
decision rule, widening an allowlist, or bending acceptance inputs to fit your own change.

B-45a0 case: adding files to `REPLAY_ADMISSION_NONEXECUTING_PATHS` looked like a cheap
way to make the replay admission pass. Measuring the actual diff showed the drift was in
`story-aware-validation.ts` — where `discoverValidationInventory` and
`compileValidationCatalog` are defined — i.e. producer-side drift, precisely what that
allowlist refuses by design. The honest fix was re-running the campaign for a fresh report.

Every out-of-scope fix is also another material change: it can invalidate an open review
inventory epoch, re-stale acceptance surfaces, and force another review round.

One-line test: **if this defect goes unfixed, is this story's acceptance conclusion
false?** Yes → step 2. No → step 3.

## Debugging Contract

遇到 `proof-or-stop validate` / reviewer finding / bug 反馈报红时，**禁止直接猜修**，必须先走 Systematic Debugging：

1. **观察（Observe）**
   - 先读完整报错、失败测试名、退出码、最近改动
   - 先确认问题能稳定复现，再进入下一步
   - 不允许"先改改看"

2. **假设（Hypothesize）**
   - 只提出一个当前最可能的根因
   - 假设必须由当前证据支持，不能只凭代码直觉猜
   - 如果是跨模块问题，先比较同仓库里正常工作的相似实现

3. **隔离（Isolate）**
   - 先写最小复现：优先 logicTest，其次 integrationTest
   - 一次只改一个变量，验证一个假设
   - 禁止把多个可能修复混在同一次提交里

4. **确认（Confirm）**
   - 修复后重新跑对应验证，确认原报错消失
   - 必须说明：根因是什么、复现测试是什么、修复为什么有效
   - 如果 3 次尝试仍未定位根因，停止继续打补丁，升级为架构/设计问题讨论

**硬规则**：
- 没有复现，不进入修复
- 没有根因说明，不算完成
- 没有重新验证，不得声明"已修复"

**证据投影**：修 bug 标 fixed 时，用 `bug_update` 的 `evidence` 字段记录调试结论，不要只留在对话里：

```bash
proof-or-stop bug_update '{"storyId":"B-xxx","id":"BUG-001","status":"fixed","evidence":{"symptom":"validate 报 TypeError: x is not a function","reproSteps":["跑 proof-or-stop validate","fn.ts:42 的 guard 返回 undefined"],"rootCause":"guard 函数缺少 default return","fixEvidence":"加 return false 兜底，logicTest guard_missing_default 覆盖","reproTest":"tests/logic.ts#guard_missing_default"}}'
```

**嵌入流程**：
- DEV 阶段：worker 按此 contract 调试
- REVIEW 阶段：reviewer 可卡"没有 repro / 没有 root cause"
- TEST 阶段：主 agent 不只看绿不绿，还看修复证据是否完整（`bug_list` 检查 evidence 字段）

## pre-push hook + 递归 tsc gate

B-5a28 针对「Proof-or-Stop 自举开发」场景引入两条防线：(1) `proof-or-stop validate --lint` 递归扫 monorepo 所有子包 tsconfig，(2) `.githooks/pre-push` 作为独立于 Proof-or-Stop CLI 自身的外部 gate。B-eab3 补齐了第二条（hook 之前只配了 `core.hooksPath` 却没创建文件，全部 git hook 静默失效）。本段记录 hook 的完整行为与启用方式。

**启用方式**（本地配置，不入库）：

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-push` 跟仓库一起提交，启用后每次 `git push` 前先默认拒绝远端写入；非仓库 resolved integration branch 的远端分支 push 直接拒绝，integration branch push 也必须携带 `proof-or-stop release_approve_push --confirm` 写入的短 TTL 一次性 approval，匹配后才继续跑递归 tsc gate。

### 外部防线原则

pre-push hook 的核心设计约束：**不调用旧 CLI alias**。原因：hook 要防御的是全局 CLI 可执行文件版本错位情形；若 hook 自己依赖可能过期的全局入口，它就会跟着翻车（B-9bd9 假 DONE 的根因之一）。实现只用 `git` / `find` / `node` / `npx tsc` / `npm run build`，完全绕开全局 CLI 版本（`node` 仅用于解析 `package.json` 的 `name` 字段做自举仓检测，不调旧入口）。

### hook 行为与容错

`.githooks/pre-push`（跟仓库一起提交，便于跨 clone 复用）逐步行为：

- 临时文件用 `mktemp -d` 创建唯一临时目录，`trap '... cleanup' EXIT` 在 hook 退出时清理（避免并发 push 同名互覆盖、`/tmp` 累积）。`mktemp` 失败 → push 被拒
- 先 `git rev-parse --show-toplevel` 拿 REPO_ROOT
- **远端写入纪律**：读取 pre-push stdin 的 ref update；任何非 resolved integration branch 的 `refs/heads/*` 直接拒绝。resolved integration branch 也默认拒绝，除非由 `proof-or-stop release_approve_push --confirm` 创建的 `.proof-or-stop/tmp/remote-push-approval.json` 的 canonical schema / remote / branch / exact SHA / TTL 全匹配；匹配后 hook 会消费该 one-shot approval。旧路径和旧 schema 不授予审批。Proof-or-Stop 并行开发只使用本地 worktree/local branch，完成后合回本地 integration branch、清理 worktree，并停止在本地。
- **Proof-or-Stop 自举仓检测**：
  1. `$REPO_ROOT/packages/main/package.json` 文件存在——不存在则非 Proof-or-Stop 仓，立即 `exit 0`（对非 Proof-or-Stop 仓零摩擦）
  2. **`node` 可用性检测**：用 `command -v node` 探测。`node` 缺失时 **fail-closed**——无法判断本仓是否 Proof-or-Stop 自举仓，向 stderr 打印明确警告并 `exit 1` 拒绝 push（不静默 `exit 0`，否则 tsc gate 会被无声绕过）
  3. 用 `node` 解析 package.json 的 `name` 字段，只有精确命中 `@proof-or-stop/core` 才继续；否则非 Proof-or-Stop 自身，立即 `exit 0`
  注意本仓是扁平布局 `packages/main`，不是嵌套布局
- **先构建 `packages/main`**：`npm --prefix packages/main run build`。原因是 `packages/utils` 的源码 import `packages/main/dist` 的编译产物，若 `dist` 不存在，递归 tsc 跑到 `packages/utils` 会因找不到模块而 FAIL。`npm run build` 即 tsc（非 Proof-or-Stop CLI 命令，符合约束）。构建失败 → push 被拒
- **递归 tsc**：`find` REPO_ROOT 下所有 `tsconfig.json`（排除黑名单目录 `node_modules / dist / build / .worktrees / .git`），对每个所在目录跑 `npx tsc --noEmit -p <dir>`。覆盖面与 `validate --lint` 递归扫子包对齐，消除 B-9bd9 的单根 tsconfig 子包盲区
- 任一 tsc 非零退出 → hook 以非零退出码拒绝 push

### 递归 tsc 实现

`packages/main/src/handlers/validate-lint.ts`：

- `TSCONFIG_IGNORE_DIRS: ReadonlySet<string>` — 模块级常量黑名单（`node_modules / dist / build / .worktrees / .git`）。**扩展忽略目录需修改该常量本身**，不走函数参数。
- `findTsconfigs(projectRoot, deps?: { readdir?, stat?, fileExists? })` — BFS 扫目录，命中黑名单的子目录剪枝；返回所有 `tsconfig.json` 绝对路径。第二参是**依赖注入接口**（测试用，替换 fs helpers），**不是 options 也没有 `ignoreDirs` 参数**——黑名单由 TSCONFIG_IGNORE_DIRS 常量固定。默认 stat 用 `lstatSync` 且跳过 symlink，防 npm link 场景下节点指回仓库根触发无限递归（F-005）。
- 每个 tsconfig 逐个 `tsc --noEmit -p <dir>`，任一 fail → 整体 fail + 合并所有 stderr。工具缺失判定用显式 `passes` 计数：仅在「从未成功跑过任何 tsc 且从未有 fail」时才视为 skipped；已有 pass 后再遇 toolMissing 当 fail 记录，别静默吞掉前面的 pass（F-007 / F-014）。

**改动前的 bug**：老实现 hardcode `<projectRoot>/tsconfig.json` 单根，avalon 根没有 tsconfig.json → tsc gate 永远 skip → 子包编译错误永远漏检（B-9bd9 翻车根因）。

### 单测策略

`tests/validate-lint.test.ts` 用 `CommandRunner` 类型依赖注入，**不 spawn 真 tsc**。签名：

```ts
type CommandRunner = (cmd: string, args: string[], cwd: string) => {
  code: number;           // 进程退出码；spawn 失败时为 -1
  output: string;         // stdout + stderr 合并后的纯字符串（不区分流）
  spawnError: boolean;    // true = 可执行文件缺失（ENOENT），调用方应视为 skipped
};
```

- `output` 是 stdout / stderr 合并后的单字符串，不是两个独立字段——业务只需「tsc 说了啥」一坨文本，合并简化断言
- `spawnError` 区分「二进制不存在（npx / tsc 没装）」与「二进制可跑但编译失败（exit code != 0）」两种不同语义：前者 skipped，后者 fail
- 测 `findTsconfigs` 的黑名单剪枝逻辑用 fixture 目录树
- 测 `runTsc` / `runLint` 的聚合行为用 stub runner 注入预设返回（模拟成功 / 失败 / 混合 / 工具缺失）
- 好处：秒级反馈、不依赖 tsc 版本、CI 稳定

生产路径用 `defaultRunner`（`child_process.spawnSync` + 合并 stdout/stderr + 区分 ENOENT）。

### 与 CLI gate 的关系

`proof-or-stop validate --lint` 是 REVIEW→TEST preflight 的 CLI gate 之一（见上文「CLI gate」段）。B-5a28 前：lint gate 只扫根 tsconfig → monorepo 子包漏检。B-5a28 后：lint gate 递归扫所有子包 → 子包编译错误直接 block REVIEW→TEST。pre-push hook 是「即使 lint gate 被跳过也兜住」的最后一道防线。

see story/B-5a28

## 规则

- 所有 Story 操作通过 `proof-or-stop` CLI 完成
- 测试统一通过 `proof-or-stop validate` 执行
- `proof-or-stop validate` 全绿 = 可以提交
- 调用出错时先 `proof-or-stop <command> --help`，不要靠记忆猜参数
<!-- proof-or-stop:end -->

## Changelog maintenance

For CHANGELOG.md, prepend only 3-5 concise bullets describing final delivered
changes. Link detailed investigation and audit records instead of copying them.
Read only the current entry or relevant Git diff when updating it; consult older
Git history only for a specific historical question. Do not regenerate the file.
