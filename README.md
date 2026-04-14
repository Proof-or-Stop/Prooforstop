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

### 3. 新 session 的第一步

```bash
node bin/koala-codex.js session_brief
```

项目里的 [AGENTS.md](/Users/jek/Documents/Work/Orchestrate/AGENTS.md:1) 也要求每个新 session 先跑这条命令。

### 4. 查看 Codex 自己的 Koala 活动

```bash
node bin/koala.js tool_status --source=codex --days=1 --limit=10
```

## 没有本地 wrapper 时

如果某个项目只有全局 `koala`，没有 `bin/koala-codex.js`，可以这样跑：

```bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
```

这能保证 activity 里仍然按 `source=codex` 记账；但如果没有 bootstrap 入口，`aux_*` 命令可能不可用。

## Claude Code

Claude Code 侧仍然使用 `.claude/` 下的配置和 hooks。Codex 侧的说明放在：

- [AGENTS.md](/Users/jek/Documents/Work/Orchestrate/AGENTS.md:1)
- [.Codex/README.md](/Users/jek/Documents/Work/Orchestrate/.Codex/README.md:1)
- [.Codex/agents/test-intent.md](/Users/jek/Documents/Work/Orchestrate/.Codex/agents/test-intent.md:1)
- [.Codex/agents/test-case-reviewer.md](/Users/jek/Documents/Work/Orchestrate/.Codex/agents/test-case-reviewer.md:1)
