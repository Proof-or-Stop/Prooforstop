## 触发事件
2026-05-05 复核 PVSC B-73f3、B-686f、B-e241 后确认 open bug 为 0，但过程暴露 Koala 框架风险：validate.command 曾可能假绿，benchmark 曾未被 pytest 采集，status 与 gate 提示曾不一致，DONE merge 曾被 Koala 自己的 story metadata 卡住。

## 关键洞察
这些问题不应该写成 PVSC 专属补丁，也不应该把 106 passed 或具体 story id 写进运行时逻辑。真正要固化的是机制：验证命令必须可观察、参数错误必须 fail-fast、status 必须复用 gate 事实、Koala 自产物不能被当成人工 stray 文件。

## 方案取舍
优先做硬代码能力覆盖高风险路径：validate shell/receipt/hard fail、CLI schema 错误直报、status/DONE preflight 文案统一、Koala 生命周期产物白名单。pytest collect 数异常和 fallback warning 先作为 doctor/advisory，避免把项目测试策略误变成通用硬门禁。

## 对话纹理
用户连续追问是不是硬编码、是否需要优化 Koala、是否要变成硬代码能力，核心担心是为了修改而修改。实现必须保持克制：只把复盘中能跨项目复用的流程约束落到 Koala 核心，留下明确回归测试，而不是追着某个 PVSC 案例打补丁。
