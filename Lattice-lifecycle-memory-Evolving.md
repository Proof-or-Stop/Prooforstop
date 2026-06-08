# Lattice Lifecycle Memory Evolving

## 执行结论

Evolving Work Lifecycle / lifecycle memory 对当前 Lattice **可行**，但可行形态必须是 **host-neutral lifecycle projection / contract layer**，不是新的 user-memory、agent-memory、personal memory 或外部记忆产品。

换句话说，Lattice 可以把已有的 Story、Lineage、Evidence、Recovery、Handoff、Capability、Dev Memory advisory context 投影成更清楚的「工作会记忆，生命周期会进化」叙事；但它不能接管 host persona、用户偏好、自动技能回放、自动信任、自动合并或生产完成权威。Lattice 记住的是「这件工作如何被定义、执行、证明、恢复、交接」，不是「这个 Agent 如何越来越懂用户」。

## 多 Host 分析摘要

| 来源 | 核心判断 | 主要依据 | 采纳方式 |
|---|---|---|---|
| Claude-A architecture reviewer | 可行，而且 Lattice 已覆盖 Story Memory、Lineage、Evidence、Recovery、Handoff、Frozen/Live 分离的大部分语义。真实增量应集中在 Thread/Trajectory 一等化、productionDone receipt 闭环和受控 recovery contract。 | `.omx/artifacts/claude-role-claude-a-architecture-reviewer-worktree-users-jek-docum-2026-06-08T09-36-18-528Z.md` | 采纳正向可行性，但把 L0/L1/L5、外部 memory provider、自动 skill replay 降级为非目标或未来待证实 gap。 |
| Claude-B skeptical reviewer | 提案中超过一半具体实现会越过 host-neutral、dev-memory non-authority、receipt/gate 语义边界；最小安全子集只有只读投影、Thread/Trajectory schema、经真实失败证明的 recovery contract。 | `.omx/artifacts/claude-role-claude-b-skeptical-reviewer-worktree-users-jek-document-2026-06-08T09-39-02-035Z.md` | 采纳边界约束，作为最终分类的 guardrail：没有 correctnessEvidence 的优化不进入 v0 或 future story。 |
| Codex host analysis | 从 Codex 视角可行，但应组装现有 lifecycle surfaces；host 输出只能是本地诊断、local evidence candidate 或 transcript，不能变成 production authority。 | `.omx/artifacts/lifecycle-memory-codex-B-f1d3.md` | 采纳 capability comparison 和测试建议，但不把 Codex/Gemini subprocess 写成当前已支持能力。 |

分歧解决：Claude-A 和 Codex 提供「可以如何表达」；Claude-B 提供「哪些不能做」。最终口径是 authority-preserving synthesis：host 输出是输入证据，最终分类以 Lattice 真相源和 gate 边界为准。

## 当前能力对比

| 分类 | 当前状态 | 与附件提案的关系 | Source refs |
|---|---|---|---|
| Host-neutral lifecycle infrastructure | 已是项目核心定位：Lattice/Koala 是 host-neutral CLI，Claude Code、Codex 等是 execution hosts；Lattice 持有 story、scope、receipt、merge authority。 | 直接支持「Lattice remembers the work」叙事。 | `docs/requirements/decisions/project-vision.md`, `docs/requirements/decisions/host-overflow.md` |
| Story / checklist / verification lifecycle | 已有 `INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE`，PLAN 记录 verificationIntent，DEV/REVIEW/TEST 记录 verificationEvidence 和 validation evidence。 | 覆盖附件的 Story Memory / Evidence Memory 主体。 | `docs/requirements/decisions/story-lifecycle.md`, `docs/requirements/decisions/testing-infra.md` |
| Lineage / recovery / observability projection | 已有 Canonical Story、lineage、recovery point、parallel evidence refs、read-only dashboard/console 设计；Thread/Trajectory 目前仍是 process-events 上的投影概念。 | 覆盖 L4 Lineage Memory 的大部分叙事；Thread/Trajectory 一等 schema 是真实后续 gap。 | `docs/requirements/decisions/host-neutral-observability-console.md`, `docs/requirements/decisions/lattice-parallel-wave.md` |
| Handoff / Host Overflow | 已有 manual-first handoff、dispatch、diagnostic receipt、bounded worktree、authority flags 固定 false；Claude Code real subprocess 需 policy opt-in，Codex/Gemini real-subprocess 仍为 scaffold/refused。 | 覆盖 Host-neutral Handoff Snapshot，但禁止把 host output 升级为权威。 | `docs/requirements/decisions/host-overflow.md` |
| Dev-memory | 已有轻量经验捕获，JSONL、可搜索、可 preflight；每条 entry 强制 `gateEvidence:false`、`authority:"non_authoritative"`。 | 可作为 advisory lifecycle context，不是 gate evidence。 | `docs/requirements/decisions/dev-memory.md` |
| Narrative-only delta | 「Work that remembers」「Hermes remembers the agent, Lattice remembers the work」「Run -> Evidence -> Lineage -> Recovery Pattern -> Better Next Run」是有用叙事，但本身不产生新 authority。 | 可用于文档表达；不能直接变成 storage、gate 或 auto-runner 需求。 | `/Users/jek/.codex/attachments/85e74934-0860-4165-a4d6-d1040d2a130a/pasted-text.txt` |
| True correctness / logic gaps | Thread/Trajectory 尚未一等 schema；receipt-backed productionDone 闭环未完成；跨 host recovery contract 只有在真实恢复失败被证明时才算 gap。 | 这些可以进入 future story，但必须带 correctnessEvidence、sourceRefs 和测试。 | `docs/requirements/decisions/host-neutral-observability-console.md`, `docs/requirements/decisions/host-overflow.md` |
| Non-goals | SQLite/vector DB/external memory provider、Hermes 式 personal memory、L0/L1 user profile、自动 skill replay、auto-trust/auto-merge/auto-DONE、宣称 Codex/Gemini real subprocess 当前可用。 | 附件中这些点不进入 Lattice v0。 | `docs/requirements/decisions/dev-memory.md`, `docs/requirements/decisions/host-overflow.md`, `docs/requirements/decisions/lattice-parallel-wave.md` |

## Host-neutral 对齐与约束

本方案必须遵守以下对齐规则：

1. Lattice 是 lifecycle infrastructure，不是 agent runtime。Host 可以执行，Lattice 负责 story/scope/evidence/receipt/merge 的结构化边界。
2. 不为了优化而优化。任何新 schema、命令、adapter 或 storage 提案必须先证明真实 correctness、recovery、handoff 或 logic consistency gap。
3. 不任意优化。不能因为「看起来更智能」就新增 SQLite、vector DB、外部 provider、自动 skill replay 或 prompt injection assembler。
4. 只修真实正确性问题。叙事更好听不是实现理由；本地 transcript 更完整也不是 gate evidence。
5. 保持逻辑一致性。dev-memory、parallel wave、handoff、observability snapshot 都必须继续显式保留 `productionDone=false`、`authorityChanged=false`、非权威 evidence refs 或 equivalent boundary。
6. Host 输出与 Lattice 权威分离。Claude、Codex、Gemini、Hermes、OpenHands、Devin 的 transcript 或 local PASS 只能作为 advisory/local evidence candidate，不能自动进入 REVIEW/TEST/DONE gate。

## 权威边界

`dev-memory` 和 host transcript 是 advisory / local evidence only：

- 不能满足 `verificationEvidence`。
- 不能满足 `review_pass_set`。
- 不能满足 delivery check。
- 不能满足 `koala validate` validation evidence。
- 不能生成或替代 signed receipt。
- 不能让 `productionDone=true`。
- 不能触发 auto-trust、auto-merge、auto-DONE。

如果未来某个 lifecycle projection 引用 dev-memory 或 transcript，输出中必须保留非权威字段或文案，例如 `gateEvidence:false`、`authority:"non_authoritative"`、`receiptVerified:false`、`productionDone:false`。引用它们的正确语义是「帮助人或 agent 理解上下文」，不是「证明任务完成」。

## 跨场景处理

当 Host 分析和 capability gap 分类同时发生时，本文档采用两步处理：

1. Host 输出作为输入证据：Claude-A、Claude-B、Codex 的 artifact、附件文本、manual transcript 可以帮助发现候选能力、风险和冲突。
2. 最终分类由 authority-preserving synthesis 决定：只有能被 Lattice docs / CLI contract / gate semantics 支持的内容，才可归为 existing capability 或 true gap；其余归为 narrative-only delta、advisory context 或 non-goal。

这避免把「某个 host 说可行」误读成「Lattice 已有权威能力」，也避免把怀疑性审查直接变成永久否决。Host 是证据来源，不是生产权威。

## 执行计划

| Phase | 范围 | 交付 | 测试 |
|---|---|---|---|
| v0: Documentation / contract first | 只产出本文件，固定 feasibility conclusion、边界、gap 分类、non-goals、testing matrix。 | `Lattice-lifecycle-memory-Evolving.md`。不修改 truth source 或 source code；Koala story metadata 只作为本 story 的正常流程证据存在，不作为 lifecycle-memory 新能力。 | `git show --check --stat --oneline HEAD -- Lattice-lifecycle-memory-Evolving.md`; `rg -n "productionDone|gateEvidence|non_authoritative|SQLite|vector|auto-DONE|Codex/Gemini" Lattice-lifecycle-memory-Evolving.md` |
| Phase 1: Contract hardening story, optional | 仅当团队决定把本方案提升为 truth source 时，新建后续 story 更新 requirements docs，仍不改 gates。 | Lifecycle projection contract，明确 existing/gap/non-goal taxonomy 和 authority vocabulary。 | docs_check：确认所有 non-goals、authority boundary、source refs 存在；manual review 三方 artifact 作为 advisory evidence。 |
| Phase 2: Thread / Trajectory projection, optional true gap | 只从现有 process-events / Canonical Story 投影 Thread 与 Trajectory schema；不新建 `.lineage.jsonl` 旁路。 | Read-only CLI JSON 或 Canonical Story 投影字段；老 story 无字段不崩。 | logic/cli：给定 process-events 输出 deterministic projection；空 events 不 crash；非法 event 跳过并产生 degradation；authority flags 不变化。 |
| Phase 3: Recovery resume contract, optional true gap | 只有在跨 host handoff 真实恢复失败可复现时做；contract 描述 phase、last completed step、required capabilities、degradation。 | Handoff pack 的 bounded resume contract；不包含 persona、user preference 或 hidden host context。 | cli/manual_transcript：handoff prepare/inspect 可见 resume contract；target host 缺 capability 时输出 degradation；host transcript 仍只作 local evidence。 |
| Phase 4: Receipt-backed production authority, separate roadmap | 这不是 memory story；依赖 receipt-backed verifier 真正端到端。 | server-receipt tier 可被 verified receipt 点亮。 | cli/gate：authority enforce matrix、receipt invalid/missing fail closed、local PASS 不能 productionDone。 |

v0 的边界是「把话说准」。后续只有当 gap 有真实 failure、source refs 和测试路径时才新建 story；否则保持 non-goal 或 advisory。

## 测试矩阵

| Evidence type | 目标 | 命令 / 证据 | 通过标准 |
|---|---|---|---|
| docs_check | 本文件包含必需标题、结论、三方摘要、能力分类、权威边界、non-goals、执行计划和测试矩阵。 | `rg -n "^# Lattice Lifecycle Memory Evolving|可行|host-neutral|non_authoritative|auto-DONE|SQLite|Codex/Gemini" Lattice-lifecycle-memory-Evolving.md` | 所有关键短语可定位；没有把 non-goal 写成 current capability。 |
| docs_check | 已提交版本的 Markdown 无尾随空白或 patch 格式问题。 | `git show --check --stat --oneline HEAD -- Lattice-lifecycle-memory-Evolving.md` | 命令 exit 0。 |
| manual_transcript | 三方 Host 分析被作为输入证据读取，不作为权威结论直接采纳。 | 附件：`/Users/jek/.codex/attachments/85e74934-0860-4165-a4d6-d1040d2a130a/pasted-text.txt`；artifacts：`.omx/artifacts/claude-role-claude-a-architecture-reviewer-worktree-users-jek-docum-2026-06-08T09-36-18-528Z.md`、`.omx/artifacts/claude-role-claude-b-skeptical-reviewer-worktree-users-jek-document-2026-06-08T09-39-02-035Z.md`、`.omx/artifacts/lifecycle-memory-codex-B-f1d3.md` | 文档有三方摘要和 disagreement resolution；authority boundary 不由 host 输出覆盖。 |
| cli | story 当前处于正确 owner/worktree/cwd lifecycle 上下文。 | `koala session_brief` | 输出 story `B-f1d3`、owner/worktree/cwd 为 `.worktrees/B-f1d3`，并报告当前 lifecycle phase；不要求固定为 DEV。 |
| cli | 若后续 story 实现投影能力，验证不污染 gate authority。 | `npm --prefix packages/main run test:authority-enforce-matrix`; `npm --prefix packages/main run test:lattice-parallel-wave-smoke`; `npm --prefix packages/main run test:lattice-handoff-smoke` | 所有 projection / handoff / wave 输出保持非权威边界，不能产生 production authority。 |
| cli | 若后续 story 修改 process facts、gate evidence 或 lifecycle registry，验证 registry 不漂移。 | `node scripts/verify-process-fact-contract.mjs`; `node scripts/verify-runtime-fact-contract.mjs` | 新事实必须登记；runtime facts 不混入 process facts。 |
| cli | TEST 阶段最终项目验证。 | `koala validate --story=B-f1d3` | 仅在 story 进入 TEST 且所有 checklist evidence 齐全时作为 validation evidence；v0 文档阶段不伪造该 evidence。 |

## 非目标

以下内容明确不属于本方案 v0，也不应被未来文档当作已采纳能力引用：

- SQLite、DuckDB、vector DB、Mem0、Supermemory、Honcho 或任何 external memory provider。
- Hermes-style personal memory、SOUL.md 替代品、用户偏好长期画像、agent identity registry。
- automatic skill replay、自动从成功 story 抽取并执行 playbook、自动 prompt 注入顺序管理。
- auto-trust、auto-merge、auto-DONE、自动 claim `productionDone=true`。
- 把 dev-memory、host transcript、本地 PASS、本地 diagnostic receipt、observability snapshot 当成 gate evidence。
- 新建 `.lineage.jsonl` 作为绕开 process-events / signed artifact 的证据旁路。
- 把 Codex/Gemini subprocess support 写成当前能力；当前 Host Overflow 口径中 real-subprocess 主线仍是受控 Claude Code opt-in，Codex/Gemini 不能被宣传为已可真实派发。
- 为了优化任意增加 storage、adapter、daemon、dashboard write path 或 Lattice core persona 语义。
