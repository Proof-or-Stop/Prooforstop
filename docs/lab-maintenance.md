# Temporary Lab maintenance

Lab is a manually invoked local maintenance exception for bounded system bugs and
performance regressions in Proof-or-Stop itself. It uses RED -> GREEN instead of
the full Story lifecycle. New product features and broad redesigns use Stories.
A successful release removes the Lab worktree and merged branch. Failure retains
the workspace and local audit record. There is no automatic remote push.

The command is a repository script, not a registered `proof-or-stop lab_*` command.
Use Node 24+ with native TypeScript stripping and module hooks. It reads source
helpers without booting the Story engine or requiring an initial dist build.
Run it from a checkout of this repository. A checked-out local `main` is required.

## One repair cycle

```sh
npm run lab:worktree -- create slow-query --developer codex
cd .worktrees/Lab-slow-query
npm run lab:worktree -- sync slow-query
```

Creation starts from the latest committed local main. Sync explicitly merges main
before a new repair. Uncommitted main changes are never copied. Dependencies and
build outputs are independent; install dependencies in the Lab as needed. Do not
share writable dist or point the global installation at the temporary Lab. Cleanup
refuses a global package link into Lab; relink it to verified main before retrying.

Write and commit a focused regression test first, staging explicit paths to keep
the generated `AGENTS.override.md` untracked. Then record the expected failure:

```sh
npm run lab:worktree -- red slow-query --expect 'specific regression assertion' -- node path/to/regression-test.mjs
# Make the smallest sound fix; commit the implementation and regression coverage.
npm run lab:worktree -- green slow-query
```

RED requires a failed, non-signaled command whose output contains the specified
marker; GREEN reruns that exact executable and argv after a repair commit. Choose
an assertion that identifies the actual bug: a missing dependency is not RED.
The recorded command should cover the reproduction and relevant regressions.
Performance assertions must compare equivalent conditions and define a threshold.
Command exit status cannot prove that a test is meaningful; maintainers must still
review test intent, coverage, and whether an optimization weakens a contract.
When changing `test:serial-reference` or `test:serial-reference-prefix`, build and
run `node packages/main/dist/tasks/full-suite-runner-smoke.js` before GREEN. Its
live inventory check verifies every canonical member has a resource policy;
per-command success alone does not establish suite membership completeness.

Keep hooks enabled and preserve prompt plus mechanical enforcement for process
facts. Local records are not formal Story REVIEW, TEST, DONE, or signed
artifact/capability-release evidence. No Story JSON is created or advanced.

### Root-install dependency regression

Run `npm run test:root-ws-types` after changing root build dependencies or their
lockfile. This opt-in installation check runs root-only `npm ci` in a temporary
directory, typechecks the main sources, and checks static and dynamic WebSocket
types. It is intentionally outside the default validation suite: unlike ordinary
source checks, it installs the locked root dependency tree and may need npm
registry access when packages are not cached. Use it explicitly in a
network-enabled maintenance or CI job; installation failure is never target RED.

## Carry a blocked Story patch

An explicitly authorized Lab may carry one clean Story patch when its intended
behavior is complete but unrelated repository-baseline failures prevent lifecycle
closure. This is an integration exception, not a way to mark the source Story
DONE:

```sh
npm run lab:worktree -- carry repair-name \
  --story B-xxxx \
  --source /absolute/path/to/.worktrees/B-xxxx \
  --confirm
```

The action accepts only the matching registered `story/B-xxxx` worktree in
REVIEW or TEST. The source must be clean, every checklist item must be done,
there must be no open Finding, and the executed validation artifact must report
complete mechanical intent coverage bound to one `storyFilesHash`. Carry does
not trust those JSON fields by shape: it recomputes the material and Story-files
hashes and runs every required intent through the same strict authoritative
receipt evaluator used by lifecycle gates. Legacy, unsigned, tampered, stale,
or self-authored receipt claims are refused. Current main is built before every
baseline capture. Every failed validation command is then rerun on that built
main with the same executable and argv; a command that passes on main, changes
exit code, cannot execute, or would raise the bounded failure count above five
stops the import.

If main advances after capture and a command that PASSed in the source evidence
now fails, preserve it without repairing unrelated code:

```sh
npm run lab:worktree -- baseline repair-name \
  --expect 'specific current-main failure marker' --confirm -- \
  node path/to/exact-recorded-command.js
```

The command must exactly match a PASS row in the carried full validation, must
now fail on main with the named marker, and must not change main. Duplicate or
invented commands are refused. The supplemental witness invalidates GREEN and
joins the same latest-main, built-candidate, and post-merge parity checks.

The Lab stores the source head, evidence head, material and Story-files hashes,
command counts, both failure-output digests and bounded tails, patch digest, and
imported paths in its HMAC-bound local record. It applies only the source diff
outside `.proof-or-stop/`; Story state, phases, findings, passes, receipts, and
other lifecycle metadata are never copied or rewritten. Commit and review the
staged patch, then rerun `green`. Release notes disclose the source Story and
state explicitly that the carry-forward is not Story DONE.

Ordinary Lab finish still requires clean main. For a Story carry-forward only,
pre-existing dirty main files may remain when they do not overlap any candidate
path. Finish records their path set and content/index fingerprint, checks it
before integration and after every main-side build or verification step, and
stops if any byte, staging state, path, or overlap changes. It never stashes,
commits, restores, or copies those unrelated files.

This rule preserves evidence instead of treating a repository-wide FAIL as a
PASS. It proves only that all remaining failed commands also fail on main at the
time of capture; different failure output remains visible in the record and is
not claimed to have the same root cause. Finish repeats those exact baseline
commands against the latest main and treats its current exit codes as the
integration oracle. A failure fixed on main must remain fixed in the built
candidate; a failure still present on main must retain both the same exit code
and normalized diagnostic identity.

PASS evidence is reused only when its recorded runtime trace proves it is not
affected by changes between the Story base and latest main. A traced command is
replayed when a changed repository path intersects its recorded read/load/spawn
inputs. Missing, incomplete, unknown, or oversized trace input fails closed by
replaying that command. Explicit supplemental baseline commands are removed
from this PASS set because their current-main failure is checked by the stricter
baseline path. The resulting impacted/fallback command set is run on both the
built candidate and post-merge main. This is bounded dynamic revalidation, not
a narrative claim that all historical commands ran again; if trace closure is
unavailable for every PASS, it deliberately falls back to replaying every PASS.

## Explicit release and cleanup

Only after the user asks to integrate the repair, prepare an English notes file
outside the worktree (40-100000 characters) describing the problem, behavior change,
verification, and measured performance improvement where relevant. Then run:

```sh
cd ../.. # Return from .worktrees/Lab-slow-query to main before cleanup.
npm run lab:worktree -- finish slow-query --notes /absolute/path/repair-notes.md --confirm --bump patch
```

Write notes as 3-5 concise bullets about final delivered changes, including the
verification and any important limitation. Link detailed investigation or audit
records; do not copy failed attempts or withdrawn designs into the release summary.
When updating CHANGELOG.md, read only the current entry or relevant Git diff.
Consult older Git history only for a specific historical question; do not regenerate
the full file. The 2026-09-18 user-authorized compaction keeps earlier entries at
`a8768173bc7488aa8fdc3ef45f1ed295cbd924c8:CHANGELOG.md`; the identity verifier checks
those retained bytes, ancestry from HEAD and the exact compact replacement, permitting later prepends.

Finish requires a clean main and clean committed Lab with current GREEN. It holds
the same main write lock as formal operations, merges latest local main into Lab,
reruns the pinned test, and prepares a local release commit. Lab decides release
version and build requirements separately. Runtime inputs
retain the shared DONE build predicate; executable maintenance scripts under
`scripts/` also trigger an automatic patch release. An explicit `--bump patch`
on finish requires a patch release even for changes outside those paths.
Every version bump triggers a build and CLI version check because the runtime
brand constant changes. The requested policy is stored with the prepared release;
retrying finish reuses that release and never bumps twice. Omitting the option
on retry preserves the prepared policy. A patch request against an already
prepared unbumped candidate is refused; reopen it before changing release intent.
Qualifying runtime/contract changes use the existing
atomic patch-bump helper for both manifests, both lockfiles and the CLI brand
constant. Ordinary documentation-only changes retain the version unless a patch is requested. Changes and
verification commands are recorded in CHANGELOG.md with Lab/commit provenance.

The candidate uses the existing `scripts/ensure-dist.mjs` preparation when required
(main plus utils, including the CLI bootstrap dependencies), its CLI version is checked, and its regression
command replayed before a fast-forward-only main update. Main is then built and
checked again. Only after post-merge verification and reachability checks does the
command remove the generated override, clean worktree and merged branch. It never
uses force removal, a hard reset, a forced branch deletion or a push. Existing
mechanical restrictions are not disabled. `status` only reads the existing signed
record; it never acquires a write lock or initializes a signing key. RED and GREEN
hold a per-Lab operation lock, allowing different Labs to verify concurrently and
unrelated main writers to proceed. All Lab mutators take that same per-Lab lock
first; sync, creation and finish additionally take the main write lock. Therefore
finish cannot merge or delete a Lab while its verification is running. Finish's
integration/build/recheck section still holds the main lock; this change does not
make concurrent main releases safe. A conflicting operation on the same Lab fails
with the holder's operation lock. Long synchronous checks retain a heartbeat and
must still own their lock and original signing key before publishing a result.
The 120-second fallback stale threshold spans four 30-second heartbeat intervals,
so a missing process-start probe does not expire a live operation between beats.
The operation-lock protocol introduced signed schema 2; mandatory vendor audit below now uses schema 3. An existing schema-1 Lab first takes the main
lock briefly to record its upgrade, waiting for operator retry if an old writer
is active. The long test runs after this upgrade releases the main lock. Older
Lab scripts reject schema 2 instead of bypassing its operation lock; use the
updated checkout command for subsequent operations. Status can read either
schema without upgrading it. This adoption is per Lab, not a migration of every
existing worktree or running session.
The default command timeout is 30 minutes (1800 seconds) per process. Long regression commands
may declare `--timeout-ms MS` between the RED marker and `--` (1–3600000 ms).
The signed RED record binds that budget; GREEN and integration checks replay it
unchanged. Existing records with an explicit timeout retain that value, including
the former 15-minute default; records without a stored timeout use the current
30-minute default. A timeout never counts as target RED or passing GREEN.

Audit input uses a separate 64 MiB bound for each Git read and the complete
serialized commit snapshots. Provider output remains bounded at 8 MiB. Full
snapshot and diff digests remain mandatory; the initial provider prompt contains
snapshot references rather than repeating large source files. Oversized, binary,
invalid UTF-8 or mutated snapshots still refuse audit. This input allowance does
not imply passing review or permission to omit changed files.

Local HMAC-bound command records and captured output stay in the Git common
`lab-maintenance/` directory after worktree cleanup. They are tool-owned local
provenance, not tamper-proof against a user who controls the local key, and not
independent reviewer evidence. Keep secrets out of test output. A name cannot be
reused after cleanup, preserving its record; choose a new repair name.

## Failures and recovery

- Dirty main or Lab: preserve/commit the pending work, then retry. No automatic stash.
- Merge conflicts: resolve and commit them in Lab, rerun GREEN, then finish.
- Failed build without source changes (for example missing dependencies): repair
  the environment and retry finish with the same notes file. The pinned developer is reused even
  in a plain terminal; for an unpinned legacy Lab supply `--developer PROVIDER`.
  Version is not bumped twice.
- Prepared candidate needs source changes, new notes, or main advanced: run
  `npm run lab:worktree -- reopen NAME --confirm`. This reverts only the generated
  release commit, preserves repair history, and invalidates GREEN. Sync main,
  make any required repair, commit, then green and finish again.
- Failure after main integration: main already contains the candidate. The Lab is
  retained. Correct the environment and retry finish; do not claim rollback. If
  main or source must change, inspect status and perform explicit recovery; the
  tool refuses to rewrite integrated history automatically.
- Cleanup failure: the verified candidate is already on main. Retry finish; the
  integrated version will not be bumped again. Unknown files, locks and new work
  are preserved. Do not use forced cleanup to conceal a failure.

Use `npm run lab:worktree -- status NAME` to inspect progress. Direct edits to
records are rejected. Manual/legacy worktrees (including the original Lab-story
bootstrap workspace) are not silently adopted. Install/merge this mechanism first;
subsequent Labs created by the command get the complete managed cycle.

### Machine provider admission

Provider launches acquire both their project slot and a same-OS-user machine
slot. The machine pool lives under the OS account home runtime locks directory,
uses a private directory, and has an independent capacity of four. Raising a
project concurrency environment setting cannot raise that machine capacity.
Machine refusal releases the tentative project slot before returning.

Identity-aware launchers transfer both slots to the actual provider process
identity. A worker exit alone does not free capacity while that provider group
is alive. `node scripts/verify-machine-provider-admission.mjs` verifies admission,
zero launch on refusal, rollback, and a real detached provider surviving its
worker and then exiting naturally. Tests isolate the OS-home lookup in their own
processes; production has no alternate-pool environment switch.

Synchronous planned/dispatch providers now execute through an isolated bridge.
The bridge transfers both slots before spawning a provider into its own process
group. Provider output cannot write the separate control pipe. Release and retry
require a control result plus observed group exit; missing control proof retains
capacity. A normal provider exit also triggers cleanup of ordinary same-group
descendants. Daemon/setsid escape is outside this process-group contract.
`node scripts/verify-planned-provider-group-lifecycle.mjs` exercises the actual
planned executor; `node scripts/verify-supervised-provider-boundaries.mjs` covers
output fidelity, missing binaries and timeout cleanup. These bounded checks do
not establish full U-08 product acceptance.

### Scope budget validation groups

New `storyScopeBudget.validationGroups` mappings use `commandIds`, resolved by
the same canonical inventory as validation. Declared IDs remain stable; derived
IDs bind command, argv, cwd and shell. Legacy `commandLabels` remain accepted
only when every label resolves to exactly one configured command. Missing or
ambiguous references, duplicate command IDs and mixed reference forms yield an
unknown budget and block enforce mode. Distinct commands using `node` cannot
stand in for each other. This identity repair does not enable or calibrate the
root repository scope budget policy.

## Mandatory independent vendor audit

Lab finish requires at least one actual audit from a vendor different from the
development provider. It is not a fixed Claude/Codex pair. Built-in adapters map
Codex to OpenAI and Claude CLI to Anthropic. The default selects an available
adapter from a different vendor; an explicit preferred auditor is also supported.
Missing executables, same-vendor selections and failed reviews block integration.
There is no skip flag or caller-supplied approval path.

```sh
npm run lab:worktree -- create repair-name --developer codex
npm run lab:worktree -- audit repair-name --developer codex
npm run lab:worktree -- finish repair-name --notes /absolute/path/notes.md --confirm --bump patch
```

To register another vendor, have the operator review and integrate
`lab-audit.config.json` on main. Audits consume that trusted baseline configuration;
a candidate cannot select its own auditor by changing the configuration:

```json
{
  "adapters": [{
    "id": "grok",
    "vendor": "xai",
    "command": "/absolute/path/to/grok-audit-adapter",
    "argv": ["--schema", "{schema}"],
    "protocol": "lab-json"
  }],
  "preferredAuditor": "grok"
}
```

The example names a required local adapter, not an assumed Grok CLI command or
an installed integration. A custom adapter must consume the prompt on stdin,
accept the supplied schema file if needed, invoke its declared vendor in a
read-only mode, and return exactly one JSON verdict matching the schema. No shell
interpolation is performed. Built-in IDs cannot be overridden. Provider/vendor
registration is trusted local operator configuration, not remote vendor
attestation; a malicious executable or dishonest vendor declaration is outside
that trust boundary. The tool captures the actual invocation and process result.

Supported host context supplies the developer identity when available; otherwise
an explicit provider declaration is required. `finish` also accepts
`--developer PROVIDER` for an older Lab that has not pinned its developer. The developer is pinned once; later audit/finish operators may use a plain
terminal or a different host without changing that attribution. An explicit
conflicting developer declaration is refused. This is attributable host identity, not
cryptographic proof of who edited each byte. Do not relabel an existing Lab merely because a different operator retries its
release; the recorded developer still owns the implementation.

Audit receives the exact committed diff and complete changed-file contents,
inline or in a read-only snapshot. It runs through shared provider admission and
the process supervisor. A strict structured verdict binds the Lab, developer and
auditor IDs and vendors, candidate HEAD, main baseline, complete input digest,
provider-configuration digest and invocation ID. Read references must cover the
changed paths; these are the auditor's declarations, not independent filesystem
read receipts. Any finding, failed invocation, timeout, malformed/duplicate
output, stale binding, changed snapshot or incomplete cleanup prevents passing.

Finish audits the prepared candidate before merging and reuses only its exact
fresh passing record on recovery. An early audit cannot approve later commits or
a changed baseline/configuration. Rejected unchanged candidates cannot be rerolled, including after reopening and regenerating a release commit;
reopen and repair a prepared candidate before retrying. Raw provider output,
process receipts, duration and verdict remain under the Git common Lab audit
directory; the local HMAC record pins the result. Synthetic fixture CLIs only test
the transport/gates and never count as independent provider audit of this repo.
These local records do not create formal Story evidence.

Schema 3 fences older writers after adoption. Existing active Labs upgrade under
the shared lock and must earn the audit before integration. The executing trusted
Lab checkout supplies both version and build policy; version numbers always start
from synchronized latest main. Use the reviewed updated Lab executable when
bootstrapping a change to the Lab tool itself.

Audit inputs must be valid UTF-8 text with exact path names. Immutable commit inputs are cached only within one command process. Rejected repair-content digests cover the complete pre-release diff, including manually edited manifests, while excluding only the tool-generated release commit and the out-of-tree notes file. Changing release notes cannot unlock another audit. Reopening or regenerating a release without changing that repair diff cannot request another audit.

Legacy records without a pinned developer always require an explicit `--developer PROVIDER` naming the implementation provider, even from a recognized terminal. During an actual finish-time provider audit only the per-Lab lock remains held. Finish reacquires the main lock and rechecks the main branch, HEAD and dirty-state boundary before proceeding; concurrent main movement retains the candidate for explicit recovery.

Provider audit has a registered 30-minute (1800-second) total budget and 90-second startup budget; timeout is a failed invocation, never approval. Reviewers receive the full diff and complete snapshots, and inspect changed regions plus necessary surrounding context instead of exhaustively rereading unrelated historical content. Missing dependency context must be stated explicitly; denied reads are not evidence.

The pinned Lab worktree verifier also executes the isolated lock-scope regression. Audit input refuses changed paths that collide as file/directory prefixes before snapshot creation. Binary content and size overflow have separate diagnostics naming the cause; these refusals occur before main integration.

Developer IDs must exist in the trusted provider configuration. Creation rejects unknown IDs before creating the worktree; legacy attribution is persisted only after the provider configuration and audit subject validate, so a typo cannot permanently pin an invalid identity.

### Route restoration dependency boundary

Story2 route and history handlers accept an internal source restoration reader
from registry composition. The Story1 adapter rederives the signed material or
head-only restoration against the exact proposal and current workspace on each
read. Public command JSON cannot supply the reader or restoration payload.
Standalone Story2 callers remain strict under drift; current-reviewer acceptance
never uses the restoration port. Progress revalidation reads the proof again.
`node scripts/verify-route-reattestation-dependency-direction.mjs` checks the real
component DAG and native signed restoration with missing, substituted and wrong
workspace controls. These disposable tests are not Story completion evidence.

### Exact-candidate verification in audit inputs

Audit input includes a bounded measurement projected from the authenticated local
Lab history. A candidate-green command becomes eligible only after exit success,
absence of process error, clean checkout and unchanged HEAD have all been checked.
Rejected runs remain in history without the checkout-verified marker. The first
accepted record matching the candidate SHA and pinned executable/argv remains
stable across successful retry replays. The projection includes command, deadline
allowance, elapsed time, timestamp, output digest and a bounded output tail; it is
covered by the audit input digest and does not grant independent approval. Early
audits without an accepted candidate measurement receive null rather than an
invented pass. This external-to-Git measurement avoids requiring a candidate commit
to contain its own SHA or its future execution result.

Large audit bodies use complete `diff.patch` and per-file snapshots, with a path/size/digest manifest in the initial prompt. The original full-input digest and complete changed-path read-reference requirement remain unchanged. Both diff and file bytes are checked after the provider exits. `scripts/verify-lab-audit-prompt-budget.mjs` exercises real transport with a disposable synthetic adapter; it is not independent audit evidence.

### Audit deadline sizing

Independent Lab audits retain the main branch’s 30-minute minimum. The immutable changed-path
count supplies a five-second allowance per path; complete diff plus snapshot
bytes supply a one-minute allowance per MiB. The larger allowance is rounded up
to five-minute increments. Work exceeding the one-hour maximum is refused before
provider launch with an explicit split-the-repair diagnostic, rather than silently
clamping an undersized budget. For example, 347 small files receive 30 minutes;
a single file with 40 MiB of diff plus snapshot content receives 40 minutes.
These are configuration allowances, not measured speedups or guarantees of approval.
The earlier 347-path audit hit its 900-second total deadline after 337 Read
calls and 272 distinct path attempts, without a verdict. A Read attempt alone is
never complete coverage or approval. The subsequent 30-minute-budget audit returned
an incomplete fail after 235 seconds; that is a coverage refusal, not a timeout.

Every provider type consumes the same calculated deadline; startup remains 90
seconds and process-group cleanup remains required. Each audit records its exact
path count, review bytes and deadline in `budget.json` and prints them before launch. Timeout
reports the deadline and cleanup state explicitly and never produces an accepted
verdict. Different-vendor independence, exact candidate/digest bindings, complete
changed-path references and refusal of unresolved findings are unchanged.

Audit navigation also includes an exact Git diff for each changed path under
`changes/`, with its byte length and SHA-256 in the file manifest. Complete
aggregate diff and source snapshots remain available and are checked after the
provider exits, together with every per-file patch. The read-only Claude adapter
allows Read, Grep and Glob so auditors can locate changed regions without paging
the full aggregate diff. Navigation files do not grant coverage or a PASS.

### Bounded module audit batches

Candidates with more than 24 changed paths use deterministic directory-family
batches of at most 24 paths and 2 MiB of snapshot content; a single larger file
gets its own batch and retains the existing input/deadline bounds. Every batch
receives its assigned exact patches and complete snapshots, with the complete
candidate snapshot tree available for dependency tracing. Every provider verdict
binds the same base, candidate, full input digest, configuration and vendors.
The tool rejects omitted assigned paths, stale bindings, reused invocation IDs,
findings, failed processes and incomplete cleanup. A partial batch cannot pass
the full-candidate freshness check.

After all module batches pass, a separate independent integration review receives
all batch summaries and the complete candidate manifest, diff and snapshots. It
checks cross-module imports, registrations, retirement boundaries, audit authority
and runtime interactions. Its readRefs acknowledge paths considered in that
integration assessment; module readRefs remain declarations of inspected changed
regions. Neither is an operating-system read receipt. The controller requires
every changed path in exactly one module batch and all required batches plus the
integration review to pass before publishing a full-candidate verdict. Any failure
retains evidence and blocks finish. Batches run sequentially through existing
provider admission; this does not authorize parallel agents or reuse another
candidate's approval. Synthetic transport tests never constitute vendor approval.

Every audit also receives a complete exact-commit tree inventory. Changed-file
snapshots are not a complete repository listing: reviewers must consult that
inventory before reporting a missing file. Bounded static reference traversal
supplies unchanged source imports and documentation targets under the snapshot
tree (at most 400 additional files and 16 MiB). Non-text, unsupported, private
metadata and budget-omitted contexts are explicitly listed; this is not a complete
dynamic dependency closure. Every supplied byte and the tree inventory are checked
again after the provider exits. Unavailable context must be reported as a limit,
not invented as a missing repository file.

A well-formed module verdict containing findings does not stop the remaining module
batches: the controller collects their findings on the same frozen candidate and
returns a combined failure. Integration review runs only after every module batch
passes. This avoids repeated early-file reviews hiding later defects. Transport
errors, invalid bindings, incomplete coverage, snapshot mutation or unsafe cleanup
still stop immediately; continued collection never converts failure into approval.
