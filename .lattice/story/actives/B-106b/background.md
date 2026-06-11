## 触发事件
2026-06-03 用户确认要把 dispatch_run / overflow_auto 的 10 个 milestone 全部执行到测试验证完成，核心目标是在 Codex、Claude Code、Gemini agent 不够时，Lattice CLI 能自动规划、准备、运行、收集 receipt 并完成本地验收闭环。

## 关键洞察
现有 Host Overflow 已能安全生成 handoff、worktree projection 和 local receipt submission，但 host_dispatch 仍是 projection-only。真正的产品化需要 dispatch runtime：可探测 host runtime、选择 host、创建隔离 dispatch 状态、运行 fake/real-adapter scaffolding、收集 git-derived receipt，并保持 productionDone=false。

## 方案取舍
优先做协议和 fake runner 的 deterministic full path，再做真实 host adapter scaffolding；这样可以在没有 Claude/Gemini/Codex 登录的机器上完整测试，同时不把外部 host 输出误认为 authority。真实 host 执行默认 supervised，失败/缺 CLI 都 visible degradation。

## 对话纹理
用户不是要再讨论 Lattice 是什么，而是要能在 agent 不够时让另一个 host 执行任务。实现必须给出真实 `lattice dispatch_run`、`overflow_auto`、status/list/resume/cancel/review/merge_plan 命令和测试证据，且清楚说明外部 host 永远不能自动 merge 或 claim DONE。
