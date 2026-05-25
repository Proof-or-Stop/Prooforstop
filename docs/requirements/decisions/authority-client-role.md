# Koala CLI Authority Client Role (PD-1 Decision)

> **Status**: Decision recorded — 2026-05-25
> **Story**: B-4bd4 (decision-only; no production code changed)
> **Derivation**: `.koala/story/actives/B-4bd4/evidence/authority-client-role-decision.md`
> **Source audit**: `.koala/story/actives/B-0f04/evidence/cross-end-contract-audit.md` (AUDIT), `.koala/story/actives/B-0f04/evidence/codex-verification.md` (CODEX)

---

## PD-1 Decision

**Question**: Should Koala CLI become a first-class enforce-mode authority client, or stay a thin
local/shadow tool with MAC as the canonical runner for authority evidence?

**Answer**: **Koala CLI remains a thin local/shadow lifecycle client.** It must not claim or certify
L2+ authority evidence. MAC/runner/CI/human and the Python authority remain the canonical sources
for L2+ authority evidence. A first-class enforce-mode CLI authority client is **deferred** to a
future explicit product track once handshake, full evidence envelope submission, actor-key/signing/
runner identity, and server receipt verification are implemented and reviewed in dedicated stories.

---

## Current Decision

**Chosen role**: Option A — thin local/shadow client (the CLI's current deployed posture).

### What "thin local/shadow client" means

- The CLI's lifecycle gates (DONE/REVIEW/TEST) consume **local** evidence only. No lifecycle gate
  reads a server receipt.
- The CLI authority POST runs in off/shadow mode by default. The client-side `enforce` toggle in
  `authority-mode.ts` is **not** the same as being accepted by a production Python authority with
  `production_enforce_authority=true`; those are two orthogonal axes (per AUDIT matrix #8, lines
  154-156, 123).
- The CLI envelope (`buildEnvelope`) is a strict subset: it never populates `producerRunId` /
  `verifierRunId`, `provider` / `model` / `vendor`, or structured claims/coverage/negativeControls
  (AUDIT matrix #1/#4/#5, blocker B3; CODEX HV-1).
- The CLI carries only numeric `trustLevel` defaulting to `2`, with no preset awareness and no
  L3–L4 model (AUDIT matrix #3, advisory A2).

### What this decision does NOT change

- The existing transport (off/shadow POST path) continues to work as before.
- Local evidence and lifecycle gates are unaffected; no gates are added or removed.
- No production TypeScript, Python, or Swift code is modified by B-4bd4.

---

## L2+ Evidence Boundary

**Koala CLI must not claim or certify L2+ authority evidence** until the following gaps are
resolved in dedicated implementation stories:

| Gap | AUDIT ref | Status |
|-----|-----------|--------|
| No handshake (`clientName`, `clientVersion`, `commandCatalogDigest`, `evidenceSchemaDigest`, `authorityMode`) | B1 / matrix #8 | Absent |
| No actor-key registration, no runner heartbeat, envelope is unsigned | B2 / matrix #9 | Absent |
| `buildEnvelope` never populates run bindings or provider/model/vendor | B3 / matrix #1,#4,#5 | Absent |
| Server receipt (`AuthorityReceipt`) discarded; only `accepted` is checked | advisory A1 / matrix #2 | Absent |
| No `trustLevel` preset model; no L3–L4 gate handling | advisory A2 / matrix #3 | Absent |

Until all gaps above are resolved, a production Python authority configured with
`production_enforce_authority=true` will reject every CLI evidence POST with
`authority_enforce_required` / `authority_handshake_required` (AUDIT matrix #8, B1; CODEX HV-1).

**Canonical L2+ authority evidence sources remain**: MAC (local runner — actor-key, heartbeat,
ed25519-signed envelope); CI runner; human attestation via the Python authority's receipt
endpoints. These are not replaced or supplemented by the CLI in the current decision.

---

## Deferred Enforce-Mode CLI Requirements

If a future product track decides to make the CLI a first-class enforce-mode authority client,
the following must be implemented in separate, sequenced stories before the CLI may submit or
certify L2+ authority evidence:

| Requirement | Maps to | Priority if PD-1 = enforce |
|------------|---------|---------------------------|
| Full `EvidenceEnvelope`: run bindings, provider/model/vendor, claims/coverage/negativeControls | FU-1 / B3 / matrix #1,#4,#5 | Blocker |
| Authority handshake fields (`clientName`, `clientVersion`, `commandCatalogDigest`, `evidenceSchemaDigest`, `authorityMode`) | FU-2 / B1 / matrix #8 | Blocker |
| Actor-key registration + runner heartbeat + ed25519 envelope signing; **or** explicit doc that CLI is a non-runner and MAC is the sole runner | FU-3 / B2 / matrix #9 | Blocker |
| `AuthorityReceipt` signature verification (neither CLI nor MAC verifies this today) | advisory A1 / matrix #2 | Required |
| `trustLevel` preset model; L3–L4 gate handling | advisory A2 / matrix #3 | Required |

**No code for any of the above may land until the product track explicitly approves a PD-1 =
enforce decision.** Building FU-1/FU-2/FU-3 before that decision risks wasted work (AUDIT lines
166-167; CODEX lines 120-129).

---

## Implications for FU-1, FU-2, FU-3

| Follow-up | Scope | Status under current decision |
|-----------|-------|-------------------------------|
| **FU-1** — full `EvidenceEnvelope` in `buildEnvelope` (run bindings, provider/model/vendor, claims/coverage/negativeControls) | B3 / matrix #1,#4,#5 | **Deferred** — do not implement until enforce-mode PD-1 is approved |
| **FU-2** — authority handshake fields so Python can negotiate instead of hard-reject | B1 / matrix #8 | **Deferred** — same gate as FU-1 |
| **FU-3** — actor-key + heartbeat + ed25519 signing, or doc explicitly delegating runner role to MAC | B2 / matrix #9 | **Deferred (doc-only path available)** — if PD-1 stays "thin client", the doc-only resolution is: record in this file that CLI is a non-runner, MAC is the canonical runner, and FU-3 is permanently resolved by design (no code needed) |

### FU-3 doc-only resolution (applicable under current decision)

Because PD-1 resolves to "thin local/shadow client" with MAC as the canonical runner, **FU-3 is
resolved by design**:

- MAC already implements actor-key registration, runner heartbeat, and ed25519-signed envelopes
  (`AuthorityClient.swift:28-85`; `LocalRunnerService.swift:248,632-641`; AUDIT matrix #9; CODEX
  HV-2).
- The CLI is explicitly **not a runner** under the current decision. It is a lifecycle tool.
- No CLI code is needed for FU-3. This document is the durable record of that design choice.

FU-1 and FU-2 remain deferred until the product explicitly chooses the enforce-mode track.

---

## Implications for the Python Authority Preset Model

The Python authority's preset/limit/gate details (e.g., `anti-hallucination` as default preset,
`balanced-basic`, `balanced-heterogeneous`, `strict-ci`) are **external authority constraints**.
They are not locally-landed facts in this repo unless there is an explicit code/doc reference here.
Under the current thin-client decision, the CLI does not need to model or mirror Python presets.
(VCP-DOC §设计决策 / §Server 配合; AUDIT advisory A2 scoping presets as external.)

---

## Source Links

| Source | Role | Location |
|--------|------|----------|
| B-0f04 cross-end contract audit | Primary evidence for PD-1 inputs | `.koala/story/actives/B-0f04/evidence/cross-end-contract-audit.md` |
| B-0f04 Codex PM re-verification | Independent PM confirmation of audit claims | `.koala/story/actives/B-0f04/evidence/codex-verification.md` |
| B-4bd4 CHK-001 decision inputs | Derivation artifact (terms, citations, fact extraction) | `.koala/story/actives/B-4bd4/evidence/authority-client-role-decision.md` |
| Verification Context Pack | Defines locally-landed vs external authority constraints | `docs/requirements/decisions/verification-context-pack.md` |
| Truth-source management | Defines where human decisions must live | `docs/requirements/decisions/truth-source.md` |
| Role separation doc | Koala multi-role architecture reference | `docs/requirements/decisions/role-separation.md` |
| Story lifecycle | DONE/REVIEW/TEST gate policy | `docs/requirements/decisions/story-lifecycle.md` |
