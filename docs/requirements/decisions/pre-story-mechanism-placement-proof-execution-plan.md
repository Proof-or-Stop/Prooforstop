# Pre-Story Mechanism Placement Proof — Architecture and Execution Plan

Status: **AUDITED PROPOSAL; documentation only; no runtime enforcement is implemented by this document**
Story: `B-c648`
Motivating incident: build/bootstrap side failure tracked by `B-fb7b`, surfaced
during `B-3783` DONE-required validation
Enforce-mode dependency: `B-8de3` evidence-store atomic-write hardening
Date: 2026-08-14

## 1. Executive decision

Proofbound should add a mandatory **Mechanism Placement Proof** to the existing
`STORY_INTAKE` path for applicable work. It should not add a lifecycle phase or
a second planning system.

**Mechanism Placement Proof** means a fresh, independently reviewed,
candidate-only proof—completed before any new Story ID is allocated—that:

1. identifies the real execution entrypoint;
2. traces the relevant producer-to-consumer chain;
3. inventories mechanisms that already own the behavior;
4. selects the earliest authoritative hook that can repair the defect without
   broadening responsibility; and
5. names the smallest change and the verification that would disprove an
   incorrect placement.

The gate has exactly three outcomes:

- `PROCEED`: the placement claim is complete, fresh, and independently
  reviewed; Story creation may continue;
- `NEEDS_RESEARCH`: one or more load-bearing facts remain unknown or
  contradictory; no Story ID is allocated; or
- `STOP_NO_STORY`: the proposed Story premise is refuted, the behavior is
  already owned elsewhere, the candidate is a duplicate, or no justified
  repair exists; no Story ID is allocated.

`unknown` is never an alias for `PROCEED`. `forceNew` and
`reproFirstBypassReason` must not bypass this gate.

The design reuses five existing architectural assets:

- Evidence Runtime and its immutable `evidence-candidate` scope;
- Repro-First STORY_INTAKE artifacts;
- `story_draft` plus independently signed draft review;
- the central `story_create` handler used by direct, draft, planner, and
  Repro-First creation paths; and
- PLAN `verificationIntent` plus acceptance-topology recomputation after the
  Story exists.

The missing part today is not another reasoning prompt. It is a required,
fresh, review-bound intake artifact and a central pre-allocation gate.

## 2. Direct answer: what Proof-or-Stop already solves and what it does not

The current architecture contains most of the ingredients, but it does not
mechanically solve this false-premise class before Story creation. The concrete
build/bootstrap example is `B-fb7b`; it surfaced while `B-3783` was running
DONE-required validation but was not the root defect of `B-3783` itself.

| Existing mechanism | What it proves today | Why it does not close this gap |
|---|---|---|
| Repro-First `repro_probe` / `repro_review_set` | The observed failure is real and classified as the target bug instead of bootstrap or environment noise | It does not require a complete execution chain, existing-mechanism inventory, rejected hooks, or a minimum authoritative repair point |
| Optional spike evidence | A bounded exploration may explain a failure or narrow scope | A spike can remain inconclusive and is not a mandatory placement decision |
| `story_draft` | Background, title, description, and checklist exist before a formal Story ID | The solution shape is already assumed; the draft does not currently bind structured mechanism research |
| `draft_check_set` | A reviewer signs the current background/title/description/checklist hash | The signature does not include mechanism-probe or mechanism-review digests |
| INIT reviewers / `init_preflight` | The created Story has background quality, product value, scope boundary, execution boundary, and INIT evidence | The Story ID already exists; a wrong-direction Story has already entered the backlog |
| Original intent / intent collision / ProofStory contract | The user request, accepted interpretation, checklist, and verification intent are coherent | These artifacts are PLAN inputs after Story allocation |
| `plannedPathDeclarations` | A verification-intent role can declare producer-to-consumer proof paths | `story_create` explicitly rejects these declarations at creation; they can only be authored during PLAN |
| Acceptance topology | PLAN checks structural proof paths and pre-REVIEW checks current executable evidence | It can catch an incorrect planned path after creation, not stop the wrong Story ID from being allocated |
| REVIEW / TEST / DONE | Independent critique, validation, freshness, and completion evidence | These are delivery gates, not intake-placement gates |

Therefore the correct architectural statement is:

> Proof-or-Stop already has the evidence store, independent review patterns,
> central creation choke point, and post-creation path verification needed to
> support the solution. It does not yet require or consume a Mechanism
> Placement Proof before Story ID allocation.

## 3. Incident reconstruction: the B-fb7b side failure found during B-3783

### 3.1 Current execution facts

At the 2026-08-14 repository snapshot:

- root `npm run build` builds `packages/main`, then `packages/utils`, then runs
  `scripts/verify-full-suite-build-binding.mjs`;
- `lattice.config.json` routine validation starts by building only
  `packages/main`;
- the routine validation command set runs `packages/main/dist` entrypoints and
  does not establish a consumer requirement for `packages/utils/dist` or
  `bin/lattice.js`;
- DONE-required validation builds `packages/main`, then runs root `npm test`;
- root `npm test` starts `packages/main/dist/tasks/full-suite-runner.js`;
- full-suite children invoke `bin/lattice.js` on some paths;
- `bin/bootstrap-runner.js` requires both
  `packages/main/dist/cli-engine.js` and `packages/utils/dist/index.js`; and
- when either artifact is absent, bootstrap prints recovery commands and exits
  instead of building automatically.

The relevant chain is:

```text
done_required_validate
  -> packages/main build
  -> root npm test
  -> full-suite-runner
  -> child test invokes bin/lattice.js
  -> bin/bootstrap-runner.js
  -> packages/utils/dist/index.js required
  -> missing artifact => exit(1)
```

### 3.2 Plausible hypotheses that focused research refutes

| Initial hypothesis | Focused evidence | Verdict |
|---|---|---|
| “Routine `proof-or-stop validate` must build utils” | Its command paths do not consume utils or `bin/lattice.js` | Refuted; changing validate would repair the wrong owner |
| “The worktree handler should auto-build dist” | The failing delivery path is root `npm test`; changing worktree creation broadens a sensitive lifecycle component | Refuted as the minimum repair point |
| “Bootstrap should always auto-build missing artifacts” | Bootstrap is shared by interactive and test entrypoints; implicit builds add side effects, latency, and recursion risk | Broader alternative, not the minimum defect repair |
| “The full-suite child tests should each remember to build utils” | This duplicates a shared prerequisite across consumers | Refuted by ownership and duplication |
| “Root test should establish its own build prerequisite” | Root test owns the full suite and is the first common entrypoint whose descendants require both dist trees | Confirmed minimum authoritative hook |

### 3.3 Minimum repair selected by the proof

The narrow repair proposed by `B-fb7b` is a root `pretest` that reuses the
authoritative root build:

```json
{
  "scripts": {
    "pretest": "npm run build"
  }
}
```

This document does not implement or pre-approve that patch. The example shows
what the intake mechanism must accomplish: a candidate aimed at routine
validation or the worktree handler should receive `STOP_NO_STORY` for that
premise; a revised candidate aimed at root test ownership can receive
`PROCEED` after independent review. No wrong-direction Story ID is needed.

## 4. Goals, guarantees, and non-goals

### 4.1 Required guarantees

For an applicable new Story, the architecture must guarantee that:

1. a valid and fresh Mechanism Placement Proof exists before `nextStoryId`;
2. the proof references replayable source or command facts rather than a prose
   assertion that research happened;
3. the review is a distinct signed run bound to a fresh-context reviewer
   contract; same-host actor separation is not overstated as a mechanically
   provable identity fact;
4. all five mandatory questions have a non-`unknown` reviewed verdict;
5. the chosen hook is compared with at least one rejected alternative unless
   the reviewer records why only one hook exists;
6. every Story-creation path consumes the same gate;
7. source drift in any load-bearing research file makes the review stale;
8. a stop verdict allocates no Story ID and writes no Story lifecycle files;
9. candidate evidence cannot satisfy PLAN, REVIEW, TEST, DONE, Authority, or
   production proof; and
10. post-creation verification independently re-derives current proof paths.

### 4.2 Bounded guarantee

The mechanism proves placement only inside the declared, replayable research
basis. It cannot prove that every dynamic path in an open system is known.

If a relevant path is dynamic, inaccessible, secret-dependent, or otherwise
not enumerable, the result is `NEEDS_RESEARCH` or `STOP_NO_STORY`; reviewer
confidence cannot convert it to `PROCEED`.

### 4.3 Non-goals

This design does not:

- replace Repro-First failure evidence;
- replace PLAN understanding, decision, verificationIntent, or acceptance
  topology;
- replace REVIEW, validation, delivery checks, or DONE-required evidence;
- turn pre-story evidence into verificationEvidence;
- add `RESEARCH` to the Story state machine;
- make the intake artifact a second requirements, acceptance, or evidence truth
  source;
- automatically implement the chosen repair; or
- promise that static analysis discovers all runtime consumers.

## 5. Lifecycle placement

The mechanism is a row inside existing `STORY_INTAKE`, before draft approval
and before ID allocation:

```text
problem / request
  -> applicability classification
  -> optional repro_probe + repro_review_set
  -> mechanism_probe_set
  -> mechanism_review_start
  -> independent mechanism_review_set
  -> story_intake_check
       |-- PROCEED ---------> story_draft
       |                       -> draft_check_set v2
       |                       -> story_create --fromDraft
       |-- NEEDS_RESEARCH --> no Story ID; return missing questions
       `-- STOP_NO_STORY ---> no Story ID; return refuted premise / owner
  -> INIT -> INIT_CHECK -> PLAN
  -> verificationIntent planned paths
  -> acceptance-topology pipeline binds independently derived current paths
  -> acceptance_topology_check evaluates structural completeness
  -> DEV -> REVIEW -> TEST -> DONE
```

Repro-First and Mechanism Placement Proof are complementary:

- Repro-First asks, “Is this the target failure?”
- Mechanism Placement Proof asks, “Which existing mechanism owns the repair,
  and what is the smallest authoritative hook?”

For a deterministic code bug, both may be required. A reviewed repro artifact
can be referenced by the mechanism probe, but neither artifact subsumes the
other.

## 6. Applicability policy

### 6.1 Required classes

Mechanism Placement Proof is required when the candidate may change:

- build, bootstrap, install, test-runner, validation, or entrypoint behavior;
- lifecycle transitions, gates, locks, signatures, hashes, receipts, or
  registries;
- framework or workspace-wide configuration;
- dispatch, planner, story intake, reviewer, or evidence ownership;
- shared handlers with three or more known consumers;
- public API or cross-package dependency order; or
- any task classified high-assurance by existing risk and intent policy.

### 6.2 Not-applicable classes

Pure prose, spelling, formatting, and already-localized documentation changes
may be `not_applicable` only when the intake classifier can show that all
declared outputs are documentation and no runtime or gate claim is changed.

`not_applicable` is a structured classification with:

- `reasonCode`;
- declared output paths;
- classifier version;
- source task digest; and
- reviewer-visible explanation.

It is not a free-form bypass. In enforce mode, ambiguous classification is
treated as required.

### 6.3 No general emergency bypass

`forceNew` remains a deduplication override only.
`reproFirstBypassReason` remains a Repro-First exception only.

Neither field bypasses Mechanism Placement Proof. Urgent work may use a bounded
probe with fewer basis files, but it must still identify the entrypoint, owner,
hook, and disconfirming verification. If those facts cannot be established, the
correct Proof-or-Stop result is not to allocate a Story on a guessed premise.

## 7. Mandatory research questions

Every probe contains the following stable question IDs:

| ID | Question | Minimum evidence | Blocking condition |
|---|---|---|---|
| `Q1_ENTRYPOINT` | What command, handler, or external event first enters the failing behavior? | Entrypoint source reference and, when executable, a command receipt | Missing, inferred only from naming, or contradictory entrypoints |
| `Q2_CONSUMER_CHAIN` | What exact chain reaches the failure or obligation? | Ordered nodes with source references; dynamic edges need bounded trace/receipt | Any load-bearing edge is `unknown` |
| `Q3_EXISTING_MECHANISMS` | Which workspace mechanisms already build, validate, gate, recover, or own this behavior? | Registry/config/script references plus observed responsibility | Inventory omits a known authoritative owner or relies only on keyword search |
| `Q4_AUTHORITATIVE_HOOK` | What is the earliest common owner that can fix the defect without broadening unrelated behavior? | Candidate-hook comparison, chosen hook, rejected hooks, and reasons | No comparison, owner mismatch, or shared side effects unresolved |
| `Q5_MINIMUM_CHANGE_AND_PROOF` | What is the smallest change set and what verification would bite if placement is wrong? | Declared files/symbols, negative proof, positive proof, and relevant full-suite path | Verification only proves syntax/build or cannot distinguish the rejected hooks |

Each question records `confirmed`, `refuted`, or `unknown`. The probe author may
propose a verdict, but only the independent review artifact controls intake.

## 8. Candidate evidence model

All new artifacts use the existing Evidence Runtime and remain
`evidenceScope: "evidence-candidate"`.

### 8.1 Artifact kinds

Add these canonical hyphenated kinds:

- `mechanism-probe`;
- `mechanism-review-run`; and
- `mechanism-review`.

CLI commands remain underscore-style:

- `mechanism_probe_set` / `mechanism_probe_get`;
- `mechanism_review_start`;
- `mechanism_review_set`; and
- `story_intake_check`.

After Story creation, extend the existing `story-evidence-binding` with source
digest references. Do not create a separately authoritative
`story-mechanism-binding` truth source.

### 8.2 Probe schema

Normative v1 shape:

```ts
interface MechanismProbeV1 {
  schemaVersion: 'mechanism-placement-probe.v1';
  evidenceScope: 'evidence-candidate';
  candidateId: string;
  task: MechanismTaskEnvelopeV1;
  taskDigest: `sha256:${string}`;
  applicability: {
    verdict: 'required' | 'not_applicable' | 'inconclusive';
    reasonCode: string;
    classifierVersion: string;
    declaredOutputPaths: string[];
  };
  baseline: {
    headHash: string | null;
    materialHash: string | null;
    researchFilesHash: `sha256:${string}`;
    researchBasis: ResearchBasisEntry[];
  };
  questions: MechanismQuestionAnswer[];
  executionChain: MechanismChainNode[];
  existingMechanisms: ExistingMechanism[];
  candidateHooks: CandidateHook[];
  chosenHook: {
    hookId: string;
    owner: string;
    sourceRef: EvidenceSourceRef;
    rationale: string;
  } | null;
  minimalChangeSet: {
    modify: string[];
    create: string[];
    test: string[];
    symbols: string[];
  };
  verificationPlan: {
    negativeProof: CommandSpecOrInspection;
    positiveProof: CommandSpecOrInspection;
    bitingFailure: string;
  };
  openQuestions: string[];
  proposedVerdict: 'PROCEED' | 'NEEDS_RESEARCH' | 'STOP_NO_STORY';
  conclusionReason: string;
  producer: CandidateProducerEnvelope;
  createdAt: string;
}
```

The task envelope and producer envelope are explicit:

```ts
interface MechanismTaskEnvelopeV1 {
  title: string;
  description: string;
  type: string;
  priority: string;
}

interface CandidateProducerEnvelope {
  agentId: string;
  host: string;
  sessionId: string;
  promptHash: `sha256:${string}`;
  createdAt: string;
}
```

`taskDigest` is `sha256` over UTF-8 canonical JSON containing exactly
`schemaVersion`, normalized `title`, normalized `description`, lower-cased
`type`, and lower-cased `priority`. Normalization converts CRLF to LF, trims
leading/trailing whitespace, and collapses internal horizontal whitespace in
the title only. The same function is used by probe creation, draft binding,
direct creation, planner creation, and Repro-First delegation. If research
changes the premise enough to change this envelope, a new probe and review are
required.

`ResearchBasisEntry` is computed by the CLI from normalized project-relative
paths. It contains:

```ts
interface ResearchBasisEntry {
  path: string;
  locator: string;
  sourceKind: 'tracked_blob' | 'worktree_content' | 'command_receipt';
  contentHash: `sha256:${string}`;
  gitBlobHash?: string;
  commandReceiptDigest?: `sha256:${string}`;
  role: 'entrypoint' | 'chain' | 'mechanism' | 'hook' | 'verification';
}
```

The handler computes file and receipt digests. A caller cannot supply a trusted
`researchFilesHash`, claim a path was read, or self-declare freshness.

This proves the cited basis and its content. It does not claim transcript-level
proof of what a model mentally read. The reviewer must replay load-bearing
references, and future read-manifest instrumentation may strengthen that
separate concern without changing this artifact's authority.

### 8.3 Review-run schema

`mechanism_review_start` creates a signed immutable run before review:

```ts
interface MechanismReviewRunV1 {
  schemaVersion: 'mechanism-placement-review-run.v1';
  evidenceScope: 'evidence-candidate';
  reviewRunId: string;
  candidateId: string;
  probeArtifactId: string;
  probeDigest: `sha256:${string}`;
  researchFilesHash: `sha256:${string}`;
  reviewerLane: 'mechanism-placement-reviewer';
  host: string;
  sessionId: string;
  promptHash: `sha256:${string}`;
  issuedAt: string;
  signature: string;
}
```

The reviewer may not submit a verdict without this run. The handler validates
the run signature, probe and research hashes, reviewer lane, prompt hash, and
freshness.

Same-host CLI execution does not provide a reliable mechanical distinction
between a main agent and a genuinely fresh reviewer: they may share process,
environment, and session-shaped identifiers. V1 therefore does **not** claim
that comparing `host`, `sessionId`, `agentId`, or PPID proves independent human
or model identity. Those producer fields are provenance and diagnostics only.

The independence control follows the repository's existing anti-self-exemption
composition:

1. a signed reviewer run bound to the exact probe and canonical reviewer
   prompt;
2. a reviewer template with a fresh-context fence that prohibits carrying the
   producer's conclusion into review;
3. host guidance that forbids the producer/main agent from self-invoking the
   review verdict; and
4. optional stronger cross-host receipts when configured for high-assurance
   intake.

The first three controls are auditable but do not create a cryptographic
same-host identity guarantee. A future host-native identity primitive may
strengthen this without changing the placement artifact schema.

### 8.4 Review schema

```ts
interface MechanismReviewV1 {
  schemaVersion: 'mechanism-placement-review.v1';
  evidenceScope: 'evidence-candidate';
  reviewId: string;
  reviewRunId: string;
  candidateId: string;
  probeArtifactId: string;
  probeDigest: `sha256:${string}`;
  researchFilesHash: `sha256:${string}`;
  questionReviews: Array<{
    questionId:
      | 'Q1_ENTRYPOINT'
      | 'Q2_CONSUMER_CHAIN'
      | 'Q3_EXISTING_MECHANISMS'
      | 'Q4_AUTHORITATIVE_HOOK'
      | 'Q5_MINIMUM_CHANGE_AND_PROOF';
    verdict: 'confirmed' | 'refuted' | 'unknown';
    replayedBasisRefs: string[];
    note: string;
  }>;
  hookVerdict: {
    chosenHookId: string | null;
    rejectedHookIds: string[];
    minimumPlacementConfirmed: boolean;
    note: string;
  };
  verdict: 'PROCEED' | 'NEEDS_RESEARCH' | 'STOP_NO_STORY';
  reasonCodes: string[];
  requiredNextResearch: string[];
  reviewedAt: string;
  signature: string;
}
```

`PROCEED` is valid only when all five question verdicts are `confirmed`, the
minimum hook is confirmed, the probe is fresh, and `requiredNextResearch` is
empty.

`NEEDS_RESEARCH` is mandatory when any question is `unknown`, evidence conflicts,
or a load-bearing dynamic edge is not replayable.

`STOP_NO_STORY` is mandatory when the proposed premise is refuted, another
mechanism already satisfies the requested outcome, the candidate is a duplicate,
or every candidate hook would broaden scope beyond the request.

## 9. Freshness and replay

### 9.1 Research-files hash

The canonical hash is computed over a typed object, not delimiter-free string
concatenation:

```text
entries = sort by (path, locator, role, sourceKind)

canonicalEntry = {
  path,
  locator,
  sourceKind,
  contentHash,
  gitBlobHash: gitBlobHash ?? null,
  commandReceiptDigest: commandReceiptDigest ?? null,
  role
}

researchFilesHash = sha256(UTF8(canonicalJson({
  schemaVersion: "mechanism-research-basis.v1",
  entries: entries.map(canonicalEntry)
})))
```

`canonicalJson` sorts object keys lexicographically, preserves array order,
emits no insignificant whitespace, serializes absent optional fields as JSON
`null`, and rejects non-finite numbers or duplicate keys. `gitBlobHash` is
included as provenance for tracked blobs; `contentHash` remains the uniform
content authority for tracked and worktree sources.

Path normalization rejects absolute paths, `..` traversal, duplicate aliases,
and case-collision ambiguity.

### 9.2 Drift classification

| Drift | Gate behavior |
|---|---|
| Any research-basis content or command receipt changed | Review is stale; block `PROCEED` |
| Probe digest changed | Review is stale; block |
| Draft content changed but probe basis did not | Draft check is stale; rerun draft review; mechanism review may remain current |
| HEAD changed while all research-basis hashes are unchanged | Advisory provenance drift; do not force mechanism replay solely for unrelated HEAD movement |
| Applicability classifier version or policy changed | Rerun `story_intake_check`; fail closed when the new result is required/inconclusive |
| Evidence object is missing, malformed, digest-mismatched, or signature-invalid | Fail closed |

The gate must consume the shared freshness classifier instead of reimplementing
hash semantics in prompt text or renderer code.

### 9.3 Immutable-store safety dependency

`B-8de3` tracks a non-atomic immutable-object write plus exists-then-read dedupe
failure that can permanently poison a digest. Mechanism artifacts inherit that
risk because they are stored in Evidence Runtime.

Therefore:

- shadow and warn command development may start before `B-8de3` closes only as
  non-decisional diagnostics because they do not block Story creation;
- any malformed, mismatched, or unreadable shadow/warn object is quarantined,
  reported as `MECH_INTAKE_STORAGE_INTEGRITY_FAILURE`, and excluded from rollout
  metrics;
- telemetry used to approve enforce mode is collected only after `B-8de3`
  closes and the store passes atomic-write/read/recovery characterization;
- enforce mode must not activate until atomic write, post-write validation,
  dedupe-read validation, and corrupted-object recovery are implemented and
  verified; and
- `story_intake_check` must surface storage-integrity failure as
  `NEEDS_RESEARCH`/blocking infrastructure status, never silently downgrade it
  to missing optional evidence.

## 10. Draft binding

### 10.1 `story_draft`

Add a required `mechanismReviewRef` for applicable drafts:

```ts
interface DraftMechanismBindingV1 {
  reviewArtifactId: string;
  reviewDigest: `sha256:${string}`;
  probeArtifactId: string;
  probeDigest: `sha256:${string}`;
  researchFilesHash: `sha256:${string}`;
  verdict: 'PROCEED';
}
```

The handler resolves the artifact; callers cannot paste an unverified verdict.

### 10.2 Draft check hash v2

The current draft check signs background, title, description, checklist, and
review round. Introduce a versioned hash that also includes:

- mechanism review artifact ID and digest;
- probe artifact ID and digest;
- `researchFilesHash`;
- applicability result and policy version; and
- the fixed `PROCEED` verdict.

Legacy v1 draft checks remain readable in `off`/`warn` mode. In enforce mode,
an applicable new draft requires v2.

Add an explicit `schemaVersion` to `DraftCheckData`:

```ts
type DraftCheckSchemaVersion = 'draft-check.v1' | 'draft-check.v2';
```

An absent version is normalized to v1 for legacy reads. A v2 record requires a
complete `mechanismBinding`; field-presence or null-value sniffing must not be
used to infer the version.

Changing the draft does not mutate a mechanism artifact. Changing a
load-bearing research fact invalidates the mechanism review and, transitively,
the draft check.

## 11. Central Story allocation gate

### 11.1 One normalized candidate

Refactor both current `story_create` branches to produce a
`NormalizedStoryCandidate` before allocation:

```ts
interface StoryCreateMechanismArgs {
  mechanismReviewArtifactId?: string;
}

interface NormalizedStoryCandidate {
  source: 'direct' | 'draft' | 'planner' | 'repro-first';
  name: string;
  title: string;
  description: string;
  type: string;
  priority: string;
  checklistDigest: `sha256:${string}`;
  taskDigest: `sha256:${string}`;
  mechanismReviewRef?: DraftMechanismBindingV1;
  reproBindingRef?: string;
}
```

For `fromDraft`, the handler resolves the exact review artifact from the v2
draft binding. Direct `story_create` accepts
`mechanismReviewArtifactId` explicitly. Planner creation must pass the exact
artifact ID attached to its planned candidate; it may not use a global or
"latest" lookup. Repro-First delegation passes both its Repro artifact refs and
the exact mechanism review artifact ID.

For every source, the handler resolves that exact artifact and verifies its
`candidateId` and `taskDigest` against the normalized candidate. Omission in
enforce mode, mismatch, ambiguity, or lookup by recency fails closed before ID
allocation.

### 11.2 Required ordering

Inside the existing main-write lock, creation ordering is:

```text
normalize candidate
  -> exact-name/idempotency and duplicate lookup
       -> existing Story reuse: return existing ID; no new allocation
  -> compute applicability
  -> resolve probe/review/run artifacts
  -> verify digests, signatures, independence, questions, verdict, freshness
  -> evaluateMechanismIntakeGate(candidate)
       -> NEEDS_RESEARCH: return structured stop; write no Story
       -> STOP_NO_STORY: return structured stop; write no Story
       -> PROCEED: continue
  -> nextStoryId
  -> write Story/checklist/background/bindings
```

The gate must run before both current `nextStoryId` calls in
`packages/main/src/handlers/story-create.ts`.

Deduplication runs first because returning an already-existing Story allocates
nothing new. `forceNew` may bypass that deduplication decision, but the forced
candidate must still pass Mechanism Placement Proof.

### 11.3 All creation paths

- direct `story_create` reaches the common gate;
- `story_create --fromDraft` reaches the same gate and must also validate the
  v2 draft check;
- planner creation already delegates to `createStoryCreateHandlers(ctx)` and
  therefore reaches the common gate;
- `story_create_from_repro` already delegates to the same handler and therefore
  reaches the common gate; and
- no helper may call `nextStoryId` or write Story files outside this gate.

That final invariant applies to externally dispatchable production creation
paths. The existing internal, non-dispatchable `_nextStoryId` fixture helper may
remain for isolated tests, but it cannot be registered, routed, or accepted as
a production Story-creation command.

The gate returns structured reason codes instead of an exception-only prose
message:

```ts
interface StoryIntakeCheckResult {
  status: 'pass' | 'stop';
  verdict: 'PROCEED' | 'NEEDS_RESEARCH' | 'STOP_NO_STORY';
  blocking: boolean;
  candidateId: string;
  probeDigest?: string;
  reviewDigest?: string;
  researchFilesHash?: string;
  reasonCodes: string[];
  nextActions: string[];
  storyIdAllocated: false;
}
```

For `PROCEED`, the creation response later reports the newly allocated Story ID.
For both stop verdicts, `storyIdAllocated` remains mechanically `false`.

## 12. Handoff to ProofStory after creation

After successful creation, the existing `story-evidence-binding` records only
immutable source references:

- `mechanismProbeId` / `mechanismProbeDigest`;
- `mechanismReviewId` / `mechanismReviewDigest`;
- existing Repro-First `probeId` / `probeDigest` and `reviewId` /
  `reviewDigest`, when present;
- created Story ID;
- checklist digest; and
- task digest.

It does not create `verificationEvidence`, planned paths, a review pass, or a
validation result.

During PLAN:

1. an independent verification-intent role reads the candidate references as
   context;
2. that role authors `plannedPathDeclarations` through the existing authorized
   checklist path;
3. the acceptance-topology pipeline uses `verifyAcceptanceBasisReceipt` to
   bind independently derived current-worktree paths, after which
   `acceptance_topology_check` evaluates structural completeness; and
4. mismatch between the intake placement and current topology becomes a
   diagnostic or blocker under existing topology policy.

This independent recomputation is deliberate. Copying the intake chain into
verificationIntent as trusted fact would let a single early mistake propagate
through every later gate.

## 13. Process-fact two-layer contract

Mechanism Placement Proof affects Story allocation and is therefore a process
fact. It requires both layers.

### 13.1 Prompt layer

Agent prompts must:

- route applicable requests to `mechanism_probe_set` before `story_draft`;
- require the five stable questions;
- prohibit producer self-review;
- tell the reviewer to call `mechanism_review_start` before reading conclusions;
- require `mechanism_review_set` even for stop verdicts; and
- direct the host to follow `story_intake_check` next actions rather than
  manually interpreting raw hashes.

### 13.2 Mechanical layer

CLI/handler/gate code must independently enforce:

- schema and canonical enums;
- applicability policy;
- artifact scope and kind;
- digest, signature, reviewer-run, prompt-fence, and freshness binding;
- all-question totality;
- verdict derivation constraints;
- v2 draft binding;
- central pre-`nextStoryId` stop; and
- no candidate-to-lifecycle-evidence promotion.

Update in the same implementation wave:

- `packages/main/src/core/command-policy.ts`;
- `packages/main/src/core/process-fact-levels.ts`;
- `packages/main/src/core/process-fact-registry.ts`;
- CLI command catalog and registry;
- reviewer templates and all maintained host mirrors; and
- `scripts/verify-process-fact-contract.mjs`.

Prompt-only implementation is incomplete. Handler-only implementation is also
incomplete because agents would lack a reliable route to produce the required
facts.

## 14. Configuration and rollout

Proposed project configuration:

```json
{
  "mechanismIntake": {
    "mode": "off",
    "requiredFor": [
      "framework-control-plane",
      "build-bootstrap-test-entrypoint",
      "workspace-wide-config",
      "high-assurance"
    ],
    "docsOnlyPolicy": "structured-not-applicable",
    "unknownApplicability": "required",
    "minimumRejectedHooks": 1,
    "requiredQuestionIds": [
      "Q1_ENTRYPOINT",
      "Q2_CONSUMER_CHAIN",
      "Q3_EXISTING_MECHANISMS",
      "Q4_AUTHORITATIVE_HOOK",
      "Q5_MINIMUM_CHANGE_AND_PROOF"
    ]
  }
}
```

Modes:

- `off`: read legacy projects; do not request or evaluate artifacts;
- `shadow`: produce artifacts and diagnostics, but creation behavior is
  unchanged;
- `warn`: missing/stale/refuted placement is prominent, machine-counted, and
  included in Story creation output, but does not block; and
- `enforce`: applicable new Story allocation requires a fresh `PROCEED` review.

Rollout waves:

| Wave | Scope | Exit criteria |
|---|---|---|
| M0 — decision | This document and independent CLI audits | No unresolved blocker/high architecture findings |
| M1 — candidate artifacts | Types, commands, signed review run, `story_intake_check`, smoke tests in shadow | Artifact corruption, invalid reviewer-run/prompt binding, unknown question, and freshness tests fail closed diagnostically; pre-B-8de3 metrics are quarantinable diagnostics only |
| M2 — draft binding | `story_draft` reference, draft-check hash v2, CLI/prompt/process-fact contract, warn mode | Direct and draft flows show identical diagnostics; legacy projects remain readable |
| M3 — Proofbound self-enforce | Common `story_create` gate before both ID allocations | `B-8de3` closed; post-hardening trusted telemetry excludes quarantined objects; all four creation paths tested; no-ID assertions pass; telemetry shows bounded false-stop rate |
| M4 — external opt-in | Documented config and migration tooling | External fixtures cover off/shadow/warn/enforce without inheriting Proofbound-specific paths |

There is no automatic time-based promotion. A human-approved config change is
required between modes.

## 15. Observability and operator experience

`story_intake_check` and `session_brief` should render:

- applicability and policy version;
- candidate ID;
- probe/review/run validity;
- five question statuses;
- chosen and rejected hooks;
- research freshness classification;
- final verdict and stable reason codes;
- whether an ID was allocated; and
- exact next commands.

Suggested reason codes include:

- `MECH_INTAKE_NOT_APPLICABLE`;
- `MECH_INTAKE_PROBE_MISSING`;
- `MECH_INTAKE_REVIEW_MISSING`;
- `MECH_INTAKE_REVIEWER_NOT_INDEPENDENT`;
- `MECH_INTAKE_QUESTION_UNKNOWN`;
- `MECH_INTAKE_CHAIN_INCOMPLETE`;
- `MECH_INTAKE_HOOK_NOT_MINIMAL`;
- `MECH_INTAKE_RESEARCH_STALE`;
- `MECH_INTAKE_DRAFT_BINDING_STALE`;
- `MECH_INTAKE_STORAGE_INTEGRITY_FAILURE`;
- `MECH_INTAKE_STOP_PREMISE_REFUTED`; and
- `MECH_INTAKE_PROCEED`.

Metrics for rollout evaluation:

- applicable candidate count;
- `PROCEED` / `NEEDS_RESEARCH` / `STOP_NO_STORY` rates;
- reason-code distribution;
- median research basis size;
- time from probe to reviewed verdict;
- review-stale rate;
- number of Story IDs avoided after refuted premises;
- subsequent PLAN placement-mismatch rate; and
- override attempts through `forceNew` or Repro-First bypass fields.

Metrics are diagnostic, not gate evidence.

## 16. Implementation touchpoints

The implementation should be decomposed, but the expected minimum surfaces are:

| Surface | Change |
|---|---|
| `packages/main/src/core/evidence/types.ts` | Add candidate artifact kinds and schemas |
| `packages/main/src/core/mechanism-intake.ts` | Canonical question IDs, hash/freshness, applicability, verdict and gate evaluation |
| `packages/main/src/handlers/mechanism-intake.ts` | Probe/get/review-start/review-set/intake-check handlers |
| `packages/main/src/handlers/story-draft.ts` | Accept and resolve mechanism review references |
| `packages/main/src/handlers/draft-check.ts` | Bind v2 draft review to mechanism evidence |
| `packages/main/src/core/draft-check-hash.ts` | Versioned hash including mechanism digests and policy |
| `packages/main/src/handlers/story-create.ts` | Add explicit `mechanismReviewArtifactId`, normalize both branches, exact-match `candidateId`/`taskDigest`, and gate before both `nextStoryId` calls |
| `packages/main/src/handlers/planner.ts` | No local bypass; regression proves delegation reaches common gate |
| `packages/main/src/handlers/repro-intake.ts` | Bind both Repro-First and mechanism evidence, then delegate |
| CLI command catalog / registry / policy | Expose commands with correct lifecycle, ownership, and risk classes |
| process-fact levels / registry / verifier | Register gate-consumed facts and prevent prompt/handler drift |
| reviewer templates and host mirrors | Route producer and independent reviewer behavior |
| focused smoke tasks | Prove verdict, freshness, binding, no-ID, and all-path behavior |

Do not modify sensitive worktree or bootstrap handlers merely to host this
intake rule. The central Story allocation boundary is the authoritative hook.

## 17. Verification matrix

### 17.1 B-3783 characterization

1. Fixture shows routine validate does not consume utils/bin bootstrap.
2. Fixture shows root full suite reaches `bin/lattice.js` and requires utils
   dist.
3. Probe records validate/worktree/bootstrap-auto-build as alternatives.
4. Independent review refutes validate/worktree placement and confirms root
   test prerequisite ownership.
5. A wrong-placement candidate returns `STOP_NO_STORY` with no new ID.
6. A revised root-test candidate returns `PROCEED` and can create exactly one
   Story.

### 17.2 Verdict and schema tests

- missing one mandatory question cannot produce `PROCEED`;
- `unknown` cannot be normalized to confirmed;
- refuted entrypoint forces stop or renewed research;
- missing rejected-hook comparison blocks unless the single-hook reason is
  independently confirmed;
- caller-supplied hashes and verdict-only prose are rejected;
- malformed, unknown-kind, or wrong-scope artifacts fail closed; and
- a probe cannot create `verificationEvidence`.

### 17.3 Freshness tests

- change a basis file: review and draft binding become stale;
- change an unrelated file: HEAD drift is advisory when basis hashes remain
  identical;
- change probe content: old review fails;
- change task/draft content: old draft check fails;
- change applicability policy version: intake is reevaluated; and
- corrupt an evidence object or its digest: storage-integrity failure blocks
  enforce mode.

### 17.4 Path-coverage tests

Exercise all creation modes:

1. direct `story_create`;
2. `story_create --fromDraft`;
3. planner-created Story; and
4. `story_create_from_repro`.

For each mode:

- missing/stale/non-proceed evidence allocates no ID;
- valid evidence allocates one ID;
- concurrent identical creation remains idempotent;
- `forceNew` bypasses dedup only, not placement proof; and
- `reproFirstBypassReason` does not bypass placement proof.

Tests must assert the ID counter and Story directory set are unchanged after a
stop; checking only an error string is insufficient.

### 17.5 Authority-boundary tests

- invalid reviewer-run, probe, prompt, or freshness bindings are rejected;
- tests do not claim that same-host session/PPID equality proves reviewer
  independence; the fresh-context fence and optional cross-host receipt are
  tested according to their actual assurance level;
- review without a signed review run is rejected;
- wrong probe/review/draft digest combinations are rejected;
- candidate artifacts are rejected by REVIEW/TEST/DONE evidence consumers;
- planned paths remain writable only by the PLAN verification-intent role; and
- acceptance topology recomputes from current files instead of trusting the
  intake chain.

### 17.6 Process-fact contract tests

- command policies and process-fact levels cover every new command;
- registry lists artifact, reviewer lane, verdict, freshness, and allocation
  stop semantics;
- `verify-process-fact-contract` fails if prompt and mechanical facts diverge;
- maintained Claude/Codex/Antigravity prompt mirrors stay synchronized; and
- docs-only `not_applicable` requires the structured classifier result.

## 18. Threat model and failure containment

| Threat | Containment |
|---|---|
| Agent claims it inspected the workspace but cites no replayable basis | Handler requires normalized source/receipt references and computes hashes |
| Producer self-approves its placement | Signed review run, canonical fresh-context reviewer fence, explicit host behavior contract, and optional cross-host receipt; no same-host identity overclaim |
| Reviewer rubber-stamps while facts are unknown | All five questions must be confirmed; `unknown` derives `NEEDS_RESEARCH` |
| A stale review is reused after code/config drift | Research-basis hash and shared freshness classifier |
| Direct creation bypasses draft review | Common `story_create` gate before both allocation calls |
| Planner/Repro-First bypasses direct guard | Both delegate to the same normalized candidate gate; path smoke tests |
| `forceNew` becomes an escape hatch | Scope it mechanically to dedup only |
| Candidate evidence is promoted to DONE proof | Fixed `evidence-candidate` scope and consumer rejection tests |
| Intake becomes a second acceptance truth source | Binding stores references only; PLAN intent and topology remain canonical for delivery proof |
| Evidence object is poisoned by interrupted write | Do not enforce before `B-8de3`; validate on write/read and support recovery |
| Broad applicability causes process avoidance | Structured classifier, docs-only not-applicable, measured shadow/warn rollout |

## 19. Proposed delivery decomposition

This decision should not be implemented as one broad Story.

1. **Candidate artifact core** — types, canonical hashes, commands, signed
   reviewer run, freshness, and focused smoke tests in shadow mode.
2. **Draft/process contract binding** — story draft reference, draft-check v2,
   prompts, command policy, process-fact registry, and warn-mode UX.
3. **Central allocation enforcement** — normalized candidate, all creation
   paths, no-ID assertions, dedup/bypass semantics, and self-repo enforce
   config; depends on `B-8de3`.
4. **ProofStory handoff and measurement** — extend existing Story evidence
   binding, PLAN context projection, topology mismatch metrics, and external
   opt-in documentation.

Every implementation Story must run its own pre-story focused research under
the best available mechanism at that time. This document is not permission to
skip current lifecycle gates.

## 20. Decision summary

Adopt the following architecture:

- no new lifecycle phase;
- no second truth source;
- new immutable candidate-only placement artifacts in Evidence Runtime;
- independent signed mechanism review;
- fresh five-question proof;
- v2 binding into story draft review;
- one common gate in `story_create` before ID allocation;
- fail closed to `NEEDS_RESEARCH` or `STOP_NO_STORY`;
- independent PLAN verificationIntent and topology recomputation afterward;
- shadow, warn, then enforce; and
- no enforce before `B-8de3` closes.

This turns “research first” from a useful habit into a bounded Proof-or-Stop
mechanism: either the proposed repair location is proved well enough to justify
creating a Story, or the system stops before institutionalizing a false premise.

## 21. Independent CLI audit record

This section is completed after both CLIs review the same full draft. Reviewers
must not edit the document and must not see the other review before submitting
their first verdict.

### 21.1 Audit rubric

Both reviews must check:

1. duplication versus Repro-First, draft review, ProofStory, and acceptance
   topology;
2. authority and candidate-only evidence boundaries;
3. every Story creation path and ID-allocation bypass;
4. freshness, replay, signature, and independent-review semantics;
5. process-fact prompt/CLI dual-layer registration;
6. storage-integrity dependency and rollout safety;
7. B-3783 placement reasoning; and
8. verification completeness, including no-ID assertions.

### 21.2 Claude CLI audit

- Host: Claude CLI / Claude Code `2.1.220` (`claude-sonnet-5` reported by the
  auditor).
- First verdict: `PASS_WITH_CHANGES`.
- Findings: one HIGH, four MEDIUM, and two LOW; no BLOCKER.
- HIGH: same-host session identity cannot mechanically prove producer/reviewer
  separation. Required the established signed-run + fresh-context-fence +
  behavior-contract composition and an explicit bounded assurance statement.
- Strengths preserved: accurate `story_create` choke-point topology,
  candidate-only boundary, correctly scoped bypass fields, B-8de3 dependency,
  and no-ID state assertions.

### 21.3 Antigravity CLI (`agy`) audit

- Host: Antigravity CLI (`agy`), auditor-reported CLI `1.1.13`.
- Operational note: the first 5-minute invocation terminated with an explicit
  timeout and returned no verdict; the single permitted replacement used the
  same rubric with a 10-minute limit and completed.
- First completed verdict: `PASS_WITH_CHANGES`.
- Findings: one HIGH and two MEDIUM; no BLOCKER.
- HIGH: direct and planner creation lacked an explicit mechanism review
  artifact input, making implicit latest-artifact lookup a possible wrong
  binding or bypass.
- Strengths preserved: pre-allocation boundary, downstream independent
  recomputation, B-8de3 dependency, and strict bypass scoping.

### 21.4 Finding dispositions and final status

| Finding | Severity | Disposition |
|---|---|---|
| Claude H1 — same-host reviewer identity overclaim | HIGH | Accepted. Removed session-equality enforcement; specified signed run, canonical prompt/fresh-context fence, host behavior contract, optional cross-host receipt, and the non-cryptographic V1 boundary. |
| Claude M1 — collision with Repro-First binding fields | MEDIUM | Accepted. Added explicit `mechanismProbe*` and `mechanismReview*` fields while preserving existing generic Repro fields. |
| Claude M2 — B-3783 incident attribution | MEDIUM | Accepted. Reframed `B-fb7b` as the side failure surfaced during B-3783 validation, not B-3783's root defect. |
| Claude M3 — draft-check v2 recognition | MEDIUM | Accepted. Added explicit schema version; absent means v1 and field sniffing is forbidden. |
| Claude M4 — pre-B-8de3 telemetry integrity | MEDIUM | Accepted. Shadow/warn may develop diagnostically, but corrupted artifacts are quarantined and enforce-promotion telemetry starts only after B-8de3. |
| Claude L1 — `_nextStoryId` fixture helper | LOW | Accepted. Scoped the invariant to externally dispatchable production paths and preserved the non-dispatchable test helper. |
| Claude L2 — topology recomputation attribution | LOW | Accepted. Named `verifyAcceptanceBasisReceipt` as the current-path binding step before structural topology evaluation. |
| agy F1 — missing direct/planner artifact argument | HIGH | Accepted. Added explicit `mechanismReviewArtifactId`, exact artifact resolution, and `candidateId`/`taskDigest` matching; recency lookup is forbidden. |
| agy F2 — ambiguous hash concatenation | MEDIUM | Accepted. Replaced concatenation with typed canonical JSON, stable sort, explicit nulls, and included `gitBlobHash`. |
| agy F3 — undefined task digest and identity fields | MEDIUM | Accepted. Defined task envelope/digest and producer provenance; reconciled identity handling with Claude H1 so provenance fields are not misused as independence proof. |

After these revisions, both hosts ran focused confirmation audits over the
updated full document:

- Claude CLI: `CONFIRMED_PASS`; the H1 same-host identity overclaim is closed,
  the signed-run/fresh-context/behavior-contract assurance boundary is
  consistent across normative text and tests, and no new BLOCKER/HIGH was
  introduced.
- Antigravity CLI (`agy`): `CONFIRMED_PASS`; explicit artifact input,
  `candidateId`/`taskDigest` exact matching, recency-lookup prohibition, and
  pre-`nextStoryId` failure are consistent across all four creation paths, and
  no new BLOCKER/HIGH was introduced.

Final audited status: **no unresolved BLOCKER or HIGH architecture finding**.

### 21.5 Canonical `host_run` provenance

The prose above records the architecture findings and their dispositions. The
following canonical Proof-or-Stop usage-ledger rows are the authoritative local
evidence that the two external audit hosts were actually invoked for this
Story. These rows are diagnostic execution provenance (`gateEvidence=false`),
not verified external authority or production-release proof.

| Host | Final record | Recorded usage | Audit result |
|---|---|---|---|
| Claude CLI | `llmuse_e67c2062-1063-4c7e-bf33-9cef6fe90b81` | `source=provider-reported`; input `6`, output `1655`, cache creation `47054`, cache read `160377` | Completed under `agentType=lattice-audit-mechanism-placement`; no unresolved BLOCKER/HIGH. |
| Antigravity CLI (`agy`) | `llmuse_681319b0-4a0d-4f17-9ba4-a5862e38e23f` | `source=unavailable`; `unavailableReason=agy_print_mode_reports_no_usage`; no numeric count is asserted | Completed the single permitted focused replacement and emitted `AGY_HOST_AUDIT_CONFIRMED`. |

Both final rows are bound to `storyId=B-c648`, `phase=DEV`, and distinct
`ledgerCallId` values. Each is a sequence-2 final row that supersedes its own
sequence-1 prompt-size estimate. The earlier agy call represented by preflight
row `llmuse_d68b8791-13dc-4be8-b5d6-cfec9c57a1dc` was authoritatively aborted
after 300 seconds without output and has no final row; it is retained as failed
attempt provenance and is not cited as a successful audit.

Delivery verification must resolve the two exact final record IDs in
`.lattice/usage/llm-usage.jsonl`, check their Story/phase/agent/host bindings,
and compare the recorded usage states above. A grep that only finds this prose
is insufficient. In particular, agy's unavailable state must remain explicit:
inventing token counts would turn an honest provider limitation into false
evidence.
