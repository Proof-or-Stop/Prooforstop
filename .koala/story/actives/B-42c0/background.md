## 触发事件
2026-05-22 用户要求修复 Koala CLI 的交接和恢复问题，并明确不是下游 Prodenovo 或 Mac app 的业务 story。现有 B-95d8 已解决 INIT_CHECK fallback/repair，但新 Agent 接手仍主要依赖聊天上下文和零散 activity，容易不知道当前做到哪里、证据在哪里、下一步是什么。

## 关键洞察
Koala 已有 Story、Checklist、Evidence、Gate、process-events 和 Verification Context Pack。缺口不是再造一个真相源，而是给每个 story 增加一个可恢复、可交接、可审计的投影层。process-events 必须保持 append-only ledger，capsule 只能作为当前视图和 handoff 入口。

## 方案取舍
采用 story-scoped capsule 目录和 CLI 命令，但路径遵循当前仓库配置的 storyDir，默认是 docs/story/actives，不使用大写 Docs。capsule 摘要不能让 DONE 通过，只能引用 checklist evidence、review pass、test command、receipt 或 process-event。OMX 只能作为 non_authoritative import，不能成为 Koala gate 依据。

## 对话纹理
用户特别担心 Agent 编造流程、编造事实，以及跨项目修改后没有 story 证据。这个 story 应把建议中的六个 milestone 变成 Koala 原生流程，并配套测试证明伪造 session-brief 或缺失 evidence ref 不能骗过 gate 或健康检查。
