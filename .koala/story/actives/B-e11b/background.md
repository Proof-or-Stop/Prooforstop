## 触发事件
2026-04-27 用户明确要求 Koala 支持 Android 原生、PHP、Python、Go、C++、Java、Swift、Objective-C 等跨语言项目的开发测试，并确认方向不是给某一种语言加特判 adapter，而是语言无关测试协议加可插拔执行器。当前 verifier.ts 已有 validate.ts 和少量自动发现命令，但结构还混在 handler 内，难以扩展。

## 关键洞察
Koala 的 story/checklist/review/DONE gate 天然是语言无关的，真正耦合语言的是 validate 命令发现、执行、结果包装和 evidence 写入。先固化协议和执行器，后续 Python、PHP、Android、C++ 都只是不同 detector 生成同一种 ValidationPlan，不应该让 DONE gate 知道语言细节。

## 方案取舍
选择先抽象 ValidationCommand、ValidationPlan、ValidationResult 和 shell executor，不一次性实现所有语言 detector。这样第一步能保持行为兼容，降低回归风险，也为 timeout、optional、cwd、env、输出截断、命令明细记录提供统一位置。validate.ts 仍保持最高优先级，配置命令也继续可用。

## 对话纹理
用户前面已经连续遇到 Python 项目缺 validate.ts、JS fixture runner 无法 import Python、test-evidence 不回写、metadata commit stale 等问题，所以这个 story 的用户价值不是抽象重构，而是让用户在非 JS 项目里跑 koala validate 时看到清楚的命令计划、统一结果和可被 DONE gate 正确消费的 evidence。
