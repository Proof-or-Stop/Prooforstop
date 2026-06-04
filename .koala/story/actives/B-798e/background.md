## 触发事件
2026-06-04 在 B-47cd DONE 后运行 convergence_check，所有 story 完成、需求覆盖和 Flow 都已通过，但代码注释合规仍显示 10 个注释错误，需要单独修复这个项目级收敛残留。

## 关键洞察
错误集中在 observability 与 story-authority 相关文件的 legacy @task 注释元数据，不是运行时逻辑失败；修复应补齐 @changes 并把 invalid @type=test 改成 validator 接受的类型。

## 方案取舍
选择只改 annotation header，不改变 runtime behavior、CLI 命令语义或测试逻辑；这样能让 cli-validate 和 convergence_check 变绿，同时避免把旧 validator 清理扩大成重构。

## 对话纹理
用户明确指出上一轮交付里剩下的 convergence_check 错误并要求处理，所以这次目标是把这一个红项清掉，而不是继续讨论无人值守调度或新增产品能力。
