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

For explicitly eligible shared commands on a clean workspace, the DONE
handler commits its own ADMITTED-to-RUNNING certification window
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
