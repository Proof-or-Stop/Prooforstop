## 触发事件
2026-06-01 B-1148 DONE 收尾时，koala validate 会更新 tracked 的 .koala/story/.../test-evidence.json；提交后 session_brief 又提示 materialHash drift，形成用户可见的 stale advisory 循环。

## 关键洞察
问题不是测试失败，而是 validation artifact、git HEAD、materialHash freshness 三者的职责边界不清。test-evidence 是最新测试记录，但不应该让用户陷入提交一次又 stale 一次的流程噪音。

## 方案取舍
优先做最小修复：明确 validate 写入的 test-evidence 是否应计入 materialHash/freshness，或让 freshness 逻辑忽略自更新的测试证据元数据。避免扩大到重写 DONE gate 或全部 evidence schema。

## 对话纹理
用户关心的是 Koala 流程不要自己制造混乱：如果 DONE gate 已经通过，就不应该同时告诉用户还有 stale 需要恢复。修复后，新 Agent 看到 session_brief 应该得到清晰下一步，而不是被误导反复刷新。
