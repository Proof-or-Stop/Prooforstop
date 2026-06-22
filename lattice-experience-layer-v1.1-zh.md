# Lattice Experience Layer：基于 Story 结局的可审计经验复用机制（v1.1 Implementation Draft，代码核对版）

> 版本：v1.1（在 v1.0 Implementation Draft 基础上，用真实 Lattice 代码映射 + 对抗校验 + ClawCreek 参考实现核对后修订；尚未实现验证）
> 读者：Lattice CLI / Runtime / Story Lifecycle 开发者
> 性质：技术方案 / 实现规格
> 核心原则不变：**Lattice 不让 Agent 自作聪明；Lattice 让过去发生过的、被验证过的证据，在下一次 review 时准时、可审计地出现。**
> 一句话定位不变：**Learning suggests. Human and gate decide.**

---

## 0. v1.1 修订说明（changelog —— 相对 v1.0 改了什么、为什么）

本版只改「与真实代码冲突 / 有确定性风险 / 重造已有轮子」的部分，方向与原则全部保留。

| # | 修订 | 原因（基于真实代码核对） |
|---|---|---|
| C1 | **砍掉 FTS** | v1.0 称「Lattice 已有 FTS 基础设施可复用」——**核对为假**：全仓无 SQLite/BM25/倒排索引，`story_list` 只是文件系统扫描 + enum 过滤。Level 2 召回改为「结构化字段过滤 + 复用现有 `story_list` 扫描路径」，**连派生 story-index 都先不建**（数据量没到需要索引的程度）。 |
| C2 | **大量复用已有设施，不并建** | `dev-memory.ts`(489 行) 已是 80% 的采集层；`decision-doc-promotion.ts` 已有 propose→save→reject + digest 完整性；`activity-log.ts` 已有 JSONL appender。v1.0 在重造这三个。改为：采集**扩展 dev-memory**；playbook 晋升**克隆 decision-doc 的 digest 范式**；日志**直接用 `appendActivityLog()`**。 |
| C3 | **堵 3 个确定性/解耦漏洞** | 见 §5.4、§7.1、§10.2：① `evidenceStrength`/`resolutionType`/`dismissReasonType` 必须 audit-only、**禁止任何 gate 读取**；② `finding-signals` 必须经 finding 子系统稳定端口 `store.readFindings` 读，**不得直接 parse `findings.json`**；③ reviewer hint 注入**不得进入 `promptHash` 域**（`reviewRunId` 签名含 promptHash，否则破坏 run 绑定可复现性）。 |
| C4 | **改「第一个 story」** | v1.0 的 Phase 0「先注册路径 + 空骨架」**不可验证**（gate-exclusion 的 smoke 只是字符串匹配空转）。改为 **Phase 1a 垂直切片**：真正派生并写出 cache + 同 story 注册 registry 项，用「写 cache 后 `currentMaterialHash()` 不变」的**真实行为测试**证明 gate-safety。见 §17。 |
| C5 | **back-compat 收口** | `finding_dismiss` 的 `dismissReasonType` 必须 **optional**（设为 required 会一上线就破坏所有现有调用方）；新命令一律用**扁平下划线名**（`learning_scan`/`playbook_propose`），多词形式要改 aliasMap，违背纯增量。 |
| C6 | **模块收敛 + digest 抽取** | 模块从 v1.0 隐含的 7 个收敛为 **4 core + 2 handler**（signature 查找先并入 `learning-store`，第二个消费者出现前不独立）；Phase 2 前先把 canonical-JSON-digest 从 `decision-doc-promotion.ts` 抽成叶子 `core/digest.ts`（小重构 story），避免 handler→handler import。 |

ClawCreek 参考结论（佐证方向）：ClawCreek 的 playbook 系统用 embedding 召回、LLM 生成/判定、自动 deactivate、A/B serving —— 因为它是多租户 SaaS 摊得起成本。本方案**正确地砍掉了这些**（FTS-first、无 RL、人审 staged、不自动判定），与 Lattice 的确定性/CLI-first/host-neutral 性质一致。

---

## 1. 一句话结论（不变）

Lattice 引入 **Experience Layer**：把历史 story 的 `findings`+结局、`decision.json`、`checklist.json`、`activity.jsonl` 等结构化数据，沉淀成**可审计、可回滚、可解释**的 **review hints** 和 **process playbooks**。

它**不让** Agent 自动改 gate / 自动 finding / 自动 resolve。定位：**Evidence-backed Review Playbooks for Lattice** —— 基于真实 story 结局，把复发问题、常见误报、历史决策与踩坑，在下一次 Plan / Review / Session Brief 中提示给人类和 reviewer。

---

## 2. 为什么需要（不变，略）

Lattice 已有大量带结局的结构化数据（findings / checklist / decision / background / activity / 跨项目 footprint），但只服务当前 story、没跨 story 复用。Lattice 相对普通 agent memory 的独特优势：它知道某问题在哪个 story 出现过、reviewer 当时怎么判、最终 resolved/dismissed/accepted-risk、过没过 gate、有没有返工/rollback。

---

## 3. 设计原则（不变）

1. **只提示，不判定。** 只能影响 reviewer prompt / PLAN 先例 / session brief / checklist 建议；**不能**自动 `finding_add`/`finding_resolve`/改 gate/改 story 状态/改 checklist 强制项/自动 merge/rollback/approve。
2. **可解释、可溯源、可回滚。** 每个 hint/playbook 必带 lineage（`sourceStoryId/sourceFindingId/sourceDecisionId?/createdAt/createdBy/status/signalScore/support/lastSeen/usageCount/resolvedHits/dismissedHits`）。无 lineage 不进 active。
3. **先本地、后跨项目；先结构化、后 embedding。**（v1.1 进一步：**v1.0 连 FTS 都不做**，纯结构化字段。）
4. **失败→恢复是一等学习素材。**
5. **命名纪律。** 用 `Experience Layer`/`Evidence-backed Review Playbooks`/`Workflow Memory`；不用 `Self-learning Agent` 等。

---

## 4. 借鉴 Hermes / ClawCreek —— 取什么、不取什么（核对后）

保留 v1.0 的取舍表（取：playbook 结构、staged approval、生命周期形状、progressive disclosure；不取：DSPy+GEPA/RL、默认 agent-managed 写入、每条 5+ 命令链自动建 skill）。

**v1.1 补充（ClawCreek 实测）**：ClawCreek 的召回=embedding、生成=LLM、判定=Haiku LLM 且**自动 deactivate**、有 **A/B serving**、晋升逻辑**只是设计稿未实现**。这些**一律不取**（与确定性/CLI 成本可见性冲突）；只取其「按职责分模块」「lineage / source_experience_ids」「隐私聚合只存结构维度」三点形状。

---

## 5. Phase 0：finding outcome schema 修正（核对后）

### 5.1 扩展 finding outcome schema（字段名与真实 `types.ts` 对齐）

真实 `Finding`（`packages/main/src/core/types.ts:526-580`）已有 `status: 'open'|'resolved'|'dismissed'`、`evidenceState`、`resolvedReason?`、`dismissReason?` 等。本层**追加**（全部 optional、additive，沿用现有 `evidenceState` 校验范式 `finding.ts:112-162`）：

```jsonc
// finding_resolve 追加
{ "resolutionType": "fixed | duplicate | superseded | accepted_risk | partially_mitigated", // optional
  "resolveEvidenceStrength": "strong | medium | weak" }                                     // optional

// finding_dismiss 追加
{ "dismissReasonType": "false_positive | out_of_scope | duplicate | wontfix | unclear | already_covered", // ★ optional（C5：绝不设 required）
  "dismissEvidenceStrength": "strong | medium | weak" }                                                    // optional
```

> **C3/C5 修订**：① `evidenceStrength` 不再是「挂在最后那个动作上的单字段」，**拆成 `resolveEvidenceStrength` / `dismissEvidenceStrength`** 两个独立字段，避免 last-write-wins 语义。② `dismissReasonType` **必须 optional**。

### 5.2 signatureTag（finding 时结构化捕获，不变）

`finding_add` 增可选 `signatureTag`（短、稳定的模式键）。签名由结构化字段组合：

```text
localSignature = category + signatureTag + fileKind + lifecyclePhase
```

零 NLP、可确定、lineage 干净。没填 `signatureTag` → 退化为 `category+fileKind` 粗聚合，不进 hint、不污染。

### 5.3 Signature Registry（不变，但归入 learning-store）

`.lattice/learning/signature-registry.json`（tags + aliases + status + mergedInto；propose 可由 Agent，active 需 human approve）。**C6 修订**：第一版**不单独成模块**，其读写并入 `core/learning-store.ts`，等出现第二个消费者再抽出。

### 5.4 ★ 确定性铁律（C3-H1，新增）

`signatureTag` / `resolutionType` / `dismissReasonType` / `resolveEvidenceStrength` / `dismissEvidenceStrength` **全部 audit-only**：
- 在 `types.ts` 注释中明确标注 `// audit-only — MUST NOT be read by any gate`（与现有 `signatureTag` 同级）。
- **不进 finding 签名域**（`finding-verify.ts` 不变，passthrough）。
- **禁止 `advisory.ts` / 任何 gate 逻辑读取**它们做 confidence 加权。gate 行为不受 learning 任何字段影响。

> 真实 gate 消费点 `advisory.ts:isEvidenceStateBlocking` 仅看 `evidenceState='verified'`；新字段**不得**进入此判断。

---

## 6. 总体架构（模块拆分，C6 收敛版）

四层语义不变（L1 Finding Signals / L2 Story Recall / L3 Process Playbooks / L4 Cross-project 未来）。

**模块拆分（落到真实目录，usage-ledger 风格：handler→core→types 单向向内，现有代码零 import 本层）：**

| 模块 | 职责 | 新建/改 | 耦合 |
|---|---|---|---|
| `core/experience-layer-types.ts` | 全部类型（叶子） | 新建 | 无 |
| `core/learning-store.ts`（含 signature 查找/dedup） | 读写 `.lattice/learning/*`（source-of-truth + derived cache） | 新建 | →types |
| `core/finding-signals.ts` | 从 findings 派生 `finding-signals.json`（只读，derived） | 新建 | →store；**经 finding 端口读** |
| `core/experience-hint-loader.ts` | top-N hint 排序/过滤/progressive disclosure | 新建 | →store（只读） |
| `handlers/learning.ts` | `learning_scan` / `learning_hints` / `learning_signals_*` | 新建 | →core |
| `handlers/playbook.ts` | `playbook_propose/diff/approve/reject` / `recall` | 新建 | →core |

**必须改的现有代码（surgical + additive）：**
- `cli-engine.ts` MAIN_TOOLS：追加 ToolDef（只扩数组，不动 dispatch）。
- `registry.ts`：每个新 handler group 一行 `registerBatch()`。
- `runtime-artifact-registry.ts`：**一条**新条目，把 `finding-signals.json` + `learning-log.jsonl` 注册为 `materialHash:'exclude', volatile:true`（**gate-safety 杠杆，不可省**）。
- `story-review.ts`（约 589-598）：在 base focus guidance 后注入一段 `hintSection`，镜像现有 advisory-only 的 `grillSection`。
- `types.ts` 的 `Finding`：§5.1 的 audit-only 字段；以及（**可推迟**）citation 用的 `playbookIds?: string[]`。

**明确不碰**：`advisory.ts` / `finding-verify.ts` / `review-run.ts` gate 逻辑 / `evidence-freshness.ts` / `scope-contract.ts`（注册 registry 后这些自动排除 learning 文件，零 gate 逻辑改动）。

**复用而非重建（C2）：**
- 采集：**扩展 `dev-memory.ts`**（加 `status: candidate→active→stale→archived` + `promotionHistory`），不并建新存储。
- 晋升 digest：**克隆 `decision-doc-promotion.ts`** 的 `proposalDigest = SHA256(canonical-JSON − digest/saves)` + `sourceDigest` 新鲜度绑定 + `assertTargetInScope`。
- JSONL：复用 `activity-log.ts` 的 `appendActivityLog()`。
- grill：`grill_get` 只读作为 playbook **输入**，不建平行会话生命周期。

**语义铁律：`Story lifecycle remains deterministic. Experience Layer remains advisory.`**

---

## 7. Level 1：Finding Signals

目标/机制不变（按 §5.2 `localSignature` 聚合 resolved/dismissed/falsePositive/... 计数）。

### 7.1 ★ 数据源经端口读（C3-H2，新增铁律）

`finding-signals.ts` **必须**通过 finding 子系统导出的稳定访问器读取（真实为 `store.readFindings(storyId)`，`store.ts:359-365`），**不得直接 `JSON.parse('.../findings.json')`**。原因：`findings.json` 受 finding 子系统 + lifecycle-registry 白名单 + main-write-lock(`finding.ts:68-79`) 管辖；直接 parse 会把本层耦合到磁盘格式，格式一改即静默崩，且不符合「零向外耦合」标准。把「read-through-a-port」写进 Phase 1a story 的不变量。

**数据模型** `.lattice/learning/finding-signals.json`：derived cache（schemaVersion / signals[] / 各计数 / signalScore / support / exampleStoryIds…）。

> **derived cache**：可由 finding outcome 记录 + `learning-log.jsonl` 重建。Source of truth = story 文件 / finding outcome / playbook proposals / `learning-log.jsonl`。冲突时直接重建。

**signalScore（保守、可解释，非统计置信度，不变）：**

```text
positive    = fixed_resolved + partially_mitigated*0.5
negative    = false_positive_dismissed
ignored     = unclear + out_of_scope + duplicate + already_covered   # 不参与 promote/demote
signalScore = positive / (positive + negative + 1)
support     = positive + negative                                    # 必须与分数一起展示
priority    = signalScore * log(1+support) * recencyBoost
门槛：resolvedCount>=2 才成 hint；signalScore>=0.65 才进 reviewer prompt；
      signalScore<0.45 且 falsePositive 高 → 标 common_false_positive
```

**CLI（扁平下划线，C5）**：`learning_scan` / `learning_hints --story <id>` / `learning_signals_list` / `learning_signals_explain <localSignature>`（第一版只必做前两个）。

---

## 8. Level 2：Story Recall（C1：砍 FTS）

目标不变（开新 story / PLAN / REVIEW / session brief 时召回相似历史 story）。

**C1 修订**：**v1.0 不做 FTS、也不建派生 story-index**。召回 = **结构化字段过滤**（tags / fileKinds / touchpoints / storyType / phase / riskSignal）**+ 复用现有 `story_list` 文件系统扫描路径**。只有当 story 数量大到扫描变慢、且有实测性能依据时，才考虑建派生索引（届时独立 story）。embedding 更是后续可选增强。

**CLI**：`recall --story <id>` / `recall --query "..." [--top 5]`（基于结构化匹配，非全文检索）。

---

## 9. Level 3：Process Playbooks

流程不变（resolved finding → propose → staged → human diff → approve as candidate → 多次命中 → propose promotion → human approve active；生命周期 `proposed→candidate→active→stale→archived`，archive 可 restore）。

**C2/C6 修订**：
- `playbook_propose/diff/approve/reject` **克隆 `decision-doc-promotion.ts` 的 digest 完整性范式**，不发明新方案。
- **Phase 2 前先做一个小重构 story**：把 canonical-JSON-digest helper 从 `decision-doc-promotion.ts`（551 行 handler）抽成叶子 `core/digest.ts`，供 decision-doc 与 playbook 共同 import，**避免 `handlers/playbook.ts` → `handlers/decision-doc-promotion.ts` 的 handler→handler import**（解耦违规）。
- playbook **生命周期状态扩展进 dev-memory** 时（C2）：`status`/`promotionHistory` **必须排除在 dev-memory 的 id-hash 域之外**（dev-memory 条目按 content 的 sha7 定 id；把可变状态纳入会破坏 dedup/幂等）。晋升写**旁路 index**，不重写 append-only JSONL 行。

数据模型 `.lattice/learning/playbooks.json`（后续可选 `PLAYBOOK.md`）；字段含 `trigger/check/pitfalls/verification/lineage/usage`（不变）。

**护栏**：playbook 永不自动 `finding_add`，只改 reviewer prompt「该看什么」；lineage 必须可溯源。

---

## 10. Review Prompt 注入策略

注入三类（recurring true issues / common false positives / 匹配 touchpoints 的 active playbook）+ Top-N + progressive disclosure（≤3 recurring + 2 false-positive + 3 active + 1 candidate；先摘要、命中再展开）。

注入点：`story-review.ts` 的 `hintSection`，镜像现有 `grillSection`（已证明 advisory-only 注入可行）。

### 10.1 格式示例（不变，略）

```text
Project experience hints (advisory only):
1. [Recurring issue] ... score 0.86 · support 4 fixed / 0 false-positive  Source: B-b315/F-102
2. [Common false positive] ... support 0 fixed / 5 false-positive
```

### 10.2 ★ hint 不进 promptHash 域（C3-M2，新增铁律）

真实 `reviewRunId` 签名**包含 `promptHash`**。若把 `hintSection` 拼进 `_reviewPrompt` 且其参与 promptHash，则 learning-derived、随 dev-memory 增长而变的 hint 会让「同样代码/material 产生不同 reviewRunId 绑定」，破坏 run 绑定的可复现与 freshness/replay 等值。

**解法（二选一，Phase 1.5 story 必须明确选定）**：
- (A) hint 作为**独立的、不参与 hash 的 advisory 通道**注入（不进入 promptHash 计算域）；或
- (B) 按 `reviewRunId` **快照固定** hint 集合，使该 run 的 promptHash 稳定。

推荐 (A)。无论哪种，禁止让累积学习改变 gate-adjacent 的确定性输入。

### 10.3 Learning Usage Tracking（不变，复用 activity-log）

`surfacedCount/resolvedHits/dismissedHits` 必须可审计：hint/playbook 被注入时写 `experience_hint_surfaced`，reviewer filing finding 引用 playbook 时写 `experience_hint_used`（经 §6 的 `playbookIds` citation，**可推迟到用量证明需要时再加该字段**）。统一用 `appendActivityLog()` 写入；signals 为 derived，可从这些事件 + finding outcome 重建。

---

## 11. Level 4：跨项目聚合（未来，第一版不做，不变）

双层签名 `localSignature`（含项目内部词，只留本地）/ `publicSignature`（泛化后，只含 category+fileKind+lifecyclePhase+统计桶，无代码/路径/内容/内部词）。路线 A 单项目 → B org-local → C cloud opt-in → D 平台 starter playbooks。**不从 A 直跳 D。**

---

## 12. 与现有生命周期的关系（不变，略）

`story_create` 召回先例；`decision_set` 提示相似决策；`story_review` 注入 hints（写 `experience_hint_surfaced`）；`finding_add` 捕获 signatureTag；`finding_resolve/dismiss` 记录富化 outcome；**`gate` 不受 learning 影响**；`done` 更新 derived；`rollback` 标记相关 signals 风险升高。

---

## 13–16（host-neutral 叙事 / 成功指标 / 风险缓解 / 不要做什么：保留 v1.0，要点）

- **不要**自动 finding/resolve/改 gate/改强制 checklist/merge/rollback/approve；不要把 dismissed 当误报、resolved 当真问题、unclear 当负反馈。
- **不要**第一版做 FTS / 跨项目 / embedding / 自动晋升 / DSPy-GEPA-RL / LLM curator pass。
- **不要**让 Agent 直接写 active playbook；signalScore 必带 support。
- 尤其**不要**说「Lattice 会自我变聪明」；要说：reuses evidence from completed stories / turns verified experience into review-time hints / makes workflow memory auditable。

---

## 17. 推荐开发路线（C4：改了第一个 story 与排序）

全部走 **Lattice story workflow**（每个 coherent slice 一个 story）。

```text
★ 第一个 story = Phase 1a 垂直切片（最小可真验证）
   core/experience-layer-types.ts + core/learning-store.ts（最小）+ core/finding-signals.ts
   （经 store.readFindings 端口读，§7.1）真正派生并写出 finding-signals.json
   + 同一 story 注册 runtime-artifact-registry（materialHash:exclude, volatile）
   验收（真实行为测试，非字符串空转）：写完 cache 后 currentMaterialHash() 不变；
   零跨模块向外 import；gate/evidence 不见 learning 文件。                       粗估：小

Phase 1b  finding 结构化 enum（独立、自包含）：resolutionType / dismissReasonType(optional) /
          resolve|dismissEvidenceStrength + signatureTag + signature-registry（并入 learning-store）；
          全 audit-only、禁止 gate 读（§5.4）；migration 兼容旧 finding。         粗估：小

Phase 1.5 Advisory hint 注入：experience-hint-loader + story-review.ts hintSection；
          ★ 明确选定 hint 不进 promptHash 的方案（§10.2）。                       粗估：小（高 ROI）

（Phase 2 前）小重构 story：抽 core/digest.ts（§9）。                            粗估：很小

Phase 2   Playbook 生命周期 + handlers/playbook.ts（克隆 decision-doc digest）+
          dev-memory status/promotionHistory（排除 id-hash 域，旁路 index）。      粗估：中

Phase 3   Story Recall（L2）：结构化过滤 + 复用 story_list 扫描，★ 不建 FTS、不建派生索引。 粗估：中

Phase 4   org-local / 跨项目匿名聚合（local/public 双层签名）。                  粗估：中-大
```

**先做 ★第一个 + 1b + 1.5**（数据现成、低耦合、立刻让 reviewer 更准、修了脏数据假设、签名从源头稳、gate-safety 用真实测试锁死）。验证有价值再推 2+。

---

## 18. 最小落地版本（文件结构 + CLI）

```text
.lattice/learning/
  signature-registry.json     # source of truth（并入 learning-store 读写）
  playbooks.json              # source of truth
  proposals/<proposalId>.json # source of truth（staged）
  learning-log.jsonl          # source of truth（usage/outcome 事件，appendActivityLog 写）
  finding-signals.json        # DERIVED CACHE（materialHash:exclude），可重建
# 不做：index.sqlite / story-index.json（C1 砍）
```

```bash
# 最小 CLI（扁平下划线，staged 完整闭环）
learning_scan                       # 从 findings(经端口) + learning-log 重建 signals（derived）
learning_hints --story <storyId>    # 为当前 story 输出 review hints

playbook_propose --finding <id>     # 一条 finding → staged proposal
playbook_diff <proposalId>          # 看将写入什么
playbook_approve <proposalId>       # 人审批准 → candidate
playbook_reject <proposalId>        # 人审拒绝
```

---

## 19. 最终建议（一句话，不变）

> Lattice 不需要一个「越来越自信的 Agent」，而应做一个「**越来越少重复踩坑的生命周期系统**」。
> 切入：**先做 finding outcome signals（含 signatureTag + registry），再做 staged playbook proposal**。
> 边界：**只提示不判定；只 surface 不自动 gate；signalScore 必带 support；所有经验有 lineage、可 diff、可回滚；FTS/embedding/RL/跨项目 v1 不碰；audit 字段禁入 gate；hint 不进 promptHash；derived 文件 materialHash 排除。**

---

## 附录 A：Reviewer Prompt 模板（不变）

```text
You are reviewing this Lattice story.
Use the following project experience hints as advisory context ONLY.
Do not automatically file findings from these hints.
Only file a finding if you can verify it in the current story evidence.

Project Experience Hints:
{{experience_hints}}

Rules:
- Treat recurring-issue hints as areas to inspect, not conclusions.
- Treat common-false-positive hints as warnings to verify carefully before filing.
- If a playbook applies, cite its id in your reasoning (so usage can be tracked).
- Any finding must still include current-story evidence.
```

## 附录 B：真实代码锚点（核对依据）

| 关注点 | 文件:行 |
|---|---|
| Finding 类型 | `packages/main/src/core/types.ts:526-580` |
| finding_add/resolve/dismiss | `packages/main/src/handlers/finding.ts:217-444` |
| finding 校验范式（可复用） | `finding.ts:112-162` |
| finding 签名（passthrough 不变） | `core/finding-verify.ts` |
| gate 消费（仅 verified 阻塞） | `core/advisory.ts:isEvidenceStateBlocking 43-46` |
| findings 端口（必经此读） | `core/store.ts:readFindings 359-365` |
| derived 排除机制 | `core/evidence-freshness.ts:isMaterialExcludedPath 46-48` + `scope-contract.ts:292` |
| 已验证排除范例 | `tasks/usage-ledger-smoke.ts:544` |
| 采集层（应扩展） | `core/dev-memory.ts`（489 行，content sha7 id） |
| digest 范式（应克隆/抽取） | `handlers/decision-doc-promotion.ts` |
| JSONL appender（应复用） | `core/activity-log.ts:appendActivityLog` |
| hint 注入点（镜像 grillSection） | `handlers/story-review.ts:~589-598` |
| CLI 注册 / aliasMap | `cli-engine.ts`（MAIN_TOOLS；aliasMap 3727-3811）/ `registry.ts` |
| artifact 分类 | `core/runtime-artifact-registry.ts` |

## 附录 C：ClawCreek / Hermes 参考（核对版）

- ClawCreek 主检出：`/Users/jek/Documents/ClawCreek/clawcreek/backend/core/{playbook.py, memory.py, playbook_judge.py, playbook_seeds.py}` + `docs/playbook-evolution-design-zh.md`（§3.4 隐私聚合=只存结构维度）。
- 实测：召回=embedding(`recall_playbook` 639-744)、A/B routing(`pick_candidate_for` 198-283)、演绎蒸馏=LLM(`modules/playbook_deductive.py`)、判定=Haiku(`playbook_judge.py`)+自动 deactivate；晋升逻辑设计稿未实现。**本方案一律不取这些重型/LLM/自动判定部分**，只取「按职责分模块 / source lineage / 结构维度聚合」三点形状。
- Hermes：skills / curator / write_approval（取 staged，弃默认 agent-managed）/ self-evolution（不取）。
