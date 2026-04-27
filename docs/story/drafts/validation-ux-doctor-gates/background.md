## 触发事件
2026-04-27 用户反馈过 koala validate 报 0 项失败但仍阻塞、test-evidence 不回写、metadata-only commit 导致 stale 死循环、以及不同项目不知道该如何配置验证入口。跨语言执行器上线后，如果解释和诊断不到位，这些体验问题会在 PHP、Android、C++ 项目里放大。

## 关键洞察
跨语言支持不只是能跑命令，还要能回答三个问题：为什么选这些命令，失败是代码问题还是环境问题，DONE gate 为什么阻塞。validate --explain、doctor 依赖诊断、gate 错误摘要必须共享同一份 ValidationPlan 和 ValidationResult，否则用户会继续靠猜。

## 方案取舍
选择把 UX 放在独立 story，避免和协议、detector、原生平台支持混在一起。这个 story 不新增大量语言规则，而是把 explain、doctor、错误摘要和 evidence 更新链路打磨好，确保自动发现、配置覆盖、optional warn、coverage missing 都能被人读懂。

## 对话纹理
用户一直在拿真实项目验证 Koala，而不是只看单元测试。这个 story 的成功标志是用户在非 JS 项目里跑 koala validate 或 story_advance TEST/DONE，看到的是哪条命令失败、为什么失败、怎么配置，而不是 0 项失败、找不到 validate.ts 或 stale 这种绕圈提示。
