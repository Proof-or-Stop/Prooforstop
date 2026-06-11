## 触发事件
2026-05-08 用户在 SimCell 项目复盘 B-13be、B-c62c、B-38d4 等流程时列出十二个 Koala 体验与门禁问题，其中多个会让 story 无法继续推进或让 reviewer 误以为 metadata 已成功写入。

## 关键洞察
这些问题不是单点文案错误，而是同一类权威路径、自动同步、门禁证据和 reviewer 路由没有闭环导致的系统性摩擦。尤其 main 仓与 story worktree 同时存在 story metadata 时，读写路径稍微不一致就会制造 stale state、假成功或 DONE merge 阻塞。

## 方案取舍
本次修复优先选择小步接线与局部校验：能复用现有 worktree、cluster-sync、materialHash、reviewer-list、validate-channel 的地方不重写框架；对历史兼容保留旧命令，但让默认路径更安全、错误更早暴露、提示更少误导。

## 对话纹理
用户先要求判断这些是否真是 Koala 问题，确认后明确要求“全部给解决掉吧”。执行时需要把真实功能 bug 与粗糙 UX 一起收束，最后提供可验证的用户视角结果，而不是只说内部链路已经跑通。
