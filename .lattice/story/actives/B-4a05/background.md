## 触发事件
2026-05-04 用户复盘 B-73f3、B-686f 与 F-005 时指出三类高价值 Koala 维护问题：checklist_update 的 verificationIntent enum 错误只打印 help、init-self-check.json 每个 DONE 都阻塞、dispatch 调用没有进入 process-events 导致 channel 审计误报。

## 关键洞察
这三件事共同点不是业务功能缺失，而是流程可观察性和生命周期自洽性断裂。CLI validation 错误不可见会制造假绿，Koala 自己生成的 init-self-check 被 DONE 当成人工草稿会制造 100% 阻塞，dispatch 不落事件会让 reviewer 期望和 CLI 行为互相打架。

## 方案取舍
本 story 只修前三个最高价值问题，不顺手重做 finding_cluster、reviewer round 继承、channel 退役文档等 UX 候选。实现上优先局部修 parser/error rendering、DONE cleanup whitelist、dispatch audit event；测试用真实 CLI 复现覆盖，不用只测 helper 的假覆盖。

## 对话纹理
用户明确提醒不要为了修改而修改，所以这条 story 不扩 Koala Lab、不重构全流程。我们保留 Koala 的防误删原则，只把 Koala 生成且可识别的 story metadata 纳入安全路径；同时让错误信息把 enum 值和路径讲清楚，让主 agent 少猜少绕。
