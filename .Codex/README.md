# Codex + Koala

通用做法：

```bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
```

如果当前仓库带了本地 bootstrap wrapper，再优先用它：

```bash
node bin/koala-codex.js session_brief
node bin/koala-codex.js aux_doc_list --format=json
node bin/koala-codex.js story_create '...'
```

原因：

- `KOALA_ACTIVITY_SOURCE=codex` 会把本次调用写入 `docs/story/activity.jsonl`，并标记 `source=codex`。
- `bin/koala-codex.js` 额外会加载 `main + utils`，所以 `aux_*` 命令也可用。
- `tool_status --source=codex` 可以单独统计 Codex 侧的 Koala 使用情况。

建议：

- 新 session 第一条命令跑 `KOALA_ACTIVITY_SOURCE=codex koala session_brief`
- 如果仓库有 `bin/koala-codex.js`，日常所有 story/checklist/fixture/bug 操作都走这个入口
- 如果只用全局 `koala`，活动仍会记录，但默认会记成 `source=cli`
