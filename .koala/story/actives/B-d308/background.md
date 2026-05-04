## 触发事件
2026-05-04 用户在完成 B-3a3b 后继续追问 .Codex 是否也需要类似 .claude/hooks 与 .claude/settings.json 的功能。我们明确判断不应复制 Claude runtime 文件，但需要补齐 Codex 侧的 Koala-managed adapter 能力。

## 关键洞察
Codex 当前不消费 .Codex/hooks 或 .Codex/settings.json，直接生成这些文件会制造假支持。已有 bin/koala-codex.js 能设置 KOALA_ACTIVITY_SOURCE=codex，但缺少显式项目配置让用户和验证脚本判断 Codex 入口能力是否存在。

## 方案取舍
选择新增 .Codex/koala.json 作为 Koala 自己读取/说明的 adapter manifest，并强化 wrapper 与 init 文档；不创建 .Codex/hooks，不创建 .Codex/settings.json，不声称 Codex runtime 会自动触发 hook。

## 对话纹理
用户同意继续优化时，关注点是 Codex 侧是否需要类似 Claude hook/settings 的能力。实现和回答都要保持边界清楚：我们补的是可检测、可解释、稳定的 Koala adapter，而不是把 Claude Code 的 runtime 目录照抄过去。
