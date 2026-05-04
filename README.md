# Koala

Koala 是一套围绕 Story 工作流的 AI 开发编排 CLI。这个仓库当前包含：

- `packages/main`：Koala 核心 CLI
- `packages/utils`：`aux_*`、`truth_*`、`tool_status` 等扩展工具
- `bin/koala.js`：完整 bootstrap 入口（`main + utils`）
- `bin/koala-codex.js`：Codex 专用入口，会把活动记成 `source=codex`

## Codex 使用

## Koala 状态入口

Koala 不负责 Codex / Claude Code 的 agent runtime；它负责 project state：
story、phase、worktree、gate、review、fixture、bug 和 evidence。

恢复现场时优先使用只读入口：

```bash
koala status
koala next
```

- `koala status` 展示当前工程状态总览，复用 `session_brief` 的事实来源
- `koala next` 只输出当前最可信的下一步建议
- 两个命令都不推进 phase、不写 `.koala/state`、不修改 story/fixture/git

`session_brief` 仍然是新 agent session 的开场简报入口；`status` / `next` 是给人和
agent 在工作中快速恢复现场的短入口。

### 1. 先构建完整 CLI

```bash
npm --prefix packages/main run build
npm --prefix packages/utils run build
npm --prefix packages/lab run build
```

### 2. 在 Codex 里优先用仓库内入口

```bash
node bin/koala-codex.js session_brief
node bin/koala-codex.js aux_doc_list --format=json
node bin/koala-codex.js story_create '...'
node bin/koala-codex.js lab create --target=test-case-reviewer --profile=reviewer-quality-v1
```

原因：

- 这个入口会加载 `main + utils`，所以 `aux_*` 命令可用
- 如果 `packages/lab` 已构建，它也会把 `koala lab ...` 子命令一起接进来
- 它会把 Koala 调用写入 `.koala/activity.jsonl`
- 写入记录会带 `source=codex`，可以和普通 CLI、Claude Code 区分
- 它会为 `session_brief` 这类只读恢复命令启用 heartbeat 记录

如果本地 bootstrap 还没准备好，wrapper 会直接打印恢复步骤，而不是抛出模糊的模块加载错误。

通过 `story_advance ... INIT_CHECK` 新建的 story worktree 不需要手工复制 `.Codex`。`git worktree` 会把当前分支已跟踪的仓库文件一并展开出来，所以只要 `.Codex`、`.claude`、`AGENTS.md`、`CLAUDE.md` 已经提交到仓库，新的 `.worktrees/B-xxx/` 里就会自然带上这些入口。只有两种常见缺失原因：这些文件本来就没被 git 跟踪，或这个 worktree 是从还没包含这些资产的旧分支/旧提交分出来的。

### 3. 新 session 的第一步

```bash
node bin/koala-codex.js session_brief
```

项目里的 [AGENTS.md](/Users/jek/Documents/Work/Orchestrate/AGENTS.md:1) 也要求每个新 session 先跑这条命令。

### 4. 查看 Codex 自己的 Koala 活动

```bash
node bin/koala.js tool_status --source=codex --days=1 --limit=10
```

### 5. 跑入口回归验证

```bash
npm run test:entrypoints
```

这会验证：

- 当前仓库的 `bin/koala.js` / `bin/koala-codex.js`
- `koala init` 生成的新项目产物
- `.Codex/README.md` 是否包含正确的降级入口说明

### 6. 验证 Codex 资产没有漂移

```bash
npm run test:codex-assets
koala verify_codex
```

这会检查：

- `.Codex/agents/*.md` 是否仍然等于 `.claude/agents/*.md` 的受控 transform 结果
- `.Codex/agents` 是否没有漏掉 `.claude/agents` 中新增的 prompt
- `.Codex/koala.json` 是否仍然声明 Koala-managed Codex adapter、`activitySource=codex`、推荐入口和不生成的 runtime 资产
- `.Codex/README.md` 是否保留正确的 Codex fallback 入口
- `README.md` / `AGENTS.md` 是否仍然包含关键的 Codex 接入说明

`koala verify_codex` 复用同一套共享检查，并额外执行本地 wrapper 与全局 fallback heartbeat：它确认 activity 记录包含 `source=codex`、session、entrypoint，并把 `codex_adapter_verification` 追加到当前 story 的 `process-events.jsonl`。触及 Codex adapter 的 story 在 REVIEW/DONE gate 会区分这条证据是 missing / failing / passing，并给出可直接重跑的命令。

初始化新项目时也可以直接跑：

```bash
koala init --verify-codex
```

## 没有本地 wrapper 时

如果某个项目只有全局 `koala`，没有 `bin/koala-codex.js`，可以这样跑：

```bash
KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 koala session_brief
```

这能保证 activity 里仍然按 `source=codex` 记账，并让 `session_brief` 这种只读入口也留下 heartbeat；但如果没有 bootstrap 入口，`aux_*` 命令可能不可用。

如果全局 core 入口提示 `未知命令: aux_doc_list`，在 Koala 仓库内使用完整 bootstrap：

```bash
node bin/koala.js aux_doc_list --format=json
```

`story_create` / `story_update` 支持并行调度元数据，建议在多 story 并行时显式填写：

```bash
koala story_update '{"storyId":"B-xxxx","lane":"mainline","parallelSafe":"plan_only","sharedHotspots":["packages/main/src/handlers/session.ts"]}'
```

如果完整入口提示缺少 `packages/main/dist/*` 或 `packages/utils/dist/*`，先执行：

```bash
npm --prefix packages/main run build
npm --prefix packages/utils run build
npm --prefix packages/lab run build
```

全局安装的 `koala`（来自 `@koala-agent/core`）在 `@koala-agent/lab` 可解析时也会自动启用 `koala lab ...`；如果没有安装 lab，普通 core 命令仍然可用，只有 `koala lab ...` 会提示安装/构建 lab。

发布 `0.2.2` 前建议跑：

```bash
npm --prefix packages/main run build
npm --prefix packages/lab run build
npm run test:global-lab-entrypoint
```

## koala-lab

`koala-lab` 是 Koala 的离线优化实验室，用来创建实验配置、预览隔离 sandbox、校验 patch 白名单，以及为后续 compare/promote 留出统一骨架。

```bash
node bin/koala.js lab create --target=test-case-reviewer --profile=reviewer-quality-v1
node bin/koala.js lab run --config experiments/configs/lab-reviewer-reviewer-quality-v1.json --dry-run
node bin/koala.js lab eval '{"config":"experiments/configs/lab-reviewer-reviewer-quality-v1.json","files":[".Codex/agents/test-case-reviewer.md"]}'
```

第一版默认只支持离线、安全的实验配置：

- `lab run` 需要先 `--dry-run` 预览，真实创建 sandbox 时带 `--confirm`
- `lab eval` 默认拦截 `docs/story`、`tests/fixtures` 和任何不在 `editableFiles` 白名单内的路径
- `packages/lab` 未构建时，普通 `koala` 命令仍可继续使用；只有 `koala lab ...` 会提示补 build

当前 `reviewer-quality-v1` 已经能给出真实的 baseline / score / delta / kept-discard 决策：

```bash
node bin/koala.js lab run --config experiments/configs/lab-reviewer-reviewer-quality-v1.json --confirm
node bin/koala.js lab compare --config experiments/configs/lab-reviewer-reviewer-quality-v1.json
node bin/koala.js lab promote --config experiments/configs/lab-reviewer-reviewer-quality-v1.json
```

对 reviewer 目标来说，`lab run --confirm` 现在还会把真实 `patch.diff` 写进 run 目录；`lab compare` / `lab promote` 会把对应的 patch 路径和 baseline ref 一起带出来，便于直接审阅。

`score` 是 koala-lab 的内部加权决策分，会保留 `qualityWeight` 等权重语义；`normalizedScore` 是 0-1 的展示分，用于更直观地阅读 prompt 质量。`kept/rejected` 仍然只由 `score` 和 `minScoreGain` 决定。

可用回归：

```bash
npm run test:lab-foundation
npm run test:lab-scoring-core
npm run test:lab-reviewer-mvp
npm run test:lab-normalized-score
npm run test:lab-flow-profiles
npm run test:real-story-replay
```

真实任务回放评分表可用下面的脚本生成，输出同时包含 `Score`、`Evidence Quality`、`Why`、`Explain`，并写入 `experiments/reports/real-story-replay-v1.{md,json}`。`Evidence Quality=backfilled` 代表该行使用了显式 replay metadata 补齐旧 story 的证据缺口，分数会低权重计算并在解释中标明来源。

```bash
node scripts/real-story-replay-benchmark.mjs
```

## Claude Code

Claude Code 侧仍然使用 `.claude/` 下的 hooks、settings 和 skill。Codex 不消费这些 Claude runtime 配置，也不会读取 `.Codex/hooks` 或 `.Codex/settings.json`。Koala 为 Codex 生成的是 adapter 资产：agent prompt 会从 `.claude/agents` 全量受控生成到 `.Codex/agents`，`.Codex/koala.json` 记录 Koala-managed adapter 的推荐入口、`source=codex` 活动标记、session 环境变量和明确排除的 runtime 资产。Codex 侧的说明放在：

- [AGENTS.md](/Users/jek/Documents/Work/Orchestrate/AGENTS.md:1)
- [.Codex/README.md](/Users/jek/Documents/Work/Orchestrate/.Codex/README.md:1)
- [.Codex/koala.json](/Users/jek/Documents/Work/Orchestrate/.Codex/koala.json:1)
- [.Codex/agents/](/Users/jek/Documents/Work/Orchestrate/.Codex/agents:1)

当前仓库里 `.Codex/agents` 由 `.claude/agents` 经过受控 transform 全量生成，并通过 `npm run test:codex-assets` 防止后续漂移。
