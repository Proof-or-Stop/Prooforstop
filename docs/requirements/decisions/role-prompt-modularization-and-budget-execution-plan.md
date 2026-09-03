# Proof-or-Stop Role Prompt 模块化与预算治理执行方案

Status: accepted
Source story: B-7ffc
Source proposal: DDP-001
Created: 2026-07-17

## Canonical race burn-in execution (B-9812)

`review-incremental-context-smoke` always retains the three deterministic
concurrent-writer masks (`11111`, `01010`, and `10101`) and all gate/mutation
assertions. Canonical root testing runs the `10101` burn-in once because the
historical twenty iterations are identical repetitions of that fixed mask.
Soak testing retains the original twenty repetitions by setting
`PROOF_OR_STOP_INCREMENTAL_STRESS=1`; this is an opt-in stress tier, not a substitute
for the deterministic canonical matrix.

## Decision

Adopt the evidence-calibrated role prompt modularization and budget governance plan as the canonical execution plan for future sequential Stories; this planning decision is not implementation evidence and does not change runtime behavior by itself.

## Context

The reviewed plan existed only in temporary storage. A durable repository decision is required before implementation begins so later agents and reviewers share one discoverable source of truth.

## Scope

Applies to the seven ordered implementation Stories and the conditional budget-enforce follow-up described in this document. This promotion Story changes documentation only.

## Non-Goals

- Do not change runtime code, Prompt templates, reviewer dispatch, role authority, or lifecycle behavior in this promotion Story.
- Do not treat this accepted plan as proof that any implementation milestone is complete.
- Do not start multiple implementation milestones inside the promotion Story.

## Options Considered

### Keep the reviewed file in temporary storage

Pros:
- No repository change

Cons:
- The file can be deleted
- It is not a discoverable source of truth

### Copy the file directly without structured promotion evidence

Pros:
- Preserves the original layout exactly

Cons:
- Bypasses the implemented proposal freshness and scope checks
- Leaves weaker promotion provenance

## Chosen Approach

Use the canonical Proof-or-Stop decision-doc promotion flow, preserve the reviewed execution plan below, and execute its Stories sequentially.

### 1. 文档目的

本方案用于减少 Proof-or-Stop 角色 Prompt 的重复内容、上下文成本和多轮复审开销，同时保持现有流程事实、角色权限、证据要求和 fail-closed 门禁不被削弱。

本方案是执行文档，不直接授权删除角色、放宽门禁或改变 reviewer evidence 的法律写入路径。所有实现仍应通过独立 Proof-or-Stop Story 完成，并按照正常的 PLAN、DEV、REVIEW、TEST、DONE 流程验证。

### 2. 背景与当前基线

当前 `proof-or-stop-prompt-baseline.json` 记录 **17** 个角色的最终 `agent_prompt` 输出（`expectedRoleCount: 17`，由 `scripts/verify-proof-or-stop-prompt-baseline.mjs` 的 `EXPECTED_ROLE_COUNT` 钉住；其中 13 个带 `proof-or-stop-` 前缀）。

这 16 项是历史兼容基线，不等于当前 active role 集合。其中
`proof-or-stop-review-channel` 已退役，由 `proof-or-stop validate --channel` 的机械 gate
接管；它只应保留在 compatibility/audit baseline 中，不得作为待迁移的 active
reviewer 重新启用。

只读测量基线：

| 角色 | 当前字节数 | 当前行数 |
|---|---:|---:|
| `proof-or-stop-review-story-init` | 18,300 | 272 |
| `proof-or-stop-review-scope-plan` | 14,896 | 207 |
| `proof-or-stop-implementer` | 14,642 | 238 |
| `proof-or-stop-review-behavior` | 14,270 | 186 |
| `proof-or-stop-review-delivery` | 13,264 | 289 |
| `proof-or-stop-review-channel` | 12,113 | 194 |
| `proof-or-stop-review-docs` | 12,101 | 201 |
| `proof-or-stop-review-quality` | 10,105 | 177 |
| `proof-or-stop-review-concept` | 9,595 | 153 |
| `proof-or-stop-evaluator` | 8,907 | 202 |
| `test-case-reviewer` | 8,767 | 155 |
| `test-intent` | 7,572 | 168 |
| `proof-or-stop-review-test-coverage` | 4,404 | 56 |
| `proof-or-stop-evaluator-cli` | 4,375 | 120 |
| `product-reviewer` | 3,262 | 92 |
| `implementation-reviewer` | 2,158 | 83 |
| **合计** | **158,731** | **2,793** |

粗略估算，全部角色文本合计约 4 万 tokens。正常 dispatch 不会把 16 个角色同时发送给一个 Agent，因此总量不等于单次请求成本；当前主要问题是：

1. 多个角色重复携带 Runtime Guide、生命周期纪律、owner/reviewer 权限边界、story 文件访问规则和证据规则。
2. 同一角色多轮复审时反复接收基本不变的完整 Prompt。
3. active、compatibility 和 legacy 角色共用同一角色数量与 baseline 表达，难以判断新流程的真实默认表面。
4. Prompt 文件变短不必然降低实际 tokens；如果运行时仍然展开全部公共文字，维护层抽取不会带来执行成本下降。
5. 缺少角色级、单次装配级和 reviewer-wave 级预算门禁。

### 3. 目标

#### 3.1 功能目标

1. 把通用规则抽成共享、版本化且紧凑的 Runtime Contract。
2. 每个角色 Prompt 只保留职责差异、允许命令、禁止动作、输入、输出和停止条件。
3. 增量复审只注入从上次有效 pass 以来的变更上下文，不重复展开完整 story candidate context。
4. 将 legacy 角色移入 compatibility registry，不进入新 Story 的默认 active role 集合。
5. 建立 Prompt bytes、lines、estimated tokens、重复率、最终装配大小和
   provider-reported usage 的分层预算观测；不可见的 host/provider 输入不得
   伪装成可精确复算。
6. 保持当前流程事实双层契约：Prompt 指路，CLI/handler/gate 负责机械兜底。

#### 3.2 可观察结果

完成后应能观察到：

- 完成对应角色迁移后，`agent_prompt` 输出包含明确的 Runtime Contract 与 Role
  Contract 版本；Story 1 只在 measurement sidecar 中记录版本，不创建尚无
  ReviewRun 的 Prompt Envelope，也不改变现有 assembled prompt 字节。
- 首轮 reviewer 获得完整但有界的 task context。
- 后续增量 reviewer 只获得角色合同、绑定信息和变更 delta。
- role contract、runtime contract 或 review policy 变化时，增量复审自动升级为 full review。
- compatibility 角色仍可显式调用，但不会进入新 Story 的默认 reviewer 列表。
- baseline 报告 active/compatibility/retired 角色数量以及每层预算。
- 角色 Prompt 缩短后，历史 Story A/B 评审没有出现高严重度 finding 漏检。
- A/B 同时报告本方案可控的 assembled prompt 成本、host 可见的 dispatch 输入
  和 provider-reported 实际输入；缓存读写单独列示。

### 4. 非目标

本方案不做以下事情：

1. 不通过删除安全规则、证据规则或 fail-closed 条件换取 Prompt 变短。
2. 不要求 Agent 自行发现关键流程规则；会影响 phase、review、test、done 或审计的事实必须由机械门禁保护。
3. 不把“公共规则存入文件”误报为 token 优化；只有运行时最终装配文本减少才计入效果。
4. 不在第一阶段直接删除 `test-intent`、`test-case-reviewer` 等 legacy 入口。
5. 不让 incremental review 在 scope、policy、role contract 或 material binding 不明确时继续。
6. 不改变 reviewer、implementer、owner 的现有写权限。
7. 不把 Prompt hash 相同等同于语义正确；仍需历史 Story A/B 与对抗验证。

### 5. 设计原则

#### 5.1 可控成本真相与完整输入边界

源模板大小不能代表运行成本。成本观测分为三层：

1. `assembledPromptTokens`：本方案直接装配并可复算的 Prompt。
2. `knownDispatchInputTokens`：host launcher 可见的 Prompt、参数、工具清单和
   instructions；不宣称覆盖 CLI/provider 隐藏包装。
3. `providerProcessedInputTokens`：provider 实际报告的输入，按 uncached、
   cache-read 和 cache-creation 分列；provider 不提供时明确记
   `unavailable`，不得估零。

`providerProcessedInputTokens = uncachedInputTokens + cacheReadInputTokens +
cacheCreationInputTokens`；output 另列，不混入输入降幅。

Role 重构的机械目标针对第一层；商业效果和 A/B 结论同时报告第一、第三层。
第二层只在 host 能完整观测其本地输入时报告。任何“完整 model input”表述都
必须注明可观测边界。

#### 5.2 公共规则只保留最小必要文本

能由 CLI、handler、gate 机械执行的详细规则，应在 Prompt 中保留短指令和失败后的下一步，不重复展开实现细节。

#### 5.3 角色合同必须自足

角色合同缩短后，Agent 仍应能明确回答：

- 我是谁？
- 我必须检查什么？
- 我允许读取什么？
- 我允许写什么？
- 我不能做什么？
- 我必须输出什么结构化结果？
- 哪些情况必须 fail closed？

#### 5.4 增量复审默认 fail-closed

无法证明 prior pass、新旧 material、storyFiles、scope、role contract 和 policy 绑定时，不得使用增量 Prompt。

incremental eligibility 不能由主 Agent 或 reviewer 自报。它必须由读取实际
Story facts、freshness 分类和 contract/policy registry 的同一 CLI 进程计算，
并由 REVIEW gate 校验 reviewer pass 所绑定的 Prompt Envelope。

#### 5.5 Legacy 兼容与默认激活分离

“仍可调用”不等于“默认参与新流程”。compatibility 角色必须有 replacement 和明确的非默认状态。

### 6. 目标架构

最终 Prompt 由可信 CLI 装配器装配。主 Agent 只能请求角色和 Story，不能自行
选择或拼接 `full` / `incremental` 上下文。装配器根据机械 eligibility 选择
Task Context 的 full 或 incremental 形态；二者不会同时注入。

```text
PromptEnvelope
├── Compact Runtime Contract
│   ├── lifecycle facts
│   ├── ownership/write boundaries
│   ├── story-file access rules
│   └── evidence/fail-closed rules
├── Role Contract
│   ├── responsibility
│   ├── allowed commands
│   ├── forbidden actions
│   ├── required inputs
│   ├── required checks
│   └── required outputs
└── Task Context (oneOf)
    ├── Full Context
    │   ├── story/checklist facts
    │   ├── candidate files/docs
    │   ├── verificationIntent
    │   └── current material bindings
    └── Incremental Context
        ├── prior pass binding
        ├── changed and impacted files
        ├── changed findings
        ├── scope expansion
        └── exact re-review reason
```

#### 6.1 装配信任边界

1. 扩展现有 `proof-or-stop agent_prompt --role=<name>`，使其在需要 Story 上下文时接受
   `--storyId=<id>`；不提供由调用方强制选择 context mode 的参数，full 或
   incremental 完全由 CLI eligibility 结果决定。
2. Runtime Contract、Role Contract、Task Context、eligibility 和 digest 必须
   由实际发送 Prompt 的同一进程读取、计算并记录，避免全局 CLI、worktree
   模板或缓存版本偏斜。
3. 装配结果生成不可变 Prompt Envelope；`review_run_start` / reviewer pass
   必须引用该 envelope，且签名域包含 envelope digest。
4. REVIEW gate 必须重新计算或验证 envelope、eligibility、current round 和
   freshness。eligible=false 却使用 incremental 的 pass 一律无效。
5. 新增的 eligibility、Prompt Envelope、budget violation 和 gate evidence 必须登记到
   process fact registry，并同步相应 contract verifier；不能只加 schema 或
   Prompt 文案。
6. 在 CLI 内可信装配和 gate 绑定落地前，incremental 只能保持现有的只读
   advisory，不能成为可消费的 gate evidence。

#### 6.2 Runtime Contract

建议数据结构：

```ts
interface RuntimeContract {
  schemaVersion: 'proofbound.agent-runtime.v1';
  lifecycleVersion: string;
  ownershipVersion: string;
  evidenceVersion: string;
  compactText: string;
  semanticDigest: string;
  renderDigest: string;
}
```

Runtime Contract 只保留所有角色都必须知道的事实：

- 当前生命周期顺序。
- owner、implementer、reviewer 的写权限边界。
- `docs/story` 和 fixture 的 CLI-only 访问纪律。
- reviewer finding/pass 的签名与 evidence 要求。
- 不得伪造多主机、人类批准或 Authority。
- 关键失败必须 fail closed 并返回机器可执行的下一步。

#### 6.3 Role Contract

建议统一结构：

```ts
interface RoleContract {
  schemaVersion: 'proofbound.role-contract.v1';
  roleId: string;
  status: 'active' | 'compatibility' | 'retired';
  replacementAgentType?: AgentDispatchCanonicalType;
  migrationHint?: string;
  defaultDispatch: boolean;
  responsibility: string;
  requiredInputIds: string[];
  requiredCheckIds: string[];
  allowedCommandIds: string[];
  forbiddenActionIds: string[];
  requiredOutputIds: string[];
  stopConditionCodes: string[];
  semanticDigest: string;
  renderDigest: string;
}
```

稳定 ID 字段是机械 policy，面向 Agent 的说明由 registry metadata 渲染。
`semanticDigest` 覆盖权限、检查、输入、输出和停止条件；`renderDigest` 覆盖
实际发送文本。任何进入模型输入的 wording 变化都可能改变行为，因此默认仍使
旧 pass 失效。只有机械证明未进入 assembled prompt 的展示 metadata 变化，
才允许仅更新 render/audit 记录而不触发 full review。

#### 6.4 Prompt Envelope

Story 1 的无 Story 基线使用独立 `PromptMeasurementRecord`，只记录角色输出成本，
不携带或冒充 ReviewRun authority：

```ts
interface PromptMeasurementRecord {
  schemaVersion: 'proofbound.prompt-measurement.v1';
  roleId: string;
  runtimeContractVersion: string;
  runtimeSemanticDigest: string;
  runtimeRenderDigest: string;
  roleContractVersion: string;
  roleSemanticDigest: string;
  roleRenderDigest: string;
  assembledPromptDigest: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  tokenEstimatorVersion: string;
}
```

进入真实 Story dispatch 后，最终装配结果必须记录：

```ts
interface PromptEnvelope {
  schemaVersion: 'proofbound.prompt-envelope.v1';
  envelopeId: string;
  roleId: string;
  storyId: string;
  dispatchKind: 'story-dispatch' | 'review-run';
  reviewRunId?: string;
  reviewRound?: string;
  lane?: string;
  createdAt: string;
  headHash: string;
  runtimeContractVersion: string;
  runtimeSemanticDigest: string;
  runtimeRenderDigest: string;
  roleContractVersion: string;
  roleSemanticDigest: string;
  roleRenderDigest: string;
  contextMode: 'full' | 'incremental';
  contextDigest: string;
  priorPassRef?: string;
  materialHash?: string;
  storyFilesHash?: string;
  policyHash?: string;
  eligibilityDecision: 'full' | 'incremental';
  eligibilityDigest: string;
  freshnessClassification?: string;
  impactPolicyVersion?: string;
  eligibilityReasonCodes?: string[];
  changedFilesDigest?: string;
  impactedFilesDigest?: string;
  reviewBasisDigest?: string;
  incrementalContextDigest?: string;
  taskSemanticDigest?: string;
  selectionReason?: 'SAFETY_REQUIRES_FULL' | 'SAFE_INCREMENTAL'
    | 'FULL_CHEAPER_OR_EQUAL' | 'INCREMENTAL_BUDGET_EXCEEDED'
    | 'REVIEWER_REQUESTED_FULL';
  fullContextBytes?: number;
  incrementalContextBytes?: number;
  escalatedToFull?: boolean;
  escalationReason?: string;
  budgetViolation?: 'incremental' | 'full';
  knownExecutionEnvironmentDigest: string;
  assemblerVersion: string;
  dispatchProtocolVersion: string;
  launcherSpecDigest: string;
  commandPolicyDigest: string;
  toolPolicyDigest?: string;
  systemInstructionDigest?: string;
  requestedModelId?: string;
  dispatchPromptDigest?: string;
  hostRenderIdentityDigest?: string;
  assembledPromptDigest: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  tokenEstimatorVersion: string;
}
```

`knownExecutionEnvironmentDigest` 只覆盖本地可观测、可规范化的 execution
environment；不得声称覆盖 provider 隐藏 system wrapper。served model、实际
provider usage 和 cache 数据在运行后写入独立 observation：

```ts
interface DispatchUsageObservation {
  envelopeId: string;
  reviewRunId?: string;
  servedModelId?: string;
  assembledPromptTokens: number;
  knownDispatchInputTokens?: number;
  providerProcessedInputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  wallClockMs?: number;
  providerUsageStatus: 'reported' | 'unavailable';
}
```

Prompt Envelope 不另建一套 run/attempt authority：

- REVIEW evidence 的 Envelope 作为 content-addressed artifact 归属于现有
  signed `ReviewRun`；`envelopeId` 由 canonical envelope content 计算。
- `ReviewRun` 绑定 `reviewRunId + envelopeId + headHash`，reviewer pass 再绑定
  当前 ReviewRun。旧 Envelope 不能在新 HEAD 或新 round 重放。
- INIT/PLAN/DEV 等非 ReviewRun dispatch 使用 `dispatchKind=story-dispatch`，
  只产生 prompt/usage audit，不能据此铸造 reviewer evidence。
- retry/重新 dispatch 创建新的 ReviewRun；provider 调用重试复用 usage ledger
  现有 `ledgerCallId + attemptId`，不在 Envelope 重复定义 attempt。
- Envelope 只允许可信 CLI 装配进程创建；reviewer 和主 Agent只读。

### 7. 16 个角色的具体修改方案

#### 7.1 `proof-or-stop-review-story-init`

保留：

- 需求真实性、术语、缩写和前提检查。
- riskSignals 和 priority 检查。
- INIT 阶段允许的唯一写入。
- blocker/advisory 输出合同。

删除或抽取：

- 重复 Runtime Guide。
- 通用 owner/reviewer 权限说明。
- 通用 story 文件访问纪律。
- 其他 reviewer 共用的 finding/pass 格式解释。

目标：从 18.3 KB 降到不超过 12 KB。

#### 7.2 `proof-or-stop-review-scope-plan`

保留：

- checklist、verificationIntent 与 files contract 的 coverage。
- excluded、orphan、drift 和 scope gap 分类。
- candidate basis、扫描升级条件和非升级理由。
- scope-check 输出结构。

删除或抽取：

- 通用生命周期说明。
- 通用 review 写权限说明。
- 与 quality/concept reviewer 重复的实现质量检查。

目标：不超过 10 KB。

#### 7.3 `proof-or-stop-implementer`

保留：

- 只在 DEV 写业务代码。
- 实现 checklist item、提交代码和记录 verificationEvidence。
- commit author 与主 Agent 交接要求。
- 禁止自行推进 lifecycle 或自签 reviewer evidence。
- 失败、测试和 scope expansion 的处理。

删除或抽取：

- reviewer 专属规则。
- 重复的 CLI 使用教程。
- 全量 Story 生命周期长说明。

目标：不超过 10 KB。

#### 7.4 `proof-or-stop-review-behavior`

保留：

- 用户行为、状态转换和 observable outcome 审查。
- happy/edge/adversarial 行为路径。
- finding/pass 输出。

删除或抽取：

- 通用 Runtime Guide。
- 与 delivery reviewer 重复的文档承诺检查。
- 与 quality reviewer 重复的代码风格检查。

目标：不超过 8 KB。

#### 7.5 `proof-or-stop-review-delivery`

保留：

- `userSees`、plan/docs promise 到代码、正式验证和真实 transcript 的映射。
- delivery context pack 的消费方式。
- delivery-check 的唯一合法写入路径。
- waiver、unverified promise 和 unresolved TODO 规则。
- 不得把工程 PASS 等同于用户价值验收。

删除或抽取：

- 通用生命周期和所有 reviewer 共用规则。
- 重复的 candidate routing 解释。
- 与 test coverage reviewer 重复的测试充分性细节。

目标：从 13.3 KB / 289 行降到不超过 10 KB / 180 行。

#### 7.6 `proof-or-stop-review-channel`

处理：

- 状态固定为 `retired`，`defaultDispatch=false`。
- 不进入 reviewer Prompt 迁移、增量装配、active role count 或 reviewer-wave
  预算。
- 来源、commit author、dispatch/process event 和角色证据检查继续由
  `proof-or-stop validate --channel` 及其 handler/gate 机械执行。
- 现有 prompt 资产只为历史审计或兼容读取保留，不得产生可计入新 Story
  receipt/quorum 的 reviewer pass。

#### 7.7 `proof-or-stop-review-docs`

保留：

- 文档承诺与当前代码/CLI 输出一致性。
- stale plan、truth source 优先级和过期文档识别。
- 必须更新与无需更新文档的判定。

删除或抽取：

- delivery reviewer 已负责的最终用户验收。
- 通用 Runtime Guide。
- 通用 finding/pass 格式。

目标：不超过 8 KB。

#### 7.8 `proof-or-stop-review-quality`

保留：

- 正确性、安全性、绕过面、复杂度、可维护性。
- “修 A 引入 B”、测试 seam、任意写入和信任边界检查。
- 当前 material 的 finding/pass。

删除或抽取：

- 通用角色权限。
- concept deletion 和 coverage totality 的详细规则。
- story lifecycle 长说明。

目标：不超过 8 KB。

#### 7.9 `proof-or-stop-review-concept`

保留：

- 概念删除、声明身份、残留引用、重命名和 parser fail-closed。
- concept gate 的 finding/pass 条件。

删除或抽取：

- 通用 Runtime Guide。
- quality 和 coverage 角色的检查项。
- 与具体历史 Story 绑定的长例子，改成短规范和测试引用。

目标：不超过 8 KB。

#### 7.10 `proof-or-stop-evaluator`

保留：

- 评分维度、admissibility、证据引用和输出结构。
- 不得把本地诊断提升为 release authority。

抽取：

- 与 `proof-or-stop-evaluator-cli` 共享的评分合同。
- 通用 Runtime Guide。

目标：不超过 7 KB。

#### 7.11 `test-case-reviewer`

处理：

- 状态改为 `compatibility`。
- `replacementAgentType` 指向现有 canonical `verification-intent`；当前
  dispatch registry 已将此名称作为 alias 归一到该类型。
- `defaultDispatch=false`。
- 保留 legacy 显式调用和明确迁移提示。
- 删除新流程中已由 verificationIntent/coverage reviewer 覆盖的说明。

目标：不超过 6 KB。

#### 7.12 `test-intent`

处理：

- 状态改为 `compatibility`。
- `replacementAgentType` 指向现有 canonical `verification-intent`。
- `defaultDispatch=false`。
- 保留 legacy 请求的参数兼容与迁移提示。

目标：不超过 6 KB。

#### 7.13 `proof-or-stop-review-test-coverage`

保留：

- verificationIntent 到 verificationEvidence 的覆盖。
- missing、stale、overclaim 和 evidence kind 判定。
- finding/pass 输出。

现有 Prompt 已较紧凑，只做公共规则抽取和版本化，不为缩短而重写核心规则。

目标：保持不超过 5 KB。

#### 7.14 `proof-or-stop-evaluator-cli`

保留：

- CLI 输入解析、输出格式和评分合同的适配。

抽取：

- 与 `proof-or-stop-evaluator` 重复的评分规则。

目标：不超过 4 KB。

#### 7.15 `product-reviewer`

保留：

- 产品结果、用户价值和真实体验验证。
- 明确不能替代 delivery-check signature。

处理：

- 保持 active INIT reviewer 和 `init_check_set` 独立 authority；不得降为普通
  advisory。
- 不与 delivery reviewer 重复签名职责。

目标：保持不超过 4 KB。

#### 7.16 `implementation-reviewer`

处理：

- 保持 legacy/compatibility，不进入 active reviewer roster。
- migration hint 指向 quality + behavior 现有组合，不创建新的 REVIEW authority。
- prompt 资产仅保留兼容说明，不再以“待决定 active”作为迁移前提。

目标：不超过 3 KB。

### 8. 统一 Role Prompt 模板

所有 active 角色应使用以下模板：

```markdown
# Role
一句话职责。

## Required inputs
- 必须读取的结构化输入。

## Required checks
- 该角色独有的检查项。

## Allowed writes
- 允许调用的 reviewerWrite 或 implementer 命令。

## Forbidden actions
- 该角色特有的禁止动作。

## Output contract
- 必须写入的结构化结果。

## Stop conditions
- 必须 fail closed 的条件。
- 无法继续时返回的下一步。
```

禁止在 Role Prompt 中重复完整 Runtime Contract；装配器负责按版本注入 Runtime Contract。

Role Contract 的结构化字段是唯一真相源。Markdown role section 和 contract
tests 应由这些字段渲染或生成断言，不能再手工维护一份语义重复的独立模板。

### 9. 增量复审设计

本节扩展现有 `proof-or-stop review_incremental_context`，不另建第二套增量事实源。
现有命令继续保持严格只读和 advisory；第一阶段复用它的 prior verdict、
bound headHash、rename-aware changed files、`scopeChanged` 和 `isFirstPass`
计算。只有可信装配、Prompt Envelope 签名绑定和 gate consumer 同时落地后，
其输出才可升级为 eligibility 输入。升级前后均不得改变现有 smoke 所证明的
“调用只读命令本身不改变 gate”语义。

#### 9.1 使用条件

只有同时满足以下条件才能使用 incremental context：

1. prior review pass 存在、签名有效且属于同一角色 lane。
2. prior pass 的 materialHash、storyFilesHash、scope digest 和 policy binding 可读取。
3. Runtime/Role semantic digest 未变化；实际发送文本变化时，除非机械证明
   变化未进入模型输入，否则同样升级 full。
4. known execution environment、assembler、dispatch protocol、launcher、
   command/tool policy 未出现要求 full 的变化。
5. review policy、required lanes 和 command policy 未变化。
6. rename-aware changed-files 集合可完整计算，并能根据版本化
   `ImpactClassificationPolicy`、files contract、
   candidate routing、显式依赖/影响索引或敏感变更规则确定 impacted files。
7. freshness-reader 将 drift 分类为允许增量的已知类别；Host 不自行根据原始
   hash 猜测 freshness。
8. 没有无法分类的 scope expansion、跨模块契约变化或 untrusted lineage。

上述条件由 CLI eligibility handler 逐条计算并输出稳定 reason code。任一条件
未知、失败或无法复算时，结果必须是 `full`，不能由 prompt 文本、主 Agent 参数
或 reviewer note 覆盖。实现不强制建设全仓静态依赖图，但必须对无法证明完整的
跨文件影响 fail closed。

#### 9.2 增量输入

增量复审只注入：

- compact Runtime Contract。
- 完整但短小的 Role Contract。
- prior pass ID、round、materialHash、storyFilesHash。
- 从 prior pass 到当前 HEAD 的 changed files 与机械判定的 impacted files。
- 新增、解决、dismissed 的 findings。
- scope acknowledgement。
- 受影响的 verificationIntent。
- 为什么需要此次复审。
- `reviewBasis`：
  - 当前仍有效的验收条件与必须重证的 claims。
  - prior pass 所依赖且仍有效的 invariant。
  - 未解决 findings。
  - 受影响接口/契约的当前版本。
  - 可按需读取的当前权威材料引用。

Incremental 只减少默认注入内容，不限制 reviewer 读取 eligibility 允许的当前
权威材料。Role Contract 不得把“未注入”解释为“禁止读取”；reviewer 发现
reviewBasis 不闭合时必须请求 full。

#### 9.3 ImpactClassificationPolicy

影响分类是版本化机械 policy，输出稳定 reason code：

| 变更类型 | 默认判定 |
|---|---|
| 纯测试 fixture | 有显式 fixture binding 时可 incremental，否则 full |
| 文档变更 | docs routing 与引用索引完整时可 incremental |
| 私有函数内部修改 | language-aware symbol/call index 能证明边界时可 incremental |
| 公共 API、schema、protocol | full |
| 权限、命令 policy、gate 语义 | full |
| package dependency、构建入口 | full |
| 动态引用、未知语言或解析失败 | full |

policy 必须被 registry 和 contract verifier 消费；handler 不能维护一份散落的
隐式启发式规则。第一版可以只支持少数可证明类别，其余诚实 full，不要求先建
全仓静态依赖图。

#### 9.4 自动升级 full review

以下任一情况必须升级：

- Runtime/Role semantic contract 或 agent-facing render 改变。
- known execution environment 发生 policy 指定的强制 full 变化。
- scope contract、policy、command set、review lane 配置改变。
- changed-files 计算失败。
- prior pass 无效或绑定不完整。
- 发现 untrusted lineage path。
- 增量 context 超出预算。
- reviewer 主动请求 full context，并提供升级理由。

升级到 full review 是正确性路径，不得因为 full prompt 超出普通预算而死锁。
超预算 full review 仍允许 reviewer 获得正确上下文，但记录 budget violation，
并阻止 baseline 接受和 enforce 收束；不得回退到 incremental 规避预算。

若 full 和 incremental 均安全可用，装配器在两者都生成后比较最终大小；
`incremental >= full` 时选择 full 并记录 `FULL_CHEAPER_OR_EQUAL`。这是成本
选择，不能覆盖安全 eligibility。

#### 9.5 Eligibility 决策表

| 变化 | prior pass 是否失效 | 是否强制 full | 原因 |
|---|---|---|---|
| Runtime semantic contract | 是 | 是 | 全局规则改变 |
| 未进入模型输入的 metadata | 否 | 否 | 不改变 reviewer 行为 |
| Agent-facing Runtime/Role render | 是 | 是 | LLM 行为可能改变，不能证明语义等价 |
| Role semantic contract | 是 | 是 | 审查职责或权限改变 |
| Tool/command authority | 是 | 是 | 执行能力变化 |
| Public API/schema/protocol | 是 | 是 | 影响闭包难证明 |
| Private implementation | 是（v1） | 是 | v1 尚不声称实现跨文件影响闭包 |
| Metadata-only HEAD drift | 依据 freshness-reader | 通常否 | 无 material change |
| Scope expansion | 是 | 是 | 验收边界改变 |
| Incremental 大于等于 full | 否 | 选择 full | 成本优化 |
| Requested/served model 变化 | 依据版本化 model policy | 至少重新计算 eligibility | 行为环境改变 |

#### 9.6 审计字段

每个 v1 Prompt Envelope 都记录 Runtime/Role/environment/assembler/dispatch/
launcher/command 与最终 prompt 的绑定。只有经 Story 4 条件装配器生成的
可信 review-run Envelope 才额外记录 eligibility 与 selection 审计面；
story-dispatch Envelope、迁移前 legacy run，以及未走该条件装配路径的 full
Envelope 不要求携带 Story 4 selection 字段。下例中的
`impactPolicyVersion`、`eligibilityReasonCodes`、size/selection 字段属于
Story 4 条件装配器的审计面；`reviewBasisDigest` 与
`incrementalContextDigest` 仅在存在可信 prior pass 且成功构造 bounded
reviewBasis 时出现。首次审查或缺少可信基线的 safety-full run 不伪造这两个
字段。`budgetViolation` 与 `escalationReason` 是可选的非 null 字段：只有
实际发生预算违规或升级时才出现，缺省时必须省略而不是写 `null`：

```json
{
  "contextMode": "incremental",
  "priorPassRef": "RP-xxx",
  "runtimeSemanticDigest": "...",
  "runtimeRenderDigest": "...",
  "roleSemanticDigest": "...",
  "roleRenderDigest": "...",
  "knownExecutionEnvironmentDigest": "...",
  "impactPolicyVersion": "...",
  "eligibilityDigest": "...",
  "eligibilityReasonCodes": ["..."],
  "freshnessClassification": "...",
  "changedFilesDigest": "...",
  "impactedFilesDigest": "...",
  "incrementalContextDigest": "...",
  "taskSemanticDigest": "...",
  "selectionReason": "SAFE_INCREMENTAL",
  "fullContextBytes": 120000,
  "incrementalContextBytes": 24000,
  "envelopeId": "...",
  "reviewBasisDigest": "...",
  "escalatedToFull": false
}
```

reviewer pass、review run 和 receipt/quorum collector 必须校验
`envelopeId`。缺字段的在途旧 pass 按第 12.6 节处理，不能静默视为
新格式 incremental pass。迁移前没有 Prompt Envelope 的历史 run 只保留
`legacy-full-context` 解释；它不能通过默认值升级为 incremental baseline。
Story 4 只落地上述 v1 eligibility、装配与审计语义，不表示 Stories 5–7 的
provider observation、enforce rollout 或预算收敛已经完成。

### 10. Legacy 角色迁移

Registry 增加：

```ts
type RoleStatus = 'active' | 'compatibility' | 'retired';

interface RegisteredRole {
  roleId: string;
  status: RoleStatus;
  replacementAgentType?: AgentDispatchCanonicalType;
  migrationHint?: string;
  defaultDispatch: boolean;
}
```

机械规则：

1. active 角色进入新 Story 默认角色集合。
2. compatibility 角色仅允许显式调用。
3. compatibility 必须有 canonical `replacementAgentType` 并输出 migration
   hint；不引入 command/processFact/workflow 的泛化 replacement union，除非
   将来出现真实调用方。
4. retired 角色调用必须明确拒绝。
5. compatibility 和 retired 角色不能被错误计入 active role count。
6. baseline 分开记录 active、compatibility、retired。
7. alias-normalizer、command catalog、dispatch classifier 和 process fact registry 必须共享同一角色状态真相源。
8. dispatch classifier 的候选角色列表从 registry 动态生成，不在 Prompt 中
   手工复制 active/compatibility 状态。
9. compatibility/retired 角色的 finding/pass 可保留作 advisory 或历史审计，
   但不得计入新 Story 的 required receipt、review assurance floor 或 quorum。
10. retired 角色对新 dispatch 明确拒绝；历史 artifact 的只读重放按其记录的
    contract 版本解析，不重新产生当前 gate evidence。

Story 1 冻结现有角色事实，不把已决事项留到迁移阶段：

- `product-reviewer` 保持 active INIT reviewer；它拥有独立
  `init_check_set` authority，并是 INIT_CHECK 必需主体。
- `implementation-reviewer` 保持 legacy/compatibility，不新增第三种 REVIEW
  authority；其职责继续由 quality + behavior 承接。
- `test-intent` 与 `test-case-reviewer` 均是 canonical
  `verification-intent` 的 compatibility alias。

### 11. Prompt 预算

以下是第一阶段建议阈值，必须在历史 Story A/B 后确认：

| 预算对象 | 初始阈值 |
|---|---:|
| Compact Runtime Contract | ≤ 4 KB |
| 普通 active Role Contract | ≤ 8 KB |
| 复杂 init/scope/implementer/delivery Role Contract | ≤ 12 KB；implementer 自身目标仍为 ≤ 10 KB |
| compatibility Role Contract | ≤ 6 KB |
| 单次 incremental context | ≤ 8 KB |
| 单次 full task context | ≤ 24 KB |
| 普通角色 assembled incremental prompt | ≤ 22 KB |
| 复杂角色 assembled incremental prompt | ≤ 27 KB |
| 普通角色 assembled full prompt | ≤ 40 KB |
| 复杂角色 assembled full prompt | ≤ 44 KB |
| 三 reviewer 并行 wave 的 assembled prompts 合计 | 先记录，A/B 后设硬阈值 |

预算检查必须覆盖：

- bytes。
- lines。
- estimated tokens。
- Runtime Contract 与 Role Contract 的重复率。
- 每个 assembled prompt 的最终大小。
- 一轮 reviewer wave 的合计大小。
- 与基线相比的绝对增长和百分比增长。
- provider-reported uncached input、cache read、cache creation 和 output。
- provider 支持时记录 cache hit ratio、wall-clock latency；费用只有在存在
  versioned pricingRef 或 billing export 时报告，不从 tokens 臆造。

度量必须可复算：

- bytes 使用最终发送的 UTF-8 字节；路径统一为仓库相对 POSIX 路径，参与
  digest 的结构化对象使用 canonical serialization。
- 行数统一按 LF 逻辑行计算；是否保留原始文件字节 hash 与规范化 context
  digest 必须分字段表达，不能混用。
- Story 1 选择并 pin 一个确定性 token estimator 及版本。版本写入
  PromptEnvelope；在 estimator 未确定前，tokens 只报告不 enforce。
- 重复率必须固定规范化与 shingle/匹配算法及版本。
- enforce 状态下度量器不可用必须 fail closed，不能临时换算法后继续。

建议门禁状态：

- 第一阶段：`observe`，只报告。
- 第二阶段：`warn`，超预算需要 reason。
- 第三阶段：`enforce`，超预算 violation 阻塞 baseline 接受和 enforce 收束，
  但不阻止正确性要求的 full review 执行。

第一版不设计尚不存在的人工预算批准 Authority。正确性要求的 full review
始终允许获得完整上下文；超预算时写入结构化 `budgetViolation`，阻止
baseline 接受和 enforce 收束，但不阻止 reviewer 执行。若未来确需豁免，
必须另建 Authority Story 定义批准主体、签名、scope、expiry 和 revocation，
不能由主 Agent、implementer 或受评 reviewer 自批。

### 12. 机械验证

#### 12.1 Registry 验证

- 角色 ID 唯一。
- status 合法。
- compatibility 必须有 canonical `replacementAgentType`。
- retired 不得 defaultDispatch。
- active role count 与默认 dispatch 一致。

#### 12.2 Contract 验证

- Runtime Contract 和 Role Contract 均有 schemaVersion、semanticDigest 和
  renderDigest。
- Prompt Envelope 绑定两者 digest、known execution environment、ReviewRun
  和 HEAD。
- assembledPromptDigest 可复算。
- semantic 或 agent-facing render 变化使旧 incremental pass 不可复用；只有
  未进入模型输入的 metadata 变化可例外。
- digest 由实际发送 Prompt 的进程就地计算，拒绝全局 CLI/worktree 模板版本
  偏斜或缓存来源不明的 envelope。

#### 12.3 权限验证

- main/implementer 不能写 reviewer pass。
- reviewer 不能运行 owner-gated lifecycle mutation。
- delivery-check 只能由合法 delivery reviewer 写。
- compatibility role 不能绕过 active role 的 gate。
- evidence collector 必须过滤 compatibility/retired pass，使其不能满足
  current-round receipt、assurance floor 或 quorum。

#### 12.4 增量复审验证

- fixture 场景：仅测试文件指纹变化且影响分类完整时，reviewer 获得有界 delta。
- source、scope、policy、command set 变化时按规则升级。
- metadata-only、materialHash-only 和 storyFilesHash drift 复用 freshness-reader
  的现行分类；metadata-only HEAD 漂移不会无条件升级 full review。
- untrusted path 必须 fail closed。
- prior pass stale 时不能使用 incremental。
- 9 KB 等略超 incremental 预算的 delta 不得盲目换成不相关的 24 KB full：
  先按影响分类选择 full；预算 violation 与正确性判断分离。
- incremental assembled size 大于等于 full 时选择 full，并记录
  `FULL_CHEAPER_OR_EQUAL`。

#### 12.5 Prompt 语义验证

每个角色至少设置以下对抗样例。断言从结构化 RoleContract 字段生成，避免手写
复制 Prompt 文本形成第二真相源：

- 删除关键 `forbiddenActionId` 应使 contract test 失败。
- 修改 `allowedCommandIds` 应使 process fact contract 失败。
- 把 compatibility 角色设为 default 应失败。
- 删除 `stopConditionCode` 应失败。

#### 12.6 在途兼容、并发与回滚

- feature flag 默认保持 legacy assembled prompt；每个角色迁移后可独立回退，
  回退不得放宽现有 gate。
- 部署前创建且缺 Prompt Envelope 的旧 pass 只能按 `legacy-full-context`
  解析，并限制在原 review round；不得复用为新格式 incremental pass。
- registry、baseline 或 contract digest 的共享写入必须复用 main write lock；
  reviewer lane evidence 继续使用现有签名写入 handler，不另建并行覆盖
  `story.json` 的旁路。
- 多 reviewer wave 先各自产生 lane-scoped signed evidence，再由现有 collector
  只读汇总；不得由多个 reviewer 直接改写同一聚合对象。
- 每次迁移必须验证 feature flag 回退、旧 pass 读取和新旧 baseline diff。
- Role Contract 和 assembled prompt 不一致应失败。

### 13. A/B 验证方案

在迁移角色前先建立只读 replay/measurement harness。它必须能够 checkout 或
重建历史 material、隔离 reviewer 写入、固定模型/contract 版本、记录实际
dispatch 输入与 usage，并把实验 finding 与生产 Story evidence 分离。若无法
重放历史 material，必须把验收降级为代理指标并明确标记
`INCONCLUSIVE`，不得声称 finding 召回不下降。

选择至少三类历史 Story，每类至少两个样本：

1. 简单、小范围实现。
2. 多轮 REVIEW 且有真实 high finding。
3. closeout metadata 较多、容易重复 re-attestation 的 Story。

每个样本在运行前冻结 adjudicated finding set：

- critical/high seeded findings 具有稳定 finding ID、category、severity、触发
  条件和独立 machine/human adjudication evidence。
- 新旧 Prompt 使用同一 model/tool/task/material envelope；模型、可控采样参数
  和 run order 预注册。provider 不支持 seed 时明确记录。
- 每个适用 cell 至少重复 3 次；单次漏检不得直接判定回归。
- 新 finding 通过 normalized semantic category + source/claim binding 匹配，
  不能只比较措辞。
- 所有 critical seeded findings 必须检出；high finding 出现疑似系统性漏检
  时重复运行并独立裁决。证据不足则结论为 `INCONCLUSIVE`。
- 自然产生的新 finding 和 false positive 不作为自证事实，必须由预注册 oracle
  或独立 adjudicator 判定。

每类 Story 对比旧版与新版：

| 指标 | 目标 |
|---|---|
| 单角色 assembled prompt tokens | 按角色报告；初始目标至少下降 40% |
| provider-processed reviewer wave 输入 | 支持 usage 的 provider 明显下降；不可用时标记 unavailable |
| uncached/cache-read/cache-creation | 分列报告，不用 gross tokens 掩盖缓存效果 |
| wall-clock latency | 分 host 报告 |
| 增量 context 层输入 tokens | 相比 full context 层下降至少 50% |
| seeded high/critical finding 召回 | critical 全检出；high 无已确认系统性漏检 |
| false-positive finding | 不显著上升 |
| reviewer command misuse | 不上升 |
| metadata-only re-review 次数 | 下降 |
| full-review escalation 正确率 | 所有真实 policy/scope/material drift 均升级 |
| legacy 显式调用兼容 | 通过 |

不得仅凭 bytes 下降宣布成功。最终验收必须包括实际 dispatch usage、模型输入
tokens、review findings 和流程收敛数据。模型、token estimator、contract
版本和样本集合必须 pin；contract 频繁变化期间的数据不进入正式降幅结论。
费用只有在存在 versioned pricingRef 或 billing export 时报告。

### 14. Story 拆分与执行顺序

#### Story 1：建立 Contract 与测量基线

目标：

- 新增 Runtime Contract、Role Contract、Prompt Envelope 数据结构。
- Story 1 只写 measurement sidecar，不实例化要求 ReviewRun/HEAD 的
  Prompt Envelope，保持现有 assembled prompt 内容不变。
- 增加 bytes、lines、estimated tokens、重复率和三层输入成本报告。
- 建立并冻结 active/compatibility/retired 状态，但不改变现有合法行为。
- 将 `proof-or-stop-review-channel` 登记为 retired，并核对 baseline 的历史兼容
  分类；不重新启用或迁移其 prompt。
- 冻结 `product-reviewer` 的 active INIT authority、
  `implementation-reviewer` 的 compatibility 状态，以及
  `test-intent`/`test-case-reviewer` 到 canonical `verification-intent` 的
  alias/replacement。
- pin canonical serialization、路径/行数口径、token estimator 和重复率算法。

验收：

- 所有 16 个现有输出 hash 不变。
- 新旧装配结果字节一致。
- 新报告能够展示每层和最终 Prompt 的大小，并诚实区分 assembled、known
  dispatch 和 provider-reported usage。
- registry 明确区分 active、compatibility、retired，且 channel 不计入 active。

#### Story 2：可信 full-context 装配与 Envelope

目标：

- 扩展 `agent_prompt` 的 Story-aware CLI 内装配入口，只实现 full context。
- 定义 Task Context、known execution environment 和 content-addressed
  Prompt Envelope。
- 将 Envelope 绑定到现有 signed ReviewRun、HEAD 和 reviewer pass，增加 gate
  consumer。
- evidence collector 排除 compatibility/retired receipt/quorum。
- 建立 per-role feature flag、旧 pass `legacy-full-context` 兼容和回滚验证。

验收：

- 主 Agent 无法拼接或伪造 full envelope。
- retry 创建新 ReviewRun；provider retry 继续使用 usage ledger 现有 attempt ID。
- 旧 Envelope 在新 HEAD、round 或 ReviewRun 上重放时 gate 拒绝。
- compatibility pass 单独存在时 REVIEW gate、assurance floor 和 quorum 均不能
  通过。

#### Story 3：建立 A/B replay 与 usage 测量

目标：

- 建立历史 material 的只读 replay harness。
- 记录 assembled prompt、known dispatch 输入、provider usage/cache、
  contract/model 版本和实验 finding。
- 实验写入与生产 Story evidence 完全隔离。
- 固定 seeded/adjudicated finding set、重复次数、三类样本及
  `INCONCLUSIVE` 判定规则。

验收：

- harness 不写 review pass、finding、review run 或 lifecycle evidence。
- 同一 pinned 输入可复算 bytes、tokens、digest 和 finding 对比。
- 历史 material 不可重建时明确返回 `INCONCLUSIVE`，不伪造召回结论。

当前实现状态（Story `B-8d4b`）：

- 已在 `experiments/role-prompt-ab-replay/` 交付隔离的只读 replay、
  experiment-only ledger、离线分析和 selfcheck。协议冻结三类样本、每类两个，
  每个适用 cell 至少三次。当前 critical/high 仅作为
  `oracle-only-unverified` future seeds；没有 reviewer output + digest +
  独立语义裁决证据时，finding recall 不可评估。
- `lattice-experiment-protocol.md` 的五 arm lifecycle ablation 与本实验无关，
  只提供 pre-registration 方法参考，不是 Story 3 的 governing acceptance
  contract。
- 可执行验证命令：

  ```bash
  node experiments/role-prompt-ab-replay/selfcheck.mjs
  node experiments/role-prompt-ab-replay/run.mjs
  node experiments/role-prompt-ab-replay/run.mjs --reverse
  node experiments/role-prompt-ab-replay/run.mjs \
    --ledger=runtime/operator-run.jsonl --run-id=operator-run-001
  node experiments/role-prompt-ab-replay/analyze.mjs \
    --ledger=runtime/operator-run.jsonl
  ```

- selfcheck 覆盖固定协议与语料、重复/反序、material/model/tool/contract
  drift、post-hoc tamper、缺失裁决、无效 denominator、retry/crash、ledger
  chain、并发 append、重算 hash 后的私密字段注入、伪 authority、
  fd-based `O_NOFOLLOW` 路径/符号链接逃逸。生产证据 no-write 验证在临时隔离
  evidence root 中预置真实形状的 pass、finding、ReviewRun、verification、
  validation、lifecycle 和 process-event sentinel，复制并运行 replay/ledger/
  analyze 入口，再递归比较整个 sandbox `.proof-or-stop` 树的前后状态：覆盖所有
  sibling Story、usage/activity/lifecycle/process-event 位置、目录成员、文件
  字节和 symlink target，并确认没有新增 artifact/event。mutation-bite 另行
  写入 sibling Story review pass 和独立 usage artifact，要求同一 detector
  必须报告 drift；因此该断言不依赖并发变化的真实 Story metadata。另有结构测试
  拒绝 production 路径、伪 gate authority/Story reference，以及 experiment row
  被正常 process-fact/usage-ledger consumer 接受。
- Claim boundary：本 Story 只证明 pinned 历史观察可被确定性重算并与生产证据
  隔离。它不运行历史代码、不调用 provider，也不宣称生产 Prompt 降幅、provider
  成本下降、模型质量等价、incremental eligibility、角色迁移或 budget
  enforce-ready。当前 snapshot authority 是 `corpus.json` 内联提交并由
  `materialDigest`/corpus digest 绑定的 `material.content`；
  `sourceHintPath` 只提供人类 provenance context，不是历史文件内容证明。
  当前没有 exact content-addressed legacy/modular prompt snapshots、reviewer
  output artifacts 或 independent semantic-match adjudication bytes，因此
  canonical corpus 的 prompt cost 与 finding recall 均为 `INCONCLUSIVE`。
  selfcheck 的 hermetic inline fixtures 只证明证据齐全时测量/匹配引擎可工作，
  不属于历史或生产证据。
  当前语料未绑定可机械验证的 dispatch/provider receipt 与 evidence digest，
  因此 known dispatch、provider/output/cache 全部保持
  `unavailable(<reason>)`，包括 0 也不得伪装成已观测值；任何不可重建、篡改、
  版本偏移、arm 不对称、样本/重复不足或无效召回 denominator 均为
  `INCONCLUSIVE`，不输出 savings/recall claim。Story 的正式完成状态仍以
  Proof-or-Stop lifecycle 的 DONE 证据为准。

#### Story 4：Incremental eligibility 与 impact policy

实现记录（B-03ac）：

- v1 的机械边界只允许两类 incremental：未改变模型相关输入的
  no-material/metadata-only drift，以及所有路径均由当前 Story `files.test`
  声明且具有当前 `verificationIntent` 绑定的纯测试 fixture delta。
- docs、私有实现、public API/schema/protocol、authority/permission、
  command/gate policy、dependency/build、dynamic/parse failure、rename/delete、
  未知影响或不完整 fixture closure 全部 fail closed 到 full。扩大支持面必须升级
  `proofbound.impact-classification.v1` 并同步 process-fact verifier。
- prior baseline 必须是同 lane、签名有效的 PASS，且绑定有效 ReviewRun 和精确
  Prompt Envelope；legacy/full-context-only、wrong-lane、缺字段或损坏证据不能
  成为 incremental baseline。
- Prompt Envelope 额外绑定 model-relevant TaskContext digest、canonical
  freshness classification、changed/impacted file digests、reviewBasis digest 和
  stable reason codes。HEAD/material/storyFiles 仍由 ReviewRun/Envelope 独立签名，
  不由 Host 从 raw hash 自行解释。TaskContext 仍在 Prompt 中记录实际 phase，
  但 model-relevant digest 仅将 `TEST` 规范为 producer phase `REVIEW`：
  mandatory REVIEW→TEST/closeout metadata 不得让已通过的 REVIEW envelope 自失效；
  `DEV`、`DONE`、`DISCARDED` 与 malformed/unknown phase 必须保持不同并 fail closed，
  title、description、priority、checklist、verification intent 和 scope 等真实语义
  变化也必须 fail closed。`verifyReviewRunPromptEnvelope` 是 REVIEW、quorum、
  `done_prepare` 与 `story_advance DONE` 共享的同一判定边界。
- 安全 eligibility 先于成本。安全允许 incremental 后，只有最终 incremental
  bytes 小于 full 且未超 incremental budget 时才选择 `SAFE_INCREMENTAL`；
  否则分别记录 `FULL_CHEAPER_OR_EQUAL` 或 `INCREMENTAL_BUDGET_EXCEEDED`。
  correctness-required full 即使超预算仍保持 full，并单独记录
  `budgetViolation=full`。
- `review_incremental_context` 仍严格只读、advisory 和 gate-neutral；真正的
  authority 位于 `review_run_start` 的可信装配及
  `assertCurrentReviewRunForEvidence` / `verifyReviewRunPromptEnvelope` /
  `collectReviewerEvidenceState` 的共享 admission 链。

实现证据命令：

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/review-incremental-context-smoke.js
node packages/main/dist/tasks/prompt-full-context-envelope-smoke.js
node packages/main/dist/tasks/review-run-smoke.js
node packages/main/dist/tasks/quorum-submit-smoke.js
node scripts/verify-process-fact-contract.mjs
```

目标：

- 扩展现有 `review_incremental_context`，保持调用本身只读且不改变 gate。
- 实现版本化 `ImpactClassificationPolicy`、reviewBasis、freshness binding 和
  stable reason codes。
- 实现 full escalation、`FULL_CHEAPER_OR_EQUAL` 和 budget violation 交互。
- 将 incremental Envelope 绑定到 Story 2 的 ReviewRun/pass gate 链路。

验收：

- 主 Agent 无法强制 incremental。
- eligibility 未知或失败时机械升级 full，错误 incremental pass 无效。
- public API/schema/policy/权限变更默认 full；受支持的 bounded 类别有对抗测试。
- reviewer 在 incremental 下仍能按需读取当前权威材料。
- 现有 `review_incremental_context` smoke 继续证明只读调用不改变 gate。

#### Story 5：迁移 active reviewer 角色与增量装配

实现记录（B-235e）：

- concept、quality、test-coverage、behavior、docs 五个 active reviewer 现已各有
  独立 `full-envelope` feature flag；未配置时仍选择冻结且内容寻址的
  `legacy-full-context` 正文。五个 flag 的 32 种组合均有机械覆盖，
  `proof-or-stop-review-channel` 因 retired 明确不在 rollout 集合中。
- package registry 物理保存模块化正文，不再携带旧共享 Runtime Guide；
  Claude/Codex full-asset 文件只保存 canonical role-specific thin bootstrap，
  bootstrap 本身不含任何 reviewer role body，并要求 reviewer 先调用
  `review_run_start` 执行其返回的唯一 selected prompt。legacy rollback 由模块化
  正文中的冻结 anchor 加 canonical guide 确定性重建，并以预批准 SHA-256 拒绝
  漂移。这里的“精确”只指 selected legacy role body，不虚称总模型输入
  byte-exact：所有支持的 host mode 总输入都明确为已绑定 bootstrap 加一个
  selected body；global Claude sync、Codex registry mode 和 project full-asset
  复用同一 canonical bootstrap renderer。package registry 的实际
  `renderPromptEntryForHost` resolver 对五个迁移角色直接返回 bootstrap-only
  bytes，而不是只在 identity 中合成 digest；`review_run_start` 随后只补一个
  selected body。host identity 分别绑定 bootstrap
  digest、selected role-body digest 和 host render digest，
  从而拒绝 modular+legacy 双正文或 bootstrap/正文替换。
- incremental eligibility 仍完全由 Story 4 的 impact policy 决定。本 Story
  没有新增“精简即 incremental”的捷径；未知、contract/policy/scope drift
  继续 fail closed 到 full。
- 在途旧 pass 仍按其原 ReviewRun、round、Prompt Envelope 和 host identity
  验证；切换 feature flag 不会把旧正文重新解释成新正文，也不会让非当前
  round、compatibility 或 retired evidence 获得 gate authority。无
  `envelopeId` 的 legacy run 不再无条件通过：必须重验冻结 legacy body、
  canonical Role Contract 和 Claude/Codex host render；已存在 dispatch
  binding 时任何 body/host/round 漂移均拒绝，仅保留旧同轮 binding-race
  记录缺少 dispatch binding 的 bounded compatibility。
- REVIEW metadata retention 明确包含 `prompt-envelopes.json`。scope diff reader
  使用显式大输出上限，超过 1 MiB 的业务 diff 在提交 reviewer metadata 前后
  保持相同 material diff binding，不会因静默丢失 hunks 而让新 run 自失效。
  真实 CLI 并发回归在两组互补 mixed legacy/full masks 下同时启动五个 reviewer
  run，再并发写三条 pass 和两条 finding，断言每个 full lane 有 envelope、
  legacy lane 没有伪 envelope、全部 evidence 唯一保留、collector 无
  invalid/重复计数且 REVIEW gate 通过；独立三 lane mixed mask 继续穿过 quorum
  admission。
- 三份审批基线已绑定五个角色的 legacy/modular 正文 hash、role
  semantic/render digest，以及 Claude/Codex 两种模式的 host render digest。
  baseline verifier、process-fact registry/verifier 和 smoke tests 同步保护该
  边界。
- Story 3 的冻结 corpus/protocol 未修改。B-235e 使用独立、版本化且
  content-addressed 的三臂 replay campaign（legacy/full/incremental）重算；
  由于缺少逐角色 exact historical envelopes、reviewer outputs、独立
  adjudication bytes 和 provider receipts，五个角色全部诚实输出
  `INCONCLUSIVE`。因此本 Story 不宣称已达到 50%/40% 降幅，也不把
  unavailable provider usage 当成 0；Claude/Codex 的 input、output、
  cacheRead、cacheCreation、uncached、latency、providerProcessed 每一维均保留
  `unavailable(reason)`。
- raw `proof-or-stop.config.json` 的重复顶层 `promptEnvelope`、重复 `roles` 容器和
  重复逐角色 flag key 都会在 `JSON.parse` 前拒绝；错误 rollout
  version/mode、prototype key、unknown/retired role 继续 fail closed。真实
  handler 权限回归同时拒绝 main/implementer/wrong-lane pass、
  reviewer owner/implementer mutation 和非 delivery reviewer 的 delivery
  evidence。

实现证据命令：

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/prompt-registry-smoke.js
node packages/main/dist/tasks/runtime-owned-agent-assets-smoke.js
node packages/main/dist/tasks/review-run-smoke.js
node packages/main/dist/tasks/prompt-full-context-envelope-smoke.js
node packages/main/dist/tasks/review-incremental-context-smoke.js
node packages/main/dist/tasks/quorum-submit-smoke.js
node experiments/role-prompt-ab-replay/selfcheck.mjs
node scripts/verify-proof-or-stop-prompt-baseline.mjs
node scripts/verify-process-fact-contract.mjs
node bin/proof-or-stop.js verify_codex
```

目标：

- 迁移 concept、quality、test-coverage、behavior、docs；不包含已退役 channel。
- 使用 Story 2 的可信 full 装配和 Story 4 的 eligibility 实现 incremental。
- contract/policy/scope drift 自动升级 full review。

验收：

- 历史 reviewer A/B 满足预注册 seeded critical/high 门槛，否则
  `INCONCLUSIVE`。
- incremental context 层至少降低 50% 输入；assembled prompt 按角色报告，
  初始目标至少降低 40%。
- 所有权限和签名门禁保持。
- 每个角色完成 role-by-role baseline diff、approval 和 feature-flag 回滚测试。

#### Story 6：迁移复杂角色

目标：

- 迁移 story-init、scope-plan、implementer、delivery、evaluator。
- 对 init/scope/implementer/delivery 使用复杂角色预算。
- 完成真实 dispatch A/B。

验收：

- delivery promises、scope gaps、implementer author 和 evaluator evidence 不回归。
- 复杂角色满足暂定预算；超限则记录 budget violation，不阻止正确性执行，
  但不能接受 baseline。
- Story-aware Task Context schema 对 init/scope/implementer 的结构化输入已在
  Story 2 稳定，不由本 Story 临时反向定义。

#### Story 7：Legacy 资产隔离与预算 observe/warn

目标：

- 按 Story 1 已冻结的 registry 迁移 legacy prompt 资产，不重新决定角色状态。
- baseline 分离 active、compatibility 和 retired。
- Prompt budget 从 observe 升为 warn，积累 provider usage/cache、延迟、
  finding 和 violation 数据。

验收：

- 新 Story 默认不调度 compatibility 角色。
- 显式 legacy 调用仍工作并给出 replacement hint。
- budget violation 被记录但不阻止正确性要求的 full review。
- A/B `INCONCLUSIVE` 时保持 warn，不声称 enforce-ready。

#### 条件性后续：预算 enforce

不预先承诺 Story 编号。只有 Story 7 的观察窗口和预注册 A/B 同时充分时才创建：

- 所有 critical seeded findings 检出，high finding 无已确认系统性回归。
- provider usage 可用性和缓存口径足以支持阈值。
- active role matrix、contract 和 impact policy 已冻结。
- enforce 只阻止 baseline 接受和收束，不阻止 reviewer 获得正确 full context。
- 若未来需要人工豁免，先单独完成 Authority 设计；本计划不伪造批准主体。

### 15. 建议触点

实施前应通过代码搜索确认准确文件，预期触点包括：

- Prompt registry 与角色定义。
- `agent_prompt` 装配入口。
- story dispatch 与 reviewer dispatch。
- 现有 `review_incremental_context` handler、smoke 和 reviewer batch consumer。
- `ImpactClassificationPolicy` 与 language/docs/fixture impact adapters。
- freshness-reader/drift classifier。
- review run/pass 签名域、receipt/quorum evidence collector 和 REVIEW gate。
- canonical host launcher、usage ledger provider adapters 和 cache-aware summary。
- command catalog 和 alias normalizer。
- process fact registry。
- Proof-or-Stop Prompt baseline verifier。
- Prompt baseline JSON。
- reviewer scan budget guard。
- replay/adjudication harness 与预注册 finding corpus。
- role matrix 与相应 contract smoke。
- main write lock 和共享 baseline/registry 写入路径。

不得凭此列表直接扩大 scope；每个 Story 应在 PLAN 阶段用真实调用图确定 files contract。

### 16. 风险与缓解

#### 风险 1：只抽文件，不减少最终输入

缓解：

- 同时报告 assembled、known dispatch 和 provider-reported 输入，不把模板文件
  大小当成商业效果。
- usage ledger 分列 uncached、cache-read、cache-creation；provider unavailable
  时诚实标记。

#### 风险 2：Prompt 缩短导致关键纪律丢失

缓解：

- 关键流程事实必须有 CLI/gate 双层保护。
- 对每个被删除的 Prompt 规则记录其机械 gate consumer。

#### 风险 3：增量复审漏掉跨文件影响

缓解：

- 使用 material、storyFiles、scope、policy、role contract binding，以及可复算
  的 changed/impacted files 分类。
- 无法证明 delta 完整时自动 full review。

#### 风险 4：Legacy 隔离破坏旧 Story

缓解：

- 先 compatibility，后 retired。
- 旧 Story 显式调用回归测试。
- 旧 pass 只按 `legacy-full-context` 在原 round 读取，不升级成新 incremental
  evidence。

#### 风险 5：预算门禁诱导压缩成难读文本

缓解：

- 同时检查可读结构与 required sections。
- full review 超预算时允许正确性执行，但记录 violation 并阻止 baseline 接受。

#### 风险 6：Baseline hash 更新掩盖语义退化

缓解：

- baseline 更新必须包含 role-by-role diff、A/B finding 对比和 reviewer approval。
- 不允许只运行 `--write` 后接受新 hash。

#### 风险 7：Full escalation 与预算 enforce 形成死锁

缓解：

- 正确性先决定 full/incremental，预算不能反向迫使系统选择 incremental。
- 必需的超大 full review 继续执行并记录 budget violation；第一版不伪造尚未
  存在的批准 Authority。

#### 风险 8：版本偏斜、缓存和并发写造成 digest 或 evidence 漂移

缓解：

- 实际发送 Prompt 的同一进程就地计算 digest 和 estimator version。
- 共享 registry/baseline 写入复用 main write lock；lane evidence 使用现有
  签名 handler 和 collector。
- 路径、canonical serialization、换行和 estimator 口径版本化。

#### 风险 9：迁移破坏在途 Story

缓解：

- 逐角色 feature flag、`legacy-full-context` 读取规则和回滚 smoke。
- 不在同一 Story 中同时改变装配格式、签名域和全部角色默认调度。

### 17. 完成定义

本计划完成必须同时满足：

1. 所有 active 角色使用版本化 Runtime/Role Contract。
2. assembled prompt 绑定 contract digest 和 context digest。
3. incremental review 有机械 eligibility 和 full-review escalation。
4. `proof-or-stop-review-channel` 保持 retired；legacy compatibility 角色从默认
   active 集合中隔离，但显式兼容可用。
5. Prompt budget 进入 warn，并明确输出 enforce-readiness；enforce 是证据充分
   后另建的条件性后续，不是本计划强行承诺的终点。
6. 所有 critical seeded findings 检出，high seeded findings 无已确认的系统性
   漏检；证据不足时明确 `INCONCLUSIVE`。
7. reviewer/owner/implementer 权限门禁全部通过。
8. assembled、provider usage/cache 和多轮复审耗时按可用性诚实报告；核心成本
   指标达到预注册阈值或明确 `INCONCLUSIVE`。
9. 文档、registry、baseline、process fact contract 和 smoke tests 同步。
10. 用户能观察到 reviewer 多轮复审更快，且不会因 Prompt 精简而降低审查质量。
11. compatibility/retired evidence 不能满足 active receipt、assurance floor 或
    quorum。
12. 在途旧 pass、per-role rollback、budget violation 和并发写路径均有机械验证。

### 18. 执行检查清单

- [ ] 记录当前 16 角色 assembled prompt 基线。
- [ ] 计算公共段重复率。
- [ ] 建立 Runtime Contract schema。
- [ ] 建立 Role Contract schema。
- [ ] 建立 Prompt Envelope schema。
- [ ] 冻结 product-reviewer、implementation-reviewer 和 legacy alias 的现有状态。
- [ ] 保持第一阶段输出字节完全一致。
- [ ] 新增角色状态 registry。
- [ ] 将 channel 标记为 retired，并从 active 迁移与 wave 预算中排除。
- [ ] 新增预算报告。
- [ ] pin canonical serialization、token estimator 和重复率算法。
- [ ] 实现可信 full-context CLI 装配与 Prompt Envelope gate 绑定。
- [ ] 实现 compatibility/retired evidence collector 过滤。
- [ ] 建立 seeded/adjudicated 历史 replay 与真实 usage/cache measurement harness。
- [ ] 定义并验证 ImpactClassificationPolicy 和 reviewBasis。
- [ ] 扩展现有 `review_incremental_context`，保持其只读语义。
- [ ] 实现机械 incremental eligibility。
- [ ] 实现自动 full-review escalation。
- [ ] 验证 `FULL_CHEAPER_OR_EQUAL` 和 budget violation。
- [x] 迁移五个 active reviewer 角色（B-235e；逐角色 flag、32 组合、mode-aware gate/host binding）。
- [x] 实现旧 pass `legacy-full-context` 兼容和 per-role rollback（B-235e；精确冻结正文与 digest）。
- [ ] 迁移 init/scope/implementer/delivery/evaluator。
- [ ] 隔离 legacy 角色。
- [ ] 完成三类、每类至少两个历史 Story A/B。
- [ ] 验证 finding 召回和权限边界。
- [ ] 将预算从 observe 升到 warn。
- [ ] 输出 enforce-readiness；证据充分时另建条件性 enforce Story。
- [ ] 验证 budget violation 和 main-write-lock 并发路径。
- [x] 更新 Story 5 baseline 和相关决策文档（B-235e；不提前声称 Story 6/7 完成）。

## Operational Rules

- Treat this file as planning authority, not implementation evidence.
- Execute Story 1 through Story 7 in order; create the budget-enforce follow-up only when its evidence conditions are met.
- Each implementation milestone requires its own Proof-or-Stop Story, scope, independent review, validation, and DONE convergence.
- Current runtime facts and accepted DONE evidence override stale planning prose if implementation later diverges.

## Verification Requirements

- The generated canonical document contains the complete reviewed execution plan with structurally valid heading levels.
- docs/requirements/NAV.md links to the canonical document.
- The promotion diff contains no runtime or Prompt-template changes.
- The canonical document states seven fixed Stories and one conditional follow-up.

## Risks

- Heading transformation could accidentally alter fenced examples unless the migration is fence-aware.
- Future readers could mistake the accepted plan for completed implementation.
- Later implementation could drift from the plan without updating the decision record.

## Supersession

If this decision changes, update this file through a Proof-or-Stop story. Because
this file is under `docs/requirements/decisions/*.md`, DONE requires the local
decision-doc 3x2 host verdict quorum.
