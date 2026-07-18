# 1000+ 文档下的有界开发上下文执行方案

## 状态

- 状态：审计草案 rev 4，尚未批准。
- 日期：2026-07-17。
- 目的：供人类审计和修订；本文不构成实施授权，也不改变现有 lifecycle、review、validation、evidence 或 DONE gate。
- 后续动作：只有审计确认后，才把批准范围拆成 Story 并进入实现。
- 审计边界：本文不预先建议批准任何里程碑。M0-A 至 M0-D 也必须逐项审计；M1 需先确认 Root Registry、worktree snapshot 和 Catalog schema；任何 enforcement 均需完成 A/B 与 non-inferiority 验证并另行批准。

## 0. 审计证据规则

本文把“问题存在的证据”“可借鉴的实现先例”和“候选解法是否有效”分开。发现缺口，不等于已经证明本文提出的补救方案最优或足够。

### 0.1 证据等级

| 标记 | 含义 | 可以支持的结论 | 不能支持的结论 |
|---|---|---|---|
| `VERIFIED_REPO_FACT` | 仓库代码、现行文档或可重放命令直接证明现状、边界或缺口 | “当前实现/合同存在或缺少 X” | “本文方案一定能解决 X” |
| `LOGICAL_CONSTRAINT` | 可由状态空间、依赖关系或统计性质直接推导 | “某种表达必然丢信息/形成环/不能推出结论” | “选定 schema、算法或阈值最优” |
| `REPO_PRECEDENT` | 仓库已有相近机制且边界可核对 | “该行为模式已有兼容先例” | “可以无实验复制到新场景” |
| `PROPOSED_REMEDY` | 为已知问题提出的候选设计 | “值得进入审计或原型验证” | “已被证实有效、完整或最优” |
| `EXPERIMENT_NEEDED` | 需要基准、A/B、故障注入或统计检验 | “必须用数据决定” | “可凭架构偏好直接批准上线” |
| `HUMAN_DECISION` | 涉及风险容忍度、预算、所有权或治理边界 | “需要明确责任人批准” | “可由检索器或本草案自动决定” |

阅读规则：

- 下表中的证据只证明对应的“已知事实/约束”，不自动验证右侧候选补救。
- 本文的 TypeScript interface、字段、阈值、里程碑拆分和 rollout 准入规则，除非明确标为 `VERIFIED_REPO_FACT` 或 `REPO_PRECEDENT`，默认都是 `PROPOSED_REMEDY`。
- `REPO_PRECEDENT` 只能降低实现不确定性，不能替代本场景的回归、性能、安全和 non-inferiority 验证。
- 没有证据或实验结果的项目不得在 Story 中改写为“已验证事实”或“必须如此实现”。

### 0.2 证据账本

| ID | 已知事实或约束 | 等级 | 可重放证据 | 本文候选补救 | 补救状态 |
|---|---|---|---|---|---|
| E-01 | 仓库已有 `shadow` 只观测、`warn` 只建议、`enforce` 才 hard-block 的模式 | `REPO_PRECEDENT` | `packages/main/src/core/process-fact-levels.ts:232`；`packages/main/src/handlers/story-dispatch.ts:86-100` | 第 3.6 节 rollout 矩阵 | 仅有先例；仍需独立 policy 审批 |
| E-02 | Evidence Platform 不拥有 gate hard-fail policy，且禁止平行 artifact registry | `VERIFIED_REPO_FACT` | `docs/evidence/evidence-platform-architecture.md:62-73` | 第 9.2 节复用现有 event/store，manifest 永不成为 gate evidence | 设计待合同测试 |
| E-03 | Global Control Plane 不是第二套 lifecycle state machine，也不重算 gate truth | `VERIFIED_REPO_FACT` | `docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md:109-125` | Context middleware 只返回 assembly 状态 | 设计待接口审计 |
| E-04 | 现有 `currentMaterialHash` 基于 `git ls-tree <ref>`；dirty files 由另一条 `git status --porcelain` 路径读取，因此 HEAD/tree hash 本身不覆盖 staged、unstaged、untracked 内容 | `VERIFIED_REPO_FACT` | `packages/main/src/core/evidence-freshness.ts:151-160,405-415` | 第 5.4 节增加 worktree/changed-path digest | digest 算法未验证 |
| E-05 | 单一互斥 coverage enum 不能同时表达 `mandatory_missing`、`index_stale`、`permission_denied` 等并发条件 | `LOGICAL_CONSTRAINT` | 对任意两个同时为真的条件，单值 enum 最多保留其一 | 第 7 节 `CoverageAssessment.conditions[]` | schema 待原型与消费方评审 |
| E-06 | 若 mandatory roots 必须先由 Catalog 找到，而 Catalog 又依赖 mandatory policy 才能安全加载，会形成引导依赖环 | `LOGICAL_CONSTRAINT` | 依赖图 `Catalog → mandatory roots → Catalog` | 第 5.1 节小型 Root Registry | registry 内容、所有权待决定 |
| E-07 | 仓库当前没有统一、结构化的 `SourceRef` interface/type；现有 `sourceRef` 用法不能证明具有本文要求的跨 snapshot 身份语义 | `VERIFIED_REPO_FACT` | 2026-07-17 在 `packages/main/src` 对 `interface SourceRef`、`type SourceRef` 的 `rg` 检查为零命中；现有 `sourceRef` 多为字符串字段 | 第 5.2 节 Source Identity Contract | 字段和迁移规则均未验证 |
| E-08 | “观察到 0 次 false suppression”不能推出总体发生率为 0 | `LOGICAL_CONSTRAINT` | 二项分布中有限样本零事件的总体上界仍大于 0 | 第 10 节报告 n 与 95% 上置信界 | 统计方法、样本量待预注册 |
| E-09 | Fetch、materialized、delivery 是不同事件；模型自述不能机械证明工具读取或请求注入 | `LOGICAL_CONSTRAINT` | 三者发生在不同边界，任一记录不能蕴含另外两个事件或模型理解 | 第 8 节分离 manifests | channel coverage 与盲区待实测 |
| E-10 | Bash、外部进程或未插桩 host 可能绕过单一 read hook | `LOGICAL_CONSTRAINT` | 存在未经过该 hook 的读取通道即可构成反例 | M0-B 声明 channel coverage 和 blind spots | 需故障注入与 host 实测 |
| E-11 | 章节 ID、copy/rename、parser migration、部分 supersession 没有在上述证据中得到唯一解 | `HUMAN_DECISION` + `EXPERIMENT_NEEDED` | 无可证明唯一性的仓库事实 | 第 5.2/5.3 节初始规则 | 未批准候选 |
| E-12 | 16k/32k、召回率、non-inferiority margin、样本量和 promotion threshold 不能由当前仓库事实推出 | `EXPERIMENT_NEEDED` + `HUMAN_DECISION` | 必须依赖真实任务占用、质量结果、风险容忍度与成本 | M0/M5 校准与预注册 | 未测量、未批准 |
| E-13 | 把 M0 拆成 A-D 是为了隔离合同、runtime mutation、corpus 和统计承诺 | `PROPOSED_REMEDY` | 治理分解，不是经验效果证据 | 第 12/13 节独立批准和回滚 | 待人类审计 |
| E-14 | M6 是否 enforcement、阻塞哪些类别以及是否映射 lifecycle，不是现有证据的必然结论 | `HUMAN_DECISION` + `EXPERIMENT_NEEDED` | E-01 只提供行为先例；不能授权新 blocker | 第 12 节 M6 独立决策 | 明确未批准 |

### 0.3 采纳标准

一项建议只有满足以下之一，才可进入后续 Story：

1. 作为“现状修正”：有 `VERIFIED_REPO_FACT` 或 `LOGICAL_CONSTRAINT`，并且 Story 仍把具体补救标成待验证设计；
2. 作为“实现试验”：有明确假设、失败条件、回滚路径和 `EXPERIMENT_NEEDED` 验证计划；
3. 作为“治理决策”：列明决策者、风险承担者和替代方案，由人类显式批准。

仅仅因为 Claude、agy、Codex 或其他 LLM 提出建议，不构成采纳证据。评审意见只能生成待核验假设，证据必须回到仓库事实、可重放实验、逻辑证明或明确的人类风险决策。

## 1. 问题定义

随着项目增长到 1000 份甚至更多文档，以下模式不可持续：

```text
开始任务
  → 扫描大量 Markdown
  → 把文档正文放入 LLM 上下文
  → 希望 LLM 自己识别哪些内容重要
```

主要问题：

- 输入 token 随文档数量增长，大量内容与当前任务无关。
- 重要约束被长文本和重复说明淹没，更多上下文不等于更高遵从率。
- 旧计划、历史文档、现行决策和代码事实容易混淆。
- “要求读取”不等于模型真的读取，模型自述也不能证明读取发生过。
- 全量扫描成本高，却仍然不能证明理解、覆盖或正确执行。
- 文档占用上下文后，会压缩代码、测试和当前需求的推理空间。

本方案不删除 Markdown，也不把 dev-memory 或 Playbook 提升为权威来源。目标是把 Markdown 从“默认输入内容”改成“可按需访问、可追溯的权威来源”。

## 2. 目标与非目标

### 2.1 目标

1. 正常开发不再默认读取完整文档集合。
2. 每次任务自动获得当前结构化事实、相关经验和有限的权威文档章节。
3. 高风险、冲突或 coverage degraded 的任务能机械升级读取范围。
4. 系统能区分“被检索为候选”和“实际被读取”。
5. 在 1000+ 文档规模下，检索延迟、文档 token 和关键约束召回均可测量。
6. 保留规范来源、source lineage、freshness、supersession 和回滚能力。

### 2.2 非目标

- 不用 memory 或 Playbook 替代规范性决策文档。
- 不让 memory、Playbook、索引或 read manifest 成为 gate evidence。
- 不承诺一次检索能够发现所有新型风险。
- 不把所有文档人工迁移成新的结构化数据库后再开始使用。
- 不在第一阶段修改 lifecycle、review quorum 或 DONE 语义。
- 不因为存在大上下文窗口就接受无界输入。

## 3. 核心原则

### 3.1 Markdown 是知识源，不是默认 Payload

决策文档继续保存完整背景、讨论、取舍和规范依据。正常任务只加载相关章节；只有明确升级时才读取更大的文档范围。

### 3.2 事实与规范分轨，冲突显式化

本方案不使用一条总的“权威顺序”。不同信息平面回答不同问题：

| 平面 | 内容 | 回答的问题 |
|---|---|---|
| Instruction Plane | 平台安全约束、仓库策略、用户当前目标 | 当前交互允许和要求做什么 |
| Normative Plane | contract、decision、policy、canonical docs | 系统应该怎样工作 |
| Observed Plane | CLI、代码、运行结果、测试、Story 和 fresh evidence | 系统现在实际上怎样工作 |
| Advisory Plane | Active Playbook、dev-memory、历史经验 | 有哪些建议、导航和旧经验 |

裁决规则：

- 描述性问题以 Observed Plane 为当前事实；与规范不一致时产生 deviation/finding。
- 规范性问题以当前有效的 Normative Plane 为目标；实现不一致时产生 deviation/finding。
- Instruction Plane 约束当前行动，但不重写规范事实或运行事实。
- Advisory Plane 不能静默覆盖其他平面，也不能满足 review、validation、delivery、receipt、DONE 或 release gate。
- 冲突记录必须携带 `questionType: 'descriptive' | 'normative'`，触发升级或审查，不由检索层自动宣布任一来源失效。

### 3.3 默认有界，风险驱动扩展

正常任务使用固定文档预算。检测到高风险、权威冲突、索引过期或低召回置信度时，系统逐级扩大范围，而不是直接退回全量扫描。

### 3.4 检索必须可解释

不能只输出“语义搜索认为这些文档相关”。每个候选必须携带一个或多个结构化入选原因，例如：

- 用户显式指定；
- checklist `relatedDocs`；
- 修改路径映射；
- symbol/import/call 关系；
- process-fact 依赖；
- 文档链接；
- Playbook `sourceRefs`；
- 类似 Story；
- lexical 或 semantic match；
- reviewer 扩展要求。

### 3.5 候选与实际读取分离

系统必须分别记录：

- **Candidate Manifest**：哪些来源被枚举、召回、排序、纳入或排除。
- **Fetch Manifest**：工具获取了哪些文件、章节和字节范围。
- **Context Delivery Manifest**：哪些 material 被组装或注入具体模型请求。

模型自述“我已经阅读这些文件”不能替代工具或 harness instrumentation 产生的 Fetch/Delivery record；这些 record 也不证明模型理解或遵守了内容。

### 3.6 Rollout 模式行为矩阵

Context middleware 的 rollout mode 与 lifecycle policy 分离：

| Mode | 改变实际输入 | 产生诊断 | 阻止 Context 组装 | 直接阻止 Lifecycle |
|---|---|---|---|---|
| `off` | 否 | 否 | 否 | 否 |
| `shadow` | 否 | 仅记录 | 否 | 否 |
| `advisory` | 是 | 是 | 否 | 否 |
| `enforce` | 是 | 是 | 仅按独立批准规则 | 否 |

Context middleware 最多返回 `BLOCKED_CONTEXT_ASSEMBLY`。是否把该结果映射为 lifecycle blocker，属于 Global Lifecycle Control Plane / lifecycle policy 的独立决策，不能由 Context Pack、manifest 或 middleware 自行决定。

高风险任务在 `shadow` 只记录 `mandatory_missing`，在 `advisory` 显示 degraded 和恢复建议但继续现有流程，只有 `enforce` 才能在已批准类别内阻止 Context Pack 进入 ready 状态。这样 M3 不会形成隐式的“半 enforcement”。

## 4. 目标上下文分层与全局预算

每次开发任务由五层上下文组成。

| 层 | 内容 | 权威性质 |
|---|---|---|
| L0 最小入口 | 本地安全约束、第一恢复命令、禁止路径、信息平面和导航 | 指令与导航 |
| L1 实时事实 | Story/phase/checklist/findings/worktree/validation/evidence freshness | Observed Plane |
| L2 经验上下文 | 有界 dev-memory 和 active Playbook | Advisory Plane |
| L3 权威文档 | roots、relatedDocs、规范决策和公共契约的语义完整单元 | Normative Plane |
| L4 代码与验证 | 修改文件、依赖、调用方、测试和命令结果 | Observed Plane |

所有层最终共享同一个模型输入窗口，L4 不是物理独立预算。预算必须从全局窗口倒推：

```ts
interface ContextBudget {
  maxInputTokens: number;
  reservedForGeneration: number;
  reservedForUserTask: number;
  reservedForCodeAndTests: number;
  reservedForToolOutput: number;
  maxKnowledgeTokens: number;   // L0-L3 总和
  maxDocumentTokens: number;    // L3 上限
  tokenizerId: string;
}
```

初始候选值为普通任务 L0–L3 总和不超过 16,000 tokens、高风险任务不超过 32,000 tokens，但这些不是批准后的硬阈值。M0 必须依据模型窗口、真实代码占用、工具输出和 generation reserve 预注册最终预算。

读取单元应是“最小但语义完整的单元”。不优先整篇文档，也不以“完整文档数量为 0”为优化目标；短文档、定义与例外不可分割的文档可以整体进入上下文。

## 5. Root of Trust、Catalog 与 Snapshot

### 5.1 Context Root Registry

证据定位：E-06 证明需要打破引导依赖环；以下 registry 结构是 `PROPOSED_REMEDY`，尚未证明为唯一或最小实现。

Mandatory roots 不能依赖 Catalog 自己发现。系统首先加载一个极小、机械维护、无需检索即可读取的 Root Registry：

```ts
interface ContextRootRegistry {
  bootstrapRoots: SourceRef[];
  conditionalRootRules: ConditionalRootRule[];
  policyVersion: string;
  digest: string;
}

interface ConditionalRootRule {
  ruleId: string;
  source: SourceRef;
  appliesWhen: {
    lifecyclePhases?: string[];
    riskSignalsAny?: string[];
    pathPatternsAny?: string[];
    symbolPatternsAny?: string[];
    contractTypesAny?: string[];
  };
  mandatory: boolean;
  failureMode: 'degraded' | 'block_when_enforced';
}
```

加载顺序固定为：

```text
Context Root Registry
  → unconditional bootstrap roots
  → initial mechanical Task Fingerprint
  → matching conditional root rules
  → conditional mandatory roots
  → Catalog
  → ordinary retrieval
```

Bootstrap roots 只包含仓库安全入口、lifecycle 最小导航、context policy 和第一恢复命令。公共契约和风险相关来源通过 conditional rules 选择，避免 Root Registry 本身重新变成无界入口。

Catalog 可以扩展、切片和路由 root，但不能决定 root 是否存在。Root Registry 的变更必须机械校验引用、digest、规则确定性和 policy version；它只保存关键入口和规则，不复制全部文档内容。

### 5.2 Source Identity Contract

证据定位：E-07 证明当前缺少满足本方案需求的统一身份合同；以下字段、ID 与 digest 规则是 `PROPOSED_REMEDY`，必须先做兼容性和迁移原型。

M1 前必须冻结统一的引用和 digest 语义，Catalog、Snapshot、Candidate、Fetch 和 Delivery 只能消费这一份合同：

```ts
interface SourceRef {
  repositoryId: string;
  workspaceId: string;
  docId: string;
  sectionId?: string;
  revision: string;
  sourceDigest: string;
  sectionDigest?: string;
  pathHint?: string;
}
```

初始规则：

- 高价值 contract/decision/policy 使用显式 immutable `docId`；同一 repository 内 rename 不改变 ID，copy 默认产生新 ID，除非 registry 明确声明为另一个 source view。
- 不同 branch/worktree 共享 `docId`，由 `revision`、snapshot 和 digest 区分具体版本。
- 普通文档允许 provisional ID，但必须在 record 中声明 provisional，不能用它建立不可逆 supersession。
- `sourceDigest` 默认对原始文件 bytes 做 SHA-256；`sectionDigest` 对 parser 规范化后的 section bytes 做 SHA-256，并绑定 parser version。
- 高价值章节优先使用显式稳定 anchor/registry ID。普通章节 fallback 使用 parent stable ID + normalized heading slug + collision suffix；重复 anchor、collision 和 parser migration 必须报告，ordinal/line range 不作为长期身份。
- authorization 和 digest 使用解析后的 canonical physical path；逻辑路径只保留为 `pathHint`，symlink 不能改变信任边界。

### 5.3 Canonical Document Catalog

为文档建立可重建的派生目录，但目录本身不是权威来源。

```ts
interface SupersedesEdge {
  supersededTarget: {
    docId: string;
    sectionId?: string;
    factId?: string;
  };
  declaredBy: SourceRef;
  effectiveFrom: string;
  effectiveUntil?: string;
  reason: string;
}

interface DocumentCatalogRecord {
  docId: string;
  repositoryId: string;
  workspaceId: string;
  path: string;
  title: string;
  plane: 'normative' | 'advisory';
  documentKind: 'contract' | 'decision' | 'policy' | 'runbook' | 'design' | 'history' | 'reference';
  origin: 'repository' | 'workspace' | 'external';
  status: 'active' | 'draft' | 'superseded' | 'archived';
  visibility: 'private' | 'workspace' | 'repository';
  trustLevel: 'trusted' | 'restricted' | 'untrusted';
  containsSensitiveData: boolean;
  retentionPolicy: string;
  owners: string[];
  topics: string[];
  appliesToPaths: string[];
  symbols: string[];
  factIds: string[];
  linkedDocs: string[];
  supersessionEdges: SupersedesEdge[];
  stableSectionIds: string[];
  sourceDigest: string;
  contentDigestAlgorithm: string;
  branchOrRevision: string;
  indexedAt: string;
  catalogSchemaVersion: string;
  parserVersion: string;
}
```

目录契约：

- 文档正文仍是规范来源，Catalog 只是索引和 routing 数据。
- Catalog 必须可以从源文件和机械 registry 完整重建。
- 更新必须写入临时版本、验证完整性后原子切换。
- reader 只能看到旧的完整版本或新的完整版本，不能看到部分更新。
- digest 不匹配时不得静默使用旧记录。
- `superseded`、`archived` 和不适用的历史文档默认不进入当前上下文。
- 路径不能单独作为语义身份；同一文档的不同 authority/source view 必须保留独立 provenance。
- Supersession edge 表示声明方取代 `supersededTarget`。只有新文档或独立 registry 显式声明、且 `declaredBy` fresh 时才能生效；推断关系只能成为 advisory conflict candidate，不能自动排除来源。
- 必须支持 document、section 和 fact 级部分 supersession，禁止用整篇替代关系粗暴覆盖仍然有效的章节。
- 声明方删除、branch 冲突、cycle 或 effective period 重叠时标记 degraded；未被 edge 覆盖的章节保持原 status。
- `indexedAt` 只描述索引时间，freshness 以 revision、source digest、policy/parser version 为准。
- Observed Plane 的代码、CLI、测试和运行结果由 live-fact/source adapter 提供，不伪装成 `DocumentCatalogRecord`。

初期不要求人工为 1000 份文档补齐全部字段。可以先从路径、标题、链接、现有 registry、frontmatter 和 git 历史派生，再对高价值规范来源逐步补强。

### 5.4 Worktree Overlay 与 Context Snapshot

证据定位：E-04 证明仅用 HEAD/tree hash 不覆盖 dirty worktree 输入；以下 overlay 与 digest 字段是 `PROPOSED_REMEDY`，不代表算法已通过碰撞、性能或跨平台验证。

Catalog 使用“main 基线 + per-worktree 增量 overlay”，避免一个 Story 的文档改动污染其他并行 Story。每个任务 pin 一个快照：

```ts
interface ContextSnapshot {
  headRevision: string;
  worktreeId: string;
  worktreeStateDigest: string;
  changedPathSetDigest: string;
  catalogBaselineDigest: string;
  catalogOverlayDigest: string;
  rootRegistryDigest: string;
  policyVersion: string;
  parserVersion: string;
  createdAt: string;
}
```

`headRevision` 不能代表 staged、unstaged 或 untracked 状态；`worktreeStateDigest` 和 `changedPathSetDigest` 必须覆盖这些 dirty inputs，Catalog overlay 也单独绑定。读取和 delivery 时验证 `expectedSourceDigest === actualSourceDigest`。changed paths、mandatory roots、Catalog overlay、parser 或 policy version 发生变化时快照过期，必须重新规划；review 前再次验证 mandatory source freshness，防止检索到实现之间的 TOCTOU。

## 6. 检索与上下文组装流水线

```text
用户目标 + Story + 预计 touchpoints
  ↓
权限与 trust-boundary 过滤
  ↓
加载 Root Registry 与 bootstrap roots
  ↓
生成初始机械 Task Fingerprint
  ↓
匹配 conditional roots
  ↓
生成可修订的完整 Task Fingerprint
  ↓
装载强制来源
  ↓
多路候选召回
  ↓
合并、去重、authority/supersession 过滤
  ↓
风险、冲突和 freshness 检测
  ↓
章节级排序
  ↓
按预算组装 Development Context Pack
  ↓
记录 Candidate Manifest
  ↓
记录 Fetch 与 Context Delivery Manifest
```

Authorization 必须发生在召回和排名之前：

```text
repository/workspace authorization
  → trust-boundary filtering
  → mandatory routing
  → lexical/structural/optional semantic retrieval
  → ranking
```

未授权来源的标题、路径、摘要和 embedding 都不能进入候选、日志或跨任务索引。Manifest 和 Catalog 必须有访问控制、脱敏和 retention policy；外部来源默认视为 untrusted，不得因 semantic 相似度跨 repository/workspace 召回。

### 6.1 Task Fingerprint

Fingerprint 必须区分机械事实与 LLM 推断，关键机械召回通道不能依赖 LLM 预估正确：

```ts
interface TaskFingerprint {
  fingerprintRevision: number;
  previousFingerprintDigest?: string;
  changedBecause: string[];
  mechanical: {
    lifecyclePhase: string;
    checklistRefs: string[];
    relatedDocs: SourceRef[];
    expectedPaths: string[];
    actualChangedPaths: string[];
    symbols: string[];
    dependencyEdges: string[];
    riskSignals: string[];
  };
  inferred: {
    likelyDomains: string[];
    likelyTouchpoints: string[];
    semanticQuery: string;
  };
  actualTouchpoints: Touchpoint[];
}
```

内容至少覆盖：

- 用户目标与可见结果；
- Story/checklist/verification intent；
- 预计修改路径；
- symbol、import 和 call graph；
- lifecycle phase；
- public API、schema、security、migration、destructive、gate 等风险标签；
- 当前 findings、bugs 和验证缺口；
- fingerprint 输入 digest 和策略版本。

Fingerprint 不是只在任务开始时生成一次。至少在以下 checkpoint 重算：

```text
Initial
  → Pre-edit
  → Change-delta
  → Pre-validation
  → Pre-review
```

实际 changed paths 超出预计范围、新增 public API/schema/migration、依赖图扩展、risk tags 变化、reviewer 扩大范围或 mandatory digest 变化时必须递增 `fingerprintRevision` 并重新规划 Context Pack。

### 6.2 强制来源

以下来源不参加普通排名，直接进入候选集：

- 用户明确指定的文档；
- checklist `relatedDocs`；
- 修改流程事实时对应的 canonical decision 和 mechanical registry；
- 修改公共契约时对应的 contract；
- 当前仓库的最小安全约束；
- reviewer 明确要求的来源。
- Context Root Registry 中与任务风险和阶段匹配的 roots。

强制来源不能因预算不足被静默裁剪。预算不足时只允许：扩大经批准的预算；缩小任务并拆为独立子任务；按语义边界建立各自拥有 scope、mandatory set、snapshot、Delivery Manifest 和验证责任的阶段；或停止并报告。跨多个请求简单“分批读取”不能证明所有 mandatory source 同时存在于同一决策上下文。

### 6.3 多路召回

候选集合取以下结果的并集，不能只依赖 embedding：

- 精确路径、标题和关键词；
- Catalog metadata；
- path/symbol 映射；
- import/call graph；
- 文档链接图；
- process-fact registry；
- Playbook/sourceRefs；
- 类似 Story 和历史 findings；
- lexical retrieval；
- semantic retrieval。

候选生成和排序必须确定性地记录策略版本、输入 digest、候选 ID 和 tie-break 规则，以便 replay。

首期只要求 lexical、path、symbol、link 和 process-fact 等机械通道。Semantic retrieval 是 M2 数据证明有净收益后才可启用的可选 provider，必须单独记录模型、费用、延迟、版本和可重复性边界。

### 6.4 章节级读取

检索和 delivery 单位优先为：

```text
document-id + stable-section-id + source-digest
```

`sectionId` 由稳定 heading path、ordinal 和父 section identity 派生；line range 只是在特定 source digest 下的定位信息，不是语义身份。

选择目标是最小但语义完整的单元。被选章节显式引用同文档其他章节、定义或例外时，必须连带纳入引用单元；超预算则升级或报告 blocker，不得断章取义或静默裁剪。

## 7. 风险升级规则

升级依据使用多条件 assessment，不把不可跨查询比较的 embedding score 当作通用置信度：

```ts
type CoverageCondition =
  | 'mandatory_missing'
  | 'catalog_stale'
  | 'authority_conflict'
  | 'scope_uncertain'
  | 'retrieval_degraded'
  | 'cross_domain_expansion_required'
  | 'snapshot_drift'
  | 'delivery_truncated';

interface CoverageAssessment {
  status: 'ready' | 'degraded' | 'blocked';
  conditions: CoverageCondition[];
  missingMandatorySources: SourceRef[];
  staleSources: SourceRef[];
  conflictIds: string[];
  evaluatedAt: string;
  policyVersion: string;
  assessmentDigest: string;
}
```

`conditions` 去重并确定性排序，保留同时发生的全部问题。无 condition 时派生 `ready`；shadow/advisory 下有 condition 只能派生 `degraded`；只有 mode=`enforce` 且命中独立批准的阻断规则时才能派生 `blocked`。原始条件和派生 status 都进入 replay，不允许调用方自行发明优先级。

满足任一条件时扩大文档读取：

- 修改 lifecycle、gate、review、evidence 或 DONE 语义；
- 修改安全、凭证、数据迁移或破坏性行为；
- 修改公共 API、持久化 schema 或跨模块协议；
- 两个权威来源发生冲突；
- Playbook、memory、当前代码或 live fact 相互矛盾；
- mandatory source 缺失、没有机械 route 或 CoverageAssessment 为 degraded/blocked；
- 找不到某个行为的规范来源；
- Story 触及多个架构域；
- reviewer 认为候选范围不足；
- 文档 digest 与 Catalog 不一致。
- 实际 changed paths 超出当前 Fingerprint。
- 同一 factId 出现多个 active normative value。
- 结果只有 advisory/semantic route，没有任何 mandatory 或机械 route。

升级阶梯：

```text
相关章节
  → 直接关联文档
  → 同一 fact/topic 的权威文档
  → 同一架构域
  → 人类明确批准的广域审计
```

“广域审计”是独立模式，必须记录触发原因、枚举范围和预算，不得成为普通开发的隐式默认值。

第一阶段只机械检测 factId 多值、supersession cycle、contract/version digest 冲突、互斥 policy 重叠、effective period 重叠和 Catalog/frontmatter drift。LLM 识别的自然语言冲突统一标记为 `suspected_semantic_conflict`，可以触发扩大读取或 reviewer 检查，但不能自动裁决来源有效性。

## 8. Candidate、Fetch、Delivery 与 Usage 记录

### 8.1 Candidate Manifest

至少记录：

- 完整文档目录版本和 digest；
- Task Fingerprint digest；
- mandatory sources；
- 每条候选的召回通道和分数；
- authority/status/freshness；
- 被纳入或排除的结构化原因；
- budget cutoff 和 omitted count；
- escalation level 和原因。

排除原因使用有限枚举，例如：

- `duplicate`；
- `superseded`；
- `historical_only`；
- `outside_task_scope`；
- `lower_authority_duplicate`；
- `budget_cutoff`；
- `stale_index`；
- `untrusted_source`。

完整 Candidate Manifest 存放在模型上下文之外的审计存储。Context Pack 只携带 manifest ref/digest、排除汇总和少量 notable exclusions，禁止为了证明“排除了什么”把 1000 条排除记录重新塞回模型上下文。

### 8.2 Fetch Manifest

```ts
interface DocumentFetchRecord {
  path: string;
  docId: string;
  sourceDigest: string;
  sectionId: string;
  lineStart: number;
  lineEnd: number;
  bytesRead: number;
  estimatedTokens: number;
  fetchedAt: string;
  toolEventId: string;
  channel: 'read_tool' | 'controlled_retrieval' | 'bash_observed';
}
```

约束：

- Fetch record 只证明工具读取并返回了特定 bytes，不证明内容进入最终模型请求。
- 手工填写和模型自述不能成为 fetch evidence。
- Read-tool、controlled retrieval 和 Bash observation 的覆盖能力不同，必须在记录中声明；无法观察的 Bash/外部通道是已知盲区，不能宣称总体读取覆盖率 100%。
- `selectedBecause` 属于 Candidate Manifest，通过 `toolEventId` 关联，不混入纯读取事实。

### 8.3 Context Delivery Manifest

```ts
interface DocumentContextDeliveryRecord {
  requestId: string;
  docId: string;
  sectionId: string;
  sourceDigest: string;
  contentDigest: string;
  stage: 'materialized' | 'injected';
  deliveredTokens: number;
  truncated: boolean;
  deliveredAt: string;
  fetchEventIds: string[];
}
```

Delivery record 证明一段 material 被组装或注入某个模型请求；它仍不证明模型关注、理解、引用或遵守了内容。若 provider/harness 无法证明最终 request injection，只能记录 `materialized`，不得升级为 `injected`。

### 8.4 Usage Trace（可选、非认知证明）

Usage Trace 可以记录输出引用、tool decision 或显式 source attribution，但只是行为线索，不证明认知过程或正确性。

### 8.5 永久红线

- Candidate、Fetch、Delivery 和 Usage 记录都不是 gate evidence。
- 它们不能作为 reviewer pass、verification、validation、delivery 或 DONE 的充分条件。
- 缺失 mandatory delivery 可以产生 context assembly blocker 或审计告警；“已 delivery”不能证明实现正确。
- 是否把 manifest digest 关联 reviewer run 只能用于 provenance/audit，必须另行决策并有负向测试证明 gate 不消费它。

## 9. Development Context Pack

```ts
interface DevelopmentContextPack {
  taskFingerprintDigest: string;
  fingerprintRevision: number;
  contextSnapshotDigest: string;
  authority: 'mixed_context_not_gate_evidence';
  liveFactsDigest: string;
  memoryPackDigest: string;
  catalogDigest: string;
  rootRegistryDigest: string;
  policyVersion: string;

  candidateManifestRef: string;
  candidateManifestDigest: string;
  mandatorySources: SourceRef[];
  selectedSources: SourceRef[];
  exclusionSummary: {
    totalExcluded: number;
    byReason: Record<ExclusionReason, number>;
  };
  notableExclusions: ExcludedCandidate[];
  conflicts: ConflictRecord[];
  coverageAssessment: CoverageAssessment;

  escalation: {
    level: number;
    reasons: string[];
  };

  budgets: {
    documentTokens: number;
    memoryTokens: number;
    totalTokens: number;
    omittedCandidates: number;
  };
}
```

Context Pack 是混合上下文容器，不是新的权威层。每条内容保留自身 authority 和 provenance，容器不能把 advisory memory 提升成规范或证据。

### 9.1 Runtime 模块边界

整体作为独立 context middleware，不让 lifecycle 核心知道 embedding、Catalog 存储、切片、manifest 持久化或排序细节：

```ts
interface BoundedContextService {
  plan(request: ContextRequest): Promise<ContextPlan>;
  materialize(plan: ContextPlan): Promise<MaterializedContext>;
  recordDelivery(event: ContextDeliveryEvent): Promise<void>;
  reevaluate(delta: TaskDelta): Promise<ContextPlan>;
}
```

建议内部 provider：`RootRegistryProvider`、`CatalogProvider`、`TaskFingerprintBuilder`、`RetrievalProvider`、`CoveragePolicyEngine`、`ContextAssembler`、`ContextDeliveryObserver` 和 `EvaluationRecorder`。Lifecycle 只调用稳定接口并消费明确的 advisory/degraded 状态。

### 9.2 与 Evidence Platform 和 Global Lifecycle Control Plane 的边界

Bounded Context Service 是 advisory context producer，不是第二套 evidence 或 lifecycle control plane：

```text
Bounded Context Service
  → 生成 context plan、material 和 observation refs

Common process-event infrastructure
  → 保存 telemetry、manifest ref 和 provenance envelope

Evidence Platform / Proof Admissibility
  → 继续拥有 evidence definition、admissibility 和 gate-consumer 语义

Global Lifecycle Control Plane / story state machine
  → 继续拥有 lifecycle decision 和 blocker 映射
```

禁止 middleware 自建并行 artifact registry、run identity、reviewer authority、phase、gate 或 blocker 体系。Context observation 复用现有 event/store API，并使用仓库已有的 `authority=non_authoritative`、`gateEvidence=false` 语义；不得仅为本方案发明一个竞争性的 evidence store 或 admissibility vocabulary。

必须更新 process-fact registry，把 Candidate/Fetch/Delivery/Usage 事件登记为 observation-only，并加入负向合同测试：任何 reviewer、validator、DONE evaluator、release gate 或 Evidence Platform consumer 都不得把这些事件当作通过证据。Context middleware 的 `blocked` 只表示 assembly 状态；映射到 lifecycle 的权力仍属于独立批准的 lifecycle policy。

## 10. 性能与质量门槛

以下数值仅是 M0 要检验的候选假设，不是批准后的验收阈值。M0 必须预注册分母、硬件、模型、tokenizer、索引规模、并发、warm/cold 条件、样本量、ground-truth 生产者、non-inferiority margin 和置信区间：

| 指标 | 初始目标 |
|---|---:|
| 普通任务 L0-L3 knowledge context | 候选 ≤ 16,000 tokens，M0 校准 |
| 高风险任务 L0-L3 knowledge context | 候选 ≤ 32,000 tokens，M0 校准 |
| 默认 dev-memory | ≤ 5 条 |
| 默认 active Playbook | ≤ 3 条 |
| 不必要内容比例 / overfetch ratio | M0 建基线并预注册上限 |
| 1000 文档 warm/cold 检索 p95 | 候选 warm ≤ 1 秒；条件和 cold 目标由 M0 定义 |
| Context Pack 生成 p95 | 候选 ≤ 1.5 秒；必须包含 freshness 与 authorization 时间 |
| seeded mandatory 与非-mandatory recall | 按通道和风险层分别报告 |
| 已标注章节级 top-k recall | k、标注者独立性和置信区间由 M0 定义 |
| false-suppression | 预注册标注集中 observed count=0，并报告 n、风险分层和 95% upper confidence bound |
| mandatory-source miss/cut | 报告 observed count、n、risk strata、route type、95% upper bound 和是否被 escalation 捕获；静默裁剪 observed count=0 |
| Fetch/Delivery 覆盖率 | 按可观测 channel 报告，不宣称总体读取覆盖 |
| context delivery truncation rate | 0 或显式 degraded/blocker |
| token 降幅 | M0 前不设 promotion 数值；相对真实现行流程报告 Pareto 改善，并受质量 non-inferiority 约束 |
| escalation/human override/retrieval-degraded rate | 联合报告，不得单项优化 |
| post-edit fingerprint expansion rate | 报告任务中途范围扩展频率 |
| reviewer-added-source rate | 报告 reviewer 补充来源的频率 |
| defect recurrence/non-inferiority | M0 预注册 margin、样本量和统计功效 |
| 每任务检索与索引重建成本 | M0 预注册时间、CPU/RSS、API 和费用上限 |

不能只证明 token 下降。token、escalation、miss、false suppression、review rework、false-DONE、验证失败和成本必须联合报告，任何单项达标都不构成上线结论。

Seed 集必须同时包含 mandatory route 可达和只能经非-mandatory 机械/语义通道发现的约束，防止用确定性 routing 对测试集过拟合。任何 recall 只对预先标注、可重复的相关集成立，不得推广为对未知任务的总体保证。

## 11. 威胁模型与失败行为

必须覆盖：

| 威胁 | 必需行为 |
|---|---|
| 漏召回关键文档 | mandatory routing、混合召回、seeded recall 基准、CoverageAssessment 升级 |
| 规范与实际行为冲突 | information planes 分轨、questionType、deviation/finding，不静默覆盖 |
| memory poisoning | 非权威标记、schema 校验、来源和 promotion 审查 |
| 已失效 Playbook 继续显示 | active allowlist、status transition cache invalidation |
| 索引部分更新 | 临时构建、完整校验、原子切换 |
| digest/branch/worktree 过期 | main baseline + overlay、Context Snapshot、refresh 或 fail-closed |
| 当前约束被错误排除 | explicit supersession、false-suppression audit、notable exclusion |
| 文档冲突 | 输出 ConflictRecord 并升级，不任意选一份 |
| 超大单文档挤占预算 | 语义完整切片、任务/阶段拆分、明确升级；禁止把简单分批读取当成同一上下文 |
| 文档 prompt injection | authorization/trust filtering、检索层零执行、明确 provenance、可疑模式扫描；不宣称包装文本能从认知上彻底消除注入 |
| 路径穿越或 symlink 越界 | canonical root resolution 和路径策略校验 |
| 模型伪造读取/使用声明 | Fetch/Delivery/Usage 分层记录并声明各自证明边界 |
| embedding 排名漂移 | policy/model/version 记录和 deterministic replay |
| mandatory source 超预算 | shadow/advisory 记录 degraded；enforce 按批准规则阻止 assembly；所有模式禁止静默裁剪 |
| 跨仓库/租户信息泄漏 | retrieval 前 authorization、workspace/repository scope、敏感 metadata 脱敏和 retention policy |
| Context Pack 生成后的 TOCTOU | pinned snapshot、delivery digest 校验、pre-review freshness recheck |

索引或 retrieval 不可用时：

- 仍提供 L0 最小入口和 L1 实时事实；
- 明确标记 `context_degraded`；
- 普通任务可由人类显式选择来源后继续；
- 高风险任务在 shadow/advisory 标记 `context_degraded` 并给出恢复路径但不改变 lifecycle；只有 enforce 可按批准规则返回 `BLOCKED_CONTEXT_ASSEMBLY`；
- 不得静默声称文档覆盖完整。

## 12. 实施里程碑

### M0：基线与可证伪指标

M0 是 `PROPOSED_REMEDY`（E-13），不是已获批准的工作。若人类逐项批准，它只允许合同、观测、基线、标注和实验预注册，不批准 bounded retrieval 上线，也不改变模型输入或 lifecycle 行为。它拆成四个可独立批准、验收和回滚的候选交付物：

#### M0-A：Measurement Contract

- 冻结测量单位、分母、tokenizer、模型/version、warm/cold、并发和 channel coverage。
- 定义 fetch/materialized/injected、盲区、指标 schema、运行成本和威胁模型。
- Exit：合同通过审计；没有 runtime mutation；所有未知项显式列出。

#### M0-B：Passive Instrumentation

- 实现 Fetch observation、materialized/injected 区分、requestId/toolEventId 关联和 feature flag。
- 复用现有 event/store infrastructure，事件固定 `authority=non_authoritative`、`gateEvidence=false`。
- Exit：feature flag 关闭时模型输入、tool result、lifecycle、gate 和现有事件字节行为均不变；删除/回滚路径通过；负向 gate-consumption 测试通过。

#### M0-C：Benchmark Corpus

- 建立 1000 文档合成语料、真实任务 replay、seeded mandatory 和 non-mandatory constraints。
- 定义独立标注、adjudication、risk strata、route type 和污染检查。
- Exit：corpus self-check、隐藏 ground truth、重复构建 digest 和 blind holdout 通过。

#### M0-D：Evaluation Preregistration

- 冻结实验臂、样本量、配对/随机方法、模型参数、重复次数、置信区间、non-inferiority margin、停止条件和 no-overclaim 规则。
- 预注册 token/latency/cost 与 miss/false suppression/escalation/rework 的联合判定。
- Exit：protocol digest 冻结；在观察 powered outcome 前完成；缺统计功效时结论必须为 inconclusive。

### M1：Source Identity、Root Registry、Catalog Schema 与 Snapshot

M1 的缺口依据是 E-04/E-06/E-07；本节所有具体 schema 与算法仍是 `PROPOSED_REMEDY`。

- 冻结 SourceRef、docId、sectionId、revision、source/section digest、symlink 和 parser migration 语义。
- 建立 Context Root Registry。
- 建立 information plane、authority/status、部分 supersession、stable section ID、ACL 和 source digest schema。
- 建立 path、symbol、fact、topic 和 link 索引。
- 实现 main baseline + per-worktree overlay 和 Context Snapshot。
- 证明索引可以重建、原子更新、检测 stale/false suppression，并且不会跨 workspace 泄漏 metadata。

### M2：Shadow Retrieval 与 Fetch/Delivery 对账

- 不改变 LLM 实际输入，后台生成 Task Fingerprint、候选和 Context Pack。
- 比较候选结果与现有人工选择、review findings 和 ground truth。
- 消费 M0-B instrumentation，记录 Fetch/Delivery 对账、漏召回、误召回、按通道 recall、延迟、成本和索引 freshness。
- 默认只运行 lexical + path/symbol/link/process-fact；semantic provider 作为独立实验臂，不是必需依赖。

### M3：Bounded Advisory Mode

- 默认展示有界 Context Pack。
- 发现 coverage degraded、冲突或 stale 时建议升级。
- 暂不因预算或 manifest 阻塞 lifecycle。
- 保留人工扩大范围和读取指定来源的能力。
- Context Pack 只携带 Candidate Manifest 引用、汇总和 notable exclusions。

### M4：动态 Fingerprint、Coverage 与 Conflict Advisory

- 在 Initial、Pre-edit、Change-delta、Pre-validation 和 Pre-review checkpoint 重算 Fingerprint。
- 以 CoverageAssessment 驱动可解释升级。
- 机械检测 fact/supersession/digest/policy 冲突；自然语言冲突只产生 suspected advisory。
- Fetch/Delivery 记录继续只用于观测和实验，不成为 gate evidence。

### M5：A/B 与 Non-Inferiority 验证

M5 对应 E-08/E-12 的 `EXPERIMENT_NEEDED`，实验协议必须在查看 powered outcome 前冻结。

比较：

1. 全量或宽范围文档模式；
2. memory-only 模式；
3. bounded context 模式；
4. bounded context + risk escalation 模式。

测量 token、延迟、critical miss、false suppression、escalation、review findings、返工、false-DONE、已知缺陷复发、新型缺陷发现率和成本。memory-only 不是目标方案，而是用于验证“经验不能完全替代权威来源”的对照组。

没有达到预注册的质量 non-inferiority、召回、成本和安全条件时，不得进入 enforcement。

### M6：有限 Risk-Based Enforcement

M6 是 E-14 标记的 `HUMAN_DECISION` + `EXPERIMENT_NEEDED`，也是独立后续决策，不因本草案获批而自动获批。只有 M5 通过且人类批准具体机械落点、阻塞动作、恢复命令和回滚判据后，才对少数高风险类别试点；候选类别包括 process/gate fact、security/credential、migration/destructive operation 和 public contract/persistent schema。

Fetch/Delivery 不能成为通过条件；enforcement 只能阻止在 mandatory source 缺失、未授权、stale 或 assembly degraded 时继续组装上下文，不能把“内容已 delivery”解释为实现正确。

### M7：默认启用与回滚

运行模式：

```text
off → shadow → advisory → enforce
```

按 repository、风险类别和 host 逐步启用。M5 必须预注册自动/人工回退触发阈值、监测责任人和恢复命令；没有回退判据的 feature flag 不算可用回滚。Enforce 只能在 recall、false suppression、stale behavior、delivery instrumentation、安全降级和 non-inferiority 全部通过后启用。

## 13. Story 拆分建议

本节是 `PROPOSED_REMEDY`，不是已验证的最佳拆分。审计确认相应范围后，不建议用一个 Story 实现全部内容；候选拆分为：

1. M0-A Measurement Contract。
2. M0-B Passive Instrumentation。
3. M0-C Benchmark Corpus。
4. M0-D Evaluation Preregistration。
5. Source Identity、Root Registry、Catalog schema、worktree overlay 与 snapshot。
6. Task Fingerprint 的机械字段提取与 revision checkpoint。
7. 多路机械召回、deterministic replay 与 Candidate Manifest。
8. 语义完整 Context Pack、全局预算器和 Delivery Observer。
9. CoverageAssessment、风险升级和机械 conflict detector。
10. 1000 文档性能、召回、false suppression 和成本基准。
11. A/B、non-inferiority 与 rollout 控制。
12. 经独立决策批准后的有限 enforcement 接入。

每个 Story 必须有独立回滚点，避免把 retrieval、审计和 gate 一次性耦合。M0-A 至 M0-D 可分别批准，不因批准 M0-A 自动授权 M0-B/C/D。前七个 Story 保持合同、派生或观测层；advisory 和 rollout 使用 feature flag；enforcement Story 的前置条件必须显式指向独立批准的决策，不得由本拆分清单隐式授权。

## 14. 最终验收定义

只有同时满足以下条件，才能宣称优化可用：

- 1000+ 文档时正常任务不需要全量扫描。
- 文档 token、延迟和成本满足 M0 预注册阈值，且分母是可重放的真实现行流程。
- mandatory 与非-mandatory seeded constraints 满足 M0 预注册的分层 recall 和 non-inferiority 条件。
- Candidate、Fetch 与 Context Delivery 范围在声明的 channel coverage 内可以机械审计。
- memory 和 Playbook 始终保留非权威属性。
- 规范与实际行为分轨，发生 drift 时产生 deviation/finding 而不是静默覆盖。
- stale、部分 supersession、false suppression、冲突和 coverage degraded 都有明确行为。
- 高风险任务不能因预算而静默漏掉 mandatory source。
- bounded 模式通过预注册的质量 non-inferiority 检验，没有不可接受地增加缺陷、返工或 false-DONE。
- 索引失效、权限不足、delivery truncation 和 snapshot drift 时存在安全降级、结构化 blocker 和恢复路径。
- Context Pack、Catalog、Candidate/Fetch/Delivery Manifest 均不能满足任何 lifecycle gate，并有负向合同测试防回退。

## 15. 待审计决策

以下内容仍需人类明确确认，不能从本草案自动推导：

1. M0 校准后的全局输入预算、knowledge/document 分区和 generation/code/tool reserve。
2. SourceRef/docId/sectionId 的显式 ID 分配、rename/copy/branch/parser migration 和 digest 细节是否接受第 5.2 节初始规则。
3. 哪些 SourceRef 必须进入 bootstrap roots 和 conditional rules，以及 registry 的维护和变更审查责任。
4. 哪些风险类别进入 mandatory canonical coverage，以及可执行的 path/AST/registry 判定规则。
5. Catalog metadata 中哪些字段必须人工维护，哪些允许派生；false-suppression 抽样责任归谁。
6. Semantic retrieval 是否需要；若需要，采用本地还是外部 provider，以及费用、隐私和 replay 边界。
7. Catalog 重建触发、writer/lock 所有权、main baseline 与 worktree overlay 的生命周期。
8. Fetch/Delivery instrumentation 覆盖哪些 host/tool channel，如何声明 Bash/外部通道盲区。
9. Manifest 存放、保留期、访问控制、脱敏，以及复用 process events/Evidence Runtime 的具体 API。
10. 是否把 manifest digest 关联 reviewer run；该关联只能是 provenance，不能成为 gate evidence。
11. 标注集生产者、样本量、k 的定义、风险分层、抽样方法、置信区间和 non-inferiority margin。
12. retrieval degraded、mandatory missing、snapshot drift 时的人类 override、异步恢复命令和审计要求；lifecycle hard stop 仍属独立 policy。
13. 文档 prompt injection、external references、sensitive metadata 和跨 workspace retrieval 的独立安全策略。
14. M6 enforcement 的具体 assembly 阻塞规则、lifecycle policy 接口和回滚判据；它必须是后续独立决策。
15. ConflictRecord 的机械/LLM 生成边界，以及 suspected semantic conflict 的 reviewer 路由。

## 16. 相关现有决策

- `dev-memory.md`：dev-memory 是非权威经验，不是 gate evidence。
- `playbook-runtime-memory-consumption-execution-plan.md`：当前事实优先，memory/playbook 在入口自动消费但保持 advisory。
- `playbook-memory-entry-layer-optimization-plan.md`：索引、缓存、freshness 和有界 top hits。
- `proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md`：薄入口、canonical docs 和机械 registry 的目标权威图。
- `truth-source.md`：规范性决策文档继续承载“为什么”。
- `experience-layer-ablation-causal-validation-execution-plan.md`：memory 的效果必须通过受控实验验证，不能从可用性直接推导因果效果。
- `docs/evidence/evidence-platform-architecture.md`：Evidence Platform 拥有 artifact/ref/digest 和 evidence definition；context middleware 不建立平行 evidence registry。
- `global-lifecycle-control-plane-execution-plan.md`：Control Plane 是派生管理层，不是第二套 state machine；context assembly 不能自行拥有 lifecycle decision。
- `multi-host-keyword-candidate-spec-routing-execution-plan.md`：现有 shadow/warn/enforce 路由和 bounded candidate evidence 可作为 rollout 与候选审计的实现先例。
