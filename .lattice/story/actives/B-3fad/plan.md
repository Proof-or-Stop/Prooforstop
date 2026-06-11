# Plan: B-3fad Audit/finding channel evidence-state discipline and manual archival entry

## 总览

chosen option A：给 Finding 加 `evidenceState` 证据状态轴 + 新增 `gap_log` 手动归档入口；REVIEW→TEST gate 只阻塞 open verified critical/high。代码由 koala-implementer 写。三个 item 串行（CHK-002 依赖 CHK-001 的 evidenceState 类型，CHK-003 依赖前两者）。

**evidenceState 默认表（写死语义）**：

| 来源 | 默认 evidenceState | Gate |
|---|---|---|
| reviewer `finding_add` (REVIEW) | `verified` | critical/high open 继续阻塞，行为不回归 |
| reviewer 显式传 `evidenceState=suspected` | `suspected` | 不阻塞，只 advisory；**必须带 `uncertaintyReason`** |
| `gap_log` | `suspected` | 不阻塞 lifecycle |
| legacy finding 缺字段 | gate 视同 `verified` | 兼容旧数据，不回归 |
| audit drift finding | 机械 scan 确定 drift 可 `verified`；人工补录默认 `suspected` | 按来源区分 |

**Gate predicate（guard-utils.ts blocking 过滤）**：
```
status === 'open'
&& (severity === 'critical' || severity === 'high')
&& (evidenceState === 'verified' || evidenceState == null)
&& !isAdvisoryThisRound(severity, round)
```

## CHK-001: 给 finding 加 suspected/verified/disproven 证据状态模型

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/types.ts, packages/main/src/handlers/finding.ts, packages/main/src/core/guard-utils.ts
- Test: packages/main/src/tasks/evidence-state-gate-smoke.ts

**实现要点**:
- `types.ts`：Finding 加 `evidenceState?: 'suspected' | 'verified' | 'disproven'`（optional）。disproven 配套反证字段（能存反证摘要 + 命令 + 源码引用，如 `disprovenEvidence?: { summary; sourceRefs?; reproCommand? }`，具体形状 DEV 定）。reviewer 显式 suspected 配套 `uncertaintyReason?: string`。
- `finding.ts`：
  - `finding_add` 默认 evidenceState：reviewer 在 REVIEW 提的 finding 默认 `verified`。
  - 显式传 `evidenceState=suspected` 时必须带 `uncertaintyReason`，缺则报错。
  - 升级 suspected→verified 必须带结构化 evidence，不能只改字符串。
  - `finding_list` 每条 finding 渲染显示 evidenceState；suspected finding 进 review summary 的 advisory/attention 区，不进 blocking 区。
- `guard-utils.ts`：REVIEW→TEST blocking 过滤（约 224-231 行）按上面的 Gate predicate 加 evidenceState 维度。
- 遵守 CLAUDE.md Handler 编码约定：evidenceState enum、uncertaintyReason 约束在 handler runtime + gate 消费点同标准 runtime 校验。

**Verify**:
- `koala validate --story=B-3fad` 全绿
- `evidence-state-gate-smoke` 测试矩阵全过

**DoneWhen（测试矩阵逐条必须）**:
- legacy critical/high open finding 缺 evidenceState → 仍阻塞 REVIEW→TEST
- reviewer 新 critical/high 默认 verified → 仍阻塞
- reviewer critical/high 显式 suspected（带 uncertaintyReason）→ 不阻塞，review summary 显示为 advisory
- verified critical/high 但 status=resolved 或 dismissed → 不阻塞
- disproven critical/high open → 不阻塞
- finding_list 输出每条 finding 显示 evidenceState
- 显式传 suspected 但缺 uncertaintyReason → 报错

## CHK-002: 新增 gap_log 框架 gap 手动归档入口

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/audit-meta-store.ts, packages/main/src/registry.ts, packages/main/src/core/command-policy.ts
- Create: packages/main/src/handlers/gap-log.ts
- Test: packages/main/src/tasks/gap-log-smoke.ts

**实现要点**:
- 新增 handler `gap-log.ts`，命令 `gap_log`。入参必填 category / severity / evidence note / source（sourceRefs 等）；缺任一报明确错误，不写。
- `gap_log` 调 `ensureMetaStory(B-META-framework-audit)` bootstrap 容器（不存在则建），把记录写进 B-META 的 findings（复用 audit-meta-store 路径或等价，不造平行存储）。
- `gap_log` 默认 `evidenceState=suspected`；只有同时提供结构化 evidence 字段（sourceRefs / reproCommand / observedOutput / analysisNote 之一或多个）才允许 `verified`，否则一律 suspected。
- `gap_log` 不要求 story worktree、不参与 lifecycle gate。
- `registry.ts` 注册 `gap_log`；`command-policy.ts` 加 `gap_log` policy（allowedPhases:'all' 或 rootOnly，DEV 据语义定；destructiveRisk:'metadata-write'）。

**Verify**:
- `koala validate --story=B-3fad` 全绿
- `gap-log-smoke` 全过

**DoneWhen**:
- `gap_log` 缺 category/severity/evidence/source 任一 → 报错不写
- `gap_log` 默认写 suspected；带结构化 evidence 字段才能 verified
- B-META 容器不存在时 `gap_log` 自动 ensureMetaStory bootstrap
- `gap_log` 无需 worktree，从 main 或任意目录可跑

## CHK-003: 更新 process-fact-registry + contract 校验 + 文档

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/process-fact-registry.ts, scripts/verify-process-fact-contract.mjs, AGENTS.md
- Test: scripts/verify-process-fact-contract.mjs

**实现要点**:
- evidenceState 被 REVIEW gate 消费即流程事实：`process-fact-registry.ts` 登记 evidenceState 语义（gate-consumed）+ `gap_log` 命令 fact。
- `verify-process-fact-contract.mjs` 同步：`gap_log` 进已知命令集合；evidenceState semantic fact 可被 contract 证明硬兜底存在。
- `AGENTS.md`：说明 evidenceState 模型（默认表 + gate predicate）与 `gap_log` 用法。

**Verify**:
- `node scripts/verify-process-fact-contract.mjs` 通过
- `koala validate --story=B-3fad` 全绿

**DoneWhen**:
- process-fact contract 测试通过，evidenceState + gap_log 已登记
- `AGENTS.md` 有 evidenceState 默认表 + gate predicate + gap_log 用法
