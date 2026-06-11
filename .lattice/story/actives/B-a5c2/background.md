## 触发事件
2026-06-03 after B-106b completed Host Overflow, the user asked whether Lattice should support an unattended executor for Claude Code, Gemini, and Codex, and then explicitly approved executing the 8 milestone plan. The concrete trigger is B-106b and today's follow-up request to verify parallel development using Claude Code CLI agents.

## 关键洞察
B-106b landed manual-first dispatch and fake parallel execution, but real hosts remain scaffolded only. The next value is not redefining Lattice; it is converting scaffolded host handoff into a policy-authorized scheduler that can launch external CLI workers while keeping receipts, review, merge, and production authority under Lattice gates.

用户真正想减少的是跨 host 分工时的手工复制 prompt、创建 worktree、启动 CLI、等待输出、整理 transcript、判断下一步这些重复动作；产品完成态必须让用户看到 policy 是否授权、哪些 worker 正在跑、每个 worker 输出了什么证据、以及为什么结果仍然需要人工 review/merge。

## 方案取舍
The scheduler must be opt-in and policy-gated. It can automate host launch, timeout, transcript capture, local receipt creation, and status tracking, but it must not auto-merge, auto-DONE, expand scope, or claim productionDone. Implementation should split policy, host contract, runner, scheduler, evidence, gates, tests, and docs into isolated milestones to enable safe parallel development.

## 对话纹理
The user wants to validate that Lattice can use parallel agent work in practice, including Claude Code CLI agents, without losing host-neutral authority. The plan must be concrete enough to hand to agents, but conservative enough that unattended automation remains controlled by the user rather than becoming a hidden autonomous runner.

完成后用户应该可以自然说“好了”：我已经定义了 unattended policy，Lattice 已验证 Claude/Gemini/Codex 哪些可用，已按 policy 启动或拒绝 worker，watch 输出给出状态和 nextAction，review/merge plan 告诉我如何人工收口，而不是留下一个只会生成内部 artifact 的半成品.
