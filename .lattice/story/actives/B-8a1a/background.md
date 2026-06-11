## 触发事件
2026-06-03 用户确认 B-a5c2/B-1691 已经完成 policy 和 fake 自动调度，但真实 Claude Code CLI 自动启动仍未开发；现在要求启动 Lattice Real-host unattended runner v1.0.1: Claude Code first，把 scaffold 升级为受控 subprocess。

## 关键洞察
核心风险不在能否执行 claude --print，而在 policy、cwd、timeout、transcript、env 过滤、scope review、cancel 和 receipt 的闭环。没有这些边界，功能会变成不可审计的隐藏后台 agent。

## 方案取舍
本 story 只做 claude-code，不同时支持 Gemini/Codex；先用 fake claude binary 做 deterministic 测试，再做极小 live canary。dispatch_auto 只有在显式 policy 允许真实 host subprocess 时才会启动 Claude，merge 和 productionDone 继续保持人工与 authority 边界。

## 对话纹理
用户要验证 Codex agent 不够时可以调度 Claude Code，但也持续强调 Lattice 应该 host-neutral、authority-safe、不要重造 runner。因此交付必须既让 Claude 真能跑，又不能让 Claude 输出被自动信任。
