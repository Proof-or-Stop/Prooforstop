# Claude Session B-cdf6 审查收敛分析与框架优化优先级

Status: proposed

Evidence session: `a57f5dd5-4fe3-4355-b24b-09464e55c30a`

Evidence Story: `B-cdf6`

Evidence snapshot: `2026-08-14 17:10:31 Asia/Singapore`

## 1. 目的

本文分析 Claude session `a57f5dd5-4fe3-4355-b24b-09464e55c30a` 中 Story `B-cdf6` 为什么实现和收口异常缓慢，并按预期收益、当前阻塞程度、复发概率和落地依赖排序框架优化项。

本文的核心问题不是“Claude 为什么写代码慢”，而是：

> Proofbound 的生命周期、reviewer 编排、证据写入和验收模型，在哪些位置把一次正常的实现—审查—修复过程放大成了多轮重复工作？

本文只提出分析和优化方向，不授权修改 B-cdf6、放宽现有证据门禁、删除独立 reviewer、跳过验证或停止外部 Claude session。

## 2. 快照边界与证据可信度

### 2.1 滚动快照

快照采集时 Claude session 和 B-cdf6 仍在运行。采集过程中 review run 从 51 增长到 55，finding 从 38 增长到 40。因此本文中的计数是 `2026-08-14 17:10:31 Asia/Singapore` 时点的下界，不应解释为 Story 的最终数字。

这不影响主要因果结论，因为最关键的闭环放大过程已经发生并被原始 transcript、review run、Git commit 和 framework source 同时记录。

### 2.2 原始证据

Claude 主 transcript：

```text
/Users/qipan/.claude/projects/-Users-qipan-work-repo-Prooforstop/
  a57f5dd5-4fe3-4355-b24b-09464e55c30a.jsonl
```

Claude subagent transcript：

```text
/Users/qipan/.claude/projects/-Users-qipan-work-repo-Prooforstop/
  a57f5dd5-4fe3-4355-b24b-09464e55c30a/subagents/*.jsonl
```

Story 事实通过 Proof-or-Stop CLI 读取：

```bash
proof-or-stop story_get '{"storyId":"B-cdf6","slim":true,"fields":["story","checklist","review"]}'
proof-or-stop checklist_get '{"storyId":"B-cdf6","slim":true,"fields":["counts","items"]}'
proof-or-stop finding_list '{"storyId":"B-cdf6","brief":true}'
```

Review、finding 和 validation 聚合指标来自 Story runtime evidence：

```text
.lattice/story/actives/B-cdf6/review-runs.json
.lattice/story/actives/B-cdf6/findings.json
.lattice/story/actives/B-cdf6/test-evidence.json
```

Git 指标来自 B-cdf6 worktree：

```bash
git rev-list --count main..HEAD
git diff --shortstat main...HEAD
git diff-tree --no-commit-id --name-only -r <commit>
```

本文没有修改 B-cdf6 worktree，也没有把 Claude 的自我总结当作唯一证据。

### 2.3 判定标签

- `CONFIRMED`：有 transcript、结构化 evidence、Git 或代码入口中的直接证据。
- `SUPPORTING`：能加重成本，但不是当前最大放大器。
- `NOT PRIMARY`：真实存在或值得优化，但不足以解释 B-cdf6 的主要耗时。
- `UNSUPPORTED`：当前证据不足，不作为优化决策依据。

## 3. 证据快照

### 3.1 Story 与验证状态

| 指标 | 快照值 |
|---|---:|
| Story phase | `REVIEW` |
| REVIEW 停留 | 超过 27 小时 |
| Checklist | 6/6 done |
| Review round | 4 |
| Review run | 55 |
| Review materialHash | 21 个不同值 |
| Finding | 40 |
| Finding 状态 | 39 resolved，1 dismissed |
| Validation command | 94/94 执行成功 |
| Validation 整体结果 | `FAIL` |
| Required coverage | 35/36，缺 1 |
| CHK-006 | 0 verificationIntent，0 verificationEvidence |

这组事实证明：Story 不是卡在“测试命令无法通过”。94 条 routine validation command 已全部 PASS，整体 FAIL 来自验收覆盖缺口。

### 3.2 Git 放大量

| 指标 | 快照值 |
|---|---:|
| `main..HEAD` commit | 260 |
| 仅修改 Story metadata 的 commit | 209 |
| 包含 material 修改的 commit | 51 |
| Diff | 562 files changed |
| Insertions / deletions | 277,760 / 5,512 |

“metadata-only commit”使用路径事实分类：一个 commit 的所有路径都位于 `.lattice/` 或 `docs/story/` 时记为 metadata-only，而不是只按 commit message 猜测。

209/260 的 commit 不包含产品 material，说明状态记录、finding、pass、refresh 和收口动作本身已经成为主要 Git 活动。metadata 写入不是错误；问题是它们没有被一个有明确开始、聚合和结束的事务收敛。

### 3.3 Reviewer 与 session 成本

| 指标 | 快照值 |
|---|---:|
| Reviewer subagent | 54 |
| 首次正式 REVIEW 后启动的 reviewer | 46 |
| Reviewer transcript 区间累计时长 | 9.64 小时 |
| 首次正式 REVIEW 后 reviewer 累计时长 | 9.29 小时 |
| Implementer subagent | 14 |
| Implementer transcript 区间累计时长 | 11.54 小时 |
| 主 transcript | 11,361,725 bytes / 6,585 rows |
| Subagent transcript | 69 个 JSONL |
| 主 + subagent output token 字段总和 | 3,003,416 |
| cache-read token 字段总和 | 2,219,856,229 |
| review run 内嵌 assembled prompt | 1,529,036 bytes |

这些 token 数是 Claude usage 字段累加，不是唯一文本量，也不是账单真相。它们用于说明重复进入上下文的规模，不用于估算价格。

### 3.4 Reviewer 分布

| Lane | Review run |
|---|---:|
| concept | 12 |
| quality | 14 |
| docs | 11 |
| test-coverage | 18 |

同一 `lane + materialHash` 的确定重复 run 有 8 个。这个数字只是可以机械证明的重复下界；逐 finding 修改 material 后形成的新 materialHash 不会被这个条件计为重复，但仍可能由错误编排产生。

## 4. 决定性时间线：冻结承诺没有机械执行

本次最有解释力的证据发生在 `2026-08-14 16:35–17:00 Asia/Singapore`。

### 4.1 建立冻结点

`2026-08-14T08:35:16.614Z`，主 agent 明确写道：

```text
Material frozen at 73f42d07d1, tree clean.
Now all four lanes in parallel — and I will not touch material until every one reports.
```

随后 concept、quality、docs、test-coverage 四条 lane 被并行派出，并要求绑定同一个 HEAD `73f42d07d1`。对应 review run RR-043、RR-044、RR-045、RR-046 具有相同：

- `headHash = 73f42d07d15e08941cc963822a48b35fc556762f`
- `materialHash = c8fe9e874098f8feb8be63a72d69754ce33f77d769be89d7d3fcf99dc3f88015`

### 4.2 第一条 lane 返回后立刻修改 material

`2026-08-14T08:45:18.813Z`，concept lane 返回 F-036：`prompt-token-cost-smoke.ts` 中存在第四处手写 prompt render 规则。

主 agent 随即：

1. 读取文件；
2. 在 `08:45:50Z` 和 `08:46:02Z` 两次 Edit；
3. 运行验证；
4. 在 `08:47:17Z` 提交 material commit `155e787d0c`。

此时 docs 和 test-coverage lane 尚未结束。也就是说，四 lane 的聚合屏障还没到，审查对象已经从 `73f42d07d1` 变成 `155e787d0c`。

### 4.3 尚未结束的 lane 继续返回结果

- docs lane 随后产生 F-037；
- test-coverage lane 在 `08:59:02Z` 产生 F-038；
- F-038 指出代码修复已存在，但 F-034～F-037 没有执行 `finding_resolve`，ledger 仍显示 open；
- 主 agent 又继续修改、提交、逐条解决 finding；
- 后续出现 RR-047～RR-051，以及快照时继续增长到 RR-055。

### 4.4 因果判定

**Verdict: CONFIRMED — 这是 B-cdf6 最大的重复工作放大器。**

当前流程实际是：

```text
并行启动四条 reviewer lane
  -> 第一条 lane 返回 finding
  -> 立即修改 material
  -> 其他 lane 仍在审查旧 material
  -> 旧结果无法共同证明新 material
  -> 新 HEAD 上再次派发 reviewer
  -> 下一条 finding 再次修改 material
  -> 循环
```

这个循环的关键不是 reviewer 找到了问题。F-036、F-037、F-038 都是有效发现。问题是框架没有要求“先完整收集这一批 finding，再统一 remediation”。因此本可在一个 material epoch 中并行完成的 reviewer 被串行 finding 逐步打散。

## 5. 框架层根因

### 5.1 编排层：`reviewer_batch` 是浅只读计划，不是 review 事务

**Verdict: CONFIRMED / dominant**

`packages/main/src/handlers/reviewer-batch.ts:1-38` 明确说明：

- 只生成 reviewer launcher plan；
- 不启动 reviewer；
- 不调用 `review_run_start`；
- 不写 review run/pass/finding；
- 不等待 lane；
- 不冻结 material；
- 不推进 phase。

因此“all four lanes in parallel”“do not touch material”只是 agent prompt 中的行为承诺，不是框架事实。框架没有 `reviewEpochId`、active epoch、lane completion barrier 或 material mutation guard。

这是一个典型浅模块：调用方仍需理解并手工完成 lane 选择、启动、冻结、等待、聚合、重试和收口的全部复杂度。删除 `reviewer_batch` 后复杂度不会消失，只会继续留在 host prompt 中。

### 5.2 证据事务层：代码修复和 finding ledger 分离

**Verdict: CONFIRMED**

F-038 证明主 agent 曾四次报告“34 findings / 0 open”，但 canonical ledger 仍有五条 open finding。代码修复本身存在，缺失的是 finding closeout。

`packages/main/src/handlers/finding.ts:759-790` 的 `finding_resolve` 顺序是：

1. 单条 finding 写为 resolved；
2. 尝试重算 process metrics；
3. 独立 `autoCommitStoryMetadata`。

它不知道对应 repair commit，也不知道同一 reviewer batch 的完整 repair set。代码修复、验证、finding 解决和 canonical open-count projection 是四次不同操作，agent 很容易完成前三者中的一部分后错误宣称收口。

### 5.3 生命周期验收层：DEV 中新增 scope 没有合法验收增补通道

**Verdict: CONFIRMED / current blocker**

CHK-006 是用户在 DEV 中纠正 freeze criterion 后增加的最大工作项，但它从创建开始就没有 verificationIntent。

`packages/main/src/handlers/checklist.ts:1394-1406` 将 verificationIntent 在 `DEV / REVIEW / TEST / DONE` 全部冻结。结果是：

- CHK-006 可以完成大量代码和 gate 工作；
- 却不能获得自身的 verificationIntent；
- 没有 intentRef 就不能合法绑定 verificationEvidence；
- routine validation 的 94 条 command 可以全部 PASS；
- 整体仍因 required coverage 缺 1 而 FAIL。

冻结已有验收是正确的防篡改规则；缺陷是框架没有“签名式、只增不改”的 mid-DEV acceptance amendment。

### 5.4 模块层：prompt/asset 规则在多个调用方重复实现

**Verdict: CONFIRMED / recurrence amplifier**

F-005、F-034、F-036 形成一条清晰证据链：

1. 某处 prompt render 规则只处理 modular reviewer，漏掉 modular complex role；
2. 修复两处后，quality lane 找到第三处 `managed-assets.ts`；
3. 收敛三处后，concept lane又在 `prompt-token-cost-smoke.ts` 找到第四处；
4. 第四处之所以没在测试中暴露，是同文件更早的既有失败先中止了执行。

这不是代码风格问题，而是 shallow copies 缺少 locality：规则变化必须同步修改多个生产路径和测试路径，任何一个调用方遗漏都会制造下一轮 finding。

当前向 `renderPromptEntryForHost` 收敛的方向正确，但需要通过 interface 和 contract 防止调用方重新实现同一判断。

### 5.5 Scope 治理层：Story 从 rename 扩张为框架迁移

**Verdict: SUPPORTING**

B-cdf6 最终影响 562 个文件、21 个 reviewer materialHash、51 个 material commit，并触及：

- CLI brand；
- active docs；
- generated agent assets；
- prompt registry；
- Claude/Codex adapter；
- validation receipt timeout；
- evidence freshness；
- process fact contracts；
- smoke 和 DONE suite。

文件数包含生成资产，不能单独作为拆分依据；但独立责任域、process facts 和 host adapter 的数量已经明显超过单一 rename Story 的收口单位。mid-DEV scope growth 没有触发预算、acceptance amendment 或 child Story 分解。

### 5.6 Freshness：旧死锁部分已修，不应重复设计

**Verdict: NOT PRIMARY for the remaining loop**

`packages/main/src/core/evidence-freshness.ts:525-575` 已经支持：

- materialHash 一致直接 fresh；
- materialHash 不同但非空 storyFilesHash 一致时降级为 advisory；
- story-owned material 真变化时保持严格拒绝。

`packages/main/src/core/review-run.ts:1596-1611` 也已针对 terminal reviewer finding 的 superseded freshness 死锁做过修复。

因此不能把当前优化简化为“放宽 freshness”。B-cdf6 的决定性事件是真实 material 在 reviewer batch 尚未结束时发生改变；这本来就应该使旧 pass 不能证明新代码。

### 5.7 Validation：不是当前最大根因

**Verdict: NOT PRIMARY**

当前 test evidence 显示：

- commandExecution status = PASS；
- complete = true；
- commandCount = 94；
- requiredFailureCount = 0；
- optionalFailureCount = 0；
- overall result = FAIL；
- missingRequired = 1。

框架已有 routine validation PASS reuse 和 identity/freshness 设计。继续只优化 test runner，无法修复 CHK-006 没有 intent，也无法阻止 reviewer 对变化中的 material 重复工作。

### 5.8 Provider timeout 和 token 量：成本结果，不是首要因果

**Verdict: NOT PRIMARY**

大部分 reviewer 和 implementer 最终都返回了结果，没有证据表明统一的 provider timeout 是 55 个 review run 的主要原因。约 300 万 output token 和 22 亿 cache-read token 反映了循环的规模，但缩短 prompt 或增加 timeout 不会改变“第一条 finding 返回后立刻改 material”的状态机。

## 6. 优化优先级

排序标准：

1. 能削掉多少重复 reviewer/material epoch；
2. 是否解除 B-cdf6 当前真实 blocker；
3. 是否在执行边界机械成立；
4. 是否保持现有 fail-closed、独立 reviewer 和 evidence soundness；
5. 是否为后续优化提供稳定 seam。

| 排名 | 优化项 | 优先级 | 预期提升 | 框架层 |
|---:|---|---|---|---|
| 1 | 强制 Review Epoch 与 material write barrier | P0 | 最大 | 编排、执行边界 |
| 2 | Reviewer remediation 与 ledger 原子收口 | P0 | 很大 | 证据事务 |
| 3 | 签名式 DEV acceptance amendment | P0 | 很大，解除当前阻塞 | 生命周期、验收 |
| 4 | Prompt/agent asset 单一投影模块 | P1 | 大 | 模块深度、生成资产 |
| 5 | Story scope budget 与自动分解门禁 | P1 | 大，预防复发 | PLAN、scope 治理 |
| 6 | Convergence breaker 消费有效进展 | P1 | 中等 | 收敛控制 |
| 7 | 基于影响图的增量 validation | P2 | 中等 | 验证调度 |
| 8 | Review metadata 和 prompt 内容寻址 | P2 | 中低 | 存储、Git |
| 9 | Token、burn 和 timeout 护栏 | P3 | 较低 | 可观测性、运行成本 |

## 7. P0-1：ReviewConvergence 深模块

### 7.1 决策

新增一个深模块 `ReviewConvergence`，在一个 interface 后拥有 review epoch 的完整行为：

- 固定 review cutoff；
- 计算 active lanes；
- 签发 epoch-bound reviewer dispatch；
- 接收并校验 lane verdict；
- 维护 lane terminal state；
- 聚合 finding/pass；
- 控制 cancel/timeout；
- 阻止 epoch 中途 material mutation；
- 产生一次可审计的 batch result。

外部 interface 应保持小：

```ts
beginReviewEpoch(input): ReviewEpoch
recordReviewVerdict(input): ReviewEpochState
finalizeReviewEpoch(input): ReviewBatchResult
cancelReviewEpoch(input): ReviewEpochState
```

不要把 hash 计算、lane state、freshness、retry reason、metadata paths 等内部细节暴露给调用方。

### 7.2 Seam 与 adapter

真正变化的是 host 启动方式，因此 host launch seam 是真实 seam：

- Claude reviewer launcher adapter；
- Codex reviewer launcher adapter；
- 测试使用 in-memory adapter。

epoch 状态、hash、lane 聚合和 gate 逻辑属于模块 implementation，不应复制到每个 adapter。

### 7.3 执行边界

只在 prompt 中写“不要改 material”不算完成。active epoch 必须被以下位置机械消费：

1. Claude/Codex PreToolUse 或等价本地 hook：阻止 implementer 对 material path 的 Edit/Write/Bash mutation；
2. Git pre-commit/check：active epoch 时拒绝 material commit；
3. review pass/finding handler：拒绝不属于 active epoch/cutoff 的新 verdict；
4. lifecycle gate：未 finalized 的 required epoch 不能进入下一阶段。

若确实需要提前修复，必须显式 cancel epoch。cancel 后未完成 lane 的结果可保留作 advisory，但不能作为新 material 的 pass。

### 7.4 验收标准

- 一个 epoch 中每条 required lane 最多有一个 current verdict；
- 所有 lane 绑定同一 headHash/materialHash/storyFilesHash；
- active epoch 期间 material mutation 被机械拒绝；
- cutoff 改变后，旧 epoch verdict 不进入 current pass；
- reviewer timeout 形成结构化 terminal state，不永久锁死 epoch；
- finalize 只发生一次并且幂等；
- 重放 B-cdf6 RR-043～RR-046 时，F-036 返回后不得修改 material，必须先等待另外三条 lane terminal；
- 同一回放中不得产生 RR-047～RR-051 式的中途级联。

## 8. P0-2：ReviewRemediation 原子收口

### 8.1 决策

Review epoch finalized 后形成一个不可变 `repairSet`。新增深模块 `ReviewRemediation`，用一个收口 interface 连接 repair commit、验证证据、finding 状态和 canonical projection：

```ts
closeReviewRemediation(input): ReviewRemediationResult
```

输入至少绑定：

- storyId；
- epochId；
- repair commit；
- finding IDs；
- per-finding resolution evidence；
- verification receipt references。

### 8.2 Implementation 所有权

模块内部负责：

1. 验证 repair commit 是 epoch cutoff 的 descendant；
2. 验证目标 finding 属于该 epoch/repair set；
3. 验证 resolution evidence；
4. 一次更新全部 finding status；
5. 重算 process metrics；
6. 重新读取 canonical open count；
7. 使用 canonical metadata transaction 一次提交 Story metadata。

代码 commit 和 metadata transaction 不需要伪装成跨 Git/文件系统的全局 ACID 事务；但“某一 repair commit 关闭哪些 finding、凭什么关闭、关闭后 canonical 状态是什么”必须成为一次 fail-closed 操作。

### 8.3 验收标准

- 没有 repair commit 或 evidence 时不能把 finding 标为 fixed；
- 任一 finding 校验失败时整批不写；
- 同一 repairSet 重试幂等；
- 一批 remediation 最多一个 metadata commit；
- 输出 finding count 必须来自 transaction 后重新读取的 projection；
- 不允许缓存旧 `finding_list` 结果后继续宣称“0 open”；
- F-038 回放中，代码修复完成但 ledger 未更新时 `closeReviewRemediation` 必须明确拒绝“已收口”结论。

## 9. P0-3：AcceptanceAmendment 深模块

### 9.1 决策

保留 DEV 后不能任意改写已有 verificationIntent 的规则，同时增加签名式、只增不改的 mid-DEV acceptance amendment。

建议 interface：

```ts
proposeAcceptanceAmendment(input): AcceptanceAmendment
approveAcceptanceAmendment(input): AcceptanceAmendmentResult
```

### 9.2 Amendment 必须绑定

- 原始 scope/intent snapshot digest；
- 新增 scope delta；
- 新增或收紧的 checklist item；
- verificationIntent；
- acceptance topology delta；
- 触发原因和用户可见变化；
- 独立 verification-intent reviewer receipt；
- 新旧 storyFiles scope 的关系。

### 9.3 安全约束

- 只允许 additive 或 stricter，不允许删除、放宽或重写已有 intent；
- amendment 未批准前，新增 implementation 不能标 done；
- approval 后只使受影响 lane/scope 进入待验证，不全量清空所有 checklist；
- REVIEW 中发现的新需求不得伪装成 code fix，必须回 DEV 走 amendment；
- 所有 amendment 进入 process-fact registry 和 gate。

### 9.4 B-cdf6 验收标准

- CHK-006 可以在保留 CHK-001～CHK-005 历史的前提下获得合法 verificationIntent；
- intent 创建后可以绑定真实 verificationEvidence；
- routine validation 已 PASS 的 94 条 command 可按现有 reuse 语义复用；
- coverage 从 35/36 收敛到 36/36，而不是通过 waiver 或放宽 gate 隐藏缺口。

## 10. P1-4：PromptAssetProjection 单一投影模块

### 10.1 决策

将 role 分类、legacy reconstruction、host rendering、managed asset comparison 和 materialization 收进一个深模块：

```ts
renderPromptEntryForHost(entry, host): string
materializeManagedAgentAssets(input): MaterializationResult
```

调用方不能自行组合：

- `isModularReviewerRoleId`；
- `isModularComplexRoleId`；
- `renderReviewerRunBootstrapForTemplate`；
- `restoreLegacyPromptTemplate`；
- host-specific expected content。

这些是 implementation，不是外部 interface。

### 10.2 测试策略

采用 replace-don't-layer：

- 新测试通过 `PromptAssetProjection` interface 断言可观察结果；
- 删除重新实现 expected content 的旧测试；
- property test 可以断言 marker、frontmatter、role count 等性质，但不能复制渲染算法；
- contract scanner 阻止生产代码和测试重新出现手写 role render branch；
- 所有 role count 从 registry 派生，禁止硬编码 `16`、`17`。

### 10.3 B-cdf6 回放标准

- F-005、F-034、F-036 的三个路径都只能跨同一个 interface；
- 修改 complex-role 规则只需修改一个 implementation；
- 17 个 role × 2 个 host 的输出一致性从 interface 测试覆盖；
- 删除模块时复杂度会重新散落到多个调用方，证明该模块具有真实 depth 和 locality。

## 11. P1-5：Story scope budget 与自动分解

### 11.1 不使用单一文件阈值

生成资产会放大文件数，因此 562 files 不能直接等价为 562 个独立需求。scope budget 应组合：

- 独立责任域数量；
- host adapter 数量；
- 新增/修改 process facts；
- 公共命令和 registry 数量；
- acceptance topology obligation；
- DEV 中 scope delta；
- estimated review lane 和 validation command group。

### 11.2 Gate 行为

超出预算时要求：

1. parent roadmap + child Stories；或
2. 人工 `large-story-approve`；并且
3. 对 DEV 中新增 scope 强制创建 AcceptanceAmendment。

目标不是禁止大 Story，而是让其审查和证据收口单位显式化，避免一个 prompt helper finding 使 562 文件 Story 的全部 lane 重审。

## 12. P1-6：Convergence breaker 消费有效进展

当前 breaker 不应把以下信号视为进展：

- 新 metadata commit；
- 新 reviewer run；
- heartbeat；
- 重复运行同一失败命令；
- agent 自述“正在处理”。

建议有效进展定义：

- review epoch finalized；
- open verified finding 净减少；
- missingRequired 减少；
- blocking failure signature 改变；
- material scope 稳定后产生 current pass；
- phase 合法推进。

连续两个完整 epoch 没有上述变化时，breaker 才要求人工决策。breaker 消费 ReviewConvergence 的结构化状态，不再从零散事件猜测。

## 13. P2：增量 validation 与 metadata 压缩

### 13.1 ValidationImpact

在 process-fact registry 和 command manifest 上建立影响图：

- REVIEW remediation 只运行受影响 command group；
- coverage-only FAIL 不重跑已 PASS command；
- material identity 变化时按依赖重新执行；
- DONE-required 仍运行配置要求的完整 canonical suite。

不能用 mtime 或简单路径前缀替代依赖图，也不能把 94 command 的一次 PASS 静默重新绑定到真实 material change。

### 13.2 内容寻址

Review run 当前内嵌约 1.53 MB assembled prompt。后续可：

- prompt envelope 按 digest 存储；
- review run 只保存 immutable reference；
- epoch 内 lane result 批量 append；
- `session_brief` 和 slim reader 不加载 prompt body；
- 提供有界 GC，不能删除 gate 仍引用的对象。

这会降低 Git 和 context 成本，但必须在 P0 收敛语义稳定后实施，否则只是更高效地记录同一个循环。

## 14. P3：Burn、token 与 timeout 护栏

建议只作为防护：

- `burnThresholdExceeded` 必须和“无有效进展”同时成立；
- 高 token 但 finding/coverage 正在收敛时只 advisory；
- provider 无 progress 时由 managed process supervisor 判定，而不是把 worker heartbeat 当 provider progress；
- 增加 timeout 不能替代 review epoch；
- 增加 reviewer 并发前必须先有 material barrier，否则并发越高浪费越大。

## 15. 明确不做的优化

### 15.1 不全面放宽 freshness

真实 material 修改后要求新 review 是正确语义。当前问题是修改发生在 batch 中途，不是 gate 太严格。

### 15.2 不删除 reviewer lane

F-034、F-036、F-037、F-038 证明 reviewer 找到的是有效缺陷。优化目标是一次 epoch 收集完整，而不是减少独立制衡。

### 15.3 不把 94 command 重跑作为当前第一动作

它们已经全部 PASS。当前缺口是 acceptance coverage 和 review convergence。

### 15.4 不只缩短 prompt

Prompt 去重会降低成本，但无法阻止审查对象在 reviewer 尚未结束时改变。

### 15.5 不只增加 timeout

绝大部分 reviewer 最终完成。更长 timeout 不能把旧 material 的 reviewer result 变成新 material 的证据。

## 16. 实施顺序

建议按以下依赖顺序创建独立 Stories：

1. **ReviewConvergence epoch + execution-boundary mutation guard**
2. **ReviewRemediation atomic closeout**
3. **AcceptanceAmendment additive scope/intent flow**
4. **PromptAssetProjection interface hardening**
5. **Story scope budget and decomposition gate**
6. **Convergence breaker progress semantics**
7. **ValidationImpact and content-addressed metadata**
8. **Burn/token guardrail integration**

前两项可以属于同一 program，但应保持两个清晰职责：

```text
ReviewConvergence
  owns: cutoff, lanes, freeze, verdict collection, aggregation

ReviewRemediation
  owns: repair commit, resolution evidence, finding closeout, canonical projection
```

不要把它们重新铺成多个互相调用的浅 handler。handler 应只做 schema/authority/cwd 入口，然后调用深模块 interface。

## 17. 目标指标

第一阶段不是承诺一个未经测量的百分比，而是建立可验证的不变量：

| 指标 | 目标 |
|---|---:|
| Active epoch 中 material mutation | 0 |
| 同 epoch、同 lane 的 current review run | 最多 1 |
| 未 finalized epoch 跨 phase | 0 |
| 一批 remediation 的 metadata commit | 最多 1 |
| Code fixed 但 ledger open 的 finding | 0 |
| `done` item 且 intent/evidence 均为 0 | 0 |
| Reviewer brief 使用旧 finding count | 0 |
| Prompt render 手写 expected copies | 0 |

B-cdf6 的历史回放应作为第一条 RED/green 基准：

```text
RED baseline
  review runs: 55
  material hashes: 21
  exact same-lane/same-material duplicates: 8
  metadata-only commits: 209
  command execution: PASS 94/94
  overall validation: FAIL, missingRequired=1

Required green behavior
  RR-043..RR-046 remain one epoch
  F-036 does not permit material mutation until all four lanes terminate
  findings are aggregated into one repairSet
  one remediation closeout updates the complete ledger
  CHK-006 obtains intent through a signed additive amendment
  already-PASS command execution is reused only under existing sound identity rules
```

## 18. 结论

B-cdf6 的主要耗时应判定为 **review closure amplification**，不是单纯的模型慢、测试慢或门禁太多。

最关键的框架缺口是：系统能够创建独立 reviewer run，却没有拥有 reviewer batch 的生命周期。review 对象的冻结、四 lane 的等待、finding 聚合和 remediation 收口仍由主 agent 在 prompt 中手工编排。一次 lane 提前返回就会诱发 material mutation，使其余 reviewer 的工作不能共同证明新材料，随后再派发新 reviewer。

最高收益路径不是削弱 review，而是让 review 变成真正的事务：

```text
固定 material epoch
  -> 所有 required lane 完整收集
  -> 聚合 finding
  -> 一批 remediation
  -> 原子更新 ledger/projection
  -> 必要时签名式增补 acceptance
  -> 在新 material 上开启下一 epoch
```

如果只能先做三项，应依次实施 ReviewConvergence、ReviewRemediation 和 AcceptanceAmendment。它们分别解决本次最昂贵的重复 reviewer、工程状态与审计 ledger 不一致、以及 94 条命令全部通过却无法覆盖新增工作项的三条确定因果链。
