## 触发事件
2026-05-26 用户明确指出，如果 Koala CLI 单独管理 story、证据和 DONE，它可能变成“自己编排流程、自己证明流程”的单点，要求按照七个里程碑先执行 Milestone 1，把 CLI、Runner、Python Authority 的 trust boundary 机械化。

## 关键洞察
问题不是文档里说 CLI 不是 authority 就足够，而是流程事实必须被 CLI handler、gate、smoke test 机械验证。当前 PD-1 已经说明 CLI 是 thin local/shadow client，但 authority envelope 默认 trustLevel、accepted-only 语义和 DONE 入口仍需要更明确的边界标记，避免未来 agent 把 local/shadow 证据说成 L2+ receipt。

## 方案取舍
本 story 只做 Milestone 1：在 Koala CLI 仓库强化 trust boundary 和防过度声明。暂不实现 koala-runner CLI、不改 Mac Runner、不改 Python authority、不引入真正 receipt 验签；这些留给后续 milestone 和各自仓库 story，避免为了推进而耦合三端。

## 对话纹理
用户关注的是“防止流程伪造/事实伪造”而不是漂亮命令名；输出必须让后续 Agent 一眼知道：Koala CLI 可以编排 workflow，但不能单独认证 L2+ authority，enforce/DONE 的高信任事实必须来自 Runner/Python receipt，而不是本地 JSON 或自然语言 pass。
