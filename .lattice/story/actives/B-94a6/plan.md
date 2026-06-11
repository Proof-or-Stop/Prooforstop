# Plan: B-94a6 Implement authority evidence submission for verification evidence commands

## 总览

在 post-B-2157 干净 main 上**新增** authority evidence submission：verification_evidence_add /
batch_add 在 `withChecklistLock` 内先完成完整本地 preflight，再按 mode 决定是否 / 如何发
authority POST。架构 = **A-prepost**（decision.json，用户 2026-05-21 拍板）：完整本地
preflight → authority POST → POST 成功才写本地 evidence；**不做 compensating rollback**。

**Mode 语义（KOALA_AUTHORITY_MODE，缺省/空/非法 → off）**：
- `off`：行为字节等同 post-B-2157 main，零网络。
- `shadow`：best-effort warning——preflight 通过后尝试 POST，任何 authority 结果（含异常抛出）
  都不改变/不阻塞本地 evidence；失败仅 stderr 一行 `[warning]`；本地照写、exit 0。
- `enforce`：严格——authority POST 失败 → 0 本地写入、exit 非零（不为离线可用性削弱）。

**additive-only 硬约束（用户 2026-05-21）**：authority-contracts.ts / evidence-collector.ts
只新增 submission 协议类型 + helpers；B-2157 已交付的 VCP digest / normalization / pack
behavior 字节不变（digestCanonical / digestCommand / digestVerificationContextPack /
normalizeVerificationContextPack / buildTargetBoundEvidenceEnvelope /
prepareEvidenceEnvelopeForSigning / parseVerificationContextPackContract / canonicalJson /
全部 VerificationContextPack* / EvidenceEnvelopeContract* schemas / EvidenceMaterial /
EvidenceCollector 既有行为）。**任何 test:verification-context-pack-smoke 或
test:process-fact-contract 失败 = hard blocker**（block REVIEW→TEST，回 DEV 修）。

**config**：`KOALA_AUTHORITY_MODE` + `KOALA_AUTHORITY_URL` env，CLI 可用 `authorityMode` /
`authorityURL` 参数内联覆盖（沿用 stash@{3} 既定形状）。authority 不新增独立 koala 命令，是
verification_evidence_add / batch_add 的行为。

**reference**：stash@{3} 的 authority 子集（authority-client / authority-mode / contracts
super-set / 3 smoke）仅作形状参考；checklist.ts 按 4 blocker **重写**，不 cherry-pick stash
版本（它把 POST 放 lock 外、本地校验前——本 story 要消灭的 bug）。

## CHK-001: Add authority-client.ts + authority-mode.ts + smoke tests + package scripts + CLI wiring (no checklist.ts logic change)

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/authority-client.ts, packages/main/src/core/authority-mode.ts, packages/main/src/tasks/authority-client-smoke.ts, packages/main/src/tasks/authority-evidence-flow-smoke.ts, packages/main/src/tasks/verification-evidence-authority-handler-smoke.ts
- Modify (additive only): packages/main/src/core/authority-contracts.ts（加 submission request/response 类型 + helpers）, packages/main/src/core/evidence-collector.ts（按需加 submission helper）, package.json + packages/main/package.json（test:authority-client / test:authority-evidence-flow / test:verification-evidence-authority-handler scripts）
- Modify (仅当暴露新命令时): packages/main/src/registry.ts, packages/main/src/core/command-policy.ts, packages/main/src/core/process-fact-registry.ts, packages/main/src/cli-engine.ts
- Test: packages/main/src/tasks/authority-client-smoke.ts

**实现要点**:
- authority-mode.ts：解析 KOALA_AUTHORITY_MODE → off|shadow|enforce，未设/空/whitespace/非法 → off；runtime 复校（CLAUDE.md Handler 编码约定，非仅 Zod）。
- authority-client.ts：HTTP client，POST evidence envelope 到 KOALA_AUTHORITY_URL；区分 success / HTTP 错误 / timeout / connection-refused / throw 各路径（供 shadow 降级与 enforce 严格判定）。
- authority-contracts.ts 扩展**只加新 export**——禁碰「总览」列出的受保护名；reviewer 会 diff 校验既有 export body 字节不变。
- 本 item **不**改 checklist.ts。authority 子系统独立可编译、3 smoke 独立通过。
- 若新增 koala 命令：每条补 ownershipClass + PROCESS_FACT_REGISTRY 条目（否则 command-ownership-contract / process-fact-contract fail）。预期不新增命令（authority 走既有命令参数）。

**Verify**:
- `npm --prefix packages/main run build` 绿；递归 tsc 绿
- `npm run test:authority-client` / `test:authority-evidence-flow` / `test:verification-evidence-authority-handler` 绿
- `npm run test:command-ownership-contract` / `test:process-fact-contract` / `test:verification-context-pack-smoke` 绿（后三者 = hard blocker，证明 additive 无 VCP 回归）

**DoneWhen**: 两个新核心文件 + 3 smoke + scripts 落地；authority-contracts/evidence-collector 仅 additive 扩展且 VCP exports 字节不变；build + 6 条测试全绿；checklist.ts 未动。

## CHK-002: Wire authority POST into verification_evidence_add and batch_add with local-validation-first invariant (Blockers 1+2)

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/checklist.ts（verification_evidence_add ~line 457 + verification_evidence_batch_add ~line 508）
- Test: packages/main/src/tasks/authority-evidence-flow-smoke.ts

**实现要点**:
- 全部既有本地校验留在 `withChecklistLock` 内、最先执行（storyId/itemId/intentRef/note≥5/waiverType-kind/checklist item 存在 …）。
- 仅本地 preflight 全过后才调 authority-client（顺序：preflight → POST → POST 成功才写本地 evidence，对齐 A-prepost）。
- batch_add：先校验**所有** entry，再一次 batch POST，POST 成功才写**所有**本地 evidence——all-or-nothing。
- **不**在 lock 外调 authority；**不** cherry-pick stash@{3} 的 checklist.ts（其 submitChecklistAuthorityEvidence 在 lock 前、校验前）。
- mode=off 时整段 authority 逻辑短路（零网络、行为同 post-B-2157）。

**Verify**:
- `npm run test:authority-evidence-flow` 绿，含回归：非法 itemId → 本地 exit 非零 + authority POST 计数 0；batch 任一非法 → 整批 0 POST + 0 本地写入
- `koala validate --story=B-94a6` 绿

**DoneWhen**: add + batch_add 都是 preflight-first；本地校验失败 → 0 POST + 0 本地写入（单条 + batch all-or-nothing）；off 模式行为不变。

## CHK-003: Implement shadow mode: warning-only, zero impact on local evidence (Blocker 3)

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/handlers/checklist.ts（shadow 分支）, packages/main/src/core/authority-mode.ts（如需）
- Test: packages/main/src/tasks/authority-evidence-flow-smoke.ts

**实现要点**:
- shadow：preflight 通过 → 尝试 POST（best-effort）→ **无论** authority 结果（success / 5xx / timeout / connection-refused / client throw）都照写本地 evidence、exit 0。
- authority 交互包 catch-all：任何失败降级为 stderr 一行 `[warning] authority POST failed: ...`；不进 stdout、不改 exit code、不 rollback。
- smoke 注入 5xx / timeout / connection-refused / throw 四类失败，断言：本地写入 + exit 0 + stderr warning。

**Verify**:
- `npm run test:authority-evidence-flow` shadow case 绿（失败 server 下本地照写、exit 0、stderr warning）
- `koala validate --story=B-94a6` 绿

**DoneWhen**: shadow 下 authority 任何结果都不污染/不阻塞本地 evidence；失败仅 stderr warning；exit 0。

## CHK-004: Implement enforce mode: no local/remote fact divergence on failure (Blocker 4)

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/handlers/checklist.ts（enforce 分支）
- Test: packages/main/src/tasks/authority-evidence-flow-smoke.ts

**实现要点**:
- enforce：preflight → authority POST，**POST 成功才写本地 evidence**；POST 失败 → 0 本地写入、exit 非零（pre-POST，A-prepost）。
- **不做 compensating rollback**（不先写后删——避免 kill-9 二阶段分叉窗口）。
- batch_add enforce：authority 拒整批 / 部分拒 → 映射为整批失败 → 0 本地写入。
- 不为离线可用性削弱 enforce：server 不可达 = 本地写也失败，这是 enforce 的预期语义。

**Verify**:
- `npm run test:authority-evidence-flow` enforce case 绿（失败 server → 0 本地写入 + exit 非零；后续 checklist_get 确认无该 entry）
- partial-accept 映射为整批失败的 smoke 绿
- `koala validate --story=B-94a6` 绿

**DoneWhen**: enforce 下 authority 失败 → 本地始终无该 entry（无分叉窗口、无 rollback）；batch all-or-nothing；不削弱 enforce 严格性。
