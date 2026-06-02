# Lattice Host Overflow

## Decision

Lattice Host Overflow is a **manual-first, host-neutral overflow architecture**
for bounded work that leaves Lattice in charge of story, scope, receipt, and
merge authority.

- Lattice is the authority surface.
- Claude Code, Codex, and similar tools are execution hosts.
- Manual handoff comes before supervised dispatch.
- Supervised dispatch is a conservative projection, not an auto-runner.

Claude Code overflow workers are therefore **execution-only** in this model:
they can receive a bounded handoff pack, work inside an isolated overflow
worktree, and return a local diagnostic receipt, but they do **not** become
production authority.

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
- Return local diagnostic output and a local receipt

Every overflow surface must keep:

- `productionDone=false`
- `receiptVerified=false`
- `authorityChanged=false`

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
- Auto-merge overflow diffs
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
