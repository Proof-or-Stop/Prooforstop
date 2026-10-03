# Production validation execution and repair entry

Validation capacity preserves the literal keys of machine CPU, process,
validation-barrier and fixed-port claims. Filesystem claims are resolved against
the command working directory. Whole-invocation declarations and per-command
stages use the same normalization after validating the original claims; malformed
keys, access modes and ownership remain errors. This preserves existing machine
admission identities and limits across worktrees.

Official `validate` and `done_required_validate` retain independent acceptance,
freshness, resource, owner and build-proof checks. These changes optimize the
execution mechanisms; they do not turn Lab records into Story evidence.

## Dynamic-tier fail-closed widening matrix

The selector may reduce work only when every changed material path and every
omitted command has positive coverage. The following matrix is the exact
operator-facing reason-code contract. Adding or removing a row requires the
runtime table and its bidirectional regression to change in the same commit.
For the shipped runtime, this operator guide is authoritative for the exact
reason-code, outcome, and condition text under the accepted authority decision
`docs/requirements/decisions/validation-widening-matrix-authority.md`. The
branch-owned
`docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
matrix remains design context and does not override this executable contract.

| Condition | Effective result | Reason code |
|---|---|---|
| Changed-file discovery fails | Repository-full | `changed_files_unavailable` |
| Evidence hash snapshot (head, material or story-files digest) cannot be captured or is incomplete | Repository-full | `hash_snapshot_unavailable` |
| Material path is unclassified | Repository-full | `unclassified_material_input` |
| Index missing, stale, malformed, or digest-invalid | Repository-full | `impact_index_unusable` |
| Base index cannot be completely projected to current HEAD | Repository-full | `impact_projection_incomplete` |
| Material worktree overlay cannot be completely read or changes during plan/execute double-read | Replan; repeated movement widens to repository-full | `workspace_snapshot_changed` |
| Command-set or selector policy digest changed | Repository-full | `selection_policy_changed` |
| Declared repository-full process-fact floors cannot be read completely or no floor is declared | Repository-full | `validation_floor_registry_unavailable` |
| A legacy validation-machinery pattern or a declared repository-full process-fact path changes | Repository-full | `validation_framework_sensitive_change` |
| Story risk policy marks the change as high-risk | Repository-full | `story_risk_signal_present` |
| Package manifest, lockfile, build graph, or shared compiler configuration changes | Repository-full | `build_graph_change` |
| Dynamic import/subprocess/generated edge unresolved | Repository-full | `runtime_edge_unresolved` |
| Explicit command pin does not resolve | Stop; no PASS artifact | `pinned_command_missing` |
| Legacy free-form evidence command normalizes to no command in the validation inventory | Repository-full | `pinned_command_non_inventory` |
| Legacy pin resolves to multiple command IDs | Stop; no PASS artifact | `pinned_command_ambiguous` |
| Any configured command lacks a positive current-head exclusion proof | Repository-full | `command_exclusion_unproven` |
| Requested tier uses fallback discovery or an opaque validate-file without a decomposition adapter | Atomic repository-full | `source_kind_atomic` |
| Source kind is no-validator | Preserve no-validator compatibility; no validation tier can PASS | `no_validator` |
| No material changes and no explicit docs/no-op policy | Stop; no PASS artifact | `empty_selection_unclassified` |
| Docs-only changes with a registered docs policy | Run that docs policy | `docs_only_policy` |
| Selected set exceeds target duration | Report only; never remove a command | `duration_target_exceeded` |

Dynamic Finding is one explicit process-fact floor, not a filename heuristic.
The current registry contract implements exactly one floor value,
`repository-full`; adding another floor requires its own selector semantics and
cannot be implied by extending a value list.
Its four signed producer commands, semantic verifiers, and lifecycle consumers
map to concrete repository paths in the process-fact registry. Changing any of
those paths forces `repository-full`; unrelated L4 implementation such as
provider process admission remains eligible for ordinary relevance selection.
An absent floor mapping leaves the registry loadable; its empty projection makes
the selector widen with `validation_floor_registry_unavailable`. A present floor
declaration with malformed or empty paths is instead refused while the registry
module initializes, before any selector can return a tier decision. Both paths
fail closed, but they intentionally fail at different layers.
This floor governs the explain-only selector's effective tier
(`finalAuthority: false`); by itself it does not change which validation commands
execute while dynamic selection remains in observe mode.

## PRE_CERT execution order

Finalized-inventory guidance follows the signed receipt authority on first
finalization, status, a refused duplicate begin, and exact finalize retry.
`review-remediation-only` leads to DEV. `inventory-completeness-only` with no
retained finding families leads to the fast PRE_CERT preparation below, without
an automatic DEV detour. A saturated inventory that retains findings leads to
`finding_list`: zero new families does not prove that old findings are resolved. The hint
does not grant TEST or PRE_CERT authority: existing freshness, findings,
coverage and certification gates still decide admission. Consumed receipts lead
to the current session brief: legacy saturated receipts do not record whether
remediation or PRE_CERT consumed them. Invalid or mismatched receipts cannot supply advice.

In REVIEW, finalize the saturated review inventory, then run
`proof-or-stop validate --story=B-example --focus=fast --json` to publish a
signed cheap-check receipt for the resulting HEAD. Run
`proof-or-stop certification_window_begin --storyId=B-example` after that check.
Admission reconstructs the same current command identity as execution. Changed
environment, executable, timeout, policy or entrypoint invalidates the cheap
receipt even when HEAD is unchanged; unavailable identity fails closed.
The admitted window permits one routine `proof-or-stop validate --story=B-example --json`
execution. This includes dynamic execution and explicit full validation, even
when full is combined with focus. An exact reusable current PASS starts no child
and consumes no additional execution claim.

The REVIEW-to-TEST gate consumes the signed current routine PASS. Missing, failed,
stale or tampered evidence blocks TEST before any validation child starts. Return
to DEV for repair and follow the reported PRE_CERT recovery. A consumed window
cannot authorize unchanged failed-suite retries. Focused preparation remains
available. DONE-required validation keeps its own policy, evidence and capacity
checks and requires a current PRE_CERT window; it does not consume the routine
suite's execution claim.

Session and transition hints follow this order. When a certification window
already exists, inspect its status and recovery command before starting another;
session status alone does not establish that its evidence is current. In REVIEW,
certification status checks the same signed PASS, coverage and freshness inputs
as the TEST gate and recommends entering TEST once they pass. A consumed RUNNING
window alone is not evidence that a validation process is still executing.

## Identical command results

A structured command in `validate.commands` or `doneRequiredCommands` may opt in
with `"executionReuse": "exact-inputs"` and `"executionInputs": []` when all inputs
are tracked material. List every generated or external input file in
`executionInputs` otherwise; these file bytes and real paths also bind the receipt.
An absent declaration never enables reuse. Both consumers must declare the same
execution policy. Labels, optionality and profile selection remain consumer
properties; executable/argv/cwd, timeout, environment, tool version, material,
Story inputs and resource policy bind the shared execution identity.

Only signed causal PASS receipts are reusable. The workspace must be clean and
inputs must remain unchanged before consumption and publication. Failure,
truncated output and worktree pollution cannot publish a reusable PASS. Tampered
receipts are refused. A reused result records the original receipt and execution
time, and is not counted as a new child execution. Dynamic validation retains
its existing trace-based path; shared execution uses dynamic mode off or an explicit
validate.sharedExecution option independently of selection mode. No existing command is automatically opted in.

Workspace checks exclude only exact CAS receipt paths whose signatures, Story
identity and content addresses verify, plus an index whose entries all resolve
to those verified receipts. Publishing these outputs cannot stale their own
execution inputs. Unknown files and invalid receipts remain workspace pollution;
explicit input bytes remain bound even when an input is also a receipt output.

`fullBaselineReusePolicy: forbidden`, `closurePolicy: never-reuse`, gate and
validation-infrastructure risk classifications, and build-proof consumers or
producers always execute. This change does not relax existing forbidden policies.

## Capacity and long commands

In this Lab, configured official validation plans hold their workspace guard
and Story lock for the entire invocation. Shared repository capacity is acquired
for preparation/publication and separately for each command. Safe commands in
different worktrees may overlap; an undeclared command retains conservative
global exclusion for its execution stage. Custom/selective validators retain the
whole-invocation fallback. Nested DONE preparation retains the workspace/Story
protection across routine and DONE-required validation.

Command claims are normalized and deduplicated independently of the invocation's
workspace claim. This avoids dropping a command's only claim when it matches the
workspace. Conflicts remain exclusive, at most two invocation groups share
capacity, and legacy readers fail conservatively on newer ticket declarations.
Cancellation and exceptional plan exits cannot publish with a lost capacity token.

Cooperating StoryStore metadata writers receive `VALIDATION_METADATA_BUSY` while
another validation owns the Story lock. They may retry after it releases; the
refusal does not automatically commit their data. Checkpoint, durable output and
pending-publication methods retain their existing identity checks inside this
guard. This does not provide atomicity for arbitrary external filesystem writes.

Official Story validation renews an existing same-owner lease every 30 seconds,
including capacity wait time. Acquire, refresh, release and takeover use one
mutation lock and atomic file replacement. A generation nonce fences old timers;
missing, expired, released or transferred leases are never acquired by heartbeat.

## Start repair after one complete review wave

After all required lanes and the independent completeness critic have produced
current structured evidence, use:

```bash
proof-or-stop review_inventory_finalize --storyId=B-example --remediation
proof-or-stop story_advance --storyId=B-example --phase=DEV
```

New findings do not require a second saturation wave before repair. The signed
`review-remediation-only` receipt retains the finding set, binds the current
cutoff and live aggregate, is consumed once, and cannot enter certification or
TEST. It does not close or dismiss findings. Finalize without `--remediation`
retains the explicit saturation requirement. TEST and DONE still require their
normal current evidence and blocker resolution.

## Verification and limits

Run `node scripts/verify-performance-production.mjs`. The existing registered
validation execution-lock suite also runs these regressions. The regression uses disposable Git
repositories and fixtures, real command execution, cross-process capacity,
lease loss/generation controls, receipt tampering and signed inventory replay.
Existing validation-lock, DONE-required and inventory CLI suites provide the
integration controls. Earlier measurements apply only to their identified workloads. Stage percentages
may not be added; no universal 48% or Story-wide speedup has been established.

## Evidence hash accuracy

The shared material policy excludes the evidence store's defined object, ref and
observation outputs so publishing them does not invalidate their own input hash.
Their independent integrity and subject checks remain required. Unknown evidence
paths and policy files remain material. The Story changed-file resolver preserves
NUL-framed Git names when looking up blobs, including Unicode and control
characters. See [the hash decision](requirements/decisions/story-files-hash-material-drift.md)
for migration boundaries and the independent oracle regression. This correction
carries no percentage performance claim.

Shared execution signs the complete executor capture, independently of the
bounded prefix/suffix shown to users. Output beyond the 12,000-character selector
window produces a partial, non-reusable receipt; an exactly 12,000-character
complete result remains eligible. The v2 complete-capture execution identity
prevents earlier display-derived receipts from being consumed after this repair.

### Provider contract scheduling

Canonical validation invokes `provider-process-registry-smoke` with
`--provider-launch-owner-admission-child` and `managed-host-run-smoke` with
`--canonical-core`. Those entry variants execute their own contracts only;
`host-run-usage`, `dispatch-run`, `provider-claude`, managed process cleanup and
managed caller-death checks are independent configured commands. The original
standalone invocations retain their complete combined proofs and selectors for
existing pinned receipts. Canonical variants emit distinct core selectors.
`verify-flat-provider-validation.mjs` observes real child-process boundaries and
rejects a canonical entry launching another registered command; it also checks
that every former nested provider contract remains independently scheduled.

Registration mutation probes use the CHK-007 receipt's `--registration-only`
entry to exercise its population/config/exclusion rule in private mirrors.
That entry emits registration evidence only; it does not run or claim the
historical invariance and silent-prefix receipts. The default CHK-007 command
retains every original proof obligation and remains registered unchanged.

The legacy review-round stall check recognizes a measured blocker reduction
within its trailing comparison window. A plateau followed by a decrease, such as
`[2,2,1]`, no longer blocks DEV to REVIEW. Flat or rising counts retain the stall
diagnostic. This bounded correction is not a substitute for signed completed-epoch
progress accounting; activity counts and provider heartbeats do not prove progress.

U-11 now records tool-owned progress observations at explicit review inventory
begin and independent full-wave finalization. The signed journal binds completed
epochs, current verifier-derived coverage and pass lanes, and authenticated
Finding outcomes. Status comparisons do not write observations. Legacy unsigned
Finding metadata and compatibility dismissal cannot prove repair. A later signed
cancellation preserves the observed completion history and interrupts consecutive
stagnation. Zero-wave compatibility receipts do not count as completed reviews.
Unavailable progress is reported explicitly without undoing a valid inventory
publication. Both CLI advance/takeover and machine REVIEW mint now consume this same signed
progress decision. Two complete stagnant epochs request a human decision; raw
advance, takeover, review-run and round counts remain diagnostics. Live verified
progress releases a stall. Corrupt new authority is a distinct integrity block.
Human continuation uses interactive story_resume with acknowledgement and a reason;
the signed decision resets the comparison boundary and preserves history.
Compatibility stall_resolution_set records do not release this new gate; their
checklist withdrawal behavior remains available.

Mechanical coverage gains also require the actual CAS execution receipt, matching
command and selector pin, output digest and source identities. Missing receipt
objects and dirty material produce unavailable observations, never a claimed
coverage gain. Remediation uses the same execution-authority verifier. Legacy
compatibility coverage remains governed by the existing coverage policy.

### Managed burn and verified progress

Managed workers observe only complete bounded canonical provider stdout usage events.
Their token lower bound is the largest validated event, including reported cache
input once; replayed events are not summed. Transcript size, tool text, heartbeat,
and estimated token counts never authorize a cost stop. The submitter seals
`PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT` (positive integer; default 100000000) in the
managed spec. Changing the worker or provider environment cannot change that limit.

When this limit is exceeded, the supervisor checks the same signed completed-epoch
progress authority used by convergence gates. Only two verified complete stagnant
epochs authorize `cancelled / burn_without_effective_progress`. Current net progress,
missing history, projectless execution, or unavailable progress yields an advisory;
no independent review requirement is waived. Normal TERM/KILL/reap and replacement
safety still apply. Actual child close fences further burn requests before any
asynchronous descendant cleanup completes. Explicit startup/total/absolute deadlines remain finite and
retain their distinct terminal reasons. A burn stop never redispatches a replacement.

### Exact prompt bodies and slim review history

New full-envelope review runs persist `assembledPromptRef` equal to their signed
`promptHash`. Exact UTF-8 bodies live once per digest under the Story's
`prompt-bodies/` directory and are published before the run reference. Existing
objects are checked rather than overwritten. Ordinary `readReviewRuns` reads only
metadata; review gates, incremental eligibility and managed reviewer launch use
`readReviewPrompt` to load and hash-check the body. Envelope and canonical assembly
verification remain required. Missing, corrupt or conflicting references fail
closed. Legacy inline records remain readable and are not migrated by a read.

The owner can run `review_prompt_gc --storyId=B-xxxx` in DEV, REVIEW or TEST
to reclaim orphan prompt bodies. Collection shares publication locks, retains
all historical run/envelope references, and refuses corrupt metadata, missing
referenced bodies or dangling terminal references before deleting anything.
It never prunes signed metadata or migrates legacy inline history.

### Epoch metadata commits

Native and managed reviewer results inside an OPEN inventory epoch retain their
individual signatures and are written before success is reported. Their Git
commit is deferred until `review_inventory_finalize` or `review_inventory_cancel`.
Finalization commits only the explicit review artifacts and referenced prompt
bodies using an isolated index, normal hooks, verified bytes and a HEAD
compare-and-swap. Unrelated staged files remain untouched. A failed commit leaves
the signed results intact: retry the original finalize or cancel command without launching reviewers again. Preserve `--remediation` for repair-only receipts and the original reason for cancellation; retries cannot change receipt authority or rewrite cancellation history. Ordinary CLI telemetry alone never triggers another epoch commit.
Outside an eligible epoch, the existing immediate-commit behavior remains.

Historical incremental eligibility replays every Git/freshness probe at the
signed run commit. Later material changes do not rewrite that historical choice.
Current reviewer admission still checks live material and scope independently;
requested-full envelope verification also retains its explicit live-material
check. Historical replay is never a substitute for current gate admissibility.

Canonical RED target-binding, envelope, and W2B wiring validation use
`--canonical-core` to retain their own assertions while independently scheduled
lifecycle-registry and command-ownership commands cover the ordinary registry
checks. The W2B private-copy registration-removal probes still run both contracts:
those executions prove mutation detectability, not repeated baseline validation.
No-argument invocations retain their complete legacy receipts. Canonical output
explicitly identifies the narrower execution instead of claiming the full receipt.

Host-run usage canonical validation retains all 85 core checks, its four
extension checks, and the candidate-overflow boundary. It leaves the already
registered managed watchdog contract to its own canonical entry. The no-argument
command still runs both evidence-mapping boundaries and emits its original
83/85-check compatibility selectors; canonical mode emits only a distinct core
selector and never represents itself as that full historical receipt.

CHK004 and CHK005 canonical receipts retain their own clean-input controls,
envelope/quarantine checks, direct-injection totality and historical minimal-guard
comparison. Their ordinary v1 invariance child runs once as its independent
canonical command. Distinct required canonical markers cover each retained
clean-input assertion, so skipping the child cannot manufacture its digest or
its legacy combined receipt. No-argument receipts retain the original digest
execution and all pinned markers.

CHK007 canonical mode compares the current invariance pin against the historical
baseline Git blob and keeps its malformed-input and registration controls; the
independent invariance command executes the live verdict comparison. CHK009
canonical mode retains its own same-bytes bypass/validated-boundary differential,
while the independent artifact command owns the permutation and exhaustive
quarantine matrix. Both modes emit distinct required evidence for what they
actually execute. The full no-argument receipts retain their combined proofs.

The two excluded pre-fix attestations (CHK001 and CHK010) remain an explicit
property-test exception under CHK007: each must observe the live artifact result
and emit no obsolete failure receipt on the fixed tree. The nesting probe permits
only those exact parent paths and the single artifact argument. This retains
CHK007's silence proof, alongside the existing CHK011 same/different-seed proof;
registration-only probes still never execute these complete receipts.

The readonly command canonical check still resolves the real envelope validation
entry and checks its command/argv/timeout contract. It exercises the real
validation executor with a tiny scratch workload that verifies cwd and literal
arguments, emits stdout/stderr, and fails on a negative-control argument. This
retains executor observation without rerunning the envelope suite. Its default
entry preserves the original complete pipeline invocation and receipt.

The U18 static audit of the configured command array retains these
property executions explicitly:

| Parent | Retained execution | Reason |
| --- | --- | --- |
| W2B/W2C wiring contracts | Registry contracts with removed registration | The mutant must fail for the named missing registration. |
| Proof-admissibility registry smoke | Reviewer/dispatch/managed contracts in private mutated dist | Detect a removed admission guard against its baseline. |
| B49d4 registration derivation and CHK002 receipt | Real registration guard plus private newcomer/config mutations | Verify that the actual registration authority detects an uncovered receipt. |
| B2aa7 CHK011 | Three artifact runs | Same seed reproduces; different seed changes the generated proof inputs. |
| B2aa7 CHK007 via excluded CHK001/010 | Artifact observation in each historical attestation | Prove obsolete pre-fix attestations remain silent on the fixed tree. |

These executions are paired property controls, not independent repeated baseline
suite obligations. The runtime nesting witness covers the eleven changed
canonical parents; the static inventory review covers the whole configured array. Neither
is a claim that the entire production workload has been benchmarked.

Managed execution now starts an independent detached recovery supervisor and
waits for its readiness before launching the provider worker. It observes worker
death without status calls, uses the existing process-identity cleanup/fencing
path, and records a failed `worker_orphaned` terminal after cleanup. It also
reconciles the sealed absolute deadline independently of the owner model. This
bounded repair does not yet make every legacy status reader side-effect free.

On Darwin, `ps sess` is not a usable POSIX session ID. Cleanup records that
observation as unavailable rather than interpreting zero as a mismatching SID.
It still requires the recorded isolated spawn, PID equal to PGID, a present
original leader and its exact current start fingerprint before each group
signal. Other platforms retain the observed SID check; failed process queries,
missing leaders and identity drift remain no-signal outcomes. Supervisor lock
contention retries, and an already written terminal still triggers the existing
post-terminal prompt/scratch cleanup recovery before the supervisor exits.

The supervisor regression set also executes early-exit and readiness-timeout
faults before worker launch, a real worker SIGKILL immediately after terminal
publication, and a production mutation that skips terminal cleanup. Recovery
removes the registered scratch without changing terminal bytes; the mutation
leaves it behind. The watchdog CLI regression uses a real live provider and its
actual deadline, so cancellation ordering is never inferred from a future
injected timestamp compared against a real child-close timestamp.

## Independent liveness coverage

Routine validation registers each of the seven former liveness members exactly
once. The flow-stability and provider-codex entries use `--canonical-core`,
which retains their own assertions and emits a distinct marker while omitting
the combined seven-suite dispatch. Their default entries retain the original
complete compatibility behavior. Provider F-181 remains a real child CLI
positive/negative environment-isolation test on a disposable Story. Flow uses
the existing explicitly allowlisted test fixture namespace for its own nested
validation; production capacity admission is unchanged.

`node scripts/verify-liveness-validation-union.mjs` checks the fixed historical
seven-member inventory against configured entries. Add `--trace` to execute
those actual entries through the production command executor and reject nested
registered-suite launches. The exact cross-host `--xhr-worker` and
`--xhr-submitter` self-dispatch modes are fixture roles and remain allowed;
plain self-invocation is rejected. The inventory check alone proves no runtime flattening;
the seven-member trace is bounded coverage, not a whole-registry trace.

## Authority changes in dynamic validation

For configured commands, `validation_plan` and the runtime selector both project
ownership from the production command catalog. The legacy
`validate.dynamic.impactIndex` option is ignored with an operator warning; it
cannot replace that ownership map. Selector completeness requires explicit
command policy and complete declared inputs. Defaulted policy stays partial,
and execution independently checks catalog ownership before granting authority.
Runtime graph, receipt and risk checks can still widen execution beyond a
requested preview tier. The atomic validate-file entrypoint carries no selector
binding and retains complete-command fallback when enforcing dynamic validation.

DONE origin routing authenticates the selection manifest for the current Story
before using its mode. A valid signature for another Story cannot suppress the
strict stored-PASS check while receipts remain. Automatic tier promotion also
rejects non-string paths and patterns without allowing an incidental TypeError
to replace the selector's classified refusal.

Dynamic runner v9 binds the canonical fast/intermediate/full selector decision
and digest into the signed execution manifest, and upgrades changes to registered gate/schema/verification
authority sources to full validation, including the full task scope inventory
validator. It also follows their source dependencies in both Git revisions, so
removing a dependency in HEAD does not erase the baseline authority relationship.
The graph identity binds authority roots, members, uncertainty and policy version.
Missing graphs, unavailable source, parse failures and opaque or unresolved
authority imports force full rather than establish an unaffected result. Graph
discovery parses real TypeScript/JavaScript module syntax, excludes registered
runtime artifacts, accepts `.mts`/`.cts`, and maps tracked `dist` imports back to
their source counterparts. JSON contents, asset imports, package aliases and
example strings are not treated as missing relative module edges.

Runner v9 is a new execution identity. Existing dynamic receipts and canonical
baselines produced by an older runner are intentionally stale; an in-flight
Story in TEST must obtain a fresh complete run before dynamic reuse can resume.

The repository measurement on the 168-command inventory produced
`graphUnknown=false` and zero resolution failures; its catalog contained 51
local, 50 shared, 2 gate and 65 validation-infrastructure rows. Risk eligibility
is evaluated over the complete live catalog. Any non-local catalog row forces
the canonical fallback and cannot disappear through a selector exclusion. This
is a reachability measurement, not a wall-time or
false-negative claim. External projects without these registered tool-source
identities do not have to recreate them. Existing final full-validation
requirements remain unchanged. The six paired fault witnesses
under `scripts/lab/u09-paired-fault` measure bounded functional detection and
command selection, not population noninferiority or external LLM review quality.

The selector's command-set identity is independently rebuilt from the current
execution inventory. Before launch, its snapshot identity is independently rebuilt
from Git using the current Story id, immutable base/head and change-manifest digest.
Stored TEST/DONE admission re-derives that snapshot from the signed manifest and
independently recomputes the dependency-graph digest from the immutable base/head;
it does not claim a second Git rebuild of the change manifest. A caller cannot make
the command inventory or dependency graph authoritative merely by re-signing a
self-consistent selector object. Graph construction and traversal use bounded
process caches for immutable revisions and commit pairs plus the catalog: the
dual-revision cache retains at most eight entries and the full source-tree cache
at most sixteen. Symbolic refs are never cached. Each revision's
TypeScript/JavaScript AST graph and reverse dependency map are built once while
affected commands are resolved once per changed file rather than once per
catalog row. Exact identity, eviction, moving-ref and call-count tests protect
those bounds; this is a complexity boundary, not a repository wall-time claim.

Configured `inputRoots` are the declaration that can establish complete
selector exclusion ownership. The impact index matching surface is the union of
those roots with the registered `runnerSourcePath` and `caseRegistryPath`, so a
runner or case-registry change selects its command directly instead of becoming
an unclassified repository-wide change. Those registered direct triggers do not
independently upgrade a partial declaration to complete coverage. Runtime
closure uses the same union; an empty non-authoritative declaration falls back
to heuristic runtime roots but never becomes complete selector ownership.

The twenty compatibility package entrypoints now dispatch twenty distinct
mode-specific executable assertions over the corresponding manifest,
graph/scope, receipt, oracle, authority, or scheduler object. They no
longer prove a mode by relabeling one unconditional tail marker. The `test-gate`
and `test-gate-mutations` modes also rebuild runtime output and cross the real
TEST and DONE consumers. These
package scripts are not twenty configured `validate.commands` rows, so Story
selection does not execute them as twenty validation units.

## Whole-array nested execution guard

Routine validation now registers `scripts/verify-validation-static-edges.mjs`.
It inspects every configured entry (153 at adoption), expands the supported npm
script forms and follows bounded fixture/helper imports. Unsupported expansion,
source parse errors and unresolved child executable/arguments require review.
The evaluator recognizes imported child-process APIs and simple aliases, and
resolves path helpers only when bound to their Node builtin imports.

`scripts/lab/u18-static-edges/exceptions.json` records 185 individually reviewed
call contexts for private mutants, positive controls, explicit worker modes and
unreachable suite branches. Each binds its exact config index, call, source and
all traversed caller/helper/package bytes; the whole command array is also bound.
New edges, missing dependency keys and changed sources/configuration fail closed.
Refreshing these pins requires renewed review; the checker never refreshes them.
This retains the CHK011 three-run seed property and real atomic build/read races.

`node scripts/verify-validation-static-edge-boundaries.mjs` tests the public
checker against temporary source/config fixtures: hidden aliases, mutable argv,
package children, malformed source, false builtin identities, removed canonical
flags, reviewed exceptions and caller/source/config drift. These static checks
complement the eleven-parent and seven-member runtime witnesses. They are a
bounded syntax and reviewed-call guard, not a proof of arbitrary JavaScript
call-graph completeness or production wall-time improvement.


### Managed-run owner/UI delivery

`proof-or-stop graph` now includes a Managed runs panel. The existing status
poll reads retained managed runtime even when Story hashes have not changed;
it displays stage N/M, recorded queue state, last actual provider output and an
explicitly historical ETA. Heartbeats do not become provider progress. Terminal
notifications are rendered once per project, run and validated terminal identity.
Reloading preserves rendered notifications in browser storage. Hidden pages do
not acknowledge unseen notifications; returning to the page delivers them.
Storage-disabled browsers retain deduplication within the current page.

This is delivery to the existing open owner/UI, without model polling or a new
external messaging channel. A closed browser has no live recipient; retained
unseen terminals are delivered when the UI reconnects. Network failures are
visible, and reconnecting resumes observation. Provider completion is an
operational result, not Story DONE or a newly signed reviewer PASS.

The main package supplies an explicit public field projection through the Graph
library callback. Runtime artifact bindings are checked using the existing
managed-run verifier; malformed state, corrupt bindings, symlinks and special
files produce diagnostics rather than a normal run or success. Provider text,
credentials, raw errors and worker heartbeats are not included. Observation is
read-only, with registered directory and total-byte limits; hitting those limits
explicitly labels the run list partial. Notification identity is a digest of
validated terminal content, not a claim of an additional terminal signature.

The Lab regression `scripts/verify-managed-run-graph-terminal.mjs` combines a real
managed worker, the public HTTP and CLI status routes, read-only/fault boundary
checks, and a real browser using `packages/graph/scripts/verify-managed-runs-browser.mjs`.
Browser verification needs an installed Playwright runtime; an explicit
`PROOF_OR_STOP_TEST_PLAYWRIGHT_MODULE` may select that dependency. Missing browser
dependencies fail verification rather than silently skipping it. These tests
verify delivery behavior; real-project notification P95 and reduced user queries
remain operational measurements.

## Known dynamic fallback

Before launching the dynamic plan, the verifier checks the current static
baseline, catalog, closure, risk, and revocation prerequisites. A known rejection
uses the ordinary canonical plan once. It does not first run a dynamic copy of
those commands. Passing this rejection-only preflight grants no authority: the
actual dynamic execution must still satisfy every existing runtime prerequisite.
Observe remains selection-only followed by the full oracle; shadow retains both
runs for comparison. Explicit full and final-phase requirements remain unchanged.

The repository configuration still uses observe mode. This repair makes the
selector/executor contract real without silently activating it: a narrow signed
manifest partitions the complete inventory into `execute`, admissible `reuse`,
positive-proof `excluded`, and fail-closed `unverified` rows. A repository-full
widening selects every catalog row for execution and does not reuse receipts;
that is the conservative oracle when narrowing proof is unavailable. Activation requires a separately recorded real
inventory observe cycle and remains reversible with `--dynamicMode=off`.

## Worktree discovery in validation

`listGitWorktrees` now runs the live Git inventory command directly from the
supplied Git cwd. It no longer resolves the root through two extra Git processes
before asking Git for the same repository's worktrees. No cache is introduced:
worktree addition/removal and HEAD/branch changes remain visible immediately.
Subdirectory and relative-cwd queries are covered along with main and linked
worktree queries, and non-Git/missing paths retain their empty-list behavior.

The original expensive quorum target with all preceding checks passed in a
same-fixture baseline-to-fixed pair: 109.790s / 10,005 Git calls became
96.116s / 8,656 calls (12.45% elapsed reduction in this pair). Both runs retained
all original target assertions and six verdicts. See
`docs/lab-evidence/validation-worktree-list-pair.json`. This is one ordered pair,
not a whole-suite measurement or a population/P95 claim. The deterministic
regression is `node scripts/verify-worktree-list-efficiency.mjs --performance-only`;
it checks one real Git process per lookup and then runs the complete live-state
and subdirectory cases.

## Dynamic PASS consumption

The REVIEW-to-TEST consumer first authenticates the complete stored PASS record
with its Story-bound signature, before reading its execution mode. DONE routes
a stored dynamic claim to the added strict evaluator. It also authenticates the
Story-owned selection manifest before using its mode for routing; an invalid or
malformed selection beside retained receipts stays on the strict refusal path.
Consequently, stripping the output marker or re-moding the selection while its
receipts remain cannot downgrade admission. Unrelated legacy full PASS records
retain their prior DONE contract. Git-backed
FAIL records are also authenticated, preserving existing command-PASS reuse after
a verification-coverage-only failure is repaired; non-Git failure reporting stays
available. Both canonical
execution and whole-result reuse sign the final size-bounded record. Dynamic whole-result
reuse preserves the original manifest and execution HEAD and rechecks the live
receipts, so an unchanged retry can reuse its PRE_CERT result without launching
validation children or discarding its dynamic proof. Removing a
dynamic marker, changing the output, or stripping the signature cannot downgrade
verification. Older unsigned PASS records require a fresh `validate` run.

The consumer then rechecks dynamic receipt integrity at consumption:
the signed manifest, its execution HEAD, current baseline/closure bindings and
its signed base/head dependency-graph digest,
current toolchain, each required receipt signature and expiry, and the live signed
revocation ledger. Missing or malformed runtime records are refused rather than
recovered as an empty ledger. The normal evidence freshness check first proves
that automatic metadata commits preserve material and Story-input identity; the
manifest still binds the actual execution HEAD. No validation child is started
by this check.

A real two-command dynamic REVIEW fixture now executes one Story-relevant
command and signs a positive exclusion for the other. Its PASS crosses the
actual REVIEW-to-TEST gate and the DONE dynamic-consumer boundary. Removing,
tampering with, expiring, or revoking the executed command's receipt rejects
both consumers; missing or malformed ledgers are also refused.
This does not enable the root repository's observe configuration. The original
DYN-3 plan additionally requires the complete dependency, scope, ancestry,
environment and rollout evidence chain before expanding dynamic authority. In
particular, root full-only policies and unknown graph dependencies remain intact.
Direct validation invoked in TEST resolves to dynamic authority only when the
repository explicitly configures `enforce-low-risk`; `observe` and `shadow`
resolve to `off` and retain the prior canonical execution path. Enforcement still requires the complete inventory partition and the existing
baseline, closure, freshness, expiry, revocation, selector-input and exclusion-
proof prerequisites pass. Explicit `--full`, DONE-phase invocation, and
DONE-required evidence remain on their independent canonical policies.
In DEV and REVIEW, non-authoritative `observe`/`shadow` keep the canonical oracle
but do not newly enable cross-invocation shared execution. Any dynamic mode may
use that path only when the repository explicitly sets
`validate.sharedExecution=true`; ordinary `off` retains its prior eligibility.

The focused regression is `node scripts/verify-dynamic-test-admission.mjs`. The
stable package-level TEST-gate wrapper first runs both source smokes and verifies
their owning selectors, then imports the real consumer fixture in-process. It covers real full and dynamic execution,
one-of-two command reduction, zero-child repeats, TEST and DONE consumption, signature
stripping, output mutation, cross-Story replay, missing/expired/tampered receipts,
missing/malformed ledgers, and receipt/epoch revocation. The older
`validation-evidence-reuse-smoke` still stops before these paths because its
terminal-hook fixture has a completed checklist item without verification intent;
the same failure was reproduced against the pre-repair verifier. Its entire
suite is not claimed green by this repair.

## Repository-root query overhead

The next measured hotspot was 674 `getRepoRoot` calls from signed workspace
resolution. Each previously spawned two Git queries. The ordinary main/linked
layout now reads worktree status and the absolute shared Git directory in one
live query. Nonstandard metadata directories retain the top-level fallback;
bare/non-Git/internal-directory fallbacks remain intact. Absolute Git output
also fixes relative common-directory resolution from repository subdirectories.
No cache is introduced.

With the earlier worktree-list repair active in both rounds, the unchanged quorum
target and all 21 preceding checks passed: 98.417s / 8,657 Git calls became
92.451s / 7,982 calls, a 5.966s (6.06%) reduction in this ordered pair. All six
verdicts and original target assertions remain. Evidence is in
`docs/lab-evidence/validation-repo-root-pair.json`; this is not a full-suite or
P95 claim. `node scripts/verify-repo-root-efficiency.mjs` checks the live query
budget and 15 layout/fallback boundaries, including embedded newlines in paths.


## Explicit implementation transport

Use the intended checkout's `node bin/proof-or-stop.js --implementation-identity`
to inspect the actual core, workspace extension, dependency and Node content
identity. A host can pass `PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN=1` and
`PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST=<verified digest>` to every owner,
reviewer and gate invocation. The shared CLI dispatcher refuses missing or
mismatched required pins before dispatch. This is opt-in: it does not silently
upgrade old worktrees or assert that unpinned sessions have uniform provenance.
It does not authenticate a hostile host or replace signed evidence/freshness.

For an explicitly enrolled local owner/reviewer cohort, capture one approved
runtime epoch, then launch both hosts through the same transport:

```sh
node scripts/implementation-session.mjs capture /absolute/path/new-epoch.json
node scripts/implementation-session.mjs exec /absolute/path/new-epoch.json -- proof-or-stop --version
node scripts/implementation-session.mjs exec /absolute/path/new-epoch.json -- claude
```

The session transport also supplies a content-bound Node preload. It refuses an
unapproved recognized CLI entry before an older implementation can ignore the
pin variables. The recognized scope is the canonical Node wrapper filenames and
`dist/cli.js` inside a Proof-or-Stop core package. A new capture is required after
this transport change; an existing epoch is never silently repinned. Both
canonical CLI entries and ordinary Node tools remain available. The guard's own
directory fixes the entry allowlist, so editing a manifest cannot enroll an old
unaware CLI. This is cooperative inherited-environment protection, not an OS
sandbox against environment removal, alternate runtimes, or disguised imports.
Copied entries with different filenames and packages using retired names are
outside this recognition boundary; the symlink test proves realpath alias
handling only.
Existing foreign desktop sessions are not migrated by starting a Lab session.

Plain host commands use a local pipe-lifetime anchor. Managed launches that
publish the actual provider PID through `onSpawn` or deliver a signed review
invocation descriptor retain the current managed provider lifecycle; the anchor
does not replace their PID identity or fd 3 protocol. The provider runs inside the isolated
group, while the anchor remains alive until controller cleanup. A
provider that exits first therefore cannot remove the owned leader while its
descendants retain those pipes. Timeout/cancellation signals that owned group
with a matching live fingerprint (or a fresh late observation of the still
unreaped anchor). Provider exit code, signal and spawn errors use private IPC;
output remains streamed. This adds one Node process per real POSIX run, so normal
command overhead is measured separately from timeout recovery.
On normal provider completion the anchor flushes forwarded stdout/stderr before
sending its private completion message, and keeps the group leader alive. The
controller then signals the attested owned group and waits for the anchor's
actual close before returning the original provider result. This also terminates
ordinary background descendants that closed their output pipes but still hold
resources needed by the next invocation. These bounded host jobs do not grant
implicit permission to keep services running after the host finishes.
If normal-completion cleanup cannot attest or signal the group, the runner emits
`HOST_GROUP_CLEANUP_UNVERIFIED` and refuses success. A controller disconnect makes
the private anchor terminate its own group. This is bounded local POSIX cleanup,
not durable crash supervision or a guarantee against deliberate group escape.
Missing identity, injected runner seams, and Windows retain direct-child fallback; that fallback
does not prove descendant cleanup. A process that deliberately creates another
group is outside this bounded cleanup guarantee. Failure stays failure; recovery
latency is measured separately from successful Story delivery time.

Capture records both ordinary and canonical Codex entrypoints with their own
exact pins and requires identical implementation file inventories. Their entry
wrapper bytes differ, so their complete entry-specific digests need not be equal.
Capture refuses to overwrite an existing epoch. Exec validates the bound runtime,
and refuses older single-entry manifests before launching any host;
sets a private PATH shim for the selected absolute CLI, and carries the manifest
and required pin through child environments. The CLI itself rejects missing,
malformed, conflicting or mismatched manifests before dispatch. Each admitted CLI
process emits `IMPLEMENTATION_SESSION_WITNESS` on stderr with its actual digest,
entrypoint, PID and argument digest (no raw argument values). The argument digest
is a correlation token, not confidentiality: guessable arguments can be tested
against it. These are unsigned
runtime diagnostics, not role authority or Story acceptance evidence. Inspect
actual command witnesses, not just the launcher's admission check. A runtime
change requires a deliberate new captured epoch; it is never silently re-pinned.
An already-running host must explicitly adopt this transport. Unenrolled hosts,
environment-stripping callers and hostile local administrators are not made
uniform or sandboxed by this opt-in mechanism. Lab adoption does not migrate
other live Story worktrees or change the global installation.

The candidate also renews an existing same-owner lease through the actual
`verification_evidence_add` and `verification_evidence_batch_add` execution and
canonical publication paths. A missing, expired or transferred generation remains
a refusal, and existing valid receipts retain their zero-command import path.
These changes use the managed Lab integration contract and its fresh regression evidence.

For explicitly eligible shared commands, DONE-required validation requires a
clean workspace and checks the current PRE_CERT admission. It preserves the
routine window's execution allocation and does not commit an ADMITTED-to-RUNNING
transition. DONE writes only its own validation evidence through the existing
metadata path. Dirty source and adjacent staged changes remain untrusted; receipt
consumers retain independent acceptance and build-proof rules.


## Audited acceptance additions during repair

The owner may call `verification_intent_append` in DEV with `storyId`, `itemId`,
`expectedIntentHash`, a substantive `reason`, and `addition` (happy/edge/adversarial
arrays). Each new row must have a unique stable id, an English description, an
executable type (cli/logic/browser), and priority must. Compute expectedIntentHash
using acceptanceIntentHash: pin execution fields are excluded from acceptance
semantics. The command refuses stale intent, absent/foreign/stale ownership,
dispatched agents, terminal/withdrawn items, caller-authored pins or receipts,
and replacement or removal of original requirements. It does not approve scope
expansion. Use the scope workflow for new capabilities or affected files.

The CLI appends a repository-key-signed amendment within checklist.json, retaining
original intent semantics, scope binding, owner lease generation, and the prior
amendment signature. Canonical checklist reads and writes verify the chain. The
item reopens in progress; added requirements remain missing until tool-executed
evidence covers them. Existing acceptance and final review remain mandatory, and
acceptance hashes invalidate obsolete review inventories. This is attributable
repair provenance, not formal PASS evidence. A Lab fixture is not a real Story
completion or evidence that every ongoing session has adopted the candidate.


## Shared execution identity and dynamic selection

`validate.sharedExecution: true` explicitly enables exact-input shared execution
also when dynamic selection is observe/on. Selection mode alone does not grant
command reuse. Each command must still declare executionReuse and executionInputs,
and existing forbidden, never-reuse, risk and build-proof exclusions remain in force.
The receipt now includes the loaded implementation digest automatically; callers
cannot replace it with a displayed package version. Changes to runtime bytes or
explicit ignored inputs invalidate reuse. The engine checks the runtime digest at
consumption/publication as well as before a child launch. These checks cost time;
short commands can be faster to execute than to share. Measure total wall time
before opting a production command into reuse.

The tool version in causal receipts is read from the loaded core package, never
from an unrelated target project's packages/main/package.json. The optional host
pin still refuses before dispatch, after bootstrap modules have been loaded.
It is not a hostile-host sandbox or proof that every running reviewer adopted it.
## Resource declaration audit

The integration retains twenty matching historical source reviews: fourteen
shared readers, five explicit local writers, and one build-order precheck.
The prior quorum review is superseded by main's modular coordinator and existing
B-e40f regression contracts. `resource-audit.json` identifies that supersession;
its current command binding uses exact executable/argv, never old array positions.
A missing or duplicate command, changed declaration, removed writer protection,
or weakened precheck ordering fails the resource audit controls.

## Governed revision and checkpoint recovery

After the existing authorized rollback to INIT/PLAN, `checklist_update` may revise
an amended item only within its ordinary phase, role, field and scope permissions.
It requires a substantive `reason` for an acceptance change and appends a signed
revision binding both intent states, both scope hashes, the prior signature,
actual writer and owner generation. It retains every original amendment and resets
the item to pending. This grants no exemption from PLAN review, scope checks,
fresh coverage or final review. DEV cannot use this route to rewrite acceptance.
Dispatched verification-intent writers retain their existing PLAN-only field scope.

Every canonical write for an amended checklist first anchors the exact signed
snapshot in a single-parent Git commit chain beneath
`refs/proof-or-stop/intent-checkpoints/<story-digest>`. The reference update uses
compare-and-swap and does not move any branch, including main. A retained ref
keeps its history reachable through normal packing and garbage collection.
The `proof-or-stop-intent-checkpoints` directory is a local file mirror; removing
that mirror and the projection history together cannot erase the anchored
obligation. Canonical reads use the verified anchor and reject a different
projection. Old unanchored records retain the contiguous-file verification path
and acquire a complete-chain anchor on their next authorized canonical write, including unchanged data. No caller can
supply a replacement signature or silently truncate old history.
Typed integrity errors propagate through gate/roster/query fallbacks. A reordered
JSON object is equivalent under canonical comparison.

An interrupted projection is recovered by the current owner with
`verification_intent_recover --storyId=B-example` (inspection, zero writes), then
`verification_intent_recover` with `apply:true`, the returned
`expectedCheckpointDigest`, and a substantive reason. Recovery restores exactly
the signed snapshot; stale digests, foreign owners and terminal Stories are
refused. It neither reruns commands nor re-attests evidence. The existing CLI
command audit records the recovery invocation. The retained Git ref, object store
and signing key are the local trust root. Deleting that trust root too cannot be
recovered from the remaining erased files. A fresh clone does not automatically
carry private signing keys or these custom refs; no cross-clone trust transfer is
claimed. This protects local file loss and interrupted publication, not a hostile
Git-administrator sandbox.

### Complete verification output

Verification commands whose output exceeds the 12,000-character display probe now
retain complete redacted output under the Story causal-evidence/outputs directory.
The signed receipt binds its digest and length. Each intent still checks its own
pinned selector; a middle-of-output marker is no longer lost to display truncation.
Independent processes can reuse the original successful execution. Output that is
missing or changed is refused, with no automatic rerun or replacement evidence.
The output object is process evidence, not a disposable runtime cache. Legacy
receipts are not silently upgraded, and this repair grants no Story-wide speedup.

Checklist verification receipts automatically bind the executing implementation,
including bootstrap helpers, dependencies and Node, even without a caller-supplied
transport pin. An equal version string cannot reuse a different implementation's
receipt. The handler checks bytes before launch, after execution and at canonical
publication. Mutation during execution refuses receipt publication; stale-refresh
raw-process fanout also refuses implementation drift. This does not claim that
unrelated running owner/reviewer sessions have adopted a common CLI installation.

Complete output objects have a 1 MiB serialized-byte ceiling. If a store lacks
both complete-output methods, or output exceeds that ceiling, the fresh command
still proves its own selector using a bounded signed witness. That receipt is not
shared with later requests: another selector or a publication recovery request may
need a fresh execution in this fallback. There is no poisoned reusable receipt or
unbounded Story file. Exit-only checks never read selector objects. Matching uses
NUL boundaries for redactions and rejects NUL-bearing selectors; display placeholders
cannot become proof of text the command never printed. Redaction itself is preserved
behavior, not an additional performance gain claimed by this repair.

## Lab graph validation process ownership

The graph CLI accepts port 0 and reports the actual port assigned by the OS. Graph
verifiers use that address, confirm the served repository identity, and terminate
only process groups they created. Client recovery is checked over HTTP as soon as
the server is ready; a fixed 60-second foreground timeout is no longer a success
condition. The original client bytes are restored after both recovery probes.
JSON mode is observed for zero Node listener calls, including inherited children.
The isolated missing-output control also requires refusal before any listener.
These checks do not authorize shared access while a verifier rebuilds local assets.

## Explicit local barriers and cross-worktree capacity in this Lab

All 135 routine and both DONE entries declare resources. Ten audited or
conservatively retained routine writers carry explicit exclusive local barriers;
the initial precheck also holds an exclusive barrier to preserve build order.
The newer quorum coordinator and its new inventory regression retain the current
main shared Git declaration. The executor automatically adds a shared local plan
barrier to every declared command, so all still conflict with local writers.
DONE build and full-suite execution remain non-reusable. The full suite retains
its machine-wide exclusive TCP 43127 claim. Graph checks use OS-assigned ports
and exclusive local asset access. Independent routine invocations may share the
two-invocation capacity only when all actual resource claims agree. Declaration
completeness alone is not proof of command success or lower elapsed time.

Exit-only checks with long output within the retention limit keep durable receipts
and can reuse them without reading selector bytes. The 1 MiB and legacy-store
fallback remains non-reusable. Historical v1 receipts that contain truncated or
redacted display text cannot prove a nonempty selector; they refuse with
`causal_legacy_selector_output_unproven` and require fresh execution. Plain complete
legacy output remains compatible. No historical credential is silently rewritten.

The Lab root opts into shared execution for one measured eligible heavy command:
`tool-executed-evidence-receipt-smoke.js`. Its explicit input binds the command
artifact in addition to automatic implementation, material, environment and
workspace bindings. Dynamic selection remains observe. Short assertion suites
are not opted in merely to increase the eligibility count. Both DONE commands
retain build/full-suite exclusions; 0/2 DONE eligibility is the intended policy,
not a switch left disconnected. The root full-suite inventory does not contain
this heavy command, so the isolated two-consumer experiment proves conditional
reuse, not that those two root inventories duplicate this work.

Late subscribers now join an already-running batch retry instead of launching a
third identical command. A non-reusable fallback witness for another selector
cannot become a false selector-mismatch result: that consumer executes its own
witness. This may require one execution per selector outside durable retention;
it is correctness, not a claimed speed gain. Completed selector-output publication
retries the same bytes at most twice without rerunning the command. A permanent
storage error still refuses and provides no cross-process recovery guarantee.
The current resource audit reports 20 reviewed / 14 effectively shared /
6 superseded by local barriers; exact claim guards
reject both unapproved additional claims and removal of writer protection.

Completed receipt publication has the same two-attempt transaction bound as
complete-output publication. A transient first write retries the original signed
receipt, preserving its timestamp/hash and one command execution; permanent
storage failure still refuses. Superseded resource declarations must preserve
every original audited claim even if both config and supersession metadata are
edited together. Capacity aggregation removes only exact duplicate normalized
claims; the historical 195-to-17 count is not a current inventory assertion. Access,
ownership and resolved working directory remain part of the distinct claim.

The repository CLI-surface suite also needs the local `packages/lab` extension.
In a fresh Lab checkout, `scripts/ensure-dist.mjs` prepares main and utils only;
run `npm --prefix packages/lab run build` before CLI-surface verification. A
missing extension intentionally leaves the standalone core without Lab commands
and must be classified as missing preparation, not as a passing full CLI profile.
Build before starting readers, then derive the implementation pin from the final
prepared runtime. The frozen pre-preparation measurements remain separately bound
to their original runtime; do not relabel their implementation identity.


### Current main internal quorum partitioning

The current main modular coordinator retains 73 executable case registrations,
canonical partitions, and isolated worker fixtures. Root configuration uses
`--jobs=2` and preserves main's exact shared Git resource contract. The independent
B-e40f regression checks inventory bijection, missing/duplicate/replaced cases,
partition boundaries, private fixture isolation, selector refusal, concurrency
and cleanup. Existing tests are retained rather than weakened to accept the old
Lab prototype. The historical old 13-case atomic-group implementation and its
jobs=4 timings remain in the archived evidence, not the current runtime.

Use decomposition when its measured saving exceeds process/fixture setup and
aggregation costs. This is not proof that splitting arbitrary product Stories
reduces development time. The full workload and source version must be identified
for every new measurement.

Checkpoint audit recovery: Git refs are resolved through Git, including reftable and in-place backend migration. Every canonical write, including an unchanged write, anchors the complete verified legacy chain. Missing mirror generations are reconciled from retained signed Git objects before successful projection publication; conflicting or newer mirrors refuse recovery rather than roll acceptance backward. Root generation and predecessor checks cover the full chain, and CAS/publication failures propagate typed integrity errors. Reads remain read-only; a legacy record needs an authorized canonical write to migrate. Git ref/object/signing-key destruction remains outside the local recovery trust boundary.

Owner recovery also handles the prior experimental parentless anchor when a complete, valid signed mirror contains the exact signed anchor record at its own generation index; later records must extend that same complete signed chain. A damaged mirror can be replaced from a complete verified Git anchor only through the existing owner recovery command; the original directory is retained under a `.quarantine-<uuid>` sibling. Inspection performs zero writes. Apply still requires the expected digest and a substantive reason. A valid newer or conflicting signed mirror blocks repair even if another mirror file is corrupt. Missing signed generations with no retained anchor or backup cannot be fabricated and remain a restoration-from-backup requirement. Normal canonical reads continue to fail closed before repair.

History reads batch the repository-key resolution while verifying every checkpoint and amendment signature and every lineage/current-intent binding. They re-read the trusted key at the end of each synchronous multi-envelope batch; key replacement/deletion fails the batch. No key, digest or prior verification result is cached across calls. This reduces repeated Git subprocess startup without omitting old generations.

After successful owner recovery, leftover generated replacement directories are removed only when every contained file is an exact duplicate of a verified retained generation. Empty generated directories and partial sets containing only verified duplicates are deliberately removable: the complete authority has already been restored. Quarantine evidence, symlinks, unknown files and corrupt remnants are preserved. Complete authoritative anchors still refuse newer or conflicting signed mirrors; the extended-lineage migration exception is limited to the prior parentless anchor format and requires explicit owner confirmation of the latest snapshot digest.

The first root precheck holds an explicit local exclusive barrier even though its fixture work is read-only. This preserves the configured precheck/build prefix: a later compiled consumer cannot overtake the queued exclusive build. A mutual-exclusion resource claim alone does not impose producer-before-consumer order. The standalone build-order regression runs the actual executor with the first three configured resource rows, stale/missing output and failed/unguarded build controls. The prior prepared-dist full run is not proof of this sequencing condition. Of the original 21 shared-reader recommendations, the replaced quorum row is preserved only as historical evidence. The other twenty resolve to fourteen effective readers, five local writers and one build-order precheck; original claims remain preserved for these matching implementations.

Current integration adds two admission-reader supersessions to that historical
review: the original claims stay present, and the same real-root admission mutex
is now declared by all eight verified takers. The quorum coordinator still uses
its internal jobs=2 workers, but its outer validation row holds the local-plan
barrier because its protected-root observer must not see another command's trace
writes. Resource coverage is 141/141 routine and 2/2 DONE at main 0.3.292. These
coordination repairs are correctness evidence, not a fresh full-workload speedup
measurement. The earlier successful 134-command A/B remains separately scoped.


## Complete PASS reuse while observing dynamic selection

The Lab's identity regression keeps an independent required-source inventory as
well as the runtime operation registry. A shared verification producer has two
reviewed operation owners with disjoint named identity sites. Every schema,
reviewer role and signer-key filename in the newly included producer/consumer
modules remains registered and receives its own unsupported-family mutation;
none is reclassified away to satisfy the test. Exact occurrence/import contexts
and the existing complete executable-module fingerprints remain required.
`experiments/five-item-closure/complete-closure-entry.mjs` runs the fast inventory
and site-completeness checks before the handler regressions. The complete public
operation and zero-mutation campaign remains in the unchanged full test group.

`validate.reuseFreshRoutinePass: true` enables strict whole-routine PASS reuse
in `observe` mode. The project configuration opts in; other projects default to
false. `validate --reuseFreshRoutinePass=false` forces a new observe execution.
The CLI option overrides the configuration. A matching complete PASS still
requires exact execution identity, all required intent coverage, clean material
and Story inputs, trusted metadata lineage and stable HEAD. The signed dynamic
revocation digest must match the one recorded with that PASS. Missing, corrupt,
changed or newly revoked evidence causes execution.

The zero-command path persists the current advisory selection and then checks
identity, coverage, HEAD and revocation state again. Its result explicitly records
`authority: observe-only`, `oracleStatus: not-run`, and
`reusedFromIdentityDigest`. It does not report a new full-plan oracle, runtime
trace or verdict-equivalence proof. Canonical evidence records the resolved mode
and `reuseAdmission: observe-opt-in`, retaining the original command execution
summary. Shadow/enforcement modes and focused validation keep their execution
semantics. Use this option for repeated complete demands on unchanged inputs;
changed commands, sources or policies require new execution.

This option is separate from per-command CAS sharing. Build/full-suite exclusions
and command/input declarations are unchanged. Direct `done_required_validate`
continues to execute; `done_prepare` retains its existing independent fresh
DONE-required PASS reuse. A nested npm suite is not interchangeable with an
argv-similar leaf invocation unless their complete execution identities match.


The four registered identity modules (evidence-freshness, review-inventory-epoch,
verification-execution-evidence and handlers/checklist) bind their reviewed
complete executable syntax (TypeScript printer, comments removed,
SHA-256). This covers live producers, comparisons, aliases and computed writes,
including neighbouring identity sites in those modules. Merely keeping a
canonical declaration or a dead comparison is insufficient. Exact value checks
run first, then the syntax guard rejects rewiring that retains those values.
This covers the registered modules; the separately pinned execution identity
protects the checker implementation itself. Comments/formatting
alone do not revoke this syntax binding. Intentional executable changes require
reviewed pin updates; there is no automatic refresh or hostile-host guarantee.
Failed-command diagnostics preserve both the output prefix and terminal failure
context within the existing character budget. Successful commands retain their
existing bounded prefix presentation. Execution receipts continue to consume the
complete captured output.


## Runtime cache publication and focused diagnostics

Doctor reports runtime index discovery as `ok`, `not-evaluated`, or `failed`.
Unavailable scans have `tracked: null` and cannot authorize repair; they never
mean a healthy or empty index. Discovery bounds Git output at 32 MiB and rejects
failed or incomplete scans. Non-Git roots remain readable diagnostic targets.

`doctor --repair --runtimeArtifact=runtime-causal-evidence-receipts` is a focused
maintenance operation: it migrates only the known causal ignore policy and
untracks only registry-classified `index.json` and `receipts/` cache paths. It
retains file bytes, refuses force removal, and skips owner/worktree/branch cleanup.
Already-tracked files require this explicit migration; adding ignore rules alone
does not remove them from Git history or the index. Partial failures are errors.

The registry retains legacy causal path classification. Managed sync and init
replace the historical whole-directory ignore with index, receipt, and pending
publication rules. Complete selector outputs remain durable evidence; unknown
siblings remain visible. Pending publication capabilities stay on disk for signed
recovery and are never selected by focused untracking. This does not claim
recovery after loss of the local trust root or arbitrary external writes.

### Certification transitions during closeout

The Lab closeout classifier accepts only a signed, previously authorized
`ADMITTED` to `RUNNING` transition with unchanged receipts, history and frozen
identity. Other changes to the same file remain untrusted. This delta check does
not replace current-input certification or final DONE gates. DONE-required
admission runs inside validation ownership and before command execution. A
changed physical policy file while waiting refuses the queued plan; a missing
admission exits nonzero without executing commands or claiming an executed result.

### Lab publication readiness and intended output binding

Full Story validation refuses existing canonical publication-path changes before cluster synchronization, reuse or command execution. Resolve the pending change explicitly before retrying; focused and non-Story checks keep their existing behavior. Final publication checks remain necessary for non-cooperating filesystem writers. Both execution and reuse bind evidence bytes predicted before writing, the exact terminal append and receipt-chain bytes, and current validation ownership. A mismatch rejects publication and preserves foreign bytes, leaving operator-visible dirt until resolved; it does not adopt or erase them. The registered closeout regression runs the dirty-entry, status-error, clean, cooperative writer, source drift, foreign event, foreign evidence, terminal-read failure and injected publication-owner refusal scenarios. Missing terminal receipts refuse directly; the owner fault injection checks the real verifier error path, while lock drift semantics are exercised by the separate lock controls. This is not a complete recovery scheduler or real Story performance claim.

### Lab index recovery and outer closeout

After a real-index refresh failure, HEAD rollback is attempted independently. Per-path index recovery skips unchanged baseline entries, restores only the expected owned entry with one index-info write, and preserves unexpected or unreadable entries. Outer auto-closeout uses the captured metadata root and intended reuse-output digest for selective worktree rollback; it does not reset the shared index or adopt changed/deleted foreign bytes. The reuse writer checks serialized output against its predicted digest and reports write failures as blocked outcomes. Regression controls reach the actual auto-closeout fallback branch as well as the exported primitive. This narrows a read/compare/write window; it is not an index CAS or OS-wide atomicity. A foreign actor staging identical mode/object bytes is indistinguishable from the owned partial write.

The selective worktree rollback also has read/compare/write and path-classification/open windows against non-cooperating filesystem writers; its tests do not prove OS-wide exclusion. Index restoration derives the zero object ID width from the owned entry, with SHA-1 and SHA-256 fixture controls. Ordinary outer refusal is checked to restore the owned reuse write without adding dirt to its capture boundary; this does not delete legitimate pre-existing generated outputs.


### Bounded scope-withdrawal compensation and persistence contention

The scope withdrawal handler holds the cooperative validation metadata guard for
its three-artifact application. Intended output bytes are predicted before each
writer; a failure restores only matching owned bytes. Unchanged bytes are a no-op,
foreign bytes are preserved, and a moved HEAD requires reconciliation. This is
not OS-level atomicity: uncooperative writes can race the compare/restore window.

A completed checklist checkpoint is compensated by the canonical writer, adding
a signed generation rather than deleting history. This is valid only for scope
withdrawal, which leaves amendment arrays unchanged. An interruption between
checkpoint advance and file publication preserves the checkpoint and refuses with
SCOPE_WITHDRAWAL_RECOVERY_REQUIRED; use verification_intent_recover and reconcile
the withdrawal before retrying. This branch is a detected recovery requirement,
not automatic restoration of all state.

Scope persistence contention propagates and triggers the same compensation.
Certification contention also propagates, but reports the already-recorded window
state; inspect certification_window_status and retry the original request. Other
legacy best-effort persistence errors retain their behavior. These controls do not
claim to implement complete certification inventory-consumption recovery.


### Routine validation scope readiness

Routine Story validation in REVIEW, TEST and DONE projects the existing transition
scope policy before publication preflight, cluster sync, certification and reuse.
Declared files without a contract, unreadable contracts and enforcing violations
refuse with zero commands and no PASS. Use scope_contract_init_from_plan or
scope_contract_set, inspect scope_contract_check, then retry. Scope takes priority
when both scope and canonical publication paths are not ready. DEV, legacy Stories
without file declarations, focus/channel/concept/lint and no-Story calls keep their
existing boundaries. Shadow mode retains its warn-only behavior.

This also affects validate consumers in done_prepare, phase gates and evidence
recovery. It produces neither a scope contract nor acceptance evidence and cannot
replace the final DONE oracle. Two real CLI controls are registered in freshness;
the wider matrix is a targeted integration run, not a reason to run all quorum.


The separate done_prepare lifecycleReadiness step diagnoses scope and review before
expensive validation. This early snapshot is not protected by the later execution
lock and cannot certify readiness: in-lock validation and final DONE checks still
run. Dry runs collect downstream planning but must retain a blocked upstream
status. Direct done_required_validate scope admission remains a separate flow;
this change does not claim that its newer commit/admission path was audited for
this additional prerequisite.


### Interrupted certification admission

Begin records a signed ADMITTING attempt before consuming finalized inventory.
It holds one inventory lock and the cooperative metadata guard; consumption uses
the explicitly unlocked internal entry, while existing callers retain their locked
entry. Epoch and receipt record the same window owner in their signed content.
Recovery re-reads the pending attempt inside the lock, checks complete frozen input
identity and current non-inventory prerequisites, and promotes that same window.
Already consumed inventory is never consumed again or adopted without its owner.
ADMITTING carries no PRECERT receipt and cannot authorize heavy validation.

Interrupted or ambiguous consumption remains pending for explicit retry. Foreign
identity, partial consumption, missing legacy ownership, timestamp or signature
failures remain blocked. Cancellation never unconsumes inventory. A fully written
ADMITTED result can be returned idempotently after a caller-visible write error.
This does not establish arbitrary publication/commit failure recovery, OS-level
atomicity, or permission to refresh a stale identity. Registered protocol controls
add regression cost; their elapsed time is not a Story speedup measurement.

### Validation CLI outcome

Top-level `validate` returns nonzero for a typed failure in either JSON or text mode. Its exit, activity and terminal event agree; validator prose cannot override execution/coverage failure. Warning/skip without an explicit failure stays successful. Internal validation calls retain their outer handler's outcome policy; only the top-level CLI receives the private per-call outcome sink. Structured TEST refusals no longer reset the gate-failure counter; the existing throw-only increment rule is unchanged. Autopilot's existing shell-exit consumer now observes failed text validation as failure; its repair-spawn policy is unchanged.

### Declared directory inputs

Explicit `executionInputs` may name files or complete directory trees, including resolved symbolic-link targets. Each currentness check rereads bytes; metadata is only a race detector. The entire snapshot is refused for cycles, unsupported nodes or limits (4096 entries, depth64,64MiB). Initial refusal executes without reuse and reports `input_unreadable` in context-local diagnostics. Drift after snapshot refuses stale publication. No partial tree grants reuse.

Within one shared invocation, the captured initial facts and input snapshot are
each canonicalized once. Later checks still acquire and canonicalize fresh facts
and input bytes, compare workspace state, and verify loaded implementation
identity. These baseline strings do not survive the invocation or authorize
reuse. The canonical runtime contract uses `verify-validation-snapshot-binding.mjs`
to check the actual owner and live comparison bindings without Node module hooks.
The Lab-only `validation-snapshot-operation-count.mjs` measures the operation
count with real execution, reuse, changed inputs, and refusal under live drift;
it does not raise the general runtime requirement.

`executionDecision` is diagnostic only, absent without a shared execution context. The existing reuse predicate is unchanged; build/gate/forbidden policies still execute. A same-process follower keeps the leader receipt timestamp while reporting reused, because only its local run callback proves a physical start. Directory support does not enable production caches or imply short commands benefit.


Declared input directories must be read-only for the duration of shared execution,
including writes by the command itself. Put generated outputs outside those trees.
If a command succeeds but changes a declared input, the validation call raises an
input-drift error and does not publish reusable PASS evidence; it does not silently
return that successful child result. The self-writer regression pins this behavior.
An empty executionInputs array retains the pre-existing policy meaning: no additional
paths beyond the workspace, command, environment and implementation identity. It is
not proof that a command has no other dependencies; opt-in still needs input auditing.
The input walker rejects non-regular descriptors before reading. Opening a path
raced into a device is not claimed to be preventable on every operating system.

Ordinary unscoped validation without a resolvable Git HEAD preserves the actual
command result, but does not create a canonical full baseline. The CLI logs why
that baseline was not produced; successful command execution alone cannot supply
a reusable Git epoch. Existing Story gates still require their own evidence.

## Measured reuse admission

Official routine and DONE-required invocations measure the first eligible execution,
including framework overhead. If overhead exceeds twice actual command wall time,
subsequent identical commands in that same context execute freshly with current
execution admission before and after the command, without scanning implementation
identity or consuming reuse evidence. This never consumes a cached PASS; normal execution, locks and caller
gates remain active. At most 128 hints live in a weak context map. Failure or an
execution now as expensive as the observed overhead removes the hint. A fresh
invocation may use the bounded six-hour advisory runtime cost file. A missing or
invalid observation falls back to full checks; the first-ever observation cost
is not eliminated. The file stores hashed keys and costs, never output or PASS.
Only ignored runtime directories are written; symlink paths are refused. Lost
updates may lose an optimization, never authorize reuse. Long commands
retain the complete existing identity and receipt checks. This is a measured
execution choice, not a claim that receipt verification itself became cheap.


## Command entry and wait diagnostics

Routine commands not declaring exact-input reuse enter their resource stage once.
Exact-input reuse declarations retain the nested stage recheck around the actual child. Independent complete-output evidence execution keeps
its own stage. Immediately before spawning, cancellation and expired invocation
deadlines refuse without starting a child, including commands ineligible for reuse.

Per-command `schedulerWaitMs` reports the keyed scheduler's observed resource-conflict
wait. It excludes worker-slot queue time, cross-process capacity wait and execution;
it is diagnostic only, not a gate input or a full-overhead measurement. The existing
`durationMs` retains its meaning. Local command-entry measurements do not establish
full-configuration throughput or complete Story latency.


### Synchronous Git tree observations (Lab)

The causal preflight, evidence hash snapshot, ordinary freshness reader, and
strict freshness reader now bind both material and Story projections to the
full object name already resolved at that entry. The persisted snapshot `ref`
retains its original value. A synchronous observation shares only successful
`git ls-tree -r -z <full-object-name>` output with the same absolute cwd and
sorted inherited environment (including `GIT_*`, `PATH`, and `HOME`). The fixed 1 GiB reader limit is unchanged; other
formats/limits and symbolic refs use their existing independent reads. Nested
synchronous helpers share the observation; the outer `finally` clears it.
No observation survives an await or a later launch/publication check.

This also prevents mixed-HEAD hash tuples when HEAD advances between the two
projections. The next observation detects the newer HEAD; receipt admission,
policy, working-tree drift and publication checks remain independent. This is
not cross-invocation caching and grants no new PASS reuse authority.

Reproduce the bounded contracts with
`node packages/main/tests/validation-git-tree-batch.mjs`,
`node packages/main/tests/validation-git-tree-safety.mjs`, and
`node packages/main/tests/validation-git-tree-head-drift.mjs` after building.
The default 141-command identity diagnostic found repeated executable reads but
only about 14 ms total on this host; no executable memo was added. These local
measurements do not establish full Story throughput or default lifecycle gains.

### `next --storyId` decisions (Lab)

A child_process profile of every quiet decision on the ND harness fixture
(`NEXT_DRIVER_COST_PROFILE=<file> node packages/main/dist/tasks/next-driver-cost-smoke.js`)
found 5292 spawns in 35 decisions, 93 s of their 100 s, 55% of them repeated
identical git commands: each gate opened its own observation scope and the
driver held none, and several read-only probes bypassed `observedGit`
(story branch check, finding-ledger common dir, rename-aware name-status diff,
blob ls-tree/cat-file, closeout ancestry, REVIEW index snapshot). The driver now
decides inside one `withGitTreeObservation` and those probes pass through
`observedGit` (a failed branch probe and any incomplete command are never
memoized; a blob read keys on its byte bound). Result: 2468 spawns, 49 repeated.
What remains is mostly the review verdict's per-pass lineage walk, distinct
object reads that the TEST/REVIEW rows consult first; deferring other rows
would save under 10%.

### Losing ownership while queued

Official validation passes the lease heartbeat's cancellation signal into capacity
acquisition and combines it with caller cancellation. A failed renewal removes the
waiting invocation's own capacity ticket and refuses before entering its callback.
The default heartbeat interval remains 30 seconds; this is the detection bound, not
a promise of instantaneous revocation. Already-running child commands retain their
existing launch and publication checks; this change does not terminate arbitrary
subprocesses. Missing or expired ownership at entry still refuses immediately.

The incremental Lab regression keeps prior repairs in its baseline and compares
refusal latency after private lease revocation under identical capacity contention.
Healthy owners still wait and execute; caller aborts keep their original reason.
This mechanism result does not measure overall Story delivery time or establish
that other running hosts have adopted this runtime.

Existing activity records now include `implementation.status`: `verified-at-entry`
with the checked digest, actual entry path and PID, or `unverified` when no pin
was required. The CLI reuses its admission result; publishing this field performs
no additional implementation scan and does not enable read-only logging. This
runtime observation is unsigned diagnostic data, not continuous code attestation,
Story role authority or proof that every live host has enrolled. Historical rows
without this field remain unknown. Collection must distinguish observed session
labels from actual live host counts.
Nested capacity reuse also checks cancellation before entering its callback.
Signal forwarding uses base AbortController methods and removes listeners on
success, refusal and callback failure, retaining the existing Node runtime floor.

## Historical review comparison bases

New conditional reviewer runs record `fullStoryBaseHead`, the Story's frozen `integrationTarget.parentCommitAtCreation`, inside the authenticated Prompt Envelope. Historical eligibility replay compares that immutable commit with the signed run head. This applies both to a first review and to a full-context fallback after the incremental path limit is exceeded. Moving or renaming the integration branch cannot rewrite those historical comparison inputs, and repositories whose integration branch is `master` do not need a synthetic local `main` ref.

Topology implementation provenance uses the same frozen Story integration commit as its lower range boundary. A legacy Story without that field derives the current repository merge base. Dispatch and receipt verification scan only that commit through the current `HEAD`; they do not assume a branch named `main` and do not search an unbounded recent-commit window. This prevents an implementer-authored commit from an earlier Story from being attributed to the current Story when its own implementation commit is absent. Missing base, range, or current-Story implementer evidence has a stable `IMPLEMENTATION_PROVENANCE_*` code; optional scope dispatch records that diagnostic in its process event while required topology dispatch refuses.

The field accepts a full Git commit object id, never a branch name. A declared Story base that is no longer available produces `FULL_STORY_BASE_UNAVAILABLE`; it does not fall back to a moving branch or an empty diff. Legacy Stories without a frozen integration target use the repository-baseline resolver and retain the prior optional-field behavior when no baseline can be identified. Older envelopes remain readable without inventing a base or changing their legacy eligibility digest; affected old evidence may require a new reviewer run.

This freezes a historical input, not current admission. Story-source, scope, policy, native identity and Finding checks remain live. The integration target is chosen and recorded when the Story is created; review_run_start consumes that authority rather than choosing a branch later.

### Completed inventory history after certification

Certification admission legitimately adds signed consumption timestamps and certification-window ownership to a finalized inventory epoch and receipt. The convergence completion digest excludes those later output fields in both records while continuing to verify both signatures and all completion claims. Agents should retain the existing journal after normal admission; do not reset completion history to work around a lifecycle output. Material or receipt tampering remains an integrity failure. Consumption ownership is still enforced independently by certification and never grants authority through the convergence journal.

### Batched review metadata before certification

The native review epoch publisher commits signed reviewer artifacts together as
`record <Story> review epoch metadata`. PRE_CERT recognizes that exact same-Story
bookkeeping subject when every changed path belongs to the publisher's registered
review artifacts or a prompt-body path recognized by the canonical prompt-body store.
The publisher verifies referenced prompt bytes; continuity checks path membership,
not historical blob digests. Ancestor, single-parent,
material, scope and signed inventory checks remain required. An arbitrary commit
subject, another Story's path or an unrelated artifact does not gain continuity.

`node scripts/verify-review-epoch-certification-continuity.mjs` runs genuine native
review lanes and a completeness critic in linked worktrees, then checks clean
admission and those rejected lineage claims. This preserves the normal sequence
of finalizing review inventory and running the fast check before admission.

The serial reference suite includes `test:review-epoch-certification-continuity`.
Its six native cases include a malformed prompt-body path and an actual signed
cancellation. Finalize and cancel share a publication subject; admission still
requires the latest signed FINALIZED epoch and its valid unconsumed receipt.
The four-case version measured 76 seconds; the expanded six-case verifier has a
bounded 240-second fixture budget for host contention. Production budgets are unchanged.

### Retry after a refused certification begin

A refused `certification_window_begin` may publish a signed BLOCKED diagnostic.
Follow its fast-check remedy and retry begin with the same finalized inventory;
do not recreate review merely because that official metadata commit changed HEAD.
The shared strict lineage reader accepts an append-only BLOCKED diagnostic and
valid cheap-check receipts carried by that diagnostic publication. Fast receipts
still bind the exact current HEAD: after any later commit, run the fast check
again before retrying admission. This change grants no new inventory continuity
for a `validate` metadata commit. It rejects
rewritten history, other Story or source paths, invalid signatures, inventory
consumption and heavy-authority fields or receipts in a diagnostic publication.
This preserves review only. Current inventory, cheap-check identity, coverage,
findings, clean-tree and main checks still decide admission, and only the signed
admitted window plus its PRE_CERT receipt authorizes heavy certification.

`packages/main/tests/certification-recovery-lineage.test.mjs` exercises the actual
refused handler publication and retry on a disposable Story branch with a frozen
synthetic inventory cutoff, plus negative lineage and authority controls.

Managed review supersession authenticates an unambiguous managed transport before classifying live freshness. Unbound and conflicting records retain their prior freshness, scope and retention ordering. An observed material-hash mismatch or changed head lineage follows the existing stale-run policy: a newer valid record on the same lane may supersede the old PASS, without promoting or deleting it. Unavailable identity and invalid managed seals remain blocking. Open findings still require their own disposition; a newer PASS cannot hide them. The focused `managed-review-evidence-smoke --supersession-regression` fixture exercises imported signed passes and an open finding, material movement, missing replacement, and terminal-byte tampering. Reviewers should retain historical records and inspect the current collector result rather than request duplicate reviews to replace already valid evidence.

Authenticated resolved or dismissed managed findings with ordinary material or
lineage drift follow the existing F-019 terminal-finding forgiveness rule without
a newer lane replacement. For a latest-lane finding reaching this authentication
path, invalid managed terminal seals remain blocking. The earlier non-latest
`stale_run` handling is unchanged by this repair. The regression imports a real
latest-lane managed finding, resolves it through `finding_resolve`,
and checks material drift, terminal tampering and exact restoration.

Dual-binding PASS controls deliberately assert `invalid_evidence_signature` for
both fresh and stale runs. `verifyReviewPass` in `core/finding-verify.ts` explicitly
returns false when both bindings are present before computing any digest, and
`signReviewPass` rejects that input too. Thus a caller-computed outer hash cannot
reach the later conflicting-authority branch through the real PASS collector.
These controls prove that outer rejection, not execution of the downstream
defense. The unchanged late guard ordering is checked by the process contract.

## Canonical benchmark regression membership

The serial reference and resource policy both include the benchmark framework
hardening regression. The managed review final-schema regression retains its
original command and membership. The canonical benchmark hardening npm alias
uses `--prebuilt`: it verifies the current build binding before either child and
refuses missing or stale output instead of rebuilding while peer tests read it.
Direct invocation of the verifier without that option retains its build-first
behavior. Both the hardening smoke and recovery scan remain required children.
The registered full-suite smoke exercises real inventory mutations and a private
prebuilt wrapper fixture covering stale/missing bindings, restoration, unknown
options and propagation of a child failure. Those fixture markers are test
observations, not benchmark scores or Story completion evidence.

## Process-contract refusal ordering

The process-contract verifier evaluates its actual Story-writer runtime admission
contract and terminating failure barrier before the independent JSONL, review
history, managed supersession, certification recovery and managed delivery
fixtures. A positive run still executes every fixture with its original argv and
deadline. This prevents the runtime-admission negative witness from paying for
those unrelated positive fixtures before it can report the intended rejection.

`verify-process-runtime-admission-order.mjs` requires exactly one retained call
for each fixture after the real barrier and before the existing acceptance proof
loop. Its subprocess observer forwards actual execution and observes all five
fixtures and the three acceptance proofs; the mutated admission must reject
with zero observed positive launches. No validation budget or production
permission rule changes. This local regression is not benchmark scoring.
