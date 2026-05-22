## 触发事件
2026-05-22 用户确认 B-42c0 已完成 capsule/process 防伪收口后，继续要求 Milestone 2-6 全部完成，并明确让 Claude Code CLI 开发、Codex 作为监工。当前缺口集中在事实伪造边界：弱测试、reviewer 同错、CI/human 走形式、actor key 泄漏或共犯、外部事实源错误。

## 关键洞察
B-42c0 已把 capsule 限定为 projection，并从 Koala gate/evidence 中移除 .omx import surface；流程伪造已经很强。剩余风险不应再靠自然语言承诺，而应让 evidence 自身带质量、身份、来源、freshness 和 quorum 约束。

## 方案取舍
本 story 选择在 Koala CLI/gate 层增加机械检查：弱证据评分、review quorum、CI/human 结构化 attestation、actor trust/revocation、external provenance。暂不引入 Python authority server 的网络依赖，先在 Koala 本地流程中形成可测试合同，再供服务端/Runner 对齐。

## 对话纹理
用户关注的是流程伪造和事实伪造能否继续逼近工程上的强解决，不希望再增加会重复 story 历史的旁路记忆。执行方式指定为 Claude Code CLI 开发、Codex 监督，所以 story 需要保留清晰 checklist、review evidence 和可复核测试。
