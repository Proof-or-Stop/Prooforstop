## 触发事件
2026-05-23 用户要求继续解决流程伪造、事实伪造之外的 AI 越界修改问题，并明确指出需要 diff scope、changed-file policy、regression fixture、pre-tool blocking 作为新的强门禁。B-1fca 已完成 evidence/gate 防伪，但还缺少修改范围层的机械约束。

## 关键洞察
当前 Koala 已经能用 evidence、review、validate 证明某些声明是否成立，但还没有一个 story-scoped 的允许修改范围作为硬事实源。没有这层约束时，Agent 可以在实现新需求时顺手修改旧功能，后续 reviewer 需要靠人工阅读完整 diff 才能发现越界风险。

## 方案取舍
先做 scope contract 和 post-diff gate，而不是直接做 Claude hook blocking。这样可以先把什么文件允许改、什么文件需要额外理由、什么测试必须跑落成稳定数据结构和 CLI 判定，再让 Claude Code、Codex、Gemini 等不同 runner 复用同一个判定入口。

## 对话纹理
用户关注的不是增加更多记录，而是防止 AI 编流程、编事实之后继续越界改旧功能。实现必须避免和 story 历史记录重复，只保存当前 story 的范围约定与判定结果，让后续 Agent 接手时能快速知道哪些改动是允许的，哪些需要显式升级。
