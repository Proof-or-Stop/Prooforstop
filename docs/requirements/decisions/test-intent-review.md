# testIntent 对抗审查体系

## 决策 1：checklist item 必须带 testIntent

每个 checklist item 可带 `testIntent` 字段，三栏结构：
- **happy**: 正常路径
- **edge**: 边界路径
- **adversarial**: 对抗路径（暴力操作、断网、并发、时序异常）

缺少 testIntent 时 story_create 给出提示。三栏填不满说明 item 拆得不对。

**理由**：测试意图决定测试质量。脚本只是执行手段，意图设计不到位测试脚本写再多也没用。

## 决策 2：Agent A/B 对抗审查

- Agent A 负责拆解需求和实现代码
- Agent B 负责审查 testIntent 完整性（找弱项、交叉场景遗漏、truth 未覆盖的约束）
- 写 testIntent 的和审 testIntent 的必须分开

`story_review` 命令输出 `_reviewPrompt`，包含 truth + checklist + testIntent 对照材料，交给独立 agent 审查。

**理由**：自己审自己找不到盲点。testIntent 是考卷（Agent B 审过的），fixture/browser case 是答题（Agent A 按意图写）。

### testintent_handoff 交接包

PLAN 阶段可运行 `koala testintent_handoff --storyId=B-xxx`，让 CLI 生成给 test-intent agent 的结构化交接包。交接包包含 story 摘要、目标 worktree、待补齐的 checklist item、已有 verificationIntent/testIntent 数量，以及 `checklist_update` 示例命令。

`testintent_handoff` 是正式 CLI 命令，应同时满足三层一致性：`koala help` / `koala testintent_handoff --help` 可发现，handler registry 可调用，PLAN phase allowlist 允许执行。它不是特定 story 的 adapter，也不是 `dispatch` 的隐藏替代品；它的职责只是在 PLAN 阶段把 test-intent agent 需要的上下文打包清楚。

## 决策 3：白盒 fixture 和 browser test 的分工

- **白盒 fixture**：函数正确性（fn + execute + expect）
- **browser test**：业务正确性（模拟真实用户操作路径，覆盖边界和异常）

browser test 验证的是"业务链路在真实操作下的表现"，不只是"渲染映射"。例如：升级后经验条归零还是溢出、暴力连点会不会重复扣费。

DEV 阶段同时写代码和 fixture（含 browser case），testIntent 前置。

## 决策 4：漏需求的三层防线

- **事前**：三栏结构逼完整 + Agent B 对抗审查
- **事中**：checklist 逐项验证，标 done 需 testIntent 对应的测试通过
- **事后**：代码覆盖扫遗漏（哪些代码路径没被 testIntent 覆盖）

需求完整性没有银弹，靠多层防线降低遗漏概率。

## 决策 5：checklist item 拆解标准

合格的 item 必须同时满足：
1. 有可观测的结果（用户能看到/感受到变化）
2. 有明确的输入触发（操作、事件、时间都算触发）
3. happy/edge/adversarial 三栏能填满
