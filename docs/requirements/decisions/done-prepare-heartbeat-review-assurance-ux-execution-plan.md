# DONE Prepare Heartbeat And Review Assurance UX Execution Plan

Status: proposal / execution plan
Created: 2026-07-09
Source incident: B-90d6 closeout

## Purpose

Fix the end-of-story drivability gaps exposed during B-90d6 closure:

1. `done_prepare` printed progress while running validation, then went silent
   during DONE closure, runtime-change, and clean-tree projection.
2. Review assurance was a legitimate DONE requirement, but the requirement was
   discovered late and without a clear enough operator recipe.

This plan improves operator and agent visibility. It must not weaken DONE,
review, delivery, scope, Authority, or verification gates.

## Problem Statement

### Silent `done_prepare` Closure

Observed behavior:

```text
done_prepare
  -> prints validation progress through 43/43 configured commands
  -> validation completes
  -> no output while evaluating DONE closure / runtime-change / clean-tree
  -> command eventually returns a real result
```

The command was not functionally stuck, but the lack of progress made it look
stuck. Agents and humans can reasonably misread this as a hung process and
interrupt a valid closeout.

Expected human output examples:

```text
done_prepare progress: evaluating DONE closure
done_prepare progress: checking review assurance
done_prepare progress: computing runtime-change status
done_prepare progress: checking clean tree
```

Long closure projections should emit a heartbeat at a bounded interval,
preferably every 30 seconds, until the command returns or fails.

The full required label set is defined in M1. Examples in this problem
statement are illustrative only, so acceptance does not drift across multiple
partial lists.

### Late Review Assurance Surfacing

The missing review assurance was not, by itself, a gate bug. In the observed
story, review assurance was required because:

- the first REVIEW round had multiple countable findings; and
- the touched code paths were lifecycle / gate / process-fact state machinery.

The bug is UX and drivability: the CLI should surface the review-assurance
requirement as soon as the canonical review-assurance / DONE gate predicate says
the condition is known, and again at phase boundaries, instead of letting the
agent discover it only at `done_prepare` or DONE.

Correct behavior:

- make the requirement visible when the first review round creates or confirms
  the canonical escalation trigger;
- keep it visible in `review_escalation_status`, `session_brief`, `next`, TEST
  entry guidance, and `done_prepare --dryRun`;
- print the exact next commands or command families needed to satisfy the gate;
- explain why the CLI cannot auto-write host verdicts, degraded fallback, or
  reviewer evidence.

## Non-Goals

- Do not relax review assurance, DONE, delivery, validation, scope, or Authority
  gates.
- Do not auto-sign reviewer evidence, host verdicts, delivery checks, or
  degraded fallback attestations.
- Do not claim Authority DONE, full Authority DONE, or production DONE from
  local fallback evidence.
- Do not hide or skip long-running validation.
- Do not pollute `--json` stdout with human progress text.
- Do not reimplement the B-783c global-thin activity-root fix.

## Existing Coverage From B-783c

B-783c is already DONE and merged to local `main`. It covers a related but
different heartbeat layer:

- managed global-thin roots with `.lattice/lattice.json` and
  `assetMode=global-thin` are eligible for runtime activity logging;
- `cli-engine` activity logging uses the runtime activity-root helper instead
  of requiring only `lattice.config.json`;
- `lattice codex verify` global fallback heartbeat can observe
  `session_brief` activity in a global-thin project;
- `thin-init-assets-smoke` covers canonical roots, valid global-thin roots, and
  malformed / wrong-assetMode roots.

That work should be treated as an existing prerequisite and regression guard,
not as work to redo in this story.

The remaining gap in this plan is command-output drivability during
`done_prepare` closeout: progress / heartbeat text, JSON-safe liveness,
post-validation closure phase deadlines, and early review-assurance surfacing.
Activity-log persistence can provide audit evidence that a command ran, but it
does not replace real-time operator-visible progress output and must not be used
as the only liveness signal for `done_prepare`.

If an implementation touches `cli-engine` activity logging, runtime root
detection, or Codex global fallback verification while implementing this plan,
it must rerun the B-783c regression smoke. If the implementation stays inside
`done_prepare` / review-assurance output paths, B-783c should remain a referenced
baseline rather than a required implementation milestone.

## Milestone Ledger

| Milestone | Status | Goal | Acceptance |
|---|---|---|---|
| M0 Incident Fixture | Not Started | Freeze the B-90d6 closeout transcript as a regression fixture | Fixture captures 43/43 validation progress followed by silent closure projection and late review-assurance discovery |
| M1 Closure Progress Contract | Not Started | Define the `done_prepare` progress and heartbeat contract | Human mode prints phase start/end and heartbeat lines; JSON stdout remains machine-parseable |
| M2 Closure Heartbeat Implementation | Not Started | Emit progress for post-validation closure work without weakening fail-closed timeouts | Output covers the M1 label set; every heartbeating phase also has an independent hard deadline and a hang regression test |
| M3 Early Review Assurance Surfacing | Not Started | Surface review-assurance requirements before DONE closeout from the canonical gate predicate | Escalation appears after triggering review evidence, in required status commands, at TEST entry as advisory guidance, and in `done_prepare --dryRun` |
| M4 Actionable Blocker Summary | Not Started | Classify closeout blockers and print safe next commands | Output distinguishes required gate, missing evidence, generated metadata needing commit, stale material, and cannot-auto-sign cases |
| M5 Re-run And Merge-Preflight UX | Not Started | Explain repeated `done_prepare` runs and catch merge hazards earlier | Re-runs print what changed since the previous attempt; untracked-overwrite and metadata-commit blockers are reported before ambiguous DONE state |
| M6 Regression Verification | Not Started | Prove the UX improved without weakening gates | Smoke tests cover heartbeat, heartbeating hangs still failing closed, early review-assurance guidance, JSON/process-fact cleanliness, no auto-signing, dry-run immutability, and true gate failures still blocking |

## Execution Details

### M0 - Incident Fixture

Record a compact fixture from the observed closeout:

- `done_prepare` validation reached all configured commands;
- post-validation closure projection produced no progress for long enough to
  look stuck;
- review assurance was discovered as a blocker late in closure;
- the story required explicit local degraded review assurance before DONE.

The historical fixture may record the observed 43/43 validate command count, but
live regression tests must not assert a fixed command count. They should assert
progress and heartbeat behavior over whatever validate command set the current
configuration defines.

The fixture should be a regression contract, not proof of correctness.

### M1 - Closure Progress Contract

Define stable progress labels for `done_prepare`:

```text
done_prepare progress: preflight
done_prepare progress: merging main
done_prepare progress: refreshing stale evidence
done_prepare progress: running validation
done_prepare progress: evaluating DONE closure
done_prepare progress: checking review assurance
done_prepare progress: computing runtime-change status
done_prepare progress: checking clean tree
done_prepare progress: producing DONE command
```

Human-readable progress may go to stdout in human mode. In `--json` mode,
progress must go to stderr or another side channel so stdout remains parseable.
Every progress event must flush immediately.

This M1 list is the source of truth for required progress labels. Later
milestones should refer to this list instead of maintaining their own partial
label sets.

Watchdog liveness must be decoupled from human text routing. If JSON mode uses
stderr or a structured side channel, that side channel must participate in the
same liveness accounting as human mode while preserving parseable JSON stdout.

### M2 - Closure Heartbeat Implementation

Add heartbeat coverage to post-validation closure work. Validation already has
its own progress contract; this story extends the same visibility principle to
the quiet phases after validation.

Heartbeat output is diagnostic visibility. It is not, by itself, proof of real
progress.

Every heartbeating closure phase must have an independent hard wall-clock
deadline that fails closed with an attributed error even if heartbeat output
continues. The phase deadline must not rely on the global idle watchdog. Prefer
phase deadlines below the global idle timeout; if a phase legitimately needs
more time, split it into bounded substeps with their own deadlines.

The implementation must define mechanical progress signals for each phase, such
as phase start, phase completion, child output, child exit, or bounded checked
work units. A pure timer loop must not keep a hung phase alive indefinitely.

True hangs, child command timeouts, and impossible gate states must still fail
closed in both human and JSON modes.

### M3 - Early Review Assurance Surfacing

Whenever a story reaches a review-assurance escalation condition, the CLI should
make that fact visible immediately. The condition must be computed from the same
canonical review-assurance / DONE-closure source of truth used by the gate; do
not duplicate or approximate the predicate in display-only code.

Required first implementation surfaces:

- review finding creation or first-round review summary;
- `review_escalation_status`;
- `story_advance --phase=TEST`;
- `session_brief` and `next`;
- `done_prepare --dryRun` and `done_prepare`.

Optional follow-up surfaces:

- `review_pass_set` / review evidence status writers;
- other reviewer-evidence writers whose stdout / JSON contracts can be covered
  by process-fact regression tests.

The guidance should say why the requirement exists, for example:

```text
Review assurance required:
  reason: >=2 countable first-round reviewer findings and high-risk lifecycle/gate/process-fact work
  current: missing fresh required assurance for current material
  binding: current materialDigest=<...> storyFilesHash=<...>
  required writer: <canonical legal writer from review-assurance status>
  fallback: <eligible | not eligible>, reason=<canonical reason code>
  next: run review_escalation_status, then submit the required host verdicts or record an explicit degraded-single-host fallback only when the canonical status says fallback is eligible
```

The guidance must also say what the command will not do:

```text
This command will not auto-write host verdicts or fallback evidence.
Those records must come from the reviewer / host path and bind to the current material.
```

TEST-entry surfacing is advisory. It warns that DONE will require fresh review
assurance, but it must not turn review assurance into a TEST gate unless the
canonical lifecycle policy separately defines that gate.

### M4 - Actionable Blocker Summary

`done_prepare` should group blockers by operator action:

| Class | Meaning | Example guidance |
|---|---|---|
| Required gate | A real DONE gate is unsatisfied | Run the named gate/status command and satisfy the evidence |
| Missing evidence | Evidence is absent but may be produced by a legitimate writer | Print the exact writer or reviewer path |
| Generated metadata | `done_prepare` wrote or refreshed lifecycle metadata | Commit only the files generated by this `done_prepare` run, then rerun |
| Stale material | Evidence is bound to an old material hash | Refresh evidence or rerun review on the current material |
| Cannot auto-sign | The CLI must not self-attest the evidence | Use reviewer, host, or human-approved fallback path |

This reduces the pattern where an agent sees a single missing phrase, guesses a
command, and learns the next blocker one failure at a time.

Generated-file guidance must separate files produced by the current
`done_prepare` run from unrelated dirty files. It must never suggest committing
unrelated user changes.

Generated metadata must also be classified by hash impact:

- hash-excluded lifecycle metadata may be committed and rerun without forcing
  review-assurance rebinding;
- hash-included lifecycle metadata must warn that committing it changes the
  relevant material / story-files binding and may require fresh review,
  delivery, quorum, or DONE evidence.

If required lifecycle metadata is hash-included and creates a commit -> rebind
-> new metadata loop, the implementation story must fix that ordering or hash
classification before claiming this UX story complete.

### M5 - Re-run And Merge-Preflight UX

Repeated `done_prepare` calls can be valid, but the reason should be visible.
When a previous run generated metadata, merged main, changed material, or
refreshed evidence, the next run should summarize the delta:

```text
done_prepare re-run reason:
  previous run wrote done-required-evidence.json
  material hash changed after metadata commit
  review assurance must bind to the current material
```

Also preflight merge hazards before DONE state becomes confusing:

- untracked files on `main` that would be overwritten by the story merge;
- generated metadata left uncommitted;
- local branch divergence that requires a manual merge;
- unrelated dirty files that `done_prepare` will not touch.

The command should print exact file paths and safe next steps.

`done_prepare --dryRun` must be side-effect free. It may inspect state and print
planned actions, but it must not change git state, evidence files, lifecycle
metadata, process events, review artifacts, or timestamps that participate in
gates.

### M6 - Regression Verification

Add focused smoke tests:

- long post-validation closure emits progress or heartbeat before the idle
  deadline;
- a deliberately hung post-validation closure phase with heartbeat enabled still
  fails closed by its independent phase deadline;
- heartbeat / liveness behavior works in both human mode and `--json` mode while
  `--json` stdout remains parseable;
- `done_prepare --json` stdout remains parseable;
- review-assurance escalation is visible before DONE when the trigger is known;
- review-assurance UX is generated from the canonical gate/status predicate and
  includes reason code, current material binding, legal writer, and fallback
  eligibility;
- no command auto-writes host verdicts, fallback evidence, or reviewer evidence;
- `done_prepare --dryRun` leaves git state, evidence files, lifecycle metadata,
  process events, review artifacts, and relevant timestamps unchanged;
- true missing assurance still blocks DONE;
- generated metadata produces a clear "commit these generated files, then rerun"
  message and never suggests committing unrelated dirty files;
- hash-included generated metadata warns about required re-binding or is proven
  not to create a commit / re-review loop;
- untracked-overwrite merge hazards are caught before ambiguous DONE recovery;
- every M3 surface that emits machine-readable output preserves its stdout /
  JSON contract; process-fact contract tests cover any signed-flow surfaces that
  gain new guidance.

Recommended verification commands should include the existing build plus focused
smokes for the new behavior:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/validate-progress-heartbeat-smoke.js
node packages/main/dist/tasks/review-assurance-floor-smoke.js
npm --prefix packages/main run test:process-fact-contract
```

When the implementation touches `cli-engine` activity logging, runtime root
detection, or Codex global fallback paths, also run:

```bash
node packages/main/dist/tasks/thin-init-assets-smoke.js
```

Add new focused smoke scripts or test cases for `done_prepare` closure heartbeat
and early review-assurance surfacing as part of the implementation story.

## Additional Flow UX Opportunities

These are adjacent process UX improvements worth considering after the core
story, or as small scoped follow-ups.

| Priority | UX gap | Why it matters | Candidate fix |
|---|---|---|---|
| P1 | DONE merge can fail late on untracked overwrite hazards | The story may already look DONE-ish before merge recovery is obvious | Add a pre-DONE merge-collision preflight with exact paths and preservation guidance |
| P1 | Generated lifecycle metadata is easy to miss | Agents rerun `done_prepare` without knowing why DONE still blocks | Always print generated files, why they matter, and the exact commit/rerun expectation |
| P1 | Review escalation status can look alarming in degraded local mode | Valid local fallback may be confused with failed two-host assurance | Render "degraded local fallback" separately from invalid or stale host verdicts |
| P2 | Repeated prepare / validate runs lack a delta summary | Users ask why the same step happened twice | Store and print a compact "what changed since previous attempt" summary |
| P2 | Milestone ledger and checklist changes can drift in visibility | Developers may not realize checklist additions need milestone-ledger synchronization | Keep forced read-only milestone display on write paths and add a ledger-sync advisory when checklist changes outpace the ledger |
| P2 | Phase-stop messages vary by command | Agents see a stop but not the next legal writer | Standardize "blocked because / cannot auto-write / next legal command" banners across INIT, PLAN, REVIEW, TEST, and DONE |
| P3 | Machine and human output contracts are not uniformly documented | Progress fixes risk breaking JSON consumers | Document stdout/stderr contracts for lifecycle progress in the CLI reference |

## Story Slicing Recommendation

Preferred split:

1. Story A: `done_prepare` post-validation progress and heartbeat.
2. Story B: early review-assurance surfacing and blocker recipes.
3. Story C: DONE merge-preflight and re-run delta UX.

If these ship in one story, keep the scope UX-only: progress, status, guidance,
and tests. Do not change gate criteria or create new auto-attestation paths.


## B-c163 convergence contract (implemented)

- A later closeout idle/max timeout preserves any already-observed validation disposition, evidence basis, and refusal reasons; only the later terminal result/layer changes to `timed_out` and `idle|max`. The command-level `done_prepare` budget is the exact sum of routine validation plus each enabled closeout phase once (five non-validation phases, plus DONE-required only when enabled). CLI named deadline errors propagate through routine verifier execution so a command deadline that lands between watchdog polling ticks retains `timeoutLayer=max`.

- Closeout segments check the parent watchdog before and after each segment and await cooperative abort cleanup. Synchronous JavaScript is inherently non-preemptible, so it stops at the first deadline/checkpoint boundary. Pure in-process closeout segments spawn no descendants, making process-tree ESRCH evidence not applicable there; descendant cleanup is required and tested only for validation/phase paths that actually spawn children.

DONE-required execution and reuse use one bounded contract:

- The DONE-required phase budget is the safe sum of effective sequential command timeouts plus bounded grace. A phase-specific override wins the global phase override, which wins the derived budget. The direct `done_required_validate` CLI max covers that derived phase; the `done_prepare` CLI max covers routine validation plus every enabled closeout phase. An explicit `LATTICE_MAX_TIMEOUT_MS` remains authoritative. Each effective command timeout is capped at Node's maximum legal timer delay before arming the real timer, so a huge configured value cannot overflow into an immediate timeout. Structured `failed` / `timed_out` / `blocked` results remain parseable on stdout and exit nonzero; routine `done_prepare` idle/max aborts use the same terminal timeout shape and release child processes, timers, and locks for an immediate rerun.
- `done_prepare` defaults `reuseFreshDoneRequired=true`, independently of post-closeout `reuseFreshValidation`. Reuse requires the canonical DONE-required evaluator to pass and evidence HEAD to equal current HEAD, or be its ancestor with every path touched by every intervening commit classified as trusted story metadata (including modify-then-revert history). HEAD must remain unchanged across evaluation. Any code, config, non-metadata, non-ancestor, unreadable evidence/lineage, or concurrent HEAD movement refuses reuse.
- `validate:false` means `disposition=skipped_explicitly` and `result=not_run`; it neither executes nor reuses nor manufactures evidence, while reporting `existingEvidenceBasis=fresh|stale|missing`. Executed and reused paths report `disposition`, `result`, `refusalReasons`, and any `timeoutLayer` in human and JSON output.
- Progress and heartbeat output uses stderr/the logging side channel, never JSON stdout. Reporter failures are diagnostic-only. Heartbeats refresh idle liveness only; command, phase, idle, and absolute max deadlines, child-tree termination, lock release, and timer cleanup remain independent.
