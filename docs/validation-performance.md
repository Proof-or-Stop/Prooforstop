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
its existing trace-based path; shared execution is enabled only with dynamic
mode off. No existing command is automatically opted in.

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
integration controls. The earlier experiment's approximately 48% reductions
remain measurements of those workloads: there is no Story-wide speedup claim.

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
