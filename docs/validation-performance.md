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
its existing trace-based path; shared execution uses dynamic mode off or an explicit
validate.sharedExecution option independently of selection mode. No existing command is automatically opted in.

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


## Unreleased Lab candidate: explicit implementation transport

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
These changes are retained in Lab for user verification; no version is released.

For explicitly eligible shared commands on a clean workspace, the Lab DONE
candidate commits its own ADMITTED-to-RUNNING certification window
through the existing immutable lifecycle transaction before execution. This keeps
admission metadata from disabling exact-input reuse, without trusting pre-existing
dirty metadata or committing adjacent staged source. Receipt consumers retain
independent acceptance and build-proof rules; the root command policy is unchanged.


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
# Lab resource declaration audit

The Lab candidate declares 21 additional read-only or isolated-fixture routine
commands after the independent source audit in
`experiments/five-item-proof/resource-audit.json`. This removes their exclusive
plan barriers; it does not change the default four workers or remove any tests.
Five routine checkout writers and both DONE commands retain the exclusive default.
Keys use exact canonical equality, so a directory claim does not protect a
different child-path key. Do not opt a writer into concurrency without auditing
all readers of the same resource. `resource-config.mjs` compares four actual
assertion suites under the original and candidate declarations and checks that
all audited readers still conflict with the writer barrier. This is a bounded
command comparison, not a full-suite or whole-Story performance claim.

## Governed revision and checkpoint recovery

After the existing authorized rollback to INIT/PLAN, `checklist_update` may revise
an amended item only within its ordinary phase, role, field and scope permissions.
It requires a substantive `reason` for an acceptance change and appends a signed
revision binding both intent states, both scope hashes, the prior signature,
actual writer and owner generation. It retains every original amendment and resets
the item to pending. This grants no exemption from PLAN review, scope checks,
fresh coverage or final review. DEV cannot use this route to rewrite acceptance.
Dispatched verification-intent writers retain their existing PLAN-only field scope.

Every canonical write for an amended checklist first saves the exact signed
checklist snapshot in an append-only checkpoint sequence under the repository's
shared Git metadata (`proof-or-stop-intent-checkpoints`). Canonical reads reject
a missing or different projection, including deletion of the entire history field.
The latest checkpoint is selected from the contiguous immutable sequence; ordinary
callers cannot supply a replacement signature or silently truncate old history.
Typed integrity errors propagate through gate/roster/query fallbacks. A reordered
JSON object is equivalent under canonical comparison.

An interrupted projection is recovered by the current owner with
`verification_intent_recover --storyId=B-example` (inspection, zero writes), then
`verification_intent_recover` with `apply:true`, the returned
`expectedCheckpointDigest`, and a substantive reason. Recovery restores exactly
the signed snapshot; stale digests, foreign owners and terminal Stories are
refused. It neither reruns commands nor re-attests evidence. The existing CLI
command audit records the recovery invocation. The checkpoint and signing key
are trusted local Git metadata: this is protection against mutable Story-file
corruption and interrupted publication, not a hostile Git-administrator sandbox.

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

All 134 routine and both DONE entries now declare resources. Eleven audited or
conservatively retained routine writers carry an explicit exclusive local plan
barrier. This preserves serialization against every command in their own checkout;
it does not turn a local build into a global writer. Six older shared declarations
are tightened to match the existing writer guard. The historical 21-reader audit
is retained as evidence, with these six superseded by the conservative barrier.
DONE build and full-suite execution remain non-reusable. The full suite retains
its machine-wide exclusive TCP 43127 claim. Graph checks use OS-assigned ports
and retain exclusive local asset access. Independent routine invocations may
share the configured two-invocation capacity only when all actual claims agree.
This configuration change alone does not prove all 134 commands pass or run faster.

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
The historical resource audit now records six explicit supersessions and reports
21 reviewed / 15 effectively shared / 6 retained local writers; exact claim guards
reject both unapproved additional claims and removal of writer protection.

Completed receipt publication has the same two-attempt transaction bound as
complete-output publication. A transient first write retries the original signed
receipt, preserving its timestamp/hash and one command execution; permanent
storage failure still refuses. Superseded resource declarations must preserve
every original audited claim even if both config and supersession metadata are
edited together. Capacity aggregation removes only exact duplicate normalized
claims (195 records become 17 for the current routine configuration); access,
ownership and resolved working directory remain part of the distinct claim.

The repository CLI-surface suite also needs the local `packages/lab` extension.
In a fresh Lab checkout, `scripts/ensure-dist.mjs` prepares main and utils only;
run `npm --prefix packages/lab run build` before CLI-surface verification. A
missing extension intentionally leaves the standalone core without Lab commands
and must be classified as missing preparation, not as a passing full CLI profile.
Build before starting readers, then derive the implementation pin from the final
prepared runtime. The frozen pre-preparation measurements remain separately bound
to their original runtime; do not relabel their implementation identity.
