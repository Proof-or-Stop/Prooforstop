# Codex + Koala

优先做法：

```bash
node bin/koala-codex.js session_brief
node bin/koala-codex.js aux_doc_list --format=json
```

原因：

- `node bin/koala-codex.js` 是仓库内 Codex 首选入口，会加载本地 bootstrap（main + utils）
- wrapper 会写入 `.koala/activity.jsonl`，并标记 `source=codex`
- wrapper 会为 `session_brief` 这类只读恢复命令启用 activity heartbeat

只有当前项目没有本地 wrapper 时，才使用全局 fallback：

```bash
KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback koala session_brief
```

fallback 说明：

- `KOALA_ACTIVITY_SOURCE=codex` 会把本次调用标记为 `source=codex`
- `KOALA_ACTIVITY_RECORD_READONLY=1` 会让 `session_brief` 这样的只读入口也记录 heartbeat
- `KOALA_CODEX_ENTRYPOINT=global-fallback` 会防止本地 wrapper 子进程把 global fallback 误记成 `local-wrapper`
- 全局 `koala` 可能是 core-only，`aux_*` 命令不一定可用
- 全局 `koala` 也可能滞后于当前 worktree；有本地 wrapper 或 `node packages/main/dist/cli.js` 时，不要把 fallback 的 `status` / `next` / `validate` 输出当作 gate 证据
- `.Codex/agents` 由 `.claude/agents` 的完整 prompt 集合受控生成；Claude hooks/settings/skills 仍只属于 `.claude`
- `.Codex/koala.json` 是 Koala 自己读取的 Codex adapter manifest，用来说明推荐入口、session 环境变量和不生成的 runtime 资产

建议：

- 新 session 第一条命令跑 `node bin/koala-codex.js session_brief`
- 日常所有 story/checklist/fixture/bug 操作尽量保持同一入口
- 在 Koala 仓库自身开发时，若完整 wrapper 暂不可用，用 `node packages/main/dist/cli.js <command>` 做当前 worktree 的 status/gate/validate 判断
- 改动 Codex adapter 资产后运行 `node bin/koala-codex.js verify_codex`（或 `node bin/koala.js verify_codex`）；它会验证 manifest、agent mirror、wrapper heartbeat、global fallback heartbeat 和 runtime 排除项，并写入 gate 可消费的 process-event evidence
- 运行 `koala check` 检查 Koala 管理资产/模板漂移；确认后用 `koala check --apply` 或 `koala check --upgrade` 同步安全项
- 初始化脚本可用 `npx koala-init --verify-codex` 做同源资产校验
- 诊断 Codex adapter 时运行 `node bin/koala-codex.js doctor`，可同时查看共享检查、health 和 worktree 状态
- 如果 `aux_*` 不可用，说明当前是 core-only koala：优先找本地 bootstrap 入口；没有的话，用 AGENTS.md 规定的 shell 搜索兜底

边界：

- 不创建 `.Codex/hooks`，因为 Codex runtime 不会执行 Claude Code hooks
- 不创建 `.Codex/settings.json`，因为 Codex runtime 不会读取 Claude Code settings
- 需要观测 Codex 活动时，使用 `.Codex/koala.json` 记录的 wrapper 或带 `KOALA_ACTIVITY_RECORD_READONLY=1` 的 fallback
