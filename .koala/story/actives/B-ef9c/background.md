## 触发事件
2026-04-27 用户要求继续解决 convergence_check 剩余的 10 个高优先级差距和 88% 需求覆盖率，同时贴出 verificationIntent.happy/edge/adversarial 中 type=cli_blackbox 被 schema 拒绝的报错。B-3749 已修复 evidence stale 与 testintent_handoff，本轮进入最终收敛层。

## 关键洞察
10 个 high gap 来自 gap_analyze 的 uncovered_requirement，而不是测试失败；它通过 truth requirement 关键词匹配代码 @task 注释，可能代表缺实现，也可能代表实现存在但没有可追溯元数据。cli_blackbox 则是旧流程文档与新 schema 的兼容断层。两者都属于 Koala 自身接口/追溯层的问题。

## 方案取舍
优先逐条核对 high gap，不用粗暴降低 severity 或关闭检查。已实现但未映射的需求通过更准确的 @task 注释和文档元数据连接；确实缺少的行为补最小实现。verificationIntent type 采用兼容归一，cli_blackbox 映射 cli、browser_blackbox 映射 browser，避免旧 agent 生成内容直接失败。

## 对话纹理
用户问“那先解决10个高优先级差距和88%需求覆盖率”，并询问 cli_blackbox 报错是不是问题。回答必须落到可全局复用的 Koala 修复，不应只告诉用户手动把 cli_blackbox 改成 cli，也不能靠 waiver 绕过 convergence。
