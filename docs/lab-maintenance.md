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

## Explicit release and cleanup

Only after the user asks to integrate the repair, prepare an English notes file
outside the worktree (40-100000 characters) describing the problem, behavior change,
verification, and measured performance improvement where relevant. Then run:

```sh
cd ../.. # Return from .worktrees/Lab-slow-query to main before cleanup.
npm run lab:worktree -- finish slow-query --notes /absolute/path/repair-notes.md --confirm
```

Finish requires a clean main and clean committed Lab with current GREEN. It holds
the same main write lock as formal operations, merges latest local main into Lab,
reruns the pinned test, and prepares a local release commit. The version/build
predicate is shared with DONE. Qualifying runtime/contract changes use the existing
atomic patch-bump helper for both manifests, both lockfiles and the CLI brand
constant. Ordinary documentation-only changes retain the version. Changes and
verification commands are recorded in CHANGELOG.md with Lab/commit provenance.

The candidate uses the existing `scripts/ensure-dist.mjs` preparation when required
(main plus utils, including the CLI bootstrap dependencies), its CLI version is checked, and its regression
command replayed before a fast-forward-only main update. Main is then built and
checked again. Only after post-merge verification and reachability checks does the
command remove the generated override, clean worktree and merged branch. It never
uses force removal, a hard reset, a forced branch deletion or a push. Existing
mechanical restrictions are not disabled. Long checks hold the main write lock;
other writers must wait or retry. The command timeout is 15 minutes per process.

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
