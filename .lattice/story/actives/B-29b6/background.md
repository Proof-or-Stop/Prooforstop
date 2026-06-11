## 触发事件
2026-06-02 用户要求在理解 Koala 下一代 Lattice 框架后，把“需求拆解 → story DAG → 并行计划 → 多 worktree 派发 → 证据收集 → 串行合并”升级成可执行方案，并授权执行到完成。

## 关键洞察
Lattice v0/v1 已经把 Canonical Story、Capability Contract、Visible Degradation、Lineage、Authority Binding 和 Handoff 定义为下一代边界。并行开发不能另建一套真相源，必须作为 collection-level Parallel Wave 引用 Canonical Story，并把缺能力、冲突和 authority 限制显式化。

## 方案取舍
优先在 Koala TS CLI 中实现 Lattice Parallel Wave 的文档合同、核心模型、CLI/JSON、scope-aware gate 输出和烟测。暂不重命名 Koala，不让 wave 本身成为 production authority，不绕过现有 story lifecycle、handoff、evidence 和 receipt 边界。

## 对话纹理
用户关注的是大需求拆分后能让 Claude Code、Codex、Gemini 或本地 runner 在多个 story/worktree 中并行推进，同时仍能防止流程伪造、事实伪造和越界修改。输出必须给后续 agent 可恢复、可审计、可验证的具体执行表面。
