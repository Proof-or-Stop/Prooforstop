# ProofStory Acceptance Topology and Pre-Review Gates — Execution Plan

Status: **PROPOSED — AUDIT REQUIRED — NOT IMPLEMENTED**  
Story: `B-4444`  
Motivating incident: `B-407c` (evidence only; no changes to that Story)  
Decision owner: human approval after document audit

## 1. Executive decision

Proofbound should not add a separately writable `acceptance_matrix` artifact.
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

This document specifies future work. `B-4444` does not ship either command,
schema version, handler, prompt, test, or lifecycle gate.

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

| Surface | Current implementation | Proposed change |
|---|---|---|
| `MilestoneLedgerItem` | Owns requirement claim, `doneMeans`, required evidence classes, checklist refs, verification-intent refs, and candidate/confirmed intent binding | Remains unchanged as the canonical intent-totality ledger |
| `ProofStoryAcceptanceBinding` | Owns an acceptance binding ID plus claim/checklist/intent/milestone refs | Adds an optional versioned `verificationTopology` |
| `verificationIntent` | Declares planned happy, edge, and adversarial scenarios | Remains checklist-scoped; topology references its stable intent refs |
| `verificationEvidence` | Records observed command/manual/docs results against intent refs | Remains the observation store; topology references evidence IDs/receipts rather than copying results |
| ProofStory DEV diagnostics | Check intent artifacts, known refs, and coverage | Adds structural topology diagnostics through `acceptance_topology_check` |
| `evaluateReviewCompleteness` | At REVIEW → TEST, checks bound intent refs have passing evidence | Remains in place; consumes the stronger topology after implementation |
| DEV → REVIEW transition | Does not require the complete proposed proof topology to have current executable evidence | Adds `pre_review_check` before REVIEW begins |
| Acceptance matrix | No canonical writable artifact | Add only a derived read-only rendering |

The current source facts behind this table are in:

- `packages/main/src/core/types.ts` (`MilestoneLedgerItem`,
  `ProofStoryAcceptanceBinding`);
- `packages/main/src/core/proofstory.ts` (binding normalization, diagnostics,
  `evaluateReviewCompleteness`);
- `packages/main/src/handlers/phase-gates.ts` (configured ProofStory modes and
  REVIEW → TEST consumption);
- `packages/main/src/core/process-fact-registry.ts` and
  `packages/main/src/core/process-fact-levels.ts` (gate-fact ownership).

## 4. Canonical ownership and non-duplication invariant

| Question | Canonical owner | What it must not own |
|---|---|---|
| What outcomes did the user require? | Original intent snapshot and confirmed milestone ledger | Executed test results |
| What does completion mean for each milestone? | `MilestoneLedgerItem.doneMeans` and `requiredEvidence` | Reviewer verdicts or Authority claims |
| Which accepted claim maps to which work and intent? | `ProofStoryAcceptanceBinding` | Copied milestone claims or evidence status |
| Which scenarios must be verified? | Checklist `verificationIntent` | Observed pass/fail results |
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

### 5.2 Proposed TypeScript shape

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

interface AcceptanceCoverageBasisV1 {
  schemaVersion: 'proofstory.acceptance_coverage_basis.v1';
  storyId: string;
  status: 'complete' | 'partial' | 'unsupported';
  generatedBy: {
    verifier: string;
    command: string;
    algorithmVersion: string;
  };
  discoveryMethods: Array<
    | 'scope_contract'
    | 'actual_diff_hunks'
    | 'process_fact_registry'
    | 'handler_dispatch_inventory'
    | 'static_call_graph'
    | 'runtime_trace'
  >;
  scopeRefs: string[];
  sourceInventoryRefs: string[];
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
  };
  receiptRef: string;
  basisDigest: string;
}
```

Required referenced records:

| Record | Required fields | Meaning |
|---|---|---|
| coverage basis | `status`, verifier identity, discovery methods, scope/source/path refs, exclusions, blind spots, current binding, receipt, digest | Independently derived closure universe against which topology completeness is judged |
| producer | `id`, `kind`, `sourceRef`, `outputFact` | The production path that creates the fact under test |
| consumer | `id`, `kind`, `sourceRef`, `inputFact`, `producerRefs` | A real consumer that must observe or reject the producer fact |
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

### 5.3 Complete example

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
    "coverageBasisRef": "CB-B-4444-001",
    "coverageBasisDigest": "sha256:coverage-basis-digest",
    "applicability": {
      "mode": "required"
    },
    "producerRefs": [
      {
        "id": "P-B",
        "kind": "handler",
        "sourceRef": "review_run_start",
        "outputFact": "reviewRunEnvelope:B"
      }
    ],
    "consumerRefs": [
      {
        "id": "C-VERIFY-B",
        "kind": "verifier",
        "sourceRef": "verifyReviewRunPromptEnvelope",
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
      "acceptedIssuerKinds": ["lattice_handler", "signed_review_run"],
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

The referenced basis is produced independently, for example:

```json
{
  "schemaVersion": "proofstory.acceptance_coverage_basis.v1",
  "storyId": "B-4444",
  "status": "complete",
  "generatedBy": {
    "verifier": "acceptance-coverage-basis-verifier",
    "command": "lattice acceptance_coverage_basis_check --storyId=B-4444",
    "algorithmVersion": "v1"
  },
  "discoveryMethods": [
    "scope_contract",
    "actual_diff_hunks",
    "process_fact_registry",
    "handler_dispatch_inventory",
    "static_call_graph",
    "runtime_trace"
  ],
  "scopeRefs": ["scope:path:review-run", "scope:path:review-verifier"],
  "sourceInventoryRefs": [
    "handler:review_run_start",
    "verifier:verifyReviewRunPromptEnvelope"
  ],
  "enumeratedPathRefs": [
    "path:review_run_start->verifyReviewRunPromptEnvelope"
  ],
  "excludedPathRefs": [],
  "blindSpots": [],
  "binding": {
    "headHash": "current-head",
    "materialHash": "sha256:current-material",
    "storyFilesHash": "sha256:current-story-files"
  },
  "receiptRef": "receipt:coverage-basis:B-4444:001",
  "basisDigest": "sha256:coverage-basis-digest"
}
```

The example illustrates the target shape only. It is not a claim that this
schema or command exists.

## 6. Structural integrity and totality rules

`acceptance_topology_check` evaluates the following invariants:

1. Every required acceptance binding has exactly one topology version.
2. All topology IDs are non-empty and unique within the binding.
3. Every referenced checklist, intent, milestone, producer, consumer, command,
   and claim exists in its canonical owner.
4. Every required producer feeds at least one real consumer.
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
    from the frozen scope, actual diff hunks, registered process facts,
    handler/dispatch inventory, and applicable static/runtime path discovery.
16. Completeness PASS requires `coverageBasis.status === 'complete'`; `partial`
    and `unsupported` are `INCONCLUSIVE`, even if all declared topology nodes are
    internally connected.
17. Every `enumeratedPathRef` maps to at least one producer/consumer/assertion
    edge or to an exclusion carrying an independently approved decision ref.
18. Every topology producer/consumer source ref occurs in the current basis;
    topology cannot expand or narrow its own closure universe.
19. A `complete` basis has no unresolved blind spots. Dynamic/reflection/plugin
    paths require an admissible runtime trace or force `partial`/`unsupported`.
20. The basis digest and current `storyFilesHash` binding match the topology;
    any relevant workspace or topology change requires independent recomputation.

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

## 7. `acceptance_topology_check` — PLAN → DEV

Purpose: answer “Have we specified how every accepted claim will be proved?”

Inputs:

- original intent snapshot;
- confirmed milestone ledger when the milestone path applies;
- ProofStory acceptance bindings and topology;
- checklist and frozen verificationIntent;
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
resolve all canonical refs
derive applicability for each binding
independently derive coverage basis from frozen scope + current repository/runtime inputs
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
  AND basis.status == complete
  AND basis.binding is current
  AND topology.coverageBasisDigest == basis.basisDigest
  AND every basis path is mapped or independently excluded
  AND every topology path belongs to basis
  AND all remaining topology invariants pass
```

The verifier must compute the basis independently. A payload that lets the
caller choose `status`, path inventory, blind spots, or exclusions is invalid by
construction. A topology critic may challenge the result, but its prose cannot
turn a `partial` basis into `complete`.

Output is a diagnostic report. If a durable artifact is later introduced, it
must be hash-bound and process-fact registered; command output alone cannot be
retrofitted as gate evidence.

## 8. `pre_review_check` — DEV → REVIEW

Purpose: answer “Is there current, admissible evidence that the planned proof
topology is executable and bites before reviewers spend a round?”

For every applicable required binding, it verifies:

- coverage basis is independently recomputed from the actual current diff,
  source inventory, registries/dispatch paths, and applicable runtime traces;
- recomputed basis remains `complete` and its digest matches the topology;
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
input, not a substitute for enumerating paths.

It does not replace REVIEW. A pass means the implementation is ready to be
reviewed against a complete proof plan. Reviewers can still find missing paths,
weak assertions, design problems, or unmodeled interactions.

### 8.1 Deterministic executable codes

| Code | Condition |
|---|---|
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
| `PR_COVERAGE_BASIS_CHANGED` | Current DEV-derived basis differs from the topology-bound PLAN basis |
| `PR_NEW_PATH_UNMAPPED` | Current source/runtime discovery finds a path absent from topology |
| `PR_COVERAGE_INCONCLUSIVE` | Current path discovery is partial or unsupported |

### 8.2 Independent topology critic

Before DEV admission on enforced high-assurance paths, an independent topology
critic challenges scope, discovery methods, exclusions, and closure. Before
REVIEW, it re-attests the recomputed DEV basis. Its result must be a signed,
hash-bound artifact containing critic identity, basis digest, topology digest,
scope digest, `storyFilesHash`, finding refs, and verdict.

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
2. `materialHash`-only drift with unchanged signed `storyFilesHash` is classified
   by the existing freshness policy. A permitted re-attestation remains explicit
   and auditable; it is never a silent pass.
3. Legacy evidence without `storyFilesHash` follows the existing strict fallback.
   It stays readable but cannot be upgraded to strong proof merely by rewriting
   metadata.
4. `headHash` movement alone is not self-classified by the host. The canonical
   reader decides whether it is metadata/provenance movement or material drift.
5. Temporal claims declare a cutoff policy. Producer assembly and verifier
   recomputation must consume the same immutable cutoff fact.
6. Equality boundaries are explicit. If the policy says events at or after the
   cutoff are excluded, both `>` and `>=` mutations must be covered.
7. Freshness repair must preserve original issuer, command, outcome, and evidence
   identity; otherwise it is a new run, not a refresh.
8. Coverage-basis freshness is stricter than evidence freshness: a change to
   frozen scope, relevant diff hunks, registered producer/consumer facts,
   topology, or discovery inputs requires basis recomputation. Rebinding an old
   path inventory to a new hash is forbidden.

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
| Machine-enumerable frozen scope | Basis may be `complete` after all required discovery methods agree and blind spots are empty |
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

Proposed command surface:

```text
lattice acceptance_coverage_basis_check --storyId=B-xxxx [--json]
lattice acceptance_topology_check --storyId=B-xxxx [--json]
lattice pre_review_check --storyId=B-xxxx [--json]
lattice acceptance_matrix --storyId=B-xxxx [--json]   # read-only renderer
```

Names remain subject to audit. No command above exists because of this plan.

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

Before naming new topology fields, Wave 1 must inspect the legacy-quarantined
`VerificationTargetContract` / `TargetBoundEvidenceInput` vocabulary in
`authority-contracts.ts`, including `producerRunId`, `verifierRunId`,
`coveredRefs`, `uncoveredRefs`, `failedRefs`, `negativeControls`, and
`transcriptHash`. Those shapes are not active gate truth and must not be revived
or treated as canonical merely because names overlap. The review is a vocabulary
and migration-collision check: reuse a name only when semantics and ownership are
identical; otherwise record the distinction explicitly and avoid a second
concept with a misleading synonym.

## 15. Bounded implementation waves

### Wave 1 — Schema and read-only diagnostics

Outcome: normalize v1 topology, validate references/totality, and render the
derived matrix in observe mode.

Entry: this plan is human-approved.  
Exit: schema round-trips; legacy contracts read; derived rows expose canonical
IDs; no lifecycle behavior changes.  
Stop: any need for a separate writable artifact or ambiguous canonical owner.

### Wave 1A — Independently derived coverage basis

Outcome: implement the registered basis verifier, `complete` / `partial` /
`unsupported` classification, discovery adapters, signed receipt, digest and
workspace binding, closure diagnostics, and read-only basis rendering.

Dependency: Wave 1 schema ownership plus frozen scope/diff and process-fact
interfaces.
Exit: callers cannot submit path inventory or force `complete`; known static and
runtime paths are deterministically enumerated; blind spots cause
`INCONCLUSIVE`; stale basis bindings fail; every exclusion requires an eligible
decision ref.
Stop: basis completeness depends on self-report, reviewer prose, silently
ignored adapters, or a hash-only rebind of an old inventory.

### Wave 2 — PLAN structural gate

Outcome: integrate `acceptance_topology_check` at PLAN → DEV behind
observe/warn/enforce configuration.

Dependency: Waves 1 and 1A.
Exit: missing edges and prompt-only facts produce stable codes; docs-only and
single-outcome paths avoid false blocks; process facts are registered.  
Stop: the check requires executed evidence or duplicates verificationIntent.

### Wave 3 — Executable pre-review evidence

Outcome: implement `pre_review_check`, current-worktree basis recomputation,
omission mutations, mutation polarity, transcript relation, authority
admissibility, and freshness consumption.

Dependency: Waves 1–2 plus canonical evidence/receipt identifiers.  
Exit: real producer-to-consumer tests pass; every adverse mutation bites; clean
controls pass after restoration; deleting a topology path that remains in the
basis fails; stale, changed, partial, and weak basis/evidence fail
deterministically.
Stop: the implementation relies on caller-written authority or silent rebinding.

### Wave 3A — Explicit applicability selection for selective enforcement

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

Outcome: update role guidance, enable warn telemetry, measure impact, and opt in
bounded project-level enforcement. Selective high-risk per-Story enforcement is
not part of this wave unless Wave 3A has first delivered explicit applicability
selection.

Dependency: Waves 1–3; Wave 3A is additionally required for selective per-Story
or per-policy enforcement.
Exit: current 3×2 high-risk review/quorum; false-pass and false-block thresholds
met; rollback tested; no degraded 3×1 evidence is labeled authority.  
Stop: review rounds fall only because checks were weakened or waivers increased.

Each wave is a separate Story unless its scope reviewer proves a smaller safe
decomposition. A wave cannot claim later-wave completion.

## 16. Verification and mutation matrix

| Scenario/mutation | Stage | Expected result/code |
|---|---|---|
| Complete verifier-produced basis plus basis-closed required topology | PLAN | pass |
| Required topology has no signed basis | PLAN | `AT_COVERAGE_BASIS_MISSING` |
| Basis is caller-authored or issuer is ineligible | PLAN | reject artifact; no completeness state |
| Basis is `partial` or `unsupported` | PLAN | `AT_COVERAGE_BASIS_PARTIAL`; `INCONCLUSIVE` |
| Basis contains C2 but topology declares only C1 | PLAN | `AT_UNMAPPED_SCOPE_REF` |
| Topology declares C2 but current basis does not contain C2 | PLAN | `AT_TOPOLOGY_OUTSIDE_BASIS` |
| Basis excludes C2 without independent decision | PLAN | `AT_UNJUSTIFIED_EXCLUSION` |
| Basis binding or digest is stale | PLAN | `AT_COVERAGE_BASIS_STALE` |
| Missing producer | PLAN | `AT_UNKNOWN_REF` or `AT_ORPHAN_CONSUMER` |
| Missing consumer | PLAN | `AT_ORPHAN_PRODUCER` |
| Must intent absent from topology | PLAN | `AT_INTENT_UNCOVERED` |
| Behavioral claim has positive only | PLAN | `AT_MUTATION_MISSING` |
| User-visible claim has no transcript declaration | PLAN | `AT_TRANSCRIPT_MISSING` |
| Self-authored not-applicable note | PLAN | `AT_INVALID_NA_DECISION` |
| Topology stores `result: pass` | PLAN | `AT_INLINE_RESULT_FORBIDDEN` |
| Complete positive production-path evidence | pre-REVIEW | pass |
| DEV adds consumer C2 after PLAN | pre-REVIEW | `PR_COVERAGE_BASIS_CHANGED` plus `PR_NEW_PATH_UNMAPPED` |
| Remove C2 from topology while current basis retains C2 | both | omission mutation must fail with `AT_UNMAPPED_SCOPE_REF` |
| Dynamic path cannot be enumerated or traced | pre-REVIEW | `PR_COVERAGE_INCONCLUSIVE` |
| Synthetic fixture bypasses real producer | pre-REVIEW | `PR_PRODUCTION_PATH_UNPROVEN` |
| Remove producer cutoff | pre-REVIEW | mutation must fail; otherwise `PR_MUTATION_DID_NOT_BITE` |
| Change `>=` exclusion to `>` | pre-REVIEW | equal-time mutation must fail; otherwise `PR_MUTATION_DID_NOT_BITE` |
| Mutation fails because build is broken | pre-REVIEW | `PR_MUTATION_DID_NOT_BITE` |
| Clean control not restored | pre-REVIEW | `PR_CONTROL_NOT_RESTORED` |
| Transcript omits consumer verification | pre-REVIEW | `PR_TRANSCRIPT_UNRELATED` |
| Caller changes authority label | pre-REVIEW | `PR_AUTHORITY_INADMISSIBLE` |
| Signed `storyFilesHash` changes | pre-REVIEW | `PR_EVIDENCE_STALE` |
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

## 18. Risks and pre-mortem

| Failure scenario | Trigger | Consequence | Mitigation |
|---|---|---|---|
| Parallel truth source emerges | Matrix becomes writable | Conflicting completion facts | Derived-only renderer; reject writes |
| Schema duplicates claims/results | Inline prose and verdicts are accepted | Drift and laundering | Reference-only normalization; `AT_INLINE_RESULT_FORBIDDEN` |
| Coverage basis is self-reported | Implementer supplies both universe and topology | Omitted C2 passes both gates | Registered verifier independently derives basis; caller cannot set status or inventory |
| Basis says complete despite blind spots | Dynamic/reflection/plugin paths are not discoverable | False completeness | Three-state classification; unresolved blind spot forces `partial`/`unsupported` and `INCONCLUSIVE` |
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

## 19. Open decisions for human audit

1. Should `verificationTopology` be nested on each acceptance binding, as
   proposed, or referenced from a topology table inside the same
   `proofstory.json` envelope? Either is acceptable only if there is one owner and
   atomic versioning; a separate artifact is not recommended.
2. Which claim classes require transcript assertions by default: all
   user-visible/orchestration claims, or a narrower configured taxonomy?
3. Which claim classes require mutation cases by default? The proposed default is
   behavior, lifecycle, proof, and safety claims, with docs-only exemptions.
4. Should DEV → REVIEW enforce be a separate config key
   (`preReviewGateMode`) or derived from an existing ProofStory gate mode? A
   separate key improves rollout control but expands configuration.
5. What measured thresholds authorize warn → enforce (false-block rate, seeded
   defect detection, minimum Story sample size)? These must be set before Wave 4.
6. Should the matrix renderer be a dedicated command or part of existing
   ProofStory status output? It must remain L0/read-only either way.
7. Should selective enforcement be Story-bound, policy-profile-bound, or remain
   project-wide? Until Wave 3A and this decision are complete, the only supported
   model is the existing flat project-wide mode.
8. Which discovery adapters are sufficient to classify each supported
   language/framework as `complete`, and which combinations require runtime
   traces? Until answered, unsupported adapters must return `partial` or
   `unsupported`, never optimistic completeness.
9. Should the signed coverage basis be a dedicated durable process artifact or
   a verifier-recomputable section of `proofstory.json`? Either choice must keep
   path inventory non-caller-writable and atomically bind basis/topology digests.
10. Which roles may approve exclusions and topology-critic receipts, and how is
    independence from the implementer mechanically established?

## 20. Human audit checklist

Mark **Pass** only if every required row below is true. Otherwise mark
**Request changes** and cite the section/row.

- [ ] The document clearly says PROPOSED / NOT IMPLEMENTED.
- [ ] Milestone ledger remains the canonical intent-totality and `doneMeans`
      owner.
- [ ] ProofStory acceptance bindings remain the acceptance-claim reference owner.
- [ ] No independently writable `acceptance_matrix` is proposed.
- [ ] The derived matrix exposes canonical source IDs and is non-evidentiary.
- [ ] The topology schema is reference-based and versioned.
- [ ] `coverageBasis` is generated by a registered verifier, not supplied by the
      implementer or reviewer.
- [ ] Basis status is exactly `complete`, `partial`, or `unsupported`, and only
      `complete` can satisfy topology completeness.
- [ ] The basis is derived from frozen scope, actual diff hunks, registries,
      handler/dispatch inventory, and applicable static/runtime discovery.
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
- [ ] High-risk implementation uses genuine 3×2 host assurance; 3×1 remains
      explicitly degraded and non-authority.
- [ ] Follow-up work is divided into bounded waves with entry, exit, dependency,
      and stop conditions.
- [ ] The negative-control matrix includes producer/consumer deletion, polarity,
      transcript, authority, and freshness mutations.
- [ ] An omission mutation removes C2 only from topology while retaining it in
      the independently derived basis, and the gate fails.
- [ ] Success metrics include false passes, false blocks, waiver use, and total
      cost—not only fewer REVIEW rounds.
- [ ] Open decisions are resolved or explicitly accepted before implementation.

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
5. independent reviewers find no unmarked claim that proposed gates already
   exist; and
6. the user receives this file for audit before any implementation Story starts.
