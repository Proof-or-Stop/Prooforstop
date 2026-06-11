## 触发事件
2026-05-29 用户指出普通编程时，即使不使用 Koala，也会和 Claude / Codex / Gemini 形成流程设计、失败模式、成功经验和最新问题库；如果这些经验只停留在聊天上下文，下一次开发时新 Agent 不会主动读取或询问保存，经验会丢失。

## 关键洞察
Koala story 是强证据和 gate 系统，但用户普通开发并不总是走 Koala。需要一个轻量 experience memory，能在开发前 preflight 读取经验，在开发后 finish/capture 保存经验，并在有 active story 时把本次经验候选留在 story 证据上下文里。

## 方案取舍
第一版不做向量数据库、不做复杂 UI、不把经验当作 DONE 证据；采用 JSONL/Markdown、项目与全局双层存储、可读 CLI 输出和用户确认写入。这样能快速落地且不和 Koala 的 evidence/gate 权威混淆。

## 对话纹理
用户关注的是“下次编程别再重复踩坑”，不是再建一个没人看的日志库。因此命令必须低摩擦：capture 能保存，search 能找回，preflight 能在开工前提醒，finish 能在收尾时沉淀，并且 story 内只保存候选与来源引用。
