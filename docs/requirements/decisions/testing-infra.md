# Testing Infrastructure

## Test Strategy

The current test contract is centered on the story checklist:

1. The PLAN phase records the happy/edge/adversarial `verificationIntent` for each checklist item.
2. The DEV phase implements the code and records the `verificationEvidence` (command, summary, intentRef, hash, etc.) via `checklist_update`.
3. The REVIEW phase has the reviewer agent/lane (including the `proof-or-stop-review-test-coverage` coverage-review lane) check the implementation and evidence coverage.
4. The TEST phase runs `proof-or-stop validate`, writing validation evidence, bugs, and stale/missing-evidence results.
5. The DONE phase may additionally require `done_required_validate --storyId=<id>` when a project opts into `doneRequiredCommands` / `validationProfiles.done`; this writes separate DONE-required evidence and does not change ordinary `proof-or-stop validate`.

### Project-Native Validation

Prefer using the project's own validation commands (such as `npm test`, `pytest`, `go test`, `cargo test`) to produce evidence. Proof-or-Stop does not require every project to have a TypeScript `validate.ts`, nor does it require passing through a fixture to count as validation.

### Browser Real-Machine Tests

Browser black-box validation can still serve as `verificationEvidence`:

1. Start the project dev server + bridge proxy
2. Execute the user-visible flow in a real browser
3. Associate the transcript, screenshot/trace, command, and result with the corresponding `verificationIntent` via `checklist_update`

User-value acceptance can only be approximated, not disguised as a fully automatic proof: transcript/delivery evidence is required; prompt-only user-value claims are not enough. The user's final approval is non-mechanical user approval, and the Proof-or-Stop gate can only consume a transcript, verificationEvidence, delivery-check / product-reviewer evidence, or a waiver.

### Grill Planning Artifact Boundary

`grill_start` / `grill_record` / `grill_close` only write `grill.json` as a PLAN-phase clarification record; `grill_get` only reads this planning artifact. Grill clarifies intent; evidence proves behavior. Grill's questions, answers, open session, and remainingUnknowns can help `story_review` give an advisory, but cannot be written into or replace `verificationEvidence`, `test-evidence.json`, validation evidence, a review pass, or delivery evidence.

### Legacy Fixture Compatibility

`test_auto` / `test_story` / `test_fixture` / `fixture_batch_add` / `fixture_update` / `test_add` / `task_coverage` are the old fixture/test family, retained for old stories, migration, diagnosis, and maintenance. They are not the default flow for the current story; the new flow should prefer `verificationIntent`, `verificationEvidence`, and `proof-or-stop validate`.

## Test Execution

`proof-or-stop validate` is the project-level validation entry point, and cannot assume every project has a TypeScript `validate.ts`. Execution priority:

1. When the project root has `validate.ts` / `validate.js` / `validate.mts`, execute via the original D/M/F verifier path.
2. Otherwise, read the **project config**: canonical `proof-or-stop.config.json` is the only active config file. Retired config spellings are ignored by the active loader, so their `validate.command` or `validate.commands` are not executed.
3. Otherwise, auto-discover the standard command by project type: `npm test`, `python -m pytest`, `go test ./...`, `cargo test`, `mvn test`, `gradle test`.
   - **Swift / Package.swift is not in the auto-fallback list**: the Mac Native App is retired and is no longer a current product entry point; to run `swift test`, you must explicitly declare a `validate.commands` entry in `proof-or-stop.config.json`.
4. When no validation entry is still found, return `warn/skip`, and do not misjudge a non-TS project such as Python/Go/C++ as a failure; a project that needs a hard gate must explicitly configure a validation command.

Repository-wide discovery does not by itself make absolute success a Story
acceptance requirement. During PLAN, focused behavior introduced by the Story is
normally an absolute-pass `must`. A repository-wide command must first be run or
checked against the pre-change baseline. If that baseline is already red because
of an existing or environmental failure, record an explicit
`no_new_regressions` repository-health comparison as `should`; reviewers compare
the referenced baseline and current outputs and file a Finding for a new failure.
Absolute repository-wide success may remain `must` when the task, user, or
official verifier explicitly requires it. `story_review` rejects other
repository-wide `must` intents, including unannotated standard full-suite
commands, before they freeze at DEV.

The success prompt of `proof-or-stop validate` must use the current story phase and the gate oracle, rather than hardcoding DONE:
after the DEV phase passes, the prompt is to commit and enter REVIEW; after the REVIEW phase passes, the prompt is to enter TEST;
after the TEST phase passes, the prompt is to view the DONE pre-check, and per the hint of the failed rows, fill in gate items such as summary, delivery check, dirty tree, and missing/stale `verificationEvidence`.

The REVIEW→TEST validation entry must be fail-closed. A `review-preflight` import/runtime exception, a `proof-or-stop validate` handler execution exception, or a JSON parse exception are all gate infrastructure failures, and must block entry into TEST and output `Cannot enter TEST` plus a re-runnable command; these exceptions must not be downgraded to a warning. A `warn/skip` that is explicitly returned by the validate policy when no validation entry is found is still handled per the validate JSON semantics, distinct from the runner itself crashing.

## DONE-Required Validation

`proof-or-stop validate` is routine TEST evidence. `done_required_validate --storyId=<id>` is the separate DONE-required evidence writer for projects that explicitly configure `doneRequiredCommands` or `validationProfiles.done` in `proof-or-stop.config.json`.

Both official entrypoints and derived host-verdict binding use a shared workspace validation capacity lease keyed by the resolved Git workspace's git-common-dir rather than the metadata wrapper. Expected Git identity resolution fails closed, including no-story validation with an explicit but unresolved configured `gitRoot`; genuinely non-Git projects use their project root. This covers story and no-story `validate`, including `--channel`, `--concept`, and `--lint`. A contending command waits asynchronously, emits the rate-bounded phrase `waiting for workspace validation capacity` plus holder/heartbeat details on stderr/progress, and starts automatically after release. Story-scoped validation always acquires workspace capacity before its existing per-story evidence lock. Reentrancy requires the async context's acquisition token to equal the currently active token for that exact lock path; path equality alone never transfers ownership across generations. Capacity takeover is strict: age-only expiry and missing/malformed ownership stay blocked; only mechanically proven local-dead ownership or holder/heartbeat identity mismatch is reclaimable. Each acquisition prepares complete identity before atomically publishing a never-reused UUID ticket; stale recovery atomically renames that exact ticket to a unique quarantine and deletes only the quarantine, never the shared root or a successor ticket. Owner release and queued-waiter abort/deadline cleanup use bounded ownership-safe retries. Persistent isolation failure attempts a best-effort released marker on only that unique ticket; marker success permits mechanical successor recovery after filesystem repair, while marker failure remains fail-closed until repair. A successful callback reports release failure. An original callback, abort, or deadline error stays primary and does not separately surface the secondary cleanup failure. Direct `validate` enters the structured watchdog only to propagate abort/deadline into this wait and clean its waiter ticket; it preserves the existing `validate` classification and exit contract. `structuredDoneResult` and the DONE-result classifier remain exclusive to `done_prepare` / `done_required_validate`. Derived host-verdict binding intentionally exposes no caller-authored abort/deadline fields; its CLI host timeout remains the outer cancellation boundary unless a future public interface change adds structured cancellation. Independent repositories do not contend.

The checked-in regression/evidence contract exercises an exact-12 child-process stale/ABA cohort, distinct from the exact-12 in-process Promise cohort, and asserts `maxConcurrency=1`, zero overlap, zero child errors, and zero queue-artifact leaks. This does not promise a user-visible runtime concurrency level. The managed terminal pins remain exact: focused `validate-execution-lock workspace capacity contract passed: 15 assertion groups`; full `validate-execution-lock smoke passed: 26 assertion groups`.

The coordination boundary is intentionally the Proof-or-Stop handlers. A bare `npm test` or direct full-suite process is outside the lease and must not run concurrently with `proof-or-stop validate` or `proof-or-stop done_required_validate`. This mechanism serializes execution only; it does not alter validation commands, timeout budgets, evidence bindings, freshness, or the routine/DONE-required split.

Missing DONE-required config is advisory and non-blocking for external projects; the DONE checklist must not claim full-suite assurance in that case. Malformed opted-in config fails closed. When a policy exists, DONE blocks on missing, failing, stale, policy-drifted, or command-set-drifted `done-required-evidence.json`. Its receipts must cover the effective policy commands exactly in order and match command, args, cwd, and shell identity; artifact-level PASS cannot substitute for per-receipt PASS results.

For this self-host repository, the required policy explicitly marks the root `npm test` command with `requiresBuildProof: "packages-main-build"`, so it must be preceded by `npm --prefix packages/main run build` or an equivalent same-material packages/main build proof. This build-proof rule is a self-host policy requirement; external projects that only configure root `npm test` as a DONE-required command do not inherit it.

The validation-related process facts must be registered in `packages/main/src/core/process-fact-registry.ts`:
`validate` represents `validation-status`, `verification_evidence_*` represents
`verification-evidence` / `execution-evidence`, `test-evidence.json` is the routine validation-result artifact consumed by TEST/DONE, and `done-required-evidence.json` is the opt-in DONE-required artifact consumed by the separate DONE-required row. `scripts/verify-process-fact-contract.mjs`
is responsible for validating that these registry facts are consistent with `COMMAND_POLICIES`, `PROCESS_FACT_LEVELS`,
`DEFAULT_PHASE_TOOLS`, reviewer lanes, and signed artifacts; the project config can only add
a local validation command or narrow the available commands, and cannot relax the legacy/rootOnly/gateEvidence semantics.

runtime/environment drift facts must be registered separately in `packages/main/src/core/runtime-fact-registry.ts`,
and protected against regression with `scripts/verify-runtime-fact-contract.mjs`; do not mix environment facts such as the CLI entrypoint,
global realpath, and project-local bin into the process-fact registry.

The legacy `test_auto` is a compatibility runner, not a unified entry point. The current handler is only responsible for executing legacy fixtures and returning an execution summary; when maintaining old fixtures, its behavior is:

1. Scan all `.json` fixture files under `fixturesDir`
2. Validate that the `fn` + `file` fields point to real source code
3. Execute each case via the language-agnostic executor registry: prefer `executor` / `command`, fall back to legacy JS `execute`
4. Validate the result (`expect` exact/pattern match, or `throws` error match)
5. Collect a V8 profiler trace, detect call-chain changes, and output warnings
6. Aggregate results such as total / passed / failed / warnings / trace snapshot

It does not write `bug.json`, nor does it write `test-evidence.json` / `verificationEvidence`. Bug management and validation-evidence writing belong to `proof-or-stop validate` / the gate or explicit bug/evidence commands; a real legacy maintenance run may still execute a workspace-destructive cleanup (`git restore . && git clean -fd`).

The focused smoke for outcome semantics covers dashboard/session wording, the `summary_set.outcomeKind` schema, verification-evidence verdict rendering, and worktree authority wording:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:outcome-semantics-smoke
```

It must fail when something regresses into a single ambiguous DONE percentage, or restores the old alarming main metadata wording.

Configuration example:

```json
{
  "validate": {
    "commands": [
      { "label": "python tests", "command": "python", "args": ["-m", "pytest"] },
      "ruff check ."
    ]
  }
}
```

The JSON receipt of `validate.command` / `validate.commands` is audit evidence: each command should record
`command`, `args`, `code`, `durationMs`, `output`, and `shell=true` when shell semantics are needed. When a string command contains shell semantics such as `cd`/`&&`/a pipe/a redirect, Proof-or-Stop will execute it
as a deliberate shell receipt; a structured command object does not go through the shell by default, unless `"shell": true` is written explicitly. When a required command fails, `proof-or-stop validate` hard-fails; when an `optional:true`
command fails, it only returns a warn.

The Validation scan of `proof-or-stop doctor` is a project-level advisory and does not replace `proof-or-stop validate`:
it states whether `validate.ts/js/mts` exists, whether canonical `proof-or-stop.config.json` has a validation command configured,
the labels of the auto-discovered fallback commands, whether it is in a no-validator warning, and whether the shell-style config
will leave a `shell=true` receipt. It must not write a project-specific test count or an assumption such as PVSC here;
when a hard gate is needed, an explicit validate command should be configured. Swift / Package.swift is not in the auto-fallback (the Mac Native App is retired), and the doctor output will explicitly note that an explicit `validate.commands` is needed before `swift test` will run.

The `Runtime scan:` of `proof-or-stop doctor` is another kind of advisory / warn output: it checks Proof-or-Stop runtime environment facts,
does not write validation evidence, and does not enter the `process-fact-registry`. The runtime facts are declared by
`packages/main/src/core/runtime-fact-registry.ts`, and `scripts/verify-runtime-fact-contract.mjs` validates the registry ID, output key, checker wiring,
the doctor JSON `runtime` section, and text source coverage. `external-reference-policy` only does a bounded
truth/config scan: `proof-or-stop.config.json`, `AGENTS.md`, `CLAUDE.md`, `README.md`,
`docs/requirements/**/*.md`; it excludes `.proof-or-stop/story`, legacy `docs/story`, `tests/fixtures`,
`node_modules`, `dist/build`, and ordinary source-code comments. When it scans an external URL / host:port with no health-command
semantics, it can only output a reference-only / health-check-required warning, and cannot claim a connectivity pass. The bounded scan recognizes `proof-or-stop.config.json` as the canonical project-config marker.

Runtime artifacts are not the environment facts of the `Runtime scan`, but are runtime file facts registered separately by
`packages/main/src/core/runtime-artifact-registry.ts`.
This table provides unified gitignore, materialHash exclusion, volatile dirty-risk, and tracked-repair semantics for paths such as
`.proof-or-stop/activity.jsonl`, the legacy `docs/story/activity.jsonl`, `.proof-or-stop/runtime/`,
`.proof-or-stop/traces/`, `.proof-or-stop-serve.json`, and debug/browser logs.
`currentMaterialHash` / verification freshness must exclude the runtime artifacts marked by the registry,
but must not exclude source/config/requirements/package files; `.proof-or-stop/story/` is process evidence,
and is not handled as a runtime artifact.

### Phase Behavior Differences

- **INIT phase**: the Story-init reviewer checks only term definitions, standalone readability, metadata consistency, existing-system claims, and mechanical checklist sanity; the product reviewer checks whether a concrete outcome and executable verification plan exist. A critical/high `init_check_set` issue blocks only when its kind is allowed for that reviewer and its `requirementRef` names an exact authoritative INIT input. The handler preserves out-of-authority or unbound critical/high reports as medium advisory evidence. Implementation choices, details explicitly marked implementation-defined, exhaustive internal transitions, trace formatting, and test-coverage refinements belong in PLAN or REVIEW unless the authoritative INIT input already fixes them.
- **DEV phase**: validate with project-native commands, and write `verificationEvidence` via `checklist_update`; the legacy `test_auto` is available only when maintaining old fixtures, and must clearly warn that it may modify actual files
- **REVIEW phase**: the reviewer lane (including `proof-or-stop-review-test-coverage`) first does `review_run_start` to create the current round's signed reviewer run, then consumes `verificationIntent` / `verificationEvidence`; when there are no blockers it writes `review_pass_set` + `reviewRunId`. An external linked Story worktree's untracked controller config and native Codex hooks pass dirty preflight only while the existing signed projection receipts, registered Story branch, untracked-file policy, and byte identity all verify; any drift or missing proof returns the path to ordinary blocking classification.
- **TEST phase**: `proof-or-stop validate` writes validation evidence; the legacy `test_auto`, if explicitly invoked in a maintenance scenario, will still execute `git restore . && git clean -fd`

## Flow Fact Policy

Process facts must be protected by two layers of code policy and gate, not only by a prompt or document. `packages/main/src/core/flow-fact-policy.ts` is the centralized table of review/pass/finding/verification exemptions, and is registered in sync into `process-fact-registry`, `process-fact-levels`, and `scripts/verify-process-fact-contract.mjs`.

- `reviewRound: string (ISO 8601 review round id)`, provided by `story.currentReviewRound`; signed facts consume the string, not a number round.
- `reviewRunId: string`, generated by `review_run_start` and written into signed `review-runs.json`; current-round `finding_add` / `review_pass_set` must carry it. The gate validates lane, round and material/scope freshness for both kinds; only an open FINDING requires the lane's latest run, while a fresh non-latest PASS remains admissible.
- `story_review.planReviewRound: number (PLAN review round count)` is the numeric count of PLAN review output; `story_review.reviewRound` is only the legacy numeric PLAN review alias, and cannot be used as the signed-artifact schema of a finding / review pass / delivery check.
- pass-only finding_add normalization: a pass-only finding with low severity and an agent of `proof-or-stop-review-*` is converted to `review_pass_set`; one containing contradictory semantics such as failure / blocker / missing / failed, a non-reviewer, or a non-low severity must all be kept as a finding.
- review run freshness: `review_run_start` records `headHash/materialHash`. If a code or document material change makes the run stale, the old `reviewRunId` is no longer usable, and the reviewer must re-run `review_run_start` before submitting a finding/pass.
- Express exemption: when the channel is express and there is zero `verificationIntent`, it outputs `Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped)`; normal / fast with zero intent only displays the ordinary coverage-missing wording, not `express-exempt`.
- Worker evidence boundary: prompt-only worker claims and Git commit author text are not mechanical authority. A normal-channel implementation must have canonical `proof-or-stop dispatch` or successful `subagent_result` process evidence for every non-exempt checklist item before the lifecycle can enter formal review. Commit authors remain audit attribution only. Proof-or-Stop cannot mechanically prove true subagent context isolation, and proves the observable assignment/result evidence it actually records.

## Test Flow

- PLAN: use `verificationIntent` to describe the happy/edge/adversarial acceptance of each checklist item.
- DEV: after implementing, run project-native commands or the browser flow, and write the `verificationEvidence` with `checklist_update`.
- REVIEW: the reviewer lane `proof-or-stop-review-test-coverage` checks whether every `verificationIntent` has traceable evidence; it first does `review_run_start` to get the `reviewRunId`, and when there are no blockers it records a pass via `review_pass_set` + `reviewRunId`. The internal coverage validation consumes `verificationIntent` / `verificationEvidence`, and is not a separate CLI command.
- TEST: `proof-or-stop validate` runs the project-level validation and records validation evidence; when evidence is missing or stale, it returns `allPass:false`.
- DONE: only accepts a result where PASS, bug fixed, evidence fresh, summary/delivery gate are satisfied, and any opted-in DONE-required policy has fresh PASS evidence.

## CLI Tools

| Tool | Purpose |
|---|---|
| `proof-or-stop validate` | The current standard project-level validation entry point, writes validation evidence / bug / stale-evidence results |
| `done_required_validate` | Opt-in DONE-required validation entry point, writes `done-required-evidence.json`; advisory when no policy exists |
| `checklist_update` | Records the checklist status, `verificationIntent`, and `verificationEvidence` in the DEV phase |
| `grill_start` / `grill_record` / `grill_close` / `grill_get` | PLAN planning context; not gateEvidence, produces no validation evidence |
| `verification_evidence_refresh_stale` | Refreshes stale evidence without copying hashes: a current V5 policy-owned deterministic capsule with a complete unchanged input closure and valid signed lineage may publish a signed `ReuseReceipt` with zero subprocesses; otherwise the pinned verifier is really run at most once per affected execution key, and uncertainty or failure fails closed by demoting dependent evidence |
| `test_auto` | legacy/compat full fixture runner, used only when maintaining old fixtures |
| `test_story` | legacy/compat story fixture runner |
| `test_fixture` | legacy/compat single-fixture/chain runner |
| `fixture_batch_add` / `fixture_update` | legacy/compat fixture maintenance entry |
| `test_add` | legacy/compat test-evidence writing; the new flow uses `verificationEvidence` |
| `task_coverage` | legacy/maintenance coverage helper; the current coverage reviewer lane / validation reads `verificationEvidence` |
| `browser_test` | Run browser tests separately; the result should be transcribed into `verificationEvidence` |
| `test_list` | View test evidence |
| `bug_report` | Report a bug (automatically marks the associated item in_progress + rolls back to DEV) |
| `bug_update` | Update bug status |
| `bug_list` | View the bug list |
| `diagnose` | Auto-diagnosis (pure advice in DEV, associates with bug_report in TEST) |

## Cross-Language Execution Protocol

A legacy fixture is a language-agnostic test protocol, not a JS script container. `execute` represents only the legacy `js.execute` executor; projects such as Python, Go, C++, Java, and Rust should prefer producing `verificationEvidence` via `command` / a language executor / a native test command, then have `proof-or-stop validate` consume it in the TEST phase. Swift / Objective-C (Mac Native App) is retired and is no longer a current default product validation entry point; it will only be executed when explicitly opted in via `validate.commands` or the legacy `swift.test` / `objc.xcodebuild` executor.

The first batch of built-in executors:

| executor | Purpose |
|---|---|
| `js.execute` | Compatible with old JS fixtures, executes the `execute` function body |
| `command` | General black-box command, suitable for `go test`, `pytest`, `ctest`, `mvn test`, `swift test`, `xcodebuild test`, etc. |
| `python.function` | Python function-level boilerplate executor, calls a single function via the JSON process boundary |
| `go.test` | Go standard entry, default `go test ./...` |
| `java.junit` | Java/JUnit standard entry, default `mvn test`, optional `buildTool:"gradle"` |
| `cpp.binary` | C/C++ test binary entry |
| `swift.test` | Swift Package standard entry, default `swift test`; used only when the legacy executor is explicitly declared (the Mac Native App is retired, **not** in the auto-fallback list of `proof-or-stop validate`) |
| `objc.xcodebuild` | Objective-C / Apple-platform standard entry, default `xcodebuild test`; same as `swift.test`, only via explicit legacy executor opt-in |
| `rust.cargo` | Rust standard entry, default `cargo test` |

A reviewer must not judge "the JS runner cannot import Python/Go/C++/Java/Swift/OC" as a test pass; this only indicates that the corresponding executor evidence or `verificationEvidence` is missing.
