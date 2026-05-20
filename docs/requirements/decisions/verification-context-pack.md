# Verification Context Pack

## 背景

2026-05-20，Koala Python authority server 引入更严格的 authority evidence gate：L2 verifier 不能只提交自然语言结论，而应提交可追踪、可重放、可覆盖的结构化证据。Koala CLI 需要同步这个协议，否则 verifier 仍可能漏看关键 diff、使用弱测试命令，或者把没有覆盖 artifact 的结论交给服务端。

这个文档是 Orchestrate 侧的长期真相源，用来说明 Koala CLI 与 Python authority server 在 Verification Context Pack 上的配合关系。

## 设计决策

Koala CLI 负责机械生成 Verification Context Pack。Python authority server 负责签发 verifier job、校验 evidence envelope、执行 gate adequacy。两边的字段、digest 规则和默认覆盖语义必须保持一致。

Context Pack 是 verifier 的默认阅读边界，不是自然语言建议。它应包含 changed files、changed hunks、changed symbols、source snippets、checklist item ids、test intent refs、oracle refs、required commands、risk tags、limitations、token budget、truncated 标记，以及扩展包的 parent digest。

Verifier 可以请求扩展 context，但扩展必须带 `expansionReason`，并受服务端 `maxContextPackExpansionDepth` 与 `maxContextPackEstimatedTokens` 限制。扩展不是绕过上下文包，而是形成 parent-linked pack chain。

## CLI 责任

- `verification_context_pack_create` 从当前 git diff 机械生成 pack，不写 story metadata。
- `verification_context_pack_expand` 基于 parent pack 生成受控扩展，必须说明扩展原因。
- `digestVerificationContextPack` 与 Python `VerificationContextPack.digest()` 保持 canonical digest parity。
- `buildTargetBoundEvidenceEnvelope` 和 `EvidenceCollector` 默认把 context pack required refs 纳入 `coveredRefs`，并填充 `verificationContextPackId`、`verificationContextPackDigest`、`inspectedPackRefs`。
- CLI command policy 中这两个命令应为 read-only / all phases / non-destructive。

## Server 配合

Python authority server 的 verifier job 会绑定 signed context pack 和 digest。提交 L2 evidence 时，服务端会检查 evidence 中的 pack id、digest、producerRunId、diffHash 是否和 server-issued verifier job 一致。

Gate adequacy 会要求 pack 中的 files、hunks、oracle refs、test intent refs、required commands 等被覆盖，否则 evidence 不足。

生产环境启用 `anti-hallucination` 或 `strict-ci` preset 时，verifier job 必须携带 context pack。

## 验证命令

CLI 侧至少运行：

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:verification-context-pack
npm --prefix packages/main run test:command-ownership-contract
```

Python authority server 侧对应回归：

```bash
uv run pytest -q
```

## 后续维护规则

以后修改 Koala CLI 的 authority/evidence/context-pack 相关代码时，必须先按 Orchestrate 的 Koala story flow 建立或恢复 Story，并运行 `koala session_brief` 与 `koala aux_doc_list`。除非用户明确要求快速修补，否则不要绕过 Story/checklist/verificationEvidence。

凡是修改以下内容，都要同步检查 Python authority server 的协议字段和测试：

- `packages/main/src/core/authority-contracts.ts`
- `packages/main/src/core/evidence-collector.ts`
- `packages/main/src/core/verification-context-pack.ts`
- `packages/main/src/handlers/verification-context-pack.ts`
- `packages/main/src/cli-engine.ts`
- `packages/main/src/core/command-policy.ts`

对应 Python 侧重点检查：

- `cord_team.schemas.verification.VerificationContextPack`
- `cord_team.schemas.command.EvidenceEnvelope`
- `cord_team.services.job_scheduler`
- `cord_team.services.authority_records`
- `cord_team.domain.evidence_adequacy`
- `cord_team.services.gate_service`
