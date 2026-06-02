# Claude Code / Codex × Superpowers × Koala 分层说明（草稿）

> 2026.04 · 用三层模型解释当前体系的职责边界，避免“谁负责 workflow、谁负责 project state、谁负责 runtime”继续混在一起

## 一句话结论

推荐把当前体系理解成三层：

1. **Claude Code / Codex**：agent runtime
2. **Superpowers**：agent workflow / methodology
3. **Lattice CLI / Koala**：project execution + verification substrate

三层不是并列功能列表，而是自上而下分工：

```text
Claude Code / Codex
  ↓ 提供模型、对话、工具调用、subagent、UI 宿主

Superpowers
  ↓ 提供 workflow、skills、方法论、默认工作习惯

Lattice CLI / Koala
  ↓ 提供 story / checklist / phase / gate / artifact / evidence / bug / review result
```

## 为什么要分三层

之前的讨论里，容易把这三件事混成一个“大而全系统”：

- agent 在哪运行
- agent 应该怎么工作
- 项目状态怎么被记录、验证、推进

这三件事本质上是三个不同问题：

| 层 | 回答的问题 |
|---|---|
| **Claude Code / Codex** | agent 在哪里运行、原生有什么能力？ |
| **Superpowers** | agent 应该按什么方法工作？ |
| **Koala** | 项目状态怎么被落盘、推进、验证、复查？ |

如果不把边界划开，就会出现两个典型问题：

1. **都想当 workflow 编排层**  
   Superpowers 和 Koala 都开始下指挥，会互相打架。
2. **没人负责 project state**  
   agent 工作流看起来很完整，但 story/gate/artifact/evidence 没有明确底座。

## 各层职责

### 1. Claude Code / Codex：Runtime 层

这是宿主层，负责：

- 模型本身
- 对话上下文
- tool calling
- subagent 能力
- 交互 UI
- 插件 / skill / agent 资产的运行环境

这一层不应该负责 project-state 语义，也不应该直接定义业务工作流本身。

它的职责是：

> **让 agent 能运行**

而不是：

> **规定项目怎么推进**

### 2. Superpowers：Workflow 层

这是工作方法层，负责：

- brainstorming
- writing-plans
- subagent-driven-development
- test-driven-development
- requesting-code-review
- finishing-a-development-branch

它的强项是：

- 塑造 agent 行为
- 减少即兴发挥
- 把“一个靠谱工程师会怎么做”变成 skill-driven workflow

它的职责是：

> **让 agent 更像一个会按流程工作的工程师**

而不是：

> **长期保存项目状态和验证证据**

### 3. Lattice CLI / Koala：Execution / Verification 底座

这是项目状态层，负责：

- story
- checklist
- phase
- gate
- worktree 生命周期
- review 记录
- test evidence
- bug / bug cleanup
- summary
- implementation review result
- artifact contract

它的强项是：

- 明确“做到哪一步了”
- 明确“为什么不能继续”
- 明确“证据在哪里”
- 明确“是不是已经真的完成”

它的职责是：

> **把工作流落成可判定、可追踪、可复查的 project state**

而不是：

> **替上层 agent methodology 设计全部工作方式**

## 组合方式

最健康的组合关系不是“谁替代谁”，而是：

- **Claude Code / Codex** 提供 runtime
- **Superpowers** 提供 workflow
- **Koala** 提供 state substrate
- **Lattice CLI 0.3.5** 是这个 substrate 的主产品入口；`koala` 是 legacy alias

也就是：

```text
用户 / agent
  ↓
Superpowers skills / workflow
  ↓ 调用
Lattice CLI / Koala CLI / MCP / story machine
  ↓ 落盘
story / checklist / phase / gate / artifact / evidence
```

一句更白话的话：

- **Claude/Codex**：让 agent 能工作
- **Superpowers**：告诉 agent 应该怎么工作
- **Lattice CLI / Koala**：记录它到底工作到了哪

## Mac App Boundary

Lattice CLI 0.3.5 moves provider/config status into CLI-first surfaces:
`host_list`, `host_probe`, `host_install`, `lattice_config_doctor`,
`authority_status`, `conduit_status`, and `conduit_explain`. The Mac App is not
the required project-state or provider/config layer. It may remain an optional
dashboard/archive surface, but the CLI owns the cold-readable migration status.

These CLI surfaces do not create a model runner or production authority. They
report capability degradations and receipt requirements, and keep
`productionDone=false` / `receiptVerified=false` unless a future receipt-backed
authority path is implemented and mechanically verified.

## 为什么这种组合比单独使用更强

### 只有 Superpowers 的风险

优点：

- agent workflow 很完整
- 使用体验流畅
- 很适合快速把模型拉进正确习惯

风险：

- project state 未必足够结构化
- 长期复查和跨 session 对齐未必够硬
- “到底做到哪了 / 为什么能继续 / 证据在哪里”可能分散在聊天和 skill 内部

### 只有 Koala 的风险

优点：

- phase / gate / artifact 很强
- 状态可追踪
- 复查能力强

风险：

- agent workflow 塑形不如 Superpowers 完整
- 自动 skill 触发和方法论体验没有那么顺
- 容易显得“系统很硬，但 agent 未必天然用得好”

### 组合后的收益

组合起来的最佳形态是：

- 上层更聪明
- 中层更守纪律
- 下层更可验证

换句话说：

> **Superpowers 负责“会做正确的事”，Koala 负责“系统知道它到底做到了什么”。**

## 边界原则

为了不让三层打架，建议遵守这 3 条边界：

### 原则 1：Superpowers 不负责长期 project state

Superpowers 可以触发 workflow，但不应该自己定义：

- story 生命周期真相源
- gate 的最终判定记录
- bug/evidence 的持久化协议

这些应由 Koala 负责。

### 原则 2：Koala 不负责塑造全部 agent methodology

Koala 应继续专注于：

- state machine
- gate
- artifact
- verification

而不是试图自己重写一整套：

- brainstorming 技法
- plan 写法
- subagent methodology
- TDD 哲学包装

这些更适合 Superpowers。

### 原则 3：Claude/Codex 不直接承载业务状态语义

Claude/Codex 提供运行时与交互，但不应成为：

- story 真相源
- checklist 真相源
- reviewer 真相源

否则一旦跨 session / 跨 tool / 跨 agent，就会丢状态。

### 原则 4：Koala 的 runtime 只限 project state

这里的 runtime 不是 agent runtime。Koala 不负责启动、恢复或调度 Codex/Claude
session，也不实现通用 worker 池、prompt marketplace、token/model 管理或通知系统。

Koala 可以借鉴 OMX 的可观察、可恢复、可诊断思想，但借鉴对象应落在
project-state runtime：

- `status`：只读展示 story / phase / worktree / reviewer / artifact / dirty risk
- `next`：只读输出当前最可信的下一步
- `doctor`：诊断 Koala 流程和本地状态健康
- 后续可选的 `.koala/state`：只能是可删除、可重建的投影缓存，不能成为第二真相源

硬边界是：story、checklist、fixture、requirements、git 仍然是真相源；所有 gate
仍由确定性 CLI / fixture / review record 判定，不由 LLM 的即时判断判定。

## 当前实践对应关系

结合当前仓库，已经能看到这个分层开始成型：

### Claude Code / Codex 层

- `.claude/agents/*`
- `.Codex/agents/*`
- `bin/koala-codex.js`
- runtime 工具调用、subagent、交互入口

### Superpowers 层（外部方法论参考）

- brainstorming
- writing-plans
- subagent-driven-development
- requesting-code-review
- verification-before-completion

这些更像“如何驱动 agent”的方法，不是 Koala 自己要全部重写的东西。

### Koala 层

- `story_advance`
- `session_brief`
- `story_review`
- `test_story`
- `summary_set`
- `implementation_review_result_set`
- `phase invariant / reason code`
- `artifact contract`

这些都属于 project state / verification substrate。

## 对 Koala 的直接指导

如果接受这份分层，Koala 后续应优先做的，不是“像 Superpowers 那样多加技能”，而是继续强化这些底座能力：

1. **state machine 更清晰**  
   phase / rollback / gate reason 继续结构化
2. **artifact 更统一**  
   让更多 reviewer / evidence / summary / implementation review 结果走统一 contract
3. **verification 更可判定**  
   减少“看起来完成”但系统无法确认的状态
4. **runtime 集成更稳定**  
   让上层 workflow 调 Koala 时更少出现 worktree / reconcile / ownership 漂移

## 一句话定位（推荐对外/对内表述）

推荐统一说法：

> **Claude Code / Codex 是 runtime，Superpowers 是 workflow，Koala 是 project execution and verification substrate。**

再白话一点：

> **他们教 agent 怎么干活，我们记录它到底干到了哪。**
