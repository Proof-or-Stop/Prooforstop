## 触发事件
2026-05-18，B-f60c（main write lock）已 DONE 合并 8def6a07，session-ownership rollout step 2a 完成。step 2b——story owner lease 仍未实现：多个 agent session 仍能并行 mutate 同一 story 的 metadata，只能靠人类聊天协调，而非 Koala 机械 own。

## 关键洞察
owner lease 保护的是「story authoring / lifecycle mutation ownership」，**不是**取消 reviewer / verifier 的独立写入权。reviewer read-only（story_get / checklist_get / finding_list / session_brief）永远放行；reviewer 写（finding_add / review_pass_set）不归 main-agent owner，需 actor/lane-scoped 例外，否则会把三方制衡锁死。sessionId 只是本地流程协调 ID，不是 cryptographic identity。

## 方案取舍
4 条硬边界（用户裁定，不可越界）：(1) 只做本地 session 协调，不做强身份安全——无 public/private key、无 server authority、无 reviewer attestation；(2) 命令分类先落表（read-only / story-scoped mutating / main-shared mutating / dangerous），gate 严格按表接，不漏命令、不误拦只读命令；(3) owner lease 不阻断 reviewer read-only flow，reviewer writes 走自己的 review-run gate 或 lane-scoped 例外；(4) 不重构 B-f60c 的 main write lock，只在必要时调用既有锁。

## 对话纹理
用户在 B-f60c 收口后批准开 owner lease story，并加 4 条边界防止 story 失控，特别强调最易设计错的地方——把「一个 story 一个 owner」机械套到 reviewer lane 会干掉 reviewer 的独立写入权；要求 PLAN 的 decision 里明确「owner lease 保护 authoring / lifecycle ownership，不取消 reviewer/verifier 写入权」这条原则。
