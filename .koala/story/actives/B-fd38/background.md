## 触发事件

2026-05-17 与用户讨论 Koala 商业化架构(本地客户端 + 远程服务、多 agent 厂商适配)时,核对仓库 .Codex 目录大小写,发现 AGENTS.md:185 把 .Codex/agents/ 括注为「Codex 官方约定」,需查证该描述是否准确。

## 关键洞察

case-sensitive grep 确认 koala 源码(packages/main/src、bin、scripts)零处小写 .codex,全部用大写 .Codex,git index 也只有 .Codex 一种大小写,内部完全自洽——不存在跨平台 bug。但 .Codex/koala.json 自述 read by Koala tooling, not by the Codex runtime,且 prompt 是 Markdown 格式;官方 Codex 自定义 agent 约定是小写 .codex/agents/ + TOML。因此 .Codex/agents/ 实为 Koala adapter 约定,AGENTS.md:185 的「Codex 官方约定」与事实不符,会误导用户以为官方 Codex CLI 消费该目录。

## 方案取舍

考虑过三条路:A 不处理接受文档瑕疵;B 真做官方原生兼容额外生成小写 .codex/agents/*.toml;C 仅修正文档措辞。选 C:当前无功能 bug,B 是独立 feature 且与 Koala 当 Driver 路线可能冲突,A 留错误信息有害。C 成本最低且消除误导。

## 对话纹理

讨论从 Koala 核心源码保护、远程服务拆分、provider 抽象延伸到多 agent 厂商能力差异。用户先纠正 Codex 现已有原生 subagent,我据此重核仓库,先错误推断存在 .Codex 大小写跨平台 bug,经 case-sensitive 查证后自我更正:跨平台 bug 不成立,只余 AGENTS.md 一处文档归属误述。用户选择就该误述开 story 走完整流程。
