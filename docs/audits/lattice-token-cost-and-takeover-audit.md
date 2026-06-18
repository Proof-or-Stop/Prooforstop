# Lattice CLI 审计报告：Token 成本 + 跨 Host 接管能力

> **用途**：供审计 / 方案确认。  
> **日期**：2026-06-15  
> **范围**：(1) Lattice 是否能接管其它 host 未完成的工作；(2) Lattice CLI 的 LLM token 成本是否过高，确切证据 + 不破坏功能的优化方案。  
> **方法**：5 路并行调查 → 量化建模 → 对抗式安全核验（7 个 agent，~52 万 token），关键结论由主 agent 直接读源码二次核验。  
> **整体置信度**：中（最大不确定性来自 prompt cache 是否命中，见 §2.4）。

---

## 审计记录（独立核验，2026-06-15）

本文档已用 Lattice CLI 流程独立核验：5 路 fresh-context reviewer 逐条对照源码复跑 27 个事实主张（含 file:line 引用、字节数、token 账、签名域），结论独立裁决。

- **25 / 27 主张直接确认**（repro 命令实测：字节数、fence 行号、签名域、lease / handoff / session 源码）。
- **Keystone C16 确认**：init / scope / delivery 三个 gate 的签名域均只签 story 数据，**无一读取 agent 模板字节**（`init-check-gate.ts:133`、`scope-check.ts:15-18`、`delivery-check-hash.ts:21,28-41`）→ 裁剪快照不会让任何已签 artifact 失效，§3 优化方案的安全前提成立。
- **2 条 low 发现**，均为本文档侧 drift（不影响任何量化结论或安全论证），已登记并随即修正：
  - `B-META-framework-audit:F-010`（C19）：story_get 引用路径 `core/story-query.ts` → 实际 `handlers/story-query.ts`（已修 §3.2 / 附录 A）。
  - `B-META-framework-audit:F-011`（C6）：§1.2 boundary 表已包含 `noHiddenContextSharing:true`，与 `lattice-handoff.ts` 源码一致。
- 查看：`lattice finding_list '{"storyId":"B-META-framework-audit"}'`。

**裁决：文档事实可靠，方案可确认。**

### B-bfb5 DEV 落地核验（local Non-authority evidence，2026-06-15）

本 story 已把 package agent templates 与 tracked `.claude/agents` / `.lattice-codex/agents` mirrors 中的重复全量 guide snapshot 替换为 `prompt-registry.ts` 中的 load-bearing prompt slice，并新增可执行 smoke：

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/prompt-token-cost-smoke.js
node packages/main/dist/tasks/prompt-registry-smoke.js
node packages/main/dist/cli.js verify_codex --storyId=B-bfb5 --json
```

实测（char/4 近似 token，仅代表灌入 prompt/context 的字节量，不代表已确认账单）：

| 范围 | baseline | after | delta |
|---|---:|---:|---:|
| 10 个 package snapshot-bearing templates | 632,687 B（~158,172 tok） | 115,317 B（~28,830 tok） | -517,370 B（~-129,343 tok） |
| package + `.claude` + `.lattice-codex` tracked mirrors 总量 | 1,987,273 B | 437,445 B | -1,549,828 B |

最大 caveat 不变：当前 smoke 证明的是本地 prompt 字节与近似 token 降幅，以及 safety phrases / mirror consistency / slim output invariants；**不能证明 provider prompt-cache billing 是否命中，也不构成 Authority Server receipt-backed completion / productionDone / receiptVerified / authorityDone / fullAuthorityDone。**

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| **Q1 接管能力** | **能，但分两层、有刻意收窄的边界。** 同仓库跨 session 可 `--takeover`/`--forceTakeover` 抢占 lease；跨 host 走 handoff pack（有界 overflow，authority/merge/DONE 不转移）。**不支持跨机器自动 adopt 半成品 story**——这是按设计的安全收窄，不是缺陷。 |
| **Q2 Token 成本** | **确实偏高，有确切证据。** 根因是 **10 份 package agent 模板各内嵌一整份 ~54–58KB 的 CLAUDE.md 副本**，占这些 subagent system prompt 的 **85–90%**。B-bfb5 后这 10 份 package templates 从 632,687 B 降到 115,317 B，减少 ~129K 近似 tokens；prompt-cache billing 仍是不确定项。 |
| **优化是否安全** | **是。** 已核验 gate 签名只签 story 数据、**从不读模板字节**，裁剪快照不会让任何已签 artifact 失效。唯一 load-bearing 的是快照里的 fresh-context fence 原文 + flow-fact 段，逐字保留即可。 |

---

## 1. Q1 — 跨 Host 接管 / 适应能力

Lattice 有两套独立机制，职责不同。

### 1.1 Story-owner-lease takeover（同仓库，跨 session）

源码：[`packages/main/src/core/story-owner-lease.ts`](../../packages/main/src/core/story-owner-lease.ts)

每个 story 一个 owner lease，带 heartbeat。第二个 session 抢占：

```bash
# 抢占一个 stale lease（>30min 无 heartbeat）
lattice story_advance --storyId=B-123 --phase=DEV --takeover
# 抢占一个仍活跃的 lease（强制）
lattice story_advance --storyId=B-123 --phase=DEV --forceTakeover
```

- `STALE_LEASE_THRESHOLD_MS = 30 * 60 * 1000`（story-owner-lease.ts:585）。
- 任何 story-scoped 变更命令（`story_advance` / `checklist_update` / `decision_set` …）经 choke-point gate `enforceStoryOwnerLeaseGate`（cli-engine.ts）自动转移 lease。
- `takeOverOwnerLease()`（story-owner-lease.ts:901-982）接受 `'takeover' | 'forceTakeover'`：纯 `--takeover` 拒绝活跃 lease，`--forceTakeover` 两者都转。

**硬边界（文件头第 9-26 行自述）**：
> "This is LOCAL session coordination, NOT a strong-identity security mechanism."

`sessionId` 来自 `LATTICE_SESSION_ID` / `CLAUDE_CODE_SESSION_ID` env，否则 `deriveLocalSessionId = sha256(hostname + root + ppid)[:16]`——**非密码学身份，只防并发误写，不防恶意，不跨机器。**

### 1.2 Handoff packs（跨 host，有界 "overflow"）

源码：[`packages/main/src/core/lattice-handoff.ts`](../../packages/main/src/core/lattice-handoff.ts) · [`packages/main/src/handlers/lattice-handoff.ts`](../../packages/main/src/handlers/lattice-handoff.ts)

这是**唯一**的跨 host 委派机制：

```bash
# Host A 打包
lattice handoff_create --storyId=B-123 --fromHost=A --toHost=B \
  --allowedPaths='src/foo/*' --baseSha=$(git rev-parse HEAD) --output=pack.json
# Host B 接受 + 取下一步
lattice handoff_accept  --file=pack.json   --output=accept.json
lattice handoff_resume  --file=accept.json --output=resume.json
```

权限边界 `HandoffAuthorityBoundary`（lattice-handoff.ts:42-53）写死：

| 字段 | 值 | 含义 |
|---|---|---|
| `owner` | `'lattice'` | story / scope / receipt / merge 权威留在原 host |
| `executor` | `'overflow-host'` | 第二 host 只执行有界任务 |
| `manualFirst` | `true` | 人工优先 |
| `noHiddenContextSharing` | `true` | 不隐式共享上下文 |
| `noAutoTrust` / `noAutoMerge` | `true` | 不自动信任 / 不自动合并 |
| `noEvidenceSubmit` / `noReceiptVerify` | `true` | 不替原 host 提交证据 |
| `noProductionDoneClaim` | `true` | 不能声明 DONE |

### 1.3 `authority:worktree, mirror:X` 是什么

跟跨 host **无关**。[`session.ts:770`](../../packages/main/src/handlers/session.ts#L770)：当 linked worktree 的 phase 与 main 分支元数据镜像不一致时，显示 `${phase} (authority:worktree, mirror:${mainPhase})`——同一仓库内"哪个位置是真相源"的消歧。

### 1.4 缺口（直接回答"不能适应吗"）

- ❌ **不能跨机器自动 adopt 半成品 story**：`buildHandoffWorktreeProjection`（lattice-handoff.ts:1019-1051）只**投影**出 worktree 的 create/cleanup 命令，不替你建、不迁移 phase。
- ❌ lease takeover **不跨机器**（sessionId 非密码学身份）。
- ✅ 能做的：同仓库跨 session 续作（lease takeover）+ 跨 host **有界委派**（handoff，authority 不转移）。

**一句话**：接管能力存在，但被**刻意收窄**为"手动优先 + 有界 + authority 不转移"。不是不能适应，而是为安全不让它自动适应。

---

## 2. Q2 — Token 成本的确切证据

### 2.1 证据①：模板 85–90% 曾是重复的 CLAUDE.md

落地前，每份大模板的 `<!-- koala:start -->` 到 `<!-- koala:end -->` 之间，是**一整份 CLAUDE.md 副本**。B-bfb5 后，该区段被替换为同一份 ~4.3KB load-bearing prompt slice，保留 fresh-context / process fact / reviewer run / Authority boundary 等安全文本。

| 模板 | baseline 总大小 | after 总大小 | delta | after koala block |
|---|---:|---:|---:|---:|
| lattice-evaluator.md | 57,931 B | 8,258 B | -49,673 B | 4,376 B |
| lattice-implementer.md | 63,463 B | 13,973 B | -49,490 B | 4,376 B |
| lattice-review-behavior.md | 63,499 B | 11,362 B | -52,137 B | 4,376 B |
| lattice-review-channel.md | 63,587 B | 11,450 B | -52,137 B | 4,376 B |
| lattice-review-concept.md | 61,085 B | 8,948 B | -52,137 B | 4,376 B |
| lattice-review-delivery.md | 64,505 B | 12,368 B | -52,137 B | 4,376 B |
| lattice-review-docs.md | 63,591 B | 11,454 B | -52,137 B | 4,376 B |
| lattice-review-quality.md | 60,804 B | 8,667 B | -52,137 B | 4,376 B |
| lattice-review-scope-plan.md | 63,354 B | 11,217 B | -52,137 B | 4,376 B |
| lattice-review-story-init.md | 70,868 B | 17,620 B | -53,248 B | 4,376 B |
| **合计** | **632,687 B（~158,172 tok）** | **115,317 B（~28,830 tok）** | **-517,370 B（~-129,343 tok）** | — |

- **10 份 package 模板曾各嵌一份**全量快照，package 层 ~517KB 重复已移除；同步 `.claude` / `.lattice-codex` mirrors 后，tracked 三份合计减少 ~1.55MB。
- 每次 spawn 不再把整份全量 guide 快照灌进该 subagent context；只保留 compact load-bearing slice + role-specific prompt。
- **test-coverage.md（4.4KB，无快照）能正常工作 → "瘦模板可行"已被框架自己证明。**

### 2.2 证据②：每个 story 的 token 账（char/4 ≈ token）

普通通道 story（4 个 checklist item、1 轮 review、baseline + 1 opt-in reviewer）≈ **11 次 subagent spawn**：

| 来源 | 单次 | 次数 | 小计 |
|---|---|---|---|
| DEV 实现者（每 item 一个 fresh worker，**无上下文复用**） | ~15.8K | 4 | **~63K** |
| REVIEW baseline：concept + quality | ~15.2K | 2 | ~30K |
| INIT / PLAN-scope / TEST-delivery reviewer | ~16K | 3 | ~48K |
| REVIEW opt-in（behavior 或 docs） | ~15.8K | 1 | ~16K |
| REVIEW baseline：test-coverage（瘦，无快照） | ~1.1K | 1 | ~1.1K |
| 命令输出灌进主 agent（story_get / checklist_get 等，循环重复调用） | — | ~10–25 | ~6–12K |
| **合计脚手架** | | | **~155K（区间 120K–195K）** |

其中 **~110–135K 纯粹是那份 CLAUDE.md 快照在 ~10 次 spawn 里的重复**。

### 2.3 证据③：已有省 token 措施（说明不是没人管，但都没动最大的肉）

| 措施 | 来源 | 评价 |
|---|---|---|
| advisory 走 stderr | B-6812（CLAUDE.md:684-688） | 已落地 |
| `--json` 结构化输出 | 各命令 | 已落地 |
| `--noSync` 跳过 git log 扫描 | CLAUDE.md:849 | 已落地 |
| `status` 一屏摘要 / finding_list 视图分组 | — | 已落地 |

**全部没碰模板快照这块最大的肉。** git log 中 `snapshot|token|drift` 相关 story（B-5a28 / B-eab3 / B-9bd9）都是别的事，**无任何一个 story 针对快照重复做过优化**。

> 关联：项目 memory 中已记一条待建 story —— "30 份 agent 模板内嵌 CLAUDE.md 快照漂移"。**该漂移问题与本 token 问题同根**（嵌全量快照），应合并处理。

### 2.4 ⚠️ 必须诚实标注的最大不确定性

- §2.2 的 155K 是 **"灌进各 context 的脚手架字节量，不是账单"**：**不含**实际工作（代码 diff、文件 Read、推理），也 **未假设 prompt cache**。
- 若 harness 对各 spawn 间**完全相同**的快照命中 prompt caching，真实计费会**显著更低**。现有证据**无法确认**是否命中缓存——这是整体置信度判为"中"、区间给得宽的原因。
- 但"每份模板 88% 是可去重的死重量"这一事实**独立于缓存成立**。

---

## 3. 优化方案（已做安全核验）

### 3.0 先纠正一个会误导决策的说法

调查中一份子报告称"共享 CLAUDE.md 会破坏签名稳定性"——**经源码核验，此说不成立**：

- `signInitCheck(storyId, backgroundHash, title, description, checklistHash, reviewRound)`（[init-check.ts:149](../../packages/main/src/handlers/init-check.ts#L149)）——init / scope / delivery 三个 gate 的 `_hash` **只签 story 数据，从不读模板字节**。
- [`managed-assets.ts`](../../packages/main/src/core/managed-assets.ts) 对模板算 hash 只为 doc-drift 的 `STALE / INCOMPATIBLE` 同步状态，**与 gate `_hash` 是两套独立机制**。
- **结论：裁剪 / 去重快照不会让任何已签 artifact 失效。**

唯一真正 load-bearing 的不是快照本身，而是快照里**两段文字**，必须**逐字保留**：

1. **fresh-context fence 原文**（防 reviewer 自我赦免；EXP-001 已证 subagent 与主 agent 机械不可区分，隔离**仅靠这段 prose** + 签名 + 行为约定，无机械强制）。
2. **flow-fact 段**：phase 机、gate 签名域、finding / review-pass 契约、debugging contract。

其余 ~50KB（Core/Shell 架构、worktree 生命周期、audit 配置、pre-push hook、目录结构）reviewer / implementer 根本用不到。

### 3.1 Lever 1（主菜）：全量快照 → 瘦切片　**实测 package 层省 ~129K 近似 tokens**

把大模板里的 57–71KB 全量 CLAUDE.md，换成 **~4.3KB 的 load-bearing 切片**（只留 fresh-context fence / flow-fact / reviewer run / delivery / Authority boundary / debugging contract 等该角色真正需要的段）。

- 量级参照：test-coverage.md（4.4KB）已证明可跑。
- **从单一真相源再生成**：load-bearing slice 登记在 [`prompt-registry.ts`](../../packages/main/src/core/prompt-registry.ts)，mirrors 继续由 [`managed-assets.ts`](../../packages/main/src/core/managed-assets.ts) / package registry render 机制校验；`prompt-registry-smoke` 现在检查 package ↔ `.claude` ↔ `.lattice-codex` mirror consistency。
- 实测效果：10 个 package templates 合计 ~158K tok → ~28.8K tok，减少 ~129.3K 近似 tokens。该数字仍是 prompt/context 字节近似，不是账单确认。

### 3.2 Lever 2：story_get / checklist_get 输出去重　**省 ~1.2–2.7K/查询轮，零风险**

[`story-query.ts`](../../packages/main/src/handlers/story-query.ts) 里 `story_get` 已内嵌完整 `checklist.items`，`checklist_get` 是逐字重复。加一个 **additive 的 `--slim` / fields 过滤**（默认输出不变，不破坏现有调用方），或让 agent 只调其一。不碰任何 gate。

### 3.3 Lever 3：控制 review 轮次 / 避免误触 opt-in reviewer（过程纪律）

docs reviewer 见任何 `.md` touchpoint 即挂载。**安全边界**：不要为"躲 docs reviewer"而不更新该更新的 `.md`——那会破坏 doc-promise gate。正解是不做纯格式的 `.md` churn，并把 PLAN / scope-check 质量做高让 Round 1 一次过（而非该补的 finding 不补）。

### 3.4 风险一览（来自对抗审查）

| Lever | 会破坏功能吗 | 关键约束 |
|---|---|---|
| 1 裁剪快照 | **maybe → 可控** | 逐字保留 fence 原文 + flow-fact 段；用 registry 再生成防漂移 |
| 2 输出去重 | **no** | additive，默认输出不变 |
| 3 控轮次 | **maybe** | 别把"少触 reviewer"做成"少更新该更新的文档" |

---

## 4. 审计要点 / 待确认项

1. **置信度**：方案大头（Lever 1 实测 package 层减少 ~129K 近似 tokens）的前提是"快照按 spawn 重复计入成本"；若证实 harness 命中 prompt cache，节省的**计费金额**会小于 token 数所示，但**死重量去除**这一架构收益不变。建议确认 harness 缓存行为后再定收益口径。
2. **load-bearing 边界**：Lever 1 的安全性完全取决于"fence 原文 + flow-fact 段逐字保留"。落地时需逐模板核对保留清单，并跑 `npm run test:process-fact-contract` 确认 process fact 未漂移。
3. **落地建议**：Lever 1 值得起一个正式 story（understanding + decision + checklist + plan.md），并合并收掉 memory 中那条 snapshot-drift 待建项；Lever 2 是顺手小补丁；Lever 3 是过程纪律，不需代码改动。

---

## 附录 A：证据文件索引

| 主张 | 文件:行 |
|---|---|
| lease 30min 阈值 | story-owner-lease.ts:585 |
| lease 非密码学身份自述 | story-owner-lease.ts:9-26, 101-142, 181-185 |
| takeOverOwnerLease 语义 | story-owner-lease.ts:901-982 |
| handoff 命令族 | handlers/lattice-handoff.ts:52-151 |
| handoff 权限边界 | core/lattice-handoff.ts:42-53, 381-400 |
| handoff worktree 仅投影 | core/lattice-handoff.ts:1019-1051 |
| authority/mirror 渲染 | handlers/session.ts:770, 687-735 |
| 模板内嵌快照 fence | .claude/agents/lattice-implementer.md:12, 909 |
| init-check 签名域（只签 story 数据） | handlers/init-check.ts:149 |
| 模板 hash 仅 doc-drift 同步 | core/managed-assets.ts:55-57, 474 |
| story_get 内嵌 checklist | handlers/story-query.ts:401-434 |

## 附录 B：方法与置信度

- 调查：5 路并行 agent（takeover / static-context / output-verbosity / subagent-fanout / existing-mitigations）→ 1 路量化建模 → 1 路对抗式安全核验。共 7 agent、~522,906 subagent token、181 tool use。
- 主 agent 二次核验：模板 fence 字节实测、签名域读源码确认、prompt-registry / global-thin 机制存在性确认。
- 换算：char/4 ≈ token，全程一致；快照单次按 ~14K token（保守偏大）。
- 置信度：**中**。最大不确定性 = prompt cache 是否命中（影响计费口径，不影响架构结论）。
