# Evidence Platform Architecture

Status: implementation baseline for the B-0aa1 candidate-only MVP plus the
B-0985 proof-admissibility classification MVP.
Date: 2026-06-24.
Scope: shared local evidence platform for Proofbound CLI.

Current vocabulary: active Proofbound CLI/runtime evidence is expressed with
`admissibilityStatus`, `assuranceLevel`, `evidenceScope`, gate-consumed local
evidence, local signed/offline receipt bundles, and local review quorum
assurance. Authority Server and server-backed receipt semantics are retired
from the active core path and appear only as legacy/out-of-core references.

This document defines the evidence storage boundary used by Repro-First intake.
The B-0aa1 slice implements the artifact storage and repro intake portions only.
B-0985 adds a shared proof-admissibility classification helper.
It does not implement retired server Authority quorum, production gate
consumption, ledger waterlines, or hard Proof Admissibility enforcement.

## Architecture Rule

Evidence-looking data must go through a shared evidence service instead of each
handler writing proof files directly.

```text
CLI / REVIEW / TEST / DONE / Local assurance
                    |
                    v
             EvidenceRuntime
                    |
       +------------+-------------+
       |                          |
       v                          v
EvidenceArtifactService   ProofAdmissibilityService
       ^
       |
ReproIntakeService
```

B-0aa1 implements the local candidate artifact store and ReproIntakeService.
B-0985 implements the first classification-only ProofAdmissibilityService shape in
`packages/main/src/core/proof-admissibility.ts`.

This slice separates concerns:

- evidence storage and lookup
- admissibility classification
- gate enforcement and local assurance semantics

Later slices can consume these interfaces for gates.

## Ownership Boundary

Evidence Platform owns the evidence data layer:

- artifact objects and refs;
- canonical digest and strict shape;
- shared artifact / proof-surface definitions;
- transaction and observed-event storage under `.lattice/evidence`;
- public EvidenceRuntime APIs used by higher layers.

Evidence Platform does not own:

- gate hard-fail policy;
- Proof Admissibility consumer/claim decisions;
- admissibility evaluation ledger semantics beyond storage support;
- global lifecycle dashboards;
- queue governance, duplicate cleanup, or experiment-batch exceptions;
- `productionDone` eligibility.

Higher layers must consume Evidence Platform through public runtime APIs. They
must not directly write proof-looking files under `.lattice/evidence` or create
parallel artifact registries.

## Evidence Model v1

Evidence is managed in two layers:

- immutable envelope object (content-addressed)
- observation record (mutable identity, timestamps, refs)

```ts
type EvidenceEnvelopeVersion = "lattice.evidence_envelope.v1";

interface EvidenceArtifactObject<K extends ArtifactKind, P, B extends SubjectBinding> {
  envelopeVersion: EvidenceEnvelopeVersion;
  artifactKind: K;
  artifactSchemaVersion: string;
  producer: ProducerIdentity;
  producerBoundary: ProducerBoundary;
  evidenceScope: EvidenceScope;
  subjectBinding: B;
  payload: P;
}

interface EvidenceArtifactRecord {
  recordVersion: "lattice.evidence_record.v1";
  artifactId: string;
  artifactDigest: string;
  createdAt: string;
}

type EvidenceScope =
  | "audit-note"
  | "legacy-observed"
  | "legacy-local-only"
  | "legacy-unknown-producer"
  | "evidence-candidate"
  | "local-diagnostic"
  | "local-key-single-host"
  | "local-gate-evidence"
  | "local-review-quorum"
  | "authority-receipt"
  | "production-gate-decision";
```

`artifactId` is not part of envelope integrity.
`artifactId` is immutable, non-content-addressed observation identity.

For this MVP, `evidenceScope` is usually `evidence-candidate` for pre-story
artifacts and `local-gate-evidence` for later lifecycle-ready claims.

Candidate artifacts are not REVIEW, TEST, DONE, Authority, or production-gate
evidence by themselves.

`envelopeVersion` / `artifactSchemaVersion` are separate:

- `envelopeVersion`: evidence platform envelope format version.
- `artifactSchemaVersion`: per-artifact payload schema version.

## Digest and Integrity

`artifactDigest` is SHA-256 over canonical object JSON including:

- envelope version
- artifact kind
- artifact schema version
- producer
- producer boundary
- evidence scope
- subject binding
- payload

Rules:

- same canonical object ⇒ same `artifactDigest` (deduplicated object)
- same canonical object + multiple writes ⇒ same `artifactId` is idempotent; a different
  digest for the same `artifactId` must be rejected as conflict
- createdAt is not part of object integrity

`artifactDigest` is the immutable object identity; `artifactId` is immutable
observation identity.

Ref integrity invariants:

- refs/by-id is write-once.
- `artifactId` + `artifactDigest` pair is immutable.
- on read, recompute object hash and require:
  - path digest == computed digest
  - computed digest == `artifactDigest` in ref row

## Storage Layout

```text
.lattice/evidence/
  objects/sha256/<artifactDigest>.json
  refs/by-id/<artifactId>.json
  ledger/observed.jsonl
  transactions/pending/<operationId>.json
  transactions/committed/<operationId>.json
```

Storage write protocol:

1. parse and canonicalize
2. hash canonical object
3. write object content-addressed file (atomic temp+rename)
4. write ref record (artifactId + digest + timestamp) with write-once enforcement
5. append observed event for write (audit)

`ledger/observed.jsonl` is append-only audit, not source-of-truth.

`story_create_from_repro` is a transactional, crash-recoverable protocol:

1. Generate `operationId`.
2. Write pending transaction record.
3. Create object/ref/binding idempotently.
4. Create/update story metadata idempotently.
5. Attach planning/checklist/review refs idempotently.
6. Write committed transaction marker.
7. On restart, resume or roll back incomplete pending transactions.

## Shared Definition and Admissibility Projection

Single source-of-truth rule:

- artifact definitions live in one native registry module in `packages/main/src/core/evidence`;
- proof-admissibility must consume the same registry through a read-only projection.

No parallel proof-only definition list may be maintained.

Proof surfaces are defined once in a native registry used by both
artifact service and proof classifier.

```ts
interface ProofSurfaceDefinition {
  surfaceKind: string;
  artifactRole: ArtifactRole;
  temporalRole: TemporalRole;
  evidenceScope: EvidenceScope;
  producerPolicy: ProducerPolicy;
  allowedConsumers: readonly ArtifactConsumerKind[];
  allowedClaims: readonly ClaimKind[];
}

interface StoredArtifactDefinition<K extends ArtifactKind, P, B extends SubjectBinding>
  extends ProofSurfaceDefinition {
  artifactKind: K;
  artifactSchemaVersion: string;
  payloadSchema: StrictSchema<P>;
  subjectBindingPolicy: SubjectBindingPolicy<B>;
}

interface ExternalSurfaceDefinition extends ProofSurfaceDefinition {
  verifierAdapterId: string;
}

type EvidenceSurfaceDefinition = StoredArtifactDefinition<ArtifactKind, unknown, SubjectBinding>
  | ExternalSurfaceDefinition;

interface ArtifactDefinition<K extends ArtifactKind, P, B extends SubjectBinding>
  extends StoredArtifactDefinition<K, P, B> {}
```

`ProofAdmissibilityService` consumes this registry and does not maintain
independent scope/consumer definitions.

Projection rule:

- `command` names are CLI dispatch names (underscore style).
- `artifactKind` is the canonical hyphenated contract key used for registry and
  admissibility lookup.
- consumer decisions must be based on registry + projection, not raw command strings.

Example:

```text
repro_probe -> repro-probe
repro_review_set -> repro-review
spike_record -> spike-record
spike_review_set -> spike-review
red_green_relation_create -> red-green-relation
red_green_relation_evaluate -> red-green-relation-evaluation
story_create_from_repro -> story-evidence-binding
```

## Subject Binding

```ts
type SubjectBinding =
  | {
      kind: "pre-story-candidate";
      candidateId: string;
      baselineHeadHash?: string;
      baselineMaterialHash?: string;
      executionContextDigest: string;
    }
  | {
      kind: "story";
      storyId: string;
      headHash: string;
      materialHash: string;
      storyFilesHash: string;
    }
  | {
      kind: "story-evidence-binding";
      storyId: string;
      sourceArtifactDigests: string[];
      checklistDigest: string;
      verificationIntentDigest: string;
    }
  | {
      kind: "transition-relation";
      storyId: string;
      baselineArtifactDigest: string;
      currentVerificationEvidenceDigest: string;
      acceptanceRowDigest: string;
    };

```

Canonical subject-binding definitions:

- `pre-story-candidate`: Repro/Spike pre-story candidate scope.
- `story`: lifecycle-bound evidence (required: `storyId`/`headHash`/`materialHash`/`storyFilesHash`).
- `story-evidence-binding`: immutable story-binding bridge from candidate to story.
- `transition-relation`: red-green transition assertion witness set.

`red-green-relation` is a local relation descriptor.
`red-green-relation-evaluation` is evaluator-derived and must not be a caller-writable
artifact.

## Consumption Boundary

A candidate artifact may inform STORY_INTAKE. It must not satisfy lifecycle
completion claims by itself.

- `story_create_from_repro` may create a story and a `story-evidence-binding`
- candidate artifacts remain `evidence-candidate`
- the binding does not create current `verificationEvidence`
- green evidence is produced later by normal DEV/TEST commands
- DONE/production gates must not consume candidate artifacts as completion proof

`story_create_from_repro` is a transactional, crash-recoverable operation.

## MVP Artifact Kinds (B-0aa1)

| Kind | Role | Producer boundary | Temporal role | Allowed consumers |
|---|---|---|---|---|
| `repro-probe` | problem-observation | local-runtime-owned | historical-baseline | STORY_INTAKE |
| `repro-review` | repro-validity-review | trusted-reviewer-owned | historical-baseline | STORY_INTAKE |
| `spike-record` | planning-input | local-runtime-owned | not-applicable | STORY_INTAKE, PLAN |
| `spike-review` | planning-review | trusted-reviewer-owned | not-applicable | STORY_INTAKE, PLAN |
| `red-green-relation` | red-green-relation | local-runtime-owned | transition-relation | REVIEW |
| `red-green-relation-evaluation` | derived-evaluation | local-runtime-owned | transition-relation | REVIEW |
| `regression-matrix-review` | regression-matrix-review | trusted-reviewer-owned | current-state | REVIEW |
| `story-evidence-binding` | binding | local-runtime-owned | not-applicable | PLAN, STORY_INTAKE |

`red-green-relation-evaluation` uses producer policy `evaluator-only`.
`REVIEW` here means claim-bound usage; candidate display is `diagnostic-status`.

The MVP `evidenceScope` for these kinds is `evidence-candidate`, unless otherwise
bound in a later hardening story.

## Proof Admissibility Classification (B-0985)

B-0985 registers proof-looking surfaces in a shared classification registry and
adds this service contract:

```ts
interface ProofAdmissibilityApi {
  classifySurface(input: StaticClassificationInput): StaticClassificationResult;
  evaluateVerifiedSurface(
    request: VerifiedSurfaceRequest,
  ): Promise<AdmissibilityResult>;
}

type StaticClassificationResult = {
  claimTypeSupported: boolean;
  consumerTypeSupported: boolean;
  verificationRequired: boolean;
  productionDoneEligible: boolean;
  reasons: ReasonCode[];
  remediation: string[];
};

type VerifiedSurfaceRequest = {
  consumer: ArtifactConsumerKind;
  claim: ClaimKind;
  storyId?: string;
  surfaceKind: string;
  surfaceRef: string;
};

```
`classifySurface` is caller-side static compatibility check and must not accept
caller-provided `signatureValid`/`digestValid` semantics.

`evaluateVerifiedSurface` does not receive external facts. The service resolves
the correct verifier adapter internally from registry + `surfaceKind`, invokes
the adapter, then evaluates admissibility.

`TrustedVerifierFacts` is therefore not a public input and must stay an internal
opaque type inside the admissibility service implementation.

producer identity in this tier is derived from authenticated execution or reviewer
context and is not caller-settable for runtime-owned, evaluator-only, or
reviewer-owned artifacts.

`production-completion` projection for this slice:

- `evidence-candidate`, `local-diagnostic`, `local-key-single-host`,
  `local-gate-evidence`, `local-review-quorum`, `legacy-observed`,
  `legacy-local-only`, `legacy-unknown-producer`, and raw `authority-receipt`
  cannot satisfy production-completion in local CLI core.
- `production-gate-decision` can only be a production-ready projection through
  a matching external authority adapter gate.

`local-gate-evidence` is explicit:

- can support local lifecycle claims such as `current-pass`, `review-pass`,
  `done-readiness`
- cannot satisfy `production-completion`

This slice is classifier-only: no new evidence writes, no new storage root,
no hard-fail gate enforcement, no new Authority integration.

## EvidenceRuntime API Baseline

```ts
interface EvidenceRuntime {
  readonly repro: ReproIntakeApi;
  readonly artifacts: EvidenceArtifactReadApi;
  readonly admissibility: ProofAdmissibilityApi;
}
```

Boundary constraints:

- handlers do not write `.lattice/evidence` directly
- handlers call case-based APIs, e.g. `repro.recordProbe()`
- `evidenceScope` / `producerBoundary` are not caller-settable for runtime-owned
  artifacts
- no direct creation of `story-evidence-binding` and `red-green-relation-evaluation`
- handlers and adapters must not write `.lattice/evidence/objects` / `refs` / `ledger`
  directly. All writes go through `EvidenceArtifactService`.
- source paths for APIs: `packages/main/src/core/evidence/*`; handler entrypoints:
  `packages/main/src/handlers/*`.

## Storage module layout

```text
packages/main/src/core/evidence/
  index.ts
  evidence-runtime.ts
  artifact/
    artifact-envelope.ts
    artifact-definition.ts
    artifact-registry.ts
    artifact-service.ts
    subject-binding.ts
  admissibility/
    types.ts
    registry.ts
    classify-surface.ts
    classify-verified-surface.ts
  repro/
    repro-intake-service.ts
    register-repro-artifacts.ts
    artifacts/
      repro-probe.ts
      repro-review.ts
      spike-record.ts
      spike-review.ts
      red-green-relation.ts
      red-green-relation-evaluation.ts
      regression-matrix-review.ts
      story-evidence-binding.ts
  storage/
    artifact-repository.ts
    fs-artifact-repository.ts
    observed-event-repository.ts
```

Compatibility pathing strategy:

- keep existing exports via compatibility re-export entry points (e.g.
  `packages/main/src/core/proof-admissibility.ts`)
- move callsites incrementally

## Cross-document alignment

Repro-First and admissibility documents must align on this baseline:

- Repro-First uses `.lattice/evidence` and `red-green-relation` +
  `red-green-relation-evaluation` contract above
- Proof-admissibility uses the native artifact registry projection and the
  `local-gate-evidence` scope definition in this document
- pre-story object storage and observed ledger behavior are considered provided by
  this slice

## Non-goals (future work)

- Authority quorum
- production gate hard-fail wiring
- ledger/waterline consolidation
- full registry federation across external runtimes

## Inventory

- `docs/evidence/proof-surface-inventory.md`
- `docs/evidence/proof-surface-inventory.json`

## Read-only Lifecycle Control Projection

The lifecycle control read-only plane in this baseline is a separate projection
layer and does **not** alter gate semantics. It uses explicit projection-only fields
for current runtime/consumption/readiness status and keeps legacy projection fields for
backward compatibility:

- Canonical status: `runtime`, `consumption`, `readiness`, and `queue`/`queueSummary`.
- Compatibility projection: legacy `lanes` and `cp2Projection` fields remain present for
  existing read paths but are documented as non-authoritative.

This keeps migration stable while new code uses canonical field names.
