# Story Lifecycle

> The current primary flow uses the second-generation Proofbound flow:
>
> `INIT -> INIT_CHECK -> PLAN/express skip -> DEV -> REVIEW -> TEST -> DONE`
>
> The legacy `TEST_CASE` / `TEST_CASE_REVIEW` / `testIntent` are retained only as legacy compatibility data. The currently active model is the `verificationIntent` on a checklist item, the `verificationEvidence` recorded during the DEV/REVIEW/TEST phases, the reviewer agent/lane in the REVIEW phase (including the `lattice-review-test-coverage` coverage-review lane), and `lattice validate` in the TEST phase. Projects may opt into a separate DONE-required validation policy with `done_required_validate`; missing policy is advisory and must not be described as full-suite assurance.

## Phase Transitions

```text
INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE
                              ^        |        |
                              |        v        v
                              +------ DEV <-----+
```

The express channel may skip some planning material when the gate allows it, but it must not skip deterministic states such as worktree, review, validate, or DONE evidence.

## Phase Numbering and Health Checks

Proofbound assigns the executable primary-flow phases a stable number, used by `lattice status` to display progress:

| Number | Phase | Description |
|---:|---|---|
| 1/8 | IDEA | Requirements have not yet formed a checklist; compatibility entry for legacy data and drafts |
| 2/8 | INIT | Story created, worktree not yet bootstrapped |
| 3/8 | INIT_CHECK | Worktree bootstrap check/creation phase |
| 4/8 | PLAN | Understanding snapshot, checklist, verificationIntent, required decision |
| 5/8 | DEV | Implement code and record verificationEvidence |
| 6/8 | REVIEW | Reviewer audits the implementation; the coverage reviewer lane audits verificationIntent coverage |
| 7/8 | TEST | `lattice validate` writes validation evidence / bug |
| 8/8 | DONE | Complete, merge, clean up worktree |

`DISCARDED` is a terminal state and does not participate in the primary-flow progress percentage. `TEST_CASE` and `TEST_CASE_REVIEW` are legacy phases, retained only so that old stories remain readable and migratable; new stories should not actively enter them.

The numbering is used only for observable state, not to judge whether something is anomalous. Proofbound's flow permits legal rollbacks, so you cannot detect errors with "the current number must equal the previous number + 1." Health checks must use the legal transition graph:

- Forward: `INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE`
- Compatibility forward: `IDEA -> INIT`, `IDEA -> PLAN`
- Express channel: `INIT_CHECK -> DEV` may enter implementation when policy allows
- Legal rollback: `DEV -> PLAN`, `REVIEW -> DEV`, `TEST -> DEV`
- Legacy compatibility: `TEST_CASE -> DEV`, `TEST_CASE_REVIEW -> DEV`, `TEST_CASE_REVIEW -> TEST_CASE`, `TEST_CASE_REVIEW -> TEST`
- Terminal: any unfinished story may enter `DISCARDED` via `story_discard`

`lattice status` / `lattice session_brief` should display the current number, allowed next, and allowed rollback, and explicitly state the execution authority when the main metadata and the linked worktree phase disagree:

- When there is a linked worktree, the story metadata inside the worktree is the execution authority.
- The main metadata is only an index and recovery entry point, and may lag.
- The output must indicate which worktree to `cd` into next.
- The DONE display in the Dashboard / `session_brief` must distinguish lifecycle from outcome: `Lifecycle DONE: N/M` only states that the phase has reached DONE; `DONE-success/default`, `DONE-blocked`, and `DONE-audit-only` state the nature of the terminal state. A legacy summary with no `outcomeKind` falls into the success/default compatibility bucket.

## Phase Responsibilities and Gates

| Phase | Meaning | Entry gate | Artifacts |
|---|---|---|---|
| INIT | Story created | `story_create` succeeds | story metadata, background |
| INIT_CHECK | Worktree bootstrap | init reviewers / draft gate pass (or controlled `init_check_repair` fallback), scope anti-expansion freeze passes, git available | `.worktrees/B-xxx`, `story/B-xxx` |
| PLAN | Breakdown and acceptance intent | cwd is in the worktree; high-risk stories require understanding + decision/preMortem | understanding, checklist, verificationIntent, decision |
| DEV | Implement and record evidence | PLAN/review gate allows it | code, checklist status, verificationEvidence |
| REVIEW | Independent review | DEV checklist complete, changes committed | reviewer findings, coverage reviewer result / review pass |
| TEST | Automatic validation | REVIEW blockers resolved, preflight gate passes | `lattice validate` evidence, bug/test runs |
| DONE | Wrap-up | validate PASS, bug fixed, evidence fresh, summary/delivery gate passes, any opted-in DONE-required validation passes, branch contains main | merge main, clean up worktree, summary |
| DISCARDED | Discarded | `story_discard` | discard event, cleanup result |

### INIT_CHECK Controlled Fallback Without Subagent (B-95d8)

On the normal path, `INIT → INIT_CHECK` requires an independent INIT reviewer (`lattice-review-story-init` + `product-reviewer`) to write the signed `init-check.json` via `init_check_set`. Environments that cannot spawn a subagent (CI sandbox / no subagent runner) previously had no legal exit, so the story was permanently stuck at `[missing_init_check]`.

`lattice init_check_repair` provides an **explicit, auditable fallback that does not weaken the signature** (INIT phase, `ownershipClass: storyScopedMutating`, an owner-gated manual override, not a reviewer-lane write):

- **Disabled by default**: missing `acknowledge:true` or a `fallbackReason` shorter than 30 characters is rejected, producing no file and not changing the phase.
- **Reuses `signInitCheck`**: the signature domain is unchanged; later modifying any of background/title/description/checklist still triggers `[init_check_tampered]`.
- **Does not relax the gate**: the required reviewer coverage is recorded as `<required>@fallback` (`initCheckAgentMatches` recognizes the prefix), which both satisfies validation and is mechanically distinguishable from an independent reviewer; manually attested high/critical issues still self-block via `blockingInitCheckIssues`.
- **Audit**: writes `init-check.json.fallback` (mode/reason/evidenceRefs/actor/session/attestedAt/headHash/materialHash) + an `init_check_fallback` process event; `story_get` exposes `initCheckAttestation` (`fallback`/`independent`) + the `initCheckFallback` block so the dashboard/report can distinguish them.
- Does not introduce mechanical `agentId` validation (EXP-001 has falsified caller mechanical distinguishability).

For the canonical command template and design constraints, see the "INIT→INIT_CHECK hard gate" section of CLAUDE.md.

### INIT Scope Anti-Expansion Gate (B-85ba)

`INIT -> INIT_CHECK` consumes structured process facts before worktree creation and phase mutation: `scope-boundary.json`, `execution-boundary.json`, `scope-freeze-check.json`, `scope-extension-proposals.json`, `scope-discard-digest.json`. These artifacts respectively freeze the user-confirmed allowed/excluded scope, the execution boundary, the current story/checklist freshness, the reviewer expansion-proposal state, and the discarded-direction digest. `scope-boundary.json` / `execution-boundary.json` may be written in sync via the optional boundary input of `story_create`; when not provided at creation time, they must be explicitly filled in during the INIT phase with `scope_boundary_set` / `execution_boundary_set`.

Typical hard reasons: `[missing_scope_boundary]`, `[missing_execution_boundary]`, `[missing_scope_freeze_check]`, `[scope_freeze_check_stale]`, `[scope_freeze_check_failed]`, `[scope_extension_proposal_pending]`, `[excluded_keyword]`, `[repeat_discarded_direction]`.

By default the `correctness_fix` future denylist contains only `repair UX`, `Authority`, `Layer4`, and `customerKeyRef`. Other exclusions must come from a user-confirmed scope boundary or the checklist `excludes`. When an INIT reviewer finds that an expansion is needed, it can only write a `scope_extension_proposal`; it cannot directly modify the checklist / scope boundary / execution boundary. Accepting or rejecting must go through `scope_extension_decide`, and after acceptance `scope_freeze_check` must be re-run.

## Automatic Rollback

- **REVIEW fail**: return to DEV when a finding or the coverage reviewer lane finds a problem.
- **TEST fail**: after `lattice validate` fails, write a bug/evidence, and the fix path returns to DEV.
- **DONE gate fail**: stay in TEST and, per the failed items in the DONE checklist, fill in evidence, summary, delivery check, main sync, or git clean.
- **DONE-required validation fail**: stay in TEST and run `done_required_validate --storyId=<id>` when the project has `doneRequiredCommands`; without such policy the row is advisory and no full-suite claim is made.

After a rollback, the main agent should first read the failure evidence, then decide whether to change code, add evidence, add documentation, or adjust the checklist. Do not substitute explanation for a fix.

## Scope Evidence Hygiene (B-4622)

This section fixes the phase assignment of the scope-related evidence commands, closing the evidence-hygiene gap recorded in B-4622: when a story rolls back from TEST to DEV and changes scope via `checklist_add`, the PLAN-phase scope command cannot be rewritten — but **this is not a gate hole**, because later phases no longer re-consume `scope-check.json`. The decision is not to relax `scope_check_save` to later phases, but to route later-phase scope changes through an independent, auditable acknowledgement path.

| Command | allowedPhases | Role | Meaning |
|---|---|---|---|
| `scope_check_save` | PLAN (only) | reviewer-lane write (`reviewerWrite`) | Writes signed scope review evidence (`scope-check.json`), consumed by the PLAN→DEV `story_review` gate. |
| `scope_contract_acknowledge` | DEV / REVIEW | story-scoped mutating | Records an explicit acknowledgement of a necessary later-phase out-of-scope change, visible to the reviewer and the scope gate. |

Rules:

- **scope_check_save remains PLAN-only signed scope review evidence**. It is not, and should not be, relaxed to DEV/REVIEW; `scope-check.json` is verified only once at PLAN→DEV by `story_review`.
- **scope_contract_acknowledge is the DEV/REVIEW later-phase scope acknowledgement path**. When changing scope via `checklist_add` after a TEST→DEV rollback, use it to record an explicit acknowledgement, rather than rewriting PLAN's signed scope review evidence.
- **later-phase acknowledgement is not a replacement for a PLAN scope reviewer pass**. `scope_contract_acknowledge` only records that "this out-of-scope change is explicitly acknowledged"; it neither regenerates the signed `scope-check.json` nor re-triggers the scope-plan reviewer's PLAN gate. If the later-phase scope drift is large enough to require redoing the scope review, the correct action is to return to PLAN, re-run the scope-plan reviewer + `scope_check_save`, rather than using acknowledgement to stand in for a reviewer pass.

## Merged-State Combination Review (Process-Framework Parallel Stories)

> This section is the **canonical detailed version** of this rule. `CLAUDE.md` keeps only a short summary and a see-also pointing here; the two are not independent equivalent copies.

This is an **advisory process discipline**, not a CLI gate, and is not automatically enforced by the state machine. It covers a blind spot that single-story REVIEW structurally cannot see.

### Why It Is Needed

Single-story REVIEW always looks only at one story's own diff, and cannot see the kind of cross-story interaction defect where "two locally correct stories stack up to form a global hole."

**Origin incident**: the 2026-05-15 hotfix B-8db9 fixed a CRITICAL gate bypass — B-cf60 (declared-artifact declaration) and B-4b22 (the dirty-gate-policy that sets `declared_artifact_changes` to non-blocking) each passed single-story REVIEW independently when DONE, but after merging into main the two stacked up to form a DONE dirty gate bypass: an agent could declare a dirty source file to bypass the gate. This hole was discovered only by an after-the-fact read-only review of the merged state.

### Trigger Scope

Triggered when **multiple "process-framework" stories are developed in parallel and merged into main**. A process-framework story is one that touches any of the following assets:

- dirty / working-tree state classifier (how each category is judged)
- gate policy (whether a class of change is blocking or non-blocking)
- command entry-point gates (the rejection rules at a handler entry)
- auto-commit (auto-commit logic, and its interaction with dirty state)
- DONE merge semantics (what gets carried over when merging back into main)

### Rule

After merging, you must perform a read-only combination review of main's **merged state** (i.e. the actual state after all parallel stories have been merged into main). This is a read-only review; it does not change code. Its purpose is to discover stacking defects, and when a problem is found, fix it through the normal story flow.

### Enumerated Checklist

A combination review must go through the following checklist item by item — this is to prevent the combination review from degenerating into a rubber stamp:

1. **Classification priority order**: is the judgment order of the classifier's categories still self-consistent? Has a category added by one story displaced the judgment order that another story depends on?
2. **gate policy table**: list out the blocking / non-blocking values of all affected categories, and confirm that after stacking there is no "category that should be blocking but was changed to non-blocking by some parallel story."
3. **command entry-point gates**: are the rejection rules at each handler entry still complete after stacking? Is there an entry relaxed by one story that is exactly the path another story assumes will be blocked?
4. **auto-commit / dirty state interaction**: after stacking the auto-commit behavior with the dirty-state classification, could a change that should have been blocked by the dirty gate end up being auto-committed, or be classified as harmless?
5. **DONE merge semantics**: at DONE merge, will declared artifacts / uncommitted files be carried into main? If one story's "declaration means release" semantics stacks with another story's merge behavior, could a dirty file silently enter main?

### Out of Scope

Ordinary business stories **do not trigger** a combination review. This rule applies only to process-framework stories (the assets enumerated under Trigger Scope above). Forcing a merge review on ordinary business stories only creates review fatigue and instead causes the rule to be ignored entirely.

## Worktree Isolation

Each story is developed in its own worktree, with branch name `story/{storyId}`. Multiple concurrent sessions do not interfere with each other.

- `story_advance -> INIT_CHECK`: automatically creates the worktree + branches off.
- `story_advance -> DONE`: automatically merges back into the main branch + cleans up the worktree + deletes the branch. On failure it returns an error message for the agent to handle.
- `story_advance -> DONE` must hold the unified main write lock before triggering any main-affecting preflight, canonical path `.lattice/locks/main-write.lock/` (since B-f60c; the old `.lattice/runtime/done-main-merge.lock` is retired, no alias). The lock covers main divergence check / autoSyncMain / DONE pre-merge gate / phase writes / main merge / worktree cleanup / branch delete; when a live lock cannot be acquired, it must fail before writing `phase=DONE` and prompt to retry later. A stale lock can be reclaimed by the lock primitive. For the canonical lock path definition, see the Storage section of `session-ownership-and-write-leases.md`.
- After the story branch is merged into the local main, `story_advance -> DONE` records the main SHA before and after the merge, and checks whether that merge diff touches watched Proofbound CLI/runtime or bounded capability contract/proof inputs: `packages/main/src/**`, `docs/CLI.md`, `packages/main/tests/**`, `packages/main/package.json`, `packages/main/package-lock.json`, `packages/main/tsconfig.json`, the root `package.json`, and `package-lock.json`. On a hit it runs `npm --prefix packages/main run build` to refresh the local `packages/main/dist`; on a miss it prints `✓ version bump skipped (no watched CLI/runtime or capability contract inputs changed)` for the CLI patch-version bump path and a visible packages/main build skip line for the build path. If the post-merge build fails, the DONE command must clearly warn that `packages/main/dist` may be stale, give the recovery command `npm --prefix packages/main run build`, and attach the captured output.
- The CLI patch version is a Proofbound CLI/runtime and capability-contract marker, not a repository-wide code-artifact ledger. The bounded non-runtime watched set is intentionally limited to the CLI contract (`docs/CLI.md`) and package-local proof/regression files (`packages/main/tests/**`). Other changes outside the watched set, including arbitrary requirements documents such as `docs/requirements/**`, offline experiment harnesses under paths such as `experiments/**`, and paper artifacts, may still be real project work, but they do not by themselves require a Proofbound CLI patch-version bump unless a later policy explicitly adds a separate product/experiment version ledger.
- Non-runtime DONE artifacts use a separate provenance ledger at `.lattice/artifact-releases.jsonl`. V1 records include releasable `experiments/**` and `docs/**` paths that are not watched CLI/runtime or bounded capability contract/proof inputs, a deterministic `sha256:` artifact-set digest over each normalized path and its git blob at the DONE merge commit, and a boundary flag showing whether the runtime/capability semver path also changed. `.lattice/story/**` lifecycle metadata, root/package manifests and locks, `packages/main/src/**`, and all watched build/version inputs are excluded from artifact release contents. This ledger is provenance only; it is not runtime activation, package semver, Authority release readiness, or a broader CLI bump rule. `artifact_release_list` and `artifact_release_status` are read-only host-neutral inspection commands.
- **story owner lease (since B-c55d)**: the authoring / lifecycle mutation of a single story is serialized by a per-story owner lease, orthogonal to the main write lock — the main write lock governs cross-session main / B-META shared writes, while the owner lease governs "one mutating owner per story." The lease is persisted at `.lattice/story/actives/<storyId>/owner-lease.json` (a runtime artifact, leaving no dirty write before DONE). The first story-scoped mutating command acquires the lease, owner commands refresh the heartbeat, and a successful DONE/DISCARDED+cleanup releases it. A non-owner `storyScopedMutating` / `dangerousMutating` command is rejected fail-closed at a single CLI choke-point gate (`enforceStoryOwnerLeaseGate`, decided by `CommandPolicy.ownershipClass`), with an error message containing the owned storyId / owner sessionId / cwd / heartbeat age / stale flag / next action; read-only commands are never blocked. A heartbeat not refreshed for over 30 minutes is judged stale and may be transferred with `--takeover`; an active lease requires `--forceTakeover` (manual approval), and both transfers record a `story-owner-lease-takeover` audit event. `session_brief` renders a `## Story ownership` section (owner session/cwd/heartbeat age/stale|active/whether it is this session/recommended action); the B-META container renders a separate `## Shared audit state (B-META)` section and does not recommend story_advance. For the full current rules, see `session-ownership-and-write-leases.md`; for the canonical `LATTICE_SESSION_ID` host-adapter migration plan, see `owner-session-contract-execution-plan.md`.
- If a post-merge path failure causes the story branch to have already written `phase=DONE` while `story/B-xxx` has not yet merged into main, this is called partial-DONE. `lattice doctor` must list such stories in its `Partial-DONE scan` and provide `lattice done_recover --storyId=B-xxx`. `done_recover` itself must also first acquire the same `.lattice/locks/main-write.lock/`, and then run only when main is clean, the story worktree is clean, the story branch exists, and `merge-tree main story/B-xxx` applies cleanly; it completes the merge, worktree remove, worktree prune, and branch delete. After the recovery merge it likewise records the main SHA before and after the merge, and reuses the DONE post-merge `packages/main` build rule: it runs `npm --prefix packages/main run build` only when watched Proofbound CLI/runtime or capability contract inputs are touched, otherwise it prints the same visible skip semantics; a build failure must warn that `packages/main/dist` may be stale, the recovery command, and the captured output. It is not a general conflict resolver, and will not delete a story worktree with local changes; conflicts or a dirty worktree still require manual handling.
- **post-DONE activity heartbeat must land in main (B-da5b)**: `story_advance -> DONE` deletes the current story worktree partway through command execution, but the activity log (written to `.lattice/activity.jsonl`) is persisted only after the command. At that point the `root` captured when the command started already points at the deleted ghost worktree. The CLI must capture a durable main-root fallback at the start of the command, while the worktree still exists (resolving the main repository root from `root/.git`), and prefer it for writing the log when `root` no longer has a `lattice.config.json`; it must not fall back to `resolveRoot()`'s cwd-walk — when `LATTICE_PROJECT_ROOT` points at the worktree it would resolve back to the ghost path again, causing the heartbeat of the finally-successful `story_advance DONE` to be silently dropped, or rebuilding the log directory inside the deleted worktree. The final success record must appear in the main repository's `.lattice/activity.jsonl`, and must not rebuild the deleted worktree directory. Regression coverage is in `assertPostDoneHeartbeatLandsInMainAfterWorktreeRemoval` of `tasks/worktree-authority-smoke.ts`.

The current branch is detected via `git rev-parse --abbrev-ref HEAD`; when it starts with `story/`, the storyId is extracted to identify the active story.

The main directory's `session_brief` must look at both the main directory's story metadata and the real story metadata inside the linked worktree. If the two phases disagree, the output should use:

```text
B-xxxx REVIEW (authority:worktree, mirror:INIT_CHECK)
→ cd /path/to/.worktrees/B-xxxx
```

This means that when continuing to work, the worktree phase is authoritative; the main phase is only a lagging index and should not trigger a duplicate advance.

### Parked Backlog in Convergence

The hard `all Stories complete` criterion of `lattice convergence_check` counts only non-terminal stories that are executing or have entered the worktree flow. A story with `phase=INIT`, no recorded `worktree.path`, and no linked `story/<id>` branch in `git worktree list` is treated as parked backlog: it is still shown on a separate `Parked backlog` advisory line, reminding the user to later complete, discard, or schedule it, but it does not by itself turn convergence red.

Once a story has a recorded `worktree.path`, a linked git worktree branch, or has advanced its phase to a non-terminal execution phase such as `INIT_CHECK` / `PLAN` / `DEV` / `REVIEW` / `TEST`, it is an active blocker and must continue to completion, be rolled back and fixed, or be explicitly discarded. The `META` audit container and `DONE` / `DISCARDED` terminal stories do not enter this hard completion check.

## Design Decisions

- **Story is Feature**: a Story is the minimal trackable unit.
- **State-machine managed**: use xstate, rather than scattered hand-written ifs.
- **Gates are not skippable**: REVIEW/TEST/DONE must all be judged by a deterministic gate.
- **verificationIntent comes first**: PLAN records happy/edge/adversarial acceptance intent.
- **verificationEvidence follows the implementation**: DEV/REVIEW/TEST attach real evidence, no longer splitting the test phase into the old `TEST_CASE` flow.
- **Grill only clarifies intent**: `grill_start` / `grill_record` / `grill_close` write the `grill.json` planning artifact of the PLAN phase, and `grill_get` can read it in all phases. Grill clarifies intent; evidence proves behavior. A grill transcript cannot replace `verificationEvidence`, a review pass, a delivery check, or `lattice validate` validation evidence.
- **evidence kind allows natural aliases**: the persisted kind is still a canonical value such as `logic_test` / `manual_transcript`; the CLI accepts `logic`→`logic_test` and `cli`→`manual_transcript`, to avoid plan.md and the command surface fighting over wording.
- **DONE evidence must be fresh**: `lattice validate --story` writes the git HEAD/material hash at the time of the test run. The DONE gate compares against the current story branch, and a change to a verification-semantics-relevant file makes the old evidence stale.
- **DONE-required evidence is separate**: `done_required_validate --storyId=<id>` writes `done-required-evidence.json` only for opted-in projects. The DONE oracle has a separate `done-required-validation` row; it blocks on missing/failing/stale/policy-drift/command-drift, and on `missing-build-proof` only when a command explicitly declares a self-host build-proof requirement. External projects without policy get an advisory row and no full-suite claim; external projects with plain root `npm test` policy do not inherit Orchestrate's `packages/main` proof rule.
- **Review escalation is threshold-triggered, not documentation-triggered**: documentation and decision-doc audit changes follow ordinary REVIEW by default. Direct edits under `docs/requirements/decisions/*.md` that are only annotation-compliance, pure typo, or wording-only clarifications are low-risk one-round cases: one two-host audit round is enough, and they do not by themselves require 3 rounds x 2 hosts at DONE. High-risk lifecycle, gate, Authority, or process-fact changes still use the 3-round path. DONE requires review escalation only when the first lifecycle REVIEW round records at least two countable reviewer problems: `lattice-review-*` findings with severity `critical`, `high`, or `medium`, and `evidenceState=verified` or legacy missing. Suspected, disproven, low-severity, non-reviewer, and later-round findings do not trigger it. When triggered, DONE requires 3 distinct `runId` rounds, each with 2 independent PASS `host_verdict` events over the current material hash. Missing binding fields, stale material, duplicate host/session/key identity, and FAIL/BLOCKED decisions fail closed. An explicit degraded fallback may pass only as `assuranceLevel=degraded-single-host`: allowed eligibility/reason, evidence or approval, fresh material binding, and 3 rounds with at least 1 PASS host. Local host verdicts and degraded fallback evidence are not Authority Server receipts and cannot imply `authorityDone`, `fullAuthorityDone`, or `productionDone`.
- **stale evidence cannot be overridden by "tests passed"**: if `lattice validate` finds verification coverage missing/stale, the JSON must be `allPass:false`, and the prompt must point to adding evidence rather than saying "validation passed." You can use `verification_evidence_refresh_stale --storyId=B-xxx --dryRun` to view the items needing refresh; after re-running the corresponding verification command, drop `dryRun` to refresh the metadata.
- **Gate oracle and renderer are separate**: gate output such as the DONE pre-check must first form a stable row contract (`id/status/detail/hint/source/blocking`), and `status` / `session_brief` / `next` only render these rows. The presentation layer must not duplicate a copy of the gate rules using phase or label wording.
- **Next-step hints must be phase-aware**: `lattice validate` passing means only that the verification command passed, not that you can skip the current phase. After DEV passes, the hint is commit + REVIEW; after REVIEW passes, the hint is TEST; after TEST passes, it must still render the DONE pre-check's failed rows and remediation hints.
- **Process facts must have two-layer protection**: the prompt is only responsible for guiding the agent to call the correct command; the CLI / handler / gate must be hardcoded as a backstop, responsible for schema, runtime normalization, signature, hash, evidence freshness check, and rejection policy. This principle covers only process facts: phase / state transition, pass / no-issue confirmation, review run / finding category / role / severity, verification evidence, init / scope / delivery check, REVIEW / TEST / DONE gate artifact. Ordinary explanatory prose should not be treated as process evidence.
- **Process facts need a typed registry**: `packages/main/src/core/process-fact-registry.ts` mechanically assembles command facts from `COMMAND_POLICIES` and `PROCESS_FACT_LEVELS`, and explicitly overrides reviewer lanes, artifacts, and required semantic facts (such as validation-status, verification-evidence, review-pass, finding-state). When a maintainer adds a gate, reviewer lane, or artifact, they must first update the registry and the contract verifier in sync.
- **Lifecycle facts need a typed registry**: `packages/main/src/core/lifecycle-registry.ts` is the read-only registry of phase/order, legacy alias, transition event, rollback edge, and gate/effect/oracle row id. `phase-flow.ts`, `handlers/context.ts`, and the focused smoke must project from or validate against this table; when a maintainer changes a phase/event/command policy, the test failure should directly name `Lifecycle registry mismatch`, not let multiple tables silently drift.
- **Runtime environment facts are registered separately**: runtime/environment facts such as the CLI entrypoint, the global core realpath, the project-local bin, the Node/package version, the validate source, and the external-reference-policy do not enter the process-fact registry. They are registered in `packages/main/src/core/runtime-fact-registry.ts`, displayed by `doctor`'s `Runtime scan:`, and verified by `scripts/verify-runtime-fact-contract.mjs` to ensure the registry / checker / doctor output are consistent. An external project's expectations about Orchestrate-local realpath/symlink only warn/advisory; `external-reference-policy` is a bounded policy scan and does not perform a connectivity pass.
- **Runtime file facts are registered separately**: runtime artifacts such as `.lattice/activity.jsonl`, the legacy `docs/story/activity.jsonl`, `.lattice/runtime/`, `.lattice/traces/`, `.lattice-serve.json`, and debug/browser logs are registered in `packages/main/src/core/runtime-artifact-registry.ts`. Freshness, baseline risk, `story_sync_main`, `lattice init`, and `doctor` must consume this table, to avoid mistaking a runtime file such as the activity log for a material change; `.lattice/story/` is still process evidence and is not a runtime artifact.
- **A Pass conclusion is not a finding**: when a reviewer has no finding, it must write `review_pass_set`. To stay compatible with old prompts or misuse, a pass-only `finding_add` (such as no findings, check passed, PASS/PASSED) is converted into a review pass in the handler; ambiguous failure semantics such as "but/failed/issue found" are still kept as a finding.
- **REVIEW evidence is first bound to a reviewer run**: `review_run_start` writes a signed `review-runs.json`, recording `reviewRunId / lane / reviewRound / headHash / materialHash / promptHash`. The `finding_add` / `review_pass_set` of the current REVIEW round must carry the `reviewRunId`, and the gate requires a matching lane, matching reviewRound, valid signature, and still-fresh material/scope. Binding is kind-aware (see `review-run-binding-race.md`): PASS evidence is accepted on any current-round run that is material- and scope-fresh — being the latest run on the lane (id-recency) is NOT required — while an open FINDING still requires the latest run on the lane so it cannot be hidden by a newer pass.
- **Finding category does not proliferate**: the current canonical categories are `happy|edge|adversarial|missing`. Known legacy categories (`cleanup|doc-promise-undelivered|doc-code-drift|spec-boundary`) are only normalized to `missing` as compatibility input, and must not continue to propagate as active reviewer prompt examples or new process semantics.
- **User-value acceptance comes first**: before DONE, you must be able to clearly state "what change the user sees, how to use it, and where the evidence is." An engineering pipeline passing does not mean the task is truly complete.
- **User-value acceptance is structured**: `summary_set` must record `expectedOutcome`, `actualTranscript`, `outcomeDiff`, and `acceptanceVerdict`, and may record `outcomeKind=success|blocked|audit_only`. The DONE gate consumes these fields, and when they are missing it cannot enter DONE; a legacy summary missing `outcomeKind` is displayed as success/default.
- **Unified advance command**: `story_advance` uniformly handles all phase advances.

## Phase-Aware Tool Filtering

The CLI layer filters the available commands by the current story phase. When there is no active story (main branch), all are available.

### Available in All Phases

| Tool | Behavior |
|---|---|
| `story_get` / `story_list` | Read-only view |
| `story_discard` | Can discard in any phase |
| `task_scan` / `task_detail` | Understand the project, read-only |
| `checklist_get` | Read-only view |
| `grill_get` | Read-only view of the grill planning context written in the PLAN phase; produces no gate evidence |
| `truth_*` / `gap_*` / `arch_trace` | Analysis reference, read-only |
| `session_brief` / `status` / `next` | Restore context and suggest next steps, does not advance the phase |

### PLAN

| Tool | Behavior |
|---|---|
| `story_update` | Edit the story |
| `story_review` | Adversarial review |
| `grill_start` / `grill_record` / `grill_close` | PLAN-only mutating grill commands; record non-gating grill planning context; an open session / unresolved question only produces an advisory hint in `story_review` |
| `story_advance -> DEV` | Enter implementation after passing the gate |
| `checklist_add` | Append an item |
| `checklist_update` | Fill in verificationIntent / metadata, should not mark done |
| `testintent_handoff` | Legacy name, actually used to generate verificationIntent handoff context |

### DEV

| Tool | Behavior |
|---|---|
| `checklist_add` | Append an item when necessary and fill in verificationIntent; the PLAN phase must provide a replan/scope audit reason |
| `checklist_update` | Can change status + verificationIntent + verificationEvidence |
| `fixture_batch_add` / `fixture_update` | Legacy/compat maintenance entry, only for old fixtures or migration; the new flow uses `checklist_update` to fill in `verificationEvidence` |
| `lattice validate` | Can be pre-checked manually; the formal evidence is written at the TEST gate |
| `story_advance -> REVIEW` | Advance after the checklist is complete and changes are committed |

### REVIEW

| Tool | Behavior |
|---|---|
| `finding_*` | Reviewer records findings |
| `reviewer_list` | View which reviewers are needed |
| `story_advance -> TEST` | Advance after blockers are resolved and preflight passes |
| `story_advance -> DEV` | Return to implementation when there is a problem |

`lattice-review-test-coverage` is the name of a reviewer agent/lane in the REVIEW phase, not a `lattice` CLI command or phase tool. It checks `verificationIntent` / `verificationEvidence` coverage; it first does `review_run_start` to get the current round's `reviewRunId`, and when there are no blockers it writes a review pass via `review_pass_set` + `reviewRunId`, while the internal coverage validation consumes this structured evidence.

### TEST

| Tool | Behavior |
|---|---|
| `lattice validate` | Standard validation, writes validation evidence |
| `done_required_validate` | Opt-in DONE-required validation, writes `done-required-evidence.json` for the separate DONE-required row |
| `verification_evidence_refresh_stale` | Refresh the HEAD/material hash of stale evidence based on the coverage report |
| `bug_report` / `bug_update` / `bug_list` | Manage bugs produced by validation failures |
| `summary_set` | Write the pre-DONE user value, actual transcript, diff, outcomeKind, and usage notes |
| `delivery_check_set` | Record the delivery reviewer signature |
| `decision_doc_quorum_check` | Read-only decision-doc quorum diagnostic; direct decision-doc edits are classification-only unless `review_escalation_status` shows the DONE escalation trigger fired |
| `review_escalation_status` | Read-only view of the actual DONE review escalation requirement and assurance level |
| `review_escalation_fallback_set` | Explicit degraded 3x1 fallback evidence, bound to current material hash; not Authority receipt completion |
| `story_advance -> DONE` | Merge and clean up after the DONE checklist fully passes |

### Key Behavioral Differences

- `lattice validate`: the TEST gate consumes its result as routine validation evidence.
- `done_required_validate`: the DONE gate consumes its result only when `doneRequiredCommands` / `validationProfiles.done` is configured; it is not a release approval, pre-push hook, or Authority receipt.
- `verification_evidence_refresh_stale`: it only refreshes an intentRef that is already stale and whose original evidence still exists; it does not prove for you that the test actually ran, so the command in the dry-run output should be re-run first.
- `fixture_*`: legacy/compat maintenance entry; DEV can use it if it needs to migrate old fixtures, but a new story should not treat it as the standard validation flow. REVIEW/TEST mainly read `verificationEvidence`, and should not bypass review to change behavior.
- `checklist_update`: PLAN fills in intent, DEV fills in status/evidence, use cautiously in other phases.
- `summary_set`: not a formal summary; the DONE gate and the final user delivery both consume it.
- `grill_start` / `grill_record` / `grill_close`: PLAN-only mutating planning context. `story_review` can display an open-session / unresolved-question advisory, but `blockerCount` does not increase due to grill; `grill.json` does not enter validation evidence, nor the checklist `verificationEvidence`.
- `grill_get`: read-only view of the grill planning context in all phases; reading a nonexistent artifact returns empty, while reading a corrupt or unreadable existing `grill.json` must fail-fast and expose the problem, and must not be treated as missing and then overwritten.
- `process-fact-registry` + `verify-process-fact-contract`: the static contract is responsible for validating that MAIN_TOOLS, DEFAULT_PHASE_TOOLS, reviewer lanes, signed/gate artifacts, L4 gate evidence, and required semantic facts are consistent; the failure wording must directly name `missing from PROCESS_FACT_REGISTRY` or `required process fact missing`, to avoid the maintainer seeing only prompt drift.
- Flow fact policy must be hardcoded in `packages/main/src/core/flow-fact-policy.ts` and registered into `process-fact-registry` / `process-fact-levels`. Currently explicitly registered: `flow-policy:review-pass`, `flow-policy:finding`, `flow-policy:pass-only-normalization`, `flow-policy:review-round-iso-string`, `flow-policy:express-verification-policy`.
- `reviewRound: string (ISO 8601 review round id)`. The signature domain of review pass / finding / delivery check consumes this string, and cannot fall back to a number round.
- `story_create --phase=REVIEW` must also initialize `currentReviewRound`. Directly creating a REVIEW story is a compatibility entry for the review-only / backfill scenario, but after persistence it must satisfy the structured metadata contract of REVIEW commands, and must not leave a half-initialized state with phase=REVIEW and no review round.
- `story_review.planReviewRound: number (PLAN review round count)`. This is the numeric count of PLAN-phase story review rounds, derived from `review.json.reviews.length`; `story_review.reviewRound` is only the legacy numeric PLAN review alias, and must not be interpreted as the signed-artifact `reviewRound`.
- pass-only finding_add normalization: a pass-only `finding_add` with low severity and an agent of `lattice-review-*` is mechanically converted to `review_pass_set`; an ambiguous pass+failure, a non-reviewer, or a non-low severity are all real findings.
- review run freshness: the same reviewer lane may do `review_run_start` multiple times in the current REVIEW round; only that lane's latest signed run is still current. After a code/document material change, the old run becomes stale, and you must re-run `review_run_start` before submitting a finding/pass.
- Express exemption is a machine policy, not a verbal explanation: when the channel is express and there is zero `verificationIntent`, it outputs `Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped)`; fast / normal with zero intent does not display `express-exempt`.

## Three-Way Checks and Balances

- **Main agent**: writes requirements, breaks down the checklist, writes code, fills in evidence, fixes bugs.
- **test-intent / verification-intent agent**: writes acceptance criteria, forcing out edge/adversarial.
- **reviewer**: audits the implementation and coverage; `lattice-review-test-coverage` is one reviewer lane among them. It first does `review_run_start` to create the reviewer run for the current REVIEW round; when there are no blockers it writes `review_pass_set` + `reviewRunId`, and when there are blockers it independently records `finding_add` + `reviewRunId` / delivery check.
- **User**: the final arbiter of product value.

The main agent is not the judge. When a reviewer fails, the correct reaction is to understand the feedback and fix it, not to explain it into a pass.
