## 触发事件
2026-05-17，B-6974 收尾时连续两次（B-6974、B-ad12）真机复现 partial-DONE——多个 agent session 并行写同一份 main 侧镜像 metadata 互相踩踏。会话期间写下了 session-ownership-and-write-leases.md 设计文档，但它目前仍只是未跟踪的工作区文件。

## 关键洞察
该文档已系统定义 read-only / story-scoped / main-shared / dangerous 四类命令、story owner lease、main write lock、takeover UX、idempotency 与 rollout plan。要让这些规则真正约束后续并行开发，必须先把文档固化进仓库、并成为 scope-plan reviewer 与各 agent 都认的真相源；规则停留在未跟踪草稿等于不存在。

## 方案取舍
可以等实现 story 一起带上文档，也可以先单独 docs-only 固化。选后者：实现是更大的 story（owner lease + main write lock + takeover），文档先落地能让实现 story 的 scope review 有据可依，也避免文档随实现反复漂移。本 story 明确不实现任何 lease 或 lock 运行时行为，只做文档固化与交叉引用。

## 对话纹理
用户给出按风险与依赖排序的路线图，明确第一步是开一个 docs-only story 把 session-ownership 文档纳入流程、成为正式真相源、不改核心行为；实现、F-008、F-007、Story 4、reviewer identity 依次排在后面，并强调不要一口气全做。
