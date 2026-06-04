# Lattice Host Overflow

## Decision

Lattice Host Overflow is a **manual-first, host-neutral overflow architecture**
for bounded work that leaves Lattice in charge of story, scope, receipt, and
merge authority.

- Lattice is the authority surface.
- Claude Code, Codex, and similar tools are execution hosts.
- Manual handoff comes before supervised dispatch.
- Supervised dispatch is a conservative projection, not an auto-runner.
- Unattended dispatch is a separate, policy-authorized extension of supervised
  dispatch, not an authority upgrade.

Claude Code overflow workers are therefore **execution-only** in this model:
they can receive a bounded handoff pack, work inside an isolated overflow
worktree, and return a local diagnostic receipt, but they do **not** become
production authority.

## B-a5c2 unattended extension

B-106b landed the manual-first Host Overflow base. B-a5c2 extends that base with
`dispatch_auto` as the selected `policy-authorized-unattended-scheduler`:
`chosen: policy-authorized-unattended-scheduler`, `preMortem: 6`.
The v1.0.1 real-subprocess contract is Claude Code first: a policy must set
`allowRealHostSubprocess=true` before Lattice may attempt a Claude Code real
subprocess. Gemini and Codex remain scaffolded/refused real-subprocess targets
in this version.

The product finish line is concrete and user-visible:

1. The user defines or selects an explicit unattended policy; real Claude Code
   subprocess launch additionally requires `allowRealHostSubprocess=true`.
2. Lattice checks policy authorization, including allowed hosts, allowed and
   denied paths, max parallelism, timeouts, retry limits, command templates,
   budget/network posture, and environment allow/deny filtering.
3. Lattice probes host capability and reports unavailable or supervised-only
   when login, noninteractive mode, cwd isolation, timeout, transcript, network,
   or env-safety guarantees are missing. The standalone
   `host_runtime_probe.unattendedSafe` fact stays conservatively `false`.
4. `dispatch_auto` performs the actual unattended launch decision by combining
   policy authorization, Claude availability, `claude --print` support,
   launcher allowlisting, timeout/env filtering, scope checks, and worker
   lease/conflict state before starting isolated worktrees. For v1.0.1, the
   only real-host subprocess target is Claude Code under explicit policy
   opt-in; fake remains the deterministic local harness.
5. `dispatch_watch` and `dispatch_cancel` keep the run visible and stoppable.
6. `dispatch_review` and manual `dispatch_merge_plan` surface transcripts,
   changed files, command output, and local diagnostic receipts as evidence
   candidates only.

The unattended extension must still keep `productionDone=false`,
`receiptVerified=false`, and `authorityChanged=false`. It must not auto-merge,
auto-DONE, expand scope, treat a host transcript as gate evidence, or treat a
local diagnostic receipt as a verified authority receipt.

## B-47cd autopilot execution modes

B-47cd defines the host-to-host autopilot layer above dispatch. Autopilot may
sequence policy checks, bounded runs, status/watch, review, cancel, and resume
surfaces, but it does not replace Lattice story/scope/review authority.

The three user-facing modes are:

| Mode | Purpose | Authority boundary |
|---|---|---|
| Conservative | Execute only a bounded, policy-authorized local/fake path or produce a host-native delegation pack for a supervised host. | Local diagnostic receipts stay diagnostic-only; `receiptVerified=false`, `productionDone=false`, and no automatic merge. |
| Authority-Verified | Require a verified server authority receipt before stronger integration can be considered. A fake server-shaped receipt is allowed for deterministic smoke coverage. | Missing, malformed, or unverifiable authority receipts stop at `missing_authority_receipt`. Local CLI output still keeps `receiptVerified=false` and `productionDone=false`. |
| Full Autopilot | Continue through bounded plan/run/watch/review loops within explicit policy, path, runtime, budget, and `maxIterations` limits. | Stops at bounds, conflict, stale base, denied path, missing receipt, or review risk. Merge and DONE remain manual. |

The intended command surface is flat-first with nested aliases for human use:

```bash
lattice dispatch_policy_create --policy=fake \
  --allowedHosts=fake --allowedPaths=packages/main/src/generated/ \
  --maxParallel=2 --maxRuntimeMinutes=10 --maxBudgetUSD=5 \
  --network=none --commandAllowlist='node -e "process.exit(0)"' \
  --requireReceipt=true --requireReview=true \
  --allowAutoMerge=false --allowProductionDone=false

lattice autopilot policy create --policy=fake \
  --mode=conservative --allowAutoDispatch=true --allowAutoValidate=true \
  --allowMainMerge=false --requireServerReceipt=false \
  --maxIterations=1 --maxRuntimeMinutes=10 \
  --stopOnConflict=true --stopOnScopeViolation=true --json

lattice autopilot_policy_check --policy=fake --json
lattice autopilot_run --mode=conservative --storyId=B-demo --policy=fake --json
lattice autopilot_status --runId=AP-B-demo-abc123 --json
lattice autopilot_watch --runId=AP-B-demo-abc123 --json
lattice autopilot_review --runId=AP-B-demo-abc123 --json
lattice autopilot_cancel --runId=AP-B-demo-abc123 --json
lattice autopilot_resume --runId=AP-B-demo-abc123 --json
```

Host-native delegation is a shape contract, not an authority transfer. The
delegation artifact must identify the selected host, command preview, prompt or
pack path, allowed/denied paths, expected receipts, transcript location, and the
`execution-only` authority boundary. Claude Code, Gemini, Codex, and fake hosts
can execute the bounded objective, but their local diagnostic receipts do not
imply `receiptVerified=true` or `productionDone=true`.

Autopilot review/merge output is guidance only. It may report changed files,
runner status, receipt status, conflict risks, and manual commands, but it must
not run a main merge, mark production done, clear conflicts silently, or convert
local diagnostic receipts into verified authority receipts. Full Autopilot stops
instead of crossing any merge/conflict or authority boundary.

## Boundaries

Lattice keeps these responsibilities:

- Story identity, lifecycle, and scope authority
- Pack creation and pack-hash authority
- Receipt review, freshness review, and merge review
- Final evidence authority and any future production authority path

Overflow hosts keep these responsibilities:

- Execute the bounded objective from the handoff pack
- Stay inside `allowedPaths` / `deniedPaths`
- Run or report required local commands
- Return local diagnostic output, transcript metadata, and a local diagnostic
  receipt

The higher-level dispatch runtime remains supervised and visible:

- The operator can see which host/runtime is targeted.
- Planning, preparation, run, collect, status, review, and merge guidance stay
  explicit artifacts, not hidden background work.
- Missing host CLI/runtime degrades to `unavailable` or a diagnostic
  `nextAction`; it does not silently switch hosts or pretend the work ran.

Every overflow surface must keep:

- `productionDone=false`
- `receiptVerified=false`
- `authorityChanged=false`

## Landed dispatch surfaces

The supervised dispatch layer is now landed as explicit Lattice surfaces:

- `dispatch_plan` selects the runtime and returns a bounded pack/worktree
  preview without creating a dispatch record, worktree, receipt, or external
  host session.
- `dispatch_prepare` persists rebuildable dispatch metadata under
  `.koala/dispatches/` plus prompt placeholders. It still does not create the
  projected worktree or auto-run a host.
- `dispatch_run` is manual-first but executable. For `fake`, it runs the local
  deterministic harness inside the isolated overflow worktree and returns a
  local diagnostic receipt. For real hosts, it attempts to create the projected
  worktree scaffold first; success yields `needs_receipt`, while scaffold
  creation failure is reported truthfully as `failed` with a diagnostic
  `nextAction`.
- `overflow_auto` is a visible policy wrapper over dispatch selection. Default
  behavior is suggest-only. It only starts a dispatch when **both**
  `approve=true` and `start=true` are provided; `approve=true` alone or
  `start=true` alone must remain suggest-only and emit a warning about the
  missing counterpart flag.
- `dispatch_auto` is reserved for the B-a5c2 unattended extension. Unlike
  `overflow_auto`, it may start unattended workers, but only after explicit user
  policy authorization and host unattended-safety checks pass. Real-host
  subprocess launch in v1.0.1 is Claude Code only and requires
  `allowRealHostSubprocess=true`; Gemini/Codex are not supported real-subprocess
  targets.

## Workflow

1. Main agent creates a bounded handoff pack.
2. Main agent projects an isolated overflow worktree.
3. Overflow host works manually in that worktree.
4. Overflow host returns a local diagnostic receipt.
5. Main agent reviews scope, freshness, and diff locally.
6. Main agent merges manually if the result is acceptable.

If a host is unavailable, Lattice reports that as a diagnostic readiness issue
with `nextAction`; it is not a global workflow blocker.

## Non-goals

Lattice Host Overflow does **not**:

- Share hidden context implicitly across hosts
- Auto-trust overflow output
- Auto-run hidden background host work that the operator cannot inspect
- Auto-merge overflow diffs
- Auto-DONE a story or claim `productionDone=true`
- Submit authority evidence from overflow hosts
- Verify authority receipts from overflow hosts
- Turn host availability into production authority
- Require the Mac App
- Introduce a new model-runner runtime inside Lattice
- Claim Gemini or Codex real-subprocess support in v1.0.1

## Claude Code note

Claude Code is a supported overflow execution host, but not a production
authority. The intended sentence for user-facing docs is:

> Lattice Host Overflow is manual-first; Lattice keeps story/scope/receipt
> authority; Claude Code is an execution host, not a production authority.

## Smoke coverage

The full user-facing unattended dispatch flow is validated by the deterministic
smoke test at `packages/main/src/tasks/unattended-dispatch-smoke.ts`:

```bash
npm --prefix packages/main run test:unattended-dispatch-smoke
```

The smoke covers: dispatch policy creation and check, `host_runtime_probe` for
claude-code (works whether or not the CLI is installed), `dispatch_auto` with
fake policy (deterministic parallel workers), `dispatch_watch` lifecycle,
`dispatch_cancel` evidence preservation, `dispatch_review` transcript/runner
evidence, `dispatch_merge_plan` `manualOnly=true`, explicit refusals for missing
policy / unavailable host / missing real-host subprocess opt-in /
`unattendedSafe=false` host, all authority flags fixed at `false`, and
`overflow_auto` `nextAction` pointing to `dispatch_auto`.
