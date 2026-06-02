## 触发事件
2026-06-02 在 B-1123 之后，用户要求 Lattice CLI 打开 authority 时能真实走 Python authority，关闭时仍本地运行。

## 关键洞察
Python authority 与 Mac Runner 已有 job claim/provider event 合约；TS CLI 需要一个显式 headless runner path，而不是把普通 story 命令偷换成 runner。

## 方案取舍
先实现 bounded once/dry-run runner 与 fake-provider 测试，避免直接接入 Claude/Codex/Gemini 真实 CLI 导致权限和交互风险；真实 provider adapter 后续可在同一 contract 下扩展。

## 对话纹理
这一步是流程防伪的关键：执行者必须有 server job lease、signed provider events 和 transcript hash，而不是自然语言说“我跑过”。
