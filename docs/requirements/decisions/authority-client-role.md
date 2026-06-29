# Proofbound CLI Authority Client Role (PD-1 / PD-2 Decisions)

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> **Status**: PD-1 decision recorded — 2026-05-25; PD-2 boundary recorded — 2026-05-27
> **Stories**: B-4bd4 (PD-1, decision-only; no production code changed), B-7e38 (PD-2, docs + smoke tests only)
> **Derivation**: `.lattice/story/actives/B-4bd4/evidence/authority-client-role-decision.md`
> **Source audit**: `.lattice/story/actives/B-0f04/evidence/cross-end-contract-audit.md` (AUDIT), `.lattice/story/actives/B-0f04/evidence/codex-verification.md` (CODEX)

---

## PD-2 Decision (Isolated Enforce Subsystem — B-7e38 Milestone 0)

**Question**: If a future product track enables a CLI-side authority runner, must it be
isolated from ordinary Proofbound workflow commands, and how should the four subsystem roles
be named so the boundary is cold-readable?

**Answer**: **Yes — isolated, opt-in, headless.** The four subsystem roles are:

| Role | Subsystem | L2+ evidence authority? |
|------|-----------|------------------------|
| **Ordinary Proofbound CLI** | Workflow thin client (`@lattice/core`, this repo) | **No** — transport / local only |
| **`lattice authority enforce`** | Future isolated opt-in headless runner path (this repo, future CLI command) | **Only after M2+ gates cleared** — see Milestone Routing below |
| **Python authority** | Receipt authority (separate Python repo) | **Yes** — signed `AuthorityReceipt` |
| **Mac Runner / Proofbound Runner CLI** | Execution plane (separate Mac/Swift + forthcoming Runner CLI repo) | **Yes** — actor key, heartbeat, signed envelope |

Key constraints recorded by this milestone:

- Ordinary Proofbound workflow commands (`lattice story_advance`, `lattice verification_evidence_add`, etc.)
  **must never** become or be treated as authority evidence submissions, regardless of future
  enforce subsystem wording in docs.
- `lattice authority enforce` **does not exist yet** as a command. Milestone 0 reserves the
  namespace only. No actor key, job claim, provider execution, full `EvidenceEnvelope`
  submission, or receipt signature verification is introduced by this story.
- PD-2 does **not** replace Mac Runner. The Mac Runner remains the sole execution plane
  owner of actor-key registration, runner heartbeat, and ed25519-signed envelopes for L2+
  evidence.
- PD-2 does **not** make existing local/shadow evidence authoritative. A submission with
  `accepted: true` from the transport remains `thin-client-transport-accepted`, never
  `receipt-backed-l2-plus`.
- Treating transport acceptance or local JSON as verified authority receipt evidence is
  **explicitly forbidden** under both PD-1 and PD-2.

### PD-2 Milestone sequence

| Milestone | Name | What may be implemented | What remains forbidden |
|-----------|------|------------------------|------------------------|
| **M0 (B-7e38)** | Boundary docs + smoke | Docs, mechanical classifier tests | All runner behavior; actor keys; job claim; provider execution; full envelope; receipt verification |
| **M1** | Policy discovery | `lattice authority enforce` command stub; policy query endpoint; no evidence submission | Actor key registration; job claim; execution; evidence signing; receipt verification |
| **M2+** | Actor identity, execution, receipts | Actor key registration; runner heartbeat; job claim; provider execution; full `EvidenceEnvelope`; receipt signature verification | Must not land before explicit enforce-mode product approval |

### M1: Policy Discovery Detail

M1 adds a command with two equivalent syntaxes: `authority_enforce_policy` (underscore form, Proofbound CLI dispatch style) and `lattice authority enforce policy` (space-separated CLI form). Both invoke the same handler; the underscore form is the internal command name and the space form is the user-facing alias.

**Ownership boundary**: the Python authority server **owns** policy discovery — it publishes `GET /v1/authority/policy` and defines the policy schema. The TypeScript CLI **consumes** that endpoint read-only; it has no authority to modify, sign, or version the policy.

The command reads the following fields from the Python `GET /v1/authority/policy` response:

| Field | Meaning |
|-------|---------|
| `contractVersion` | Policy schema version published by the Python server |
| `requiredAuthorityMode` | Authority mode the server currently requires from clients |
| `commandCatalogDigest` | Digest of the server's accepted command catalog |
| `evidenceSchemaDigest` | Digest of the server's current evidence schema |
| `evidencePolicy.preset` | Active evidence preset (e.g. `anti-hallucination`, `balanced-basic`) |
| `supportedAuthorityModes` | List of authority modes the server accepts |
| `compatibility` | Compatibility hints for negotiation between thin clients and the server |

Milestone 1 implemented read-only policy discovery only; actor keys, jobs, provider execution, evidence submission, and receipt verification remain unimplemented.

---

## PD-1 Decision

**Question**: Should Proofbound CLI become a first-class enforce-mode authority client, or stay a thin
local/shadow tool with MAC as the canonical runner for authority evidence?

**Answer**: **Proofbound CLI remains a thin local/shadow lifecycle client.** It must not claim or certify
L2+ authority evidence. MAC/runner/CI/human and the Python authority remain the canonical sources
for L2+ authority evidence. A first-class enforce-mode CLI authority client is **deferred** to a
future explicit product track once handshake, full evidence envelope submission, actor-key/signing/
runner identity, and server receipt verification are implemented and reviewed in dedicated stories.

### Proofbound CLI 0.3.5 Status Surfaces

Proofbound CLI 0.3.5 adds receipt-aware status commands for migration visibility:

- `authority_status` / `lattice authority status`
- `conduit_status` / `lattice conduit status`
- `conduit_explain` / `lattice conduit explain`

These commands are read-only diagnostics. They may report local
`LATTICE_AUTHORITY_MODE`, URL configuration, conduit availability, and supported
handoff/evidence surfaces, but they do not submit evidence, claim jobs, register
actors, run providers, sign envelopes, verify server receipts, or promote local
DONE to production DONE. Until verified receipt support exists, their JSON
contracts must keep `receiptVerified=false`, `productionDone=false`, and
`authorityChanged=false`. `authority_status` additionally reports
`canClaimProductionDone=false`; `conduit_status` does not expose that
authority-specific field.

The Mac App is not the authority/config source for this migration. It may remain
an optional dashboard/archive surface; production authority remains receipt
backed and external to the ordinary CLI path.

### B-a5c2 unattended scheduler authority boundary

The B-a5c2 `dispatch_auto` track is a policy-authorized scheduler for ordinary
execution hosts, not a new authority client. It may launch Claude Code, Gemini,
Codex, or fake workers only after user opt-in policy and host unattended-safety
checks pass. Those checks are authorization to start bounded local work; they
are not authorization to claim production completion.

Unattended worker artifacts remain local diagnostic evidence candidates:
transcripts, changed-file lists, command output, runner status, and local
receipts can inform `dispatch_review` and manual `dispatch_merge_plan`, but they
do not satisfy L2+ authority. A host transcript or local receipt must never set
`authorityChanged=true`, `receiptVerified=true`, or `productionDone=true`, and
must never auto-merge or auto-DONE a story. A verified production receipt still
requires the receipt-backed path described by PD-1 / PD-2.

### B-b710 — Enforce Readiness Diagnostics (Milestones 3-4)

> **Status**: B-b710 milestones 3-4 recorded — extends the receipt-aware status
> surface with enforce readiness diagnostics while preserving the PD-1 / PD-2
> thin-client posture.

`authority_status` and `conduit_status` are extended with an explicit
**readiness** section so users can tell `off` (intentional opt-out, free local
workflow) apart from `shadow` / `enforce` with missing prerequisites. Missing
prerequisites are surfaced as warnings, **not** as global blockers — ordinary
local Proofbound story development (`story_advance`,
`verification_evidence_add`, DONE) keeps working in every mode.

New readiness JSON fields (both `authority_status` and `conduit_status`):

| Field | Meaning |
|-------|---------|
| `mode` | Alias of `authorityMode` (`off` / `shadow` / `enforce`). |
| `localWorkflowUsable` | **Always `true`**. Local lifecycle gates do not depend on remote authority. |
| `authorityUrlConfigured` | Is `LATTICE_AUTHORITY_URL` set to a non-empty value? |
| `actorKeyConfigured` | Is `LATTICE_AUTHORITY_ACTOR_KEY` or `LATTICE_AUTHORITY_ACTOR_KEY_PATH` set? (Presence detection only — the CLI does not generate, hold, or sign with actor keys.) |
| `runnerConfigured` | Is `LATTICE_AUTHORITY_RUNNER_ID` set? (Presence detection only.) |
| `sessionConfigured` | Is `LATTICE_AUTHORITY_SESSION_ID` set? (Presence detection only.) |
| `readinessWarnings` | Actionable strings populated only when `shadow` / `enforce` is configured but prerequisites are missing. Empty when `mode='off'`. |
| `nextActions` | Suggested env / command fixes for each readiness warning. |
| `localWorkflowNote` | Reminder that readiness warnings are not global blockers. |

Constraints preserved by B-b710 (mechanical guard:
`packages/main/src/tasks/authority-status-smoke.ts`):

1. **No status/readiness path can flip `productionDone` or `receiptVerified` to
   `true`; `authority_status` also keeps `canClaimProductionDone=false`.** Not even when every readiness field is
   `true` (URL + actor key + runner id all configured): env presence alone is
   never authority. Only a future receipt-backed path that verifies a signed
   `AuthorityReceipt` may promote them, and that path is gated by PD-1 /
   PD-2 milestone routing.
2. **`authorityChanged` stays `false`** on `conduit_status`.
3. **Local workflow is never blocked.** `localWorkflowUsable: true` is a
   compile-time literal; missing enforce prerequisites become
   `readinessWarnings`, not a hard refusal to run lifecycle commands.
4. **`LATTICE_AUTHORITY_ACTOR_KEY` etc. are diagnostic env vars only.** B-b710
   does not introduce actor-key generation, registration, runner heartbeat,
   job claim, provider execution, envelope signing, or receipt verification.
   Those remain deferred per the Milestone Routing table below.

CLI ergonomics: both `--json` (shortcut) and `--format=json` work on
`authority_status` / `conduit_status` / `conduit_explain`, so
`lattice authority status --json` produces the readiness JSON directly without
remembering the long form.

### Dual-mode Autopilot Boundary

Proofbound autopilot is split into three explicit modes:

- `local` (default): pure local Proofbound workflow. It projects the ordinary story
  commands and never requires Python authority.
- `shadow`: local workflow plus authority readiness diagnostics. Missing Python
  authority prerequisites become warnings, not blockers.
- `authority`: fail-closed authority-backed projection. Python authority
  readiness is required, and a target of `DONE` also requires a signed
  `AuthorityReceipt` verified with the provided public key and explicitly bound
  by `receiptSubjectId` / `receiptSubjectKind`.

The command surface is:

- `autopilot_status` / `lattice autopilot status`
- `autopilot_doctor` / `lattice autopilot doctor`
- `autopilot_run` / `lattice autopilot run`
- `autopilot_execute` / `lattice autopilot execute`

`autopilot_run` is dry-run by default and is dynamically treated as read-only by
the command ownership policy. Only explicit `dryRun=false` may append a
story-scoped `autopilot_projection` event. That projection is coordination
metadata only: it is not lifecycle gate evidence, does not execute providers,
does not submit evidence, and cannot promote local DONE to production DONE.

`autopilot_execute` is the true bounded executor loop. It is always
story-scoped mutating for non-dry-run execution, requires a concrete `storyId`,
runs only safe argv-mapped Proofbound commands, and may append a
non-authoritative `autopilot_execution` event. That event is an execution audit
receipt only; it is not a Python `AuthorityReceipt` and cannot replace signed
authority subject binding for production DONE. Claude Code CLI repair is an
explicit local-mode repair hook and is disabled unless requested.

Mechanical guard: `packages/main/src/tasks/autopilot-authority-smoke.ts`
verifies local mode remains usable without Python authority, shadow mode stays
advisory, authority mode fail-closes without readiness or a DONE receipt, and no
JSON path overclaims `productionDone`, `receiptVerified`, or authority changes.
`packages/main/src/tasks/autopilot-execute-smoke.ts` verifies the local executor,
story binding, authority fail-closed behavior, and explicit Claude repair retry
path.

Docs that match this contract:
[`README.md`](../../../README.md) and [`docs/guide.md`](../../guide.md) document
the three modes so users know `off` is the default free/local workflow,
`shadow` is observational, and `enforce` requires Python authority + actor key
+ runner identity (and stays not-implemented until an explicit enforce-mode
product approval lands).

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
- The downstream CLI gate vocabulary stays aligned to the upstream Authority boundary: `main` and
  `human` remain the live gate-capable roles, and `mac_ui` stays legacy-only wording that must not
  reappear in the client contract.
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

## Trust Boundary (B-ec09 / Milestone 1 hardening)

Three roles, named so the boundary is cold-readable without prior context:

1. **Proofbound CLI — workflow client** (`@lattice/core`, this repo). Drives the
   Story lifecycle, runs local validations, and may POST observational evidence
   in `shadow` mode or transport-only evidence in `enforce` mode. **The CLI
   never produces production-grade authority evidence.**
2. **Proofbound Runner CLI / Mac Runner — execution plane** (separate Mac/Swift repo
   and forthcoming Runner CLI). Owns actor-key registration, runner heartbeat,
   ed25519-signed evidence envelopes, and the run identity that L2+ evidence
   binds to.
3. **Python Authority — receipt authority** (separate Python repo). Owns the
   authoritative receipt: only a signed `AuthorityReceipt` whose signature is
   verified against a registered actor key counts as production authority.

### Cold-read definition of L2+ authority

> **L2+ authority evidence** is production-grade authority evidence that is (a)
> bound to an independent actor / run identity — `producerRunId` and
> `verifierRunId` must both be present AND refer to **different** runs (a
> same-run envelope collapses the producer/verifier separation and is not L2+)
> — together with `provider`, `model`, `vendor`, and the artifacts the run
> produced (`commandDigest`, `transcriptHash`, `diffHash`), (b) carries an
> ed25519 signature from a registered runner actor key, and (c) is acknowledged
> by the Python authority via a signed `AuthorityReceipt` whose signature has
> been cryptographically verified by the consumer. Anything missing **any** of
> (a), (b), or (c) — including any of the command/transcript/diff hash
> bindings, or a verifier run id equal to the producer run id — is not L2+
> authority.

The Proofbound CLI envelope (`buildEnvelope` in
[`packages/main/src/core/authority-submit.ts`](../../../packages/main/src/core/authority-submit.ts))
is a strict subset that lacks (a), (b), and (c) by design under PD-1. The
boundary classifier
[`packages/main/src/core/authority-boundary.ts`](../../../packages/main/src/core/authority-boundary.ts)
enumerates the required fields (`producerRunId`, `verifierRunId`,
`independentVerifierRunId` — i.e., `verifierRunId !== producerRunId`,
`provider`, `model`, `vendor`, `commandDigest`, `transcriptHash`, `diffHash`,
`envelopeSignature`, `verifiedAuthorityReceipt`) and is the mechanical truth
source for "is this submission L2+?". A submission where `producerRunId` and
`verifierRunId` are both non-empty but equal is reported as missing the
`independentVerifierRunId` requirement and cannot classify as
`receipt-backed-l2-plus`, even if every other field is populated and
`receiptVerified=true` — the adversarial "same-run envelope" case is covered
by the `test:authority-boundary-smoke` adversarial test.

### Transport acceptance is NOT receipt verification

When the authority server returns `accepted: true` to a CLI POST, that is
**transport acceptance** of the submission. It is **not** verification of a
signed `AuthorityReceipt`. The CLI does not verify receipt signatures today and
must not present transport-accepted submissions as authoritative. The
classifier returns `thin-client-transport-accepted` for this case — never
`receipt-backed-l2-plus`.

### No overclaim by colocation

Colocating the CLI, runner, or authority code in one repo or one npm package
**does not** make CLI-shaped evidence authoritative. Authority is determined by
the mechanical L2+ requirements above, not by repository layout, package name,
build pipeline, or process boundary. A future Runner CLI shipped from this same
monorepo would still need to satisfy (a)+(b)+(c) before any of its evidence
counts as L2+.

### Milestone 1 scope

B-ec09 completes only M1: durable trust-boundary docs, the mechanical
classifier, a labeled transport-acceptance helper in `authority-submit.ts`, and
the `test:authority-boundary-smoke` adversarial test. M2 (Python authority
policy discovery, FU-5) is owned by the Cord Team Python authority repo, and
M5/FU-4 (Mac/Runner actor-key, heartbeat, runner identity) is owned by the
Proofbound Mac/Swift repo; both live in separate repos with their own Proofbound stories
and are **not** auto-opened by this story. M3–M6 remain routed per the table
below — M3 and M4 are CLI-side deferred follow-ups that require an explicit
enforce-mode product approval before any CLI authority-client code lands.

## L2+ Evidence Boundary

**Proofbound CLI must not claim or certify L2+ authority evidence** until the following gaps are
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
(VCP-DOC §Design Decisions / §Server Coordination; AUDIT advisory A2 scoping presets as external.)

---

## Milestone Routing

> Routing reflects the **current PD-1 decision: Proofbound CLI stays thin local/shadow**. CLI must
> not claim or certify L2+ authority evidence. Python authority and Mac runner remain canonical.
>
> Status values: **required** — work may proceed now; **deferred** — must not begin until an
> explicit enforce-mode product approval overrides PD-1 (or until deemed worth the cost for
> PD-1-independent items); **docs-only** — resolved by this document, no code needed;
> **not authority work** — owned by a different repo or team (Python authority, Mac runner);
> Proofbound CLI has no implementation obligation and cannot schedule or block this work.

| Milestone | Name | Owning repo / component | Status (PD-1 = thin-client) | Prerequisite | Validation expectation | User approval required |
|-----------|------|------------------------|-----------------------------|--------------|-----------------------|------------------------|
| **M2** | Python authority policy discovery (FU-5) | Cord Team Python authority — **separate repo; own Proofbound story** | **not authority work** — Cord Team initiative; Proofbound CLI has no implementation obligation; Python/Mac work is not current Proofbound CLI authority implementation | B-4bd4 decided (current story, complete) | Cord Team publishes `/v1/authority/policy` with versioned thin-client compatibility contract (`evidenceSchemaDigest` + required-field discovery), so a reduced-capability client can negotiate a lower trust level rather than be hard-rejected | No — Cord Team initiative; CLI team may request but cannot block |
| **M3** | CLI authority handshake fields (FU-2) | Proofbound CLI TypeScript — **this repo** | **Deferred** — must not implement until enforce-mode PD-1 explicitly approved | Explicit enforce-mode product approval; M2 policy contract (advisory input) | CLI sends `clientName` / `clientVersion` / `commandCatalogDigest` / `evidenceSchemaDigest` / `authorityMode`; production Python with `production_enforce_authority=true` accepts rather than returning `authority_handshake_required` | **Yes — enforce-mode product approval required before any code lands** |
| **M4** | Full `EvidenceEnvelope` in `buildEnvelope` (FU-1) | Proofbound CLI TypeScript — **this repo** | **Deferred** — same gate as M3 | Enforce-mode product approval; M3 (handshake implemented) | `buildEnvelope` populates `producerRunId` / `verifierRunId`, `provider` / `model` / `vendor`, and optionally `claims` / `coverage` / `negativeControls`; CLI evidence accepted at L2+ by production Python authority | **Yes — enforce-mode product approval required before any code lands** |
| **M5** | Actor-key / runner identity / envelope signing (FU-3, FU-4-runner) | **FU-3**: Proofbound CLI — **docs-only, resolved** (this document). **FU-4 runner portion**: Proofbound Mac/Swift — **separate repo; own Proofbound story** | **FU-3: docs-only / resolved** under thin-client posture — CLI is explicitly not a runner; MAC is the canonical runner (see §FU-3 doc-only resolution above). **FU-4 runner portion: not authority work** — MAC work in a separate repo; Proofbound CLI has no implementation obligation | FU-3: none (resolved by this document). FU-4: MAC/Cord team decision, unblocked by PD-1 | FU-3: this document is the durable record; no CLI code required. FU-4: MAC populates `model` / `vendor` + handshake `nil` fields in runner build; actor-key / heartbeat / signing remain MAC-owned | FU-3: No — resolved by design decision recorded here. FU-4: No — MAC team advisory, independent of CLI |
| **M6** | `AuthorityReceipt` signature verification + VCP cross-repo test (FU-4-receipt, FU-6) | **FU-4 receipt**: Proofbound Mac/Swift — **separate repo**. **FU-6**: Proofbound CLI (optional; pursue if deemed worth cost) | FU-4 receipt: **not authority work** — MAC work, separate repo; Proofbound CLI has no obligation. FU-6: **deferred** — independent of PD-1 enforce gate; may pursue if deemed worth cost | M5 FU-4-runner for MAC receipt; FU-6 independent | MAC cryptographically verifies `AuthorityReceipt` ed25519 signature (currently only JobSpec is verified). FU-6 (if pursued): fixture-based cross-repo VCP digest-equality test passes in CLI CI | No — advisory items; FU-6 requires no product approval; MAC is Cord team decision |

### Deduplication against known backlog (B-4622, B-da5b, B-0f04)

The Milestone Routing above does not re-propose any item from the following parked or
completed stories:

| Story | Phase | Topic | Overlap with M2–M6 |
|-------|-------|-------|--------------------|
| **B-4622** | INIT (parked) | `scope_check_save` PLAN-only evidence-hygiene gap — internal Proofbound CLI scope-check lifecycle (`command-policy.ts` allowedPhases, `story_review` PLAN→DEV gate) | None — different subsystem; not authority/receipt/envelope work |
| **B-da5b** | INIT (parked) | Post-DONE activity heartbeat recreating orphan `.worktrees/` dirs — worktree lifecycle bug | None — different subsystem; not authority/receipt/envelope work |
| **B-0f04** | DONE | Cross-end authority contract audit that produced the FU-1–FU-6 recommendations and the PD-1 question | Completed; M2–M6 are the forward routing from its recommendations, not a re-audit |

FU-1 / FU-2 / FU-3 / FU-6 all live in the Proofbound CLI authority-client subsystem
(`authority-submit.ts` / `authority-client.ts` / `authority-contracts.ts`) — a
different subsystem from B-4622's scope-check and B-da5b's worktree lifecycle.
Routing M2–M6 does not re-propose either parked backlog item.

Any Python authority (M2, M5/FU-4) or Mac runner (M5/FU-4, M6/FU-4) work must be
tracked as **separate stories in their own repos**, following each team's own Proofbound
flow. CLI stories in this repo may only implement CLI-owned items (M3, M4, M6/FU-6),
and only after the enforce-mode approval gate is cleared (M3, M4).

---

## `lattice authority enforce` Command Boundary (Milestone 1 Reserve)

The `lattice authority enforce` command namespace is **reserved** for a future isolated
headless runner path. The following rules apply until Milestone 2+ approval:

- **Milestone 0 (B-7e38)**: no command is introduced. This document and the boundary
  classifier + smoke tests are the only artifacts.
- **Milestone 1**: may add `lattice authority enforce` as a command stub that queries the
  authority policy endpoint only. It must not submit evidence, claim jobs, register actor
  keys, execute providers, sign envelopes, or verify receipts.
- **Milestone 2+**: actor key registration, runner heartbeat, job claim, provider
  execution, full `EvidenceEnvelope` submission, and receipt signature verification may
  be implemented only after an explicit enforce-mode product approval overrides PD-1.

Any code added under the `lattice authority enforce` namespace that bypasses this
sequencing — including direct evidence submission, receipt claims, or L2+ classification
without a full signed envelope + verified receipt — **must be rejected in code review**.

The mechanical truth source for "is this submission L2+?" remains
[`packages/main/src/core/authority-boundary.ts`](../../../packages/main/src/core/authority-boundary.ts).
The adversarial smoke tests in `packages/main/src/tasks/authority-boundary-smoke.ts`
guard against future wording changes silently promoting thin-client submissions.

---

## Milestone 0 Validation Record and Handoff (B-7e38)

**Status**: Milestone 0 complete — 2026-05-27

### What Milestone 0 completed

- Docs: PD-2 boundary recorded in this file (four-role table, prohibited actions,
  milestone sequence).
- Docs: `lattice authority enforce` command boundary reserved without implementing runner
  behavior.
- Smoke tests: `test:authority-boundary-smoke` adversarial suite guards the mechanical
  L2+ classifier (`authority-boundary.ts`) — normal workflow submissions remain
  `thin-client-*` even if future enforce-namespace wording exists in docs.
- Smoke tests: `test:authority-client` and `test:authority-evidence-flow` pass and confirm
  existing transport behavior is unchanged.
- **No** actor key registration, runner heartbeat, job claim, provider execution, full
  `EvidenceEnvelope` submission, or receipt signature verification was introduced.
- **No** existing authority-submit enforce mode or `accepted: true` transport response was
  promoted to L2+.

### What Milestone 1 may implement next

- A `lattice authority enforce` command stub that queries `/v1/authority/policy` (policy
  discovery only).
- Milestone 1 must not submit evidence, claim jobs, register actor keys, execute
  providers, sign envelopes, or verify receipts.

### What remains unimplemented until Milestone 2+

- Actor key registration and runner heartbeat (FU-3).
- Job claim and provider execution (FU-4-runner, owned by Mac/Swift repo).
- Full `EvidenceEnvelope` (`producerRunId`, `verifierRunId`, `provider`, `model`,
  `vendor`, `commandDigest`, `transcriptHash`, `diffHash`, `envelopeSignature`) (FU-1).
- `AuthorityReceipt` signature verification (FU-4-receipt, advisory A1).

---

## Source Links

| Source | Role | Location |
|--------|------|----------|
| B-0f04 cross-end contract audit | Primary evidence for PD-1 inputs | `.lattice/story/actives/B-0f04/evidence/cross-end-contract-audit.md` |
| B-0f04 Codex PM re-verification | Independent PM confirmation of audit claims | `.lattice/story/actives/B-0f04/evidence/codex-verification.md` |
| B-4bd4 CHK-001 decision inputs | Derivation artifact (terms, citations, fact extraction) | `.lattice/story/actives/B-4bd4/evidence/authority-client-role-decision.md` |
| B-7e38 Milestone 0 | PD-2 boundary + enforce namespace reserve + handoff | `docs/requirements/decisions/authority-client-role.md` (this file) |
| B-2522 CHK-002 enforce matrix | In-process smoke proving local/off stays free/local, shadow is warning-only, enforce fake receipt only classifies after receipt verification, enforce missing server fails closed, parallel_report stays non-authoritative with productionDone=false | `packages/main/src/tasks/authority-enforce-matrix-smoke.ts` |
| Verification Context Pack | Defines locally-landed vs external authority constraints | `docs/requirements/decisions/verification-context-pack.md` |
| Truth-source management | Defines where human decisions must live | `docs/requirements/decisions/truth-source.md` |
| Role separation doc | Proofbound multi-role architecture reference | `docs/requirements/decisions/role-separation.md` |
| Story lifecycle | DONE/REVIEW/TEST gate policy | `docs/requirements/decisions/story-lifecycle.md` |
