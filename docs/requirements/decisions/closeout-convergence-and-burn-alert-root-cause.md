# Closeout Convergence 与 Burn-Alert 根因分析

## 状态

- 状态：已确认根因，待拆分执行 Story
- 关联 Story：B-235e
- 日期：2026-07-20

## 摘要

B-235e 暴露了两个不同层次的问题：

1. 严格的 Prompt Envelope / ReviewRun 证据绑定，与自动写入的 lifecycle metadata 发生冲突，导致 closeout 反复判定 reviewer evidence stale。
2. `usage_sweep --alert` 能发现高消耗会话，但结果只是 advisory；convergence breaker 不消费 session burn 信号，因此无法阻断“会话持续烧 token、Story 长时间无进展”的形态。

第一个问题是 B-235e 触发的 closeout 设计缺陷；第二个问题是系统中原本存在、但此前没有被 gate 消费的监控缺口。

## 一、Closeout Convergence 问题

### 现象

B-235e 的业务实现、validation、delivery check、live smoke 和 DONE-required full suite 均能通过，但 DONE 仍可能拒绝：

- Prompt Envelope eligibility digest 不匹配；
- `priorPassRef`、`reviewBasisDigest` 或 `taskSemanticDigest` 过期；
- reviewer pass 被判定为 stale closeout review；
- convergence 反复要求 DEV → REVIEW。

### 触发链路

```text
reviewer pass
  ↓
自动写入 review/lifecycle metadata
  ↓
HEAD 发生变化
  ↓
Prompt Envelope eligibility 重新计算
  ↓
旧 pass 的 digest / priorPassRef 不匹配
  ↓
pass 被判 stale
  ↓
回 DEV → REVIEW
  ↓
再次写入 metadata
  ↓
循环
```

### 为什么以前不明显

旧流程的 reviewer evidence 绑定较简单，metadata writer 较少，也没有同时启用：

- Prompt Envelope incremental eligibility；
- signed ReviewRun；
- `materialHash` / `storyFilesHash` 严格绑定；
- DONE-required validation；
- metadata-aware convergence 检查。

因此风险一直存在，但没有被这组更严格的约束同时触发。

### 根因

业务材料和生命周期 metadata 没有被充分分层：

```text
materialHash
  代码、Prompt、配置、契约、测试等业务材料

storyFilesHash
  Story 拥有的业务文件集合

metadataHash
  .lattice/story/** 的过程记录和证据写入
```

当前某些 gate 仍把 metadata HEAD 变化间接视为 material freshness 变化。

## 二、Burn-Alert 监控缺口

### 现象

`usage_sweep --since=1d --alert` 可以发现长期、高 token 消耗的 Codex/Claude desktop 会话，并给出：

> Close/restart it; proof-or-stop cannot stop sessions it did not launch (advisory only, no gate).

但它不会改变 Story 状态，也不会触发 convergence breaker。

### 为什么之前不明显

外部 desktop/Claude 会话不一定由 Proof-or-Stop 启动，且可能完全不产生 Story event。现有 breaker 主要观察：

- Story advance；
- gate failure；
- takeover；
- 重复 lifecycle 操作。

因此系统看到的是：

```text
Story 没变化
没有 gate failure
没有 advance
```

而不是：

```text
关联 Story 的 session 正在持续消耗 token，且长时间没有进展
```

### 根因

usage 观测链与 lifecycle 执行链没有接通：

```text
usage_sweep --alert  →  advisory report
                         ✕
convergence breaker  →  不消费 burn signal
```

这不是 B-235e 的业务 bug，而是系统级保护缺口。

## 三、修复边界

### Closeout 修复

应将 material evidence 与 metadata evidence 分离：

- 只有 `materialHash` 或 `storyFilesHash` 变化，才要求完整 reviewer 重审；
- 仅 lifecycle metadata 变化时，保留 Prompt Envelope eligibility；
- reviewer pass 绑定 material/story hash，不绑定 metadata HEAD；
- convergence 正确识别 metadata-only re-attestation；
- DONE-required evidence 支持可信 metadata descendant lineage。

### Burn-Alert 修复

建议独立 Story 实现第五信号：

```text
burnThresholdExceeded
AND sessionStillActive
AND sessionMentionsStory
AND storyHasNoAdvanceFor(N hours)
```

分级动作：

1. **Advisory**：首次触发，仅提示关闭/重启。
2. **Soft block**：阻止该 session 派发新的 Story 任务，但允许只读诊断。
3. **Hard freeze**：持续触发时冻结 Story 自动推进，要求人工 ack。
4. **Recovery**：关闭旧 session、启动干净 session、人工确认后恢复。

`usage_sweep` 不应直接修改 Story 状态，而应写入结构化 `burn_signal`，由 convergence breaker 统一判定。

## 四、安全边界

- usage estimate 不是 billing truth；
- 无 Story 关联的 session 只告警，不冻结 Story；
- 正常推进的 Story 不得被误判；
- burn signal 不能伪造 validation、review pass 或 DONE evidence；
- Proof-or-Stop 不强制杀死外部 desktop/Claude session；
- freeze/recovery 必须写入结构化 process event；
- 人工恢复不能绕过 review、validation、delivery 或 DONE gate。

## 五、验收标准

### Closeout

- 连续 reviewer metadata commit 不使 material-bound pass 失效；
- metadata-only 变化不触发完整重审；
- 真实 material 变化仍强制完整重审；
- 四个 reviewer lane 能稳定完成 DONE；
- 连续 reviewer pass、validation、delivery、live smoke 和 DONE-required metadata 写入后，`done_prepare` 不再循环。

### Burn-Alert

- 高 burn + Story 零 advance 能产生结构化第五信号；
- 正常 Story advance 不误触发；
- 无 Story 关联的 session 不冻结 Story；
- soft block / hard freeze / human recovery 可验证；
- 所有触发和解除都有 evidence；
- 原有 advisory sweep 行为保持兼容。

## 结论

B-235e 的停滞不是 Prompt 业务逻辑失败，而是严格 evidence binding 与 metadata auto-commit 的边界没有分清。长期 session burn 则是另一个原有监控缺口。两者应分别修复：先修 closeout evidence 分层以完成 B-235e，再用独立 Story 将 burn-alert 接入 convergence breaker。
