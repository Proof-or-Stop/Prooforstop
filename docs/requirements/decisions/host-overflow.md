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

The product finish line is concrete and user-visible:

1. The user defines or selects an explicit unattended policy.
2. Lattice checks policy authorization, including allowed hosts, allowed and
   denied paths, max parallelism, timeouts, retry limits, command templates,
   budget/network posture, and environment allow/deny filtering.
3. Lattice probes host capability and reports unavailable or supervised-only
   when login, noninteractive mode, cwd isolation, timeout, transcript, network,
   or env-safety guarantees are missing.
4. `dispatch_auto` starts only policy-authorized, unattended-safe workers in
   isolated worktrees and records worker lease/conflict state.
5. `dispatch_watch` and `dispatch_cancel` keep the run visible and stoppable.
6. `dispatch_review` and manual `dispatch_merge_plan` surface transcripts,
   changed files, command output, and local diagnostic receipts as evidence
   candidates only.

The unattended extension must still keep `productionDone=false`,
`receiptVerified=false`, and `authorityChanged=false`. It must not auto-merge,
auto-DONE, expand scope, treat a host transcript as gate evidence, or treat a
local diagnostic receipt as a verified authority receipt.

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
  `overflow_auto`, it may start external host workers, but only after explicit
  user policy authorization and host unattended-safety checks pass.

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
policy / unavailable host / `unattendedSafe=false` host, all authority flags
fixed at `false`, and `overflow_auto` `nextAction` pointing to `dispatch_auto`.
