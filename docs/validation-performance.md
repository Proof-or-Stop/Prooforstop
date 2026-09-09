# Production validation execution and repair entry

Official `validate` and `done_required_validate` retain independent acceptance,
freshness, resource, owner and build-proof checks. These changes optimize the
execution mechanisms; they do not turn Lab records into Story evidence.

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

The legacy review-round stall check recognizes a measured blocker reduction
within its trailing comparison window. A plateau followed by a decrease, such as
`[2,2,1]`, no longer blocks DEV to REVIEW. Flat or rising counts retain the stall
diagnostic. This bounded correction is not a substitute for signed completed-epoch
progress accounting; activity counts and provider heartbeats do not prove progress.
