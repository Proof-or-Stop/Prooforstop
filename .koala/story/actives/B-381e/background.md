## 触发事件
2026-06-03 用户确认按照 Lattice CLI 开发流程推进 Host-Neutral Observability Console M1，并要求安排 Claude Code CLI 并行开发；此前 docs/requirements/decisions/host-neutral-observability-console.md 已被采纳为设计真相源。

## 关键洞察
现有 session_brief/status 只返回 Markdown，不能作为 UI adapter 的机器可读数据源。M1 的核心不是先做界面，而是先提供 resolver JSON surface，明确每个 active story 的 authority、mirrorPhase、authoritativePhase 与 authoritativeCwd。

## 方案取舍
优先实现 L0 只读 resolver 和 adapter skeleton，暂不改造现有 terminal dashboard，也不开发多页面 UI。这样能把 worktree authority 与 main mirror 的风险先机械化消除，再让后续 M2/M3 消费稳定 JSON contract。

## 对话纹理
用户连续强调能力已经集成在 Lattice CLI，并希望通过 Claude Code CLI 并行开发。执行时需要保留 host-neutral 边界：Claude Code 是 worker host，不是 authority；local DONE 不能被渲染成 production DONE。
