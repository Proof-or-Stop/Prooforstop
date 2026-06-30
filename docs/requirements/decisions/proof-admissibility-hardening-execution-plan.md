# Proof Admissibility Hardening Execution Plan

> Status: execution plan; M0/M1 classification-only MVP implemented by B-0985;
> M2-M7 hardening partially implemented by B-0405 in warn-by-default mode with
> enforce diagnostics for high-risk proof consumers. Full ledger/waterline and
> global hard-fail availability must be capability-detected by consumers.
> Date: 2026-06-23.
> Scope: Proofbound CLI evidence, receipt, handoff, and gate-consumption boundaries.
> Architecture baseline: `docs/evidence/evidence-platform-architecture.md`.

> **Current vocabulary:** Active Proofbound CLI/runtime proof language is
> `admissibilityStatus`, `assuranceLevel`, `evidenceScope`, gate-consumed local
> evidence, local signed/offline receipt bundles, and local review quorum
> assurance. Authority Server and server-backed receipt semantics are retired
> from the active core path; older sections that mention them are legacy context
> only and are superseded by local proof admissibility.

This plan migrates existing proof-looking surfaces onto the shared Evidence
Runtime architecture. It must not create a separate Proof Admissibility manager,
storage root, ledger format, or gate-specific proof implementation.

B-0985 implements the first classification-only slice: the inventory, canonical
enum vocabulary, proof surface registry, and evaluator. It does not hard-fail
gates or create storage outside `.lattice/evidence/`.

## B-cd3a Capability Audit Freeze

This table freezes the current capability audit for the proof-admissibility
slice. It is the status contract for this document: implemented means present in
source and covered by a focused smoke or registry check; partial means the local
CLI side exists but broader ledger, cross-runtime, or Authority production
semantics are not complete; future means intentionally outside the local CLI
core; missing means described by the plan but not currently implemented.

| Capability | Status | Source / evidence | Boundary |
|---|---|---|---|
| M0/M1 proof surface registry and shared evaluator | Implemented | `packages/main/src/core/proof-admissibility.ts`; `npm --prefix packages/main run test:proof-admissibility` | Classification is shared and fail-closed for unknown proof-looking surfaces. |
| Standard vocabulary for scope / role / claim / consumer / reason | Implemented | `proof-admissibility.ts`; Appendix E; command catalog `admissibility_waterline` consumer schema | `AUTHORITY_GATE_DECISION` is canonical; legacy receipt rows remain compatibility-only. |
| Reserved caller-writable proof-key sanitizer | Implemented | `packages/main/src/core/proof-admissibility-metadata.ts`; hardening smoke | Caller metadata may preserve ordinary keys, but reserved proof-looking keys are stripped or rejected. |
| Versioned strict-shape and semantic digest binding | Implemented | `packages/main/src/core/proof-admissibility-binding.ts`; hardening smoke reason/verdict/null tamper cases | Digest binding covers local CLI proof payload semantics; future artifacts must add their own registered payloads before gate consumption. |
| Gate-facing diagnostics and process-fact registration | Implemented | `packages/main/src/core/proof-admissibility-gates.ts`; `process-fact-levels.ts`; `process-fact-registry.ts`; `scripts/verify-process-fact-contract.mjs` | Diagnostics report scope/reason/remediation. The registry fact is gate-consumed; the waterline remains read-only. |
| DONE_REQUIRED hard-fail rollout | Implemented for configured local CLI high-risk consumer | `done-required-validation.ts`; `lattice.config.json` `proofAdmissibility.enforcedConsumers`; hardening smoke | Blocks inadmissible DONE-required evidence in enforce mode; does not claim production completion. |
| REVIEW review-assurance / quorum hard-fail rollout | Implemented for configured high-risk REVIEW consumer | `review-assurance-floor.ts`; `review-escalation.ts`; hardening smoke | REVIEW proof diagnostics can block high-risk review-assurance/quorum paths; local host verdicts remain non-authority. |
| HANDOFF proof-ref hard-fail capability | Partial | `proof-admissibility-handoff.ts`; hardening smoke | Helper blocks inadmissible proof refs when passed enforce policy. Existing handoff command projections remain local/diagnostic and must pass the project policy into the helper before this is end-to-end for every handoff path. |
| Authority-facing proof consumer | Partial | `authority-receipt-ref` / `AUTHORITY_GATE_DECISION` registry entries; hardening smoke | A matching Authority-facing gate decision can be admissible evidence input with `productionDoneEligible=false`; external Authority adapter production projection is future work. Plain receipts and legacy refs cannot replace the gate decision. |
| Legacy classification | Implemented for read-time local CLI diagnostics | `packages/main/src/core/proof-admissibility-legacy.ts`; hardening smoke | Legacy evidence is audit-readable only and cannot satisfy new strong proof gates. |
| Admissibility waterline | Implemented as read-only diagnostic projection | `packages/main/src/core/lifecycle-control/consumption/index.ts`; `lattice admissibility_waterline --storyId=<id> --format=json` | Waterline counts and statuses cannot satisfy DONE, cannot mutate evidence, and cannot set `productionDone`. |
| Append-only admissibility ledger under `.lattice/evidence/` | Missing / future | Appendix C schema only | Current local CLI implementation evaluates directly and renders a diagnostic waterline; durable ledger rows remain a future integration. |
| Cross-runtime / Authority Server conformance suite | Future | Appendix A C12; Appendix B Authority rows | Local CLI smokes cover the current contract. Server-backed production receipt parity is outside this slice. |
| 3 rounds x 2 host review evidence for rollout stories | Process requirement, not code capability | REVIEW / DONE evidence lanes for the story | This document records the requirement; lifecycle reviewers must supply the actual evidence over final material. |

## Table of Contents

- 1. Problem
- 2. Observed Failure Classes
- 3. Target Rule
- 4. Expected Benefits
- 5. Milestone Count
- 6. Milestones
- 7. Dependency Plan
- 8. Suggested Story Slicing
- 9. Risk And Mitigation
- 10. Verification Matrix
- 11. Definition Of Done
- 12. Non-Goals
- Appendix A: Contract Clauses C1-C14
- Appendix B: Module-to-Clause Mapping
- Appendix C: Evidence Admissibility Ledger Schema
- Appendix D: Admissibility Waterline Schema
- Appendix E: Standard Value Dictionary
- Appendix F: Historical Lessons / Prior Bugs
- Appendix G: Unified Close Checklist

## 1. Problem

Proofbound already has many local safeguards: review evidence is bound to
`reviewRunId`, DONE-required receipts bind `headHash` / `materialHash` /
`storyFilesHash`, local/shadow Authority output cannot claim `productionDone`,
and offline receipt bundles have a local-key scope label. The remaining risk is
that these protections are spread across separate surfaces. A new proof-looking
field can still be introduced as ordinary metadata, digest text, a local
diagnostic receipt, or a handoff artifact before it is classified by one shared
admissibility contract.

The root problem is not that a host has been proven to act with intent. The root
problem is mechanical: a value can look like proof while being produced by, or
modifiable by, an untrusted boundary.

### 1.1 Threat Model

Protected assets:

- lifecycle gate decisions for REVIEW, TEST, DONE, handoff, and Authority-facing
  consumers;
- proof-looking artifacts such as receipts, review runs, handoff packs,
  DONE-required evidence, red/green relations, and legacy evidence;
- current material bindings: `headHash`, `materialHash`, `storyFilesHash`,
  command digests, subject digests, and artifact digests;
- user-facing claims such as `done-readiness`, `production-completion`,
  `authorityDone`, `fullAuthorityDone`, and `productionDone`.

Adversary capabilities considered in this plan:

- a local host, provider transcript, handoff payload, or caller-writable metadata
  can contain proof-looking keys or claims;
- stale or historical artifacts can be replayed against current material;
- an artifact can be presented to the wrong consumer, story, phase, or claim;
- semantic fields that a gate consumes can be edited unless they are digest-bound;
- a verifier/checker can fail due to local runtime error, malformed input,
  unsupported version, or implementation bug.

Trust boundaries:

- caller-writable metadata, local diagnostic output, host transcripts, and
  handoff context are not proof authority;
- local runtime-owned evidence can support local lifecycle readiness only when
  it is current and consumed by the matching local gate;
- trusted reviewer-owned evidence can support local review assurance only;
- Authority-owned receipts are evidence inputs. A production claim requires a
  matching gate decision policy outside the local CLI core;
- legacy evidence remains readable for audit, but is not strong-admissible
  unless regenerated under the current contract.

Non-goals:

- proving that a host intended to deceive;
- deleting external Authority adapters or historical receipt readers;
- making checker failures silently pass a proof gate;
- turning local diagnostics into Authority production evidence.

Checker-failure rule:

`overall=error` means the classifier/evaluator failed before it could decide
whether the proof is valid. It is fail-open only for workflow availability: it
must surface as a warning and must not block an unrelated local flow solely
because the checker crashed. It is still `allowed=false`, cannot satisfy
`admissibleProof`, cannot set `productionDone`, and must carry a remediation to
rerun or repair the checker.

Implementation boundary:

- Use the shared `EvidenceRuntime` facade.
- Register proof surfaces through `ProofSurfaceDefinition`.
- Evaluate gate claims through `ProofClaimPolicy`.
- Store artifacts and ledger streams under `.lattice/evidence/`.
- Keep existing strong verifiers, but connect them through adapters instead of
  rewriting them in the first migration slice.

### 1.2 Boundary With Global Lifecycle Control Plane

Proof Admissibility owns proof decision logic:

- scope / claim / consumer policy;
- producer boundary and temporal/material binding decisions;
- verifier adapter resolution;
- `AdmissibilityEvaluationRow`;
- `AdmissibilityWaterline`;
- proof-consumption enforcement in M7.

The Global Lifecycle Control Plane may consume and render these outputs, but it
must not create a second admissibility ledger, recalculate clause coverage,
reclassify scope, recompute freshness for proof claims, or implement parallel
proof hard-block policy. In particular:

- CP-2 in the control-plane plan is a consumption-closure projection over this
  plan's diagnostics / waterline.
- CP-5 runtime and queue enforcement must not absorb Proof M7; Proof M7 remains
  the owner of DONE_REQUIRED, review-assurance, handoff-proof, and
  Authority-facing proof-consumer enforcement.

If an admissibility capability is not implemented, the control plane must report
`unknown` / `unavailable`; it must not assume the capability exists.

## 2. Observed Failure Classes

| Class | Concrete failure | Root cause | Case / evidence | Required contract |
|---|---|---|---|---|
| Client-writable metadata looked like proof | `job.metadata` / linked `run.metadata` could carry `hostDeclarationDigest` and `providerAuthorization` | Server-authored proof keys were not stripped from caller-writable metadata | Authority sibling story `B-e9cb`; final validation 699 pass / 9 of 9 covered | Reserved proof-key registry plus server-owned production |
| Caller metadata looked like server truth | Direct jobs could spoof delegated replay metadata such as `createdVia/source=server_delegated` | Replay classification trusted caller-supplied metadata | Authority sibling story `B-bfa9:F-007`; full validation 671 pass / 12 of 12 covered | Server-owned creator fields only |
| Digest omitted semantic material | A result `reason` could be edited while the digest still verified | Hash input omitted a field consumed by the claim | Proofbound `B-7b6e` gate-strength case | Semantic digest must cover every gate-consumed field |
| Signature shape was incomplete | A signed local receipt bundle could be structurally changed through null / shape edges if shape was not checked | Canonical signer omits null/undefined, so signature alone is insufficient | Proofbound `B-4c65` receipt-bundle contract; 18 tamper classes rejected | Versioned strict shape plus signature |
| Local/shadow status could be over-read | `accepted=true`, local JSON, jobs-stream hints, or local diagnostic receipts could be misread as Authority completion | Transport acceptance is not receipt verification | `docs/guide.md`, `authority-client-role.md`, `authority-boundary.ts` | Classify non-authority evidence explicitly |
| Handoff packs carry evidence-looking refs | Worker output and handoff receipt submission can look like completion | Host handoff is an execution transfer, not proof authority | `lattice-handoff.ts`, host overflow docs | Handoff must separate evidence candidates from admissible proof |
| Legacy evidence lacks a universal scope | Old evidence may be readable but not strong enough for a stricter future gate | Historical artifacts predate the new proof contract | DONE-required / review / local receipt history | Legacy-readable, not strong-admissible |

## 3. Target Rule

A value becomes admissible proof only when all required dimensions for its scope
are satisfied:

```text
admissibleProof =
  producerBoundaryTrusted
  AND supportedSchemaVersion
  AND supportedContractVersion
  AND supportedVerifierVersion
  AND strictShapeValid
  AND semanticDigestValid
  AND signatureOrAuthorityBindingValid
  AND temporalAndMaterialBindingValid
  AND artifactConsumerMatches
  AND scopeAllowsClaim
```

Anything else is still useful, but it is not strong proof. Scope is one
dimension; temporal role, producer boundary, consumer, claim, and binding status
are separate dimensions and must be evaluated together.

| Evidence scope | Default producer boundary | Typical artifact role | Default temporal role | Strong claim boundary | May set local CLI `productionDone`? |
|---|---|---|---|---|---|
| `audit-note` | caller-writable | local-diagnostic | not-applicable | Human-readable context only | No |
| `legacy-observed` | legacy-unknown | local-diagnostic | not-applicable | Readable historical audit material | No |
| `legacy-local-only` | legacy-unknown | local-diagnostic | not-applicable | Historical local-only evidence | No |
| `legacy-unknown-producer` | legacy-unknown | local-diagnostic | not-applicable | Historical unknown-producer evidence | No |
| `evidence-candidate` | caller-writable, trusted-reviewer-owned, or local-runtime-owned | problem-observation, repro-validity-review, planning-input, planning-review, red-green-relation, regression-matrix-review | historical-baseline, transition-relation, or not-applicable | Intake and planning only | No |
| `local-diagnostic` | local-runtime-owned | local-diagnostic or handoff-context | current-state or not-applicable | Diagnostic status and handoff context | No |
| `local-key-single-host` | local-runtime-owned | local-diagnostic | current-state | Single-host local receipt diagnostics | No |
| `local-gate-evidence` | local-runtime-owned | current-verification | current-state | Local lifecycle readiness for the matching gate | No |
| `local-review-quorum` | trusted-reviewer-owned | planning-review | current-state | Local review assurance only | No |
| `authority-receipt` | authority-owned | authority-decision | current-state | Evidence input to a matching Authority-facing gate | No |
| `production-gate-decision` | authority-owned | authority-decision | current-state | External Authority adapter gate decision; local CLI records the scope but does not self-mint production completion | No in local CLI core; external production adapters must prove their own policy |

An authority receipt is evidence. It is not a production claim by itself. The
local CLI core must not turn any receipt ref into `productionDone = true`.
The local CLI proof vocabulary is `admissibilityStatus`, `assuranceLevel`, and
`evidenceScope`; Authority production receipts are external adapter/future
compatibility evidence, not local core completion claims.
External Authority adapters may project production completion only when their
own matching gate policy verifies the decision and records that projection
outside the local proof-admissibility core.

Temporal role is separate from evidence scope:

| Temporal role | Meaning | Binding rule |
|---|---|---|
| `historical-baseline` | Evidence that old material exhibited a target failure | Binds baseline head/material and source artifact digest; does not require current HEAD |
| `current-state` | Evidence that current material passes/fails a check | Requires current head/material/story files where story-bound |
| `transition-relation` | Evidence that historical red and current green describe the same acceptance row | Binds baseline artifact digest, current artifact digest, command equivalence, and claim subject |

For repro-first flows, REVIEW/TEST/DONE consume a valid historical baseline,
fresh current-state green evidence, and a valid transition relation. They do not
consume a "fresh red" on current material.
This is enforced as a registry projection, not by trusting CLI command names:

- `red_green_relation_create` emits artifact kind `red-green-relation` for candidate
  transition evidence.
- `red_green_relation_evaluate` emits artifact kind `red-green-relation-evaluation`
  after evaluator-bound digest and command equivalence checks.
- `story_create_from_repro` emits `story-evidence-binding`; it binds candidate
  artifact references and may only be used as planning/intake proof.

No caller-side `commandEquivalence` override is allowed in claim projection.
Only registry-classified artifact kinds and digest tuples in `.lattice/evidence/`
can be consumed by STORY_INTAKE/PLAN/REVIEW/TEST/DONE.

## 4. Expected Benefits

| Benefit | What changes | Evidence / rationale |
|---|---|---|
| Fewer repeated spoofing bugs | New proof-looking fields must enter a registry and classifier before gates can consume them | `B-e9cb` and `B-bfa9` were the same trust-boundary bug on different metadata paths |
| Faster high-risk reviews | Reviewers get canonical reason codes (`reserved_key_detected`, `producer_owned_required`, `stale_material`, `signature_invalid`, `digest_mismatch`) instead of manually judging prose | Current docs already define many fail-closed reasons; this plan makes them shared |
| Safer host handoff | Codex / Claude / Antigravity can transfer work without treating worker output as proof | Handoff docs already require `productionDone=false`; the plan makes artifact classes machine-readable |
| Lower false-DONE risk | DONE / TEST / REVIEW consume only admissible proof for their configured policy | Existing `done_required_validate` and receipt-gate docs already bind HEAD/material/story files |
| Cleaner legacy story handling | Old evidence stays visible but is labeled as audit-only unless upgraded | Avoids breaking history while preventing overclaim |
| Better paper/audit story | Claims map to artifact, command, artifact consumer, and admissibility scope | Matches the paper's operational evidence-map direction |

This will not make every ordinary feature faster. It saves time mainly in
Authority, receipt, handoff, DONE, review-escalation, and other high-risk paths
where one false proof can cause hours of rework.

## 5. Milestone Count

This needs 8 milestones: M0 through M7. M0 and M1 are architectural blockers;
M2, M3, and M6 can proceed in parallel after M1; M4 and M5 integrate the
results; M7 is the hardening and rollout gate.

## 6. Milestones

### M0 - Evidence Surface Inventory

Goal: produce a complete inventory of proof-looking surfaces before changing
behavior.

Steps:

1. Inventory current proof-looking artifacts:
   - `done-required-evidence.json`
   - delivery-check / final-report evidence
   - review runs / review passes / findings
   - Authority receipt refs
   - offline receipt bundles
   - handoff packs / handoff receipts
   - host verdicts and dispatch reports
   - local/shadow Authority status
   - usage-ledger authority evidence
   - pre-story repro probes (`repro_probe`)
   - repro review verdicts (`repro_review_set`)
   - disposable spike records (`spike_record`)
   - spike review verdicts (`spike_review_set`)
   - regression matrix review verdicts (`regression_matrix_review_set`)
2. For each artifact, record producer, mutability boundary, binding fields,
   current artifact consumer, and current scope.
3. Mark each surface as:
   - `strong-proof-ready`
   - `needs-scope-label`
   - `needs-semantic-binding`
   - `must-remain-diagnostic`
   - `legacy-only`

Deliverables:

- `docs/evidence/proof-surface-inventory.md`
- `docs/evidence/proof-surface-inventory.json`

Exit criteria:

- Every gate-consumed proof-looking surface has an owner and scope.
- Every non-authority surface explicitly says why it cannot set
  `productionDone`.

B-0985 status: complete for the classification-only M0 slice. Future slices may
expand or migrate the inventory, but new proof-looking surfaces should start by
adding a registry entry rather than adding gate prose.

### M1 - Shared Proof Admissibility Registry

Goal: create one reusable contract for deciding whether an artifact is proof,
diagnostic evidence, or legacy audit material.

Steps:

1. Add a core module under `packages/main/src/core/evidence/admissibility/*`.
   `packages/main/src/core/proof-admissibility.ts` remains the compatibility re-export.
2. Define:
   - `EvidenceScope`
   - `AdmissibilityResult`
   - `AdmissibilityReasonCode`
   - `ProofProducerBoundary`
   - `ArtifactConsumerKind`
   - `ArtifactRole`
   - `ClaimKind`
   - `TemporalRole`
3. Add a registry mapping artifact kinds to required dimensions:
   - producer ownership
   - schema version
   - strict shape
   - semantic digest
   - signature / receipt binding
   - temporal/material binding
   - allowed artifact consumers
4. Add tests for classification only. Do not hard-fail gates yet.

Deliverables:

- Core helper and registry.
- Smoke test proving local/shadow/diagnostic artifacts cannot classify as
  `production-gate-decision`.

Exit criteria:

- A caller can ask "what is this artifact allowed to prove?" and receive a
  structured answer with reason codes.

B-0985 status: complete for M1 classification. The shared module is
`packages/main/src/core/evidence/admissibility/*` (compat entrypoint in
`packages/main/src/core/proof-admissibility.ts`); the focused smoke command is
`npm --prefix packages/main run test:proof-admissibility`. Gate enforcement and
Authority Server integration remain non-goals for this story.

### M2 - Reserved Proof-Key And Server-Owned Metadata Contract

Goal: stop proof-looking metadata from being preseeded or overwritten by
client/host-writable metadata.

Steps:

1. Define a reserved proof-key registry for Proofbound surfaces.
2. For each metadata-carrying path, classify fields as:
   - user metadata
   - server/runtime metadata
   - proof metadata
   - diagnostic metadata
3. Strip or reject reserved proof keys from caller-writable metadata.
4. Preserve ordinary metadata.
5. Add regression cases:
   - preseed reserved key at creation
   - mutate reserved key before claim/consume
   - inject reserved key through linked or nested metadata
   - verify ordinary metadata survives

Deliverables:

- Reserved proof-key registry.
- Sanitization helpers.
- Regression tests modeled after `B-e9cb` and `B-bfa9`.

Exit criteria:

- No caller-writable metadata path can create a field that is later accepted as
  proof.

B-0405 status: implemented for CLI proof surfaces. Reserved proof-key detection
and sanitization live in `proof-admissibility-metadata.ts`; caller metadata on
runner registration, job spec, and provider event envelopes strips nested or
linked spoof keys while preserving ordinary metadata.

### M3 - Semantic Binding And Versioned Verification

Goal: prevent partial digest/signature coverage from making edited evidence look
unchanged.

Steps:

1. For every signed or digested proof artifact, define the canonical signed
   payload.
2. Require `schemaVersion` and, where needed, `verifierVersion`.
3. Require strict shape checks before accepting signatures when canonicalization
   can elide values such as `null` / `undefined`.
4. Add "semantic field coverage" tests for each gate-consumed claim.
5. Add tamper tests:
   - edit `reason`
   - edit verdict
   - add null
   - add extra key
   - remove required field
   - change story/head/material binding

Deliverables:

- Versioned canonical payload definitions.
- Tests extending the `B-4c65` and `B-7b6e` lessons.

Exit criteria:

- Any change to a gate-consumed semantic field changes the digest or fails strict
  shape/signature verification.

B-0405 status: implemented for the CLI hardening slice. Versioned canonical
binding helpers live in `proof-admissibility-binding.ts`; Authority gate receipt
proof schemas are strict for strong proof paths, and the hardening smoke covers
reason/verdict/story/head/material/signature-like tamper plus null/extra/missing
shape failures.

### M4 - Gate Integration In Warn Mode

Goal: route REVIEW, TEST, DONE, Authority, handoff, and local review-quorum
consumers through the shared admissibility helper without breaking legacy flows.

Steps:

1. Add proof admissibility checks to gate read paths.
2. Initially report warnings / diagnostics, not hard failures, except for paths
   that are already fail-closed.
3. Update process fact registry and verification script when a gate consumes a
   new admissibility fact.
4. Make every warning include:
   - artifact id/path
   - scope
   - intended claim
   - reason code
   - remediation hint

Deliverables:

- Gate diagnostics.
- Process-fact registry coverage.
- Tests proving gates can explain inadmissible evidence.

Exit criteria:

- Every gate report can tell whether it consumed strong proof, local evidence,
  diagnostic evidence, or legacy audit material.

B-0405 status: implemented in warn mode for gate-facing reports. Shared
diagnostics live in `proof-admissibility-gates.ts`; DONE-required, review
escalation, review assurance floor, handoff, and Authority receipt-facing
surfaces report scope/reason/remediation through the shared contract. The
process fact registry records `runtime:proof_admissibility_gate_diagnostic`.

### M5 - Legacy Scope And Migration

Goal: preserve old evidence for audit without letting it satisfy stronger proof
claims.

Steps:

1. Define legacy scopes:
   - `legacy-observed`
   - `legacy-local-only`
   - `legacy-unknown-producer`
2. Add read-time classification for old artifacts that lack new fields.
3. Add repair/upgrade commands only where upgrade is mechanically possible.
4. Document non-upgradable artifacts as audit-only.
5. Ensure user-facing output does not call legacy evidence "verified authority"
   unless it is actually receipt-backed and gate-consumed.

Deliverables:

- Legacy classifier.
- Migration/repair command or dry-run.
- Documentation for old evidence interpretation.

Exit criteria:

- Old evidence remains readable.
- Old evidence cannot accidentally satisfy a new strong proof gate.

B-0405 status: dry-run diagnostics implemented in
`proof-admissibility-legacy.ts`. Legacy artifacts are classified as
`legacy-observed`, `legacy-local-only`, or `legacy-unknown-producer`; all remain
readable and none are promoted to strong proof.

### M6 - Host Handoff And Multi-Host Boundary

Goal: make cross-host work transfer proof-safe by construction.

Steps:

1. Split handoff artifacts into:
   - `context`
   - `evidenceCandidate`
   - `diagnosticReceipt`
   - `admissibleProofRef`
2. Ensure `handoff_create`, `host_dispatch`, `handoff_receipt_submit`, and
   resume flows keep `productionDone=false` unless a matching gate consumes a
   verified receipt.
3. Add host identity fields needed for local review quorum without implying
   Authority receipt completion.
4. Ensure Codex / Claude Code / Antigravity entry paths surface the same
   admissibility summary before claiming work is done.

Deliverables:

- Handoff schema update.
- Host preflight admissibility summary.
- Multi-host smoke tests.

Exit criteria:

- A new host can tell which inputs are context, which are candidate evidence,
  and which are admissible proof.

B-0405 status: implemented for handoff projections. Handoff summaries separate
`context`, `evidenceCandidate`, `diagnosticReceipt`, and `admissibleProofRef`,
carry host/quorum identity, and keep `receiptVerified`, `authorityDone`,
`fullAuthorityDone`, and `productionDone` false unless a separate matching gate
consumes verified proof.

### M7 - Hard-Fail Rollout And Adversarial Regression Suite

Goal: turn the contract into enforcement without destabilizing normal local
development.

Steps:

1. Add a policy flag such as `proofAdmissibility.mode = warn|enforce`.
2. Start with warn mode for existing projects.
3. Enable enforce mode for high-risk self-host gates first:
   - Authority receipt consumption
   - DONE-required evidence
   - review escalation host verdicts
   - handoff proof refs
4. Run adversarial regression:
   - client-writable proof key injection
   - delegated metadata spoof
   - stale material hash
   - wrong story id
   - wrong target phase
   - wrong key id
   - bad signature
   - null/extra/missing field
   - omitted semantic field
   - local/shadow accepted transport
   - diagnostic handoff receipt
   - raw red probe without accepted ReproReview
   - historical red treated as stale only because current HEAD changed
   - stale current-state green evidence
   - red/green command mismatch without equivalence review
   - candidate artifact mutation after ReproReview
   - bootstrap noise counted as target bug
   - `matrix-gap` accepted without policy exception
5. Require high-risk review assurance:
   - 3 rounds x 2 hosts for implementation stories touching gates,
     Authority, receipt verification, handoff proof, or process facts.
6. Require an enforce bootstrap record before any story flips
   `proofAdmissibility.mode` from `warn` to `enforce`:
   - the same story/head/material/policy tuple must have a fresh warn-mode pass
     with zero blocking `overall=fail` rows for the consumers being enforced;
   - the story must name the exact rollback command or config revert;
   - legacy and grandfathered artifacts must be enumerated as audit-only,
     not silently promoted;
   - checker/evaluator `overall=error` rows must be cleared or accepted only as
     warning-only workflow recovery, never as proof;
   - the rollout story must carry high-risk review assurance and scope evidence.

Deliverables:

- Enforce policy.
- Enforce bootstrap record.
- Adversarial suite.
- 3x2 review evidence for hard-fail rollout.

Exit criteria:

- In enforce mode, no inadmissible proof-looking artifact can satisfy a strong
  gate.
- In warn mode, local development remains usable with clear diagnostics.
- A story that flips enforce mode is rejected unless warn-mode evidence,
  rollback, grandfather/audit-only treatment, and checker-error handling are
  explicit.

B-0405 / B-cd3a status: B-0405 introduced config-resolved
`proofAdmissibility.mode = warn|enforce` with warn default and shared
diagnostics. B-cd3a closes the local CLI M7 rollout for explicitly configured
high-risk consumers by adding `proofAdmissibility.enforcedConsumers` and setting
this project to enforce `DONE_REQUIRED`, `REVIEW`, `HANDOFF`, and
`AUTHORITY_GATE_DECISION`. The adversarial hardening smoke covers reserved-key
injection, stale/wrong-shape proof diagnostics, semantic tamper,
local/diagnostic handoff proof refs, legacy downgrade behavior, checker-error
warning-only recovery, and enforce-mode blocking for inadmissible configured
high-risk consumers. This remains local CLI enforcement: it does not implement
append-only ledger storage or external Authority production completion.

B-91f3 clarification: the local CLI core keeps `productionDoneEligible=false`
for Authority receipt refs. External Authority adapters may still verify and
project production completion through their own policy; that projection is not a
local proof-admissibility default.

## 7. Dependency Plan

```text
M0 -> M1 -> M4 -> M5 -> M7
          \-> M2 -/
          \-> M3 -/
          \-> M6 -/
```

Repro-first candidate-only work can proceed independently from this plan. The
shared dependency starts when repro artifacts need ledger-backed evaluation,
REVIEW/TEST/DONE consumption, stale/temporal enforcement, or admissibility
waterline reporting.

Safe cross-plan order:

```text
manual repro pilot (advisory only)
  -> Proof M0/M1 admissibility inventory + registry
  -> Proof M3 semantic binding + C14 command/privacy rules
  -> Repro M1-M3 candidate-only CLI MVP
  -> integration story: register repro artifact kinds + ledger/evaluator support
  -> Proof M4 warn-mode gate display
  -> repro regression matrix integration
  -> M7 enforce rollout
```

Before the integration story lands, red/spike artifacts may be stored and
reviewed as candidate-only records. They may support experiment metrics and story
planning, but they must not be consumed by lifecycle gates.

Independent boundaries:

- Proof Admissibility M0-M3 hardens existing evidence surfaces without waiting
  for Repro-first CLI commands.
- Repro-first M1-M3 may implement candidate storage, review records,
  story creation, and experiment metrics without ledger-backed admissibility.
- The integration story registers repro artifact kinds, connects evaluator /
  ledger rows, and enables gate display/enforcement.

Parallelizable after M1:

- M2 metadata/reserved-key work.
- M3 semantic digest/signature work.
- M6 handoff boundary work.

Serial blockers:

- M1 must land before any gate starts relying on classification.
- M4 must land before M5 can safely label legacy evidence in gate output.
- M7 must not land before M2/M3/M4/M5/M6 pass their focused regression suites.

## 8. Suggested Story Slicing

| Story slice | Milestones | Risk | Notes |
|---|---|---|---|
| S1 Inventory + plan | M0 | Medium | Documentation and evidence map only |
| S2 Admissibility registry | M1 | High | New shared process/gate fact |
| S3 Reserved proof metadata | M2 | High | Can affect metadata consumers |
| S4 Semantic binding/versioning | M3 | High | Can affect old signatures/digests |
| S5 Gate warn-mode integration | M4 | High | Touches REVIEW/TEST/DONE/reporting |
| S6 Legacy migration | M5 | Medium/High | Needs careful non-breaking behavior |
| S7 Handoff integration | M6 | High | Cross-host boundary and host IDs |
| S8 Enforce rollout | M7 | Critical | Requires 3 rounds x 2 hosts |

MVP / Warn mode:

- S1-S5
- Purpose: establish shared classification and gate diagnostics.

Proof-safe handoff ready:

- S1-S7
- Purpose: include handoff and multi-host boundary protection.

Enforce ready:

- S1-S8
- Purpose: hard-fail high-risk proof consumption paths.

## 9. Risk And Mitigation

| Risk after hardening | Why it can happen | Mitigation |
|---|---|---|
| Old evidence becomes inadmissible | New contract requires fields old artifacts never had | Mark as `legacy-observed`; keep readable but not strong proof |
| Old signatures fail | Canonical payload or strict shape changes | Add `schemaVersion` / `verifierVersion`; versioned verifiers |
| False blocks increase | Gates reject evidence that was previously accepted | Start in warn mode; enforce only on high-risk policies |
| User metadata gets stripped unexpectedly | Reserved key sanitizer deletes proof-looking keys | Strip only registered reserved keys; preserve ordinary metadata |
| Handoff feels stricter | New host cannot treat worker output as DONE evidence | Show context/candidate/proof split in handoff preflight |
| Implementation forks logic again | Each gate reimplements its own proof test | Require shared helper and process-fact registry verification |
| Performance cost | Extra digest/signature/shape checks | Cache read-only classifications per gate evaluation; benchmark large stories |

## 10. Verification Matrix

| Scenario | Expected result |
|---|---|
| Caller preloads reserved proof key into metadata | Strip or reject; never admissible proof |
| Direct job spoofs delegated metadata | Not classified as server-owned proof |
| Edit gate-consumed `reason` field | Digest/signature mismatch or semantic binding failure |
| Add `null` into signed bundle | Strict shape rejects before acceptance |
| Add unexpected key into proof artifact | Strict shape rejects |
| Use old material hash | `stale_material` |
| Use wrong story id | `story_mismatch` |
| Use wrong target phase | `gate_phase_mismatch` |
| Use local/shadow `accepted=true` | `local-diagnostic`, not Authority proof |
| Submit handoff diagnostic receipt | Accepted as diagnostic only; `productionDone=false` |
| Read old evidence missing new fields | `legacy-observed`, audit-readable |
| Valid new Authority `gate_decision` receipt consumed by matching adapter | `production-gate-decision`, admissible as evidence/input; local CLI core keeps `productionDone=false` |
| Raw red probe without accepted ReproReview | `evidence-candidate` only; not a valid historical baseline |
| Historical red uses old baseline hashes | `historical-valid`; not stale merely because current HEAD changed, but cannot independently satisfy a current-state gate |
| Current green does not match current story hash tuple | stale current-state evidence |
| Red and green command specs differ without equivalence review | `red_green_command_mismatch` |
| Candidate artifact content changes after ReproReview | artifact digest mismatch |
| Bootstrap failure matches no expected target pattern | `bootstrap_noise`; no repro-first claim |
| Regression matrix verdict is `matrix-gap` | REVIEW/TEST/DONE blocked unless explicit policy exception |

## 11. Definition Of Done

This program is complete when:

1. Every proof-looking artifact kind has an admissibility registry entry.
2. Every strong gate calls the shared admissibility helper.
3. Every rejection path returns a stable reason code and remediation hint.
4. Legacy artifacts remain readable but cannot satisfy new strong proof gates.
5. Handoff artifacts distinguish context, candidate evidence, diagnostic
   receipt, and admissible proof refs.
6. The adversarial suite covers all failure classes in Section 2.
7. High-risk gate/Authority/handoff/process-fact changes have 3 rounds x 2 host
   review evidence over the final material.
8. Documentation and guide text stop saying or implying that local/shadow,
   diagnostic, or legacy evidence can establish production authority.

## 12. Non-Goals

- Do not delete historical evidence.
- Do not make ordinary local development require the Authority Server.
- Do not turn local-key receipt bundles into Authority receipts.
- Do not infer host intent from spoofable proof surfaces.
- Do not silently promote handoff output to DONE or `productionDone`.

## Appendix A: Contract Clauses C1-C14

Review date: 2026-06-23.

Post-B-0405 note: the rows below are no longer the pre-implementation gap list.
They describe the CLI hardening delivered by B-0405 and the remaining future
work that is intentionally outside this story, especially Authority Server
production receipt conformance and broader contract unification.

### A.1 Contract clauses

| Clause | Contract requirement | B-0405 CLI status | Implemented examples | Remaining future work |
|---|---|---|---|---|
| C1: Single scope classifier | Every proof-looking artifact must classify into exactly one canonical `EvidenceScope` defined in Appendix E before any consumer interprets it | Implemented for CLI proof-surface classification and gate diagnostics | `proof-admissibility.ts` defines registered surfaces and claim policies; `authority-boundary.ts`, `lattice-handoff.ts`, and process fact registry outputs map local/shadow/diagnostic/receipt-backed scopes without allowing `productionDone` overclaim | Continue converging older per-surface wording and future Authority Server integrations onto the same enum/reason-code vocabulary |
| C2: Producer ownership | Proof fields must be produced by the owning authority, not by caller-writable metadata | Implemented for B-0405 CLI metadata surfaces | `proof-admissibility-metadata.ts` reserves proof keys and sanitizes runner registration, job spec, and provider event metadata while preserving ordinary caller metadata | Authority Server production-owned metadata remains a sibling/server concern, not completed by this story |
| C3: Supported schema version | Strong proof artifacts must carry an accepted schema/version and reject unsupported versions | Implemented for the CLI hardening slice and preserved on existing strong verifiers | `done-required-validation.ts`, `receipt-bundle.ts`, `authority-gate-receipt-verifier.ts`, and handoff receipts keep explicit schema/version checks; legacy read paths downgrade old shapes instead of promoting them | Keep future schema additions registered in the shared contract before gate consumption |
| C4: Strict shape before trust | Strong proof verification must reject null, wrong type, missing field, and unexpected proof keys before interpreting signed fields | Implemented for strong CLI proof paths covered by B-0405 | `proof-admissibility-binding.ts` and the hardening smoke cover null, extra key, removed required field, wrong type, and signature-like tamper cases; diagnostic/passthrough output remains explicitly diagnostic | Continue marking intentionally passthrough diagnostics as non-strong proof; do not treat this as Authority Server production receipt coverage |
| C5: Semantic digest coverage | Every gate-consumed semantic field must be included in the digest/signature subject | Implemented for B-0405 CLI semantic binding coverage | Versioned binding helpers cover reason, verdict, story/head/material, consumer, and signature-like subjects in the adversarial smoke matrix | Extend the same pattern when new gate-consumed semantic fields or server-side receipt subjects are introduced |
| C6: Signature / receipt binding | A signature or receipt must bind to the actual subject, trusted key, story, and gate context | Implemented for existing CLI key paths and registered diagnostics | `authority-receipt-classification.ts`, `authority-gate-receipt-verifier.ts`, `review-run.ts`, and `receipt-bundle.ts` keep subject/key/story/gate checks; B-0405 routes diagnostics through the shared claim policy layer | Future signed/receipt-like artifacts must be registered before they are consumed as proof |
| C7: Temporal and material binding | Proof must declare whether it is historical-baseline, current-state, or transition-relation, and validate the correct hash/material rule for that role | Implemented for current-state CLI gates and the B-0405 adversarial stale/transition checks | `review-run.ts`, `done-required-validation.ts`, and proof-admissibility tests cover head/material/story freshness plus red/green relation and command mismatch diagnostics | Broader historical migration and Authority Server receipt timelines remain future integration work |
| C8: Artifact consumer matching | Proof must be consumed only by the consumer it was produced for, including non-gate consumers such as story intake | Implemented for B-0405 gate-facing CLI diagnostics and high-risk enforce consumers | Claim policies and process fact registry entries bind target consumers/lanes/phases; hardening smoke covers wrong story and wrong target phase | Keep new consumers registered in `ProofClaimPolicy` and the process-fact contract before use |
| C9: Non-authority cannot overclaim | Local/shadow/diagnostic/worker output must not set `receiptVerified`, `authorityDone`, `fullAuthorityDone`, or `productionDone` | Implemented and unchanged by B-0405 | `authority-boundary.ts`, `lattice-handoff.ts`, `usage-ledger/authority-evidence.ts`, `process-fact-levels.ts`, and docs preserve local/diagnostic boundaries and keep `productionDone=false` without a matching verified gate receipt | Keep this boundary for all future handoff, local quorum, and Authority-adjacent output |
| C10: Legacy scope | Historical evidence missing the current contract must remain readable but not strong-admissible | Implemented as read-time CLI dry-run diagnostics | `proof-admissibility-legacy.ts` classifies `legacy-observed`, `legacy-local-only`, and `legacy-unknown-producer`; legacy artifacts remain readable and are not promoted to strong proof | Add repair commands only where upgrade is mechanically provable; leave non-upgradable history audit-only |
| C11: Stable reason codes | Rejections must have machine-readable reason codes and remediation hints | Implemented for B-0405 diagnostics and adversarial assertions | `proof-admissibility.ts` / `proof-admissibility-gates.ts` emit scope, reason, remediation, and blocking/advisory state; tests assert specific reason codes for tamper and policy failures | Continue reducing older free-text reasons when touching legacy surfaces |
| C12: Cross-runtime vectors | CLI and Authority Server must run the same tamper/shape/stale/semantic fixtures | Implemented for CLI regression vectors only | `proof-admissibility-smoke.ts` and `proof-admissibility-hardening-smoke.ts` exercise the CLI matrix, including reserved keys, stale hashes, semantic tamper, handoff overclaim, and enforce blocking | Authority Server conformance/shared fixture execution is explicitly future work and does not imply `productionDone` |
| C13: Handoff artifact class split | Handoff must distinguish context, evidence candidate, diagnostic receipt, and admissible proof ref | Implemented for CLI handoff projections | `lattice-handoff.ts` summaries separate `context`, `evidenceCandidate`, `diagnosticReceipt`, and `admissibleProofRef`, with receipt/authority/production booleans held false unless a matching gate consumes verified proof | Keep future host surfaces rendering these classes before any completion claim |
| C14: Privacy-safe reproducible command envelope | Command-backed evidence must record structured command specs, bootstrap/environment digests, and bounded redacted output without leaking raw prompts/secrets | Implemented for B-0405 CLI proof-admissibility command diagnostics and existing usage-ledger privacy surfaces | `usage-ledger/authority-evidence.ts` remains fail-safe and privacy preserving; hardening diagnostics cover command-spec digest, bootstrap noise, redacted output, and red/green command mismatch classes | Broaden shared command-envelope adoption as additional repro, DONE-required, review, and Authority-bound receipts are migrated |

### A.2 New Proof-Looking Artifact Intake Template

Use this before adding any artifact that can be consumed by REVIEW, DONE,
Authority gate paths, or any automated evidence check.

| Field | Required answer |
|---|---|
| Artifact kind | Canonical logical kind for the new evidence/claim surface |
| Producer boundary | One of `caller-writable`, `local-runtime-owned`, `authority-owned`, `trusted-reviewer-owned`, `legacy-unknown` |
| Artifact role | `problem-observation`, `repro-validity-review`, `planning-input`, `planning-review`, `current-verification`, `regression-matrix-review`, `red-green-relation`, `authority-decision`, or another registered role |
| Intended claim | What this artifact is allowed to prove |
| Claim subject | The story, candidate, command, gate, acceptance row, or authority subject the claim is about |
| Caller-writable fields | List all fields that can be set by host/caller |
| Server/runtime-owned fields | List fields reserved for runtime or authority producer |
| Evidence scope | One of the enum values in Appendix E |
| Allowed artifact consumers | `STORY_INTAKE`, `PLAN`, `REVIEW`, `TEST`, `DONE`, `DONE_REQUIRED`, `HANDOFF`, `AUTHORITY_GATE_DECISION`, or another registered consumer |
| Required schema version | Explicit schema and contract version |
| Strict shape policy | Whether unknown fields are rejected |
| Semantic fields consumed by gates | Fields required for claim semantics |
| Digest/signature subject | Exactly what is hashed and signed |
| Temporal role | `historical-baseline`, `current-state`, `transition-relation`, or `not-applicable` |
| Material bindings | `baselineHeadHash` / `baselineMaterialHash`, current `headHash` / `materialHash` / `storyFilesHash`, or transition relation digests as applicable |
| Pre-story bootstrap command | Required build/bootstrap command when the artifact is a repro/spike candidate |
| Execution root | `main`, `temp-worktree`, `story-worktree`, or equivalent execution boundary |
| Expected failure pattern | Pattern/digest distinguishing target bug failure from bootstrap/environment noise |
| Producer observed failure class | `target-bug`, `bootstrap-noise`, `environment-noise`, `unknown`, or `not-applicable` |
| Reviewed failure class | Reviewer-owned class when the artifact is a repro review; never producer-self-asserted |
| Story binding artifact | New immutable binding artifact ref after promotion, or `null` before story binding; never mutate the original candidate |
| Artifact digest | Digest of the immutable artifact body |
| Subject digest | Digest of the claim subject |
| Policy id | Policy or gate policy under which the artifact is evaluated |
| Legacy behavior | How old artifacts are mapped (if any) |
| Reason codes | All expected rejection / downgrades for this artifact |
| Test fixtures | Adversarial + positive coverage planned |

This makes the contract review explicit and prevents “new surface without shared
entry” regressions.

For command-backed artifacts, the intake entry must reference a structured
command envelope rather than only a shell string:

```text
CommandSpec {
  executable
  args
  cwdClass
  envAllowlist
  timeoutMs
  networkPolicy
  mutationPolicy
}

BootstrapSpec {
  steps: CommandSpec[]
}
```

The evaluated artifact records `commandSpecDigest`, `bootstrapSpecDigest`,
`environmentFingerprint`, `toolchainDigest`, `exitCode`, `startedAt`,
`finishedAt`, `redactedOutputDigest`, and a bounded output excerpt. Default policy is
`cwdClass=temp-worktree`, `mutationPolicy=disposable`, and
`networkPolicy=denied-or-explicit`; running in `main` requires an explicit
override plus dirty-before and dirty-after evidence.

## Appendix B: Module-to-Clause Mapping

### B.1 Modules that must obey the contract

Post-B-0405 note: this table reports the implemented CLI state after B-0405.
Remaining unification or Authority Server production receipt work is called out
separately and must not be read as delivered by this story.

| Module / surface | Artifact kind | Current admissibility role | Must obey clauses | B-0405 CLI status / remaining work |
|---|---|---|---|---|
| `packages/main/src/core/authority-gate-receipt-verifier.ts` | Authority `gate_decision` proof | `production-gate-decision` candidate | C1, C3-C8, C11, C12 | Strong CLI verifier path is strict-shape and claim-policy aware; Authority Server production receipt execution remains out of B-0405 scope |
| `packages/main/src/core/authority-receipt-classification.ts` | Evidence-envelope receipt | `authority-receipt` candidate | C1, C3, C5, C6, C11, C12 | Subject binding remains strong and is represented in shared diagnostics; future work is cross-runtime fixture parity |
| `packages/main/src/core/authority-boundary.ts` | Local/shadow authority submission | `local-diagnostic` classifier | C1, C9, C11 | Anti-overclaim classification feeds the shared scope boundary; local/shadow output still cannot set Authority completion or `productionDone` |
| `packages/main/src/core/receipt-bundle.ts` | Offline local signed bundle | `local-key-single-host` | C1, C3-C7, C9, C11, C12 | Strict-shape/signature/freshness behavior remains strong and explicitly non-Authority |
| `packages/main/src/core/done-required-validation.ts` | DONE-required command receipts | `local-gate-evidence` | C1, C3, C5, C7, C8, C10, C11 | Freshness, policy, command coverage, scope diagnostics, and enforce-mode blocking are wired for the CLI consumer |
| `packages/main/src/core/review-run.ts` | Reviewer run, finding, review pass | REVIEW gate evidence | C1, C3, C5-C8, C11 | Lane/round/latest/signature/freshness checks remain strong and are surfaced through registered proof diagnostics |
| `packages/main/src/core/lattice-handoff.ts` | Handoff pack/receipt/dispatch | Context + local diagnostic evidence | C1, C7-C9, C11, C13 | Handoff projections now render typed artifact classes and keep local diagnostics separate from admissible proof refs |
| `packages/main/src/core/process-fact-registry.ts` and `process-fact-levels.ts` | Gate-consumed process facts | Registry / drift guard | C1, C8-C11 | Process facts include `runtime:proof_admissibility_gate_diagnostic`; future process-fact additions must stay synchronized with the admissibility registry |
| `packages/main/src/core/repro-intake.ts` | Repro-first candidate surfaces (`repro-*`, `spike-*`, red-green relation, binding) | `evidence-candidate` | C1, C8, C11 | Registry-facing candidate artifacts are implemented as registry entries; they remain candidate-only and cannot satisfy lifecycle or production claims |
| `packages/main/src/handlers/repro-intake.ts` | Repro-first CLI commands and handlers | candidate-only command surfaces | C1, C8, C11 | CLI command surface remains underscore names; artifact kinds are canonicalized to hyphenated registry values before evaluator projection |
| `packages/main/src/core/usage-ledger/authority-evidence.ts` | Usage evidence envelope + receipt gate | Privacy-preserving evidence candidate | C1, C5, C6, C9, C11, C14 | Local privacy and fail-safe receipt handling remain strong; future work is broader shared command-envelope adoption |
| `packages/main/src/core/gate-strength.ts` and `gate-strength` tasks | Gate-strength result digest | Local methodology proof | C3-C5, C11, C12 | B-7b6e semantic-binding lesson is represented in the B-0405 adversarial matrix for reason/verdict tamper |
| `packages/main/src/handlers/authority-enforce.ts` | Authority receipt verify/fetch/write path | Producer of receipt refs | C1, C3-C9, C11, C12 | CLI receipt-ref handling is diagnostic/enforce aware; Authority Server production receipt behavior remains a future/server-side responsibility |
| `packages/main/src/handlers/lattice-handoff.ts` | Handoff CLI surface | Handoff context/diagnostic surface | C1, C9, C13 | Handoff output renders scope/class labels so hosts cannot read local transfer output as completion proof |
| `packages/main/src/handlers/verdict*` / `quorum-submit` | Local or Authority host verdicts | Local quorum or Authority verdict candidate | C1, C6-C9, C11 | Local review quorum remains distinct from Authority receipt completion; proof diagnostics preserve that boundary |
| `packages/main/src/core/evidence-freshness.ts` | Freshness primitive | Shared supporting check | C7, C11 | Hash freshness remains central; reason-code vocabulary is aligned for B-0405 proof diagnostics and should be reused by future consumers |

### B.2 Practical conclusion

The contract is not replacing the current safeguards. It is the coordination
layer above them:

```text
existing per-surface verifier
  -> proof-admissibility classifier
  -> artifact consumer / gate-specific consumer
  -> claim wording / productionDone boundary
```

The most important implementation rule is that no new proof-looking artifact
may be added directly to a gate. It must first declare:

1. artifact kind;
2. producer boundary;
3. admissibility scope;
4. required schema/version;
5. semantic digest/signature subject;
6. temporal/material binding;
7. artifact role, intended claim, and claim subject;
8. allowed artifact consumers;
9. reason codes for rejection.

Pre-story repro/spike artifacts are a special case of this same rule:

- `repro-probe`, `repro-review`, `spike-record`, `spike-review`,
  `red-green-relation`, `regression-matrix-review`, and
  `red-green-relation-evaluation` start as scoped artifacts with explicit roles;
  all are pre-story `evidence-candidate`.
- They may inform story creation and planning.
- They may not satisfy REVIEW/TEST/DONE/Authority gates until promoted into a
  story-bound verification intent / current verification evidence path and
  evaluated under the correct temporal role.
- Bootstrap or environment failures must stay candidate diagnostics; they cannot
  be upgraded to proof of a product bug.

## Appendix C: Evidence Admissibility Ledger Schema

Source-of-truth hierarchy:

1. The artifact-specific verifier result is authoritative.
2. The ledger is an append-only audit record and optional cache of verifier
   results.
3. The waterline is a derived projection of ledger rows.
4. Neither a ledger row nor a waterline status can independently promote an
   artifact to a stronger admissibility scope.

### C.1 Evidence Admissibility Ledger (Machine-Readable Record)

Your question about “a table/state machine for all proof checks” is correct, but the shape is:

- The **workflow state machine** is still `INIT → INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE`.
- The new layer is a **Proof Admissibility Ledger** that records what each artifact can prove at that moment.

That means we maintain rows, not a separate contract-per-failure state machine:

```text
ArtifactObservedEvent {
  eventId
  artifactKind
  artifactRef
  artifactDigest
  subjectDigest
  schemaVersion
  producerBoundary
  producedAt
  producer
  subjectBinding:
    | {
        kind: "pre-story-candidate"
        candidateId
        headHash
        materialHash
        executionContextDigest
      }
    | {
        kind: "historical-baseline"
        storyId
        baselineHeadHash
        baselineMaterialHash
        sourceCandidateDigest
      }
    | {
        kind: "story"
        storyId
        headHash
        materialHash
        storyFilesHash
      }
    | {
        kind: "transition-relation"
        storyId
        baselineArtifactDigest
        currentArtifactDigest
        baselineCommandSpecDigest
        currentCommandSpecDigest
        acceptanceRowDigest
      }
}

AdmissibilityEvaluationRow {
  evaluationId
  artifactEventId
  artifactKind
  artifactDigest
  subjectDigest
  schemaVersion
  contractVersion
  verifierVersion
  policyId
  intendedClaim
  claimSubject
  temporalRole
  consumer
  scope
  scopeReason
  overall: pass | warn | fail | error
  bindingStatus: current | stale | historical-valid | relation-valid | not_applicable
  clauseResults: [
    {
      clause: C1 | ... | C14
      result: pass | fail | not_applicable
      reasonCodes: [code]
    }
  ]
  remediation
  evaluatedAt
  evaluator
  supersedesEvaluationId?
}

EvidenceConsumptionEvent {
  consumptionId
  consumer
  claim
  claimSubject
  policyId
  evaluationIds
  decision: allow | deny
  consumedAt
}
```

How we update it:

1. Producer appends `ArtifactObservedEvent` only.
2. Verifier/evaluator appends `AdmissibilityEvaluationRow`.
3. Consumer uses the latest applicable evaluation or re-verifies, then appends
   `EvidenceConsumptionEvent`.
4. Historical rows remain immutable.
5. On current-state hash drift (`materialHash` / `headHash` /
   `storyFilesHash` changed), freshness is recomputed against the current hash
   tuple and unmatched story rows become `bindingStatus: stale`.
6. Historical-baseline rows are not expected to match current material; they
   must instead remain bound to their baseline material and candidate digest.
7. Transition-relation rows are valid only when baseline/current artifact
   digests, command equivalence, and acceptance row binding all match; successful
   relation checks use `bindingStatus: relation-valid`.
8. If a new bug pattern appears, append a new evaluation row with reason code and
   remediation. Update only derived current views, never historical rows.
9. Add a new `contractVersion` only when we intentionally extend/redefine rules
   (for example new producer boundary or new proof kind), not for each incident.

Consumable rows must satisfy:

```text
consumable =
  overall == pass
  AND bindingStatus is valid for temporalRole
  AND artifactDigestMatches
  AND verifierVersionSupported
  AND contractVersionSupported
  AND policyIdMatches
  AND consumerMatches
  AND bindingValidForClaim
  AND scopeAllowsClaim
```

`overall` meanings:

| Overall | Meaning | Consumer behavior |
|---|---|---|
| `pass` | The artifact satisfied the required proof checks for this consumer and claim. | May be consumed if the remaining row predicates also match. |
| `warn` | The artifact is useful context, but not strong proof for this consumer and claim. | May inform operators; must not satisfy strong proof. |
| `fail` | The artifact was evaluated successfully and failed proof requirements. | In enforce mode, blocks the matching high-risk proof consumer. |
| `error` | The evaluator/checker failed before it could classify the artifact. | Fail-open for workflow availability only: warning, `allowed=false`, never strong proof, never `productionDone`. |

This distinction prevents two unsafe collapses: a bad proof must not look like a
checker outage, and a checker outage must not be counted as proof.

This gives machine reusability:

- New runtime/host can load the same ledger and know whether evidence is still admissible.
- New incident can be handled by adding a traceable row reason, instead of changing behavior ad-hoc.
- High churn paths keep history, because stale rows are preserved rather than overwritten silently.

#### C.1.1 Issue / Post-Fix Risk Checklist

| Issue | Fix action | New risk after the fix | Mitigation |
|---|---|---|---|
| Client-writable metadata can look like server proof | reserved proof-key registry + strip reserved keys | Existing scripts using custom metadata keys may fail validation | Explicit key allowlist + migration dry-run output |
| Local diagnostic receipts reused as proof | strict scope and consumer matching in ledger | Some existing operators lose “acceptance” signal in outputs | Keep `local-diagnostic` scope, no claim loss, clearer wording |
| Partial digest / signature coverage | shared semantic field binding + strict shape checks | Legacy artifacts may fail verification due to schema gaps | C3/C4 downgrade path to `legacy-observed` + repair command |
| Gate consumes wrong artifact for wrong phase | artifact consumer binding in ledger checks | Harder to pass some existing tests until fixtures are updated | Add fixture-upgrade matrix in M7 before enforce mode |
| Handoff work transfer mislabeled as proof | artifact split + context/evidence/proof class | New handoff payload must carry more explicit fields | Preflight prints class map and required fields |
| Non-shared reason codes | centralized code vocabulary | More strict rejects can look “noisy” at first | Warn-mode rollout + explicit remediation text |
| Cross-host/hotfix drift | host-independent digest/shape/producer rules | False failures during mixed old/new rollout windows | Versioned contract with compatibility policy |
| Checker failure hidden inside proof failure | model checker failures as `overall=error` with `checker_error` | Operators might treat fail-open as proof-open | `overall=error` is warning-only, `allowed=false`, and cannot set `productionDone` |

### C.2 Contract-vs-code mapping by temporal/material dimensions

Material bindings in the ledger are evaluated according to temporal role:

- `current-state`: current `materialHash`, `headHash`, and story-bound
  `storyFilesHash` are hard freshness anchors.
- `historical-baseline`: `baselineMaterialHash`, `baselineHeadHash`, and source
  candidate digest are immutable historical anchors; they are not expected to
  match current material.
- `transition-relation`: baseline artifact digest, current artifact digest,
  command equivalence, and claim subject must all match.

Any current-state row with a stale hash tuple is machine-closed
(`bindingStatus: stale`) and cannot be consumed by DONE/REVIEW/Authority gates.
Historical-baseline rows remain consumable only as historical inputs to a valid
transition relation. Transition-relation rows use `bindingStatus:
relation-valid` when the relation is mechanically or reviewer-verified.

So your interpretation is mostly right:

- When we discover a new issue before DONE, we append a new evaluation row and
  keep the trace.
- We only mint a new contract version when the admissibility rule set itself changes.

## Appendix D: Admissibility Waterline Schema

The ledger records individual rows. Operators also need a derived waterline view
to quickly identify where the proof contract is weak.

The waterline value is diagnostic only:

- it shows which consumer or gate has a gap;
- it shows which clauses are repeatedly missing;
- it distinguishes missing contract integration from hash drift;
- it surfaces compatibility downgrades without accepting them as proof.

```text
AdmissibilityWaterline {
  contractVersion
  evaluatedAt
  evaluationEnvironment: local | hosted | production-like
  consumerWaterline: [
    {
      consumer: AUTHORITY_GATE_DECISION | DONE_REQUIRED | REVIEW | HANDOFF | TEST | DONE | STORY_INTAKE | PLAN
      subjectSelector: candidateId | storyId | authoritySubjectId
      requiredClauses: [C1, C2, C3, C4, C5, C6, C7, C8, C9, C11, C12]
      matchedClauses: [C1, C3, C4, C5, C6, C7, C9, C11]
      missingClauses: [C2, C8, C12]
      passRows: 180
      warnRows: 12
      failRows: 3
      staleRows: 7
      legacyRows: 21
      status: "green | yellow | red"
      topReasons: [
        { code: "clause_not_bound", count: 3 },
        { code: "stale_hash_tuple", count: 7 }
      ]
    }
  ]
  staleRatio
  maxStaleAgeHours
  highSeverityFailCount
  unknownArtifacts
}
```

Minimum implementation:

- Add `lattice admissibility_waterline` or an equivalent
  `lattice audit --kind=admissibility_waterline` entry point.
- Output each consumer's `pass / warn / fail / error / stale` buckets,
  `missingClauses`, and top reasons.
- `status=red` blocks high-risk advancement only when the row matches the
  current blocking scope.
- Recompute on story DONE and at least every 24 hours.
- A story entering REVIEW should inspect the waterline first, then inspect the
  concrete ledger rows that explain the waterline.

All counts are derived from ledger rows and clause arrays. Counts are rendered
for operator convenience, not accepted as an independent source of truth.

Suggested thresholds, tunable by environment:

- `missingClausesRatio > 0.05`: red.
- `AUTHORITY_GATE_DECISION` or `DONE_REQUIRED` has matching `failRows > 0`: red.
- `staleRatio > 0.20`: yellow; `> 0.40`: red.
- `legacyRows` keeps rising with no repair channel: yellow.
- `errorRows > 0`: yellow for workflow recovery, red only when the project tries
  to consume that errored row as strong proof.

Blocking waterline rows must match:

- current subject selector (`candidateId`, `storyId`, or `authoritySubjectId`);
- current `ArtifactConsumerKind`;
- current `contractVersion`;
- current temporal/material binding for the artifact role;
- active policy;
- latest non-superseded evaluation.

Historical failed rows and stale rows remain visible for audit, but they must not
block unrelated stories merely because they exist in the ledger history.

Fast diagnosis rules:

- red with non-empty `missingClauses`: likely missing contract integration for a
  new surface or path.
- red with non-zero `failRows`: likely hash, signature, producer, or consumer
  binding failure; treat as high priority.
- red with high `staleRows`: likely material/storyFiles/head drift without a
  fresh evaluation.
- yellow with rising `legacyRows`: likely historical evidence entering a strong
  evidence view; document and repair the compatibility path.
- yellow with `errorRows`: likely checker/runtime failure; rerun or repair the
  checker and do not consume the errored row as proof.

## Appendix E: Standard Value Dictionary

To prevent `consumer`, `status`, `scope`, and `reason` vocabulary drift across
stories and modules, new implementation work should write only the values in
this dictionary. Readers may accept compatibility aliases, but new writers must
use canonical values.

#### ArtifactConsumerKind

- `STORY_INTAKE`
- `PLAN`
- `REVIEW`
- `TEST`
- `DONE`
- `HANDOFF`
- `AUTHORITY_GATE_DECISION`
- `DONE_REQUIRED`

#### CLI command to artifact kind mapping

| CLI command | Artifact kind |
|---|---|
| `repro_probe` | `repro-probe` |
| `repro_review_set` | `repro-review` |
| `spike_record` | `spike-record` |
| `spike_review_set` | `spike-review` |
| `story_create_from_repro` | `story-evidence-binding` |
| `red_green_relation_create` | `red-green-relation` |
| `red_green_relation_evaluate` | `red-green-relation-evaluation` |
| `regression_matrix_review_set` | `regression-matrix-review` |
| `validate` / DEV / TEST evidence writers | `current-verification-evidence` |
| Authority-facing adapter gate decision refs | `authority-receipt-ref` |
| Legacy Authority receipt compatibility refs | `legacy-authority-receipt-ref` |

Projection rule:

- `command` names are CLI dispatch names (underscore).
- `artifactKind` is the canonical hyphenated contract key used by registries and evaluators.
- Claim consumption must use registry lookup by `artifactKind`; `command` names alone can never determine admissibility.

Compatibility aliases, read-only:

- `AUTHORITY_GATE` -> `AUTHORITY_GATE_DECISION`
- `LOCAL_REVIEW_QUORUM` -> `REVIEW`
- `LEGACY_AUTHORITY_RECEIPT` remains readable as compatibility-only diagnostic
  input and must not be used for new strong proof consumers.
- `gate` -> `consumer`

#### ArtifactRole

- `problem-observation`
- `repro-validity-review`
- `planning-input`
- `planning-review`
- `current-verification`
- `regression-matrix-review`
- `red-green-relation`
- `handoff-context`
- `local-diagnostic`
- `authority-decision`

#### ClaimKind

- `historical-failure`
- `current-pass`
- `current-fail`
- `red-green-equivalence`
- `review-pass`
- `done-readiness`
- `production-completion`
- `handoff-context`
- `diagnostic-status`

#### Scope

- `audit-note`
- `legacy-observed`
- `legacy-local-only`
- `legacy-unknown-producer`
- `evidence-candidate`
- `local-diagnostic`
- `local-key-single-host`
- `local-gate-evidence`
- `local-review-quorum`
- `authority-receipt`
- `production-gate-decision`

Read-only compatibility scope:

- `legacy-authority-receipt` is accepted only for legacy receipt compatibility
  rows and must not be emitted for new strong proof surfaces.

#### ProofProducerBoundary

- `caller-writable`
- `local-runtime-owned`
- `authority-owned`
- `trusted-reviewer-owned`
- `legacy-unknown`

Read-only compatibility producer boundary:

- `legacy-authority-owned` is accepted only for legacy receipt compatibility
  rows and must not be emitted for new strong proof surfaces.

#### Local CLI proof vocabulary

The local CLI proof-admissibility core names proof output with
`admissibilityStatus`, `assuranceLevel`, and `evidenceScope`. Authority
production receipts are external adapter/future compatibility evidence, not
local production completion claims.

#### AdmissibilityStatus

- `admissible`
- `inadmissible`

#### AssuranceLevel

- `none`
- `diagnostic`
- `local-gate`
- `authority-adapter`

#### Legacy Overall (artifact-level compatibility result)

- `pass`
- `warn`
- `fail`
- `error`

`error` is reserved for checker/evaluator failure. It is not proof success and
not proof failure. It is warning-only for workflow availability and must remain
`allowed=false`.

#### BindingStatus

- `current`
- `stale`
- `historical-valid`
- `relation-valid`
- `not_applicable`

#### TemporalRole

- `historical-baseline`
- `current-state`
- `transition-relation`
- `not-applicable`

#### ClauseResult

- `pass`
- `fail`
- `not_applicable`

#### Standard reason code

- `unsupported_schema_version`
- `unsupported_contract_version`
- `unsupported_verifier_version`
- `checker_error`
- `bad_shape`
- `missing_required_field`
- `unexpected_field`
- `signature_missing`
- `signature_invalid`
- `digest_mismatch`
- `stale_head`
- `stale_material`
- `stale_story_files`
- `stale_hash_tuple`
- `story_mismatch`
- `artifact_subject_mismatch`
- `producer_mismatch`
- `unknown_producer`
- `producer_owned_required`
- `artifact_consumer_mismatch`
- `gate_phase_mismatch`
- `temporal_role_mismatch`
- `historical_baseline_missing`
- `current_state_missing`
- `red_green_relation_missing`
- `red_green_command_mismatch`
- `equivalence_review_missing`
- `matrix_gap_unwaived`
- `bootstrap_noise`
- `environment_noise`
- `command_spec_missing`
- `command_spec_digest_mismatch`
- `bootstrap_spec_digest_mismatch`
- `clause_not_applicable`
- `clause_not_bound`
- `local_diagnostic_non_gate`
- `reserved_key_detected`
- `legacy_downgrade`

#### Recommended unified output fragment

```json
{
  "consumer": "AUTHORITY_GATE_DECISION",
  "artifactKind": "authority-receipt-ref",
  "artifactRole": "authority-decision",
  "intendedClaim": "production-completion",
  "claimSubject": "story:B-xxxx",
  "scope": "production-gate-decision",
  "temporalRole": "current-state",
  "overall": "pass",
  "bindingStatus": "current",
  "reasonCodes": [],
  "materialHash": "sha256:...",
  "headHash": "sha256:...",
  "storyFilesHash": "sha256:..."
}
```

Failure example:

```json
{
  "consumer": "AUTHORITY_GATE_DECISION",
  "artifactKind": "authority-receipt",
  "artifactRole": "authority-decision",
  "intendedClaim": "production-completion",
  "claimSubject": "story:B-xxxx",
  "scope": "authority-receipt",
  "temporalRole": "current-state",
  "overall": "fail",
  "bindingStatus": "current",
  "reasonCodes": ["artifact_consumer_mismatch"],
  "materialHash": "sha256:...",
  "headHash": "sha256:...",
  "storyFilesHash": "sha256:..."
}
```

## Appendix F: Historical Lessons / Prior Bugs

### F.1 From scattered guardrails to one ledger

Earlier fixes landed in separate stories: some hardened `metadata`, some
hardened `digest`, and some hardened `authority` boundaries. The missing piece
was one gate-facing intake point that classifies proof-looking values before any
consumer trusts them.

| Category | Prior fix fragment | Before the unified contract | After the unified contract |
|---|---|---|---|
| Client-writable metadata forged proof fields | `B-e9cb` / `B-bfa9` | New paths could still introduce spoofed metadata fields and be misconsumed. | Reserved keys and producer ownership are checked at one intake boundary. |
| Semantic fields were not digest-bound | `B-7b6e` | New semantic fields such as reason or gate context could look verified while being edited. | `semanticFieldBinding` becomes a shared check for every gate class. |
| Signature and shape checks diverged | `B-4c65` | Each signature class carried its own shape/version policy, so new surfaces could omit checks. | Strict shape plus schema/version rules reduce implementation drift. |
| Local-shadow output was over-read as authority proof | `authority-boundary` and historical handoff work | Diagnostic signals could still be consumed as proof. | Scope plus consumer decides whether any claim is allowed. |
| Stale and legacy handling was ad hoc | Multiple local compatibility paths | The same old evidence could behave differently in different modules. | `legacy-observed` and `stale` semantics are shared. |

Conclusions:

- Unified management should significantly reduce repeated evidence-spoofing
  regressions, especially "new feature + new surface + reviewer/gate path not
  wired into the contract" failures.
- It will not eliminate every future issue because new hosts, surfaces, and data
  models will continue to appear. It changes the failure from scattered latent
  risk into a traceable ledger gap.
- Future fixes should usually be faster: add a ledger row and reason code before
  rebuilding a bespoke proof chain.

Suggested follow-up metric:

- In the 30 days after enforce mode is enabled, repeated high-risk
  evidence-spoofing regressions should trend down. The target is sustained
  reduction, not an unrealistic claim of zero.
- Similar risks should become visible at intake rather than only after a later
  consumer misreads the artifact.

## Appendix G: Unified Close Checklist

High-risk proof-path stories should use this checklist so that fixing one proof
surface does not leave the same bug class open in another surface.

- Step 1: contract integration inventory
  - List every new or changed proof-like artifact, including handoff, context,
    evidence, and decision artifacts.
  - Check whether the module-to-clause table covers every required C1-C14 clause
    for the artifact.
  - New artifacts must declare `producer`, `scope`, `ArtifactConsumerKind`,
    `ArtifactRole`, `ClaimKind`, `claimSubject`, and reason codes.
- Step 2: evidence ledger write path
  - Producers append only `ArtifactObservedEvent`; they do not write
    admissibility conclusions.
  - Evaluators append `AdmissibilityEvaluationRow`.
  - Consumers use the latest applicable evaluation, or rerun the shared
    admissibility evaluator before gate entry.
- Step 3: consistency threshold check
  - Generate the current consumer waterline through `lattice
    admissibility_waterline` or an equivalent entry point.
  - `AUTHORITY_GATE_DECISION` / `DONE_REQUIRED` `failRows > 0` blocks only when
    it matches the current story, consumer, contract version, hash/temporal
    binding, active policy, and latest non-superseded evaluation. Historical
    failures remain visible but do not block unrelated stories.
- Step 4: hash tuple check
  - Record the current `materialHash`, `headHash`, and `storyFilesHash`.
  - Check that stale counts are explained by a legitimate rerun or update path.
- Step 5: compatibility and downgrade explanation
  - If `legacy` or `local-diagnostic` appears, output must say it is audit or
    diagnostic material only and cannot claim production completion.
- Step 6: delivery signoff
  - REVIEW notes for high-risk proof-path stories should include the story's
    `missingClauses`, `topReasons`, `legacyRows`, `errorRows`, and
    `highSeverityFailCount`.

Close signals:

- Key consumers such as `AUTHORITY_GATE_DECISION`, `REVIEW`, and `DONE_REQUIRED`
  should be green for the current subject.
- Yellow status is acceptable for compatibility or migration noise only when a
  repair plan and owner are attached.
- Any `contractVersion` upgrade must trigger same-day regression and a waterline
  snapshot.
