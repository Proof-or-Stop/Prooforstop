# Production validation execution and repair entry

Official `validate` and `done_required_validate` retain independent acceptance,
freshness, resource, owner and build-proof checks. These changes optimize the
execution mechanisms; they do not turn Lab records into Story evidence.

## PRE_CERT execution order

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

An official invocation whose entire command inventory declares resources can
share the repository capacity with one other invocation. Resource conflicts,
unknown declarations, and legacy tickets remain serialized. The invocation also
claims its own workspace exclusively to protect local preparation and metadata.
Canonical Git/common-directory, path and port claims retain their existing meaning.
Nested calls cannot widen a resource reservation. Capacity state remains in the
existing shared runtime lock directory, including across worktrees and processes.

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

Dynamic runner v6 upgrades changes to registered gate/schema/verification
authority sources to full validation, including the full task scope inventory
validator. It also follows their source dependencies in both Git revisions, so
removing a dependency in HEAD does not erase the baseline authority relationship.
The graph identity binds authority roots, members, uncertainty and policy version.
Missing graphs, unavailable source, parse failures and opaque or unresolved
authority imports force full rather than establish an unaffected result.

This conservative resolver currently treats non-builtin package/alias imports
in an authority closure as unresolved. Projects with such imports can lose
incremental eligibility until those resolutions are proven; this change does not
claim improved speed for those projects. External projects without these
registered tool-source identities do not have to recreate them. Existing final
full-validation requirements remain unchanged. The six paired fault witnesses
under `scripts/lab/u09-paired-fault` measure bounded functional detection and
command selection, not population noninferiority or external LLM review quality.

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

The repository configuration still uses observe mode. This repair removes
redundant execution in enforce-low-risk fallback; it does not by itself activate
incremental validation for this repository or make its full-only policies reusable.

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
with its Story-bound signature, before reading its execution mode. Git-backed
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
the signed manifest, its execution HEAD, current baseline/closure bindings,
current toolchain, each required receipt signature and expiry, and the live signed
revocation ledger. Missing or malformed runtime records are refused rather than
recovered as an empty ledger. The normal evidence freshness check first proves
that automatic metadata commits preserve material and Story-input identity; the
manifest still binds the actual execution HEAD. No validation child is started
by this check.

A real dynamic REVIEW execution that runs build and reuses one certified PASS
can pass the TEST-entry consumer. Revoking that receipt afterward now rejects
entry, as do missing/tampered/expired receipts and missing/malformed ledgers.
This does not enable the root repository's observe configuration. The original
DYN-3 plan additionally requires the complete dependency, scope, ancestry,
environment and rollout evidence chain before expanding dynamic authority. In
particular, root full-only policies and unknown graph dependencies remain intact.
Direct validation invoked in TEST currently retains its canonical-full policy;
this is distinct from consuming a valid REVIEW dynamic PASS on entry to TEST.

The focused regression is `node scripts/verify-dynamic-test-admission.mjs`. It
covers real full and dynamic execution, zero-child repeats, TEST entry, signature
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
