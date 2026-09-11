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
npm run lab:worktree -- create slow-query
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
Keep hooks enabled and preserve prompt plus mechanical enforcement for process
facts. Local records are not formal Story REVIEW, TEST, DONE, or signed
artifact/capability-release evidence. No Story JSON is created or advanced.

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
New records use signed schema 2. An existing schema-1 Lab first takes the main
lock briefly to record its upgrade, waiting for operator retry if an old writer
is active. The long test runs after this upgrade releases the main lock. Older
Lab scripts reject schema 2 instead of bypassing its operation lock; use the
updated checkout command for subsequent operations. Status can read either
schema without upgrading it. This adoption is per Lab, not a migration of every
existing worktree or running session.
The default command timeout is 15 minutes per process. Long regression commands
may declare `--timeout-ms MS` between the RED marker and `--` (1–3600000 ms).
The signed RED record binds that budget; GREEN and integration checks replay it
unchanged. Existing records retain the 15-minute default. A timeout never counts
as target RED or passing GREEN.

Local HMAC-bound command records and captured output stay in the Git common
`lab-maintenance/` directory after worktree cleanup. They are tool-owned local
provenance, not tamper-proof against a user who controls the local key, and not
independent reviewer evidence. Keep secrets out of test output. A name cannot be
reused after cleanup, preserving its record; choose a new repair name.

## Failures and recovery

- Dirty main or Lab: preserve/commit the pending work, then retry. No automatic stash.
- Merge conflicts: resolve and commit them in Lab, rerun GREEN, then finish.
- Failed build without source changes (for example missing dependencies): repair
  the environment and retry finish with the same notes file. Version is not bumped twice.
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
an explicit provider declaration is required. Conflicting host context or a change
to the pinned developer is refused. This is attributable host identity, not
cryptographic proof of who edited each byte. Mixed-provider implementation must
be scoped separately rather than relabeling an existing Lab.

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
a changed baseline/configuration. Rejected unchanged candidates cannot be rerolled;
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
