## 触发事件
2026-06-01 在 B-edca 收尾时，Claude reviewer 被要求只读审查，却因为拥有 Bash 权限直接调用 koala review_pass_set，后来代码继续变化导致该 pass 被 Koala materialHash 判为 stale。Gate 正确阻止了旧证据复用，但暴露出 reviewer delegation 缺少只读执行边界。

## 关键洞察
Koala 的 evidence gate 能识别 stale review pass，却无法知道某次外部 Claude/Codex/Gemini 调用本来应是只读 reviewer。需要把“只读 reviewer 不允许直接执行 mutating Koala 命令”从口头约束升级为 CLI/Runner 可执行的流程事实。

## 方案取舍
不改变 review_pass_set 的正常 reviewer 写证据能力；新增受控 read-only reviewer mode 或命令策略，让 owner 可以显式把委派 reviewer 放进只读沙箱。只有在该模式下才阻止 review_pass_set、finding_add、story_advance 等 mutating commands，避免破坏标准 Koala reviewer 流程。

## 对话纹理
用户关注的是防止 Agent 越权写流程事实，而不是再叠加一个口头提醒。交付应该让下一次 Codex 派 Claude 做只读审查时，即使 Claude 试图运行 mutating koala 命令也会被机械拒绝，并且测试能复现这个拒绝。
