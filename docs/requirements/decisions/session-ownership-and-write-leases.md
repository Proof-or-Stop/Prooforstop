# Session Ownership and Write Leases

## Status

Adopted design; rollout fully implemented. This document is the canonical, adopted
design for Proof-or-Stop's multi-session coordination rules and is treated as a process truth
source — agents and the scope-plan reviewer should honor it.

Owner-session identity amendment: B-a781 added
`owner-session-contract-execution-plan.md` as the execution plan for migrating
session identity to the canonical `PROOF_OR_STOP_SESSION_ID` host-adapter contract.
B-9089 implements that runtime contract: generic owner-lease and lifecycle code
consume the host-neutral resolver facade, while Claude Code, Codex,
Antigravity/agy, and future host signals are bridged at the adapter/dispatch
boundary.

- **Main write lock (rollout step 3) — implemented (B-f60c)**: a unified lock in
  `core/main-write-lock.ts` over the canonical `.proof-or-stop/locks/main-write.lock/` path, held by
  DONE / done_recover / gap_log / audit / story_create / B-META finding writes, with
  idempotency enforced inside the lock and a doctor stuck-lock check.
- **Story owner lease (rollout step 2) — implemented (B-c55d)**: the per-story owner lease
  in `core/story-owner-lease.ts`, the single CLI choke-point gate
  (`enforceStoryOwnerLeaseGate` in `cli-engine.ts`) classified by
  `CommandPolicy.ownershipClass`, stale-lease detection + `--takeover` / `--forceTakeover`,
  ownership-aware rejection errors, and `session_brief` ownership rendering.

Current implementation resolves `sessionId` through the owner-session facade:
`PROOF_OR_STOP_SESSION_ID` (`sessionSource: explicit-env`) → host adapter bridge
(`host-adapter`) → local generated token fallback (`generated-token`) →
`deriveLocalSessionId(hostname, worktree-root, ppid)` (`derived-ppid`). Legacy
retired persisted lease labels such as `lattice-env` and `claude-code-env` remain readable and are
normalized on read. The id is a local process-coordination id, never a
cryptographic identity; ppid is only the degraded last-resort fallback because
each tool call can spawn a fresh parent process under some hosts.

For Git repositories, the adapter's project identity is the primary worktree
root resolved through Git's shared worktree inventory. A linked Story worktree
therefore keeps the same logical owner identity as the primary checkout. The
checkout path remains an operation-location check; it is not an owner identity
dimension. Host task and agent/role identity remain isolation dimensions, so a
different session still cannot take an active lease without the existing
takeover policy.

The doctor stale story-owner-lease check (step 5) and the multi-session
convergence/regression smoke (step 6) were both delivered by B-c55d (CHK-005);
B-9089 extends them with the host-neutral owner-session contract.

## Original Problem

Before the implemented main write lock and story owner lease rollout, Proof-or-Stop
supported parallel story worktrees but did not mechanically own write
coordination across sessions. The remaining B-a781 work is narrower: migrate
session identity resolution to the canonical host-adapter `PROOF_OR_STOP_SESSION_ID`
contract without regressing the implemented write-coordination baseline.

The rollout was designed to prevent these failure modes:

- Two sessions can mutate the same story metadata and confuse phase or evidence state.
- Two DONE flows can race on main and leave partial-DONE recovery work.
- Shared B-META writes such as `gap_log` can duplicate findings.
- Agents relying on human chat coordination instead of Proof-or-Stop-enforced ownership.

Proof-or-Stop must allow parallel work while making write authority explicit.

## Goals

1. Multiple stories may progress in parallel.
2. One story has one mutating owner session at a time.
3. Shared main and B-META writes are serialized.
4. Stale sessions can be recovered explicitly.
5. Read-only inspection is always allowed.
6. Errors and `session_brief` must tell agents whether to proceed, wait, or request takeover.

## Terms

- `sessionId`: stable identity for one agent session.
- `story owner lease`: exclusive right to run mutating commands for one story.
- `main write lock`: global lock for writes to main or shared metadata.
- `stale lease`: owner lease with heartbeat older than the configured threshold.
- `takeover`: explicit transfer of a story lease to another session.
- `read-only command`: command that does not mutate story, main, or B-META state.
- `mutating command`: command that writes story metadata, code, review evidence, findings, lifecycle state, or shared audit state.

## Command Classes

### Read-Only Commands

Always allowed. Examples:

- `session_brief`
- `story_get`
- `story_list`
- `checklist_get`
- `finding_list`
- `convergence_check`
- `doctor` read-only scans
- audit report reads

### Story-Scoped Mutating Commands

Require the story owner lease.

Examples:

- `story_advance`, except INIT_CHECK creation edge cases
- `checklist_update`
- `understanding_set`
- `decision_set`
- `finding_resolve` or `finding_dismiss` for a normal story
- `validate` when it writes evidence
- `delivery_check_set`
- `summary_set`

### ReviewerWrite Gate Evidence Commands

These commands write REVIEW evidence but are `reviewerWrite`, not story-owner
mutations. Per `packages/main/src/core/command-policy.ts`, `reviewerWrite` is
exempt from the owner lease; see `review-run-binding-race.md` for why owner-lease
serialization does not solve the review-run binding race.

Examples:

- `review_run_start`
- `review_pass_set`
- `finding_add` for a normal story

### Main/Shared Mutating Commands

Require the main write lock. Some also require a story owner lease.

Examples:

- `story_create`
- `story_advance DONE` merge and cleanup
- `done_recover`
- `gap_log`
- `audit --framework` when it writes reports or findings
- finding mutations on `B-META-framework-audit`
- commands that update main mirror metadata

### Dangerous Mutating Commands

Require the relevant lease plus explicit user or takeover intent.

Examples:

- force takeover of an active non-stale story
- discard another session's active story
- recovery commands that merge to main
- cleanup commands that remove worktrees or branches

## Story Owner Lease Rules

1. The first story-scoped mutating command for a story acquires the owner lease.
2. The lease records `sessionId`, hostname, pid, cwd, command, `acquiredAt`, `heartbeatAt`, and optional human label.
3. Owner commands refresh `heartbeatAt`.
4. Non-owner story-scoped mutating commands fail closed.
5. Read-only commands do not require a lease and do not refresh ownership.
6. Lease is released when the story reaches DONE or DISCARDED and cleanup succeeds.
7. Lease may be marked stale after 30 minutes without heartbeat.
8. A stale lease can be taken over with explicit `--takeover`, recording an event.
9. A non-stale lease requires explicit `--forceTakeover` and should be treated as human-approved.

## Main Write Lock Rules

1. Main/shared mutations must acquire a global mkdir-style lock.
2. The lock must be atomic and stale-reclaimable.
3. The lock scope must cover the whole critical section, not just the final write.
4. DONE must hold the main write lock from pre-merge final check through merge and worktree cleanup.
5. B-META finding writes must hold the main write lock and perform idempotency checks inside the lock.
6. Lock acquisition failure is blocking. Proof-or-Stop must not proceed optimistically.

## Storage

Preferred storage:

- story lease: `.proof-or-stop/story/actives/<storyId>/owner-lease.json`
- main write lock: `.proof-or-stop/locks/main-write.lock/`
- command event trail: existing process-events/activity stream

> Runtime note (B-f60c): `.proof-or-stop/locks/main-write.lock/` is the single canonical
> main write lock path. The former DONE-specific merge serialization lock
> `.proof-or-stop/runtime/done-main-merge.lock` has been retired with no back-compat
> alias — the DONE merge / `done_recover` critical sections now acquire the
> unified lock at the path above. `story-lifecycle.md` references the same
> canonical path; the two docs are synchronized.

The lease file is process metadata, not product evidence. It should be visible in `session_brief` but should not count as verification evidence.

## Error UX

A non-owner mutation must say:

- which story is owned
- owner `sessionId`, cwd, and last heartbeat
- whether the lease is stale
- allowed next action

Implemented behavior (B-c55d): the non-owner rejection message is built by the single pure
formatter `formatNonOwnerError` in `core/story-owner-lease.ts`, which the CLI choke-point
gate calls. It always carries all four facts, and its allowed-next-action text branches on
the stale verdict — a stale lease points at `--takeover`, an active lease points at
read-only / wait / `--forceTakeover`.

Example (active foreign lease):

```text
B-6974 is owned by Proof-or-Stop session abc123, heartbeat 8m ago (owner cwd: /repo/.worktrees/B-6974).
"checklist_update" is an owner-gated storyScopedMutating command, so this session (def456)
cannot run it. The owner lease is still ACTIVE. Use read-only commands, wait for the owner,
or rerun with --forceTakeover to seize the active lease (a deliberate human override).
```

Example (stale foreign lease):

```text
B-6974 is owned by Proof-or-Stop session abc123, heartbeat 45m ago (owner cwd: /repo/.worktrees/B-6974).
"checklist_update" is an owner-gated storyScopedMutating command, so this session (def456)
cannot run it. The owner lease is STALE (no heartbeat for 30+ minutes). Use read-only
commands, wait for the owner, or rerun with --takeover to transfer the stale lease.
```

Main lock contention must say:

```text
main write lock is held by session abc123 running story_advance DONE for B-6974, heartbeat 30s ago.
Retry after it completes.
```

## session_brief Requirements

`session_brief` must show:

- story owner session
- owner cwd
- last heartbeat age
- stale/active status
- whether current session is owner
- recommended action: proceed, read-only only, takeover available, or wait

Implemented behavior (B-c55d): the active-story branch of `session_brief` renders a
`## Story ownership` block built from the pure `summarizeOwnerLease` view in
`core/story-owner-lease.ts`. The block shows the owner session (with its resolved
`sessionSource`), owner cwd, last-heartbeat age, stale/active status, whether the current
session is the owner, and a recommended action — `proceed` when this session owns the
story, `read-only only` for a foreign active lease, or `takeover available` for a foreign
stale lease. A story with no lease on disk renders no ownership block (the next mutating
command will acquire one).

For B-META, `session_brief` must show shared audit state separately and must not suggest
`story_advance`. Implemented behavior (B-c55d): a B-META container renders a
`## Shared audit state (B-META)` block instead of an owner-lease block — it states the
container carries no per-story owner lease (concurrent writes are serialized by the main
write lock) and explicitly tells the agent not to `story_advance` it.

## Idempotency Requirements

Inside the relevant lock:

- `story_create` deduplicates by normalized name and keyword overlap.
- `gap_log` deduplicates by normalized title, category, source, and evidence fingerprint.
- finding mutations reject duplicate active findings unless explicitly linked as `duplicate-of`.
- DONE recovery detects already-merged branches and already-removed worktrees.

## Read-Only Reviewer Mode (`PROOF_OR_STOP_REVIEWER_READONLY=1`)

The command classes above describe ownership coordination between *owner sessions*. A separate
concern is **advisory external reviewers**: external Claude/Codex/Gemini processes delegated
to inspect artifacts and return structured findings as text — they are not Proof-or-Stop gate
reviewers and must not write lifecycle evidence directly.

`PROOF_OR_STOP_REVIEWER_READONLY=1` is an opt-in guard for these advisory reviewer processes. It
layers on top of the `CommandPolicy` / owner-lease architecture:

- The guard runs **before** `enforceStoryOwnerLeaseGate` and before preCommand hooks, so a
  readonly reviewer cannot acquire an owner lease, use `--takeover`, or trigger any hook
  side-effect that requires mutating access.
- Only `ownershipClass === 'readOnly'` commands (e.g. `session_brief`, `story_get`,
  `checklist_get`, `finding_list`) proceed. All other classes fail closed.
- This mode does **not** change how normal Proof-or-Stop gate reviewers (`proof-or-stop-review-*`) work,
  but their evidence authority depends on the invocation path. A registered host adapter can
  issue a signed, exact native-review invocation attestation; that broker-attested native
  reviewer may call `review_pass_set`, `finding_add`, or `delivery_check_set` directly. A
  delivery-review dispatch records the exact prompt, selected host-render identity, and
  current HEAD/material/story-files binding; `delivery_check_set` consumes a one-shot
  descriptor capability for that exact dispatch immediately before persistence. Merely
  setting `agentId` or `PROOF_OR_STOP_AGENT=proof-or-stop-review-delivery` is not authority. A
  cross-provider reviewer launched through ManagedHostRun must instead submit its provider-owned
  proposal and let `managed_review_evidence_import` write the pass/finding only after the completed
  terminal receipt is sealed and proves `replacementSafe=true`,
  `processCleanup.reaped=true`, and `processCleanup.residualProcessGroup=false`. Raw provider CLI processes and unregistered adapters are
  advisory-only and cannot directly author gate evidence.

This section is the current active contract for reviewer read-only mode. Older
reviewer-role background may describe the same separation concept, but must not
override the `PROOF_OR_STOP_REVIEWER_READONLY=1` env name or the command class rules
documented here.

## Out of Scope

This design does not solve:

- general human/agent identity outside the registered host-adapter attestation and managed receipt boundaries
- cross-clone distributed locking
- distributed reviewer identity attestation across machines or clones
- malicious local users editing JSON by hand
- replacing git as source of truth

Those require a stronger trust model and should be separate work.

## Acceptance Criteria

1. Two sessions mutating the same story: second session is rejected with owner guidance.
2. Two sessions working different stories in DEV: both proceed.
3. Two DONE operations: serialized by main write lock; no partial-DONE race.
4. Concurrent `gap_log` of the same issue: produces one canonical finding or duplicate-of link.
5. Stale lease takeover: allowed only with explicit takeover and event record.
6. Active lease takeover: rejected unless `forceTakeover` or human-approved.
7. `session_brief` clearly tells non-owner sessions to wait or stay read-only.
8. Existing read-only reviewer workflows still work.

## Rollout Plan

1. Add this document and command classification table. — done.
2. Implement story owner lease for story-scoped mutations. — done (B-c55d).
3. Implement main write lock for DONE, B-META, audit, `story_create`, and recovery
   commands. — done (B-f60c).
4. Add `session_brief` ownership rendering and ownership-aware errors. — done (B-c55d).
5. Add doctor checks for stale leases and stuck locks. — stuck-lock check done (B-f60c);
   stale story-owner-lease check done (B-c55d).
6. Add convergence/session smoke tests for multi-session behavior. — done (B-c55d).
