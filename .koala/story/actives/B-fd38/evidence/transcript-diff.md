# B-fd38 真机验证 transcript-diff

## PLAN outcome（expected）

读者打开 `AGENTS.md`「Subagent 定义」节时，看到 `.Codex/agents/` 被准确描述为
**Koala adapter 约定**（由 Koala tooling 读取），并与 **Codex 官方约定**（小写
`.codex/` + TOML）明确区分；不再出现「Codex 官方约定」误述。

## 真机执行（actual）

cwd: `.worktrees/B-fd38`，HEAD = story/B-fd38（commit c783a29b）。

```
[检查1] grep -c '（Codex 官方约定）' AGENTS.md
        → 0   （旧误述已清除）

[检查2] sed -n '183p;185p' AGENTS.md
        → ### Subagent 定义
          subagent prompt 文件放在 `.Codex/agents/` 下——这是 **Koala adapter 约定**
          （大写 `.Codex` 目录、Markdown + YAML frontmatter 格式，由 Koala tooling
          读取，见 `.Codex/koala.json` 标注的 `read by Koala tooling, not by the
          Codex runtime`），**不是 Codex 官方约定**；Codex 官方自定义 agent 约定是
          小写 `~/.codex/agents/` 或项目 `.codex/agents/` + TOML 文件。…

[检查3] grep -o 'read by Koala tooling, not by the Codex runtime' .Codex/koala.json
        → read by Koala tooling, not by the Codex runtime   （断言与事实源一致）
```

## diff（expected vs actual）

| 维度 | expected | actual | 一致 |
|---|---|---|---|
| 旧误述「（Codex 官方约定）」 | 不存在 | grep -c = 0 | ✓ |
| `.Codex/agents/` 定性 | Koala adapter 约定 | 「这是 **Koala adapter 约定**」 | ✓ |
| 与官方 Codex 约定区分 | 注明小写 `.codex/` + TOML | 「Codex 官方自定义 agent 约定是小写 …+ TOML」 | ✓ |
| 关键断言可追溯 | 引 `.Codex/koala.json` 原文 | 引文与 koala.json 逐字匹配 | ✓ |

无差异。`koala validate` 全绿（story-lifecycle 5 步 + gap-convergence 4 步 ALL PASS）。

## 副作用确认

本 story 仅改 `AGENTS.md` 一行 prose，不触及任何编译代码 / 运行行为；
`verify_codex` 6/7 pass（manifest / agent mirror / 排除项 / wrapper / heartbeat 全 ✓，
唯一 `[!]` 为非阻塞的 global-fallback advisory）。
