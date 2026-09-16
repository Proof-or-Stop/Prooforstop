# ProofStory Acceptance Topology and Pre-Review Gates — Execution Plan

Status: **WAVES 1/1A/2/2A/3/4 IMPLEMENTED — WAVE 3A SKIPPED FOR FLAT ROLLOUT**
Story: `B-4444`  
Motivating incident: `B-407c` (evidence only; no changes to that Story)  
Decision owner: human approval after document audit

## 1. Executive decision

Proof-or-Stop should not add a separately writable `acceptance_matrix` artifact.
The milestone ledger and ProofStory contract already own the facts from which an
acceptance matrix would be built. A second store would introduce precedence,
synchronization, and false-completion risks.

Instead, extend each existing `ProofStoryAcceptanceBinding` with a versioned,
reference-based `verificationTopology`. The topology records how an accepted
claim will be proved: producer, consumer, positive assertion, biting mutation,
transcript or receipt, authority, temporal role, and freshness binding.

Add two checks with different lifecycle responsibilities:

1. `acceptance_topology_check` at PLAN → DEV checks structure and graph totality.
   It must also close the declared topology over an independently generated
   `coverageBasis`; it must not require implementation commands to have run or
   verification evidence to exist.
2. `pre_review_check` at DEV → REVIEW checks current executable evidence. It
   rejects missing or non-biting mutations, unrelated transcripts, inadmissible
   authority, stale bindings, and topology paths omitted from the recomputed
   current-worktree coverage basis before a REVIEW round is spent.

Any tabular “acceptance matrix” is a deterministic, read-only projection of the
confirmed milestone ledger, ProofStory acceptance bindings, checklist intents,
and evidence. It is never independently authored and never satisfies a gate by
its own existence.

This document records the staged design and its implementation status.
`B-4444` was the audited documentation deliverable; subsequent implementation
Stories shipped Waves 1, 1A, 2, 2A, and 3. Wave 3A was intentionally skipped
because the current rollout is flat and project-wide. Wave 4 implements only
that flat boundary: prompt integration, verifier-owned measured cohorts, and
opt-in project enforcement. It does not claim selective high-risk applicability
or production/public authority.

### 1.1 Guarantee boundary

The target is a bounded mechanical guarantee, not proof that every possible
runtime path in an open system is known:

```text
topology completeness PASS
  only if coverageBasis.status == complete
  AND coverageBasis was independently derived from the frozen scope and current workspace
  AND every basis path maps to topology or an independently approved exclusion
  AND the basis/topology binding is current
  AND omission mutations bite
```

If static analysis, registry enumeration, dispatch inspection, or runtime traces
cannot enumerate a relevant dynamic path, the basis is `partial` or
`unsupported`. Those states render `INCONCLUSIVE`; they never become completeness
PASS through prose, reviewer confidence, or a caller-written flag. Therefore the
design can mechanically prevent omissions inside a frozen, machine-enumerable
scope. It cannot promise zero unknown paths outside that boundary, and REVIEW
remains required.

## 2. Problem statement

`B-407c` eventually reached the required assurance, but important obligations
were discovered progressively in REVIEW: producer-to-consumer coverage,
mutation polarity, transcript evidence, and authority boundaries. The defect was
not that the milestone ledger omitted the requested deliverables. The defect was
that the plan did not enumerate the complete verification topology for those
deliverables before implementation.

The result was repeated REVIEW rounds and repeated evidence binding. REVIEW did
its job, but it was asked to discover obligations that could have been made
explicit earlier.

The target outcome is not “eliminate REVIEW.” It is:

- make required proof relationships visible before DEV;
- prove executable readiness before REVIEW;
- leave REVIEW responsible for independent critique and missed-path discovery;
- preserve the existing authority and freshness boundaries;
- reduce avoidable review rounds without increasing false passes.

## 3. Current implementation versus target

| Surface | Current implementation through Wave 4 | Remaining target |
|---|---|---|
| `MilestoneLedgerItem` | Owns requirement claim, `doneMeans`, required evidence classes, checklist refs, verification-intent refs, and candidate/confirmed intent binding | Remains unchanged as the canonical intent-totality ledger |
| `ProofStoryAcceptanceBinding` | Owns an acceptance binding ID plus claim/checklist/intent/milestone refs and optional versioned `verificationTopology` | No separate writable matrix |
| `verificationIntent` | Declares planned happy, edge, and adversarial scenarios plus optional versioned planned-path declarations; topology references stable intent/declaration/endpoint IDs | Remains checklist-scoped |
| `verificationEvidence` | Records observed command/manual/docs results against intent refs | Remains the observation store; topology references evidence IDs/receipts rather than copying results |
| ProofStory DEV diagnostics | Check intent artifacts, known refs, coverage, and structural topology through `acceptance_topology_check` | Wave 4 measures rollout behavior through a signed frozen cohort |
| `evaluateReviewCompleteness` | At REVIEW → TEST, checks bound intent refs have passing evidence | Remains in place; consumes the stronger topology after implementation |
| DEV → REVIEW transition | Consumes `pre_review_check` and the flat rollout report under independently configured modes | Wave 4 enforce blocks only on the same mode-invariant rollout diagnostics |
| Acceptance matrix | Derived read-only rendering; no canonical writable artifact | Remains non-evidentiary |

The current source facts behind this table are in:

- `packages/main/src/core/types.ts` (`MilestoneLedgerItem`,
  `ProofStoryAcceptanceBinding`);
- `packages/main/src/core/proofstory.ts` (binding normalization, diagnostics,
  `evaluateReviewCompleteness`);
- `packages/main/src/handlers/phase-gates.ts` (configured ProofStory modes and
  REVIEW → TEST consumption);
- `packages/main/src/core/process-fact-registry.ts` and
  `packages/main/src/core/process-fact-levels.ts` (gate-fact ownership); the
  exported `PROCESS_FACT_REGISTRY` is the global assembled flat fact catalog,
  not a Story-local list and not yet a producer→consumer graph;
- `packages/main/src/core/types.ts` and `packages/main/src/core/store.ts`
  (existing signed `scope-check.json` and Story-scoped `scope-contract.json`
  types and persistence APIs).

## 4. Canonical ownership and non-duplication invariant

| Question | Canonical owner | What it must not own |
|---|---|---|
| What outcomes did the user require? | Original intent snapshot and confirmed milestone ledger | Executed test results |
| What does completion mean for each milestone? | `MilestoneLedgerItem.doneMeans` and `requiredEvidence` | Reviewer verdicts or Authority claims |
| Which accepted claim maps to which work and intent? | `ProofStoryAcceptanceBinding` | Copied milestone claims or evidence status |
| Which scenarios and not-yet-implemented path relations must be verified? | Checklist `verificationIntent`; its versioned planned-path declaration owns endpoint roles, expected symbols/facts, file declaration refs, and producer→consumer relation | Observed pass/fail results or topology closure verdicts |
| What actually ran or was inspected? | `verificationEvidence` and signed receipts | New acceptance claims |
| Is the implementation independently acceptable? | REVIEW runs, findings, passes, quorum policy | PLAN completeness |
| Is the Story lifecycle complete? | Existing TEST/DONE gates | Milestone status or derived matrix alone |

Hard invariant:

```text
There SHALL NOT be a writable acceptance-matrix truth source.

acceptance matrix = derive(
  confirmed milestone ledger,
  ProofStory acceptance bindings,
  checklist verificationIntent,
  verificationEvidence and signed receipts
)
```

The renderer must expose source IDs on every row. If its inputs disagree, it
renders a diagnostic; it never resolves the disagreement by choosing its own
value. Matrix output is L0/read-only and cannot be submitted as gate evidence.

## 5. Target schema

### 5.1 Placement and versioning

Add an optional `verificationTopology` to each acceptance binding. New writes use
`proofstory.acceptance_topology.v1`. Existing v1 ProofStory contracts without
the field stay readable and normalize to `topologyState: "legacy_missing"`.

The topology uses references. It must not copy `claim`, `doneMeans`, intent
descriptions, observed output, or verdicts from their canonical owners.

### 5.2 Implemented TypeScript shape

```ts
interface ProofStoryAcceptanceBinding {
  id: string;
  acceptanceClaim?: string;
  checklistRefs: string[];
  verificationIntentRefs: string[];
  milestoneIds: string[];
  note?: string;
  verificationTopology?: AcceptanceVerificationTopologyV1;
}

/** Implemented additive field on the existing checklist verificationIntent item. */
interface VerificationIntentItem {
  id?: string;
  desc: string;
  type: VerificationIntentType;
  requiredIn?: VerificationRequiredIn;
  priority?: VerificationPriority;
  plannedPathDeclarations?: VerificationPlannedPathDeclarationV1[];
}

interface VerificationPlannedPathEndpointV1 {
  id: string;
  role: 'producer' | 'consumer';
  expectedArtifactKind: 'source_file' | 'handler' | 'dispatch' | 'process_fact';
  expectedFileRef: string;
  expectedSymbolOrFact: string;
  /** Resolves to this checklist item's existing files.modify/create/test entry. */
  fileDeclarationRef: string;
}

interface VerificationPlannedPathDeclarationV1 {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1';
  id: string;
  relation: 'producer_to_consumer';
  producer: VerificationPlannedPathEndpointV1;
  consumers: VerificationPlannedPathEndpointV1[];
  outputFactRef: string;
}

interface AcceptanceVerificationTopologyV1 {
  schemaVersion: 'proofstory.acceptance_topology.v1';
  /** Signed verifier-produced basis; never a caller-authored inventory. */
  coverageBasisRef: string;
  coverageBasisDigest: string;
  applicability: {
    mode: 'required' | 'docs_only' | 'optional' | 'not_applicable';
    reason?: string;
    decisionRef?: string;
  };
  producerRefs: TopologyProducerRef[];
  consumerRefs: TopologyConsumerRef[];
  positiveAssertions: TopologyPositiveAssertion[];
  mutationCases: TopologyMutationCase[];
  transcriptAssertions: TopologyTranscriptAssertion[];
  commandRefs: TopologyCommandRef[];
  evidenceAuthority: TopologyEvidenceAuthority;
  freshness: TopologyFreshnessPolicy;
}

interface ExistingTopologySourceRefV1 {
  refKind: 'existing';
  canonicalSourceRef: string;
}

interface PlannedTopologySourceRefV1 {
  refKind: 'planned';
  /** Stable ref into a frozen verificationIntent item; topology owns no edge prose. */
  plannedPathDeclarationRef: string;
  endpointRef: string;
}

type TopologySourceRefV1 =
  | ExistingTopologySourceRefV1
  | PlannedTopologySourceRefV1;

interface PlannedCoveragePathV1 {
  schemaVersion: 'proofstory.planned_coverage_path.v1';
  plannedPathRef: string;
  plannedPathDeclarationRef: string;
  declarationDigest: string;
  producer: VerificationPlannedPathEndpointV1;
  consumers: VerificationPlannedPathEndpointV1[];
  outputFactRef: string;
  acceptanceBindingRefs: string[];
  verificationIntentRefs: string[];
  declarationRefs: string[];
  plannedPathDigest: string;
}

interface PlannedActualPathReconciliationV1 {
  schemaVersion: 'proofstory.planned_actual_path_reconciliation.v1';
  plannedPathRef: string;
  actualPathRefs: string[];
  relation: 'exact' | 'expanded' | 'replaced';
  replacementDecisionRef?: string;
  reconciliationDigest: string;
}

type CoverageDiscoveryMethodV1 =
  | 'scope_contract'
  | 'actual_diff_hunks'
  | 'process_fact_registry'
  | 'handler_dispatch_inventory'
  | 'static_call_graph'
  | 'runtime_trace';

interface CoverageAdapterResultV1 {
  schemaVersion: 'proofstory.coverage_adapter_result.v1';
  adapterId: string;
  method: CoverageDiscoveryMethodV1;
  pathRefs: string[];
  coverageClaim: 'complete_for_scope' | 'partial' | 'unsupported';
  blindSpots: string[];
  provenanceRefs: string[];
  asymmetryPolicy: {
    kind: 'exhaustive' | 'bounded_non_exhaustive' | 'unsupported';
    policyRef: string;
    scopeRefs: string[];
  };
  /** Canonical hash of every preceding field in this record. */
  resultDigest: string;
}

interface AcceptanceCoverageBasisV1 {
  schemaVersion: 'proofstory.acceptance_coverage_basis.v1';
  storyId: string;
  phaseBasis: 'plan' | 'pre_review';
  /** Required on pre_review and equal to the topology-bound PLAN basis digest. */
  priorPlanBasisDigest?: string;
  status: 'complete' | 'partial' | 'unsupported';
  generatedBy: {
    verifier: string;
    command: string;
    algorithmVersion: string;
  };
  /** Registered profile decides required adapters; the caller cannot narrow it. */
  discoveryProfileRef: string;
  discoveryProfileDigest: string;
  discoveryMethods: CoverageDiscoveryMethodV1[];
  adapterResults: CoverageAdapterResultV1[];
  scopeRefs: string[];
  sourceInventoryRefs: string[];
  plannedPathRecords: PlannedCoveragePathV1[];
  plannedActualReconciliations: PlannedActualPathReconciliationV1[];
  enumeratedPathRefs: string[];
  excludedPathRefs: Array<{
    pathRef: string;
    decisionRef: string;
  }>;
  blindSpots: string[];
  binding: {
    headHash: string;
    materialHash: string;
    storyFilesHash: string;
    scopeCheckDigest: string;
    scopeContractDigest?: string;
    /** Hash of every source ref in the discovered producer/consumer closure. */
    closureFilesHash: string;
  };
  receiptRef: string;
  /** Includes profile, every adapter result/digest, planned paths, and all bindings. */
  basisDigest: string;
}

interface TopologyCriticReceiptV1 {
  schemaVersion: 'proofstory.topology_critic_receipt.v1';
  storyId: string;
  criticIdentity: string;
  criticRole: string;
  criticProvenance: TopologyActorProvenanceV1;
  implementationProvenance: TopologyImplementationProvenanceV1;
  basisDigest: string;
  topologyDigest: string;
  scopeCheckDigest: string;
  scopeContractDigest?: string;
  storyFilesHash: string;
  closureFilesHash: string;
  findingRefs: string[];
  approvedExclusionRefs: string[];
  verdict: 'pass' | 'request_changes';
  issuedAt: string;
  signerPublicKey: string;
  signature: string;
}
```

Required referenced records:

| Record | Required fields | Meaning |
|---|---|---|
| coverage basis | `phaseBasis`, `status`, verifier identity, discovery profile, per-adapter results, scope/source/planned/actual path refs, exclusions, blind spots, current binding, receipt, digest | Independently derived closure universe against which topology completeness is judged |
| verification planned-path declaration | ID, relation, typed producer/consumer endpoints, expected artifact/file/symbol or fact, `ChecklistItem.files` refs | Canonical PLAN owner for a genuinely new path; written/frozen with verificationIntent, outside verificationTopology |
| planned path | declaration ref/digest, verifier-derived endpoints/fact, binding/intent refs, digest | Signed PLAN-basis projection independently derived from the frozen declaration, checklist files, and scope |
| planned→actual reconciliation | planned path ref, actual path refs, typed relation, optional independent replacement decision, digest | Mandatory pre-REVIEW mapping from each planned obligation to current discovered code |
| adapter result | adapter ID/method, path set, claim, blind spots, provenance, typed asymmetry policy, digest | Replayable discovery contribution; required results cannot be omitted or rewritten inside an aggregate |
| producer | `id`, `kind`, typed existing-or-planned `sourceRef`, `outputFact` | The production path that creates, or is planned to create, the fact under test |
| consumer | `id`, `kind`, typed existing-or-planned `sourceRef`, `inputFact`, `producerRefs` | A real or explicitly planned consumer that must observe or reject the producer fact |
| positive assertion | `id`, `intentRef`, `producerRefs`, `consumerRefs`, `expectedOutcome`, `evidenceRefs` | Expected success behavior |
| mutation case | `id`, `mutates`, `targetRefs`, `expectedPolarity`, `expectedFailureCode`, `commandRef`, `evidenceRefs` | A negative control that must bite |
| transcript assertion | `id`, `claimRef`, `eventRefs`, `expectedSequence`, `evidenceRefs` | A claim-related end-to-end event or CLI transcript |
| command ref | `id`, `commandTemplate`, `runnerKind`, `workspacePolicy` | The canonical executable route, not an observed result |
| authority | `requiredClass`, `acceptedIssuerKinds`, `prohibitedPromotions` | Which evidence may support the claim |
| freshness | `bindingFields`, `cutoffPolicy`, `onDrift` | How current evidence is determined |

`AcceptanceCoverageBasisV1` is a derived, signed gate fact, not a second
acceptance or completion store. Its producer must be a registered verifier that
recomputes from repository/runtime inputs. Neither an implementer nor a reviewer
may submit arbitrary `enumeratedPathRefs`, `status: complete`, or exclusions.
The topology stores only the basis reference and digest so a self-reported basis
cannot make its own graph appear complete.

PLAN and pre-REVIEW use two typed views of the same proof obligation, not two
truth sources. The target schema additively nests
`VerificationPlannedPathDeclarationV1[]` on the existing
`VerificationIntentItem`; it does not create a new artifact, store, acceptance
claim, or completion fact. The verification-intent flow writes and freezes the
declaration with the intent. That declaration—not `verificationTopology`—owns
endpoint roles, expected artifacts/files/symbols or facts, output fact, and the
producer→consumer relation. Its `fileDeclarationRef` values must resolve to the
same checklist item's existing `files.modify/create/test` entries and the files
must remain inside the signed scope-check/phase-applicable scope contract.

At PLAN, topology uses `TopologySourceRefV1.refKind: "planned"` only to reference
the frozen declaration ID and one of its endpoint IDs. It cannot restate or
override the declaration's edge semantics. The registered verifier loads the
declaration directly from canonical verificationIntent ownership, checks the
file/scope refs, and independently derives `PlannedCoveragePathV1` plus its
declaration digest. A PLAN basis may be `complete` relative to the frozen
planning scope when every existing path and every declared planned path is
closed, even though the planned implementation does not yet exist. That
classification is structural only and is not evidence that code ran.

At pre-REVIEW, planned refs are no longer accepted as unresolved promises. The
verifier recomputes the actual basis from the current worktree and emits a
`PlannedActualPathReconciliationV1` for every planned path. `exact` and
`expanded` mappings must resolve to discovered actual paths already represented
by the topology. `replaced` additionally requires an independently auditable
decision ref and the replacement actual path remains subject to full closure.
Missing implementation, a changed endpoint/fact without an approved
replacement, or a new actual path without topology coverage fails closed. The
reconciliation records and digests enter the pre-REVIEW basis digest/receipt;
they do not become a writable completion ledger.

Adapter evidence is equally non-lossy. The applicable registered discovery
profile determines required methods independently of the submitted basis. Each
required invocation produces one `CoverageAdapterResultV1`; `resultDigest` is
computed over the canonical record excluding that digest. `basisDigest` is the
canonical hash of the complete basis excluding `basisDigest`, including the
profile ref/digest, the deterministically sorted full adapter records and their
digests, planned-path/reconciliation records, aggregate union, exclusions, and
workspace bindings. The receipt signs `basisDigest`. `discoveryMethods` and the
aggregate path/blind-spot fields are derived projections and must exactly match
the adapter records; they cannot hide a missing or disagreeing adapter.

“Frozen scope” reuses existing lifecycle artifacts; this plan does not create a
parallel scope truth source. At PLAN, discovery binds the signed
`scope-check.json` plus existing checklist `files` declarations and existing
scope-boundary facts. `scope_contract_init_from_plan` is an existing manual
PLAN/DEV command; it produces the contract before the transition that consumes
it. At DEV → REVIEW, discovery binds the then-current `scope-contract.json`.
If an enforced rollout needs the contract before its current manual point, Wave
2 must change the ordering of that existing command rather than add a new scope
artifact. The corresponding artifact digests are part of the basis binding.
Trust is asymmetric: `scope-check.json` carries its existing reviewer signature;
`scope-contract.json` is not presently signed, so the verifier recomputes its
digest from the canonical store and validates its registered producer/provenance
instead of describing the contract itself as signed.

Registry and dispatch discovery is deliberately not bounded by Story-owned
files. The current global `PROCESS_FACT_REGISTRY` supplies flat producer and
consumer-gate facts; it is not already a navigable call graph, and no current
dispatch inventory is claimed. Wave 1A must build adapters that start from facts
and producers introduced or changed by the Story, resolve those catalog entries
against handler/dispatch source, and derive the global consumer closure. A
consumer outside the Story scope remains part of the closure.
`closureFilesHash` binds every discovered producer and consumer source reference,
including files outside `storyFilesHash`; inability to resolve or inspect a
relevant consumer forces `partial`, never optimistic completeness.

### 5.3 Phase-separated example

```json
{
  "id": "AC-RUN-CUTOFF",
  "acceptanceClaim": "An incremental review run uses only prior passes before its start time",
  "checklistRefs": ["CHK-002"],
  "verificationIntentRefs": [
    "CHK-002:happy:0",
    "CHK-002:edge:0",
    "CHK-002:adversarial:0"
  ],
  "milestoneIds": ["M2"],
  "verificationTopology": {
    "schemaVersion": "proofstory.acceptance_topology.v1",
    "coverageBasisRef": "CB-B-4444-PLAN-001",
    "coverageBasisDigest": "sha256:plan-coverage-basis-digest",
    "applicability": {
      "mode": "required"
    },
    "producerRefs": [
      {
        "id": "P-B",
        "kind": "handler",
        "sourceRef": {
          "refKind": "existing",
          "canonicalSourceRef": "review_run_start"
        },
        "outputFact": "reviewRunEnvelope:B"
      }
    ],
    "consumerRefs": [
      {
        "id": "C-VERIFY-B",
        "kind": "verifier",
        "sourceRef": {
          "refKind": "existing",
          "canonicalSourceRef": "verifyReviewRunPromptEnvelope"
        },
        "inputFact": "reviewRunEnvelope:B",
        "producerRefs": ["P-B"]
      }
    ],
    "positiveAssertions": [
      {
        "id": "PA-B-AFTER-C",
        "intentRef": "CHK-002:happy:0",
        "producerRefs": ["P-B"],
        "consumerRefs": ["C-VERIFY-B"],
        "expectedOutcome": "verifier.ok=true and priorPassRef=A after C is appended",
        "evidenceRefs": ["E-B-AFTER-C"]
      }
    ],
    "mutationCases": [
      {
        "id": "MUT-NO-CUTOFF",
        "mutates": "remove passesCutoffAt from producer or verifier",
        "targetRefs": ["P-B", "C-VERIFY-B"],
        "expectedPolarity": "must_fail",
        "expectedFailureCode": "PRE_REVIEW_MUTATION_DID_NOT_BITE",
        "commandRef": "CMD-CUTOFF-E2E",
        "evidenceRefs": ["E-MUT-NO-CUTOFF"]
      }
    ],
    "transcriptAssertions": [
      {
        "id": "TR-A-B-C",
        "claimRef": "AC-RUN-CUTOFF",
        "eventRefs": ["run:A", "pass:A", "run:B", "pass:C", "verify:B"],
        "expectedSequence": ["A before B", "C at-or-after B", "B retains A"],
        "evidenceRefs": ["E-TRANSCRIPT-A-B-C"]
      }
    ],
    "commandRefs": [
      {
        "id": "CMD-CUTOFF-E2E",
        "commandTemplate": "node packages/main/dist/tasks/review-cutoff-e2e-smoke.js",
        "runnerKind": "local_cli",
        "workspacePolicy": "story_worktree"
      }
    ],
    "evidenceAuthority": {
      "requiredClass": "local_gate_evidence",
      "acceptedIssuerKinds": ["proof-or-stop-handler", "signed_review_run"],
      "prohibitedPromotions": ["diagnostic_to_authority", "self_report_to_receipt"]
    },
    "freshness": {
      "bindingFields": ["headHash", "materialHash", "storyFilesHash"],
      "cutoffPolicy": "producer_and_verifier_use_run_startedAt",
      "onDrift": "classify_then_rerun_or_reattest; never_silent_rebind"
    }
  }
}
```

The topology-bound PLAN basis is produced independently. Its registered PLAN
profile excludes `actual_diff_hunks`: DEV has not produced an implementation
diff yet, so requiring one would violate the structural-only gate. PLAN derives
from frozen scope, current discoverable source/registry/dispatch/static/runtime
facts that already exist before DEV, and frozen planned-path declarations.
The distinct pre-REVIEW profile adds `actual_diff_hunks` after implementation.
For example:

```json
{
  "schemaVersion": "proofstory.acceptance_coverage_basis.v1",
  "storyId": "B-4444",
  "phaseBasis": "plan",
  "status": "complete",
  "generatedBy": {
    "verifier": "acceptance-coverage-basis-verifier",
    "command": "proof-or-stop acceptance_basis_generate --storyId=B-4444",
    "algorithmVersion": "v1"
  },
  "discoveryProfileRef": "profile:typescript-proof-gate:plan:v1",
  "discoveryProfileDigest": "sha256:registered-plan-profile",
  "discoveryMethods": [
    "scope_contract",
    "process_fact_registry",
    "handler_dispatch_inventory",
    "static_call_graph",
    "runtime_trace"
  ],
  "adapterResults": [
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "scope-contract:v1",
      "method": "scope_contract",
      "pathRefs": [],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["scope-contract:B-4444"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:scope:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:adapter-scope"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "process-facts:v1",
      "method": "process_fact_registry",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["registry:process-facts:current"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:registry:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:adapter-registry"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "handler-dispatch:v1",
      "method": "handler_dispatch_inventory",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["inventory:handler-dispatch:current"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:dispatch:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:adapter-dispatch"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "typescript-static:v1",
      "method": "static_call_graph",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["static-graph:current"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:typescript-static:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:adapter-static"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "bounded-runtime:v1",
      "method": "runtime_trace",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["trace:cutoff-smoke:current"],
      "asymmetryPolicy": {"kind": "bounded_non_exhaustive", "policyRef": "policy:bounded-runtime:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:adapter-runtime"
    }
  ],
  "scopeRefs": ["scope:path:review-run", "scope:path:review-verifier"],
  "sourceInventoryRefs": [
    "handler:review_run_start",
    "verifier:verifyReviewRunPromptEnvelope"
  ],
  "plannedPathRecords": [],
  "plannedActualReconciliations": [],
  "enumeratedPathRefs": [
    "path:review_run_start->verifyReviewRunPromptEnvelope"
  ],
  "excludedPathRefs": [],
  "blindSpots": [],
  "binding": {
    "headHash": "current-head",
    "materialHash": "sha256:current-material",
    "storyFilesHash": "sha256:current-story-files",
    "scopeCheckDigest": "sha256:signed-scope-check",
    "scopeContractDigest": "sha256:current-scope-contract",
    "closureFilesHash": "sha256:all-discovered-closure-files"
  },
  "receiptRef": "receipt:coverage-basis:B-4444:plan:001",
  "basisDigest": "sha256:plan-coverage-basis-digest"
}
```

After DEV, the verifier produces a second artifact. It does not replace the
topology's PLAN ref/digest or reuse the PLAN receipt. This linkage-focused view
shows the fields that must differ; the real artifact also contains every
required schema field and freshly produced adapter/reconciliation record shown
above:

```json
{
  "schemaVersion": "proofstory.acceptance_coverage_basis.v1",
  "storyId": "B-4444",
  "phaseBasis": "pre_review",
  "priorPlanBasisDigest": "sha256:plan-coverage-basis-digest",
  "status": "complete",
  "generatedBy": {
    "verifier": "acceptance-coverage-basis-verifier",
    "command": "proof-or-stop pre_review_check --storyId=B-4444",
    "algorithmVersion": "v1"
  },
  "discoveryProfileRef": "profile:typescript-proof-gate:pre-review:v1",
  "discoveryProfileDigest": "sha256:registered-pre-review-profile",
  "discoveryMethods": ["scope_contract", "actual_diff_hunks", "process_fact_registry", "handler_dispatch_inventory", "static_call_graph", "runtime_trace"],
  "adapterResults": [
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "scope-contract:pre-review:v1",
      "method": "scope_contract",
      "pathRefs": [],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["scope-contract:B-4444:post-dev"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:scope:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:pre-review-adapter-scope"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "actual-diff:pre-review:v1",
      "method": "actual_diff_hunks",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["diff:post-dev-story"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:diff:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:pre-review-adapter-diff"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "process-facts:pre-review:v1",
      "method": "process_fact_registry",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["registry:process-facts:post-dev"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:registry:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:pre-review-adapter-registry"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "handler-dispatch:pre-review:v1",
      "method": "handler_dispatch_inventory",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["inventory:handler-dispatch:post-dev"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:dispatch:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:pre-review-adapter-dispatch"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "typescript-static:pre-review:v1",
      "method": "static_call_graph",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["static-graph:pre-review-current"],
      "asymmetryPolicy": {"kind": "exhaustive", "policyRef": "policy:typescript-static:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:pre-review-adapter-static"
    },
    {
      "schemaVersion": "proofstory.coverage_adapter_result.v1",
      "adapterId": "bounded-runtime:pre-review:v1",
      "method": "runtime_trace",
      "pathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
      "coverageClaim": "complete_for_scope",
      "blindSpots": [],
      "provenanceRefs": ["trace:cutoff-smoke:post-dev"],
      "asymmetryPolicy": {"kind": "bounded_non_exhaustive", "policyRef": "policy:bounded-runtime:v1", "scopeRefs": ["scope:path:review-run"]},
      "resultDigest": "sha256:pre-review-adapter-runtime"
    }
  ],
  "scopeRefs": ["scope:path:review-run", "scope:path:review-verifier"],
  "sourceInventoryRefs": ["handler:review_run_start", "verifier:verifyReviewRunPromptEnvelope"],
  "plannedPathRecords": [],
  "plannedActualReconciliations": [],
  "enumeratedPathRefs": ["path:review_run_start->verifyReviewRunPromptEnvelope"],
  "excludedPathRefs": [],
  "blindSpots": [],
  "binding": {
    "headHash": "post-dev-head",
    "materialHash": "sha256:post-dev-material",
    "storyFilesHash": "sha256:post-dev-story-files",
    "scopeCheckDigest": "sha256:signed-scope-check",
    "scopeContractDigest": "sha256:post-dev-scope-contract",
    "closureFilesHash": "sha256:post-dev-closure-files"
  },
  "receiptRef": "receipt:coverage-basis:B-4444:pre-review:001",
  "basisDigest": "sha256:pre-review-coverage-basis-digest"
}
```

The PLAN and pre-REVIEW refs, receipts, and digests are deliberately different.
The example is an illustrative, abridged shape of the implemented canonical
schema and command; omitted fields and values remain governed by the runtime
schema and verifier.

### 5.4 PLAN-safe new-path example

A Story that will create a finalize handler and receipt verifier does not claim
those files or symbols already exist. The verification-intent flow writes this
declaration inside the relevant frozen intent item; its file refs point to two
genuinely new `ChecklistItem.files.create` entries:

```json
{
  "id": "CHK-002:happy:0",
  "desc": "finalized runs produce a verifiable final receipt",
  "type": "cli",
  "priority": "must",
  "plannedPathDeclarations": [{
    "schemaVersion": "proofstory.verification_planned_path_declaration.v1",
    "id": "VPP-FINAL-RECEIPT",
    "relation": "producer_to_consumer",
    "producer": {
      "id": "ENDPOINT-FINALIZE",
      "role": "producer",
      "expectedArtifactKind": "handler",
      "expectedFileRef": "packages/main/src/handlers/review-run-finalize.ts",
      "expectedSymbolOrFact": "review_run_finalize",
      "fileDeclarationRef": "CHK-002:files:create:0"
    },
    "consumers": [{
      "id": "ENDPOINT-VERIFY-FINAL",
      "role": "consumer",
      "expectedArtifactKind": "process_fact",
      "expectedFileRef": "packages/main/src/core/final-review-receipt.ts",
      "expectedSymbolOrFact": "verifyFinalReviewReceipt",
      "fileDeclarationRef": "CHK-002:files:create:1"
    }],
    "outputFactRef": "planned-fact:final-review-receipt"
  }]
}
```

Topology references but cannot redefine that owner:

```json
{
  "producerSourceRef": {
    "refKind": "planned",
    "plannedPathDeclarationRef": "CHK-002:happy:0:VPP-FINAL-RECEIPT",
    "endpointRef": "ENDPOINT-FINALIZE"
  },
  "consumerSourceRef": {
    "refKind": "planned",
    "plannedPathDeclarationRef": "CHK-002:happy:0:VPP-FINAL-RECEIPT",
    "endpointRef": "ENDPOINT-VERIFY-FINAL"
  }
}
```

The verifier reads the frozen intent declaration directly, confirms both file
declaration refs and scope boundaries, and emits the `PlannedCoveragePathV1`
inside the signed PLAN basis. The derived record binds the declaration digest;
it does not trust endpoint semantics copied from topology. Neither the nested
declaration nor its derived basis projection is executable evidence, a new
artifact, or a parallel completion truth. At pre-REVIEW it must reconcile to
actual discovered paths, or admission fails.

## 6. Structural integrity and totality rules

`acceptance_topology_check` evaluates the following invariants:

1. Every required acceptance binding has exactly one topology version.
2. All topology IDs are non-empty and unique within the binding.
3. Every referenced checklist, intent, milestone, command, and claim exists in
   its canonical owner. Existing producer/consumer source refs must resolve now;
   planned source refs resolve only to an endpoint in a frozen
   `VerificationPlannedPathDeclarationV1` owned by verificationIntent.
4. At PLAN, every required producer feeds at least one existing consumer or one
   typed planned consumer from that canonical declaration. At pre-REVIEW, every
   required producer must feed an actually discovered consumer through a valid
   planned→actual reconciliation; a planned-only consumer cannot pass.
5. Every required consumer points to at least one producer.
6. Every must-priority intent appears in at least one positive assertion,
   mutation case, or transcript assertion appropriate to its lane.
7. Every required positive assertion names both the path and expected outcome.
8. Every required behavioral claim has at least one mutation case unless an
   applicability policy explicitly exempts it.
9. Every mutation declares polarity, target, command, and deterministic expected
   failure code.
10. Every user-visible or orchestration claim has a transcript assertion, unless
    a typed policy says a logic-only proof is sufficient.
11. `not_applicable` requires an independently auditable decision reference; a
    note written inside the topology is not enough.
12. No topology record embeds copied observed results or a completion status.
13. No topology field can promote local, diagnostic, audit-only, or degraded-host
    evidence to Authority or production proof.
14. The binding-to-topology graph and topology-to-binding graph are both total:
    no required binding is unrepresented and no topology node is orphaned.
15. Every required topology references a signed basis independently recomputed
    from phase-applicable inputs. PLAN uses frozen scope, current registered
    facts/dispatch/static/runtime inputs, and verifier-derived planned paths;
    its profile excludes DEV-output `actual_diff_hunks`. Pre-REVIEW uses a
    distinct profile that additionally requires actual diff hunks and current
    implementation discovery.
16. Completeness PASS requires `coverageBasis.status === 'complete'`; `partial`
    and `unsupported` are `INCONCLUSIVE`, even if all declared topology nodes are
    internally connected.
17. Every `enumeratedPathRef` maps to at least one producer/consumer/assertion
    edge or to an exclusion carrying an independently approved decision ref.
18. Every topology producer/consumer source ref occurs in the current basis;
    topology cannot expand or narrow its own closure universe.
    Two bounded forward-declaration forms are the only PLAN exceptions. First,
    the discovery-owned deferred pre-review fact set is exactly
    `pre_review_check`, `pre_review_check_read`, and
    `artifact:pre-review-check.json`; this is a closed platform allowlist, not a
    story-authored prefix or arbitrary future-phase category. Second, an
    existing source ref may use `basis-path:` only in producer, consumer, or
    command positions and only for the verifier-producible canonical path
    grammars `path:process-fact:<fact>->consumer:<consumer>`,
    `path:runtime-fact:<fact>->checker:<checker>`, or
    `path:static-call:<source>#<symbol>->consumer:<source>#<symbol>`. Unknown
    path kinds, free-form edges, and basis paths in positive, mutation, or
    transcript assertion positions are invalid.
    PLAN may retain those strict refs before the later-phase path materializes;
    pre-REVIEW removes that deferral and requires every ref to occur exactly in
    the current verifier-derived basis. Missing, misspelled, or deleted edges
    therefore fail closed as outside/unmapped coverage.
19. A `complete` basis has no unresolved blind spots. Dynamic/reflection/plugin
    paths require an admissible runtime trace or force `partial`/`unsupported`.
20. The basis digest, scope-artifact digests, current `storyFilesHash`, and
    `closureFilesHash` match the topology; any relevant workspace, closure, or
    topology change requires independent recomputation.
21. Discovery adapters report their path set, coverage claim
    (`complete_for_scope`, `partial`, or `unsupported`), blind spots, and
    provenance. The reconciled basis is the union of every path discovered by
    any admissible adapter, never their intersection.
22. A path reported by any adapter cannot disappear because another adapter did
    not observe it. Observation asymmetry is acceptable only under an explicit,
    typed per-adapter policy (for example, a bounded runtime trace declared
    non-exhaustive); unexplained set or semantic disagreement forces `partial`.
23. Process-fact and dispatch traversal reaches registered consumers outside
    Story scope. Every such consumer is mapped or independently excluded, and
    failure to inspect one forces `partial`.
24. A PLAN basis may contain a planned path only when its frozen verification-
    intent declaration owns and binds the relation, endpoint roles, expected
    file/artifact/symbol or fact, output fact, and valid `ChecklistItem.files`
    refs. Topology references the declaration/endpoint IDs only; a bare future
    string or topology-owned restatement is invalid.
25. Every planned path is reconciled to current actual discovery before REVIEW.
    No unresolved planned endpoint can satisfy executable readiness; expansions
    and approved replacements remain subject to topology/basis closure.
    Endpoint resolution is artifact-kind aware and runtime aware: a handler or
    dispatch must be registered/reachable, a process fact must resolve through
    the process-fact registry, and a source endpoint must be an exported
    callable on a proven producer→consumer relation. A same-named interface,
    type, enum, dead constant, nested property, or unreachable callable is not
    an actual endpoint. The relation itself must be witnessed by a bound static
    call or by the registered process-fact producer/consumer contract.
26. The registered discovery profile, not the basis payload, determines required
    adapters. Every required adapter has exactly one digest-valid result record.
27. `discoveryMethods`, aggregate paths, and aggregate blind spots equal the
    deterministic projection/union of adapter results. Each result's path set,
    claim, provenance, blind spots, and asymmetry policy is covered by its result
    digest and by `basisDigest`.

### 6.1 Deterministic structural codes

| Code | Condition |
|---|---|
| `AT_MISSING_TOPOLOGY` | Required binding has no topology |
| `AT_UNSUPPORTED_VERSION` | Topology version is unknown |
| `AT_DUPLICATE_ID` | A topology-local ID is duplicated |
| `AT_UNKNOWN_REF` | Any canonical reference cannot be resolved |
| `AT_ORPHAN_PRODUCER` | Producer has no consumer |
| `AT_ORPHAN_CONSUMER` | Consumer has no producer |
| `AT_INTENT_UNCOVERED` | Must intent has no applicable topology assertion |
| `AT_MUTATION_MISSING` | Required behavioral claim has no negative control |
| `AT_TRANSCRIPT_MISSING` | Required user/orchestration claim has no transcript assertion |
| `AT_INVALID_NA_DECISION` | Exemption lacks a valid external decision ref |
| `AT_INLINE_RESULT_FORBIDDEN` | Topology attempts to store observed pass/fail |
| `AT_AUTHORITY_PROMOTION_FORBIDDEN` | Requested authority exceeds evidence class |
| `AT_COVERAGE_BASIS_MISSING` | Required topology lacks a signed verifier-produced coverage basis |
| `AT_COVERAGE_BASIS_PARTIAL` | Basis is `partial` or `unsupported`; completeness is inconclusive |
| `AT_UNMAPPED_SCOPE_REF` | A basis path/source/scope ref has no topology mapping |
| `AT_UNJUSTIFIED_EXCLUSION` | A basis path is excluded without an independently approved decision ref |
| `AT_TOPOLOGY_OUTSIDE_BASIS` | Topology references a producer/consumer not present in the current basis |
| `AT_COVERAGE_BASIS_STALE` | Basis digest or workspace/story-files binding is not current |
| `AT_SCOPE_BINDING_MISSING` | Basis is not bound to the applicable existing signed scope-check/scope-contract artifact |
| `AT_DISCOVERY_DISAGREEMENT` | Discovery adapters disagree without a typed reconciliation policy; basis is `partial` |
| `AT_REGISTERED_CONSUMER_UNMAPPED` | A globally registered consumer reached from a Story fact is absent from topology/exclusions |
| `AT_CLOSURE_FILES_STALE` | A producer/consumer closure source changed while the topology-bound closure hash remained old |
| `AT_PLANNED_PATH_INVALID` | A planned path is free-form, incomplete, duplicate, or lacks resolvable canonical PLAN declaration refs |
| `AT_PLANNED_PATH_DECLARATION_MISSING` | A planned topology endpoint has no frozen verification-intent declaration or names an unknown declaration/endpoint ID |
| `AT_PLANNED_PATH_DECLARATION_DRIFT` | Topology or basis attempts to restate/override declaration-owned relation, role, file, symbol/fact, or output-fact semantics |
| `AT_PLANNED_PATH_OUTSIDE_BASIS` | Topology declares a planned path that the PLAN verifier did not derive from frozen scope/declarations |
| `AT_REQUIRED_ADAPTER_RESULT_MISSING` | The registered profile requires an adapter for this scope but its result record is absent or duplicated |
| `AT_ADAPTER_RESULT_DIGEST_MISMATCH` | An adapter record or its aggregate projection does not match its result digest/basis digest |
| `AT_ADAPTER_RESULT_INVALID` | Adapter claim, provenance, blind spots, or typed asymmetry policy is missing or invalid |

## 7. `acceptance_topology_check` — PLAN → DEV

Purpose: answer “Have we specified how every accepted claim will be proved?”

Inputs:

- original intent snapshot;
- confirmed milestone ledger when the milestone path applies;
- ProofStory acceptance bindings and topology;
- checklist and frozen verificationIntent;
- frozen `VerificationPlannedPathDeclarationV1` records owned by verification-
  intent and bound to `ChecklistItem.files` for endpoints DEV will introduce;
- independently generated coverage basis and verifier receipt;
- applicability decisions and configured rollout mode.

The check is structural only. It must not:

- run commands;
- require verificationEvidence;
- require a transcript that can only be produced after implementation;
- treat an absent executable result as failure;
- write a completion fact.

Algorithm:

```text
normalize supported topology versions
resolve existing canonical refs
resolve each planned topology ref to a frozen verification-intent declaration/endpoint
reject topology-owned restatements or overrides of declaration semantics
derive applicability for each binding
bind the applicable existing scope-check/scope-contract artifacts
load the registered PLAN discovery profile for this scope (actual_diff_hunks excluded)
run each required adapter and hash its complete result record
reject missing, duplicate, invalid, or digest-mismatched required adapter results
seed global registry/dispatch traversal from Story facts and follow all registered consumers
reconcile adapter outputs by union under typed per-adapter policies
derive planned path records independently from frozen intent declarations + ChecklistItem.files + scope
independently derive PLAN basis from current paths + typed planned paths
classify basis as complete, partial, or unsupported
stop with INCONCLUSIVE unless required basis status is complete
check bidirectional graph totality
check every basis ref maps to topology or an independently approved exclusion
check every topology path exists in the current basis
check lane-to-assertion coverage
check mutation/transcript declarations where applicable
check authority and freshness policies are declared
emit stable rows and deterministic codes
apply configured observe/warn/enforce behavior
```

The decisive predicate is:

```text
structuralPass =
  basis.issuer is registered verifier
  AND basis.phaseBasis == plan
  AND basis.status == complete
  AND basis.binding is current
  AND basis.binding.scopeCheckDigest is current
  AND the phase-applicable scopeContractDigest is current
  AND basis.binding.closureFilesHash is current
  AND topology.coverageBasisDigest == basis.basisDigest
  AND every profile-required adapter has one valid hash-bound result
  AND aggregate methods, paths, and blind spots equal the adapter-result projection
  AND every planned topology ref resolves to a frozen declaration endpoint
  AND every planned basis path was independently derived from that declaration
  AND every basis path is mapped or independently excluded
  AND every topology path belongs to basis
  AND all remaining topology invariants pass
```

The verifier must compute the basis independently. A payload that lets the
caller choose `status`, path inventory, blind spots, or exclusions is invalid by
construction. A topology critic may challenge the result, but its prose cannot
turn a `partial` basis into `complete`.

### 7.1 Discovery reconciliation

Each adapter emits discovered path refs, a coverage claim
(`complete_for_scope`, `partial`, or `unsupported`), explicit blind spots, and
provenance in a hash-bound `CoverageAdapterResultV1`. Required adapters come
from the registered `discoveryProfileRef`; deleting a method from
`discoveryMethods` cannot make its result optional. Reconciliation follows these
mechanical rules:

1. The candidate basis is the union of paths reported by every admissible
   adapter. It is never an intersection or “majority” set.
2. A path reported by either static or runtime discovery remains in the basis
   even when the other adapter does not observe it.
3. Expected observation asymmetry is accepted only when a typed policy for that
   adapter and bounded scope declares it (for example, runtime trace coverage is
   non-exhaustive for unexecuted branches). The policy cannot remove the path.
4. An unexplained path-set disagreement, semantic edge disagreement, missing
   provenance, or conflicting completeness claim yields
   `AT_DISCOVERY_DISAGREEMENT` and `status: partial`.
5. At pre-REVIEW, the equivalent condition yields
   `PR_DISCOVERY_DISAGREEMENT`; reviewer prose or critic approval cannot waive it
   into `complete`.
6. Before unioning paths, the verifier checks each result digest, profile
   membership, exactly-once presence, provenance, coverage claim, blind spots,
   and typed asymmetry policy. The derived aggregate must reproduce exactly from
   those records. Omission or tampering is a deterministic failure, not merely a
   disagreement advisory.

Disagreement may add obligations, but it cannot erase an obligation discovered
by another admissible source.

Output is a diagnostic report. If a durable artifact is later introduced, it
must be hash-bound and process-fact registered; command output alone cannot be
retrofitted as gate evidence.

## 8. `pre_review_check` — DEV → REVIEW

Purpose: answer “Is there current, admissible evidence that the planned proof
topology is executable and bites before reviewers spend a round?”

The verifier selects one workspace profile before applying those requirements.
A TypeScript workspace, including a mixed TypeScript/Go repository, keeps the
strict topology profile described below. A pure Go workspace uses the
`go-command` profile because the TypeScript call-graph adapters cannot describe
its production graph. That profile does not invent topology, mutation, or
transcript evidence. It requires every executable `must` intent to have its
immutable command and selector pin, a current tool-owned signed execution
receipt bound to the exact Story and publication HEAD, current material and
Story-files hashes, and pre-review cutoff, plus at least one argv-structured
`go test` execution. A later metadata-only auto-commit may advance HEAD when
the material and Story-files bindings remain current.
Missing, failed, stale, cutoff-invalid, command-mismatched, selector-mismatched,
unsigned, and non-Go-only evidence still blocks. Other unsupported languages do
not inherit this profile.

For a linked Story worktree created by an external harness, the primary checkout
may initially contain the controller config and Story metadata while the Story
branch does not. Before the first Story-scoped mutation, the CLI checks the
owner lease and verifies the exact registered `story/<StoryId>` worktree,
symbolic branch, shared Git common directory, canonical containment, no-follow
file types, matching config bytes, and bounded snapshot size. It then projects
only the config and exact Story directory into the linked worktree. All later
Story writes and metadata commits use that worktree copy; the controller copy
is not mutated. A foreign lease, nested repository, symlink, mismatched config,
or oversized snapshot is rejected before projection.

An existing Story in a repository that commits its configuration and all three
native hook assets uses the branch-local files as ordinary material. When each
file is a regular file in both checkouts, both HEAD trees and both indexes, CLI
bootstrap and reviewer preflight do not demand external-controller projection
receipts. Legitimate branch configuration differences remain intact and still
require ordinary scope and review evidence. This classification grants no
runtime-artifact exemption. Partial tracking, index-only additions, missing
files, and symlinks do not qualify; controller-only assets retain the signed
projection checks above.

The controller config may be intentionally untracked, so an existing
branch-local Story directory does not imply that the target config already
exists. Bootstrap installs a missing target config without dereferencing the
absent path. The first authorized projection writes matching signed receipts
under the shared Git common directory and the Story evidence directory. They
bind the config digest, Story, controller root, worktree root, and config path.
The Story copy enters branch history with ordinary metadata auto-commit, so
deleting or damaging either receipt cannot silently authorize a replacement.
Scope classification treats the
worktree config as a Proof-or-Stop control artifact only while both copies are
untracked, byte-identical, and still match both initial receipts. This avoids an
acceptance-amendment deadlock in projects that do not use ProofStory contracts.
Changing either copy or both copies together, deleting a tracked config, changing
the branch/workspace binding, using a symlink, losing the signing key, or losing receipt integrity removes
that classification and restores ordinary scope enforcement.

Repository baselines normally resolve from the configured remote HEAD. A linked
worktree instead prefers the primary local branch when its name exactly matches
origin/HEAD and the remote commit is an ancestor of the local tip. This excludes
locally integrated changes from Story scope without requiring a remote push.
Remote-ahead, diverged, differently named and detached primary checkouts retain
the existing fallback policy. In a linked Story worktree the primary branch
otherwise comes next, before conventional
`main` and `master` fallbacks; this preserves repositories whose integration
branch is `develop` even if an old `main` ref exists. In an ordinary checkout,
conventional refs precede the checkout's current branch so a feature branch is
not mistaken for its own baseline. Local and remote Story refs are never eligible.
Acceptance and scope gates therefore use a repository's real integration branch
and never require an Agent to create a synthetic local `main` alias.

The signed Go profile also makes the topology-specific PLAN check
not-applicable: a valid verifier-issued basis and receipt may pass that check
without claiming TypeScript topology was discovered. All ordinary scope, Story
review, ownership, and lifecycle gates still apply, so the command-evidence
gate is reachable under enforce mode without weakening those controls.

For every applicable required binding, it verifies:

- coverage basis is independently recomputed from the actual current diff,
  source inventory, registries/dispatch paths, and applicable runtime traces;
- topology still binds the valid PLAN basis, while the recomputed pre-REVIEW
  basis remains `complete`, names that PLAN digest in `priorPlanBasisDigest`, and
  carries its own freshly signed digest;
- every required discovery adapter has one complete, digest-valid result record
  and its aggregate projection is reproducible;
- every PLAN `plannedPathRef` has a digest-bound planned→actual reconciliation;
- every newly discovered path maps to topology or an approved exclusion;
- positive assertions have current successful evidence;
- producer and consumer evidence exercise the declared production path;
- each required mutation was actually applied in an isolated or safely restored
  environment;
- the mutation produced the declared failure polarity;
- the unmutated control passes after the mutation run;
- transcript assertions contain the required claim-related events and ordering;
- receipts came from an accepted issuer kind;
- evidence is bound to the current admissible workspace/material state;
- no result is silently rebound after drift.

The pre-review verifier must not trust the PLAN basis merely because its receipt
was once valid. It recomputes the basis after implementation, compares it with
the PLAN basis, and invalidates topology completeness if DEV introduced a new
producer, consumer, handler, dispatch edge, process-fact consumer, or relevant
changed hunk. `storyFilesHash` binds the recomputed closure; it is a freshness
input, not a substitute for enumerating paths. Because registered consumers can
live outside Story-owned files, `closureFilesHash` separately binds every source
in the traversed global producer/consumer closure. Either hash changing requires
recomputation; unchanged `storyFilesHash` does not excuse stale external
consumers.

Planned→actual reconciliation is mandatory and ordered before executable
evidence evaluation:

```text
load the signed PLAN basis and its plannedPathRecords
load each frozen verification-intent declaration and verify its PLAN-bound digest
recompute a phaseBasis=pre_review basis from actual diff/source/runtime inputs
verify all profile-required adapter records and reconstruct their union
for each plannedPathRef, resolve current producer, consumer, fact, and source endpoints
emit exact/expanded/replaced reconciliation and its canonical digest
reject an unresolved path, endpoint/fact mismatch, or unapproved replacement
feed every expanded/replacement actual path back through topology closure
only then evaluate positive, mutation, transcript, authority, and freshness evidence
```

An empty diff cannot satisfy a planned new path. Conversely, discovery of more
actual consumers than planned does not invalidate DEV work by itself, but every
additional path must be represented or independently excluded before REVIEW.
The pre-REVIEW basis/receipt binds the ordered reconciliation records; copying a
PLAN digest onto current hashes is not reconciliation.

It does not replace REVIEW. A pass means the implementation is ready to be
reviewed against a complete proof plan. Reviewers can still find missing paths,
weak assertions, design problems, or unmodeled interactions.

### 8.1 Deterministic executable codes

The implemented Wave 3 surface distinguishes absence from corruption:
`PR_ARTIFACT_MISSING` means no pre-review artifact exists and directs the user
to run `pre_review_check`; `PR_ARTIFACT_TAMPERED` is reserved for a present
artifact whose signature, digest, receipt, or canonical contents fail
verification. Enforced high-assurance work also emits
`PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED` when the independent critic receipt
is absent or stale for the current basis. Codes are emitted in a canonical
priority order, not incidental lexical order: artifact absence/corruption
first, then `PR_NEW_PATH_UNMAPPED` before its supporting
`PR_COVERAGE_BASIS_CHANGED`, followed by coverage, execution, freshness, and
critic diagnostics. CLI and lifecycle consumers display the same first code
and remediation.

Executable proof authority is additionally argv-bound. The causal
`live_smoke_transcript` receipt is admissible here only when its captured
command is exactly
`node scripts/run-proofstory-pre-review-live-proof.mjs`. The tracked runner performs a fresh
`npm --prefix packages/main run build` before invoking the generated target; the proof binds
both current runner and freshly-built target digests. The live proof carries gzip-compressed
canonical machine case records for every required positive, mutation, and transcript ID. Each
executed record carries its exact topology assertion ID, kind, and canonical `sourceRef`; assembly
matches by ID and rejects missing, extra, duplicate, kind-mismatched, or source-mismatched records
instead of reassigning a per-kind array position. Permuting records therefore cannot reattribute an
observed outcome, and swapping two assertion source refs fails closed. The loader also checks
distinct mutation targets/kinds, validates observed outcomes/control reruns and
producer-before-consumer events, and mechanically recomputes the aggregate root. Both initial
loading and signed-artifact readback compare provenance with the current tracked runner and built
target. A formatted arbitrary digest, stale runner, or stale/overwritten `dist` emitter is therefore
not executable evidence; a fresh runner build and proof issuance restores admissibility.

The machine records come from the bounded production pre-review scenario suite, not from replaying
the topology as a data structure. Its ledger binds the five positive paths and the seventeen
adversarial intents to their executed checks: deterministic projection; producer/read/lifecycle
parity; signed-field tamper; authority replay; planned-to-actual and discovery-state mutations;
topology omission; adapter/reconciliation tamper; wrong-polarity plus clean rerun; transcript
cardinality; bypass attempts; equal-cutoff freshness; legacy/config rollback; stable direct versus
lifecycle codes; critic freshness/replay; the process-fact contract; and the no-later-wave scan.
The transcript case consumes the producer/consumer events recorded by that execution.
The canonical inventory is exactly **5 positive / 17 mutation / 1 transcript**; the
process-fact contract checks this cardinality so documentation cannot silently lag the
registered executable catalog.
That bounded mode executes the production producer/read/lifecycle chain and
the required exact-cardinality, authority, planned→actual, restoration, and
tamper mutations within the fixed live-smoke safety ceiling. Merely printing a
proof-shaped JSON line from another command remains inadmissible.
The fixed argv is necessary but not sufficient: `live_smoke_transcript` injects
the active story identity into that runner, and the runner reads that story's
current contract/topology rather than carrying a story ID or case count in its
source. It executes each binding's positive, mutation, clean-control, and
producer-before-consumer transcript checks, records evaluator-observed mutation
codes, and emits canonical per-case digests. The causal receipt binds those
digests and the captured output; retaining case IDs while changing an observed
outcome is therefore a failing mutation, not admissible self-report.

| Code | Condition |
|---|---|
| `PR_ARTIFACT_MISSING` | No verifier-issued pre-review artifact exists; run `pre_review_check` after recording current canonical executable proof |
| `PR_ARTIFACT_TAMPERED` | A present pre-review artifact fails canonical signature, digest, receipt, or content verification; discard and reissue it through `pre_review_check` |
| `PR_POSITIVE_EVIDENCE_MISSING` | Required positive assertion lacks successful evidence |
| `PR_PRODUCTION_PATH_UNPROVEN` | Evidence uses a synthetic path instead of declared producer/consumer |
| `PR_MUTATION_EVIDENCE_MISSING` | Required mutation was not executed |
| `PR_MUTATION_DID_NOT_BITE` | Mutation run passed or failed for the wrong reason |
| `PR_CONTROL_NOT_RESTORED` | Clean control does not pass after mutation |
| `PR_TRANSCRIPT_MISSING` | Required transcript evidence is absent |
| `PR_TRANSCRIPT_UNRELATED` | Transcript does not bind to the acceptance claim/events |
| `PR_AUTHORITY_INADMISSIBLE` | Issuer or evidence class is insufficient |
| `PR_EVIDENCE_STALE` | Binding is stale under the freshness reader |
| `PR_CUTOFF_UNBOUND` | Temporal producer/verifier cutoff relation is missing |
| `PR_LEGACY_EVIDENCE_WEAK` | Legacy record is readable but cannot satisfy strong proof |
| `PR_COVERAGE_BASIS_CHANGED` | Current actual closure differs from the PLAN basis without complete planned→actual/new-path reconciliation; raw phase-basis digest inequality alone is expected |
| `PR_NEW_PATH_UNMAPPED` | Current source/runtime discovery finds a path absent from topology |
| `PR_COVERAGE_INCONCLUSIVE` | Current path discovery is partial or unsupported |
| `PR_DISCOVERY_DISAGREEMENT` | Required adapters disagree without a typed reconciliation policy |
| `PR_CLOSURE_FILES_CHANGED` | A source in the global producer/consumer closure changed after basis binding |
| `PR_PLANNED_PATH_UNRESOLVED` | A PLAN planned path has no current actual producer→consumer implementation |
| `PR_PLANNED_PATH_MISMATCH` | Actual endpoint/fact semantics do not match the planned path and no eligible replacement decision applies |
| `PR_PLANNED_PATH_RECONCILIATION_TAMPERED` | Reconciliation record/digest is missing, altered, duplicated, or absent from the pre-REVIEW basis digest |
| `PR_REQUIRED_ADAPTER_RESULT_MISSING` | A profile-required current-worktree adapter result is absent or duplicated |
| `PR_ADAPTER_RESULT_DIGEST_MISMATCH` | A current-worktree adapter record, aggregate projection, or basis digest was altered |
| `PR_ADAPTER_RESULT_INVALID` | A current adapter result lacks admissible claim, blind-spot, provenance, or asymmetry-policy fields |
| `PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED` | Enforced high-assurance admission lacks a fresh independent critic receipt bound to the current pre-review basis |

### 8.2 Independent topology critic

In the implemented Wave 3 state, the phase-appropriate gates consume an independent
topology critic before DEV admission and consume its re-attestation of the
recomputed DEV basis before REVIEW. The critic challenges scope, discovery
methods, exclusions, and closure. Its result must be a signed, hash-bound
`TopologyCriticReceiptV1` containing `schemaVersion`, `storyId`,
`criticIdentity`, `criticRole`, `criticProvenance`,
`implementationProvenance`, `basisDigest`, `topologyDigest`,
`scopeCheckDigest`, the phase-applicable `scopeContractDigest`,
`storyFilesHash`, `closureFilesHash`, `findingRefs`,
`approvedExclusionRefs`, `verdict`, `issuedAt`, `signerPublicKey`, and
`signature`. This inventory mirrors every field in the actual
`TopologyCriticReceiptV1` type; adding a signed field requires updating both
the verifier binding and this inventory.

Wave 2A by itself was deliberately narrower than that target state. It only produced and
verified the signed receipt and exclusion approvals through explicit CLI
commands. It had no lifecycle admission consumer: absence or failure of a
Wave 2A receipt alone did not block PLAN → DEV or DEV → REVIEW. Binding pre-DEV and
pre-REVIEW consumption was added by Wave 3 at the phase-appropriate gate.
Wave 4 rollout work remains separate.

The CLI independently verifies those bindings and the critic's eligible role.
Prompt text, natural-language approval, or a self-authored reviewer ID is not
evidence. The critic cannot override `partial`/`unsupported`; it may only require
more discovery or confirm that a mechanically `complete` basis has no identified
omission.

## 9. Freshness, temporal binding, and drift

The new checks must reuse the canonical freshness reader and
`storyFilesHash` policy. They must not invent a second hash classifier.

Rules:

1. `storyFilesHash` drift is a strong signal that Story-owned material changed;
   topology evidence for affected claims is stale and must be re-run or
   independently re-attested according to the consuming gate.
2. `closureFilesHash` drift is a strong signal that a discovered producer or
   consumer changed, including outside Story scope. The basis and affected
   evidence must be recomputed; a stable `storyFilesHash` is insufficient.
3. `materialHash`-only drift with unchanged signed `storyFilesHash` and
   `closureFilesHash` is classified
   by the existing freshness policy. A permitted re-attestation remains explicit
   and auditable; it is never a silent pass.
4. Legacy evidence without `storyFilesHash` follows the existing strict fallback.
   It stays readable but cannot be upgraded to strong proof merely by rewriting
   metadata.
5. `headHash` movement alone is not self-classified by the host. The canonical
   reader decides whether it is metadata/provenance movement or material drift.
6. Temporal claims declare a cutoff policy. Producer assembly and verifier
   recomputation must consume the same immutable cutoff fact.
7. Equality boundaries are explicit. If the policy says events at or after the
   cutoff are excluded, both `>` and `>=` mutations must be covered.
8. Freshness repair must preserve original issuer, command, outcome, and evidence
   identity; otherwise it is a new run, not a refresh.
9. Coverage-basis freshness is stricter than evidence freshness: a change to
   frozen scope, relevant diff hunks, registered producer/consumer facts,
   topology, frozen planned-path declaration, or discovery inputs requires basis
   recomputation. Rebinding an old path inventory or declaration projection to a
   new hash is forbidden.
10. **Ordering: regenerate the coverage basis BEFORE issuing `pre_review_check`,
    never after.** `pre_review_check` snapshots the plan basis digest into
    `priorPlanBasisDigest` at issue time, and the next recomputation compares it
    against the current plan basis by RAW `basisDigest`
    (`core/pre-review-check.ts`, the `PR_COVERAGE_BASIS_CHANGED` check). Because
    `basisDigest` covers `binding` (headHash/materialHash/storyFilesHash) and
    `receiptRef`, a further `acceptance_basis_generate` that changes NO acceptance
    semantics still moves that digest, so a genuine PASS decays to
    `PR_COVERAGE_BASIS_CHANGED` (usually alongside `PR_ARTIFACT_TAMPERED`) with no
    material drift and an unchanged `storyFilesHash`. This is a hazard for the
    operator, not a code defect: failing closed is correct per Rule 3's
    "never a silent pass" (Rule 9 governs coverage-basis freshness, not this
    rule). Recovery requires reissuing `pre_review_check`, which
    is a DEV-only writer — so a story that hits this in REVIEW cannot self-repair
    and must return to DEV. Note the codebase has a purpose-built
    `acceptanceCoverageBasisSemanticDigest` (strips `basisDigest`/`binding`/
    `receiptRef`) used by `verifyAcceptanceBasisReceipt` to detect exactly this
    hash-only rebinding; wiring it into the `PR_COVERAGE_BASIS_CHANGED` comparison
    would need a persisted semantic digest, since `priorPlanBasisDigest` stores
    only the raw hash. Discovered empirically on B-45a0 (F-431/F-432/F-433/F-435),
    where two convergence regenerations 82 seconds after a signed PASS silently
    invalidated it.

## 10. Applicability and compatibility

| Story/claim shape | Topology expectation |
|---|---|
| New high-risk behavior or lifecycle/proof gate | Full required topology; mutation and transcript based on claim type |
| Standard behavior change | Required topology for affected acceptance bindings |
| Ordinary single-outcome low-risk work | Minimal topology; no milestone ledger is invented |
| Documentation-only story | Docs assertions and source-boundary checks; no fake executable mutation requirement |
| Milestone-triggered story | Only confirmed ledger rows are gate-consumed |
| Candidate ledger | Diagnostic only; cannot satisfy topology totality |
| Optional claim | Explicit `optional` applicability and reason; omission is visible |
| `not_applicable` | External auditable decision ref required; self-authored note is insufficient |
| One producer to many consumers | Each required consumer has its own assertion/evidence edge |
| Many producers to one consumer | Assertion declares whether all or any producer is required |
| Legacy ProofStory without topology | Readable as `legacy_missing`; observe/warn initially, never silently treated as full proof |
| Machine-enumerable frozen scope | Basis may be `complete` after every profile-required adapter has a valid result, their union is reconciled under typed policies, and blind spots are empty |
| Dynamic/reflection/plugin path with admissible trace coverage | Basis may be `complete` only if policy declares the runtime trace sufficient for that bounded scope |
| Relevant dynamic path without admissible trace | Basis is `partial`; result is `INCONCLUSIVE` |
| Unsupported language/framework discovery | Basis is `unsupported`; result is `INCONCLUSIVE` |

## 11. Derived acceptance matrix

Example read-only rendering:

| Acceptance | Basis | Milestone | Producer → consumer | Positive | Mutation | Transcript | Authority | Freshness | Result |
|---|---|---|---|---|---|---|---|---|---|
| `AC-RUN-CUTOFF` | `CB-B-4444-001: complete` | `M2` | `P-B → C-VERIFY-B` | `PA-B-AFTER-C` | `MUT-NO-CUTOFF` | `TR-A-B-C` | local gate / signed run | current | ready-for-review |

Every cell is a link or ID derived from canonical inputs. The result column is a
computed diagnostic such as `structurally-complete`, `ready-for-review`,
`warning`, or `blocked`; it is not persisted as a new completion fact.

Implemented command surface through Wave 4:

```text
proof-or-stop acceptance_basis_generate --storyId=B-xxxx [--json]
proof-or-stop acceptance_basis --storyId=B-xxxx [--json]
proof-or-stop acceptance_topology_check --storyId=B-xxxx [--json]
proof-or-stop pre_review_check --storyId=B-xxxx [--json]
proof-or-stop pre_review_check_read --storyId=B-xxxx [--json]
proof-or-stop acceptance_rollout_report --storyId=B-xxxx [--json]
proof-or-stop acceptance_rollout_report_read --storyId=B-xxxx [--json]
proof-or-stop acceptance_rollout_check --storyId=B-xxxx [--json]
proof-or-stop acceptance_matrix --storyId=B-xxxx [--json]   # read-only renderer
```

Implementation status through Wave 4: `acceptance_topology_check`,
`pre_review_check`, and `acceptance_matrix` exist. The PLAN basis writer is
named `acceptance_basis_generate`; `pre_review_check_read` is the explicit
read-only pre-review verifier. Wave 3A was skipped under the flat project-level
rollout. Wave 4 adds the three rollout commands above, a signed
`acceptance-rollout-report.json`, and the flat DEV→REVIEW consumer. No selective
per-Story applicability is inferred.

## 12. Rollout and rollback

| Stage | Behavior | Promotion criterion |
|---|---|---|
| `observe` | Render topology and executable gaps; never block | Diagnostic codes stable; legacy impact measured |
| `warn` | Show would-block result and exact remediation; transition continues | False-block rate below agreed threshold; docs-only and legacy paths verified |
| `enforce` | Block only applicable configured transitions | Mutation bite tests, process-fact contract, freshness tests, and high-risk 3×2 review pass |

Recommended activation:

1. Ship schema normalization and read-only renderer in observe mode.
2. Measure missing topology categories on real Stories.
3. Add PLAN structural check in warn mode.
4. Add executable pre-review check in warn mode.
5. With the current flat project-wide gate mode, pilot `enforce` only in a
   dedicated project environment where its blast radius is explicitly accepted
   and every in-flight Story is prepared for the same mode.
6. Before selectively enforcing only newly created high-risk, lifecycle, or
   proof-gate Stories, deliver and independently review a separate per-Story or
   per-policy applicability-selection capability. It must use explicit typed
   policy, not fuzzy milestone/keyword triggers.
7. Expand only with explicit project configuration and measured false-block data.

Current constraint: `configuredProofStoryMode` resolves a single flat,
project-wide `reviewGateMode`/`doneGateMode`; there is no per-Story or per-trigger
selection mechanism. The existing
`milestone-triggered-gate-mode-default-decision.md` explicitly keeps the default
at `observe` and defers `enforce-for-triggered` machinery. This plan does not
overturn that decision. Selective rollout step 6 is therefore blocked until the
separate capability exists; without it, only the bounded project-level pilot in
step 5 is valid.

Rollback from enforce to warn changes blocking behavior only. It preserves all
artifacts, evidence, diagnostic rows, and audit history. Rollback must not rewrite
failed rows as passes.

## 13. Process-fact and authority obligations

Any topology fact consumed by a lifecycle gate requires both layers:

- prompt/role guidance explaining what the actor must provide;
- CLI/handler/gate code that validates the fact mechanically.

Implementation must update:

- command schemas and phase allowlists;
- a registered coverage-basis producer/verifier whose path inventory and
  completeness classification cannot be caller-authored;
- `packages/main/src/core/process-fact-registry.ts`;
- `packages/main/src/core/process-fact-levels.ts`;
- `scripts/verify-process-fact-contract.mjs`;
- producer and consumer rationale/verifier declarations;
- freshness/material binding declarations;
- tests proving prompt omission cannot bypass the gate.
- producer/consumer process facts needed to seed and cross-check the basis;
- signed topology-critic receipt verification and digest/freshness consumers.

Authority rules:

- local structural diagnostics are not Authority evidence;
- local executable evidence is not production completion proof;
- caller-writable `authority` strings are not trusted;
- issuer class is derived from signed/registered provenance;
- a degraded review campaign must never be rendered as independent two-host
  assurance.

For high-risk implementation waves, REVIEW uses the configured 3 rounds × 2
independent hosts (`Codex CLI` and `Claude CLI`) through the existing quorum
mechanism. If only one host is available, the permitted 3×1 degraded path is
explicitly non-authority/non-quorum and cannot be promoted by text or flags.

## 14. Likely implementation touchpoints

This is an inventory, not authorization to edit every file.

| Concern | Likely touchpoint |
|---|---|
| Types and schema constants | `packages/main/src/core/types.ts`, ProofStory schema constants |
| Coverage-basis discovery and closure | focused verifier plus scope/diff/registry/dispatch/static/runtime adapters |
| Normalization and totality evaluator | `packages/main/src/core/proofstory.ts` or a focused `acceptance-topology.ts` |
| CLI schemas/commands | ProofStory handler/schema registration surfaces |
| PLAN → DEV consumption | `packages/main/src/core/machine.ts` and guard diagnostics |
| DEV → REVIEW consumption | phase transition orchestration/handler gate surface |
| REVIEW → TEST compatibility | `packages/main/src/handlers/phase-gates.ts` |
| Freshness | existing freshness reader and story-files hash policy |
| Process facts | registry, levels, and contract verifier |
| Adjacent legacy vocabulary | `packages/main/src/core/authority-contracts.ts` |
| Prompts | implementer, verification-intent, coverage, and reviewer modules |
| Smokes/tests | focused topology smoke, pre-review mutation smoke, process-fact contract |
| Read-only display | ProofStory status or a dedicated matrix renderer |

The implementation Story must confirm exact file ownership before freezing its
scope; this table does not grant broad modification rights.

Before naming new topology fields, Wave 1 must inspect the dormant,
non-gate-consumed `VerificationTargetContract`, `TargetBoundEvidenceInput`, and
`EvidenceEnvelopeContract` vocabulary in `authority-contracts.ts`.
`VerificationTargetContract` owns target requirements; the latter two carry
run/ref/transcript bindings, while `negativeControls` belongs specifically to
`EvidenceEnvelopeContract`. Those shapes are not active gate truth and must not
be revived or treated as canonical merely because names overlap. The review is
a vocabulary and migration-collision check: reuse a name only when semantics
and ownership are identical; otherwise record the distinction explicitly and
avoid a second concept with a misleading synonym.

## 15. Bounded implementation waves

### Wave 1 — Schema and read-only diagnostics

Status: **IMPLEMENTED**

Outcome: add/freeze the versioned planned-path declaration under existing
verificationIntent ownership, normalize v1 topology references, validate
references/totality, and render the derived matrix in observe mode.

Entry: this plan is human-approved.  
Exit: planned declarations round-trip inside checklist verificationIntent;
verification-intent flow owns their write/freeze semantics; topology can only
reference declaration/endpoint IDs; legacy contracts read; derived rows expose
canonical IDs; no lifecycle behavior changes.
Stop: any need for a separate writable artifact or ambiguous canonical owner.

### Wave 1A — Independently derived coverage basis

Status: **IMPLEMENTED**

Outcome: implement the registered basis verifier, `complete` / `partial` /
`unsupported` classification, discovery adapters, signed receipt, digest and
workspace binding, closure diagnostics, and read-only basis rendering.

Dependency: Wave 1 schema ownership plus frozen scope/diff and process-fact
interfaces.
Exit: callers cannot submit path inventory or force `complete`; known static and
runtime paths are reconciled by union under typed adapter policies; global
registry/dispatch traversal includes consumers outside Story scope; blind spots
or unexplained discovery disagreement cause `INCONCLUSIVE`; every required
adapter has a replayable hash-bound result and omission/tampering fails;
verifier-derived typed planned paths come from frozen verification-intent
declarations and permit genuinely new endpoints at PLAN without circularly
trusting topology;
existing scope artifacts and both Story/closure hashes are bound; stale bindings
fail; every exclusion requires an eligible decision ref.
Stop: basis completeness depends on self-report, reviewer prose, silently
ignored adapters, or a hash-only rebind of an old inventory.

Wave 1A includes building the producer→consumer and handler/dispatch discovery
adapters. The current flat `PROCESS_FACT_REGISTRY` is an input catalog, not an
already implemented graph or dispatch inventory.

### Wave 2 — PLAN structural gate

Status: **IMPLEMENTED**

Outcome: integrate `acceptance_topology_check` at PLAN → DEV behind
observe/warn/enforce configuration.

Dependency: Waves 1 and 1A.
Exit: missing edges and prompt-only facts produce stable codes; docs-only and
single-outcome paths avoid false blocks; a declared new producer→consumer path
can enter DEV without pretending its code exists; PLAN accepts its typed planned
consumer, while pre-REVIEW requires an actual reconciled consumer; process facts
are registered.
Stop: the check requires executed evidence or duplicates verificationIntent.

### Wave 2A — Independent topology critic and role eligibility

Status: **IMPLEMENTED**

Outcome: implement the independent topology-critic role, eligible-role policy,
signed/hash-bound receipt, exclusion-approval path, and CLI verification of
critic independence.

Dependency: Waves 1A and 2, plus a human resolution of Open Decision 10.
Exit: an eligible non-implementer critic can sign a receipt bound to current
basis digest, topology digest, scope artifact digests, `storyFilesHash`, and
`closureFilesHash`; self-authored or ineligible identity is rejected; exclusion
approval is independently attributable; any basis that is `partial` or
`unsupported` remains non-pass regardless of critic verdict.
Stop: independence is inferred from prompt text or self-report, critic evidence
is not mechanically verified, or critic/exclusion approval can override
discovery incompleteness.

Implementation contract: the registered critic role is
`proof-or-stop-review-topology-critic`; the independently registered exclusion
approver is `proof-or-stop-review-scope-plan`. The production writer commands are
`topology_critic_receipt_set` and `topology_exclusion_approval_set`, while
`topology_critic_receipt_check` is read-only. Their signed artifacts bind the
current basis/topology/scope/workspace hashes and exact actor, session,
dispatch, and business-commit-author provenance. Exclusions require a current
one-to-one signed approval mapping. A `partial` or `unsupported` basis is an
unconditional non-pass. Wave 2A alone added no lifecycle admission gate:
PLAN → DEV continued to consume only Wave 2 `acceptance_topology_check`
structural semantics under its existing observe/warn/enforce rollout. A critic
receipt was produced and verified through the explicit CLI set/check path; its
absence or failure could not independently block PLAN → DEV. Those Wave 2A
mechanics did not themselves imply later-wave completion. Wave 3 executable
evidence was implemented separately; Wave 3A selective applicability remains
outside the implemented flat Wave 4 scope.

### Wave 3 — Executable pre-review evidence

Status: **IMPLEMENTED**

Outcome: implement `pre_review_check`, current-worktree basis recomputation,
omission mutations, mutation polarity, transcript relation, authority
admissibility, and freshness consumption.

Dependency: Waves 1–2A plus canonical evidence/receipt identifiers.
Exit: real producer-to-consumer tests pass; every adverse mutation bites; clean
controls pass after restoration; deleting a topology path that remains in the
basis fails; every planned path reconciles to actual current discovery; required
adapter omission or record/reconciliation tampering fails; stale, changed,
partial, and weak basis/evidence fail deterministically.
Stop: the implementation relies on caller-written authority or silent rebinding.

### Wave 3A — Explicit applicability selection for selective enforcement

Status: **SKIPPED — OPTIONAL UNDER THE CURRENT FLAT PROJECT-LEVEL ROLLOUT**

Outcome: if selective rollout is approved, add a separately scoped mechanism
that resolves gate mode from explicit Story/policy applicability rather than
implicitly interpreting risk keywords or milestone-trigger regexes.

Dependency: Waves 1–3 plus a human decision on the configuration and precedence
model.
Exit: the flat project default remains `observe`; explicit selection is
deterministic and auditable; missing/ambiguous selection fails to the project
default; existing Stories do not change mode retroactively; rollback removes
blocking without rewriting evidence.
Stop: selection depends on fuzzy prose, silently flips the project default, or
changes in-flight Story behavior without explicit operator approval.

Wave 3A is optional for a flat project-level rollout and mandatory for any claim
that enforcement applies only to newly created high-risk, lifecycle, or
proof-gate Stories.

### Wave 4 — Prompt integration and measured rollout

Status: **IMPLEMENTED — FLAT PROJECT BOUNDARY**

Outcome: update role guidance, enable warn telemetry, measure impact, and opt in
bounded project-level enforcement. Selective high-risk per-Story enforcement is
not part of this wave unless Wave 3A has first delivered explicit applicability
selection.

Dependency: Waves 1–3, including 2A for enforced high-assurance paths; Wave 3A
is additionally required for selective per-Story or per-policy enforcement.
Exit: current 3×2 high-risk review/quorum; false-pass and false-block thresholds
met; rollback tested; no degraded 3×1 evidence is labeled authority.  
Stop: review rounds fall only because checks were weakened or waivers increased.

Implemented contract:

- `runProofStoryAcceptanceRolloutCohort` materializes and reads back real
  temporary Story artifact trees. Every row runs the production
  `acceptance_topology_check` and `pre_review_check` paths, then records real
  reviewer runs/passes and a production `quorum_submit` metadata commit. The
  verifier checks that commit's exact six `host_verdict` rows before signing the
  observation. Callers cannot supply detected/blocked outcomes, review-round or
  usage totals, adapter identity, or quorum claims.
- `deriveAcceptanceRolloutReport` requires at least three matched baseline /
  candidate pairs in each arm and computes the report from source records. The
  registered measured run contains three seeded defect pairs plus docs-only,
  legacy, and ordinary false-block control pairs.
- Promotion requires every registered seed detected, overall false-pass count
  zero, supported omission detection 100%, false-block rate zero, mislabeled
  3×1 count zero, waiver delta `<= 0`, non-shrinking check inventory, supported
  `codex-cli+claude-cli` adapters, and genuine three-round/two-host evidence.
- `acceptance_rollout_report` is the sole signed report writer;
  `acceptance_rollout_report_read` and `acceptance_rollout_check` are read-only.
  DEV→REVIEW consumes the same evaluator. Observe, warn, and enforce keep the
  same status and ordered diagnostics; only enforce blocks.
- This repository opts into that blocking boundary with
  `proofStory.acceptanceRolloutGateMode=enforce`; therefore its current signed,
  promotable full-3×2 report is lifecycle authority rather than diagnostic-only
  review evidence.
- Rollback changes only `proofStory.acceptanceRolloutGateMode` to `warn` or
  `observe`. It never deletes or rewrites a report, receipt, failed attempt, or
  prior evidence.
- The measured output is local full-3×2 assurance. It is not a release,
  production, public-authority, or selective high-risk claim.

Each wave is a separate Story unless its scope reviewer proves a smaller safe
decomposition. A wave cannot claim later-wave completion.

## 16. Verification and mutation matrix

| Scenario/mutation | Stage | Expected result/code |
|---|---|---|
| Complete verifier-produced basis plus basis-closed required topology | PLAN | pass |
| New handler P and consumer C do not exist yet, but frozen verificationIntent declaration VPP owns their typed edge and valid files/scope refs | PLAN | structural pass; DEV may begin without executable evidence |
| New path is declared only as free-form future symbols or lacks a `ChecklistItem.files`/scope declaration | PLAN | `AT_PLANNED_PATH_INVALID` |
| Topology invents planned P→C without a frozen verification-intent declaration/endpoint | PLAN | `AT_PLANNED_PATH_DECLARATION_MISSING` |
| Topology restates VPP but changes its endpoint role, symbol/fact, file, or relation | PLAN | `AT_PLANNED_PATH_DECLARATION_DRIFT` |
| A valid declaration exists but verifier cannot derive P→C into the PLAN basis from it/files/scope | PLAN | `AT_PLANNED_PATH_OUTSIDE_BASIS` |
| Required topology has no signed basis | PLAN | `AT_COVERAGE_BASIS_MISSING` |
| Basis is caller-authored or issuer is ineligible | PLAN | reject artifact; no completeness state |
| Basis is `partial` or `unsupported` | PLAN | `AT_COVERAGE_BASIS_PARTIAL`; `INCONCLUSIVE` |
| Basis contains C2 but topology declares only C1 | PLAN | `AT_UNMAPPED_SCOPE_REF` |
| Topology declares C2 but current basis does not contain C2 | PLAN | `AT_TOPOLOGY_OUTSIDE_BASIS` |
| Basis excludes C2 without independent decision | PLAN | `AT_UNJUSTIFIED_EXCLUSION` |
| Basis binding or digest is stale | PLAN | `AT_COVERAGE_BASIS_STALE` |
| Static finds C2 while runtime trace misses C2 under a declared non-exhaustive trace policy | PLAN | union retains C2; no omission |
| Runtime finds C2 while static misses C2 without explained adapter policy | PLAN | union retains C2 and `AT_DISCOVERY_DISAGREEMENT`; basis is `partial` |
| Static/runtime adapters disagree semantically without reconciliation | both | `AT_DISCOVERY_DISAGREEMENT` / `PR_DISCOVERY_DISAGREEMENT`; cannot pass |
| Remove a profile-required static adapter result while leaving its method/path in the aggregate | PLAN | `AT_REQUIRED_ADAPTER_RESULT_MISSING`; cannot pass |
| Duplicate one profile-required adapter result with the same adapter ID/method | PLAN | `AT_REQUIRED_ADAPTER_RESULT_MISSING`; exactly-once cardinality fails |
| Delete a required method from the basis payload while the registered profile still requires it | PLAN | `AT_REQUIRED_ADAPTER_RESULT_MISSING`; caller cannot narrow profile |
| Change one adapter's C2 path set, claim, blind spots, provenance, or asymmetry policy without recomputing its digest and signed basis | PLAN | `AT_ADAPTER_RESULT_DIGEST_MISMATCH` |
| Keep every signed adapter result unchanged but independently add/remove C2 in aggregate `enumeratedPathRefs` or alter aggregate `blindSpots` | PLAN | `AT_ADAPTER_RESULT_DIGEST_MISMATCH`; derived projection fails |
| Recompute an adapter digest after tampering but retain the old signed basis receipt | PLAN | `AT_ADAPTER_RESULT_DIGEST_MISMATCH`; receipt/basis digest verification fails |
| Story changes producer P whose registered consumer C2 is outside Story scope | PLAN | global traversal retains C2; missing mapping yields `AT_REGISTERED_CONSUMER_UNMAPPED` |
| Missing producer | PLAN | `AT_UNKNOWN_REF` or `AT_ORPHAN_CONSUMER` |
| Missing consumer | PLAN | `AT_ORPHAN_PRODUCER` |
| Must intent absent from topology | PLAN | `AT_INTENT_UNCOVERED` |
| Behavioral claim has positive only | PLAN | `AT_MUTATION_MISSING` |
| User-visible claim has no transcript declaration | PLAN | `AT_TRANSCRIPT_MISSING` |
| Self-authored not-applicable note | PLAN | `AT_INVALID_NA_DECISION` |
| Topology stores `result: pass` | PLAN | `AT_INLINE_RESULT_FORBIDDEN` |
| Complete positive production-path evidence | pre-REVIEW | pass |
| Typed planned P→C is implemented and exact actual discovery is digest-bound | pre-REVIEW | reconciliation passes, then executable evidence is evaluated |
| Typed planned P→C entered DEV but P or C was never implemented | pre-REVIEW | `PR_PLANNED_PATH_UNRESOLVED` |
| Planned P→C is implemented as P→D with changed fact semantics and no approved replacement | pre-REVIEW | `PR_PLANNED_PATH_MISMATCH` |
| Remove or alter the planned→actual reconciliation while retaining its signed pre-REVIEW basis | pre-REVIEW | `PR_PLANNED_PATH_RECONCILIATION_TAMPERED` |
| Remove/tamper a required adapter result after DEV | pre-REVIEW | `PR_REQUIRED_ADAPTER_RESULT_MISSING` / `PR_ADAPTER_RESULT_DIGEST_MISMATCH` |
| Duplicate one profile-required current-worktree adapter result after DEV | pre-REVIEW | `PR_REQUIRED_ADAPTER_RESULT_MISSING`; exactly-once cardinality fails |
| Keep every signed current-worktree adapter result unchanged but independently mutate aggregate paths or aggregate blind spots | pre-REVIEW | `PR_ADAPTER_RESULT_DIGEST_MISMATCH`; derived projection fails |
| DEV adds consumer C2 after PLAN | pre-REVIEW | canonical first code `PR_NEW_PATH_UNMAPPED`, with supporting `PR_COVERAGE_BASIS_CHANGED` |
| Remove C2 from topology while current basis retains C2 | PLAN / pre-REVIEW | PLAN diagnostic is `AT_UNMAPPED_SCOPE_REF`; executable pre-REVIEW gate fails with canonical first code `PR_NEW_PATH_UNMAPPED` and supporting `PR_COVERAGE_BASIS_CHANGED` |
| Dynamic path cannot be enumerated or traced | pre-REVIEW | `PR_COVERAGE_INCONCLUSIVE` |
| Synthetic fixture bypasses real producer | pre-REVIEW | `PR_PRODUCTION_PATH_UNPROVEN` |
| Remove producer cutoff | pre-REVIEW | mutation must fail; otherwise `PR_MUTATION_DID_NOT_BITE` |
| Change `>=` exclusion to `>` | pre-REVIEW | equal-time mutation must fail; otherwise `PR_MUTATION_DID_NOT_BITE` |
| Mutation fails because build is broken | pre-REVIEW | `PR_MUTATION_DID_NOT_BITE` |
| Clean control not restored | pre-REVIEW | `PR_CONTROL_NOT_RESTORED` |
| Transcript omits consumer verification | pre-REVIEW | `PR_TRANSCRIPT_UNRELATED` |
| Caller changes authority label | pre-REVIEW | `PR_AUTHORITY_INADMISSIBLE` |
| Signed `storyFilesHash` changes | pre-REVIEW | `PR_EVIDENCE_STALE` |
| External closure consumer changes while Story hash is stable | pre-REVIEW | `PR_CLOSURE_FILES_CHANGED` |
| `materialHash` only drifts, story hash stable | pre-REVIEW | canonical classification; explicit advisory/re-attestation, never silent pass |
| Legacy evidence lacks story hash | pre-REVIEW | `PR_LEGACY_EVIDENCE_WEAK` on strong path |
| Docs-only claim | both | docs/source assertions pass without fabricated runtime mutation |
| Degraded 3×1 review | REVIEW | visible degraded/non-authority; cannot satisfy 3×2 quorum |

Mutation tests must alter the real consumer or verifier behavior in an isolated
copy, not merely change an expected string in the test. They must prove both
polarity and restoration:

```text
clean control passes
→ targeted mutation applied
→ expected semantic assertion fails with named reason
→ mutation removed
→ clean control passes again
```

The omission mutation is mandatory for the basis-closure gate: start with basis
paths `C1` and `C2`, remove only `C2` from topology while leaving the independently
derived basis unchanged, and assert that admission fails. A test that deletes
`C2` from both topology and basis proves nothing because it reproduces the
self-reporting failure mode this design exists to prevent.

## 17. Success metrics

Measure before and after on comparable high-assurance Stories:

- median REVIEW rounds before first all-lane pass;
- percentage of eventual REVIEW findings already surfaced by PLAN or pre-review;
- false-pass rate from seeded topology/mutation defects;
- false-block rate on docs-only, legacy, and single-outcome Stories;
- percentage of required topology edges backed by current evidence;
- percentage of Stories with independently derived `complete` basis versus
  honest `partial`/`unsupported` outcomes;
- seeded omission-detection rate when a real basis path is removed only from
  topology (target: 100% on supported adapters);
- unmapped path and unjustified exclusion counts at PLAN and pre-REVIEW;
- number of silent evidence rebindings (target: zero);
- number of degraded 3×1 campaigns mislabeled as two-host authority (target: zero);
- waiver count and age, so reduced rounds cannot be bought with waivers;
- time/token cost shifted from REVIEW to PLAN/DEV and total end-to-end cost.

Initial success is not “zero review findings.” A healthy target is fewer repeated
findings for already-known obligation classes while independent REVIEW continues
to find genuinely unmodeled issues.

Wave 4 measured flat cohort:

The canonical test producer executes the twelve hermetic production cases with
a bounded three-process pool. The focused consumer then reuses that exact
verifier-owned frozen cohort after proving the copied runner digest is
byte-identical; it does not regenerate the same cohort a second time. All six
pairs, signed source records, mutation diagnostics, and the real consumer
enforce/rollback checks remain unchanged.

| Metric | Result |
|---|---|
| Seeded matched pairs | `3` baseline + `3` candidate |
| False-block control pairs | docs-only `1`, legacy `1`, ordinary `1` per arm |
| Registered seed detection | `3/3` (`100%`) |
| Overall seeded false passes | `0` |
| Supported omission detection | `1/1` (`100%`) |
| False blocks | `0` |
| Mislabeled degraded 3×1 | `0` |
| Waiver delta | `0` across the full six-pair cohort |
| Check inventory shrinkage | `0` |
| Counted adapter/quorum | `codex-cli + claude-cli`, three rounds, `full-3x2` |

The focused smoke replays membership omission/ineligible/window/digest/N<3,
incomplete campaigns, signed-observation and gate-result tamper, degraded 3×1
receipt truncation, real transition consumption, exact restoration, mode
invariance, and non-destructive rollback. The registered cohort separately
executes omission, forgery, freshness, docs-only, legacy, and ordinary cases
through the production gate and quorum paths.

## 18. Risks and pre-mortem

| Failure scenario | Trigger | Consequence | Mitigation |
|---|---|---|---|
| Parallel truth source emerges | Matrix becomes writable | Conflicting completion facts | Derived-only renderer; reject writes |
| Schema duplicates claims/results | Inline prose and verdicts are accepted | Drift and laundering | Reference-only normalization; `AT_INLINE_RESULT_FORBIDDEN` |
| Coverage basis is self-reported | Implementer supplies both universe and topology | Omitted C2 passes both gates | Registered verifier independently derives basis; caller cannot set status or inventory |
| Topology circularly owns planned edges | Future symbols/relations exist only inside topology | Basis merely repeats the graph it is meant to challenge | Frozen verification-intent declaration owns the edge; topology references IDs; verifier derives basis from declaration/files/scope |
| PLAN requires new code to exist | Canonical-ref rule has no planned form | Genuine new producer/consumer can never enter DEV | Verification-intent-owned declaration plus verifier-derived planned path at PLAN; mandatory actual reconciliation before REVIEW |
| Planned promises survive into REVIEW | DEV omits or changes a declared path | Structural plan is mistaken for implemented closure | Fail closed on unresolved/mismatched/tampered planned→actual reconciliation |
| Adapter aggregation loses provenance | Basis retains only a union/method list | Required adapter can be ignored or its claim/policy rewritten invisibly | Hash-bound per-adapter records, registered required profile, reproducible projection, signed basis digest |
| Basis says complete despite blind spots | Dynamic/reflection/plugin paths are not discoverable | False completeness | Three-state classification; unresolved blind spot forces `partial`/`unsupported` and `INCONCLUSIVE` |
| Discovery adapters disagree and intersection wins | One adapter misses C2 | C2 silently disappears | Union every discovered path; unexplained disagreement forces `partial` with deterministic codes |
| A parallel frozen-scope truth appears | New topology-specific scope artifact is introduced | Scope contracts drift | Bind existing signed scope-check/scope-contract artifacts and their digests only |
| Registry discovery is Story-scope filtered | Registered consumer lives elsewhere | Cross-scope consumer bypasses topology | Traverse global registry/dispatch closure and bind all closure source files |
| DEV changes the real path set | PLAN basis is reused after code changes | New consumer bypasses topology | Recompute from actual diff/runtime inputs and bind to current `storyFilesHash` |
| Exclusion launders an omission | Implementer excludes C2 without scrutiny | Incomplete graph appears closed | Eligible independent decision ref plus omission mutation |
| PLAN gate executes tests | Structural check requires evidence | DEV cannot begin coherently | Hard separation of the two checks |
| Pre-review becomes checkbox theater | Positive evidence alone passes | False assurance | Required biting mutations and transcript relation |
| Mutation failure is nonspecific | Broken build counts as bite | False pass | Named semantic failure and restored control |
| Legacy rollout blocks unrelated work | Enforce becomes implicit | Adoption failure/bypass | Observe → warn → opt-in enforce |
| Docs-only work fabricates runtime proof | Uniform topology policy | Meaningless evidence | Typed applicability and docs assertions |
| Freshness logic forks | New hash classifier added | Inconsistent gate outcomes | Reuse canonical freshness reader |
| Local evidence gains Authority label | Caller-written metadata trusted | Overclaim | Registered issuers and prohibited promotions |
| REVIEW metrics improve deceptively | More waivers or fewer checks | Quality regression | Track false pass/block, waivers, and seeded defects |
| 3×1 is reported as 3×2 | Host identity not bound | Fake independence | Existing signed host quorum only |

## 19. Decision record and resolved Wave 4 policy

1. **Resolved:** `verificationTopology` is nested on each acceptance binding in
   the same `proofstory.json` envelope.
2. **Resolved in Wave 4:** all user-visible and orchestration claims require
   transcript assertions.
3. **Resolved in Wave 4:** behavior, lifecycle, proof, and safety claims require
   biting mutation cases; docs-only is exempt.
4. **Resolved for Waves 1–3:** DEV → REVIEW uses the existing flat project-level
   ProofStory gate mode.
5. **Resolved in Wave 4:** at least three matched pairs in each arm; every
   registered seed detected; overall false-pass zero; supported omission
   detection 100%; false-block zero; mislabeled 3×1 zero; waiver delta `<=0`;
   inventory non-shrinking.
6. **Resolved:** `acceptance_matrix` is the dedicated L0/read-only renderer.
7. **Resolved for the current rollout:** enforcement remains project-wide and
   flat. Selective enforcement requires a future Wave 3A implementation.
8. **Resolved for the implemented flat Wave 4 boundary:** only the registered
   combined `codex-cli+claude-cli` profile counts. Unknown, partial, unsupported,
   missing, or disagreeing adapters fail promotion. Broader framework profiles
   remain unsupported, never optimistic completeness.
9. **Resolved:** the signed coverage basis is a dedicated durable verifier-owned
   process artifact with non-caller-writable path inventory.
10. **Resolved in Wave 2A:** registered critic/exclusion roles and signed
    provenance mechanically establish independence from the implementer.

## 20. Human audit checklist

Mark **Pass** only if every required row below is true. Otherwise mark
**Request changes** and cite the section/row.

- [ ] The document accurately marks Waves 1/1A/2/2A/3/4 implemented and Wave 3A
      skipped under the flat rollout, without implying selective applicability.
- [ ] Milestone ledger remains the canonical intent-totality and `doneMeans`
      owner.
- [ ] ProofStory acceptance bindings remain the acceptance-claim reference owner.
- [ ] No independently writable `acceptance_matrix` is proposed.
- [ ] The derived matrix exposes canonical source IDs and is non-evidentiary.
- [ ] The topology schema is reference-based and versioned.
- [ ] `coverageBasis` is generated by a registered verifier, not supplied by the
      implementer or reviewer.
- [ ] `VerificationPlannedPathDeclarationV1` is nested under existing
      verificationIntent ownership, written/frozen by that flow, and canonically
      owns endpoint roles, expected files/symbols/facts, file refs, and relation.
- [ ] Topology only references planned declaration/endpoint IDs; the verifier
      independently derives the PLAN-basis projection from the frozen declaration,
      `ChecklistItem.files`, and scope. No new artifact or completion truth exists.
- [ ] A genuinely new declared producer/consumer need not exist before DEV, but
      its planned consumer cannot remain unresolved before REVIEW.
- [ ] Planned→actual reconciliation is digest-bound, included in the signed
      pre-REVIEW basis, and fails closed for omitted, mismatched, expanded-but-
      unmapped, or tampered paths.
- [ ] The topology references the PLAN basis/ref/receipt only; pre-REVIEW uses a
      distinct basis digest and receipt linked through `priorPlanBasisDigest`.
- [ ] Basis status is exactly `complete`, `partial`, or `unsupported`, and only
      `complete` can satisfy topology completeness.
- [ ] The PLAN basis is derived from frozen scope, current discoverable paths,
      registries, and typed planned declarations; its profile excludes DEV-output
      `actual_diff_hunks`. The distinct pre-REVIEW profile adds actual diff hunks
      and current handler/dispatch/static/runtime discovery.
- [ ] Frozen scope binds the existing signed `scope-check.json` and phase-
      applicable `scope-contract.json`; no parallel writable scope artifact is
      introduced.
- [ ] Adapter reconciliation uses the union of all discovered paths; unexplained
      static/runtime disagreement is `partial` with deterministic PLAN and
      pre-REVIEW codes.
- [ ] The registered discovery profile independently determines required
      adapters; every adapter result retains method, path set, claim, blind
      spots, provenance, typed asymmetry policy, and its own digest.
- [ ] Adapter records and digests are included in `basisDigest`/signed receipt;
      omission, duplication, field tampering, or aggregate mismatch has
      deterministic PLAN and pre-REVIEW failure codes and negative tests.
- [ ] The mutation matrix separately bites duplicate required adapter records and
      aggregate-only path/blind-spot projection tampering at both PLAN and
      pre-REVIEW.
- [ ] Registry/dispatch discovery traverses globally from Story facts to every
      registered consumer, including outside Story scope, and binds a separate
      `closureFilesHash`.
- [ ] Every basis path maps to topology or an independently approved exclusion;
      every topology path exists in the basis.
- [ ] Dynamic blind spots force `INCONCLUSIVE` unless an admissible bounded
      runtime trace closes them.
- [ ] Producer, consumer, positive, mutation, transcript, command, authority,
      temporal, and freshness obligations are all represented.
- [ ] Bidirectional totality and stable structural failure codes are specified.
- [ ] `acceptance_topology_check` is structural-only and belongs before DEV.
- [ ] `pre_review_check` requires current executable evidence before REVIEW.
- [ ] DEV→REVIEW independently recomputes the current basis and rejects new
      unmapped paths or stale basis/topology digests.
- [ ] A mutation must fail for the intended semantic reason and the clean control
      must pass after restoration.
- [ ] Transcript evidence must be related to the acceptance claim and event path.
- [ ] Freshness reuses canonical `storyFilesHash`/material classification and
      forbids silent rebinding.
- [ ] Legacy, docs-only, optional, not-applicable, and one-to-many cases are
      explicit.
- [ ] Observe → warn → enforce and rollback are safe and measurable.
- [ ] Gate-consumed facts require CLI/handler enforcement and process-fact
      registry/contract updates.
- [ ] Wave 2A owns critic implementation and cannot exit without mechanically
      verified role eligibility, independence, signed bindings, and exclusion
      approval; Open Decision 10 is resolved before entry.
- [ ] High-risk implementation uses genuine 3×2 host assurance; 3×1 remains
      explicitly degraded and non-authority.
- [ ] Follow-up work is divided into bounded waves with entry, exit, dependency,
      and stop conditions.
- [ ] The negative-control matrix includes producer/consumer deletion, polarity,
      transcript, authority, freshness, planned→actual reconciliation, and
      adapter-result omission/tampering mutations.
- [ ] An omission mutation removes C2 only from topology while retaining it in
      the independently derived basis, and the gate fails.
- [ ] Success metrics include false passes, false blocks, waiver use, and total
      cost—not only fewer REVIEW rounds.
- [ ] Wave 4 thresholds, adapters, current-receipt, full-3×2, and rollback
      boundaries match the executable evaluator and focused smoke.

Audit result:

```text
Decision: PASS | REQUEST CHANGES
Reviewer:
Date:
Sections/rows requiring changes:
Authorized implementation waves:
Conditions:
```

## 21. Non-goals

- Do not implement runtime code, schemas, commands, handlers, prompts, tests, or
  configuration in `B-4444`.
- Do not change `B-407c` or reinterpret its completed evidence.
- Do not replace REVIEW, TEST, DONE, delivery checks, quorum, or Authority proof.
- Do not make a milestone ledger mandatory for ordinary single-outcome Stories.
- Do not make mutation or transcript evidence meaningless by requiring it for
  claim types it cannot validly test.
- Do not allow natural-language notes to satisfy gate-consumed facts.
- Do not infer freshness or host independence from filenames or prose.
- Do not claim absolute path completeness outside a frozen, supported,
  machine-enumerable scope; unresolved discovery returns `INCONCLUSIVE`.
- Do not let the same actor author both the coverage universe and the topology
  closure assertion.
- Do not enable enforce mode before the measured rollout criteria are approved.

## 22. Acceptance criteria for this planning Story

`B-4444` is complete as a documentation deliverable when:

1. this is the only material file created by the Story;
2. the current-versus-target boundary is accurate;
3. the ownership and no-parallel-truth-source decision is explicit;
4. schema, algorithms, failure codes, freshness, authority, rollout, tests,
   independently derived coverage basis, three-state completeness, omission
   mutations, waves, risks, metrics, open decisions, and audit rubric are
   present;
5. independent reviewers find no status claim that contradicts the implemented
   Waves 1–3 or overstates Wave 4; and
6. the user received this file for audit before implementation Stories started.
