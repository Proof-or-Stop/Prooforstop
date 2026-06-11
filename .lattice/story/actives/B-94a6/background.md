## 触发事件
2026-05-21 用户验收 B-8a1b（tiny chore，merged 69f0809a）后核查 main 状态。B-2157 已正式交付 Verification Context Pack（merged af22307e），main 现含 VCP 4 个文件 + authority-contracts.ts (443 行) + evidence-collector.ts (47 行)。当前 main 的 checklist.ts 是 **clean lock-first 结构**（verification_evidence_add ~line 457 与 batch_add ~line 508 全部 logic 在 withChecklistLock 内、零 authority 调用）。stash@{3} 19 文件 WIP 里的 authority 子系统（authority-client / authority-mode / 3 smoke + 1 集成 smoke）和 checklist.ts authority 改动（92 行）**尚未合**——其中 stash 把 authority POST 放在 lock 外、本地校验之前，违反「local 优先」硬约束。

## 关键洞察
经独立核查（draft-check v1 抓出事实错误后纠正）：(a) **authority-contracts.ts 与 evidence-collector.ts 已存在于 main**——B-2157 shipped 的是 VCP 用的 envelope 结构（VerificationContextPackContract / EvidenceEnvelopeContract / canonical-json / digest / buildTargetBoundEvidenceEnvelope 等），**不包含**任何 submission / POST / client / mode 协议（grep 'submit|POST|send' 在 authority-contracts.ts 零命中）。(b) authority-client.ts 与 authority-mode.ts 在 main 不存在，是真正需要新增的核心文件。(c) 三个 authority/integration smoke + test:authority* package scripts 全部不存在。因此 Story 2 真实 delta = 新增 client/mode + smoke + scripts + checklist.ts authority 接入；同时 **有限地扩展** authority-contracts.ts / evidence-collector.ts 加 submission 协议类型 + helpers——具体增什么由 PLAN 阶段读现状决策。

## 方案取舍
**不**整包 `git stash pop stash@{3}`——只按文件挑出 authority 子集（client + mode + 3 smoke + 1 集成 smoke + package scripts authority 部分）作为 *参考*，checklist.ts 与新增/扩展模块的实现按 4 blocker 重写、不 cherry-pick stash 的错版本（它把 POST 放 lock 外）。

**用户 2026-05-21 拍板的 additive-only 硬约束**（必须严格遵守，违反任一即 Story scope 越界）：
- 允许在 main 既存的 `authority-contracts.ts` / `evidence-collector.ts` **只新增** submission 协议类型和 helpers（request/response schemas、submission 工具函数）；
- **不得修改** B-2157 已交付的 VCP digest / normalization / pack behavior——具体禁碰的现有 exports 包括（不限于）`digestCanonical` / `digestCommand` / `digestVerificationContextPack` / `normalizeVerificationContextPack` / `buildTargetBoundEvidenceEnvelope` / `prepareEvidenceEnvelopeForSigning` / `parseVerificationContextPackContract` / `canonicalJson` / 全部 VerificationContextPack* / EvidenceEnvelopeContract* schemas / 既有 EvidenceMaterial / EvidenceCollector 行为；
- **任何 VCP smoke 或 process-fact-contract 失败都视为 hard blocker**——不是「找到再决定」，而是必须 block REVIEW→TEST、必须回 DEV 修；相关测试 = `test:verification-context-pack-smoke` 与 `test:process-fact-contract`。

**严格 out of scope**：VCP 任何文件（B-2157 已交付）、stash@{2} koala-vcp-flow-migration（已被 B-2157 supersede）、stash@{0}/{1} 的 B-7f2d/B-2157 leftover（用户已处理）、改动 main 上 authority-contracts.ts 既有 VCP exports 的任何字节、改动 evidence-collector.ts 既有 EvidenceMaterial / EvidenceCollector 行为。

## 对话纹理
用户 2026-05-21 拍板的 4 个硬 blocker 必须进 checklist：(1) verification_evidence_add/batch_add 不能先 POST authority 再本地校验。(2) 本地 story/item/note/kind 校验失败时，authority server 必须收 0 次 POST。(3) shadow 模式只能 warning、不破坏本地 evidence。(4) enforce 模式失败语义明确：失败时不能制造本地/远端事实分叉。用户同时明确：选 additive 但**只能新增 submission 协议类型和 helpers**；不得修改 B-2157 已交付的 VCP digest/normalization/pack behavior；任何 VCP smoke 或 process-fact contract 失败都视为 blocker。
