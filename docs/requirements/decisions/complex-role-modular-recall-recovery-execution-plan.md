# Complex Role Modular Prompt 召回恢复执行方案

Status: proposed
Source story: B-407c
Created: 2026-07-21

## Decision

在保持 Story 6 已交付的 modular Prompt Envelope、audit-only dispatch、预算观测和可验证 receipt 链路不变的前提下，启动一个独立的质量恢复序列：先冻结失败归因和新的盲测协议，再采用 conditional modularization 修复复杂角色的召回与误报，最后通过真实双 host 预注册 A/B 决定是否获得后续 rollout eligibility。

本方案明确分离两类结论：工程门禁回答“这个冻结 candidate 是否满足 Proofbound 的安全准入规则”，统计推断回答“现有独立任务样本是否支持 modular 对 legacy 的总体非劣效主张”。receipt 数量证明执行和审计覆盖，不能自动充当独立统计样本量；工程门禁 PASS 也不能自动包装成论文中的总体非劣效结论。

本方案不重新打开或否定 B-407c 的 DONE。B-407c 的正确结论是“评估机制已完成，但 modular baseline 因质量回退未被接受”。本方案也不自动授权 Story 7、预算 enforce 或 production default 切换。

## Context

B-407c 为以下五个复杂角色建立了生产入口绑定的 modular audit 路径：

- `lattice-review-story-init`
- `lattice-review-scope-plan`
- `lattice-implementer`
- `lattice-review-delivery`
- `lattice-evaluator`

Story 6 v3 campaign 使用：

```text
6 个任务样本 × 2 个 host × 2 个 arm × 3 次重复 = 72 cells
```

两个 host 为 Codex CLI 与 Claude CLI；两个 arm 为 `legacy` 与 `modular`。所有结果通过 production `agent_prompt` audit producer、Prompt Envelope、event、campaign binding、content-addressed receipt 和独立 adjudication 绑定。

真实结果：

| 指标 | Legacy | Modular | 结论 |
|---|---:|---:|---|
| Applicable findings | 24 | 24 | 同一 adjudication basis |
| Detected | 24 | 20 | Modular 漏检 4 |
| Recall | 24/24 | 20/24 | 预注册工程门槛失败；未形成总体统计非劣结论 |
| False positives | 0 | 1 | Modular 误报增加 |
| Explicit command misuse | 0 | 0 | 仅保守下界，不代表完整工具轨迹 |

Provider limitation：36 个 Codex cells 没有 `cacheCreationInputTokens`。该字段不得填零，也不得据此声称缓存收益。

因此当前结构化结论保持：

- `status=INCONCLUSIVE`
- `baselineAccepted=false`
- `recallNonRegressionClaim=false`
- `enforceReady=false`
- production default 继续使用 `legacy-full-context`
- modular full-envelope 继续为 `auditOnly=true`
- modular audit receipt 继续满足 `canMintReviewEvidence=false`

## Problem Statement

需要回答的问题不是“如何让现有 72 cells 变绿”，而是：

> 如何在不恢复整份 legacy full context、不削弱权限与证据门禁、不针对已知样本硬编码的条件下，使 modular complex-role prompts 在双 host 上达到质量非劣，并保留可测的上下文成本优势？

质量恢复至少包含三个独立目标：

1. 找回 4 个漏检所依赖的语义、证据或跨段关联。
2. 消除 1 个 modular 误报，并保持 legacy 的零误报水平。
3. 在未参与调参的新盲测集上证明修复可泛化，而不是记住旧 campaign。

## Non-Goals

- 不把已知 sample id、finding 文本、digest 或 adjudication label 写入 Prompt 作为特判。
- 不通过恢复完整 legacy Prompt 来伪装 modular 优化成功。
- 不删除 delivery、scope、author、evaluator、authority、signature、Task Context 或 REVIEW-credit 约束。
- 不把缺失 provider 指标视为零。
- 不在实验完成前切换 production default、启用 Story 7 promotion 或预算 enforce。
- 不把 Prompt bytes 下降单独当成成功；质量门槛优先于成本门槛。
- 不重复运行 provider campaign 来挑选“最好的一轮”。实验轮数和停止条件必须预注册。

## Design Principles

### 1. 原 72 cells 降级为 development regression set

一旦使用 v3 的 4 个漏检和 1 个误报指导 Prompt 修改，原 campaign 就不再是独立验证集。它可以用于：

- 根因定位；
- 回归测试；
- mutation biting；
- 确认已知失败不再出现。

它是候选冻结前必须通过的必要条件，但不是充分条件；在新候选的泛化分析中统计权重为零，不能单独支持新的 rollout 或论文非劣效结论。

### 2. 新 blind holdout 决定 rollout eligibility

在修改 Prompt 前，由独立构造者冻结新的 holdout corpus、adjudication、sample-class balance 和 digest。独立构造者不得参与 candidate 实现，也不得读取 sample-specific 修复、已知失败的答案文本或最终 candidate diff；其输入只包含预先批准的抽象任务类别和风险类别。Prompt implementer 不读取 holdout tasks、labels 或 oracle；provider run 完成并封存 receipts 后，再由独立 adjudicator 解封评分。

必须持久化 corpus/oracle 冻结时间、digest、构造者与实现者身份、允许的信息边界和解封事件。仅声称“标签隐藏”不足以证明 blind；缺少这些分权证据时，holdout 结论为 `INCONCLUSIVE`。

### 3. Conditional modularization，而不是继续无差别压缩

目标装配形态：

```text
Complex Role Prompt
├── Compact Runtime Contract
├── Stable Role Core
├── Story-aware Task Context
└── Conditional Extensions (zero or more)
    ├── critical/high finding analysis
    ├── closeout and delivery promises
    ├── scope and cross-document consistency
    ├── implementer authorship and mutation boundary
    └── evaluator evidence completeness
```

Conditional extension 必须由可信 producer 根据结构化 task facts 选择；主 Agent 和被评估模型不得自由拼接。选择结果、extension ids、版本、digest 和最终 Envelope 必须持久化并可由 consumer 重算。

### 4. Fail closed

extension selection、Task Context、role binding、host binding、campaign binding 或 receipt provenance 无法验证时，该 cell 不进入结果汇总。任何缺失 cell、重复 cell、stale receipt、wrong-role、wrong-arm、wrong-producer 或 digest mismatch 都使 campaign 结论失败，而不是自动补值。

## Evidence and Claim Layers

本方案要求分别保存并报告三类证据，不能相互替代：

1. **执行完整性证据**：真实 provider receipt、producer/host/arm/campaign binding、content digest、receipt set/Merkle root、缺失和篡改拒绝。它证明实验按冻结协议执行。
2. **工程质量证据**：预注册 oracle、开发回归、blind holdout 的逐任务/逐 finding 结果、双 host 安全门槛和绝对错误上限。它决定 Proofbound 是否允许生成 rollout eligibility。
3. **统计推断证据**：独立任务数、预注册 estimand、非劣效 margin、功效、paired effect、置信区间和多重性策略。它决定论文是否可以作总体非劣效主张。

若只有第一类证据，可以主张“实验可审计且 fail closed”；若前两类通过，可以主张“冻结 candidate 通过预注册工程门禁”；只有第三类也通过，才可以主张“在预注册总体和 margin 下获得统计非劣效证据”。

### Required evidence artifacts

每个阶段至少生成以下内容寻址 artifact；具体文件名可以由实现 Story 冻结，但语义和互相引用不可省略：

| Artifact | 必须证明的事实 |
|---|---|
| failure-attribution records | 5 个已知失败的根因、正反 mutation、falsifier 和证据引用 |
| protocol lock | campaign id、candidate/corpus/oracle/protocol digest、hosts、arms、repetitions、task 数、全部分母和停止规则 |
| blindness attestation | 构造者、实现者、adjudicator 身份分离，允许信息边界，冻结及解封时间 |
| receipt manifest | 每个预期 cell 的 production producer provenance、host/arm/task/repetition binding、content digest 和完整集合 root |
| mutation report | duplicate、forged、stale、wrong-role、wrong-arm、wrong-producer 和 digest mismatch 均被拒绝 |
| adjudication record | 解封后的逐 task、逐 finding oracle verdict 及 adjudicator/digest binding |
| analysis summary | task/cell/receipt 分列、absolute safety、paired effect、confidence bound、power、protocol deviations 和 PASS/FAIL/INCONCLUSIVE |

artifact 之间必须通过 digest 引用形成闭合链；仅有总结 Markdown、截图或“reviewer 认为通过”的文本不能设置 `baselineAccepted=true`。

## Failure Attribution Protocol

优化前必须为 4 个漏检和 1 个误报分别建立结构化 attribution record。每条至少包含：

| 字段 | 含义 |
|---|---|
| `sampleId` / `roleId` / `hostId` / repetition | 定位失败分布 |
| expected finding | 独立 adjudication 预期 |
| legacy evidence span | Legacy 成功依赖的最小 Prompt/Task Context 证据 |
| modular evidence span | Modular 实际获得的对应内容 |
| failure class | missing-context / weak-instruction / lost-cross-reference / threshold-error / host-variance / other |
| causal mutation | 删除或恢复最小语义后，结果是否按预期翻转 |
| proposed extension | 最小修复落点，不能包含 sample-specific token |
| falsifier | 什么测试能证明该归因错误 |

仅比较最终回答文本不足以形成根因。每个归因至少需要一个 biting mutation：恢复候选语义应修复对应漏检，删除同一语义应使控制测试失败；误报修复也必须有正反控制，避免通过“永不报 finding”消除误报。

## Optimization Strategy

### Stable Role Core

每个复杂角色保留始终需要的最小职责：

- role identity 和 authority boundary；
- required inputs、checks、outputs；
- evidence threshold；
- stable stop/fail-closed conditions；
- Task Context 与 Envelope binding 要求。

### Conditional Extensions

优先从 failure attribution 中提取可泛化的语义模块。候选策略：

1. 将被过度压缩、但对多个样本共同必要的规则恢复为共享 extension。
2. 将只在 closeout、critical finding、scope expansion 等结构化场景必要的长规则按需注入。
3. 对漏检增加“必须引用证据才能 no-issue”的检查闭环，而不是增加结论暗示。
4. 对误报增加明确的 evidence threshold、negative condition 和“不足以构成 finding”的边界。
5. 保留真实 full correctness fallback；超预算只记录 violation，不截断关键上下文。

### Budget Discipline

每个候选版本都必须记录：

- final assembled bytes；
- estimated tokens；
- configured limit；
- selected extension ids 与各自 bytes；
- provider-reported input/cache/latency（可用时）；
- over-limit 后是否完整执行；
- `baselineAccepted`。

质量通过前不评价节省成功。质量通过后，成本结论仍只能覆盖实际可观测维度。

## Experimental Design

### Units, estimands, and frozen denominators

以下单位必须在协议和 summary schema 中分开，禁止把它们都称为样本量：

| 单位 | 用途 | 是否独立统计单位 |
|---|---|---|
| task | 从目标任务总体独立构造的盲测任务 | 是；primary sampling unit |
| host | 同一 task 在 Codex CLI / Claude CLI 上的交叉条件 | 否；crossed factor |
| arm | 同一 task 的 legacy / modular 配对条件 | 否；paired treatment |
| repetition | 同一 task/host/arm 的随机重复 | 否；nested observation |
| cell / receipt | 一次真实 provider 执行及其审计记录 | 否；execution evidence |
| expected finding | oracle 中预注册的应检问题 | outcome；按 task 聚类 |

因此，`8 tasks × 2 hosts × 2 arms × 3 repetitions = 96 cells` 表示 96 条执行证据，但 primary statistical `n=8 tasks`，不是 96。repetition 用于估计同一条件下的运行波动，不能制造任务多样性。

campaign 冻结前必须记录以下分母，任何字段缺失都禁止开始 confirmatory run：

```text
independentTaskCount
positiveTaskCount
negativeTaskCount
expectedFindingCount
criticalFindingCount
falsePositiveOpportunityCount
taskClassCounts
roleCounts
```

每个 task 的 oracle 必须同时冻结 expected findings、严重度、允许的语义等价表达、`not-applicable` 条件和 false-positive 判定规则。primary engineering outcome 为 task-level pass；逐 finding recall、false positives、host、role 和 task class 作为预注册组成指标报告。

task-level pass 的默认聚合规则为：每个 non-critical expected finding 在每个 host 上至少 `2/3` repetitions detected；每个 critical expected finding 在两个 host 上均为 `3/3` detected；任一 repetition 出现 unsupported critical/high finding 则该 task 失败。若采用不同聚合规则，必须在解封 holdout 前冻结理由和阈值。

### Development regression campaign

使用原 v3 72 cells，目的仅为：

- 4 个已知漏检恢复；
- 1 个已知误报消除；
- 其余既有正确 cells 不退化；
- provenance/mutation suites 保持 biting。

该 campaign PASS 是 candidate freeze 的必要条件，但不是 blind validation。报告必须把它标记为 `development-regression`，并显式记录 `generalizationWeight=0`；不得与新 holdout 合并计算 recall、置信区间或有效样本量。

禁止用重复 provider runs 选择偶然通过的输出。开发阶段可以使用确定性的 consumer/selfcheck 和最小 targeted provider probes；最终完整 campaign 只在候选冻结后执行。

### Blind holdout campaign

holdout 在 Prompt 修改前冻结，至少覆盖原三类任务：

- simple bounded change；
- multi-round high finding；
- closeout re-attestation。

并至少增加一种对 conditional extension 选择有压力的样本，例如同一 story 同时包含 scope、delivery 和 evidence 边界，但只有其中一部分真正适用。

第一阶段可以使用至少 8 个新 task 做 protocol pilot；如保持 2 hosts、2 arms、3 repetitions，则产生 96 cells。pilot 用于验证 producer、receipt、oracle 解封、聚合和成本，不足以单独支持总体非劣效或 rollout eligibility。

正式 confirmatory holdout 的独立 task 数不得由固定 cell 数反推。必须在运行前根据预注册非劣效 margin、预期 paired disagreement、目标 power 和显著性水平完成功效分析，并冻结 task 数、成本上限和停止规则。默认要求 one-sided `alpha=0.05`、power 至少 `80%`；若算出的独立 task 数不可承担，应缩小论文主张或维持 `INCONCLUSIVE`，不得用增加 repetitions 代替独立 tasks。

如果 pilot 结果被用于选择 Prompt、oracle、margin、阈值或样本量，pilot tasks 必须从 confirmatory 分析中排除；除非事前采用并冻结允许 internal pilot 的统计设计。

### Host and order control

- hosts：Codex CLI + Claude CLI；
- arms：frozen legacy baseline + candidate modular；
- repetitions：每个 sample/host/arm 3 次；
- arm order：继续采用预注册交叉顺序，控制先后与缓存偏差；
- model、tool policy、producer version、schema、corpus digest、adjudication digest 在 campaign 开始后冻结；
- provider seed/temperature 不可统一控制时，明确记录 unavailable。

legacy 与 modular 必须在相同 task、host 和冻结 provider 条件下配对运行。legacy 的偶然低表现不能降低 modular 的绝对安全门槛；paired difference 与各 arm 的绝对结果必须同时报告。

### Statistical analysis plan

confirmatory campaign 开始前必须冻结：

- primary estimand：modular 与 legacy 的 task-level paired pass-rate difference；
- 非劣效 margin `delta`：由产品风险容忍度决定，不得根据 pilot/candidate 结果倒推；
- primary analysis：以 task 为 cluster 的 paired analysis 和置信区间；
- missing/invalid task：按 fail-closed 协议处理，不做有利于 candidate 的插补；
- multiplicity：aggregate task-level outcome 是唯一 primary inference；per-host 为安全门槛，per-role/per-class 默认只作诊断描述。

只有当 paired effect 的 one-sided 95% confidence bound 排除 `-delta`，且全部工程安全门槛通过时，才允许 `recallNonRegressionClaim=true`。未达到预注册 power、confidence bound 未排除 `-delta`、协议偏离或有效独立 task 数不足，都必须输出 `INCONCLUSIVE`，不能输出 PASS。

如果计划对多个 host、role 或 failure class 分别作推断性主张，必须为每个 strata 预设最小独立 task 数并采用明确的多重比较控制；否则这些表格只能标为 exploratory/diagnostic。

## Pre-Registered Acceptance Gates

候选 modular 只有同时满足 integrity、engineering quality、confirmatory inference 和适用的 budget gates，才允许 `baselineAccepted=true`。protocol pilot 即使全部通过，也不能设置该字段。

### Engineering quality gates

1. Development regression set：已知 applicable findings 为 24/24 detected。
2. Development regression set：false positives 为 0。
3. Development regression 只作必要条件，不进入 holdout 分母。
4. Blind holdout：全部 critical finding 满足冻结的双 host `3/3` 门槛；任一 critical miss 直接拒绝 candidate。
5. Blind holdout：unsupported critical/high false positive 为 0。
6. Blind holdout：modular 的 task-level pass、finding recall 和 false positives 同时报告绝对值及 paired legacy 差值；legacy 变差不得放宽 modular 的绝对门槛。
7. 不允许由一个 host 的改善掩盖另一个 host 的系统性回退；两个 host 必须分别满足冻结安全门槛。
8. delivery/scope/author/evaluator/authority/signature/Task Context/REVIEW-credit invariant suites 全部通过。

### Confirmatory inference gates

1. 独立 task 数达到冻结的功效要求；cells 和 repetitions 不计作独立 `n`。
2. primary task-level paired effect 的 one-sided 95% confidence bound 排除 `-delta`。
3. `delta`、alpha、power、聚合规则、missing-data 规则和停止规则均在 candidate/holdout 解封前冻结。
4. primary inference 只使用 blind confirmatory tasks；开发集和被用于调参的 pilot tasks 权重为零。
5. 未经充分样本量和多重性控制的 per-role/per-class 结果不得升级为 confirmatory claim。

### Integrity gates

1. expected receipt count 完整，不能缺 cell。
2. production audit producer、event、Envelope、role、arm、host、material 和 campaign digest 全部验证通过。
3. duplicate、forged、stale、wrong-role、wrong-arm、non-production receipt mutations 全部被拒绝。
4. independent adjudication 在 candidate 冻结后产生或解封，且 digest 进入 summary。
5. 原始 provider content 不进入不必要的长期证据面；只持久化协议允许的 transcript/metric/digest。

### Budget and observability gates

1. Candidate 不得依靠截断 correctness context 达到预算。
2. 超预算仍完整执行，并保持 `baselineAccepted=false`，直到全部质量门满足。
3. assembled prompt 成本必须相对 frozen legacy 报告；primary cost metric、最小有意义降幅和允许的回退边界必须在 campaign 前冻结。若不设成本阈值，结果只能是 descriptive，不能支持“预算优化成功”或 production rollout claim。
4. provider 指标不可用时保持 `unavailable`/`INCONCLUSIVE`，不得估零。
5. 缓存指标不完整时可以判定质量非劣，但不得声明 cache savings；是否阻塞 production rollout 必须在 campaign 前由独立决策明确，不能事后修改。

### Rollout gate

即使上述实验通过，也只生成 rollout eligibility evidence，不直接改变 production default。切换 `legacy-full-context`、进入 Story 7 promotion 或启用 enforce 必须由后续独立 Story 完成，并重新验证 rollback、host mirrors、process-fact contract 和真实 dispatch。

## Execution Sequence

### Story A：失败归因与实验冻结

交付：

- 5 条结构化 failure attribution；
- causal mutations 与正反控制；
- v3 72 cells 明确标记为 development regression set；
- 由独立构造者生成的新 blind pilot/confirmatory corpus、adjudication protocol、sample matrix 和 digests；
- task/finding/negative 分母、primary estimand、`delta`、功效分析、聚合规则和停止规则；
- 构造者/实现者信息边界、冻结与解封审计事件；
- 预注册 engineering、integrity、inference 和 budget acceptance gates；
- 不改 production default。

退出条件：独立 reviewer 确认归因可证伪、holdout 未泄漏、独立 task 数有功效依据、门槛未针对 candidate 调整。

### Story B：Conditional modularization 实现

交付：

- stable role core 与 conditional extension registry；
- 可信 producer 选择、持久化和 verifier 重算；
- role/extension/Task Context/Envelope digest binding；
- fail-closed consumer；
- budget observation；
- rollback 到 exact legacy；
- process-fact registry 和 contract verifier 同步。

退出条件：build、smokes、mutation tests 和原 72 regression set 的确定性/targeted 证据通过；不提前运行或读取 blind holdout labels。

### Story C：Protocol pilot 与最终候选冻结

交付：

- candidate version/digest freeze；
- development regression campaign；
- 可选的至少 8 个独立 task protocol pilot；
- producer、receipt、oracle 解封、统计聚合和成本管线验证；
- pilot 是否影响 Prompt/threshold/sample size 的结构化记录；
- 若发生影响，pilot tasks 从 confirmatory corpus 排除，并重新冻结最终 candidate 和 confirmatory digests。

退出条件：development regression 与 protocol/integrity checks 通过，最终 candidate、powered confirmatory corpus 和 analysis plan 均不可再修改。pilot 不生成 rollout eligibility。

### Story D：Powered 双 host confirmatory campaign 与 eligibility 决策

仅在 Story C 完成最终冻结后创建或推进。

交付：

- powered blind holdout 双 host、双 arm、三重复 receipts；
- independent adjudication；
- content-addressed summary；
- 独立 task 数与 receipt/cell 数分列；
- paired effect、confidence bound、per-host safety、per-role/per-class diagnostic 和 aggregate quality/cost tables；
- unavailable dimensions 和 protocol deviations；
- `baselineAccepted` 决策；
- 是否允许 Story 7 的明确边界；
- production rollback plan；
- observation window 与 post-rollout regression criteria；
- 不可用 cache 维度对应的 claim 限制。

只有 integrity、engineering quality、confirmatory inference 和适用 budget gates 全部通过时，才生成 rollout eligibility。如果 Story D 为 FAIL 或 INCONCLUSIVE，production 继续 legacy-default，candidate 保持 audit-only；记录失败原因后结束，不伪造 rollout 成功。

Stories A–D 是 Story 6 负面结果后的恢复序列；原 Story 6 保持 DONE 且证据不可改写。Story 7 仍是独立 production promotion/rollout 工作，不由本方案中的实验 PASS 自动完成。

## Required Verification Surfaces

实现 Stories 至少应覆盖：

- Prompt registry 与 host mirror consistency；
- production `agent_prompt` audit producer；
- story dispatch Envelope/event persistence；
- conditional extension selector 与 verifier recomputation；
- role/head/material/Task Context/extension digest mutations；
- complex-role budget observation；
- delivery/scope/authorship/evaluator/authority/signature invariants；
- REVIEW evidence collector 对 audit receipt 的 zero-credit 行为；
- A/B receipt schema、provenance、dedupe、freshness 和 report claims；
- Codex adapter verification；
- process-fact contract；
- routine validation、DONE-required validation 和 real-machine acceptance transcript。

复用现有 Story 6 入口时，至少保持以下命令继续有效：

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/story6-production-dispatch-smoke.js
node packages/main/dist/tasks/story6-role-migration-smoke.js
node packages/main/dist/tasks/prompt-full-context-envelope-smoke.js
node packages/main/dist/tasks/story6-invariants-smoke.js
node packages/main/dist/tasks/story6-acceptance-transcript.js
node experiments/role-prompt-ab-replay/story6-analyze-selfcheck.mjs
node experiments/role-prompt-ab-replay/story6-report-selfcheck.mjs
node scripts/verify-process-fact-contract.mjs
node bin/lattice.js verify_codex
```

新增 campaign 必须使用新的 campaign id、corpus digest、protocol digest 和 summary schema/version；不得覆盖 v3 evidence。

新增 summary schema 必须分别输出 `independentTaskCount`、`cellCount`、`receiptCount`、`expectedFindingCount` 和各冻结分母，禁止只报告一个容易被误读的 `sampleCount`。

## Paper and Reporting Boundary

该工作可用于论文中的工程实证部分，但报告必须区分：

- v3 是一个阻止不安全 rollout 的负面结果；
- 原 72 cells 在本方案中成为 development regression set，不再是独立 holdout；
- 新 blind holdout 才能支持优化后的泛化结论；
- 8-task pilot 即使全部通过，也只能支持协议可运行和有限工程观察，不能表述为总体非劣效；
- repetitions 是同一 task 内的波动观测，不能把 96 cells 表述为 96 个独立统计样本；
- receipt provenance 与 mutation rejection 支持数据完整性，不等同于证明 causal superiority；
- 质量非劣、prompt 成本、provider token、cache 和 latency 是不同 claims，不能互相替代；
- 缺失的 cache 指标限制 cache claim，不得包装成零成本或确定性节省。

推荐论文主张：

> Proofbound 使用内容寻址、生产入口绑定和 fail-closed 的跨模型 Prompt A/B 方法检测到 modularization 的真实质量回退；后续通过预注册、盲测和 conditional context recovery 评估能否恢复质量，而不是在失败后直接启用 rollout。

## Risks and Mitigations

| 风险 | 触发信号 | 后果 | 缓解 |
|---|---|---|---|
| 对原 72 cells 过拟合 | 原集全绿但 holdout 失败 | 虚假非劣 | 原集仅作 development；新 blind holdout 决策 |
| 用完整 legacy 文本恢复召回 | candidate bytes 接近 legacy | modularization 名存实亡 | extension 最小化并报告逐模块成本 |
| 通过降低 finding 敏感度消除误报 | FP 下降同时 recall 下降 | 漏检增加 | recall/FP 联合门槛与正反控制 |
| host-specific 修复 | 一个 host PASS、另一个回退 | 泛化失败 | per-host 阻塞门槛，不只看 aggregate |
| 将 repetitions 当独立样本 | 把 96 cells 报告为 `n=96` | 伪精确、置信区间过窄 | task 为 cluster；task/cell/receipt 分列 |
| holdout 分母未冻结 | 只写 task 数、不写 finding/negative 数 | recall/FP 无法解释 | 冻结全部 oracle 分母和聚合规则 |
| legacy 偶然变差降低门槛 | paired legacy 出现随机漏检 | modular 错误放行 | paired difference 与绝对安全门槛并用 |
| 小 strata 过度推断 | 对每个 role/class 分别宣称非劣 | 多重比较与低功效 | 单一 primary outcome；其余默认 diagnostic |
| holdout label 泄漏 | implementer 可读取 adjudication | 评估污染 | 冻结、分权、digest、运行后解封 |
| 缺失 cache 数据被误解 | unavailable 被填零 | 成本结论失真 | schema fail closed；claim 级限制 |
| 重复 campaign 挑选偶然结果 | 未预注册的额外轮次 | p-hacking/选择偏差 | 冻结重复次数和停止规则 |
| extension selector 可被调用方操纵 | caller 自选 context | 绕过评估/门禁 | producer 机械选择，consumer 重算 |
| 实验 PASS 直接切生产 | 无独立 rollout Story | 回滚与观察缺失 | eligibility 与 rollout 分离 |

## Completion Criteria

本执行方案完成不等于 modular rollout 完成。整个恢复序列只有在以下事实全部成立时才算获得 rollout eligibility：

- 5 个已知失败有可证伪根因与 biting controls；
- 原 72 regression set 达到 24/24 recall、0 false positives；
- 新 powered blind holdout 达到冻结独立 task 数和全部 oracle 分母；
- 工程层满足双 host 绝对安全门槛，统计层的 paired confidence bound 排除 `-delta`；
- integrity、authority、signature、Task Context 和 REVIEW-credit 门禁无回归；
- 成本与 provider observability 按可见边界诚实报告；
- independent summary 明确给出 `baselineAccepted=true`；
- 后续 rollout Story 仍需单独完成 production switch、rollback 和 observation-window 验证。

任何一项不满足时，正确结果仍是保持 `legacy-full-context` production default，并让 modular candidate 留在 audit-only。
