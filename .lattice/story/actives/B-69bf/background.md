## 触发事件
2026-05-13 用户报告一个完成 story 中 .koala/activity.jsonl 被 git tracked 后，每次 Koala 命令 append 都让 verificationEvidence 因 materialHash 变化而 stale，并且 DONE freshness gate 被卡住。这个问题来自 B-cac9 后续分析发现 runtime artifact 和 material fact 的分类没有统一。

## 关键洞察
当前项目已经有 runtime-fact-registry 和 process-fact-registry，但它们分别管环境事实和流程证据，不管运行时文件路径。activity.jsonl 在 baseline-risk、story_sync_main、gitignore、freshness smoke 里被零散硬编码，语义不一致，甚至测试把它当成 material。

## 方案取舍
不要继续加 prompt 或单点 if path includes activity.jsonl。应该新增 runtime artifact registry，把 ignore pattern、materialHash exclude、tracked repair hint、volatile 判断放在同一张表，然后让 freshness、init、doctor、baseline risk 和测试消费它。

## 对话纹理
用户关心的是所有流程事实必须硬编码兜底，不能靠 agent 自觉或文档提醒。最终验收要证明 tracked runtime log 不再污染 materialHash，已有项目 init 会补 ignore，doctor 能指出修复命令，且测试会防止回归。
