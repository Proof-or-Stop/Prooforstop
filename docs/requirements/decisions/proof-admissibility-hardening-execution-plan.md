# Proof Admissibility Hardening Execution Plan

> Status: execution plan; M0/M1 classification-only MVP implemented by B-0985.
> Date: 2026-06-23.
> Scope: Proofbound / Lattice CLI evidence, receipt, handoff, and gate-consumption boundaries.
> Architecture baseline: `docs/evidence/evidence-platform-architecture.md`.

This plan migrates existing proof-looking surfaces onto the shared Evidence
Runtime architecture. It must not create a separate Proof Admissibility manager,
storage root, ledger format, or gate-specific proof implementation.

B-0985 implements the first classification-only slice: the inventory, canonical
enum vocabulary, proof surface registry, and evaluator. It does not hard-fail
gates, change Authority Server behavior, or create storage outside
`.lattice/evidence/`.

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

Implementation boundary:

- Use the shared `EvidenceRuntime` facade.
- Register proof surfaces through `ArtifactDefinition`.
- Evaluate gate claims through `ClaimPolicy`.
- Store artifacts and ledger streams under `.lattice/evidence/`.
- Keep existing strong verifiers, but connect them through adapters instead of
  rewriting them in the first migration slice.

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
  AND strictShapeValid
  AND semanticDigestValid
  AND signatureOrAuthorityBindingValid
  AND temporalAndMaterialBindingValid
  AND artifactConsumerMatches
  AND scopeAllowsClaim
```

Anything else is still useful, but it is not strong proof:

| Evidence scope | Meaning | May set `productionDone`? |
|---|---|---|
| `audit-note` | Human-readable note, log, summary, prose, or diagnostic text | No |
| `legacy-observed` | Historical evidence preserved for audit but missing the current contract | No |
| `evidence-candidate` | Pre-story or handoff candidate evidence that may inform intake/planning but is not gate proof | No |
| `local-diagnostic` | Local/shadow CLI output, fake/local receipt, host status, handoff status | No |
| `local-key-single-host` | Offline signed local bundle from one key/host | No |
| `local-gate-evidence` | Strong local lifecycle gate readiness evidence | No |
| `local-review-quorum` | Local 3 round x 2 host verdict over current material | No Authority claim; may satisfy local review escalation |
| `authority-receipt` | Signature-verified Authority receipt with subject binding | No; it may only be input to a matching gate |
| `production-gate-decision` | Verified Authority `gate_decision` receipt consumed by the matching gate | Yes, if all policy checks pass |

An authority receipt is evidence. It is not a production claim by itself.
Only a matching gate-consumed `production-gate-decision` may support
`productionDone = true`.

Temporal role is separate from evidence scope:

| Temporal role | Meaning | Binding rule |
|---|---|---|
| `historical-baseline` | Evidence that old material exhibited a target failure | Binds baseline head/material and source artifact digest; does not require current HEAD |
| `current-state` | Evidence that current material passes/fails a check | Requires current head/material/story files where story-bound |
| `transition-relation` | Evidence that historical red and current green describe the same acceptance row | Binds baseline artifact digest, current artifact digest, command equivalence, and claim subject |

For repro-first flows, REVIEW/TEST/DONE consume a valid historical baseline,
fresh current-state green evidence, and a valid transition relation. They do not
consume a "fresh red" on current material.

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

1. Add a core module such as `packages/main/src/core/proof-admissibility.ts`.
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
`packages/main/src/core/proof-admissibility.ts`; the focused smoke command is
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

Deliverables:

- Enforce policy.
- Adversarial suite.
- 3x2 review evidence for hard-fail rollout.

Exit criteria:

- In enforce mode, no inadmissible proof-looking artifact can satisfy a strong
  gate.
- In warn mode, local development remains usable with clear diagnostics.

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
| Valid new Authority `gate_decision` receipt consumed by matching gate | `production-gate-decision`, eligible for production claim under policy |
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

Current code has many strong local protections, but they are implemented per
surface. The missing layer is a single admissibility contract that every proof
consumer must call before treating an artifact as proof.

### A.1 Contract clauses

| Clause | Contract requirement | Current code status | Current code examples | Gap / action |
|---|---|---|---|---|
| C1: Single scope classifier | Every proof-looking artifact must classify into exactly one canonical `EvidenceScope` defined in Appendix E before any consumer interprets it | Partial | `authority-boundary.ts` classifies local/shadow/receipt-backed L2+; `receipt-bundle.ts` hardwires `local-key-single-host`; `lattice-handoff.ts` forces `productionDone=false`; process fact registry labels many non-authority commands | Add shared `proof-admissibility.ts`; migrate local classifiers to one enum/reason-code set |
| C2: Producer ownership | Proof fields must be produced by the owning authority, not by caller-writable metadata | Missing as a universal rule | Authority sibling fixes `B-e9cb` / `B-bfa9`; current Proofbound code has local per-artifact writers but no reserved proof-key registry | Add reserved proof-key registry and metadata sanitizer for every metadata-carrying proof surface |
| C3: Supported schema version | Strong proof artifacts must carry an accepted schema/version and reject unsupported versions | Mostly present per artifact | `done-required-validation.ts` checks schema/version; `receipt-bundle.ts` checks `lattice.receipt_bundle.v1`; `authority-gate-receipt-verifier.ts` checks `lattice.authority_gate_receipt_proof.v1`; `lattice-handoff.ts` checks handoff receipt schema | Centralize version support policy and downgrade old shapes to `legacy-observed` where appropriate |
| C4: Strict shape before trust | Strong proof verification must reject null, wrong type, missing field, and unexpected proof keys before interpreting signed fields | Partial | `receipt-bundle.ts` does strict shape and rejects extra keys/nulls; `authority-gate-receipt-verifier.ts` uses Zod schemas with `.passthrough()` on gate proof/input/decision; DONE receipts validate required fields but do not use one shared strict-shape contract | Decide which artifacts may be passthrough diagnostics and which must be strict; add strict shape for strong proof paths |
| C5: Semantic digest coverage | Every gate-consumed semantic field must be included in the digest/signature subject | Partial | `authority-gate-receipt-verifier.ts` recomputes input/decision digests and subject digest; `receipt-bundle.ts` signs the bundle body; B-7b6e fixed a gate-strength digest omission | Add semantic-field coverage tests for every gate-consumed claim, including `reason`, verdict, producer/verifier ids, policy, and evidence refs |
| C6: Signature / receipt binding | A signature or receipt must bind to the actual subject, trusted key, story, and gate context | Strong for key paths, not universal | `authority-receipt-classification.ts` verifies receipt subject binding to an envelope; `authority-gate-receipt-verifier.ts` verifies signature, subject kind/id/digest, key trust; `review-run.ts` verifies signed reviewer runs; `receipt-bundle.ts` verifies trusted local key | Route all future signed/receipt-like artifacts through a shared binding checklist |
| C7: Temporal and material binding | Proof must declare whether it is historical-baseline, current-state, or transition-relation, and validate the correct hash/material rule for that role | Strong for current review/DONE/Authority; missing for historical red-to-green relations | `review-run.ts` checks `headHash`, `materialHash`, and `storyFilesHash`; `done-required-validation.ts` blocks stale current material; repro-first requires historical baseline + current green + relation | Add temporal role, baseline/current binding rules, and red-green relation validation |
| C8: Artifact consumer matching | Proof must be consumed only by the consumer it was produced for, including non-gate consumers such as story intake | Partial | `authority-gate-receipt-verifier.ts` checks target phase; `review-run.ts` checks lane/current round/latest run; process fact registry records `consumerGate` for many artifacts | Add machine-checkable `ArtifactConsumerKind` in the admissibility registry and verify process-fact coverage |
| C9: Non-authority cannot overclaim | Local/shadow/diagnostic/worker output must not set `receiptVerified`, `authorityDone`, `fullAuthorityDone`, or `productionDone` | Strong in many surfaces | `authority-boundary.ts`, `lattice-handoff.ts`, `usage-ledger/authority-evidence.ts`, `process-fact-levels.ts`, and `docs/guide.md` all preserve this boundary | Keep behavior; replace repeated local booleans with shared scope classification where practical |
| C10: Legacy scope | Historical evidence missing the current contract must remain readable but not strong-admissible | Missing as a unified behavior | DONE-required and review-run code have some legacy compatibility, but there is no universal `legacy-observed` output | Add legacy classifier and migration/dry-run; do not delete old evidence |
| C11: Stable reason codes | Rejections must have machine-readable reason codes and remediation hints | Partial | Authority gate receipt has enumerated failure reasons; receipt bundle has ordered reasons; review-run and DONE-required have reason strings; handoff has warnings/validations | Normalize reason code vocabulary across modules |
| C12: Cross-runtime vectors | CLI and Authority Server must run the same tamper/shape/stale/semantic fixtures | Missing | Current smokes are TypeScript-local; sibling Authority fixes are documented but not shared vectors | Add JSON fixture pack and require CLI + Authority Server conformance |
| C13: Handoff artifact class split | Handoff must distinguish context, evidence candidate, diagnostic receipt, and admissible proof ref | Partial | `lattice-handoff.ts` has `authorityBoundary`, `packHash`, `receiptVerified=false`, `productionDone=false`, and local diagnostic receipt submission | Add typed handoff artifact classes and preflight output showing admissibility scope per ref |
| C14: Privacy-safe reproducible command envelope | Command-backed evidence must record structured command specs, bootstrap/environment digests, and bounded redacted output without leaking raw prompts/secrets | Present for usage ledger privacy; missing for generic command evidence | `usage-ledger/authority-evidence.ts` builds privacy-preserving envelopes and fail-safe receipt verification; repro-first requires `CommandSpec`, `bootstrapSpecDigest`, `environmentFingerprint`, and redacted output digest | Add shared command envelope policy for repro, DONE-required, review evidence, and Authority-bound receipts |

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

| Module / surface | Artifact kind | Current admissibility role | Must obey clauses | Current status |
|---|---|---|---|---|
| `packages/main/src/core/authority-gate-receipt-verifier.ts` | Authority `gate_decision` proof | `production-gate-decision` candidate | C1, C3-C8, C11, C12 | Strong core checks; strict shape and shared enum still missing |
| `packages/main/src/core/authority-receipt-classification.ts` | Evidence-envelope receipt | `authority-receipt` candidate | C1, C3, C5, C6, C11, C12 | Strong subject binding; needs shared contract integration |
| `packages/main/src/core/authority-boundary.ts` | Local/shadow authority submission | `local-diagnostic` or `receipt-backed-l2-plus` classifier | C1, C9, C11 | Good anti-overclaim classifier; should feed shared scope enum |
| `packages/main/src/core/receipt-bundle.ts` | Offline local signed bundle | `local-key-single-host` | C1, C3-C7, C9, C11, C12 | Strong strict-shape/signature/freshness; must remain non-Authority |
| `packages/main/src/core/done-required-validation.ts` | DONE-required command receipts | Local gate evidence | C1, C3, C5, C7, C8, C10, C11 | Strong freshness/policy/command coverage; needs shared scope and stricter receipt shape |
| `packages/main/src/core/review-run.ts` | Reviewer run, finding, review pass | REVIEW gate evidence | C1, C3, C5-C8, C11 | Strong lane/round/latest/signature/freshness checks; should declare scope through registry |
| `packages/main/src/core/lattice-handoff.ts` | Handoff pack/receipt/dispatch | Context + local diagnostic evidence | C1, C7-C9, C11, C13 | Strong anti-overclaim; needs typed artifact class split |
| `packages/main/src/core/process-fact-registry.ts` and `process-fact-levels.ts` | Gate-consumed process facts | Registry / drift guard | C1, C8-C11 | Many entries already record non-authority boundaries; add admissibility registry synchronization |
| `packages/main/src/core/usage-ledger/authority-evidence.ts` | Usage evidence envelope + receipt gate | Privacy-preserving evidence candidate | C1, C5, C6, C9, C11, C14 | Strong local privacy and fail-safe receipt gate; needs shared scope naming |
| `packages/main/src/core/gate-strength.ts` and `gate-strength` tasks | Gate-strength result digest | Local methodology proof | C3-C5, C11, C12 | B-7b6e lesson applies: semantic fields such as `reason` must be digest-bound |
| `packages/main/src/handlers/authority-enforce.ts` | Authority receipt verify/fetch/write path | Producer of receipt refs | C1, C3-C9, C11, C12 | Must call shared admissibility helper before persisting consumable refs |
| `packages/main/src/handlers/lattice-handoff.ts` | Handoff CLI surface | Handoff context/diagnostic surface | C1, C9, C13 | Must render scope labels so hosts cannot misread output |
| `packages/main/src/handlers/verdict*` / `quorum-submit` | Local or Authority host verdicts | Local quorum or Authority verdict candidate | C1, C6-C9, C11 | Must distinguish local review quorum from Authority receipt completion |
| `packages/main/src/core/evidence-freshness.ts` | Freshness primitive | Shared supporting check | C7, C11 | Already central for hashes; reason-code vocabulary should align with admissibility |

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

- `repro-probe`, `repro-review`, `spike-record`, `spike-review`, and
  `regression-matrix-review` start as scoped artifacts with explicit roles;
  only the first four are pre-story `evidence-candidate`.
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

This gives machine reusability:

- New runtime/host can load the same ledger and know whether evidence is still admissible.
- New incident can be handled by adding a traceable row reason, instead of changing behavior ad-hoc.
- High churn paths keep history, because stale rows are preserved rather than overwritten silently.

#### C.1.1 问题/修复后风险清单（建议执行时复用）

| 问题 | 修复动作 | 修复后新增的潜在问题 | 对应缓解 |
|---|---|---|---|
| Client-writable metadata can look like server proof | reserved proof-key registry + strip reserved keys | Existing scripts using custom metadata keys may fail validation | Explicit key allowlist + migration dry-run output |
| Local diagnostic receipts reused as proof | strict scope and consumer matching in ledger | Some existing operators lose “acceptance” signal in outputs | Keep `local-diagnostic` scope, no claim loss, clearer wording |
| Partial digest / signature coverage | shared semantic field binding + strict shape checks | Legacy artifacts may fail verification due to schema gaps | C3/C4 downgrade path to `legacy-observed` + repair command |
| Gate consumes wrong artifact for wrong phase | artifact consumer binding in ledger checks | Harder to pass some existing tests until fixtures are updated | Add fixture-upgrade matrix in M7 before enforce mode |
| Handoff work transfer mislabeled as proof | artifact split + context/evidence/proof class | New handoff payload must carry more explicit fields | Preflight prints class map and required fields |
| Non-shared reason codes | centralized code vocabulary | More strict rejects can look “noisy” at first | Warn-mode rollout + explicit remediation text |
| Cross-host/hotfix drift | host-independent digest/shape/producer rules | False failures during mixed old/new rollout windows | Versioned contract with compatibility policy |

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

## Appendix D: Admissibility Waterline Schema（覆盖水位）

你问的“这个 ledger 不够，还要不要一个水位”可以直接回答：要。  
建议把 ledger 之外再加一层 `waterline`，只存汇总指标，专门用于“快速定位问题在哪”。

- 如果只看每行是“记录是否过”，不够快。
- Waterline 的价值是：
  - 一眼看出哪个 consumer / gate 有缺口；
  - 哪些 clause 反复缺；
  - 是规则没接入还是哈希漂移；
  - 哪些问题是兼容降级。

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

建议执行动作（最小实现）：

- 增加命令 `lattice admissibility_waterline`（或 `lattice audit --kind=admissibility_waterline`）；
  - 输出每个 consumer 的 `pass / warn / fail / stale` 分桶、`missingClauses`、`top reason`；
  - `status=red` 仅在匹配当前阻断范围时阻断高风险推进。
- 每次 story DONE 或每 24 小时自动重算一次；
- 进入 REVIEW 的 story 先看 waterline，再看具体 ledger 行。

All counts are derived from ledger rows and clause arrays. Counts are rendered
for operator convenience, not accepted as an independent source of truth.

建议阈值（可按环境调）：

- `missingClausesRatio > 0.05`：红
- `AUTHORITY_GATE_DECISION` 或 `DONE_REQUIRED` 出现 `failRows > 0`：红
- `staleRatio > 0.20`：黄；`> 0.40`：红
- `legacyRows` 持续上升且修复通道没开：黄

Blocking waterline rows must match:

- current subject selector (`candidateId`, `storyId`, or `authoritySubjectId`);
- current `ArtifactConsumerKind`;
- current `contractVersion`;
- current temporal/material binding for the artifact role;
- active policy;
- latest non-superseded evaluation.

Historical failed rows and stale rows remain visible for audit, but they must not
block unrelated stories merely because they exist in the ledger history.

快速诊断规则（用于你问的“问题在哪”）：

- red 且 `missingClauses` 不空：多半是 contract 接入缺失（新 surface 或新路径没接入）。
- red 且 `failRows` 非零：多半是哈希、签名、producer、consumer 绑定失败（高优先级整改）。
- red 且 `staleRows` 高：多半是 material/storyFiles/head 漂移后未重新评估。
- yellow 且 `legacyRows` 上升：多半是历史证据被放进“强证据视图”导致的兼容行为，需要修复说明。

## Appendix E: 标准值域字典（防止命名漂移）

为防止不同故事/模块出现 `consumer / status / scope / reason` 名称分叉，建议统一以下值域（实现新内容时只允许使用本表）：

#### ArtifactConsumerKind（建议）

- `STORY_INTAKE`
- `PLAN`
- `REVIEW`
- `TEST`
- `DONE`
- `HANDOFF`
- `AUTHORITY_GATE_DECISION`（建议主用）
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

兼容别名（兼容读取，严禁新写入）：

- `AUTHORITY_GATE` -> `AUTHORITY_GATE_DECISION`
- `LOCAL_REVIEW_QUORUM` -> `REVIEW`
- `gate` -> `consumer`（读取时兼容，新增输出必须写 `consumer`）

#### ArtifactRole（建议）

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

#### ClaimKind（建议）

- `historical-failure`
- `current-pass`
- `current-fail`
- `red-green-equivalence`
- `review-pass`
- `done-readiness`
- `production-completion`
- `handoff-context`
- `diagnostic-status`

#### Scope（建议）

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

#### ProofProducerBoundary（建议）

- `caller-writable`
- `local-runtime-owned`
- `authority-owned`
- `trusted-reviewer-owned`
- `legacy-unknown`

#### Overall（artifact-level result）

- `pass`
- `warn`
- `fail`
- `error`

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

#### 标准 reason code（建议）

- `unsupported_schema_version`
- `unsupported_contract_version`
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

#### 推荐统一输出片段

```json
{
  "consumer": "AUTHORITY_GATE_DECISION",
  "artifactKind": "authority-gate-receipt-proof",
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

### F.1 历史复盘：之前是“分散护栏”，现在是“统一账本”

这类问题以前是被各 story 分散修过的：有些修到了 `metadata`，有些修到了 `digest`，有些修到了 `authority`，但没有一个统一面向 gate 的共享入口。可以把历史视作：

| 类别 | 先前修复片段 | 统一前问题 | 统一后收益 |
|---|---|---|---|
| 客户端可写 metadata 伪造 proof 字段 | `B-e9cb` / `B-bfa9`（各自修 metadata 与 delegated metadata 边界） | 新增路径可以继续引入新的伪造元数据字段而被误消费 | 统一 reserved key 与 producer ownership 规则，入口统一拦截 |
| 语义字段未覆盖到 digest | `B-7b6e` | 仍可能在新语义面（如 reason / gating context）出现“看起来一致、实则被篡改” | `semanticFieldBinding` 成为每类 gate 的共同检查项，降低“局部遗漏” |
| 签名/形状不一致 | `B-4c65` | 每类签名有各自形状/版本策略，新增 surface 时容易忘填 | 统一 strict-shape + schema/version 入 contract，减少实现差异 |
| local-shadow 被误读为权威 proof | `authority-boundary` 与 handoff 历史实现 | 仍容易在消费端把诊断性信号当成可用 proof | scope 统一标注，消费端按 scope+consumer 决定可否 claim |
| 手工类比 stale/legacy 处理 | 多处本地兼容处理 | 同一份旧证据在不同模块行为不一致 | 一致化 `legacy-observed` 与 `stale` 语义，降低误读 |

结论：

- 统一管理后，**会显著减少重复 bug 回归**，主要是“新增 feature + 新 surface + 审核入口没接管”这类高频问题。
- 不会“完全消灭”问题，因为新功能会引入新 surface、新 host 或新数据模型；但会把问题从“散落隐患”改为“可追踪的 ledger 缺口”。
- 这也意味着后续修复通常更快：发现问题后优先追加 ledger 行与 reason code，而不是先重建整条链路。

建议定义一个验收指标（完成后追踪）：

- 在 enforce 生效后的 30 天内，重复的 evidence-spoofing 类高危回归应明显下降（目标是持续下降而非归零）。
- 同类风险从“新增后才被发现”变为“入口即报”。

## Appendix G: Unified Close Checklist（每个 story 的防回归闭环）

为避免“这次修了 A，这次又在 B 打穿”，高风险路径改动统一执行这张清单：

- Step 1：contract 接入清点
  - 列出新增/变更的 proof-like artifact（含 handoff/context/evidence/decision）。
  - 检查 `C1~C14` 条款中的 `module -> required clauses` 是否都覆盖新 artifact。
  - 新 artifact 一律补齐 `producer`、`scope`、`ArtifactConsumerKind`、
    `ArtifactRole`、`ClaimKind`、`claimSubject`、`reason codes`。
- Step 2：证据入账
  - 产出端：只追加 `ArtifactObservedEvent`，不写 admissibility 结论。
  - 评估端：追加 `AdmissibilityEvaluationRow`。
  - 消费端：在 gate 入场前使用最新适用 evaluation，或重新调用共享
    admissibility evaluator。
- Step 3：一致性门槛检查
  - 通过 `lattice admissibility_waterline`（或等价入口）生成当前 consumer 水位。
  - `AUTHORITY_GATE_DECISION`/`DONE_REQUIRED` 的 `failRows > 0` 只有在匹配当前
    story、consumer、contractVersion、hash/temporal binding、active policy、latest
    non-superseded evaluation 时才阻断推进；历史失败只展示不阻断无关 story。
- Step 4：三重哈希校验
  - 复核并记录 `materialHash`、`headHash`、`storyFilesHash` 的当前值。
  - 检查 stale 计数是否可解释（是否有合法重跑/更新）。
- Step 5：兼容与降级说明
  - 若出现 `legacy`/`local-diagnostic`，在输出中明确其仅为审计用途，不可 claim `production`。
- Step 6：交付前签核
  - REVIEW note 必须附上本 story 的 `missingClauses`、`topReasons`、`legacyRows`、`highSeverityFailCount`。

收口指标（验收信号）：

- 目标是关键 consumer（`AUTHORITY_GATE_DECISION`、`REVIEW`、`DONE_REQUIRED`）状态为 green。
- 允许存在 yellow（主要是兼容和迁移噪声），但必须附带修复计划和责任人。
- 任何 `contractVersion` 升级必须触发当日回归与一次 waterline 快照。
