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
| **PLAN** | understanding → decision → checklist + `verificationIntent` → plan.md（正常通道）→ `story_review` 审查通过后进 DEV（快速通道跳过 PLAN） |
| **DEV** | 写代码 + 写测试，给 must intent 记录 `verificationEvidence`，checklist 全 done 后进 REVIEW |
| **REVIEW** | 按 riskSignals / touchpoints 自动挂载 LLM reviewer（baseline concept+quality+test-coverage，其他按信号 opt-in，详见下方「Reviewer opt-in 路由」）+ CLI preflight gate（`validate --channel` / `--concept` / `--lint` / `docs-drift`，触及 Codex adapter 时另加 `codex-adapter`）在 REVIEW→TEST 自动跑；`proof-or-stop-review-channel` 已退役（S1），由 CLI 接管。主 agent 验收：`finding_list` 确认 reviewer finding 注册 → 逐条 resolve → blocking finding 全 resolved 后经 inventory + PRE_CERT 进 TEST（CLI gate 任一 fail 会直接 block）；整个 REVIEW→TEST 顺序由 `proof-or-stop next --storyId=<id>` 逐步给出 |
| **TEST** | routine `proof-or-stop validate` 已在 REVIEW 的 PRE_CERT 之后跑过一次，TEST 只消费该 PASS；完成 live smoke / delivery reviewer / finish decision / summary / review assurance floor、bug 全 fixed 后进 DONE（`proof-or-stop next --storyId=<id>` 逐步给出每一步） |
| **DONE** | `story_advance DONE` 合并回 main 并清理 worktree。DONE 成功后按 `.proof-or-stop/audit-config.json` 触发 audit 提示（semi-auto 模式在输出末追加 audit 建议；详见「框架自省 audit 配置」段） |

### REVIEW → DONE is framework-driven: `proof-or-stop next --storyId=<id>`

After DEV (every checklist item done and committed), run `proof-or-stop next --storyId=<id>` from the Story worktree and execute the one command it prints, then ask again. It is read-only, decides each step from the real gate predicates (evidence-chain check, REVIEW verdict, reviewer batch plan, inventory status, PRE_CERT admit predicates, certification status, DONE oracle), and labels it `framework` (mechanical; `--run` executes consecutive framework steps through the normal CLI), `agent` (code, a managed reviewer launch, authored text or a host verdict; `<...>` placeholders name the fields to author) or `human`. It covers REVIEW entry, every review round (prepare → launch all prepared lanes → wait → import), the inventory epoch and critic, remediation back to DEV (repair → evidence refresh → `finding_resolve`), PRE_CERT (fast check → `certification_window_begin` → routine `validate`), TEST (live smoke, delivery reviewer, finish decision, summary, review assurance floor) and DONE. Do not reorder these steps or probe `story_advance` ahead of it. Decision table: `docs/CLI.md` ("`next --storyId`").

### 如何选通道

- **小改动**（bug fix、文案修改、配置调整）：创建 story 时只写 1-2 条 checklist，worktree 创建后直接 `story_advance DEV`，主 agent 自己做
- **正常改动**（新功能、重构、多文件改动）：走完整 PLAN（understanding_set + decision_set + checklist + plan.md + story_review），拆给 subagent

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

1. `story_create` → 停在 **INIT**（在 main 分支上写 story 文件）
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
- **relatedDocs**：关联文档路径数组，触发三次提醒

### relatedDocs 三次提醒（软提醒，不阻塞）

1. **PLAN→DEV 推进时**：列出全部 relatedDocs 去重清单
2. **`checklist_update` 标 done 时**：列出该 item 的关联文档
3. **DONE 推进时**：列出 `git diff main...HEAD` 没出现过的文档

### English authoring and legacy relatedDocs recovery

English-artifact gates scan all recursively scanned string leaves of story metadata. The listed examples (`excludes`, `files`, `reason`, `verificationEvidence`) are non-exhaustive. Recover leftover CJK in relatedDocs and other leaves before REVIEW→TEST.

## PLAN 阶段产物

### understanding_set（理解快照）

| 字段 | 含义 |
|---|---|
| `task` | 一句话描述要解决的问题（≥ 5 字符） |
| `outcome` | 完成后能观察到什么变化（≥ 5 字符） |
| `facts` | 已知事实 |
| `constraints` | 必须遵守的规则 |
| `unknowns` | 还没想清楚的问题（非空时建议先调研再拆 checklist） |
| `touchpoints` | 可能受影响的代码文件 |

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

正常通道 PLAN 阶段必须跑 `proof-or-stop-review-scope-plan` 产出 `scope-check.json`。`story_review` 规则（[story-review.ts:274-279](packages/main/src/handlers/story-review.ts#L274-L279)）：

- `understanding` 存在 + checklist 非空 + `scope-check.json` 缺失 → `missing_scope_check` **blocker**，直接卡 PLAN→DEV
- 已有 scope-check.json 但签名失效 / review round 过期 → 要求重跑
- 有未消解 gap / excluded 无证据 / orphan-suspect → blocker
- 有未 resolved OpenQuestion → blocker（见下节）

即「PLAN 完成标志 = `scope-check.json` 存在且所有通道均已清账」。

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
- `missing_receipt`：must 阻塞、should 只提示；Next 是 `verification_run`（已 pin）或 `verification_evidence_add`（未 pin，优先绑定该 item 里未被选中的已改测试）。
- `unbound_test`：只提示；Next 把测试绑定到该测试所在 item 的第一个未 pin intent。全部 intent 已 pin（pin 不可改）时无需动作，除非它是某个 userSees 行为的唯一测试（走 `acceptance_amendment_propose`）。
- 选择集是算出来的，不猜：无法计算的 pinned command（make、shell、模块外 import path 等）会跳过扫描并写明原因；JS/TS 不扫描。
- 输出位置：`pre_review_check` / `pre_review_check_read` 文本末尾的 `Evidence-chain check` 段，以及 `story_advance REVIEW` 的 gate。

test-coverage reviewer 只报产品覆盖缺口。reviewer 若仍报证据链项，用 `category: "evidence_chain"`：
`managed_review_evidence_import` 只导入产品 finding（保留 sealed proposal index），只含证据链项的 proposal 以 pass 导入
（note 由 verifier 从 sealed proposal 重算），每项记为 `review_evidence_chain_reclassified` process event，并打印
`Framework next action:`；native `finding_add` 直接拒绝（`evidence_chain_not_a_finding`）。

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
| **proof-or-stop-review-\*** | REVIEW 阶段按 opt-in 路由并行审查（baseline concept+quality+test-coverage，按 riskSignals / touchpoints 加挂 behavior/docs），各自提 finding。`test-coverage` 继承旧 TEST_CASE_REVIEW 职责，只审产品覆盖缺口（userSees/验收行为没有任何测试、断言没检查该行为、缺边界用例）；receipt/pin/测试绑定等证据链项由框架在 REVIEW 前检查，不是 finding；`channel` LLM agent 已退役（S1）由 `validate --channel` CLI 接管；`quality` 假设 lint 已绿只审主观项 | 不写 |
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
| english-artifacts | `english-artifacts` preflight (B-5f42, no standalone flag; standalone `npm run test:legacy -- english-only-guards`) | 本分支 commit + 当前 story 元数据必须英文(CJK 触发 fail) | fail → block REVIEW→TEST |
| proof-or-stop-residue | `proof-or-stop-residue` preflight (standalone `npm run test:proof-or-stop-residue`) | 仅 PoS 源码仓库通过 `reviewPreflight.proofOrStopResidue: "enforce"` 显式启用；普通 consumer repo 默认 `skipped`，无需携带维护脚本。启用后执行四个独立 check（见 `scripts/verify-proof-or-stop-residue.mjs`）：**[koala]** 对 product runtime source 零容忍扫无关产品残留；**[brand-prose]** 扫 active docs 与 host Agent mirrors，拒绝仍在教用户调用已退役命令的文案；**[brand-exec]** 扫可执行入口，拒绝退役命令；**[brand-decision]** 扫 product runtime source 的路径判定点，拒绝退役路径参与常规读写。历史签名 salt、不可变证据和显式 one-shot migration 输入由 identity-cutover verifier 的逐文件逐 token 规则校验，不是 active alias。 | 未启用 → skip；启用后缺脚本、配置非法或任一 check fail → block REVIEW→TEST |

`proof-or-stop-review-channel` LLM agent 已退役（S1），由 `proof-or-stop validate --channel --story=<id>` CLI gate 接管；`proof-or-stop-review-concept` 按需 spawn（CLI 残留 ≥ 5 时）；`proof-or-stop-review-quality` 假设 lint 已绿只审主观项。

### REVIEW→TEST gate behavior (`canPassReviewGuard`) + incremental review context (B-f675)

The structured `canPassReviewGuard` gate (`core/machine.ts`, consumed by the REVIEW→TEST transition) decides on reviewer evidence + findings, NOT on free text. Its accurate semantics:

- **An invalid (stale / unknown-run / tampered) current-round binding blocks in ALL rounds.** `collectReviewerEvidenceState` validates every reviewer finding / review-pass against its bound `reviewRunId` (signature, lane, current round, fresh head/material hash, scope binding; plus — for an open FINDING only — the lane's current-latest run, since a PASS is accepted on any current-round fresh run). If any current-round reviewer evidence is invalid, the gate fails closed BEFORE the round split — round 1 and round 2+ alike.
- **Every round: requires a valid current-round verdict from EVERY required lane, plus quorum.** The required set is `computeFinalReviewRoster` (`core/machine.ts` `evaluateReviewVerdict`): the opt-in active reviewers `proof-or-stop reviewer_list` reports (baseline concept + quality + test-coverage, plus behavior/docs by riskSignals / `.md` touchpoints), or — after one consumed remediation inventory — the signed post-remediation selection, which narrows to impacted lanes only on a complete supported impact closure and otherwise keeps every active lane. The round number never narrows the set (the former "round 2+ needs only `>= 1` receipt" shortcut is removed). Missing any required lane, or failing quorum, blocks.
- **Every verified open critical / high / medium finding blocks, in every profile and whichever round raised it (no round decay).** `status=open` AND severity in the closure set (`core/finding-closure-severities.ts`: critical+high+medium in light, balanced and strict alike — every preset's `blockingSeverities` is derived from it, so `workflow_show` reports exactly this set; low is always advisory; the same set in every round) AND `evidenceState` verified-or-missing. Findings from EARLIER rounds count: REVIEW→TEST, DONE's review-verdict predicate, `certification_window_begin` and lifecycle readiness all read every round's findings (`core/finding-closure.ts`). A finding is closed only by `finding_resolve` with repair evidence (incl. `--resolutionType=accepted_risk`, the named accepted-risk record), `review_remediation_close`, or an existing `finding_dismiss` record (REVIEW only, never critical). The refusal prints one `Next:` naming the ids and the exact `proof-or-stop finding_resolve --storyId=<id> --findingId=<id> --resolution="<repair commit + passing focused evidence>"` (from TEST: `story_advance --phase=DEV` first). A `finding_resolve` metadata commit in REVIEW is authenticated review bookkeeping (signed open→resolved transitions + their `findings.json` mirror only), so it does not break the managed-review live-head lineage. `suspected` / `disproven` never block. There is no review-round limit.

**`proof-or-stop review_incremental_context --storyId=B-xxx --role=<reviewer>`** is a strictly read-only advisory: it returns the reviewer's prior verdict, the `headHash` that verdict was bound to, and the MATERIAL files changed since (rename-aware `git diff --name-status -M`, so a renamed file still counts as changed), plus `scopeChanged` / `isFirstPass`. A first-timer (no prior pass) gets `isFirstPass=true` and the full `main...HEAD` material diff. **It writes nothing and changes none of the gate inputs above** (findings / review-passes / review-runs / currentReviewRound); calling it does not alter `canPassReviewGuard` (proven by `test:review-incremental-context-smoke`).

`isFirstPass=true` is the authoritative "no usable incremental baseline" signal and covers TWO sub-cases: (a) the reviewer never passed before, AND (b) a prior verdict exists but the run it was bound to has an unresolvable `headHash`. In sub-case (b) `priorVerdict` is non-null (informational) while `priorHeadHash` is null and `changedFiles` is the full `main...HEAD` diff — so a JSON consumer must key off `isFirstPass` (not `priorVerdict`) to decide whether an incremental baseline exists. Likewise `scopeChanged` is forced to true whenever `isFirstPass=true`, so it may be true even when `changedFiles` is empty; only when `isFirstPass=false` does `scopeChanged === (changedFiles.length > 0)`.

**Round 2+ scope-change advisory (context only):** when entering REVIEW for round >= 2 the next-step output appends the active reviewers whose scope changed since their last pass (`proof-or-stop review_incremental_context --role=<name>` inspects each). It does not relax the gate: every required lane (see `proof-or-stop reviewer_batch`) still needs a valid current-round verdict.

### Reviewer opt-in 路由（按 riskSignals 挂载）

除了 CLI gate，Round 1 的 LLM reviewer 集合不再硬要 5 个。框架按 story 的 riskSignals / touchpoints 自动挂载 reviewer 子集，基础集合永远开，其余按信号挂载：

| reviewer | 挂载条件 |
|---|---|
| **concept** | baseline（永远开） |
| **quality** | baseline（永远开） |
| **test-coverage** | baseline（永远开，审承诺的行为是否真有测试覆盖；stale/缺失 receipt 与未绑定测试属框架的证据链检查，不报 finding） |
| **behavior** | riskSignals 含 `state machine` / `guard` / `gate` |
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
- 关闭方式：`finding_resolve` + 修复证据（`--resolution`；接受风险用 `--resolutionType=accepted_risk`）、`review_remediation_close`，或既有的 `finding_dismiss`（仅 REVIEW，critical 不可 dismiss）。
- `suspected` / `disproven` 保持 advisory，不阻塞。
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

- critical / high severity
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
