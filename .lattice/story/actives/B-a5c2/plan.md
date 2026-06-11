# B-a5c2 Execution Plan — User-authorized unattended cross-host scheduler

## Coordination Model

This story intentionally uses parallel development, but only after PLAN gates pass. The implementation will use five Claude Code CLI worker lanes with at most three active at once.

Wave 1, max three parallel workers:
- Claude Policy Agent: owns dispatch policy schema, policy CLI/checks, and policy smoke coverage.
- Claude Host Contract Agent: owns Claude/Gemini/Codex unattended capability reporting and the early Claude Code bounded feasibility smoke.
- Claude Runner Agent: owns bounded process runner and raw `dispatch_status` runner detail surface.

Wave 2, after Wave 1 integration:
- Claude Scheduler Agent: owns `dispatch_auto`, `dispatch_watch`, `dispatch_cancel`, worker lifecycle aggregation, and retry/cancel semantics.
- Claude Evidence/Docs Agent: owns collector/review/merge-plan evidence behavior plus README/docs/E2E closeout coverage.

Main agent responsibilities:
- Keep story metadata, checklist evidence, commits, and phase gates coherent.
- Integrate worker branches/patches, resolve conflicts, and prevent scope creep.
- Run concept/quality/test-coverage/docs reviewers in REVIEW and delivery reviewer before DONE.
- Preserve authority invariant: unattended host output is evidence candidate only, never production authority.

Concurrency rules:
- No two workers may own the same new module at the same time.
- Shared files (`cli-engine.ts`, `handlers/lattice-dispatch.ts`, `core/lattice-dispatch.ts`) are touched in narrow patches and integrated by the main agent between waves.
- If a worker discovers a needed shared change outside its ownership, it records it as handoff notes instead of editing unrelated modules.

## CHK-001 — Lock unattended product outcome and authority decision

Goal:
Record the product finish line and hard authority decision before writing implementation code.

User-visible result:
`lattice decision_get --storyId=B-a5c2 --json` shows the selected policy-authorized unattended scheduler, explicit no-authority boundaries, and preMortem risks.

Implementation plan:
- Keep the existing `decision_set` as the canonical decision artifact.
- Add docs language in `docs/requirements/decisions/host-overflow.md` only after DEV starts, making `dispatch_auto` the policy-authorized unattended extension of B-106b Host Overflow.
- Ensure product closeout is concrete: policy check, host probe, dispatch_auto, dispatch_watch, dispatch_cancel, dispatch_review, and manual dispatch_merge_plan.

Likely files:
- `.koala/story/actives/B-a5c2/decision.json`
- `docs/requirements/decisions/host-overflow.md`
- `README.md`

Validation:
- `lattice decision_get --storyId=B-a5c2 --json`
- Docs check for no auto-merge, no auto-DONE, no productionDone, no receiptVerified, no authorityChanged.

Do not:
- Do not let a host transcript become gate evidence by itself.
- Do not introduce production authority or server receipt implementation in this story.

## CHK-002 — Verify Claude Code CLI bounded unattended feasibility early

Goal:
Before abstractions, verify the concrete Claude Code host assumption with a bounded probe/smoke.

User-visible result:
`lattice host_runtime_probe --host=claude-code --json` reports whether Claude Code is unattended-capable, supervised-only, or unavailable, with nextAction.

Agent ownership:
Claude Host Contract Agent.

Implementation plan:
- Add structured capability fields to the existing host runtime probe model, initially focused on Claude Code.
- Probe local CLI version/command path and noninteractive template support without launching unsafe real work.
- If a required guarantee is missing, report `unattendedSafe=false` and a visible fallback nextAction.
- Record a bounded Claude Code smoke transcript when safe; otherwise record explicit supervised-only refusal.

Likely files:
- `packages/main/src/core/lattice-dispatch.ts`
- `packages/main/src/tasks/dispatch-run-smoke.ts`
- Possibly new task: `packages/main/src/tasks/unattended-host-capability-smoke.ts`

Validation:
- `lattice host_runtime_probe --host=claude-code --json`
- `npm --prefix packages/main run test:dispatch-run-smoke`
- New host capability smoke if added.

Do not:
- Do not mark `unattendedSafe=true` from command availability alone.
- Do not require a live paid/long Claude run for normal validation; a safe bounded smoke or explicit refusal is acceptable.

## CHK-003 — Implement dispatch_policy contract and CLI surfaces

Goal:
Add the user authorization layer that decides whether unattended scheduling may start.

User-visible result:
`lattice dispatch_policy check --policy=<name>` reports authorized/denied, exact reasons, and whether the run must fall back to supervised/manual mode.

Agent ownership:
Claude Policy Agent.

Implementation plan:
- Create a policy core module for schema, normalization, and check results.
- Support allowed hosts, allowed/denied paths, maxParallel, maxRuntimeMinutes, retry limits, env allow/deny, network/budget posture, command templates, receipt/review requirements.
- Add CLI surfaces for policy check/inspect using repository-local policy data or explicit inline policy input, depending on existing patterns.
- Return structured denial reasons rather than vague failure text.

Likely files:
- New: `packages/main/src/core/dispatch-policy.ts`
- `packages/main/src/handlers/lattice-dispatch.ts`
- `packages/main/src/cli-engine.ts`
- `packages/main/src/core/command-policy.ts`
- `packages/main/src/core/process-fact-levels.ts`
- Tests under `packages/main/src/tasks/`

Validation:
- Policy accepts bounded policy.
- Policy rejects missing policy, traversal paths, overlap, unlimited parallelism, unsafe env, auto-merge, productionDone.
- `npm run test:command-ownership-contract`
- `npm run test:process-fact-contract`

Do not:
- Do not silently widen paths or hosts.
- Do not make policy optional for unattended starts.

## CHK-004 — Implement real host unattended capability contract

Goal:
Report whether Claude Code, Gemini, and Codex can be used unattended under policy.

User-visible result:
`lattice host_runtime_list --json` shows fake/claude-code/gemini/codex with unattended capability, degradations, and nextAction.

Agent ownership:
Claude Host Contract Agent.

Implementation plan:
- Extend host runtime probe output with `unattended` capability details.
- Represent capability as diagnostic facts, not authority.
- Add fields for version, CLI command path, noninteractive template, cwd support, timeout behavior, transcript support, env safety, and `unattendedSafe` with reasons.
- Gemini/Codex uncertain flags degrade visibly instead of blocking fake or Claude coverage.

Likely files:
- `packages/main/src/core/lattice-dispatch.ts`
- `packages/main/src/core/capabilities.ts`
- `packages/main/src/tasks/capability-list-smoke.ts`
- `packages/main/src/tasks/dispatch-run-smoke.ts`

Validation:
- Runtime list/probe JSON shape tests.
- Missing CLI and partial support tests.
- Authority fields remain false.

Do not:
- Do not start external host processes in a probe.
- Do not treat login/version presence as permission to run unattended.

## CHK-005 — Expose runner details through dispatch_status

Goal:
Add bounded raw process execution metadata and make it visible via `dispatch_status`.

User-visible result:
`lattice dispatch_status --dispatchId=<id>` shows runner command, cwd, exit/timeout, transcript path, environment summary, and inspect/retry guidance.

Agent ownership:
Claude Runner Agent.

Implementation plan:
- Create a bounded runner abstraction that only runs already-authorized host templates.
- Persist runner artifact with command template, cwd, start/end time, exit code, timeout/kill details, transcript path, and sanitized env summary.
- Update dispatch status rendering to surface raw runner details and nextAction.
- Keep `dispatch_watch` out of this milestone; watch aggregation belongs to CHK-006.

Likely files:
- New: `packages/main/src/core/dispatch-runner.ts`
- `packages/main/src/core/lattice-dispatch.ts`
- `packages/main/src/handlers/lattice-dispatch.ts`
- `packages/main/src/tasks/dispatch-run-smoke.ts`

Validation:
- Successful bounded fake/local command persists status and transcript.
- Timeout/nonzero exit persists diagnostic status.
- Refuses non-template command, forbidden env, invalid cwd, unsafe output path.

Do not:
- Do not collect receipts or merge plans here.
- Do not hide transcript or refusal reason from `dispatch_status`.

## CHK-006 — Implement dispatch_auto scheduler, dispatch_watch, and cancel control loop

Goal:
Provide the actual policy-authorized scheduler and user control loop.

User-visible result:
`lattice dispatch_auto` starts/refuses workers; `lattice dispatch_watch` shows lifecycle states; `lattice dispatch_cancel` stops a running worker and watch shows cancelled/stopped nextAction.

Agent ownership:
Claude Scheduler Agent.

Implementation plan:
- Add `dispatch_auto` as policy-authorized unattended scheduling, distinct from suggest-only `overflow_auto`.
- Read policy and host capability before starting any worker.
- Create isolated worker records/worktrees and enforce maxParallel/retry/time limits.
- Add `dispatch_watch` lifecycle aggregation: planned, prepared, running, needs_receipt, diagnostic, accepted_local, failed, cancelled/stopped.
- Add `dispatch_cancel` semantics that stop running worker process metadata and never delete evidence silently.

Likely files:
- `packages/main/src/core/lattice-dispatch.ts`
- `packages/main/src/handlers/lattice-dispatch.ts`
- `packages/main/src/cli-engine.ts`
- `packages/main/src/core/command-policy.ts`
- Tests under `packages/main/src/tasks/`

Validation:
- Authorized start path.
- Refusal for missing/unsafe policy, disallowed host, unsafe scope, maxParallel exceeded, unattendedSafe=false.
- Cancellation produces visible terminal state and preserves evidence.

Do not:
- Do not auto-retry beyond policy.
- Do not delete worktree/transcript/receipt evidence when cancelling.

## CHK-007 — Collect unattended evidence and preserve manual review/merge gates

Goal:
Turn worker artifacts into reviewable evidence while keeping authority manual/gated.

User-visible result:
`dispatch_review` shows unattended transcripts/diffs/receipts; `dispatch_merge_plan` remains manualOnly and says host completion is not production authority.

Agent ownership:
Claude Evidence/Docs Agent, integrated by main agent.

Implementation plan:
- Extend collect/review surfaces to include runner metadata, transcript, changed files, command outputs, and local diagnostic receipt refs.
- Derive changed files mechanically from git, not host prose.
- Keep `authorityChanged=false`, `receiptVerified=false`, and `productionDone=false` in all unattended outputs.
- Ensure missing transcript/receipt/stale diff gives diagnostic nextAction instead of false success.

Likely files:
- `packages/main/src/core/lattice-dispatch.ts`
- `packages/main/src/core/lattice-handoff.ts`
- `packages/main/src/handlers/lattice-dispatch.ts`
- `packages/main/src/tasks/dispatch-run-smoke.ts`

Validation:
- Collector records transcript/diff/commands/runner metadata/local receipt.
- Forged host text cannot set authority fields.
- Review/merge plan remains manualOnly and cannot satisfy DONE by itself.

Do not:
- Do not submit or verify server receipts in this story.
- Do not make dispatch completion equivalent to story completion.

## CHK-008 — Validate full user-facing unattended Claude Code flow

Goal:
Close the product loop with tests and docs that a user can follow.

User-visible result:
Docs and smoke transcript show: `overflow_auto` nextAction to `dispatch_auto`, `dispatch_policy check`, `host_runtime_probe`, `dispatch_auto`, `dispatch_watch`, `dispatch_cancel`, `dispatch_review`, and manual `dispatch_merge_plan`.

Agent ownership:
Claude Evidence/Docs Agent, with main-agent verification.

Implementation plan:
- Add final smoke covering fake parallel unattended flow.
- Add safe bounded Claude Code opt-in flow when policy and capability allow; otherwise record explicit supervised/manual refusal with nextAction.
- Cover missing policy, unavailable host, timeout, cancellation, missing receipt, mixed worker outcomes.
- Cover traversal, symlink output escape, denied path overlap, host overclaim, accidental auto-merge, and productionDone regressions.
- Update README/docs to explain `dispatch_auto` versus `overflow_auto` and why unattended remains user-authorized.

Likely files:
- `README.md`
- `docs/guide.md`
- `docs/requirements/decisions/host-overflow.md`
- `packages/main/src/tasks/dispatch-run-smoke.ts`
- New smoke task if needed: `packages/main/src/tasks/unattended-dispatch-smoke.ts`

Validation:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:dispatch-run-smoke`
- New unattended smoke script if added.
- `npm run test:command-ownership-contract`
- `npm run test:process-fact-contract`
- `lattice validate --story=B-a5c2 --json --forceTakeover`

Do not:
- Do not rely solely on fake path for final product claim if Claude Code is available; either run a safe bounded Claude Code smoke or record an explicit capability/policy refusal.
- Do not leave users with two competing entry points without migration guidance.
