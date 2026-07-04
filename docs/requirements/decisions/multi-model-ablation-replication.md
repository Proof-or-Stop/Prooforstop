# Multi-Model Ablation Replication — 预注册实验协议

**协议版本**: v1.0-draft（冻结后修改记 amendment）
**协议哈希**: 冻结时 SHA256 写入 `experiments/multi-model-ablation/protocol.lock.json`
**对应论文缺口**: §5.2 / Table 9（9,240 格全部单一 Sonnet executor + Claude reviewer）、§11 "self-built/self-reviewed"、§12 "multi-model generalization … future extensions"、摘要 "limited to one model family and 24 tasks"
**目标产出**: 回答两个问题——(Q1) +1.6pp / 31→2 的效应是控制层的性质还是 Sonnet 的性质；(Q2) 同厂商 reviewer（Claude 审 Claude）是否使 v1 低估了真实放大率
**执行分类**: research / paper-evidence campaign。它不是当前 Proofbound CLI correctness blocker，不是默认 story gate，也不应被接入 DONE / playbook activation / production runtime guidance。

## 0. 执行边界与采纳原则

本协议只在需要支撑论文或公开材料中的 **multi-model generalization** claim 时启动。它的价值是补强研究证据，而不是优化 Proofbound 的日常开发流程；因此不得因为"看起来更完整"而默认执行。

**默认采纳范围**: 先做 M0 spike（E2 harness 工具面等价性、A2′ 预算机制、分析脚本复核）。只有 M0 证明工具面等价且论文 wording 确实需要升级时，才进入阶段 1；阶段 2 必须有单独的成本预算、协议冻结和启动记录。

**非目标**:

- 不用于解锁当前 CLI DONE、review、validate、playbook 或 runtime memory gate。
- 不把实验结果直接写入 active playbook、DONE evidence、production proof 或默认 agent guidance。
- 不证明所有模型/所有 host 都等价；只证明本协议内记录的 dated provider snapshot 与工具面条件。

**研究数据隔离**: 所有记录、分析、lock 文件应落在 `experiments/multi-model-ablation/`，并标注为 research evidence。若未来要进入产品策略或 playbook，必须另走 source lineage / dedup / exposure / structured outcome 流程，不能把本实验结论直接当 runtime 规则。

### 0.1 执行顺序（结构化启动）

| 顺序 | 阶段 | 内容 | 目的 |
|---|---|---|---|
| 1 | M0 | 选定 E1/E2 model family；验证工具面等价、prompt 等价、A2′ 预算机制、分析脚本 | 先证明实验可以公平运行 |
| 2 | M1 | 冻结协议、dated model snapshots、随机种子、cell matrix、预算规则 | 防止事后改设计或追结果改口径 |
| 3 | M2-a | 先跑 ③ E2 A4×R-same 校准格，锁定 A2′ 预算，再跑 ⑥ E2 A2′ | 回答 Q1: 第二模型家族内是否复现 A4 vs A2′ 效应，且避免预算事后口径 |
| 4 | M2-b | 跑 ② E1 executor + E2 reviewer A4×R-cross，并按 §3.2 的窗口混淆警告标注 | 回答 Q2 的 E1 描述性方向；confirmatory 需要同窗 ① |
| 5 | M2-c optional | 预算允许时跑 ④ E2 executor + E1 reviewer A4×R-cross | 提前获得 Q2 的 E2 对称方向 |
| 6 | M3 | 根据 Phase 1 与预算判断是否启动 Phase 2 | 避免盲目烧预算 |
| 7 | M4 | 完整 powered 2×2 + E1 同窗重跑 | 支撑强论文 claim |
| 8 | M5 | 独立复算和审计 | 防止分析脚本、分母、cellKey 或窗口处理错误 |
| 9 | M6 | 更新论文 wording guard | 只写数据真正支持的 claim |

### 0.2 模型、Host 与并行验证约束

- **E1/E2 必须是不同 provider family**: E1 可为 Claude / Anthropic；E2 必须是非 Claude 家族，例如 OpenAI / GPT 系或其他非 Anthropic provider snapshot。Claude Opus vs Claude Sonnet 不构成 E2。
- **Host 与 model 必须分开记录**: Codex CLI / Claude Code CLI 是 host 或 adapter；OpenAI/GPT-family snapshot 与 Claude/Sonnet snapshot 是 model family。不得把 "Codex CLI host" 直接当作 "E2 model family" 的实验结果。
- **E2 runner 不限于 Codex App/CLI**: Codex App 与 Codex CLI 是推荐 E2 hosts，但不是唯一合法 host。自建 harness、CI runner 或其他 host 也可以产生 E2 数据，前提是它们实际调用 locked OpenAI/GPT-family 或其他非 Anthropic E2 model snapshot，并提供等价 tool surface、prompt digest、budget lock 与 cell records。
- **Host 不能替代 provider 证明**: 使用 Codex CLI 但调用了 Claude-family model，不能算 E2；使用非 Codex host 但调用 locked OpenAI/GPT-family snapshot，且满足本协议记录要求，可以算 E2。实验判定按 `executorSnapshot` / `reviewerSnapshot`，不是按 app 名称。
- **每个 cell 必须锁定 dated snapshot**: 记录 executorSnapshot 与 reviewerSnapshot；运行中 provider fallback、模型换代或 snapshot 缺失时，相关 cell 必须 void 或 amendment。
- **same reviewer = 同厂商 fresh context，不是同一会话自审**: ① 与 ③ 必须使用独立 session/context 的 reviewer。
- **cross reviewer 只能改变 reviewer，不改变 executor**: ① vs ② 固定 E1 executor；③ vs ④ 固定 E2 executor。② vs ④ 不得作为主读数。
- **工具面、prompt、budget 与运行参数必须等价**: prompt 同源，仅允许 API 格式最小适配；工具能力、temperature、retry、timeout、max tokens 必须记录并尽量固定；A2′ 预算按 executor family 单独校准。
- **Codex CLI 并行验证边界**: Codex CLI 可以并行做只读协议审计、cell-matrix 检查、分析计划复核和文档一致性验证，以加快 M0/M1；但除非它被正式配置为某个 locked executor/reviewer cell 并记录 snapshot、toolSurface 与 budget，否则它的输出不能计入 multi-model experiment records。

### 0.3 并行 Runner 数据纳入规则

Codex CLI、本地 Codex、Claude Code CLI 或其他 host 可以并行产生实验数据；这些数据可以计入 multi-model ablation 结果，但必须在运行前满足以下条件。否则只能作为 protocol audit / operational note，不能写入 outcome records。

**可计入结果的条件**:

- 运行前存在 frozen `cell-manifest.json`，明确每个 runner 负责的 `cellKey = arm|task|scenario|repeat|executorFamily|reviewerFamily`。
- runner 被预注册为实验 runner，并记录 `hostId`, `hostKind`, `executorSnapshot`, `reviewerSnapshot`, `toolSurfaceDigest`, `promptDigest`, `budgetLockDigest`。
- runner 实际执行协议内的 formal cells，例如 ③ E2 A4×R-same、⑥ E2 A2′、④ E2 executor + E1 reviewer；只读审计、文档 review、分析建议不产生 ablation outcome。
- 输出必须进入统一 `records-multi-model-ablation.jsonl`，包含标准 `outcome = recovered|amplified|safe-stop|false-stop`、void 规则、cellKey 去重键和 snapshot 字段。
- A2′ cells 只能在对应 executor×task 的 A4 budget lock 写入后运行；任何 runner 不得先跑 A2′ 再回填 budget。
- 同一 `cellKey` 不得由多个 runner 重复后择优；若发生重复，必须按预注册 duplicate policy 处理，不能选择更好看的结果。

**不能计入结果的情况**:

- Codex CLI 只是审计本文档或检查分析计划。
- runner 没有 locked model snapshot、缺 tool surface digest、缺 prompt digest 或缺 budget lock。
- host 被误当作 model family，例如把 "Codex CLI" 本身当作 E2，而没有记录实际 OpenAI/GPT-family snapshot。
- provider fallback、模型换代、限流或外部故障使 cell 不满足 §3.4 validity filters；该 cell 必须 void、重跑或 amendment。

**推荐分工**: 一个 host 负责 protocol management / audit / analysis recompute；一个或多个实验 runner 按 `cell-manifest.json` 并行跑 formal cells。并行只缩短 wall-clock，不改变随机种子、cell matrix、预算规则或 claim boundary。

---

## 1. 背景

### 1.1 v1 结果中依赖单一模型的部分（本协议的复验对象）

| v1 结果 | 数据 | 模型依赖 |
|---|---|---|
| Table 9 powered ablation | H1 +1.6pp [0.8,2.5]；A4 2/1800 vs A2′ 31/1800 | executor=Sonnet，A3/A4 reviewer=Claude（同厂商） |
| §6 注入 pilot | A2′ amplified 15/15；A4-C safe-stop 15/15；A4b-B recovered 15/15 | 同上 |
| Table 10 clean-task pilot | 2.07× 成本 / 2.51× 时延开销 | 同上 |

**不复验**: Tier-A 引擎合约、B-4c65 篡改矩阵、gate 谓词（确定性代码，与模型无关）；565 语料（观察性）。

### 1.2 v1 自己提供的盲区证据（Q2 的动机）

§8 记录: B-4c65 中四个 Claude lane 只报 low/medium，Codex host-2 抓到 critical 签名绕过；B-7b6e 中 8 个 finding 有 6 个为 Codex 独家。即消融实验的 A4 review gate 使用了论文自己证明会漏关键缺陷的同厂商配置——A4 的 2/1800 方向未知地有偏。

---

## 2. 预注册假设

设 `NA(arm)` = not-amplified 率（B1–B15 注入格上，v1 定义不变）。

**Confirmatory**

- **H-M1（方向复现）**: 在第二 executor 家族 E2 的同厂商 fresh-context reviewer 条件下，NA(A4) − NA(A2′) > 0，seeded cluster bootstrap 95% CI 排除 0。
  - 这是最低要求: 效应方向在第二家族成立。该对比必须使用 E2 executor + E2 reviewer 的 A4 格对 E2 A2′，以复现 v1 的"同模型家族、独立会话审查"结构；不得用跨厂商 reviewer 格替代，否则 executor 与 reviewer 两个因子同时变化。
- **H-M2（效应×executor 交互，异质性）**: GLMM 中 `arm × executorFamily` 交互项。预注册解读:
  - 交互不显著且两家族点估计同向 → "效应不依赖单一模型家族"（论文可写 model-agnostic 的实证支持）；
  - 交互显著但同向 → "效应普适、量级模型相关"（如实报告量级带）；
  - E2 上效应消失或反向 → H-M1 失败，论文 model-agnostic 措辞必须收缩为 "demonstrated on one family"（wording guard 联动）。
- **H-M3（reviewer 厂商效应）**: 固定 executor，比较 A4 在 {同厂商 reviewer, 跨厂商 reviewer} 下的 amplified 数。预注册方向: 跨厂商 reviewer 的 amplified ≤ 同厂商（基于 §8 盲区证据）。放大是稀有事件，主报告为 amplified 计数 + 差值 CI；若事件数不足以显著，如实报告为 underpowered 方向性证据。主分析必须分别做 E1 固定 executor 与 E2 固定 executor 的配对比较，再汇总解释；不得直接比较两个交叉格。

**Exploratory（单一 BH FDR 族，α=0.05，对齐 v1 纪律）**

- per-scenario (B1–B15) 差异、clean-task 成本阶梯在 E2 上的形状、H3 类比（A4 vs A3）。

---

## 3. 设计

### 3.1 因子矩阵

| 因子 | 水平 | 说明 |
|---|---|---|
| executorFamily | E1 = Claude Sonnet（**dated snapshot**，尽量取 v1 同代）；E2 = 第二厂商（如 GPT/Codex 系，dated snapshot） | E3（第三家族）可选扩展，不进 confirmatory |
| reviewerFamily | R-same（与 executor 同厂商）；R-cross（不同厂商）；not_applicable | R-same/R-cross 仅作用于 A3/A4；A1/A2/A2′ 的 reviewerFamily 必须写 `not_applicable` |
| arm | A2′、A3、A4（A2 作 reference 臂随跑，A1 砍掉——v1 中仅为参考且有 16 个边缘格问题） | 定义、预算规则、注入逻辑与 v1 附录 A 逐字一致 |
| task | v1 的 24 stratified tasks，**不改动** | 改任务会破坏与 Table 9 的可比性 |
| scenario | null + B1–B15，per-arm applicability 沿用 v1 | |
| k | 阶段 1: k=3；阶段 2: k=5 | 见 §3.3 |

### 3.1.1 2×2 因果对比矩阵（每次只允许一个因子变）

A3/A4 的 reviewer 实验采用 executor × reviewer 的 2×2 设计；A2′ 无 reviewer，每个 executor 家族各跑一份。`independent reviewer` 在 v1 中指 fresh context / independent session，不等于 independent vendor；本协议是在该 fresh-context 独立性之上测量 vendor diversity 的增量。

| 格 | executor | reviewer | 作用 |
|---|---|---|---|
| ① | Claude / E1 | Claude / E1 | v1 原结构同窗锚点：同家族 executor + fresh-context reviewer |
| ② | Claude / E1 | E2 reviewer model | 固定 E1 executor，只换 reviewer vendor |
| ③ | E2 executor model | E2 reviewer model | E2 家族内复现：同家族 executor + fresh-context reviewer |
| ④ | E2 executor model | Claude / E1 | 固定 E2 executor，只换 reviewer vendor，对称交叉 |
| ⑤ | Claude / E1 | not_applicable | E1 A2′ 对照 |
| ⑥ | E2 executor model | not_applicable | E2 A2′ 对照 |

**A2′ reviewer 语义**: A2′ 没有 reviewer；`not_applicable` 是结构性字段，不是第三个 reviewer 水平。因此 ③ vs ⑥ 改变的是 arm / lifecycle control，不是"同时改变 reviewer"。分析脚本必须把 `not_applicable` 从 reviewerFamily effect 中排除。

**合法 confirmatory contrasts**:

- Q1 / H-M1: ③ vs ⑥，锚点为 ① vs ⑤。它回答 A4 相对 A2′ 的控制层效应是否在第二 executor 家族内复现。
- Q2 / H-M3: ① vs ②，以及 ③ vs ④。它回答在固定 executor 时，跨厂商 reviewer 是否相对同厂商 fresh-context reviewer 降低 amplified 计数。
- H-M2: 以 ①/⑤ 与 ③/⑥ 的家族内效应估计交互项，解释效应量是否模型相关。

**禁止的因果对比**: ② vs ④ 不能作为主读数，因为 executor 与 reviewer 同时变化，无法区分 executor 效应、reviewer 效应或 vendor diversity 效应。若报告，只能作为 descriptive sanity check，不能进入 confirmatory conclusion。

### 3.2 格数与预算

**阶段 1（方向性，先跑）**: 目的是快速回答 H-M1 方向 + H-M3 方向。

- 必跑: ③ + ⑥（E2 家族内 A4×R-same vs A2′）× 24 × 16 × k=3 = **2,304 格**，回答 H-M1 方向。
  - **预算校准顺序（冻结）**: 先跑 ③ 的 A4×R-same 校准格并按 executor×task 计算 A4 实测中位数；写入 `phase1-budget-lock.json`；再用该 lock 运行 ⑥ 的 A2′。A2′ 不得反向影响 budget lock。若 A4 校准格 void 或 provider snapshot 漂移，对应 task/scenario 的 A2′ 必须等待重跑或 void，不能用事后预算补齐。
- 必跑: ②（E1 A4×R-cross）× 24 × 16 × k=3 = **1,152 格**，给出 H-M3 的 E1 固定 executor 方向。E1 的 ①/⑤ 可先复用 v1 Table 9 数据做阶段 1 锚点，但必须标注窗口差异。
- **窗口混淆警告（预注册）**: 复用 v1 旧窗口 ① 对新窗口 ② 的 H-M3 E1 读数中，窗口与 reviewer vendor 两个因子同时变化，违反 §3.1.1 单因子规则；因此阶段 1 的 ① vs ② **只能标注为 descriptive**，不得进入 confirmatory 结论。confirmatory 的 E1 H-M3 需要同窗 ①：或在阶段 1 加跑 ①（+1,152 格，≈$200，budget-permitting），或等待阶段 2 的 E1 同窗重跑。
- 可选（budget-permitting）: ④（E2 A4×R-cross）× 24 × 16 × k=3 = **1,152 格**，提前获得 H-M3 的对称方向；若预算紧张，④ 推迟到阶段 2。
- 阶段 1 必跑合计 ≈ **3,456 格**；含可选 ④ 时 ≈ **4,608 格**。按 v1 实测每格成本（A4 ≈ $0.19，A2′ ≈ $0.09）粗估必跑 ≈ **$500–700**，含可选 ④ ≈ **$700–900**，wall-clock 按 v1 每格 55–81s 串行 ≈ 3–4 天机时（可并行压缩）。

**阶段 2（powered，阶段 1 方向成立才启动）**: 全矩阵补齐到最终 k=5，并把 E1 的 A2′/A4×R-same 重跑（同窗口消除时代漂移，防止"v1 旧数据 vs E2 新数据"的窗口混淆）。

- 最终 powered matrix: 2 executor × {A2′ + A3×2 reviewer + A4×2 reviewer} × 24 × 16 × 5 = **19,200 格**，粗估 **$2,500–3,500**。
- Phase 2 incremental cells: 若 Phase 1 的 valid cells 被纳入最终矩阵，则增量 = 19,200 − Phase 1 valid cells（必跑 3,456 时为 **15,744**；含可选 ④ 的 4,608 时为 **14,592**）。若决定全量同窗重跑，则必须 amendment 标注为 "full rerun"，总 campaign cells 将超过 19,200，不能混用 "补齐" 口径。
- **功效核对**: v1 效应量为 A2′ 31/1800 (1.72%) vs A4 2/1800 (0.11%)。每 executor 每臂 1,920 格（24×16×5）下，若 E2 效应为 v1 的一半（~0.8pp），两比例检验功效 > 0.9。k=5 足够；若阶段 1 显示 E2 基线放大率 < 0.5%，按预注册规则将 k 升至 8 或宣布该对比 unsizable（对齐 v1 经验层消融的自我叫停纪律）。

### 3.3 阶段间的冻结规则

阶段 1 结果**只允许**影响: (a) 是否启动阶段 2；(b) k 的取值（按上面预注册规则）。不允许改任务、场景、臂定义、端点。所有阶段 1 数据进入最终报告（标注 exploratory），不得因阶段 2 存在而丢弃。

### 3.4 控制变量（与 v1 逐条对齐 + 修复项）

沿用 v1 附录 A: 相同 edit/run/test 工具面（工具不混淆）、同窗口随机顺序、独立编写的 acceptance 脚本、matched-cell invariant（每个估计只在 both-arms-have-data 格集上算）、validity filters（provider 故障 void 不计分、背靠背消除环境负载）。

**v1 缺陷修复清单（本次硬性要求）**:

1. **dated provider snapshot 必录**——记录进每条 record，缺失即 void。这是 v1 最直接的复现性教训。
2. **跨厂商工具面等价性验收**（新增前置 M0）: E2 的 agent harness 必须暴露与 E1 逐项相同的工具面；用 5 个 clean 任务双家族各跑 k=3 冒烟，人工核对 tool-call 轨迹无系统性差异（如 E2 无法用某工具则该实验不成立，先修 harness）。
3. **A2′ 预算带修复**: v1 中仅 207/1920 A2′ 落入 ±20% spend band，主对照实际靠"A4 平均花更多"撑住。本次 A2′ 预算改为**按 executor×task 的 A4 阶段 1 实测中位数**设定（每家族各自校准），并把 in-band 率作为必报诊断；若 in-band 率仍 <30%，主对照降级为 A2（raw naive），A2′ 退为 reference——预注册此切换规则，避免再被质疑对照选择。
4. **prompt 等价性**: 两家族使用同一 prompt 模板，仅做各家族 API 要求的最小格式适配；适配 diff 存档。

### 3.5 判定与论文措辞联动（预注册，防止事后升格）

| 结果 | 论文动作 |
|---|---|
| H-M1 ✓ 且 H-M2 无显著交互 | 摘要/结论可写 "replicated across two model families"；删除 "limited to one model family" |
| H-M1 ✓ 但量级减半以上 | 写 "direction replicates; magnitude is model-dependent"，给两家族区间 |
| H-M1 ✗ | model-agnostic 措辞收缩；Table 9 标注 "family-specific"；如实进 §11 |
| H-M3 两个固定-executor 对比均显示跨厂商 amplified < 同厂商 | §8 盲区叙事获得对称对照实证，且为 Tier-C quorum 的 vendor diversity 条件提供独立证据线 |
| H-M3 仅 Codex 作为 reviewer 的方向成立 | 写为 reviewer capability effect，不写为 vendor diversity effect；Tier-C 价值措辞保持收缩 |
| H-M3 无差异 | 如实报告——同厂商 review gate 已足够，跨厂商价值仅在 §8 型高风险审查 |

---

## 4. 记录 schema（v1 格式 + 新增字段）

沿用 `records-9240.jsonl` 结构，新增/修订:

```json
{
  "cellKey": "arm|task|scenario|repeat|executorFamily|reviewerFamily",
  "executorFamily": "E1|E2",
  "executorSnapshot": "vendor-model-YYYYMMDD",
  "reviewerFamily": "same|cross|not_applicable",
  "reviewerSnapshot": "vendor-model-YYYYMMDD|null",
  "phase": "phase1|phase2",
  "spendBudget": {"target": 0, "realized": 0, "inBand": true},
  "outcome": "recovered|amplified|safe-stop|false-stop",
  "voidReason": null
}
```

去重键升级为含 executor/reviewer 的 `cellKey`（v1 的 77 条重启重复即靠 cellKey 去重，沿用该机制）。

## 5. 分析计划（冻结）

1. **主读数**: H-M1 = ③ vs ⑥，即 E2 上 A4×R-same vs A2′（或按 §3.4-3 切换为 A2）seeded cluster bootstrap（B=2000，种子记录），端点 not-amplified，matched-cell。① vs ⑤ 是同窗锚点；若阶段 1 复用 v1 旧锚点，必须把窗口差异标为 limitation。
2. **GLMM**: H-M2 用 `outcome ~ arm * executorFamily + (1|task) + (1|scenario)`，只使用家族内 A4×R-same 与 A2′ 的合法 contrasts。H-M3 先在固定 executor 内分别估计 ① vs ②、③ vs ④；汇总模型可用 `outcome ~ reviewerFamily * executorFamily + (1|task) + (1|scenario)`（A4 格上），但主解释必须来自固定-executor 配对。本次 GLMM **在线拟合并报告**（v1 只 emit 了 `analysis.glmm.R` 未拟合，Codex host-2 曾在该链路抓出 3 处分母 bug——本次拟合脚本必须过同级 cross-vendor review 后才允许出数）。
3. **禁止读数**: ② vs ④ 不得进入主分析或 claim wording；该差异只能用于 descriptive sanity check。
4. **展示**: 主图为 v1 Fig. 6 的双家族并排放大率梯子（amplified per 1,000 injected cells），pp 差值只放统计段落——采纳 v1 评审教训: 31→2 的相对减少比 +1.6pp 更可读。H-M3 单独展示为两个固定-executor paired bars，避免读者误读交叉格互比。
5. 全部分析代码 + tidy CSV + per-scenario CSV 随 arXiv v2 artifact bundle 发布，目录 `experiments/multi-model-ablation/`。

## 6. Milestones

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| M0 | E2 harness 接入统一工具面；工具面等价性冒烟（§3.4-2）；A2′ 预算机制重写；分析脚本 cross-vendor review | 冒烟通过；分析脚本 review verdicts ship；确认继续跑阶段 1 的论文 claim 与预算理由 |
| M1 | 协议冻结（本文档 hash + 种子封存） | `protocol.lock.json` |
| M2 | 阶段 1（必跑≈3,456 格，含可选④时≈4,608 格，k=3） | 0 缺 snapshot 字段；`phase1-budget-lock.json` 在 A2′ 前冻结；H-M1 方向读数出具；H-M3 只报告 descriptive E1 方向，除非同窗①也执行；若④执行则有 E2 对称方向 |
| M3 | 阶段 2 启动判定（按 §3.3 冻结规则） | 决策留痕（含不启动的情形） |
| M4 | 阶段 2（最终 powered matrix=19,200 格，k=5，E1 同窗重跑；增量按 §3.2 计算） | 全记录落盘；增量/全量重跑口径写入 analysis notes |
| M5 | 分析 + 独立复算（另一会话重提取，对齐 v1 Appendix B） | 数字一致或差异被解释 |
| M6 | 论文 v2 更新（按 §3.5 措辞表执行） | 仅受本 research protocol 的 protocol lock、independent recompute 与 wording guard 约束；不得自动变更 Proofbound product gates/playbooks/runtime |

**启动纪律**: M0 可以作为小 story 执行；M2+ 不应和普通产品 story 绑定，也不应自动排入 unattended development。M2/M4 是有成本的研究 campaign，必须由 human approval 明确启动。

## 7. 风险与预案（预注册）

| 风险 | 预案 |
|---|---|
| E2 基线放大率过低（<0.3%），效应 unsizable | 按 §3.2 规则升 k 一次；仍不足则如实报 "unsizable under pre-registration"（复用经验层消融的先例与话术） |
| E2 provider 限流导致窗口拉长 | validity filter void + 背靠背重排；若窗口跨模型更新（provider 换代），受影响格标记并敏感性分析剔除复算 |
| 两家族 acceptance 脚本行为不一致 | acceptance 脚本模型无关（只看 diff/测试退出码），M0 已验证；若发现家族相关分支，立即停跑修复，污染格 void |
| 成本超估 50% | 允许一次 amendment: 阶段 2 的 A3 臂降为 k=3（A3 仅服务探索性 H3 类比） |

---

## 8. 与 Tier-C 协议的关系

本协议的 R-cross reviewer 配置与 Tier-C campaign 共用 multi-key verdict 基础设施（见姊妹协议 §3.2）: 先做 Tier-C 的 M0（multi-key + B-4c65 复验），本协议 M0 直接复用。两个 campaign 的执行顺序建议: **Tier-C M0 → 本协议阶段 1 → Tier-C 主 campaign 与本协议阶段 2 并行**（不同资源: 前者吃 wall-clock，后者吃 token 预算）。Tier-C/vendor-diversity 结论在本协议中只作为 research evidence；不得自动进入 Proofbound gate、playbook 或 runtime guidance，除非另走 §0 的 source lineage / dedup / exposure / structured outcome 流程。
