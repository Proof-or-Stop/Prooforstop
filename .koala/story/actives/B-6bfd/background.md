## 触发事件
2026-05-23 B-be27 已经把 story-scoped path gate 落地，能够阻止越界文件静默进入 REVIEW/TEST/DONE；用户随后追问是否还能防止 Agent 在允许文件里修改不属于计划版本的功能，因此需要继续把防护从文件级推进到 hunk/symbol/intent 级。

## 关键洞察
path-level scope 只能回答哪些文件可以改，不能回答允许文件内部的哪些函数、命令、schema 或配置项可以改。要降低 Agent 越界修改风险，必须把 diff pack、semantic hunk gate、review evidence hash binding 和 guarded session 状态连成一条可审计链。

## 方案取舍
本 story 优先实现 Koala 管理流程内的机械检查和 lifecycle gate，而不是承诺拦截所有外部编辑器写入。pre-tool guard 先做 guard session / watcher / status 形态，能服务 Claude/Codex 派发流程；更底层的 editor hook 或 OS sandbox 后续再做。

## 对话纹理
用户关注的不是再加记录，而是防止 AI 修改既有功能后用自然语言糊弄通过。因此输出必须直接显示 semantic gate pass/warn/fail、diffPackHash、reviewed hunks、guard mode，并且每个关键结论都能用测试和 review evidence 重放。
Codex supervisor taking over implementation after Claude CLI stalled; continuing within approved scope and preserving Claude partial CHK-001 edits.
