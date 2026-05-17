## 触发事件

B-a370（F-003 修复）收尾时，主 agent 想把 3 个发现的 koala 框架 gap 归档进 framework-audit backlog，却发现 B-META-framework-audit 容器根本不存在，且 koala 没有手动归档一条框架 gap 的入口——现有 finding_add 是 reviewer-finding 形状，要 reviewRunId、category enum、review round 语义，拿来塞人工框架 gap 是滥用。确认日期 2026-05-17。

## 关键洞察

bug 通道有硬证据纪律：repro 加 rootCause 加 reproTest 齐了才能标 fixed。但 audit/finding 通道可以直接 finding_add 一个未经复现的 suspected 结论，没有 suspected / verified / disproven 的证据状态区分——一个只是怀疑的 finding 可以表现得像 confirmed bug。三个待归档框架 gap 作为本 story 的 carry-over 上下文，本 story 不修它们，它们只是暴露了通道缺口：其一 riskSignal 误报检测器把文本里提到关键词误判成修改风险面；其二 story_review_dismiss 消解误报 riskSignal 后不解除 high-risk decision 与 preMortem 强制门槛；其三 fresh worktree 缺 node_modules，workspace-local 依赖 bootstrap 缺失。

## 方案取舍

让 audit/finding 通道继承 bug 通道的证据纪律：给 finding 加 suspected / verified / disproven 证据状态模型，未复现或无源码证据的 finding 只能是 suspected、不能呈现为 confirmed；并补一个不依赖 reviewer 与 review round 的手动归档入口，让人工框架 gap 能干净进 audit backlog。范围严格限于通道的证据状态模型加手动归档入口，不顺手修 3 个 carry-over gap 本身、不碰 B-4622、不碰 riskSignal 与 worktree dependency 的实现。

## 对话纹理

用户在 B-a370 DONE 后明确：不要用现有不合适的 finding_add 去记录 finding 通道本身有问题这类 gap——先修通道再归档。3 个 gap 先纯文本 carry-over 进本 story、不进 B-META；等本 story 做完、通道有清楚的 suspected/verified/disproven 加手动归档语义后，再跑 koala audit --framework，那时 audit 产物更干净。
