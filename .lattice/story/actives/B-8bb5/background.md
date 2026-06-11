## 触发事件
2026-05-12 在 SimCell story B-cacf 的 DEV 阶段，agent 尝试运行 `koala finding_cluster` 聚簇 9 个 reviewer findings 时被 phase gate 拒绝。CLI 同时允许 finding_list、finding_dispatch 和 dispatch，导致流程只能把所有 findings 一次性派给 implementer。

## 关键洞察
这不是 SimCell 的本地版本或配置漂移。全局 koala 已经链接到 Orchestrate 新版，问题来自 Orchestrate 默认 phaseTools：DEV 允许 finding_add / review_pass_set / finding_dispatch，却没有允许 finding_cluster。流程事实分级表把 finding_cluster 标为 L2，但 phase 白名单仍是独立硬编码。

## 方案取舍
最小修复是把 finding_cluster 加到 DEV；更稳的是补一个硬编码一致性测试，保证能产生和派发 finding 的阶段也能整理 finding。暂不把所有 L2 命令自动全阶段开放，避免扩大命令面，只修本次可观察到的 reviewer finding workflow 缺口。

## 对话纹理
用户连续追问本地其他项目是否可用，随后用截图指出 SimCell 仍然出现 DEV 阶段 cluster 不可用。这里需要承认上一轮只验证了发布链接和 process-fact registry，没有验证 phaseTools 与 registry 的一致性，修复要落在代码入口而不是解释给 agent 听。
