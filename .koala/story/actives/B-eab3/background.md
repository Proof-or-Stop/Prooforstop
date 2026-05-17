## 触发事件

2026-05-17 本 session 在 B-fd38 完成后盘点 Koala 问题时核实:git config core.hooksPath 为 .githooks,但 .githooks/ 目录在工作树和全历史(git log --all -- .githooks 为空)中都不存在,.git/hooks/ 只剩 .sample 模板。

## 关键洞察

core.hooksPath 指向一个不存在的目录,git 因此找不到任何 hook,所有 git hook 全部静默失效。B-5a28 承诺的两条防线只落地了第一条(koala validate --lint),第二条 .githooks/pre-push(独立于 koala 自身的外部 tsc gate,设计用来在快速通道 lint gate 被 skip 时兜底)从未创建。CLAUDE.md 第 903-918 行却把它描述成已随仓库提交存在;且其描述的 koala 自举仓检测路径是 packages/koala/packages/main,与本仓实际扁平布局 packages/main 不符;还引用了一个本仓不存在的「koala 自举开发注意」段。

## 方案取舍

A 删除 core.hooksPath 本地配置并删掉 CLAUDE.md 相关段,承认放弃这条防线;B 补齐 .githooks/pre-push 文件、修正路径判断为 packages/main、对齐 CLAUDE.md 描述;C 暂不处理。选 B:B-5a28 的设计意图明确要有这条外部防线,快速通道 REVIEW→TEST 会 skip lint gate,pre-push 是类型错误进 main 前的唯一兜底,放弃等于留长期隐患;A 是退步,C 是放任文档与现实漂移。

## 对话纹理

讨论从 Koala 商业化架构(源码保护、远程服务拆分、provider 抽象、Koala 当 Driver)展开,中途修了 B-fd38 的 AGENTS.md 文档误述。用户随后问还发现 Koala 什么问题,我盘点确认了源码分发暴露、pre-push hook 配了但不存在、codex-adapter gate 与 worktree 不可构建的摩擦三项,用户选择就 pre-push hook 这项开 story 走完整 Koala 开发流程。
