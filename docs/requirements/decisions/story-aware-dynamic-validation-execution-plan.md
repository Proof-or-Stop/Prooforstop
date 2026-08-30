# Story-Aware Dynamic Validation — Execution and Audit Plan

| Field | Value |
|---|---|
| Status | Approved for repository import as a design record. DYN-1 observe-only implementation authority applies only to the exact normative payload re-audited in Section 27.6 and remains subject to current-main kickoff discovery; dynamic TEST authority remains gated by DYN-2/DYN-3 evidence |
| Date | 2026-08-18 |
| Repository | `proofbound` |
| Historical candidate branch/worktree | `story/B-7dff` (unmerged at repository import; not an implementation prerequisite or statement about current `main`) |
| Historical candidate HEAD | `350e9394110a1b2dbf939650037ef73b4e3f073b` (not an ancestor of `main` at repository import) |
| Inventory authority | At DYN-1 kickoff, derive `N` from the complete command plan on current `main`; historical numeric examples in this document are non-normative snapshots |
| Historical benchmark | 107 commands: jobs=1 `29:22`; jobs=4 `21:56`; saving `7:26 / 25.3%` |
| Proposed authority | Deterministic, proof-carrying impacted validation with certified dependency closure, three-state accounting, and fail-closed full-suite escalation |
| External audit | Imported historical claims are preserved in Sections 27.1–27.5; only the repository-native, digest-bound re-audit in Section 27.6 authorizes the audited DYN-1 observe-only payload |

## 1. Executive decision

Adopt Story-aware dynamic validation as a new validation mode, but do not implement it as a heuristic test filter.

The authoritative model is:

> Execute every validation command affected by the current Story; reuse a prior PASS only when a signed dependency-closure certificate proves that the command's complete source input closure is known, byte-identical, ancestry-compatible, clean-tree generated, unexpired, and not revoked; classify every other command as unverified and execute it or escalate to full validation.

The final logical coverage ledger must still cover the complete current command inventory:

```text
inventory = executed + reused + unverified
unverified must be reduced to zero by execution or full escalation
authoritative PASS requires executed + reused = inventory
```

Example:

```text
Dynamic validation: PASS
inventory=N
executed=E
reused=N-E
unverified=0
uncovered=0
unmappedChanges=0
```

The design must never interpret "not selected" as "not relevant" without both a valid independence proof and an admissible receipt. Merely finding that the files listed in a catalog entry did not change is not an independence proof: the catalog's closure certificate must itself be current and complete. If proof is missing, malformed, stale, ambiguous, incomplete, expired, revoked, or not ancestry-compatible, the command is `unverified` and executes. If the uncertainty is systemic, validation automatically escalates to the complete plan.

## 2. Motivation and measured baseline

The existing resource-aware scheduler has already demonstrated meaningful improvement without changing validation semantics:

| Mode | Duration | Result |
|---|---:|---|
| Serial, jobs=1 | 29:22 | 107/107 PASS |
| Resource-aware, jobs=4 | 21:56 | 107/107 PASS |
| Proven saving | 7:26 / 25.3% | Verdict-equivalent |

The unmerged candidate snapshot recorded 110 commands. That count is not a statement about current `main`: DYN-1 must discover the complete inventory at kickoff, bind its digest, and use the resulting `N` everywhere below. The historical 21:56 result is a historical baseline, not a current SLA.

The largest historical critical-path contributors were:

| Command | Parallel duration | Observation |
|---|---:|---|
| `quorum-submit-smoke` | 10:43 | Approximately 49% of total wall time |
| `review-pass-discard-smoke` | 4:25 | Slower than its 2:48 serial measurement, indicating contention |

Scheduler tuning alone still executes every command. Internal sharding shortens selected heavy commands but still executes them for every Story. Dynamic validation attacks a different dimension: it removes unnecessary execution while retaining auditable logical coverage.

## 3. Goals

1. Reduce routine validation latency for ordinary Stories.
2. Preserve deterministic, machine-verifiable TEST and DONE assurance.
3. Produce an exact reason for every executed or reused command.
4. Fail closed on unmapped changes, incomplete declarations, stale receipts, or dependency uncertainty.
5. Preserve the complete validation inventory as the accounting denominator.
6. Remain compatible with keyed scheduling, CPU weights, LPT ordering, and future internal test sharding.
7. Allow phased rollout without weakening existing gates before equivalence is demonstrated.

## 4. Non-goals

1. Do not use Story titles, natural-language similarity, an LLM score, or historical success as authority to skip tests.
2. Do not reinterpret the existing `validate --focus` receipt as final validation authority.
3. Do not permit a caller to manually declare a Story low-risk at TEST time.
4. Do not claim all Stories will complete in 12–14 minutes.
5. Do not remove full validation; retain it as fallback, high-risk policy, periodic baseline, and audit oracle.
6. Do not optimize `quorum-submit-smoke` or `review-pass-discard-smoke` internally in the first dynamic-selection Story.

## 4.1 Independent audit disposition and normative corrections

The first external audit found a structural false-negative route: `triggers` and `inputs` could both omit the same implicit dependency, leaving the command unselected while its stale PASS receipt remained reusable. This revision closes that route normatively:

1. `triggers` and `inputs` are no longer independent hand-authored authorities.
2. A canonical dependency-closure certificate is generated from source dependency analysis, base/HEAD dual graphs, runtime file-read/process-spawn tracing from a canonical full baseline, process-fact/capability bindings, and explicit additive declarations.
3. File triggers are derived from the certified closure. Manual trigger declarations may only expand it.
4. Every command begins in `unverified`; it moves to `execute` or `reuse` only after the corresponding proof succeeds.
5. `full-only` has enforceable semantics: an impacted `full-only` command escalates the complete plan; an unimpacted `full-only` command may reuse only an exact canonical full-baseline receipt in the current baseline epoch.
6. Authoritative selection uses source inputs plus an always-executed build proof; it never hashes stale pre-build `dist/` files as source authority.
7. Deleted and renamed files use both the base graph and Story-HEAD graph.
8. Scope violations, protected-file changes, and explicit-exclusion changes force full validation.
9. Receipts bind trusted ancestry, merge-base, clean-tree state, baseline epoch, expiry, and revocation state.
10. No dynamic enforcement may begin until the decisions formerly listed as open questions are represented by blocking machine checks.

Where any earlier example conflicts with these corrections, this section and the revised component contracts below are normative.

## 5. Current-system findings

### 5.1 Static focused validation exists but is non-authoritative

`packages/main/src/handlers/verifier.ts` currently supports static `focus` tags. Its user-facing contract explicitly states:

```text
FOCUSED VALIDATE MODE ... not final full validation and not DONE-required proof.
```

Dynamic authoritative validation must be a separate mode and artifact. It must not silently broaden the authority of existing focused receipts.

### 5.2 Story changed-file computation already exists

`packages/main/src/core/evidence-freshness.ts` computes changed Story files from the merge-base with main and folds paths plus blob IDs into `currentStoryFilesHash`.

This is a useful starting point, but dynamic selection needs the canonical file manifest, not only the aggregate hash. The changed-file resolver should be extracted as one shared pure function consumed by both freshness hashing and validation selection.

### 5.3 Scope contract provides planning evidence

`ScopeContractData` already contains:

```text
allowedModify
allowedCreate
allowedTest
protectedFiles
explicitExcludes
```

These fields are useful for PLAN/DEV preview and safe over-selection. They cannot replace the final actual git diff.

### 5.4 Validation commands lack impact declarations

At DYN-1 kickoff, inspect every command in the complete current inventory `N`. The configuration shape observed in the historical candidate primarily declared command, args, timeout, focus, and resources; it did not mechanically declare:

```text
which files trigger a command
which process facts or capabilities it covers
which exact inputs determine receipt reusability
whether it is always-run, selectable, or full-only
its risk tier
its CPU weight or historical duration
```

### 5.5 Existing validation reuse is plan-wide

`packages/main/src/core/validation-evidence-reuse.ts` binds one validation identity to the entire command array and requires a complete PASS with the expected command count. It cannot independently reuse 92 commands and execute 18 commands.

Per-command receipts are therefore a required part of authoritative dynamic validation, not an optional optimization.

### 5.6 Current scheduler can create an exclusive tail

The unmerged candidate snapshot included `packages/main/src/core/keyed-scheduler.ts`, whose scheduling policy could leave a serial exclusive tail. Current `main` did not contain that path at repository import, so DYN implementation must discover the scheduler actually present at kickoff and must not depend on the candidate file. Weighted/LPT scheduling remains a separate, optional latency concern after that discovery.

Dynamic selection reduces plan width. Weighted/LPT scheduling and internal sharding remain complementary latency optimizations for commands that are still selected.

## 6. Safety invariants

The implementation must enforce these invariants mechanically.

### 6.1 Inventory completeness

```text
initially: every inventory command is unverified
finally: executedCommandIds union reusedCommandIds = currentInventoryCommandIds
executedCommandIds intersect reusedCommandIds = empty
unverifiedCommandIds = empty
uncoveredCommandIds = empty
```

The equality above is necessary but not sufficient. Every reuse row must also carry a current `closureCertificateDigest` proving that the changed-file set is disjoint from the command's certified transitive dependency closure. The manifest verifier recomputes this disjointness; it does not trust the row's claimed disposition.

### 6.1.1 Closure completeness

For every reused command `c` and Story change set `delta`:

```text
certifiedClosure(c) is valid and current
intersection(delta, certifiedClosure(c)) is empty
manual declarations do not subtract from certifiedClosure(c)
runtime-observed undeclared inputs are empty
```

If any clause cannot be proven, `c` remains `unverified` and executes. A structurally incomplete closure certificate cannot authorize reuse even when its declared input digest matches an older receipt.

### 6.2 Selection monotonicity

For two change sets `A` and `B`:

```text
A subset-of B  =>  selected(A) subset-of selected(B)
```

Adding a changed file, process fact, capability, or pinned verifier must not reduce the selected set.

The engine guarantees monotonicity by construction: final selection is the union of the independently computed command sets for every changed path/fact/capability plus the always and pinned sets. The manifest verifier recomputes every singleton contribution and verifies that their union equals the final selected set. No subtractive rule is permitted.

### 6.3 Determinism

The same values for the following inputs must produce the same selection manifest digest:

```text
story HEAD
main merge-base
actual changed-file manifest
scope contract
verificationIntent pins
validation catalog
validation inventory
dependency graph
process-fact/capability bindings
toolchain identity
dependency-closure certificate set
canonical full-baseline epoch
receipt-revocation ledger digest
historical recommendation snapshot digest, when advisory recommendations are included
```

Historical recommendations that are not bound to a snapshot digest are excluded from the authoritative manifest and rendered as non-authoritative post-plan suggestions only.

### 6.4 Fail-closed uncertainty

The following conditions must execute the uncertain command or escalate the whole plan:

```text
unmapped changed file
missing catalog entry
duplicate command ID
invalid glob
missing input closure
missing or stale closure certificate
runtime-observed input outside certified closure
dependency-graph failure
receipt parse/signature failure
receipt input-digest mismatch
receipt source is not a trusted ancestor
receipt was produced from a dirty worktree
receipt expired or was revoked
toolchain mismatch
catalog or inventory drift
scope protected/out-of-scope/explicit-exclusion violation
changed scheduler, executor, catalog, or selector implementation
```

### 6.5 No heuristic subtraction

Historical co-failure data, path-name similarity, symbol-name similarity, or LLM recommendations may add commands. They may never remove a command selected by deterministic rules.

## 7. Architecture

```text
Story Change Resolver
        |
        v
Validation Catalog ---- Process Fact / Capability Bindings
        |                         |
        +-----------+-------------+
                    v
       Certified Dual-HEAD Dependency Closure
                    |
                    v
              Impact Graph
                    |
                    v
             Selection Engine
           /         |          \
          v          v           v
       Execute     Reuse      Unverified
          |          |           |
          v          v           v
 Keyed Scheduler  Receipt   Execute or Full
                  Verifier     Escalation
           \         |          /
            v        v         v
          Selection + Execution Ledger
                    |
                    v
              TEST/DONE Gates
```

## 8. Component A — Story Change Resolver

### 8.1 Input

```ts
interface StoryChangeResolverInput {
  storyId: string;
  gitCwd: string;
  baseHead: string;
  head: string;
  scopeContract: ScopeContractData;
  verificationIntents: VerificationIntent[];
}
```

### 8.2 Output

```ts
interface StoryChangeManifest {
  schema: 'proof-or-stop.story-change-manifest.v1';
  storyId: string;
  baseHead: string;
  head: string;

  changedFiles: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    oldPath?: string;
    blobId?: string;
  }>;

  plannedFiles: string[];
  pinnedValidationCommands: string[];
  affectedPackages: string[];
  affectedProcessFacts: string[];
  affectedCapabilities: string[];
  scopeViolations: Array<{
    path: string;
    kind: 'outside-allowed-scope' | 'protected-file' | 'explicit-exclusion';
  }>;

  changeDigest: string;
}
```

### 8.3 Resolution rules

1. Compute the merge-base with main.
2. Read `git diff --name-status -M` from base to Story HEAD.
3. Include both the old and new path of rename/copy operations.
4. Represent deleted paths with the literal object identity `<deleted>`.
5. Exclude only paths already excluded by the canonical material-path policy.
6. Union actual changes with pinned verification commands.
7. Use scope-contract paths as additive planning input, never as a reason to omit actual changes.
8. If actual changes fall outside scope, keep them in the manifest and add a full-escalation reason.
9. Any change to `protectedFiles` or an `explicitExcludes` match is recorded as a scope violation and forces full validation; dynamic mapping cannot downgrade it.
10. Build dependency graphs for both `baseHead` and Story `head`.
11. Resolve modified and added paths against the union of both graphs.
12. Resolve deleted paths primarily through the base graph because the source no longer exists at Story HEAD.
13. Resolve renamed paths through both the old base path and new HEAD path, then union their reverse dependents.

For a deleted file, `changedFile.path` always remains its repository-relative historical path so base-graph lookup can resolve dependents. Only `blobId` carries the literal `<deleted>` marker; the path itself is never replaced by `<deleted>`.

### 8.4 Required refactor

Extract the existing changed-file logic from `currentStoryFilesHash` into a shared pure function:

```ts
resolveStoryChangedFiles(gitCwd, ref, metadataRoot): StoryChangedFile[]
```

Then implement `currentStoryFilesHash` by hashing that function's result. This prevents freshness and dynamic selection from disagreeing about Story-owned files.

The dependency graph API must be explicit about revision:

```ts
interface DualRevisionImpactGraph {
  baseHead: string;
  head: string;
  baseGraphDigest: string;
  headGraphDigest: string;
  commandsAffectedBy(change: StoryChangedFile): string[];
}
```

The graph generator must understand static imports, literal dynamic imports, package exports, CLI registry edges, and generated entrypoint bindings. Non-literal dynamic loads, filesystem-discovered modules, and child-process dispatch are supplied by explicit bindings and canonical runtime trace evidence. If one of those relations cannot be bounded, the affected command is `full-only` or uses whole-repository input closure.

## 9. Component B — Validation Catalog

### 9.1 Catalog entry

```ts
interface ValidationCatalogEntry {
  id: string;
  label: string;
  command: string;
  args: string[];

  /** Additive declarations. Authoritative file triggers are derived from closure. */
  triggerExtensions: {
    files?: string[];
    symbols?: string[];
    processFacts?: string[];
    capabilities?: string[];
    packages?: string[];
  };

  /** Source-first roots used to derive and certify the transitive closure. */
  inputRoots: string[];
  closurePolicy: 'static-and-traced' | 'whole-repository' | 'never-reuse';

  assurance: 'always' | 'story-selectable' | 'full-only';
  riskTier: 'local' | 'shared' | 'gate' | 'validation-infra';
  fullBaselineReusePolicy: 'not-applicable' | 'exact-current-epoch-only' | 'forbidden';

  resources: ResourceClaim[];
  cpuWeight: number;
  expectedP50Ms?: number;
}
```

Every entry must declare `fullBaselineReusePolicy`. `always` and `story-selectable` require `not-applicable`. A `full-only` entry must use `exact-current-epoch-only` or `forbidden`; `not-applicable` is rejected. `exact-current-epoch-only` permits reuse only from a receipt whose provenance is `canonical-full-baseline` and whose epoch exactly matches the current canonical baseline. `forbidden` means the command never reuses and any impact or missing baseline forces full execution.

`triggers.files` is not independently authored. The catalog compiler derives the authoritative file-trigger set from the certified closure and unions `triggerExtensions.files` into it. This enforces:

```text
derived file triggers are a superset of every certified dependency path
manual declarations may add triggers
manual declarations may not remove derived triggers
```

Each compiled catalog entry carries:

```ts
interface ValidationClosureCertificate {
  commandId: string;
  baseHead: string;
  inventoryDigest: string;
  catalogDigest: string;
  staticClosureDigest: string;
  runtimeTraceDigest: string;
  processFactBindingDigest: string;
  capabilityBindingDigest: string;
  certifiedPathsDigest: string;
  undeclaredObservedPaths: string[];
  environmentAccessDigest: string;
  undeclaredObservedEnvironmentKeys: string[];
  producedBy: 'canonical-full-baseline-compiler' | 'story-closure-preview';
  status: 'complete' | 'unverified';
  signature: string;
}
```

Only `status=complete` with `undeclaredObservedPaths=[]` and `undeclaredObservedEnvironmentKeys=[]` can authorize reuse. `whole-repository` causes any material Story change to select the command. `never-reuse` always executes the command. A `full-only` reuse requires a certificate produced by the canonical full-baseline compiler, never a Story preview certificate.

### 9.2 Example

```json
{
  "id": "quorum-submit",
  "label": "quorum-submit-smoke",
  "command": "node",
  "args": [
    "packages/main/dist/tasks/quorum-submit-smoke.js"
  ],
  "triggerExtensions": {
    "files": [
      "packages/main/src/handlers/quorum-submit.ts",
      "packages/main/src/core/review-escalation.ts",
      "packages/main/src/core/review-run.ts"
    ],
    "processFacts": [
      "command:quorum_submit",
      "runtime:review_assurance_floor"
    ],
    "capabilities": [
      "review-quorum",
      "host-verdict"
    ]
  },
  "inputRoots": [
    "packages/main/src/tasks/quorum-submit-smoke.ts",
    "packages/main/src/handlers/quorum-submit.ts",
    "packages/main/src/core/review-escalation.ts",
    "packages/main/src/core/review-run.ts"
  ],
  "closurePolicy": "static-and-traced",
  "assurance": "story-selectable",
  "fullBaselineReusePolicy": "not-applicable",
  "riskTier": "gate",
  "resources": [
    {
      "class": "git-common-dir",
      "key": ".",
      "access": "exclusive"
    }
  ],
  "cpuWeight": 4,
  "expectedP50Ms": 551000
}
```

### 9.3 Catalog validation

Add `scripts/verify-validation-catalog.mjs`. It must reject:

```text
missing or duplicate command IDs
inventory command absent from catalog
catalog command absent from inventory
story-selectable command without derived closure triggers or explicit extensions
empty or invalid inputRoots
absolute paths or parent traversal
unknown process-fact names
unknown capabilities
malformed resource claims
cpuWeight below 1 or above capacity
full-only entry without declared exact full-baseline reuse policy
always/story-selectable entry whose fullBaselineReusePolicy is not not-applicable
full-only entry whose fullBaselineReusePolicy is not exact-current-epoch-only or forbidden
```

The catalog verifier is an always-run command.

The verifier must also reject:

```text
compiled file trigger absent from its certified closure without an explicit extension reason
runtime-observed read/spawn/import outside the certified closure
closure certificate from another baseHead/catalog/inventory epoch
dist-only input roots used as source authority
full-only entry without exact full-baseline policy
full-only entry whose receipt/certificate provenance cannot be mechanically verified
never-reuse entry assigned a reuse disposition
```

## 10. Component C — Impact Graph

The graph combines several authoritative and advisory edge types.

### 10.1 Hard edges

Hard edges must select commands:

```text
verificationIntent pin -> validation command
changed test file -> its validation command
catalog file trigger -> validation command
process fact -> producer/consumer validation commands
capability -> capability validation commands
changed package/config -> package/full validation policy
```

### 10.2 Dual-revision reverse import edges

Build a TypeScript/JavaScript module graph using the TypeScript compiler API or another AST parser:

```ts
interface DependencyNode {
  path: string;
  imports: string[];
  dynamicImports: string[];
  exportedSymbols: string[];
  registryConsumers: string[];
}
```

Build one graph at `baseHead` and one at Story `HEAD`. For each changed source module, compute bounded reverse dependents in both graphs until reaching one or more validation entrypoints, then take their union. Deleted files rely on the base graph; added files rely on the HEAD graph; modified and renamed files use both.

Static dependency analysis is not sufficient for:

```text
CLI registry dispatch
dynamic imports
child-process argv
source-string contract checks
whole-tree scanners
process-fact producer/consumer edges
runtime registries
```

Those relationships must be explicitly declared in process-fact/capability bindings or captured by the canonical runtime closure trace produced by a full baseline. If a non-literal dynamic relation cannot be bounded, the command uses `whole-repository` or `never-reuse` closure policy.

### 10.2.1 Runtime closure tracing

During canonical full-baseline execution, each command records bounded file reads, module loads, child-process executable/argv identities, registry lookups, and generated entrypoint inputs. The trace is normalized to repository-relative source authority and merged with the static dual-HEAD closure. Observed paths outside the compiled certificate set invalidate the certificate rather than silently extending a receipt after execution.

Runtime tracing is a supplement to deterministic declarations, not proof that an unexecuted branch has no additional dependency and not permission to omit known process-fact or capability edges. A command with data-dependent, non-literal, or branch-dependent I/O that cannot be conservatively bounded cannot receive a `complete` certificate; it uses `whole-repository` or `never-reuse` policy.

### 10.2.2 Graph caching and performance

The dual graph is content-addressed by:

```text
baseHead tree digest
HEAD tree digest
TypeScript/toolchain digest
resolver/config digest
graph implementation digest
```

The implementation incrementally reparses only changed modules and affected reverse edges. It persists graph-build duration and cache-hit state. The `<2 seconds` selection target applies only to a warm valid cache; a cold or corrupt cache may exceed that target but must rebuild safely or escalate full. Enforcement is forbidden until representative warm/cold measurements are recorded.

### 10.3 Advisory edges

Historical co-failure data may select additional commands:

```text
changed path -> commands that failed in prior full validations
changed capability -> historically co-failing commands
```

Advisory edges are additive only. Their authoritative use requires a signed `historicalRecommendationSnapshotDigest`; without that digest they are rendered after planning and are excluded from the signed selection manifest.

## 11. Component D — Selection Engine

### 11.1 Selection order

1. Validate inventory, catalog, revocation ledger, and canonical full-baseline epoch.
2. Resolve actual Story change manifest and scope violations.
3. Load or build the base/HEAD dual graph and closure certificates.
4. Initialize every inventory row as `unverified`.
5. Add always-run commands.
6. Add verificationIntent pinned commands.
7. Add changed test-file commands.
8. Add closure-derived file triggers and dual-graph reverse dependencies.
9. Add process-fact and capability commands.
10. Add snapshot-bound advisory historical commands.
11. Classify full-escalation reasons, including scope/protected/exclusion violations.
12. Apply enforceable `full-only`, `whole-repository`, and `never-reuse` semantics.
13. For every remaining command, require a complete closure certificate and a deterministic matching admissible receipt before changing `unverified` to `reuse`.
14. Convert all remaining `unverified` rows to `execute`, or escalate full when uncertainty is systemic.
15. Recompute singleton selection contributions and verify monotonic union equality.
16. Assert complete inventory coverage and zero unverified rows.
17. Sign and persist the selection manifest.

### 11.2 Pseudocode

```ts
function buildDynamicValidationPlan(ctx: ValidationContext) {
  const inventory = loadAndValidateInventory(ctx.projectRoot);
  const catalog = loadAndValidateCatalog(ctx.projectRoot);
  const changes = resolveStoryChangeManifest(ctx);
  const pinned = resolvePinnedVerificationCommands(ctx.storyId);
  const impactGraph = buildDualRevisionImpactGraph(ctx.projectRoot, changes.baseHead, changes.head);
  const closures = loadVerifiedClosureCertificates(ctx, inventory, catalog, impactGraph);
  const baseline = loadCanonicalFullBaselineEpoch(ctx);
  const revocations = loadReceiptRevocationLedger(ctx);

  const selected = new Map<string, string[]>();
  const unmappedFiles: string[] = [];
  const escalationReasons: string[] = [];
  const rows = new Map(inventory.map(command => [command.id, {
    commandId: command.id,
    disposition: 'unverified' as const,
    reasons: ['awaiting-independence-proof'],
  }]));

  const select = (commandId: string, reason: string) => {
    const reasons = selected.get(commandId) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    selected.set(commandId, reasons);
  };

  for (const command of inventory) {
    if (command.assurance === 'always') select(command.id, 'always');
  }

  for (const pin of pinned) {
    const command = resolvePinnedCommand(inventory, pin);
    if (!command) throw new Error(`pinned command absent: ${pin}`);
    select(command.id, 'verification-intent-pin');
  }

  for (const changedFile of changes.changedFiles) {
    const direct = catalog.commandsTriggeredByCertifiedClosure(changedFile.path, closures);
    const dependent = impactGraph.commandsAffectedBy(changedFile);

    if (direct.length === 0 && dependent.length === 0) {
      unmappedFiles.push(changedFile.path);
      continue;
    }

    for (const command of direct) {
      select(command.id, `file-trigger:${changedFile.path}`);
    }

    for (const command of dependent) {
      select(command.id, `reverse-dependency:${changedFile.path}`);
    }
  }

  for (const fact of changes.affectedProcessFacts) {
    for (const command of catalog.commandsForProcessFact(fact)) {
      select(command.id, `process-fact:${fact}`);
    }
  }

  for (const capability of changes.affectedCapabilities) {
    for (const command of catalog.commandsForCapability(capability)) {
      select(command.id, `capability:${capability}`);
    }
  }

  const historical = loadHistoricalRecommendations(changes);
  if (verifyHistoricalRecommendationSnapshot(historical)) {
    for (const recommendation of historical.rows) {
      select(recommendation.commandId, `historical:${recommendation.reason}`);
    }
  } else {
    recordNonAuthoritativeHistoricalSuggestions(historical.rows);
  }

  escalationReasons.push(
    ...classifyFullValidationReasons(changes, catalog, unmappedFiles),
  );

  if (changes.scopeViolations.length > 0) {
    escalationReasons.push(...changes.scopeViolations.map(row => `scope-violation:${row.kind}:${row.path}`));
  }

  for (const command of inventory) {
    if (command.assurance === 'full-only' && selected.has(command.id)) {
      escalationReasons.push(`impacted-full-only-command:${command.id}`);
    }
    if (command.assurance === 'full-only' && !selected.has(command.id)) {
      const policy = command.fullBaselineReusePolicy;
      const hasExactBaselineReceipt = policy === 'exact-current-epoch-only'
        && hasCanonicalFullBaselineReceipt({
          commandId: command.id,
          baselineEpochId: baseline.id,
          requiredProducedBy: 'canonical-full-baseline',
        });
      if (policy === 'forbidden' || !hasExactBaselineReceipt) {
        escalationReasons.push(`full-only-baseline-unavailable:${command.id}`);
      }
    }
  }

  if (escalationReasons.length > 0) {
    for (const command of inventory) {
      select(command.id, `full-escalation:${escalationReasons.join(',')}`);
    }
  }

  for (const command of inventory) {
    const certificate = closures.get(command.id);
    const inputDigest = computeCertifiedSourceInputDigest(command, certificate, ctx);

    if (selected.has(command.id)) {
      rows.set(command.id, {
        commandId: command.id,
        disposition: 'execute',
        reasons: selected.get(command.id)!,
        inputDigest,
        closureCertificateDigest: certificate?.signature,
      });
      continue;
    }

    if (!certificate || certificate.status !== 'complete'
      || certificate.undeclaredObservedPaths.length > 0
      || certificate.undeclaredObservedEnvironmentKeys.length > 0) {
      rows.set(command.id, {
        commandId: command.id,
        disposition: 'unverified',
        reasons: ['closure-certificate-unavailable-or-incomplete'],
        inputDigest,
      });
      continue;
    }

    if (command.closurePolicy === 'never-reuse') {
      rows.set(command.id, {
        commandId: command.id,
        disposition: 'execute',
        reasons: ['never-reuse-policy'],
        inputDigest,
        closureCertificateDigest: certificate.signature,
      });
      continue;
    }

    const receipt = loadBestMatchingAdmissiblePassReceipt({
      commandId: command.id,
      inputDigest,
      baselineEpochId: baseline.id,
      currentHead: changes.head,
      currentBaseHead: changes.baseHead,
      requiredProducedBy: command.assurance === 'full-only'
        ? 'canonical-full-baseline'
        : undefined,
      revocations,
    });

    if (command.assurance === 'full-only' && receipt?.producedBy !== 'canonical-full-baseline') {
      throw new Error(`full-only command lacks canonical baseline provenance: ${command.id}`);
    }

    if (receiptCanBeReused(receipt, command, certificate, inputDigest, baseline, ctx)) {
      rows.set(command.id, {
        commandId: command.id,
        disposition: 'reuse',
        reasons: ['certified-input-closure-unchanged'],
        inputDigest,
        receiptId: receipt.id,
        closureCertificateDigest: certificate.signature,
      });
    } else {
      rows.set(command.id, {
        commandId: command.id,
        disposition: 'execute',
        reasons: ['no-admissible-reusable-receipt'],
        inputDigest,
        closureCertificateDigest: certificate.signature,
      });
    }
  }

  for (const row of rows.values()) {
    if (row.disposition === 'unverified') {
      row.disposition = 'execute';
      row.reasons.push('unverified-fails-closed-to-execution');
    }
  }

  assertSelectionIsSingletonUnionMonotonic(changes, selected, catalog, impactGraph, closures);
  assertCompleteInventoryCoverage(inventory, [...rows.values()]);
  assertNoUnverifiedRows([...rows.values()]);

  return signSelectionManifest({
    inventory,
    catalog,
    changes,
    rows: [...rows.values()],
    unmappedFiles,
    escalationReasons,
  });
}
```

### 11.3 Why not weighted set cover in v1

A greedy set-cover algorithm could choose the smallest number of tests whose declared coverage includes all affected capabilities. Do not use it for v1 authority because:

1. Multiple tests may cover different layers of the same capability.
2. Coverage declarations may be incomplete during rollout.
3. Removing a seemingly redundant integration sentinel can weaken adversarial discrimination.
4. The optimization is harder to audit than deterministic union rules.

Set cover may later be considered only inside an explicitly equivalent test family with a mandatory sentinel and mutation proof.

## 12. Full-validation escalation policy

### 12.1 Mandatory full triggers

Automatically select the complete inventory when the Story changes:

```text
validation catalog
validation inventory
validation executor
keyed scheduler
selection engine
command-receipt verifier
dependency graph generator
package.json or lockfile
lattice.config.json validation configuration
build binding or dist promotion
lifecycle state machine
command policy
process-fact registry
runtime-fact registry
material/story-files hashing
test harness authority
dependency-closure certificate generator or runtime tracer
receipt ancestry/expiry/revocation verifier
```

Also escalate on:

```text
unmapped changed files
unknown cross-package dependency
failed dependency-graph generation
catalog/inventory digest mismatch
changed command with missing input closure
rename/delete that cannot be mapped
actual diff outside allowed scope
protected file changed
explicit exclusion changed
dirty worktree at planning or execution boundary
missing canonical full-baseline epoch
```

### 12.1.1 Assurance-tier semantics

| Assurance | Dynamic behavior |
|---|---|
| `always` | Always execute; never reuse in dynamic-authoritative v1 |
| `story-selectable` | Execute when impacted; otherwise reuse only with complete closure certificate and admissible receipt |
| `full-only` | If impacted, force full validation; if unimpacted, reuse only from the exact current canonical full-baseline epoch |

`full-only` is therefore mechanically distinct from `story-selectable`. Catalog verification cannot by itself authorize reuse; the selection engine and TEST gate must validate the full-baseline receipt relationship.

### 12.2 Suggested risk matrix

| Change type | Strategy |
|---|---|
| Docs only | Docs, residue, registry checks; build according to project policy |
| Local isolated module | Dynamic selection |
| Ordinary handler | Dynamic plus reverse dependency closure |
| Shared core | Expanded dynamic or full by policy |
| Lifecycle gate/state machine | Full |
| Command policy | Full |
| Process/runtime fact registry | Full |
| Validation executor/scheduler/catalog | Full |
| Package, lockfile, validation config | Full |
| Unmapped or ambiguous path | Full |

## 13. Component E — Per-command receipts

### 13.1 Receipt schema

```ts
interface ValidationCommandReceipt {
  schema: 'proof-or-stop.validation-command-receipt.v1';

  id: string;
  commandId: string;

  commandIdentityDigest: string;
  inputDigest: string;
  closureCertificateDigest: string;
  catalogDigest: string;
  inventoryDigest: string;
  runnerDigest: string;
  toolchainDigest: string;
  buildProofDigest: string;

  sourceHead: string;
  sourceBaseHead: string;
  canonicalBaselineEpochId: string;
  producedBy: 'canonical-full-baseline' | 'story-execution';
  cleanTreeDigest: string;
  executionEnvironmentDigest: string;
  result: 'PASS' | 'FAIL' | 'TIMEOUT';
  exitCode: number;
  outputDigest: string;
  durationMs: number;

  createdAt: string;
  expiresAt: string;
  revocationLedgerDigest: string;
  signature: string;
}
```

### 13.2 Input digest

For each command:

```text
inputDigest = hash(
  sorted(source-path + NUL + blobId-or-deleted)
  + command identity
  + relevant environment identity
  + runner digest
  + catalog entry digest
  + dual dependency-graph digest
  + closure-certificate digest
  + canonical baseline epoch
  + Node/toolchain identity
  + signed build-proof digest
)
```

The input closure includes:

1. Source-first `inputRoots`.
2. Certified transitive source dependencies from both base and HEAD graphs.
3. Runtime-observed source/config/registry inputs from the canonical full baseline.
4. Config and registry files consumed by the command.
5. The source command runner and build/compiler identity.
6. Process-fact/capability declaration files.
7. Toolchain and execution-environment identity.

Compiled `dist/` bytes are not pre-build source authority. Dynamic-authoritative v1 always executes the canonical build in Wave 0. The build produces a signed `buildProofDigest` bound to source inputs, compiler/toolchain, output manifest, and clean-tree state. Every command receipt stores that exact digest, and `inputDigest` includes it. Selection may be previewed before build, but the authoritative manifest is finalized and signed only after build proof exists.

If the command scans the entire repository, declare:

```text
closurePolicy = "whole-repository"
```

That command will rerun after every material change, which is correct until its scanner scope can be safely narrowed.

### 13.3 Reuse predicate

Reuse is permitted only when all conditions hold:

```text
prior result is PASS
receipt signature is valid
command identity digest matches
input digest matches
closure certificate is complete and matches
catalog digest matches
inventory digest matches the current baseline epoch
runner digest matches
toolchain digest matches
receipt is not revoked
receipt has not expired
receipt sourceHead is a trusted ancestor of current HEAD
receipt sourceBaseHead matches the current canonical baseline epoch
receipt was produced from a clean worktree
receipt buildProofDigest exactly matches the current signed build proof
command ID remains canonical
```

Any missing or mismatched field changes disposition from `reuse` to `execute`.

### 13.3.1 Canonical baseline, expiry, and revocation

1. A dynamic-authoritative run requires a canonical full PASS baseline for the exact main content-tree epoch, inventory, catalog, closure implementation, and toolchain. If absent, run full validation.
2. Default receipt expiry is 24 hours and is configurable only toward a shorter duration during initial enforcement. Digest equality does not override expiry.
3. Full-baseline receipts and Story receipts may be revoked through an append-only signed ledger keyed by receipt ID and optionally command/catalog epoch. TEST reads the current ledger digest and refuses revoked receipts.
4. Cross-branch reuse is allowed only when `sourceHead` is a trusted ancestor of the current HEAD and belongs to the same canonical baseline epoch. An unrelated branch receipt is inadmissible even if file digests happen to match.
5. The worktree must be clean at selection, immediately before command execution, and after execution except for explicitly classified runtime/Story metadata. Receipt issuance records this clean-tree proof.
6. Receipts, ledgers, closure certificates, build proofs, manifests, and shard receipts use an Ed25519 signature with an explicit key ID. The private signing material is kept in Git common metadata, never beside runtime or Story artifacts; verification resolves the trusted public key and rejects unsigned, legacy digest-only, or different-key signatures. An artifact writer can therefore neither alter a payload nor recompute its provenance tag.

### 13.3.2 Deterministic receipt lookup

Replace ambiguous `loadLatestCommandReceipt` behavior with a two-step receipt lookup. The exported `loadBestMatchingAdmissiblePassReceipt` is the deterministic basic lookup: it filters by command ID, current input digest, baseline epoch, receipt signature/expiry, then chooses greatest `createdAt` (breaking ties by lexicographically greatest receipt ID). Its caller must apply the authoritative current-context admission predicate (`receiptAdmissible`): ancestry, revocation, catalog, inventory, runner, toolchain, exact `buildProofDigest`, execution environment, and clean-tree proof. A more recent nonmatching or failed receipt does not hide an older fully admissible PASS, but revocation always wins.

## 14. Component F — Selection manifest

```ts
interface ValidationSelectionManifest {
  schema: 'proof-or-stop.validation-selection.v1';

  storyId: string;
  baseHead: string;
  head: string;

  changeDigest: string;
  scopeContractDigest: string;
  catalogDigest: string;
  inventoryDigest: string;
  dependencyGraphDigest: string;
  closureCertificateSetDigest: string;
  toolchainDigest: string;
  buildProofDigest: string;
  canonicalBaselineEpochId: string;
  receiptRevocationLedgerDigest: string;
  historicalRecommendationSnapshotDigest?: string;

  changedFiles: StoryChangedFile[];

  rows: Array<{
    commandId: string;
    disposition: 'execute' | 'reuse' | 'unverified';
    reasons: string[];
    receiptId?: string;
    inputDigest: string;
    closureCertificateDigest?: string;
  }>;

  totals: {
    inventory: number;
    executed: number;
    reused: number;
    unverified: number;
    uncovered: number;
    unmappedChanges: number;
  };

  escalationReasons: string[];
  signature: string;
}
```

### 14.1 TEST gate acceptance

The TEST gate accepts dynamic validation only if:

```text
manifest signature is valid
manifest storyId, HEAD, and base are current
inventory digest is current
catalog digest is current
changed-file manifest matches current HEAD
scope contract has no protected/out-of-scope/explicit-exclusion violation
closure certificate set is current and signature-valid
build proof is current and source-bound
canonical full-baseline epoch is current
revocation ledger digest is current
uncovered is zero
unverified is zero
unmappedChanges is zero
every execute row has a current PASS receipt
every reuse row has a complete closure certificate and an admissible PASS receipt
every reuse row's certified closure is disjoint from current changed files
every receipt source is ancestry-compatible, clean-tree generated, unexpired, and not revoked
every reused full-only row has receipt.producedBy=canonical-full-baseline and exact current baseline epoch
all verificationIntent pinned commands were executed
no full-escalation reason was ignored
```

The zero-unmapped/zero-unverified requirements above govern dynamic-reuse authority. If mandatory full-validation escalation is triggered, authority falls back to the standard complete-plan execution verifier. A successful complete `N`-command run may be accepted under full-run rules even though the provisional dynamic manifest recorded the uncertainty that caused escalation; that uncertainty may not be converted into reuse.

### 14.2 DONE gate behavior

DONE-required policy remains separate. If the project configures independent DONE-required commands, dynamic routine validation does not bypass them.

The selection manifest, command receipts, and done-required evidence must each retain their existing authority boundaries.

## 15. Execution scheduling

After selection, schedule only execute rows. Reuse rows are verified synchronously and do not consume worker capacity.

Suggested two-stage planning and execution:

```text
Preview: source-only change manifest, risk classification, provisional selection
Wave 0: always-executed build, catalog verifier, graph/closure verifier
Finalize: bind build proof; recompute and sign authoritative selection manifest
Wave 1: timing-sensitive commands
Wave 2: shared weighted commands, ordered by expected p50 descending
Wave 3: exclusive/full-only commands
Wave 4: receipt aggregation and manifest verification
```

No reuse decision is authoritative until Wave 0 completes and the final manifest binds its build proof. A changed build output after manifest finalization invalidates the manifest. Dynamic-authoritative v1 does not reuse build itself.

Suggested weights:

```text
ordinary command: 1
review-pass: 3
quorum: 4
capacity: 4
```

Stable ordering:

```text
wave ascending
expectedP50Ms descending
original inventory index ascending
```

Scheduler and dynamic selection solve different problems:

```text
dynamic selection: reduces width
resource scheduler: reduces waiting/overlap cost
internal shards: reduce selected heavy-command latency
```

## 16. User-facing report

### 16.1 Dynamic PASS

```text
Dynamic validation plan
  inventory: N
  changed files: 6
  pinned commands: 3
  executed: 18
  reused: 92
  unverified: 0
  closure certificates: N/N current
  canonical baseline epoch: main-tree-...
  uncovered: 0
  unmapped changes: 0
  escalation: no
  selection digest: 8f9a...

Execution
  18/18 executed commands PASS
  92/92 reused receipts admissible
  92/92 independence proofs verified
  logical coverage: N/N
  duration: 8m42s

Validation PASS
```

### 16.2 Automatic full escalation

```text
Dynamic validation escalated to full
  reasons:
    - validation-runtime-changed
    - changed path: <changed-validation-scheduler-path>
  executing: N/N
```

### 16.3 Failure to establish authority

```text
Dynamic validation authority unavailable
  unmapped changed paths:
    - packages/main/src/core/new-runtime-boundary.ts
  action: full validation selected
```

The report must print a reason for every command and expose the full structured manifest under JSON output.

## 17. Implementation Stories

### Story DYN-1 — Catalog and observe-only selection

#### Scope

1. Add stable IDs for the full current inventory.
2. Add catalog fields and parser validation.
3. Generate signed closure certificates from dual-HEAD source analysis, runtime baseline traces, and explicit fact/capability bindings.
4. Extract the canonical Story changed-file resolver.
5. Implement deterministic three-state selection manifest generation.
6. Continue executing the complete validation plan.
7. Compare selected commands against complete-run failures.
8. Run observe instrumentation without launching an additional competing validation plan: graph/selection work occurs before the authoritative plan, and trace collection is attached to each existing command boundary or runs afterward under separately declared resources.

#### Acceptance

```text
N/N catalog coverage, where N is derived from the kickoff inventory digest
zero duplicate IDs
zero unmapped catalog commands
same inputs produce same selection digest
adding a changed file never reduces selection
runtime-observed undeclared input invalidates the closure certificate
deleted/renamed file dependents are found through the base graph
unmapped change escalates full
no TEST/DONE authority change
observe instrumentation does not change authoritative command order, verdict, worker/resource limits, or cleanup
instrumented and uninstrumented full-run verdicts match
```

### Story DYN-2 — Per-command receipts and shadow reuse

#### Scope

1. Persist signed per-command receipts.
2. Compute input closure digests.
3. Bind receipts to closure certificate, baseline epoch, ancestry, build proof, clean tree, expiry, and revocation ledger.
4. Verify receipt reuse independently per command.
5. Produce executed/reused/unverified/uncovered ledger.
6. Keep full validation as the authoritative result during shadow rollout.

#### Acceptance

```text
unchanged input closure permits reuse
any input change forces execution
runner/toolchain/catalog change forces execution
invalid receipt signature forces execution
expired/revoked/cross-branch/dirty-tree receipt forces execution
missing closure certificate forces execution
executed union reused equals inventory
unverified equals zero before PASS
uncovered equals zero
```

### Story DYN-3 — Low-risk dynamic authority

#### Scope

1. Add `dynamic-authoritative` validation evidence.
2. Update TEST gate to verify the selection manifest.
3. Permit low-risk local/docs Stories.
4. Retain mandatory full escalation for shared gates and validation infrastructure.
5. Preserve independent DONE-required policies.
6. Mechanically require every resolved pre-enforcement decision in Section 24.
7. Require a current canonical full-baseline epoch and periodic baseline policy.

#### Acceptance

```text
low-risk Story can pass TEST dynamically
gate Story escalates full
validation-infra Story escalates full
unmapped path escalates full
missing pinned verifier blocks
focused receipt cannot impersonate dynamic authority
all Section 24 pre-enforcement decisions report PASS
full-only impacted command escalates full
protected/out-of-scope/explicit-exclusion change escalates full
```

### Story DYN-4 — Weighted/LPT scheduling

#### Scope

1. Add CPU weights.
2. Add expected-p50 duration hints.
3. Add stable wave/LPT ordering.
4. Refine dist read/write resource declarations.
5. Persist scheduling timeline.

#### Acceptance

```text
worker count and CPU weight never exceed capacity
dist writer never overlaps conflicting dist reader
serial and optimized verdicts match
drain-barrier mutation fails
weight-removal mutation fails
timeline has no missing or duplicate command
```

### Story DYN-5 — Quorum and review-pass sharding

#### Scope

1. Register stable internal case IDs.
2. Split quorum into 3–4 isolated shards.
3. Split review-pass into three isolated scenario groups.
4. Preserve one real end-to-end sentinel for each.
5. Aggregate with no-omission/no-duplicate enforcement.

#### Acceptance

```text
aggregate verdict equals original test
deleting a shard fails
duplicating a case fails
wrong routing fails
static PASS shard fails
temp/process/ticket/quarantine residue is zero
```

DYN-5 is not required before narrowly enabling low-risk Stories that cannot select gate-tier or exclusive heavy commands. It is required before claiming the 8–12 minute ordinary-Story target for any population that includes quorum/review-pass-touching Stories.

## 18. Rollout plan

### Phase 0 — Characterization

1. Freeze current inventory digest.
2. Record serial and resource-aware full results.
3. Capture command durations and resource timelines.
4. Identify current high-risk and whole-repo scanners.

No gate change.

### Phase 1 — Observe

Dynamic selection computes and persists a manifest, but the complete `N`-command plan still executes and remains authoritative.

For each run, record:

```text
selected commands
unselected commands
full-run failures
commands that dynamic selection would have reused
commands left unverified before fail-closed execution
closure certificate status and undeclared observed inputs
selection reasons
unmapped changes
```

Primary safety metric:

```text
full failures outside dynamic executed set = 0
runtime-observed inputs outside certified closure = 0
reused command failures in the following full run = 0
```

### Phase 2 — Shadow reuse

1. Execute the dynamic plan first.
2. Verify reusable command receipts.
3. Still execute the full plan afterward.
4. Compare verdicts and per-command outcomes.
5. Do not allow dynamic receipts into TEST/DONE authority.
6. Require a canonical full baseline for the exact main content-tree/catalog/inventory/toolchain epoch.
7. Exercise expiry, revocation, ancestry, dirty-tree, and build-proof rejection.

### Phase 3 — Enforce low-risk Stories

Permit dynamic authority only when:

```text
risk tier is local/docs
unmapped changes is zero
scope violations is zero
catalog and graph are current
closure certificates are complete
runtime undeclared inputs is zero
pinned commands are executed
all reuse receipts are admissible
canonical baseline epoch is current
receipt revocation ledger is current
build proof is current
Section 24 enforcementPrerequisites are all PASS
no full-escalation reason exists
```

### Phase 4 — Expand coverage

After sustained zero-false-negative evidence, expand to selected shared-core Stories. Keep lifecycle-gate and validation-infra Stories on full validation. Continue one canonical full baseline for each eligible main content-tree epoch and at least one scheduled full audit run every 24 hours while enforce mode is active; if the baseline is absent or expired, dynamic authority falls back to full execution.

### Phase 5 — Optimize heavy selected commands

Land weighted/LPT scheduling and quorum/review-pass sharding. Re-run performance and equivalence campaigns.

## 19. Audit experiment design

### 19.1 Historical Story replay

Replay at least 30–50 historical Stories covering:

```text
docs-only
local handler
shared core
lifecycle gate
process fact
validation runtime
package/config
rename/delete
intentional red/failing change
test-only change
```

For each Story:

```text
1. Restore the historical Story base and head.
2. Generate the dynamic selection manifest.
3. Run the dynamic plan.
4. Run the full plan.
5. Compare per-command verdicts and final result.
```

Required property:

```text
Failures(full, story) subset-of Executed(dynamic, story)
```

A full-run failure must never appear in the reusable set.

Historical replay is not sufficient to validate catalog completeness because it is survivorship-biased. Add a systematic catalog fault-injection campaign:

1. **FI-1:** For every `story-selectable` command, mutate at least one certified source dependency and prove the command moves to `execute`.
2. **FI-2:** Remove one static edge, one runtime-traced edge, and one fact/capability edge and prove the closure certificate becomes `unverified` or the full shadow oracle detects the omission.
3. **FI-3:** For every `full-only` command, mutate one trigger and prove full escalation.
4. **FI-4:** For every `whole-repository` command, mutate an unrelated material file and prove selection.
5. **FI-5:** For deleted and renamed inputs, replay against both base and HEAD graphs.

Section 20 mutation rows carry these FI identifiers. The enforce threshold requires a durable PASS receipt for every FI item, not only a generic `all mutants failed` summary.

### 19.2 Paired performance campaign

For current HEAD, use alternating paired order:

```text
full -> dynamic
dynamic -> full
full -> dynamic
```

Record:

```text
HEAD
Node/toolchain version
inventory digest
catalog digest
dependency graph digest
closure certificate set digest
canonical baseline epoch
revocation ledger digest
selected/executed/reused counts
unverified count
per-command verdict
wall time
CPU utilization
resource overlap timeline
temp/worker/ticket/quarantine residue
```

Report median, not best run.

### 19.3 Enforce threshold

Do not enable dynamic TEST authority until all are true:

```text
30–50 representative historical Stories replayed
zero false negatives
three current-HEAD paired experiments
complete current inventory coverage
complete closure certificates for every reused row
zero undeclared runtime inputs
all mandatory mutants fail
warm-cache selection overhead below 2 seconds, with cold-cache measurements separately reported
zero residual temp/process/lock artifacts
dynamic/full final verdict equivalence
```

## 20. Mutation matrix

| Mutation | Required result |
|---|---|
| Delete changed-file to command mapping | Unmapped change; full escalation |
| FI-1: Mutate a certified source dependency | Command moves to execute |
| FI-2: Omit one real dependency from static/runtime/fact closure | Closure certificate becomes unverified; command executes or full escalates |
| FI-2: Forge a complete closure certificate after undeclared runtime read | Certificate signature/verifier failure |
| Add inventory command without catalog entry | Catalog verification failure |
| Duplicate catalog ID | Catalog verification failure |
| Delete verificationIntent pinned command | Selection manifest failure |
| Modify command input while retaining old receipt | Receipt rejected; command executes |
| Change Node/toolchain version | Receipt rejected; command executes |
| Change catalog but retain old selection manifest | Manifest rejected |
| Change inventory but retain old manifest | Manifest rejected |
| Rename file without mapping old path | Full escalation |
| Delete file without `<deleted>` digest row | Change-manifest verifier failure |
| FI-5: Build graph only at HEAD and delete/rename an imported file | Dual-graph mutation fails; dependent command must be selected |
| Replace static import with literal dynamic import and lose a selected command | Monotonic singleton-union verification failure |
| Make dependency graph omit an importer | Shadow equivalence detects false negative; graph fix required |
| Change scheduler/selector implementation and remain dynamic | Risk classifier forces full |
| Make a selected test print static PASS | Executable receipt/expected behavior check fails |
| Remove CPU weight enforcement | Scheduler mutation fails |
| Mark dist writer as reader | Resource overlap mutation fails |
| Remove scheduler drain barrier | Equivalence/timeline mutation fails |
| Omit quorum shard | Aggregate coverage failure |
| Duplicate quorum case | Aggregate uniqueness failure |
| Route review-pass case to wrong shard | Routing digest failure |
| Reuse failed or timed-out receipt | Receipt verifier failure |
| Reuse receipt from unrelated branch | Ancestry verification failure |
| Reuse receipt after expiry | Receipt verifier failure |
| Reuse revoked receipt | Revocation-ledger verification failure |
| Issue receipt from dirty worktree | Receipt issuance or TEST verification failure |
| Hash stale pre-build dist and reuse old receipt | Build-proof/source-first digest mutation fails |
| FI-3: Reuse impacted `full-only` command | Full-escalation requirement failure |
| FI-4: Ignore unrelated material change for whole-repository command | Whole-repository selection requirement failure |
| Modify protected or explicit-exclusion path without full escalation | Scope-escalation mutation failure |
| Set `uncovered > 0` but report PASS | TEST gate rejects manifest |
| Set `unverified > 0` but report PASS | TEST gate rejects manifest |

## 21. Performance targets

Targets should be expressed by Story risk tier, not as one universal SLA.

| Story class | Initial target |
|---|---:|
| Docs/small local, DYN-3 eligible | 3–8 minutes |
| Ordinary feature that selects no gate-tier/exclusive heavy command | 6–12 minutes |
| Quorum/review-pass-touching Story before DYN-5 | 15–20 minutes |
| One heavy affected domain after DYN-5 | 11–16 minutes |
| Shared gate/core | 15–22 minutes |
| Validation infrastructure | Full plan; approximately 20+ minutes until sharding improves it |

Program-level target:

```text
median DYN-3-eligible low-risk Story: 8–12 minutes
P75 DYN-3-eligible low-risk Story: 12–15 minutes
high-risk/full Story: 15–22 minutes
```

The percentile population is limited to Stories admitted by `enforce-low-risk`; full-escalated Stories are reported separately and may not be removed from program-level reporting. The 12–14 minute range is suitable as a post-DYN-5 challenge target for the eligible ordinary-Story distribution. It is not an honest worst-case commitment and does not apply to quorum/review-pass-touching Stories before sharding.

## 22. Observability requirements

Persist the following for every dynamic validation:

```text
selection manifest
selection digest
inventory/catalog/graph digests
base/HEAD graph build time and cache status
closure certificate set and undeclared runtime inputs
canonical full-baseline epoch
build proof digest
receipt expiry and revocation-ledger digest
changed-file manifest
per-command reasons
executed/reused/unverified/uncovered counts
receipt verification outcomes
full-escalation reasons
scheduler timeline
CPU weight timeline
resource claim/acquisition timeline
process launch count
temp/lock/ticket/quarantine cleanup summary
```

Required operator output:

```text
why a command ran
why a command was reused
which receipt was reused
why the plan escalated
whether dynamic authority was accepted or only observed
```

## 23. Rollback

The implementation must have a simple policy rollback:

```text
validation.dynamic.mode = "off" | "observe" | "shadow" | "enforce-low-risk"
```

Rollback rules:

1. `off`: current full validation behavior.
2. `observe`: compute selection; execute full; selection is advisory.
3. `shadow`: execute/verify dynamic first; execute full; full is authoritative.
4. `enforce-low-risk`: dynamic authority only for accepted low-risk classes.

Any catalog, graph, receipt, or gate incident can return the project to `off` without changing Story evidence semantics.

## 24. Resolved pre-enforcement decisions

These are normative decisions, not optional research questions. DYN-3 must expose one blocking `enforcementPrerequisites` row per decision and refuse authority unless every row passes.

1. **Baseline source:** reuse authority originates from a canonical complete PASS produced for the exact main content-tree, inventory, catalog, closure implementation, runner, and toolchain epoch. Story receipts may supplement that baseline only when their source HEAD is a trusted ancestor in the same epoch.
2. **Expiry:** receipt reuse expires after 24 hours by default. Initial enforcement may configure a shorter duration, never a longer one. Exact digests do not override expiry.
3. **Environment identity:** bind PATH resolution, Node/platform/arch, package-manager/compiler versions, command-specific declared variables, and every environment field consumed by the command. Environment-read tracing is stored in `ValidationClosureCertificate.environmentAccessDigest`; unknown keys are listed in `undeclaredObservedEnvironmentKeys` and invalidate the certificate. The receipt separately binds the exact execution environment through `executionEnvironmentDigest`.
4. **Whole-repository scanners:** any command whose scan cannot be bounded uses `closurePolicy=whole-repository`; any material Story change selects it. The catalog verifier maintains the explicit list.
5. **Process-fact bindings:** every gate-consumed producer/consumer edge must come from the canonical process-fact registry and be included in the closure certificate. Missing registry projection makes the certificate unverified.
6. **Changed test implementation:** always execute the changed test and every validation command that consumes its output artifact, registry row, fixture, generated manifest, or sentinel result.
7. **Generated dist handling:** source closure and compiler identity determine selection. Wave 0 always builds; the authoritative manifest is finalized after a signed build proof. Stale pre-build dist cannot authorize reuse.
8. **Build reuse:** build is always executed in dynamic-authoritative v1. Reusing build requires a later independently audited design.
9. **Initial enforce population:** only docs/local risk-tier Stories with zero scope violations, zero unverified closure certificates, no gate/full-only impact, and no full-escalation reason.
10. **Periodic full validation:** every main content-tree epoch eligible for reuse requires one canonical full baseline. A Story whose merge-base epoch differs from the current canonical baseline cannot mix epochs or reason across the drift: it must sync/rebase to the current epoch or execute the complete plan and establish a new eligible baseline according to policy. While enforce is enabled, current main also receives a scheduled full audit at least every 24 hours. Missing or expired baseline forces full execution.
11. **Revocation:** use an append-only signed receipt-revocation ledger keyed by receipt ID and optionally command/catalog epoch. Selection and TEST bind the current ledger digest and reject revoked receipts.
12. **Catalog ownership:** adding or changing a validation command requires its catalog entry, closure certificate regeneration, catalog verifier PASS, mutation coverage, and independent scope/quality review. An unregistered command blocks both full and dynamic validation-plan construction.

```ts
interface DynamicEnforcementPrerequisites {
  baselineCurrent: boolean;
  expiryPolicyActive: boolean;
  environmentPolicyComplete: boolean;
  wholeRepoScannersClassified: boolean;
  processFactBindingsComplete: boolean;
  changedTestPropagationVerified: boolean;
  sourceFirstBuildProofActive: boolean;
  buildAlwaysExecuted: boolean;
  storyRiskEligible: boolean;
  periodicFullPolicyActive: boolean;
  revocationLedgerCurrent: boolean;
  catalogOwnershipGatePassed: boolean;
}
```

Authoritative dynamic validation requires every value to be `true`. Missing fields are `false`, not advisory.

## 25. Recommended implementation order

1. Extract and sign the canonical Story changed-file manifest with base/HEAD dual-graph handling.
2. Build the `N`-command catalog, closure-certificate generator, runtime tracer, and completeness verifier from the kickoff inventory digest.
3. Implement deterministic union-based three-state impact selection, scope escalation, and `full-only` semantics.
4. Run observe-only historical replay plus per-catalog-entry dependency fault injection.
5. Add source-first per-command receipts bound to baseline epoch, ancestry, clean tree, build proof, expiry, and revocation.
6. Run shadow reuse while full validation remains authoritative and measure warm/cold graph performance.
7. Implement and mechanically gate every Section 24 enforcement prerequisite.
8. Enable low-risk dynamic TEST authority only after zero-false-negative evidence and re-audit.
9. Add CPU weights, LPT ordering, and refined dist resources.
10. Split quorum and review-pass before applying 8–12 minute targets to Stories that may select those domains.
11. Expand dynamic authority only after a new audit and continued periodic full-oracle equivalence.

## 26. Final acceptance statement

This program is complete only when an auditor can mechanically answer all of the following for a dynamic PASS:

```text
What changed in the Story?
Which validation commands were selected and why?
Which commands were reused and from which receipts?
Which certified source closure proves each reused command independent of the Story change?
Why are the reused receipts still admissible?
Does the ledger cover the complete current inventory?
Is unverified zero?
Were all pinned Story verifiers executed?
Were any changes unmapped or ambiguous?
Were deleted and renamed paths evaluated against both base and HEAD dependency graphs?
Were scope-protected, out-of-scope, or explicitly excluded paths changed?
Did the plan correctly escalate when high-risk infrastructure changed?
Does the signed manifest bind the current HEAD, base, catalog, inventory, dual graph, closure certificates, build proof, baseline epoch, revocation ledger, and toolchain?
Are receipts ancestry-compatible, clean-tree generated, unexpired, and unrevoked?
Does a complete validation run produce the same final verdict?
Did execution leave zero temp/process/lock/ticket/quarantine residue?
```

If any answer is unavailable, dynamic validation must not claim authoritative PASS.

## 27. Independent audit record and remediation trace

### 27.1 Audit executions

| Auditor | Version | Verdict | Disposition |
|---|---:|---|---|
| Claude CLI | 2.1.220 | Conditional Pass | Findings incorporated; re-audit required |
| Agy CLI | 1.1.13 | Fail | Critical/high findings incorporated; re-audit required |

### 27.2 Remediation mapping

| Stable ID | Audit finding | Revision 2 remediation |
|---|---|---|
| AUD-R2-01 | Trigger/input dual under-declaration can reuse a stale PASS | One certified closure derives triggers and input authority; runtime undeclared inputs invalidate the certificate; `unverified` is explicit |
| AUD-R2-02 | Ledger completeness is tautological | Three-state accounting plus independently recomputed closure disjointness; reuse requires independence proof |
| AUD-R2-03 | Pre-build stale dist can poison input digest | Source-first closure; build always executes; authoritative manifest finalizes after signed build proof |
| AUD-R2-04 | Deleted files disappear from HEAD graph | Base/HEAD dual graph; delete uses base, add uses HEAD, rename uses both |
| AUD-R2-05 | Selection monotonicity is prose-only | Union-of-singleton construction and runtime singleton-union verifier |
| AUD-R2-06 | Scope/protected violations not mandatory full | Scope violations are manifest rows and mandatory full triggers |
| AUD-R2-07 | Cross-branch/dirty receipt reuse | Trusted ancestry, baseline epoch, clean-tree proof, expiry, and revocation ledger |
| AUD-R2-08 | `full-only` lacks semantics | Impacted full-only forces full; unimpacted reuse only from exact canonical full baseline |
| AUD-R2-09 | Historical recommendations break determinism | Signed recommendation snapshot digest or non-authoritative exclusion from manifest |
| AUD-R2-10 | Receipt lookup order ambiguous | Deterministic best-matching admissible PASS lookup with tie-break |
| AUD-R2-11 | Dependency graph `<2s` target unsupported | Content-addressed incremental cache; warm/cold metrics separated; enforce requires measurement |
| AUD-R2-12 | Historical replay does not prove catalog completeness | Per-entry static/runtime/fact fault injection added |
| AUD-R2-13 | Early performance targets overclaim | Eligible population and pre/post-sharding bands explicitly separated |
| AUD-R2-14 | Open questions not gate-bound | Section 24 converted to twelve normative blocking prerequisites |

### 27.3 Re-audit gate

Implementation must not begin from this revision solely because findings were textually addressed. Re-run both independent auditors against Revision 2. Proceed to DYN-1 only when:

```text
no open critical finding
no open high soundness finding
all remaining medium findings have explicit owner and non-blocking rationale
the two auditors agree that observe-only implementation is safe to begin
```

### 27.4 Revision 2 re-audit and Revision 3 changes

| Auditor | Revision 2 verdict for DYN-1 | Remaining issue | Revision 3 disposition |
|---|---|---|---|
| Agy CLI 1.1.13 | PASS; no critical/high | Deleted-path marker clarity; explicit full-only assertion; full-escalation TEST wording; warm/cold telemetry | All incorporated |
| Claude CLI 2.1.220 | PASS for DYN-1; one HIGH blocking future TEST authority | Full-only exact canonical-baseline reuse lacked schema provenance and an enforceable branch | Added catalog policy, certificate/receipt provenance, explicit selection branch, TEST gate clause, mutation coverage |

Additional Claude medium items incorporated in Revision 3:

```text
environmentAccessDigest and undeclaredObservedEnvironmentKeys
FI-1 through FI-5 traceability between replay and mutation matrix
baseline epoch versus Story merge-base drift rule
DYN-1 instrumentation resource-isolation criteria
```

### 27.5 Imported Revision 3 final dual re-audit claim

| Auditor | Imported verdict claim | Critical/high claim | Repository import claim |
|---|---|---|---|
| Agy CLI 1.1.13 | DYN-1 observe-only PASS | None | APPROVE |
| Claude CLI 2.1.220 | DYN-1 observe-only PASS | None | APPROVE |

The imported artifact stated that Agy retained two non-blocking implementation observations: measure cold-cache graph construction separately and isolate trace output from command stdout/stderr/backpressure. It also stated that Claude retained two fail-safe documentation mediums: inline the historical snapshot gate and make `fullBaselineReusePolicy` structurally required. The import did not preserve invocations, timestamps, responses, or an audited artifact digest, and its claimed final edit changed the bytes after those reviews. These rows are therefore historical provenance claims, not repository-native authorization. Section 27.6 is the superseding evidence record for the exact payload in this repository.

The remaining Agy observations are DYN-1 acceptance obligations, not architecture blockers:

```text
record warm_graph_build_ms and cold_graph_build_ms independently
trace via isolated sidecar descriptors or equivalent non-interfering transport
prove instrumented and uninstrumented full-run verdict/order/resource equivalence
```

Revision 3 is approved for repository import as a design record. The exact repository payload may begin DYN-1 observe-only only when Section 27.6 contains two digest-bound PASS/APPROVE rows for that payload and kickoff discovery confirms the current inventory and implementation touchpoints. Sections 19, 20, and 24 remain blocking for any later transition.

DYN-3 dynamic TEST authority: GATED — this document does not approve or grant it.

### 27.6 Repository-native audit evidence

This section is an append-only evidence envelope, not part of the audited payload. The audited payload is the exact UTF-8 byte prefix before this heading, including the newline immediately before the heading. This avoids a self-referential digest while ensuring any change to Sections 1–27.5, including the status and implementation boundary, invalidates the recorded audit.

Recompute the payload digest from the repository root:

```bash
node -e "const fs=require('fs'),c=require('crypto');const p='docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md';const marker='### 27.6 Repository-native audit evidence';const t=fs.readFileSync(p,'utf8');const i=t.indexOf(marker);if(i<0)process.exit(1);process.stdout.write('sha256:'+c.createHash('sha256').update(t.slice(0,i)).digest('hex')+'\\n')"
```

| Evidence field | Verdict | Authority |
|---|---|---|
| Audited payload SHA-256 | `sha256:c26f2da7cb9167dad8339e6d83727f20d5a0895880beaff92a510588d4f30806` | Recomputed from the current exact UTF-8 prefix with the command above |
| DYN-1 observe-only disposition | PASS | APPROVE |

| Auditor | Version | Executed UTC | DYN-1 verdict | Repository import | Response digest |
|---|---:|---|---|---|---|
| Agy CLI | 1.1.14 | 2026-08-19T01:35:09Z | PASS | APPROVE | `sha256:397df03f0e9b5242377b8b1b30f7b26fefa8ad2136987f1b5639aa318e80a6c9` |
| Claude CLI | 2.1.220 | 2026-08-19T00:34:33Z | PASS | APPROVE | `sha256:06eeaa1960ce42dedaca6bf4729840cdffcf88358395d0ca946de456a96a61cd` |

The raw response digests above cover the complete JSON envelopes emitted by each CLI. The repository-relative transcripts below preserve each structured verdict; the raw envelopes additionally contained transport/session/usage metadata but no different verdict. Their recorded `sha256:67b246...` payload value is historical provenance for the 2026-08-19 audit and is not the current payload authority; the current recomputed prefix digest in the evidence table above is authoritative. A PASS is inadmissible if either response names a different payload digest, reports an open critical/high soundness finding, or declines DYN-1 observe-only/repository import approval.

#### 27.6.1 Shared audit prompt

Both auditors received the same decision question and exact payload digest. Claude read the repository file and recomputed the prefix digest with the command above. Agy received the exact prefix bytes inline in a fresh project because the repository permission hook rejects nested Agy tool calls; its one-turn response therefore used no repository tools.

```text
Act as an independent architecture auditor. Do not edit any file. Audit the exact UTF-8 prefix before the heading Section 27.6 Repository-native audit evidence. The expected payload digest is sha256:67b2466c324242615edd75b811150a0965100a74130f30d729ad7735a780c466. Verify or consume that exact digest and fail on mismatch. Determine whether the payload safely serves as design authority for a later, separate DYN-1 observe-only implementation Story. Check that the unmerged story/B-7dff and 350e939 snapshot plus 110-command count are historical rather than current authority; all normative inventory requirements use kickoff-derived N; ValidationCommandReceipt carries buildProofDigest and inputDigest/reuse binds it; all fourteen remediation rows remain; DYN-3 stays fail closed; and no runtime implementation is claimed. Return auditor/version/time/payloadDigest, DYN-1 PASS or FAIL, repository-import APPROVE or REJECT, critical/high findings, medium observations, and a summary. PASS and APPROVE are allowed only when critical/high findings are empty.
```

Invocation forms:

```text
Claude: claude -p --permission-mode plan --allowedTools Read Bash --output-format json --no-session-persistence --max-budget-usd 5 <shared-prompt>
Agy:    agy --new-project --disable-slash-commands --dangerously-skip-permissions --output-format json --print-timeout 10m -p <shared-prompt-plus-exact-payload-bytes>
```

The Agy permission bypass applied only to its isolated fresh-project process; the supplied prompt prohibited tools and edits, and the emitted envelope recorded a one-turn text-only audit. It did not grant any repository mutation authority.

#### 27.6.2 Agy transcript

```json
{
  "auditor": "Antigravity Architecture Auditor",
  "cliVersion": "1.1.14",
  "executedUtc": "2026-08-19T01:35:09Z",
  "payloadDigest": "sha256:67b2466c324242615edd75b811150a0965100a74130f30d729ad7735a780c466",
  "dyn1Verdict": "PASS",
  "repositoryImport": "APPROVE",
  "criticalHighFindings": [],
  "mediumObservations": [],
  "summary": "Historical candidate counts are non-normative and current inventory is kickoff-derived N; buildProofDigest is bound by the receipt contract and reuse predicate; all fourteen remediation mappings remain; DYN-3 is gated; no runtime capability is claimed."
}
```

#### 27.6.3 Claude transcript

```json
{
  "auditor": "Claude (Anthropic, Sonnet 5), repository-native ad hoc audit distinct from the imported historical row",
  "cliVersion": "2.1.220",
  "executedUtc": "2026-08-19T00:34:33Z",
  "payloadDigest": "sha256:67b2466c324242615edd75b811150a0965100a74130f30d729ad7735a780c466",
  "dyn1Verdict": "PASS",
  "repositoryImport": "APPROVE",
  "criticalHighFindings": [],
  "mediumObservations": [
    "DYN-1 observe-only authority remains conditioned on kickoff-time discovery of current inventory N, scheduler location, and touchpoints.",
    "Repository import remains prospective until this Story is merged."
  ],
  "summary": "The embedded digest recipe reproduced the expected payload digest. Live git confirmed the candidate snapshot is historical, normative formulas use N, buildProofDigest is bound into input/reuse, fourteen remediation rows remain, DYN-3 is fail closed, and the Story contains no runtime-source change."
}
```
