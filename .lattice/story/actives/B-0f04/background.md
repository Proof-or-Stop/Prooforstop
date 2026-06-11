## 触发事件
2026-05-25 用户同意在 B-ca8f 和 commit 37df1e7d 后继续推进 post-merge 总验收与跨端 contract 差异扫描，并明确要求按照 Koala 开发流程推进，由 Claude Code 执行，Codex 只做项目经理式验证与需求确认。

## 关键洞察
B-ca8f 已经把 Koala CLI 的 annotation convergence 修回 true，但流程伪造和事实伪造的长期稳定性依赖三端一致：Koala CLI 本地 evidence/gate、Cord Team Python authority receipts、Koala Mac/Swift 或 Runner 侧提交与消费 contract。单仓库 green 不等于跨端闭环已经对齐。

## 方案取舍
本 story 只做审计、验证和差异报告，不直接修改三个仓库的生产代码。这样可以先用低风险方式确认路径、命令、contract 字段、receipt/gate 边界和缺口，再把确实需要开发的部分拆成后续 story，避免把验证工作和实现工作混在一个大改动里。

## 对话纹理
用户多次强调必须遵循 Koala 流程、不能让同一个 Agent 既写代码又当裁判，也担心流程证据缺失会被后续 Agent 当成外来物。这个 story 因此要求 Claude Code 执行实际审计，Codex 只复核证据、复跑关键命令并确认是否需要新开发 story。
