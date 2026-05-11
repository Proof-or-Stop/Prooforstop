## 触发事件
2026-05-11 在连续修复 feb0a6e / 7adb8c9 相关 reviewer pass-only finding 问题后，用户明确要求把经验上升为 Koala 原则：流程执行与确认不能只靠 prompt，必须有硬编码兜底。

## 关键洞察
Koala 的核心风险不是某一个 reviewer 写错命令，而是自然语言确认进入持久化事实时缺少统一契约；pass、done、resolved、category、role 这些字段一旦进 gate，就必须由代码裁判。

## 方案取舍
本 story 不做无限重构，优先选择小而硬的治理面：把原则写入权威文档和 reviewer prompt，新增可重复的 prompt/schema 审计 smoke，并在 finding/review 相关入口补齐 legacy 归一或拒绝。

## 对话纹理
用户关注的是 Koala 后续不要靠 agent 自觉维持纪律；实现应让未来 weaker agent 也能被 CLI 拉回正轨，同时保留 prompt 里的清晰操作路径，减少误用发生率。
