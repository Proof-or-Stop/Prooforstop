## 触发事件
2026-05-09 FR-001 用户确认收口前一轮分析发现的 Koala 周边 drift：入口提醒、文档口径和 prompt hook 体验需要同步。

## 关键洞察
这不是核心状态机新 bug，而是周边知识源和 agent 入口体验的漂移。用户可见问题是 agent 会被旧 prompt 引导去跑 status，或者看见 INIT_CHECK 文档与真实 gate 不一致。

## 方案取舍
优先做小范围同步：更新根文档、生成模板、已生成 agent prompt 与 Claude hook 初始化逻辑；不创建 Codex hooks/settings，保持现有 Codex adapter 边界。


补充验证约束：因为本 story 会修改 .claude/.Codex agent prompt、Claude hook 初始化和 Codex adapter 邻近资产，DEV/REVIEW 阶段必须记录 node bin/koala-codex.js verify_codex 或等价本地 wrapper 验证，证明 Codex manifest、agent mirror 与 runtime 排除项没有漂移。

## 对话纹理
用户已经接受上一轮判断，希望把 friction 收口；本次应直接落地修复和验证，不再扩大战线到外部 memory 或 benchmark 数据集。
