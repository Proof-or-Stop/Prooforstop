# B-4bd4 Authority Client Role Decision (PD-1)

This file is the **derivation / evidence artifact** for PD-1: should Koala CLI be a
thin local/shadow lifecycle client, or a first-class enforce-mode authority client?

It is written by Claude Code (koala-implementer) as decision evidence only. **No
production TS / Python / Swift code is modified by this story.** Codex acts as
PM/verifier.

Scope of this checklist item (CHK-001): collect the **source-backed decision inputs**
needed to make the call. The actual recommended role lands in CHK-002
(`docs/requirements/decisions/authority-client-role.md`, not yet created) and the
Milestone 2-6 routing table lands in CHK-003.

All facts below are extracted from existing sources — nothing here is re-derived by
fresh code inspection:

- `.koala/story/actives/B-0f04/evidence/cross-end-contract-audit.md` (the cross-end
  contract audit; cited as **AUDIT** with its matrix row `#n`, blocker `Bn`,
  advisory `An`, or follow-up `FU-n`).
- `.koala/story/actives/B-0f04/evidence/codex-verification.md` (independent PM
  re-verification; cited as **CODEX** with its claim `HV-n`).
- `docs/requirements/decisions/truth-source.md` (cited as **TRUTH-SOURCE**).
- `docs/requirements/decisions/verification-context-pack.md` (cited as **VCP-DOC**).

Code line references that appear below (e.g. `authority-submit.ts:68-89`) are quoted
**as recorded in AUDIT / CODEX at the B-0f04 audit HEAD**; per AUDIT they are anchors,
not frozen offsets. This story did not re-inspect production code.

## PD-1 Decision Inputs

### Terms (defined inline so a new agent needs no chat context)

- **PD-1** — the product decision raised by the B-0f04 audit: *"Should Koala CLI
  become a first-class enforce-mode authority client, or stay a thin local/shadow tool
  with MAC as the canonical runner?"* PD-1 subsumes AUDIT matrix #7 (the gate-authority
  boundary: should DONE/REVIEW/TEST require a signed Python gate/evidence receipt?) and
  the overall CLI submission posture (#9). It is a cross-repo product call, *not* a code
  task. (AUDIT "Product decision" §, lines 158-167.)

- **FU-1 / FU-2 / FU-3** — three Koala-CLI-owned follow-up stories proposed by the
  AUDIT follow-up table (lines 214-216). The task scope for this story names **FU-1 /
  FU-3**; FU-2 is defined here too because it sits between them:
  - **FU-1** — model + populate the full `EvidenceEnvelope` in `buildEnvelope` (run
    bindings, provider/model/vendor; optionally claims/coverage/negativeControls). Maps
    to blocker **B3** / matrix #1,#4,#5. Priority: *Blocker-if-PD-1; else defer.*
  - **FU-2** — add authority handshake fields to the CLI authority client so a
    production Python authority can negotiate instead of hard-reject. Maps to **B1** /
    #8. Priority: *Blocker-if-PD-1; else defer.*
  - **FU-3** — add actor-key registration + runner heartbeat + ed25519 envelope
    signing, **or** explicitly document CLI as a non-runner and delegate the runner role
    to MAC. Maps to **B2** / #9. Priority: *Blocker-if-PD-1; else doc-only.*

  All three are blockers **only if** PD-1 resolves to "CLI must be an enforce-mode
  client" (AUDIT lines 169-190; CODEX HV-1/HV-2 conclusions).

- **L2+** — authority trust level 2 and above on the Python authority's `TrustLevel`
  scale `L0–L4`. L2 is the level both CLI and MAC currently target (CLI defaults
  `trustLevel` to `2`; MAC builds L2). Higher levels add role gates: **L3 ⇒ CI**,
  **L4 ⇒ HUMAN**. "L2+ evidence" is the threshold at which the Python authority's
  run-binding, provider-diversity, actor-key, and runner-heartbeat gates engage.
  (AUDIT matrix #3; `TrustLevel L0–L4` and per-level role gates as recorded there.)

- **trustLevel** — the numeric authority trust level carried on an evidence envelope.
  Today the CLI carries only a numeric `trustLevel` defaulting to `2`, with **no preset
  awareness and no L3–L4 handling**; the Python authority has the full L0–L4 model with
  per-level role gates and named presets (`balanced-basic`, `balanced-heterogeneous`,
  `strict-ci`, `anti-hallucination`). (AUDIT matrix #3, advisory A2.) Per VCP-DOC, those
  Python preset names are an **external authority constraint, not a locally-landed fact**
  in this repo (VCP-DOC §设计决策 / §Server 配合, lines 11, 16, 32).

- **thin local/shadow client** — PD-1 Option A: Koala CLI stays a lifecycle tool whose
  authority POST runs in off/shadow posture, whose DONE/REVIEW/TEST gates consume
  **local** evidence, and which relies on **MAC as the canonical runner** for authority
  evidence. AUDIT describes this as "the CLI's current deployed posture (local/shadow
  authority mode, MAC as the canonical runner)" (lines 141-143). In this posture none of
  the B-0f04 gaps block operation.

- **first-class enforce-mode authority client** — PD-1 Option B: Koala CLI becomes a
  client accepted by a `production_enforce_authority=true` Python authority. That
  requires (per AUDIT B1/B2/B3) a working handshake, actor-key registration, envelope
  signing, run bindings, and provider diversity. Note the distinction the audit makes:
  the CLI's existing client-side `off/shadow/enforce` POST posture
  (`authority-mode.ts`) is **"a different axis from server enforce"** — the client-side
  "enforce" toggle is *not* the same as being accepted by a server that enforces
  authority. (AUDIT matrix #8, lines 154-156, 123.)

### Current Koala CLI authority posture (source-backed)

- CLI is the TypeScript client; `authority-client.ts` POSTs to `KOALA_AUTHORITY_URL`.
  (AUDIT repo-role table, line 106.)
- The transport works: the off/shadow/enforce client-side posture (`authority-mode.ts`)
  and the shadow POST path "work as designed; the gap is the *envelope contents*, not
  the transport." (AUDIT "Already solved", lines 154-156.)
- The CLI evidence envelope is a **strict subset**: `buildEnvelope`
  (`authority-submit.ts:68-89`) builds a minimal object and never populates
  `producerRunId`/`verifierRunId`, `provider`/`model`/`vendor`, or structured
  claims/coverage/negative-controls. (AUDIT matrix #1/#4/#5, blocker B3; CODEX HV-1.)
- The CLI carries only numeric `trustLevel` defaulting to `2`, with no preset / L3–L4
  model. (AUDIT matrix #3, advisory A2.)
- CLI lifecycle gates (DONE/REVIEW/TEST) consume **local** evidence only; no CLI
  lifecycle gate reads a server receipt. The authority POST only gates the *local write*
  at write-time in enforce mode. (AUDIT matrix #7.)
- The CLI **discards** the server receipt entirely (`receipt: unknown`); `decideFromSingle`
  checks only `accepted`. (AUDIT matrix #2, advisory A1; CODEX HV-3.)

### What the CLI does NOT have yet (do not assume these exist)

These are explicitly **absent** per the cited evidence — this story claims none of them
as implemented in the CLI:

- **No CLI handshake.** The CLI sends none of `client_name` / `client_version` /
  `command_catalog_digest` / `evidence_schema_digest` / `authority_mode`, and
  `EvidenceEnvelopeContract` does not even model them. (AUDIT B1 / matrix #8; CODEX HV-1.)
- **No CLI actor-key registration, runner heartbeat, or envelope signature.** The CLI
  POSTs a minimal **unsigned** envelope (`authority-submit.ts`,
  `authority-client.ts:138-158`). (AUDIT B2 / matrix #9; CODEX HV-2.)
- **No CLI receipt verification.** No CLI receipt-signature verification path was found
  in the inspected authority client files. (CODEX HV-3.)
- **No client verifies the AuthorityReceipt signature at all** — *neither* CLI *nor*
  MAC. (AUDIT advisory A1; CODEX HV-3.) MAC verifies only the JobSpec signature, not the
  receipt (see Mac section below).

### Python authority production enforce requirements (source-backed)

The Cord Team Python authority is the server: it "owns lifecycle state, role policy,
evidence receipts, leases, replay protection, and gate decisions" (AUDIT repo-role
table, line 107, quoting cord-team `README.md:3`). What a production enforce
configuration requires:

- **Handshake under `production_enforce_authority`.** With `required_authority_mode="enforce"`,
  Python rejects a missing/wrong `authorityMode`, then requires `clientName`,
  `clientVersion`, `commandCatalogDigest`, `evidenceSchemaDigest`, and `authorityMode`
  (`authority_records.py:524-582`). (AUDIT matrix #8; CODEX HV-1.)
- **Signed actor payloads, checked *before* policy.** `verify_signed_actor_payload`
  (`signed_actor.py:24-64`) rejects unknown actors and unsigned payloads before evidence
  policy checks; evidence is wrapped in `_EvidenceSignedView`
  (`authority_records.py:485-495`). CODEX rates the real Python path **stricter** than
  the report's runner-heartbeat framing. (CODEX HV-2.)
- **Anti-hallucination is the Python *default* preset**, and it requires run bindings +
  distinct provider diversity (`config.py:87-100`); enforcement rejects missing run
  bindings (`authority_records.py:1139-1153`) and requires producer/verifier run records
  for diversity (`authority_records.py:903-918`). (AUDIT matrix #3/#4/#5; CODEX HV-1.)
- **Additional production gates when configured:** actor binding /
  `require_actor_key_binding` and `require_runner_heartbeat_for_l2`
  (`config.py:128-129`, `authority_records.py:584-633`). Under these, CLI L2 submissions
  fail. (AUDIT B2; CODEX HV-2.)
- **Python *does* sign receipts.** Python signs an ed25519 `AuthorityReceipt` for every
  record including evidence (`receipt.py:12-26`, `receipt_service.issue_authority_receipt`)
  and exposes lookup endpoints (`/v1/receipts/{id}`, `/v1/projects/{id}/receipts`). This
  is a real server-side capability; the gap is only that *clients do not verify it*.
  (AUDIT matrix #2.)
- **Net effect today:** against a `production_enforce_authority=true` cord-team, every
  current CLI evidence POST is rejected (`authority_enforce_required` /
  `authority_handshake_required`). (AUDIT matrix #8, B1; CODEX HV-1 "confirmed,
  conditional on using the CLI as an enforce-mode authority client.")
- **Preset caveat (do not overclaim local landing):** the Python preset/limit/gate
  details count as locally-landed facts only where this repo has explicit code/doc
  references; otherwise they are external authority constraints. (VCP-DOC §设计决策 /
  §Server 配合, lines 11, 16, 32; AUDIT A2 scoping presets as "external/not-locally-landed".)

### Mac runner responsibilities (source-backed)

- MAC is the Koala Mac/Swift local-runner client ("Local Runner prototype"). (AUDIT
  repo-role table, line 108.)
- **MAC is a full runner**: `registerActorKey` + `registerRunner` + heartbeat +
  `claimJob` + ed25519-signed envelope + server-signature verification of the JobSpec
  (`AuthorityClient.swift:28-85`; `LocalRunnerService.swift:248,632-641`; CODEX cites
  `LocalRunnerService.swift:103-151,632-641`). (AUDIT matrix #9; CODEX HV-2.) This is the
  "largest impl gap" between MAC and CLI — MAC has the runner path, CLI does not.
- MAC mirrors `trustLevel:Int` and builds L2 evidence. (AUDIT matrix #3.)
- **MAC does NOT cryptographically verify the AuthorityReceipt signature.** It stores
  `receiptId` / `receiptKind` from the response but verifies only the JobSpec signature
  (`LocalRunnerService.swift:248`, `:575-590`; receipt id/kind at `:568-590`). The
  observed signature verification is JobSpec verification, not AuthorityReceipt
  verification. (AUDIT matrix #2, A1; CODEX HV-3.)
- MAC **declares** handshake fields but the runner build path leaves them `nil`; MAC sets
  `provider` only, leaving `model`/`vendor` `nil`. (AUDIT matrix #8, #5.)
- Consequence for PD-1: MAC is already the canonical authority runner (actor-key +
  heartbeat + signing), so duplicating that in the CLI is a deliberate product decision,
  not a default. (AUDIT decision rationale; B-4bd4 `decision.json` driver 2.)

### FU-1 / FU-3 dependency on PD-1 (source-backed)

- PD-1 **gates everything below it**: "Every blocker below is real **only if** the answer
  is 'CLI must be an enforce-mode client.'" (AUDIT lines 158-167.)
- **FU-1** (full EvidenceEnvelope → B3 / #1,#4,#5) and **FU-3** (actor-key + heartbeat +
  signing, *or* document CLI as non-runner → B2 / #9) are both listed *Blocker-if-PD-1;
  else defer / doc-only* in the AUDIT follow-up table (lines 214-216). FU-2 (handshake →
  B1 / #8) shares the same conditional.
- "Until PD-1 is decided, building FU-1/FU-2/FU-3 risks wasted work … **No code should
  land for the blockers until PD-1 is resolved.**" (AUDIT lines 166-167.)
- CODEX PM conclusion concurs: the recommended follow-up stories "should be created only
  after PD-1 is resolved" and are not duplicates of the active B-4622 / B-da5b backlog.
  (CODEX lines 120-129; AUDIT "Deduplication" §, lines 221-236.)
- Durability rationale for where the *decision* must live (CHK-002): per TRUTH-SOURCE,
  the truth source is `docs/requirements/decisions/*.md` (human decisions — *why*), and
  "Story 不是真相源" (a Story is an execution plan, not truth). So the durable PD-1
  contract belongs in `docs/requirements/decisions/authority-client-role.md` with this
  story file as its derivation. (TRUTH-SOURCE §定义 / §设计原则, lines 4-14.)
