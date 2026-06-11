## 触发事件
2026-05-17 的 B-9027 DONE 收尾暴露了 Koala lifecycle 的并发缺口：另一个 story 同时把 main 推进到 B-fd38，B-9027 已写入 phase=DONE 但真实 main merge / worktree cleanup 没完成，只能靠人工 git merge 与清理恢复。

## 关键洞察
问题不是 B-9027 的 done-effects 抽取本身，而是 Koala 对 main 这个共享资源没有串行化。DONE 的 preflight、phase 写入、metadata commit、main merge、worktree remove、branch delete 是一个跨仓库临界区，必须有机械锁保护。

## 方案取舍
优先做全局 main-merge lock 加 partial-DONE recovery。锁能阻止未来并发 DONE 互撞；recovery 处理已经发生的半完成状态。暂不重写 DONE 事务模型，也不把 phase=DONE 改到 merge 成功后写入，那属于后续更大语义重构。

## 对话纹理
用户关心的是跨 story、跨团队后主 agent 不应该靠记忆和人工补救维持流程正确性。这个修复要把“并发时别写坏 main”和“坏了能机械恢复”变成 Koala 自己的硬能力，而不是让 agent 临场猜 git 命令。
