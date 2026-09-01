# Proof-or-Stop Evidence Environment Adapter — Architecture Audit and Execution Plan

Status: implemented reference contract in Story B-955c; architecture proposal previously passed round-5 independent Claude CLI and agy CLI review
Date: 2026-07-19  
Audit trail: draft → Claude CLI R1 `APPROVE-WITH-CHANGES` + agy CLI R1 `REJECTED / Needs Revision` → R2 agy CLI `PASS` + Claude CLI `APPROVE-WITH-CHANGES` → R3 agy CLI `PASS` + Claude CLI `CONDITIONAL PASS` → R4 both `CONDITIONAL/PARTIAL` → R5 Claude CLI `PASS` + agy CLI `PASS` with no required edits  
Scope: formalize the host-neutral evidence-production boundary, define a generic adapter contract, prove reference-path substitutability, and calibrate the paper claim

## 1. Decision summary

Proof-or-Stop should introduce **Evidence Environment** as the architecture-level
name for the bounded system that executes a check, observes state, or reads an
external receipt. The implementation interface should be named **Evidence
Environment Adapter (EEA)**.

The first formal use may spell out the branded form:

> Proof-or-Stop Evidence Environment Adapter Contract

After that, the paper and code should use `Evidence Environment`,
`EvidenceEnvironmentAdapter`, or `EEA`. The generic interface should **not** be
called `Proof-or-Stop Adapter`.

This is not a new evidence store, proof manager, lifecycle gate, scientific truth
engine, or arbitrary command runner. It makes an existing architectural boundary
explicit:

```text
Agent proposes
  → Gate policy specifies required evidence
  → Evidence Environment executes, observes, or reads a receipt
  → Evidence Platform binds and stores the observation
  → Proof Admissibility evaluates permitted meaning
  → Task / Story / Release Gate decides
```

The theoretical contribution is not the software Adapter pattern. It is a
host-neutral evidence-production and observation boundary with:

1. identity-bound receipts;
2. authority separation;
3. semantic confinement;
4. host-substitution invariance;
5. fail-closed admissibility.

### 1.1 Implemented support boundary (B-955c)

The repository now implements the generic contract in
`packages/main/src/core/evidence/environment-contract.ts` and exposes a
conformance command:

```bash
npm --prefix packages/main run test:evidence-environment-adapter
```

Implemented now:

| Capability | Support | Evidence |
|---|---|---|
| Versioned descriptor, invocation, receipt, normalized envelope, canonical digests, and read-only registry | Implemented | `environment-contract.ts`; conformance smoke |
| Code-runtime reference path | Implemented as a projection of existing policy-authorized DONE-required/routine-validation identities and receipts | `projectDoneRequiredReceiptToEnvironment`; no new process launcher or public command endpoint |
| Quantum reference path | Implemented as read-receipt-only projection after the existing Quantum normalizer accepts the receipt | `projectQuantumReceiptToEnvironment`; Quantum smoke |
| Proof Admissibility / Gate projection | Implemented in the existing DONE_REQUIRED lifecycle consumer; raw invocation/receipt input is revalidated before the shared proof-surface evaluator runs | `evaluateDoneRequiredEvidence` → `validateDoneRequiredEvidenceEnvironmentProjection` → `evaluateEvidenceEnvironmentGateProjection`; DONE-required smoke |
| Windows implicit-shell identity | Implemented for the DONE-required path: actual `shell:true` is recorded, target executable identity remains separate, and `ComSpec`/`cmd.exe` content identity is bound as `shellExecutableDigest` by the shared producer/consumer constructor | DONE-required platform-injected regression; validation-evidence-reuse smoke |
| Compound shell identity | Implemented conditionally: exact command/args/cwd/policy are bound by the CommandSpec digest and the actual shell executable is mandatory; target `executableDigest` may be `null` only when `shell:true` has no single resolvable target executable | DONE-required full-evaluator compound-shell positive and tampered-shell regressions |
| Host-substitution invariant | Mechanically covered for policy-equivalent normalized inputs | EEA conformance smoke |
| Producer independence | **Unsupported / fail-closed.** Receipts may reserve an opaque attestation reference, but the implementation exposes no injectable resolver and has no project-owned pinned-key/revocation registry. Distinct-host quorum always returns `distinct_host_quorum_unsupported`; repeated references additionally return `same_producer_not_independent` | EEA conformance smoke |

This implementation does **not** add an arbitrary runner, a second evidence
store, an adapter-owned lifecycle transition, production authority, or a generic
third-party execution service. The code-runtime path projects receipts already
produced by configured validation policy; the Quantum path never executes a
solver.

Integration targets—not current adapters—remain Lean, Rosetta, AlphaFold, PINN
solvers, browsers, databases, CI systems, Kubernetes, and production deployment
environments.

## 2. Why this abstraction matters

The current software-focused statement is:

> Proof-or-Stop gates lifecycle claims made during autonomous software
> development.

The generalized statement is:

> Proof-or-Stop controls progression of claims whose evidence is produced by
> heterogeneous execution or observation environments, while preserving
> identity, admissibility, authority, and lifecycle boundaries.

This creates three distinct portability claims:

| Property | Question answered | Current maturity |
|---|---|---|
| Host-neutral | Does switching Claude, Codex, or another execution host change core Gate semantics? | Implemented architecture and host-facing paths; provider-execution breadth and cross-vendor quorum remain bounded, as stated in `README.md` and `docs/requirements/decisions/host-overflow.md` |
| Environment-neutral | Can compiler, formal checker, browser, solver, CI, database, or deployment observation enter through one evidence protocol? | Generic contract and two bounded reference projections are implemented; named third-party environments remain integration targets |
| Domain-portable | Can software, mathematics, PINN, quantum, or biology define domain-specific claims and evidence requirements? | Pack framework exists; the code-runtime Pack is a declarative reference to the mature existing runtime, Quantum is local/read-only, and PINN is primarily a design contract |

Evidence Environment fills the second row. It connects the existing host-neutral
runtime and cross-domain Pack framework without merging their responsibilities.

## 3. Repository evidence audit

The proposal is grounded in existing mechanisms rather than a new parallel
architecture.

| Repository fact | Evidence | Consequence |
|---|---|---|
| Proof-or-Stop already claims host-neutral Gate semantics | `README.md`, “Where it fits”: host identity affects provenance and independence, not Gate semantics | Evidence Environment extends an existing neutrality claim |
| Evidence-looking data must pass through the shared Evidence Platform | `docs/evidence/evidence-platform-architecture.md`, “Architecture Rule” and “Ownership Boundary” | EEA must not create storage or a parallel artifact registry |
| External proof surfaces already resolve through verifier adapter identity | `ExternalSurfaceDefinition.verifierAdapterId` in the Evidence Platform architecture | EEA can refine this extension point rather than replace it |
| Claim-admissibility Packs already declare schemas, verifier adapters, Gate policies, and benchmarks | `docs/requirements/decisions/claim-admissibility-adapter-pack-framework.md` and `packages/main/src/core/claim-admissibility/pack-framework.ts` | Domain semantics remain Pack-owned |
| Adapter execution boundaries already distinguish declaration, receipt reading, and local command contracts | `ClaimAdmissibilityAdapterExecutionBoundary` in `pack-framework.ts` | EEA generalizes an existing boundary vocabulary |
| Existing command identity has two relevant surfaces: the current DONE-required `lattice.command-spec.v2` binds command, args, repo-relative logical cwd, actual shell mode, declared environment overlay, and timeout while recording absolute `resolvedCwd` as non-digested provenance; legacy `lattice.command-spec.v1`, whose digest bound an absolute cwd, remains accepted only for pre-existing receipts. Routine-validation identity additionally binds `effectiveEnvironmentDigest`, target `executableDigest`, and conditional actual `shellExecutableDigest`. Windows implicit-shell execution is recorded as `shell:true` and binds `ComSpec`/`cmd.exe` content identity | `packages/main/src/core/done-required-validation.ts`, `validation-evidence-reuse.ts`, `validation-command-environment.ts`, and `validation-executor.ts` | The local-command reference path reuses the existing effective-environment and executable identity scheme; the v2 logical/physical cwd split preserves cross-worktree portability without discarding execution provenance, while richer shell version/login/init posture remains future work |
| Quantum adapters are currently `read-receipt-only` | `packages/main/src/core/claim-admissibility/quantum.ts` | A non-executing scientific reference path already exists |
| Generic command-backed domain verifier execution and generic Pack Gate integration remain pending | Claim-admissibility Pack framework M3 command-backed execution and M4 generic Gate integration | The paper must not describe all domain integrations as implemented |

### 3.1 Current support statement

The following statement is supported now:

> Proof-or-Stop is host-neutral by design and already contains the Evidence
> Platform, proof-admissibility, verifier-descriptor, receipt, and Domain Pack
> primitives from which an Evidence Environment contract can be factored.

The following statement is not yet supported:

> Proof-or-Stop currently executes arbitrary Lean, Rosetta, AlphaFold, PINN,
> browser, database, CI, and Kubernetes environments through one completed
> adapter runtime.

## 4. Naming audit

### 4.1 Evaluation criteria

A suitable name must:

- foreground evidence rather than tool execution;
- cover execution, observation, and receipt-reading modes;
- avoid claiming scientific or mathematical truth;
- remain host- and domain-neutral;
- distinguish the architecture layer from individual adapters;
- fit existing Proof-or-Stop terms: Evidence Platform, Proof Admissibility,
  Gate, Host Adapter, Domain Pack, and Verifier Adapter.

### 4.2 Candidate comparison

| Candidate | Strengths | Problems | Recommendation |
|---|---|---|---|
| **Evidence Environment** | Names the architecture boundary; covers execution and observation; domain-neutral | “Environment” alone could be confused with process environment unless defined | **Use for the architecture layer** |
| **Evidence Environment Adapter** | Describes the extension interface precisely; preserves the Evidence Environment concept | Slightly long | **Use for the adapter contract and implementations** |
| **Proof-or-Stop Evidence Environment Adapter Contract** | Branded and precise on first formal use | Too long for repeated code/prose use | **Use once, then shorten to EEA** |
| **Proof-or-Stop Adapter** | Short and branded | Vague; sounds like an IDE/plugin integration; does not say what is adapted; collides conceptually with Host Adapter and Domain Pack | **Reject** |
| **Proof Adapter** | Short | Overclaims that the adapter produces proof; unsafe for simulations and model outputs | **Reject** |
| **Verifier Adapter** | Already exists; clear for checkers | Too narrow for state observers, isolation providers, orchestrators, and receipt-only sources | **Retain as an EEA role/subtype** |
| **Evidence Producer Adapter** | Emphasizes evidence production | “Producer” poorly fits read-only observers and external receipt normalization | Do not use as the umbrella |
| **Claim Evidence Adapter** | Preserves claim binding | Omits the execution/observation environment and environment identity | Possible internal subtype, not the architecture name |
| **Verification Environment Adapter** | Familiar terminology | “Verification” can imply truth or correctness beyond admissibility | Avoid as the umbrella |

### 4.3 Normative terminology

| Term | Normative meaning |
|---|---|
| Evidence Environment | A bounded execution or observation context capable of producing an identity-bound receipt |
| Evidence Environment Adapter | A host-neutral contract that invokes, observes, or normalizes one Evidence Environment |
| Host Adapter | Connects Proof-or-Stop to an agent/runtime host such as Codex or Claude Code |
| Verifier Adapter | An EEA role that runs or reads a checker and normalizes its result |
| Domain Pack | Defines domain claims, evidence schemas, verifier mappings, and stricter Gate policy |
| Evidence Platform | Owns envelope, digest, subject binding, storage, and shared proof-surface definitions |
| Proof Admissibility | Determines which claims and consumers may use an Evidence Envelope |
| Gate | Owns progression decisions; no adapter may advance lifecycle state directly |

`Evidence Environment` is not a synonym for a process environment or an
environment-variable map. When both meanings appear in one schema, process-level
fields must use an explicit `processEnvironment*` prefix.

The distinction is:

```text
Host Adapter: who performs bounded work
Evidence Environment Adapter (EEA): where/how an observation is obtained
Domain Pack: what the observation is allowed to mean
Gate: whether progression is allowed
```

## 5. Formal model

Let:

- `C` be a claim;
- `S` be the subject binding;
- `D` be an Evidence Environment descriptor;
- `I` be an invocation request;
- `R` be a raw environment receipt;
- `N(D, I, R)` be deterministic normalization;
- `E*` be the set of Evidence Envelopes presented for the claim;
- `P` be an admissibility policy;
- `A(C, E*, P)` be the admissibility decision over one or more envelopes;
- `G(C, A, L)` be a lifecycle Gate decision under lifecycle state `L`.

The control path is:

```text
I = request(C, S, D, policy)
R = invoke | observe | readReceipt(D, I)
E = N(D, I, R)
E* = collect(E1 ... En)
A = admissibility(C, E*, P)
decision = G(C, A, L)
```

`R` is an observation, not truth. Each `E` is an identity-bound evidence object,
not automatic proof. `E*` permits policies such as quorum, repeated stochastic
runs, or multi-observer corroboration without pretending that a single envelope
proves them. Only `A` may assign permitted claim meaning, and only `G` may change
progression.

## 6. Required invariants

### I1. Identity binding

Every Gate-consumable result must bind:

- subject identity;
- environment identity and version;
- adapter identity and version;
- invocation or command identity;
- input and output digests;
- applicable policy/tolerance identity;
- temporal/freshness identity;
- producer and trust boundary.

An identity field may be domain-specific, but it may not be silently omitted
when the active claim policy requires it.

When a policy requires producer independence, a distinct Host, or an externally
attested source, producer identity must be bound to a trusted key, signed
session, legacy/external Authority-derived identity, or equivalent verifier-owned
attestation.
Caller-supplied `hostId`, provider, session, key, or trust strings are provenance
claims only and cannot satisfy an independence policy. Missing or unverifiable
producer attestation fails closed. The current implementation has no trusted
producer registry and therefore treats every distinct-Host quorum request as
unsupported; an arbitrary callback is never accepted as a verifier-owned trust
root.

### I2. Authority separation

An EEA may:

- execute a bounded request;
- observe bounded state;
- read and normalize an external receipt;
- return structured errors and diagnostics.

An EEA must not:

- mark a Story, Release, or project Done;
- weaken lifecycle Gates;
- create production authority;
- convert caller-written metadata into admissible evidence;
- decide its own admissibility.

### I3. Semantic confinement

Evidence may satisfy only claims and consumers explicitly registered by the
shared proof-surface and admissibility policy. For example:

- compiler success does not imply behavioral correctness;
- a PINN residual receipt does not imply boundary-condition or full-domain
  correctness;
- an AlphaFold-like model output would not imply experimental validation;
- a deployment smoke receipt does not imply long-term production health.

### I4. Host-substitution invariance

For two hosts `H1` and `H2`, when:

- the claim, subject, environment, invocation, inputs, policy, trust class, and
  freshness semantics are equivalent;
- normalization yields semantically equivalent Evidence Envelopes;
- no active policy requires host independence or a distinct provenance class;

then the Gate verdict must not differ merely because the provider label is
`H1` rather than `H2`.

Formally:

```text
equivalentPolicyInputDigest(E1, E2)
∧ noDistinctHostRequirement(P)
⇒ G(C, A(C, {E1}, P), L) = G(C, A(C, {E2}, P), L)
```

`equivalentPolicyInputDigest` is a canonical digest equality over the enumerated
Gate-relevant fields: claim, subject binding, environment and adapter identity,
invocation identity, input and output identity, policy, verifier,
tolerance/repeat protocol, temporal role, freshness, and trust class. Provider
brand is excluded unless the active policy explicitly declares a provider,
distinct-Host, key, session, or independence requirement. Implementations may
not redefine equivalence ad hoc after observing a verdict.

This does not erase provenance. A quorum or independence policy may legitimately
require distinct hosts, keys, sessions, or providers. The invariant prevents
brand-specific Gate semantics when the policy does not require that distinction.
Where independence is required, every claimed distinct producer must carry
verifier-owned identity attestation as required by I1.

### I5. Environment-bound observation

The environment used to compute invocation identity must be the environment
actually used to execute or observe. A descriptor that hashes one environment
but launches another is invalid.

For the implemented command-backed path, identity includes the effective process
environment, actual shell mode, target executable content digest, and—when a
shell is used—the resolved shell executable content digest. It does not bind
shell version metadata, login/init-file posture, or launch switches. Local
execution should prefer `shell:false`. Richer shell posture is a future
versioned-schema target, not evidence supplied by the current receipt.

### I6. Fail closed

Unknown adapter versions, unsupported receipt schemas, missing identity,
subject mismatch, stale evidence, unsafe invocation, checker error, timeout,
signature failure, or unverifiable external receipt must never become an
admissible PASS.

`execute-remote`, `external-attested`, and policy-required remote receipts must
carry a cryptographically verified signature or equivalent trusted attestation.
For those classes, an absent signature is a verification failure, not an
optional omission.

## 7. Architecture boundary

```text
┌──────────────────────────────────────────────────────────────────┐
│ Agent / Orchestrator                                             │
│ proposes claim; requests work; repairs on failure                │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                v
┌──────────────────────────────────────────────────────────────────┐
│ Gate Policy / Domain Pack                                        │
│ declares required evidence, claim schema, identity, tolerance    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Invocation Request
                                v
┌──────────────────────────────────────────────────────────────────┐
│ Evidence Environment Adapter                                     │
│ execute-local | execute-remote | observe-state | read-receipt    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Environment Receipt
                                v
┌──────────────────────────────────────────────────────────────────┐
│ Evidence Platform                                                │
│ strict shape, normalize, bind, digest, store, retrieve            │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Evidence Envelope
                                v
┌──────────────────────────────────────────────────────────────────┐
│ Proof Admissibility                                              │
│ scope, producer, identity, freshness, permitted claim/consumer   │
└───────────────────────────────┬──────────────────────────────────┘
                                │ admissible / inadmissible
                                v
┌──────────────────────────────────────────────────────────────────┐
│ Task Gate | Story Gate | Release Gate                            │
│ advance | repair | degrade | escalate | stop                     │
└──────────────────────────────────────────────────────────────────┘
```

### 7.1 Environment roles

One Environment may declare more than one role, but roles remain explicit:

| Role | Examples | Responsibility |
|---|---|---|
| executor | compiler, Lean, test runner, PDE solver | Runs a bounded workload |
| observer | Git, filesystem, browser state, monitoring | Reads bounded state |
| receipt-reader | external CI, scientific run archive, legacy/external Authority service | Verifies and normalizes an externally produced receipt |
| orchestrator | CI, GitHub, Kubernetes | Schedules work and exposes execution state |
| isolation-provider | Docker, sandbox, restricted runner | Constrains filesystem, network, process, or resource access |
| stateful-target | database, browser session, deployed service | Supplies mutable state that must be temporally bound |

The generic contract standardizes identity and receipts. It does not pretend
that all roles share one universal `run()` implementation.

## 8. Proposed contract

The exact TypeScript layout may change after implementation review. These fields
are semantic requirements.

The sketches reuse `SubjectBinding` from
`packages/main/src/core/evidence/types.ts` and `ProofProducerBoundary` from
`packages/main/src/core/proof-admissibility.ts`. New schemas deliberately use the
`proof-or-stop.*` namespace; existing compatibility `lattice.*` schemas remain versioned
compatibility inputs and are not silently renamed.

```ts
type EvidenceEnvironmentRole =
  | 'executor'
  | 'observer'
  | 'receipt-reader'
  | 'orchestrator'
  | 'isolation-provider'
  | 'stateful-target';

type EvidenceEnvironmentExecutionBoundary =
  | 'declarative-only'
  | 'execute-local'
  | 'execute-remote'
  | 'observe-state'
  | 'read-receipt-only';

type EvidenceEnvironmentTrustClass =
  | 'caller-untrusted'
  | 'local-runtime'
  | 'local-key-single-host'
  | 'trusted-reviewer'
  | 'external-attested';

interface EvidenceEnvironmentDescriptor {
  id: string;
  version: string;
  domain: string;
  roles: EvidenceEnvironmentRole[];
  executionBoundary: EvidenceEnvironmentExecutionBoundary;
  trustClass: EvidenceEnvironmentTrustClass;
  reproducibilityClass:
    | 'deterministic'
    | 'seeded-stochastic'
    | 'statistical'
    | 'stateful-temporal'
    | 'external-attested';
  supportedInvocationVersions: string[];
  supportedReceiptVersions: string[];
  capabilities: string[];
  isolationPolicy?: {
    filesystem: string;
    network: string;
    secrets: string;
    resources: string;
  };
}
```

```ts
interface EvidenceEnvironmentCommandSpecBase {
  command: string;
  args: string[];
  cwd: string;
  processEnvironmentOverlay: Record<string, string>;
  processEnvironmentDigest: string;
  timeoutMs: number;
}

type EvidenceEnvironmentCommandSpec =
  | (EvidenceEnvironmentCommandSpecBase & {
      shell: false;
      executableDigest: string;
      shellExecutableDigest?: never;
    })
  | (EvidenceEnvironmentCommandSpecBase & {
      shell: true;
      executableDigest: string | null;
      shellExecutableDigest: string;
    });

interface EvidenceEnvironmentInvocationRequest {
  schema: 'proof-or-stop.evidence-environment-invocation.v1';
  invocationId: string;
  claimId: string;
  subjectBinding: SubjectBinding;
  environmentId: string;
  environmentVersion: string;
  adapterId: string;
  adapterVersion: string;
  inputDigests: string[];
  commandSpec?: EvidenceEnvironmentCommandSpec;
  policyDigest: string;
  tolerancePolicyDigest?: string;
  seed?: string;
  repeatProtocol?: {
    runs: number;
    aggregation: string;
  };
  requestedEvidenceKinds: string[];
  invocationDigest: string;
}
```

```ts
interface EvidenceEnvironmentReceipt {
  schema: 'proof-or-stop.evidence-environment-receipt.v1';
  receiptId: string;
  invocationDigest: string;
  environmentId: string;
  environmentVersion: string;
  adapterId: string;
  adapterVersion: string;
  subjectBinding: SubjectBinding;
  startedAt: string;
  finishedAt: string;
  status: 'pass' | 'fail' | 'error' | 'timeout' | 'unavailable';
  outputDigests: string[];
  artifactRefs: string[];
  observation: unknown;
  producerBoundary: ProofProducerBoundary;
  trustClass: EvidenceEnvironmentTrustClass;
  signatureRef?: string;
  producerAttestationRef?: string;
  isolationAttestation?: unknown;
  redactions?: string[];
}
```

The schema keeps the current command vocabulary (`command`, `args`, `cwd`,
`shell`, `timeoutMs`) so that the existing command-spec contract can be adapted
rather than silently replaced. `processEnvironmentOverlay` is the non-secret
configured overlay required for reproducibility. `processEnvironmentDigest`
binds the effective environment actually supplied to execution without
persisting ambient secret values in the public envelope. `shellExecutableDigest`
is forbidden when `shell:false` and required when `shell:true`. Secret-bearing
identity requires a
policy-approved redacted or keyed-digest scheme; raw secrets must not be stored
in receipts.

`executableDigest` reuses the existing routine-validation meaning. Direct
execution (`shell:false`) requires a non-null resolved target-executable content
digest. Shell execution (`shell:true`) requires the actual
`shellExecutableDigest`; its target `executableDigest` is included when one
executable resolves, but may be `null` for a compound command with no single
target executable. In that case the exact command text, args, cwd, shell mode,
environment overlay, timeout, and policy remain bound by the CommandSpec and
invocation digests.

The implemented `shellExecutableDigest` proves only resolved shell executable
content identity. It does **not** prove shell implementation/version metadata,
login/non-login launch mode, command-line switches, or init-file policy.
Those richer posture bindings require a future versioned schema. Before
constructing the current command spec, the adapter resolves the **actual**
execution mode. Thus Windows implicit-shell execution is represented as
`shell:true` with a required `ComSpec`/`cmd.exe` executable digest even when the
original configuration requested `shell:false`.

`ProofProducerBoundary` is reused from the shared Proof Admissibility registry.
`EvidenceEnvironmentTrustClass` is a closed, registry-owned baseline enum; a
future extension requires a versioned registry change and policy mapping. A Pack
or receipt cannot create a new trust class with a caller-chosen string.

### 8.1 Security rule

The first version must not expose a generic arbitrary-shell EEA. Local execution
must reuse an existing allowlisted command executor and its exact
command/environment identity. Remote execution must use an explicit host policy
or a separately configured legacy/external Authority trust policy. Receipt-only
adapters must have no execution capability.

Pack-declared command specs are inert declarations until an independently
configured execution policy authorizes the adapter, executable, arguments,
working directory, filesystem, network, environment, secrets, resource limits,
and timeout. Loading a Pack must never grant command-execution authority.

For `external-attested` and `execute-remote`, normalization requires a verified
`signatureRef` or `producerAttestationRef` whose signer is authorized by the
active policy. Local runtime-owned evidence may use a different explicit trust
policy; the absence of a remote attestation can never silently downgrade into a
local trusted receipt.

### 8.2 Caching rule

Cache reuse is admissible only when the cache key binds all Gate-relevant
identity:

```text
subject + inputs + environment + adapter + invocation + policy
+ verifier + tolerance/repeat protocol + temporal role
```

`stateful-temporal` observations, deployment validation, monitoring, and
unseeded/statistically unspecified runs are non-cacheable by default.

## 9. Relationship to existing adapters

The new abstraction should refine existing terms rather than rename everything.

```text
EvidenceEnvironmentAdapter
├── VerifierAdapter
│   ├── local-command verifier
│   └── read-receipt verifier
├── StateObserverAdapter
├── RemoteReceiptAdapter
└── IsolationAttestationAdapter
```

`ClaimAdmissibilityPack.verifierAdapters` may initially reference an
`environmentDescriptorId` and reuse its current execution boundary. A later
contract version may expose additional observer adapter lists if a real consumer
requires them. Do not add speculative lists before a reference path exists.

### 9.1 Existing-to-EEA execution-boundary mapping

The existing Pack boundary remains accepted during migration:

| Existing `ClaimAdmissibilityAdapterExecutionBoundary` | EEA boundary | Migration rule |
|---|---|---|
| `declarative-only` | `declarative-only` | Exact semantic match |
| `read-receipt-only` | `read-receipt-only` | Exact semantic match |
| `local-command-contract` | `execute-local` | Mapping only; it grants no execution authority |

`execute-remote` and `observe-state` are new EEA-only capabilities. M1 must
provide one canonical resolver for this mapping. Gate consumers must not branch
independently on both vocabularies, and the legacy name may be removed only in a
versioned compatibility migration.

### 9.2 Existing command-spec to EEA mapping

The current DONE-required envelope is `lattice.command-spec.v2`. It digests a
repo-relative logical `cwd` so the same command identity is portable across
worktrees and hosts, and records the absolute physical `resolvedCwd` separately
as non-digested provenance. `lattice.command-spec.v1`, whose digest included an
absolute cwd, remains accepted only as a legacy compatibility input. Neither
version is byte-identical to the EEA invocation command spec.

| Existing command identity surface | EEA command spec | Rule |
|---|---|---|
| DONE-required `command` | `command` | Exact |
| DONE-required `args` | `args` | Exact ordered array |
| DONE-required v2 logical `cwd` | `cwd` | Map the repo-relative logical cwd through the EEA canonical resolver; do not substitute the physical worktree path |
| DONE-required v2 `resolvedCwd` | receipt provenance only | Preserve as observed absolute execution provenance; exclude it from the DONE-required command-spec digest and do not promote it into portable EEA command identity |
| Legacy DONE-required v1 absolute `cwd` | `cwd` | Accept only when verifying a pre-existing v1 receipt, then map through the compatibility resolver; never emit v1 for new evidence |
| DONE-required `env` | `processEnvironmentOverlay` | Rename the declared non-secret overlay |
| routine-validation `effectiveEnvironmentDigest` | `processEnvironmentDigest` | Reuse or versionedly reconcile the existing effective-environment canonicalization; do not introduce an unrelated third digest |
| routine-validation `executableDigest` | `executableDigest` | Required and non-null for `shell:false`; for `shell:true`, include when one target resolves and allow `null` only when the command has no single target executable |
| DONE-required/routine declared `shell` | `shell` | Resolve from actual execution, not configuration alone |
| routine-validation `shellExecutableDigest` | `shellExecutableDigest` | Required when actual `shell:true`; forbidden otherwise; resolved shell executable content only |
| DONE-required `timeoutMs` | `timeoutMs` | Exact |

M2 must implement one versioned canonical resolver and must not reuse either
the current `lattice.command-spec.v2` digest or the legacy
`lattice.command-spec.v1` digest as an EEA invocation digest. For effective
environment identity it must either reuse the existing
`validationIdentityDigest(effectiveValidationCommandEnvironment(...))` semantics
from routine-validation identity or declare a new versioned digest domain plus
cross-contract reconciliation tests. The EEA invocation digest includes that
effective process-environment digest plus conditional actual-shell identity.
During compatibility evaluation, the original DONE-required envelope, the
routine-validation identity, and the derived EEA mapping remain independently
verifiable; callers cannot submit only the derived fields and claim that either
legacy identity verification passed.

The Windows identity gap is closed for the DONE-required reference path:
`validation-executor.ts` records the actual implicit `shell:true` result,
and the shared routine/DONE identity constructor resolves and hashes
`ComSpec`/`cmd.exe`. Producer and consumer use the same constructor. A
platform-injected regression with a synthetic `cmd.exe` proves stable
environment, shell-mode, and executable identity without requiring a Windows
test host.

## 10. Executable implementation plan

### M0 — Terminology and ownership freeze

Deliverables:

- adopt the terminology table in section 4.3;
- add an “Evidence production boundary” section to
  `docs/evidence/evidence-platform-architecture.md`;
- cross-reference this decision from the Claim-Admissibility Pack framework;
- preserve Evidence Platform as the only artifact/proof-surface definition and
  storage owner.

Acceptance:

- no document claims that EEA owns storage, admissibility, Gate decisions, or
  production authority;
- Host Adapter, Domain Pack, Verifier Adapter, and EEA are not used as synonyms;
- the current/future support matrix is explicit.

### M1 — Descriptor and registry projection

Candidate implementation:

- add `packages/main/src/core/evidence/environment-contract.ts`;
- define descriptor, role, execution-boundary, reproducibility, trust, and
  isolation types;
- expose a read-only Environment descriptor registry or a read-only projection
  from the existing Pack registry;
- add `environmentDescriptorId` to verifier adapter descriptors without
  duplicating proof surfaces or evidence storage;
- define the canonical legacy-boundary resolver from section 9.1;
- restrict descriptor registration to built-in core definitions or
  source-verified installed Packs accepted by project policy.

Registration and provenance rules:

- caller-writable runtime metadata cannot register a descriptor;
- a Pack cannot raise its own trust, Authority, completion, or execution class;
- descriptor source, Pack id/version, contract version, and registration policy
  digest are retained as provenance;
- producer and trust fields resolve through registry-owned
  `ProofProducerBoundary` and `EvidenceEnvironmentTrustClass` values rather than
  free-form receipt strings;
- registration authority and execution authority remain separate;
- an untrusted Pack may be listed diagnostically without becoming executable or
  admissible.

Fail-closed validation:

- duplicate environment or adapter ids;
- unknown descriptor references;
- unsupported contract versions;
- incompatible role/execution-boundary combinations;
- unauthorized descriptor source or trust escalation;
- `read-receipt-only` descriptors containing command execution capability;
- missing trust or reproducibility class.

Acceptance:

- default registry validates deterministically;
- unknown and duplicate entries are blocking;
- existing code-runtime and Quantum Pack behavior remains backward compatible;
- no lifecycle mutation API is exposed.

### M2 — Invocation identity and receipt normalization

Candidate implementation:

- canonical digest over Gate-consumed invocation fields;
- strict receipt schema and deterministic normalization;
- subject/environment/adapter/invocation/policy binding checks;
- structured reason codes for missing, stale, mismatched, unsafe, unsupported,
  checker-error, timeout, temporal-window conflict, and unverifiable cases;
- normalized output compatible with the existing Evidence Platform and Proof
  Admissibility service.

Acceptance:

- the environment used for identity is the environment used by execution;
- command-backed execution reuses or versionedly reconciles the existing
  resolved-executable content digest and rejects executable drift when policy
  requires executable identity;
- receipt status `error`, `timeout`, or `unavailable` can never normalize to an
  admissible PASS;
- caller-written completion flags are rejected or ignored as non-authoritative;
- normalized receipts do not mutate lifecycle state;
- repeated normalization of byte-identical descriptor, invocation, and receipt
  inputs yields the same semantic output and digest;
- stateful observations bind an observation window and reject conflicting or
  expired windows under the active policy;
- remote and externally attested receipts reject missing, unknown, revoked, or
  invalid producer attestations;
- a future project-owned pinned-producer registry, or a separately
  configured legacy/external Authority trust service, owns signer authorization,
  public-key binding, session binding, and revocation state; the adapter may
  verify against that source but cannot write or elevate it. The M2 registry
  reuses the existing canonical Ed25519 signing/verification primitives in
  `authority-signing.ts` and the strict shape/public-key binding lessons in
  `receipt-bundle.ts`; it is a new trust-policy registry, not a claim that either
  existing module already provides producer authorization or revocation.

This pinned-producer registry is **not implemented in B-955c**. Consequently
the public contract does not accept a caller-supplied resolver and distinct-host
quorum is fail-closed unsupported.

The existing `ActorTrustRegistry` remains the evidence-quality registry for
logical actor ids and revoked actor-id strings. It is not sufficient for
distinct-Host or independence claims because caller-visible actor ids are not
cryptographic key/session attestations. M2 may reuse its advisory/revocation
projection, but the pinned-producer registry is a separate verifier-owned
key/session authorization layer. One canonical projection must prevent the two
registries from disagreeing silently: an actor revoked by either applicable
registry is inadmissible under a policy that consumes that identity.

### M3 — Two orthogonal reference paths

#### M3a. Code-runtime local-command path

Reuse only the existing DONE-required/validation executor and command-identity
logic:

- command;
- args;
- cwd;
- shell mode;
- exact effective environment;
- timeout;
- policy and subject bindings.

Do not create a second process launcher. Do not reuse the legacy
`StoryStore.writeDoneRequiredEvidence` path as EEA storage. The reference adapter
must return a normalized receipt through the shared Evidence Platform API;
existing lifecycle evidence may continue its current compatibility path until a
separately approved migration. Reusing an executor does not authorize a parallel
evidence store.

The reference path must also bind shell mode and shell identity. It must test
both the preferred `shell:false` path and any supported `shell:true` path against
the environment-bound observation invariant. It must close the known Windows
implicit-shell gap described in section 9.2 rather than copying the configured
shell flag into the EEA receipt.

#### M3b. Quantum read-receipt-only path

The Quantum `read-receipt-only` verifier descriptors already exist. M3b binds
those existing descriptors to the new Evidence Environment contract and proves
that the shared normalization rules preserve their current boundary. It does
not claim to implement or execute a Quantum solver.

The bound descriptor:

- declares `read-receipt-only`;
- contains no command spec;
- normalizes only supported receipt versions;
- preserves local-diagnostic, non-authority, non-production semantics.

Acceptance:

- one common contract represents both paths;
- the local-command path cannot masquerade as receipt-only;
- the receipt-only path cannot execute;
- both paths yield Evidence Platform-compatible normalized output;
- neither adapter can directly advance a Gate.

### M4 — Conformance and host-substitution suite

Add a focused smoke, for example:

```text
packages/main/src/tasks/evidence-environment-adapter-smoke.ts
```

Required positive cases:

- default descriptor registry validates;
- code-runtime invocation and receipt bind successfully;
- Quantum read-only receipt binds successfully;
- byte-identical inputs normalize deterministically across repeated runs;
- equivalent normalized receipts from two host labels produce the same
  admissibility projection when no independence policy is active.

M4 proves normalization and admissibility-level substitution. Gate-level
substitution is intentionally deferred until M5 has connected the generic
contract to an actual lifecycle consumer.

Required negative cases:

- unknown environment id/version;
- unknown adapter id/version;
- duplicate ids;
- subject mismatch;
- invocation digest mismatch;
- command/environment identity mismatch;
- executable drift with the same command string but different resolved binary
  content;
- policy/tolerance mismatch;
- stale receipt;
- unsupported receipt schema;
- checker error, timeout, or unavailable environment;
- missing required signature/attestation;
- forged host/provider labels without producer attestation;
- invalid, revoked, wrong-session, or wrong-key producer attestation;
- receipt-only adapter containing executable command data;
- caller-supplied `done`, `productionReady`, or lifecycle mutation field;
- cache reuse across environment or policy drift;
- single-host evidence attempting to satisfy a distinct-host quorum policy.
- `shell:true` execution whose recorded shell/environment identity differs from
  the child identity;
- Windows implicit-shell execution recorded as `shell:false` or lacking required
  shell identity;
- unauthorized Pack attempting to register a high-trust or executable
  descriptor.

Regression commands:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:claim-admissibility-pack-framework
npm --prefix packages/main run test:quantum-claim-admissibility
npm --prefix packages/main run test:done-required-validation-smoke
# Added by M4; this script does not exist before implementation:
npm --prefix packages/main run test:evidence-environment-adapter
node scripts/verify-process-fact-contract.mjs
```

The process-fact contract check becomes mandatory if any adapter output is
consumed by REVIEW, TEST, DONE, release, or another lifecycle Gate.

### M5 — Admissibility and Gate integration

Integration must reuse:

- the shared proof-surface registry;
- EvidenceRuntime storage conventions;
- Proof Admissibility reason codes and consumer mappings;
- existing lifecycle Gate ownership.

Acceptance:

- a registered EEA receipt may satisfy only explicitly allowed claims and
  consumers;
- domain policy may strengthen but not weaken lifecycle requirements;
- missing or invalid EEA evidence blocks only where an approved policy requires
  it;
- a diagnostic-only adapter remains non-gating;
- no adapter can claim `productionDone`;
- the M4 Host-substitution cases are rerun through an actual Gate consumer using
  fresh evidence;
- equivalent trusted inputs yield the same Gate result when independence is not
  required;
- the current implementation never accepts producers for a distinct-Host
  policy and returns `distinct_host_quorum_unsupported`;
- only a future project-owned pinned-key registry with signed
  producer/session/invocation/subject binding and revocation checks may enable
  distinct-Host acceptance; that future path must reject duplicated,
  caller-renamed, same-producer, same-lineage, same-key, or same-session
  evidence.

### M6 — Paper claim and evidence package

The paper-facing package must contain:

- the architecture diagram from section 7;
- the formal model and six invariants;
- the terminology and responsibility table;
- the implementation support matrix;
- reference-path conformance results;
- host-substitution test results;
- negative/tamper test results;
- limitations and integration targets.

The manuscript path must be named before this milestone can be considered
complete. If the manuscript is outside this repository, record the exact
artifact path/version and the implementation commit or release digest to which
the claims bind.

Current B-955c status: **M6 is not complete for the external manuscript**. The
paper-facing material in this repository is the versioned architecture artifact
`docs/requirements/decisions/proof-or-stop-evidence-environment-adapter-execution-plan.md`
at the eventual B-955c merge/release commit. No external manuscript path,
revision, or immutable release digest containing this text is currently bound.
Therefore this repository may report the implemented mechanism and tests, but
the existing external manuscript must remain at Level B until an explicit
revision handoff records its artifact version and the final implementation
release digest.

## 11. Paper claim ladder

### Level A — Architecture defined

Allowed after M0:

> We define Evidence Environment as a host-neutral execution and observation
> boundary between claim proposal and evidence admissibility.

Not allowed:

> We implemented a generic Evidence Environment Adapter runtime.

### Level B — Generic contract implemented

Allowed after M1–M4:

> Proof-or-Stop implements a generic Evidence Environment Adapter contract for
> identity-bound execution, state observation, and external-receipt
> normalization, with local-command and read-receipt reference paths.

This statement must say “contract” and “reference paths”; it must not imply that
all named third-party systems are integrated.

### Level C — Gate-integrated mechanism demonstrated

Allowed after M5 and fresh conformance evidence:

> Heterogeneous Evidence Environments can produce normalized, identity-bound
> evidence for the shared Proof Admissibility service while lifecycle authority
> remains exclusively with Proof-or-Stop Gates.

B-955c demonstrates this level inside the repository through the real
DONE_REQUIRED evaluator. This is **not yet an external-manuscript claim**:
without the M6 artifact/version/release binding above, manuscript prose remains
at Level B.

### Level D — Domain adapter supported

Allowed only per implemented and tested adapter:

> Proof-or-Stop includes a tested `<domain/tool>` Evidence Environment Adapter
> under the stated trust, reproducibility, and admissibility boundary.

Never infer Level D for Lean, Rosetta, AlphaFold, browser, database, CI, or
Kubernetes merely because Levels A–C exist.

## 12. Recommended paper wording

### Contribution statement

> We introduce the Evidence Environment, a host-neutral evidence-production and
> observation boundary that separates claim proposal from observation,
> admissibility, and lifecycle authority. Evidence Environment Adapters bind subject,
> environment, invocation, policy, and output identity into normalized receipts;
> the shared admissibility layer restricts what each receipt may support, and
> lifecycle Gates alone decide whether execution may advance.

### Host-neutrality statement

> Host identity contributes provenance but, in the current implementation,
> cannot satisfy explicit independence
> policies, but it does not otherwise alter Gate semantics. Under equivalent
> subject, invocation, environment, policy, trust, and freshness bindings,
> semantically equivalent evidence from substitutable hosts yields the same Gate
> decision. A future Host-independence implementation must bind each producer
> identity to a separately verified pinned key, signed session/invocation/
> subject binding, and revocation state. Until that registry exists, the quorum
> API fails closed as unsupported; provider labels or injected callbacks are
> never evidence of independence.

### Cross-domain statement

> The contract is domain-portable, not epistemically uniform: a compiler result,
> formal-checker receipt, simulation residual, and deployment observation retain
> different claim scopes and assurance meanings even though they share the same
> evidence-control path.

### Calibrated implementation statement

For the B-955c implementation, use:

> Proof-or-Stop implements a generic Evidence Environment Adapter contract,
> bounded code-runtime and Quantum receipt projections, and a tested projection
> into its existing Proof Admissibility consumer. The code-runtime projection
> reuses configured validation evidence and does not expose an arbitrary command
> runner; the Quantum projection is receipt-only. Lean, Rosetta, AlphaFold, PINN
> solvers, browsers, databases, CI, Kubernetes, and production deployment
> remain integration targets rather than completed adapters.

Do not replace this evidence-bound statement with an unqualified “supports
arbitrary environments” claim.

### Manuscript handoff (pending M6)

No external manuscript revision has yet been bound to B-955c. A future external
manuscript change must cite a repository commit or release that
contains all of the following together:

1. `environment-contract.ts`;
2. the `test:evidence-environment-adapter` script and passing transcript;
3. the `runtime:evidence_environment_gate_projection` process-fact entry;
4. this support matrix.

Until that handoff exists, the external manuscript remains at Level B; M6 is
open. If any future bound artifact is absent or stale relative to the cited
commit, the manuscript must fall back to the lower claim justified by the
remaining evidence. The manuscript must not infer support for a named
environment from an example in this document.

## 13. Threats and design risks

| Risk | Failure mode | Control |
|---|---|---|
| “Adapter pattern” novelty objection | Contribution appears to be ordinary plugin plumbing | Lead with invariants, authority separation, host substitution, and tamper results |
| God abstraction | Compiler, Docker, CI, browser, and database forced into one weak `run()` | Standardize identity/receipt protocol; keep explicit roles and modes |
| Parallel evidence system | EEA creates its own store or proof definitions | Reuse Evidence Platform and shared registry exclusively |
| Scientific overclaim | Model/simulation output described as truth | Preserve semantic confinement and claim-specific admissibility |
| Arbitrary command execution | Generic adapter becomes an RCE/secrets boundary | Reuse allowlisted executors; no arbitrary shell; explicit network/fs/env policy |
| Unsafe caching | Old or different-environment receipt reused | Full identity key; temporal/stochastic non-cache defaults |
| Host-brand special cases | Gate result changes because provider string changes | Host-substitution conformance suite |
| False host equivalence | Quorum independence erased or forged with renamed provider strings | Current implementation rejects all distinct-host quorum as unsupported; future enablement requires a project-owned pinned-key, session-bound, revocation-aware registry |
| Descriptor trust escalation | An untrusted Pack registers itself as executable or high-trust | Separate registration from execution authority; policy-owned provenance and trust classification |
| Shell/environment identity drift | A command is identified under one process/shell context and runs under another | Prefer `shell:false`; bind effective process environment and shell identity; conformance-test supported shell paths |
| Paper outruns implementation | Lean/Rosetta/AlphaFold shown as supported | Claim ladder and per-adapter support matrix |

## 14. Final acceptance criteria

The architecture is paper-ready only when:

1. one normative terminology source exists;
2. Evidence Environment, EEA, Host Adapter, Verifier Adapter, Domain Pack,
   Evidence Platform, Proof Admissibility, and Gate have non-overlapping owners;
3. the generic descriptor, invocation, and receipt schemas are mechanically
   validated;
4. local-command and read-receipt-only reference paths use the same contract;
5. all identity, stale, unsafe, checker-error, and authority-bypass cases fail
   closed;
6. host substitution passes under equivalent policy inputs;
7. distinct-host quorum either binds every producer to a project-owned,
   pinned-key, signed-session and revocation-checked attestation, or remains
   explicitly unsupported and fail-closed (the current implementation);
8. adapter outputs enter the shared Evidence Platform and Proof Admissibility
   path rather than a parallel store;
9. no adapter directly mutates lifecycle or claims production completion;
10. the manuscript states the implemented support level and names future
    integrations as future work.

## 15. Audit questions

Reviewers should answer:

1. Does “Evidence Environment” denote a real architectural boundary rather than
   a synonym for Tool, Host, or Domain Pack?
2. Are execution, observation, and receipt-reading represented without a
   lowest-common-denominator `run()`?
3. Does every Gate-consumable receipt bind environment and invocation identity?
4. Can any adapter bypass the Evidence Platform, Proof Admissibility, or Gate?
5. Is host-substitution invariance conditioned correctly on trust and
   independence policy?
6. Are stochastic, stateful, temporal, and externally attested environments
   prevented from unsafe cache reuse?
7. Do paper claims distinguish a generic contract from completed third-party
   integrations?
8. Would removing the provider brand from equivalent evidence change a Gate
   result without an explicit policy reason? If yes, the implementation is not
   host-neutral.
9. Can caller-written host, provider, key, session, trust, or descriptor fields
   increase admissibility without verifier-owned attestation? If yes, producer
   identity is forgeable.
10. Does local-command reuse share only the hardened executor and identity logic,
    or does it accidentally preserve a parallel legacy storage path?

## 16. Final recommendation

Use:

- **Evidence Environment** for the paper-level architecture;
- **Evidence Environment Adapter (EEA)** for the generic interface;
- **Proof-or-Stop Evidence Environment Adapter Contract** for the first branded
  formal introduction;
- **Verifier Adapter**, **State Observer Adapter**, and **Remote Receipt Adapter**
  as role-specific subtypes, plus **Isolation Attestation Adapter** when
  isolation evidence is modeled separately.

Reject **Proof-or-Stop Adapter** as the primary name. It is brand-forward but
architecture-poor: it does not reveal that the adapter obtains evidence, does
not encode the execution/observation boundary, and is easily confused with an
IDE integration, Agent Host adapter, or Domain Pack.
