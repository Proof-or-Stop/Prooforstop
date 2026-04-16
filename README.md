# Koala

Koala 是一套围绕 Story 工作流的 AI 开发编排 CLI。这个仓库当前包含：

- `packages/main`：Koala 核心 CLI
- `packages/utils`：`aux_*`、`truth_*`、`tool_status` 等扩展工具
- `bin/koala.js`：完整 bootstrap 入口（`main + utils`）
- `bin/koala-codex.js`：Codex 专用入口，会把活动记成 `source=codex`

## Codex 使用

### 1. 先构建完整 CLI

```bash
npm --prefix packages/main run build
npm --prefix packages/utils run build
```

### 2. 在 Codex 里优先用仓库内入口

```bash
node bin/koala-codex.js session_brief
node bin/koala-codex.js aux_doc_list --format=json
node bin/koala-codex.js story_create '...'
```

原因：

- 这个入口会加载 `main + utils`，所以 `aux_*` 命令可用
- 它会把 Koala 调用写入 `docs/story/activity.jsonl`
- 写入记录会带 `source=codex`，可以和普通 CLI、Claude Code 区分

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
```

这会检查：

- `.Codex/agents/*.md` 是否仍然等于 `.claude/agents/*.md` 的受控 transform 结果
- `.Codex/README.md` 是否保留正确的 Codex fallback 入口
- `README.md` / `AGENTS.md` 是否仍然包含关键的 Codex 接入说明

## 没有本地 wrapper 时

如果某个项目只有全局 `koala`，没有 `bin/koala-codex.js`，可以这样跑：

```bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
```

这能保证 activity 里仍然按 `source=codex` 记账；但如果没有 bootstrap 入口，`aux_*` 命令可能不可用。

如果完整入口提示缺少 `packages/main/dist/*` 或 `packages/utils/dist/*`，先执行：

```bash
npm --prefix packages/main run build
npm --prefix packages/utils run build
```

## Claude Code

Claude Code 侧仍然使用 `.claude/` 下的配置和 hooks。Codex 侧的说明放在：

- [AGENTS.md](/Users/jek/Documents/Work/Orchestrate/AGENTS.md:1)
- [.Codex/README.md](/Users/jek/Documents/Work/Orchestrate/.Codex/README.md:1)
- [.Codex/agents/test-intent.md](/Users/jek/Documents/Work/Orchestrate/.Codex/agents/test-intent.md:1)
- [.Codex/agents/test-case-reviewer.md](/Users/jek/Documents/Work/Orchestrate/.Codex/agents/test-case-reviewer.md:1)
- [.Codex/agents/implementation-reviewer.md](/Users/jek/Documents/Work/Orchestrate/.Codex/agents/implementation-reviewer.md:1)

当前仓库里 `.Codex/agents` 由 `.claude/agents` 经过受控 transform 生成，并通过 `npm run test:codex-assets` 防止后续漂移。
