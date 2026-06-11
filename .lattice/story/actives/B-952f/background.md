## 触发事件
2026-04-27 在 B-e11b DONE 后执行 convergence_check，项目显示未收敛：17 个 Story 未完成、10 个 high gap、4 个注释错误。story_list 同时显示只有 DONE 与 DISCARDED，没有 active story，说明至少 Story 完成项存在统计误报。

## 关键洞察
这不是一个单纯功能缺失问题，而是收敛器把历史废弃方案当成待办 backlog，叠加 summary.ts 顶部 @task 元数据不完整。先修假 blocker，可以让后续 high gap 回链的信号更干净。

## 方案取舍
本 story 只处理两个确定性问题：DISCARDED 终态过滤和 summary.ts 注释字段补齐。10 个 high gap 涉及需求回链或真实实现，应该拆到后续 story，避免在一个 bug story 里混入大量范围扩张。

## 对话纹理
用户问 convergence_check 的未收敛项如何解决，希望得到可执行路径。我们先用小切片把明显误报修掉，再用下一轮 story 处理需求覆盖率，保持 Koala 流程本身可解释、可验证、可继续推进。
