# Session Ownership and Write Leases

## Status

Adopted design; rollout in progress. This document is the canonical, adopted design for
Koala's multi-session coordination rules and is treated as a process truth source — agents
and the scope-plan reviewer should honor it. The main write lock (rollout step 3) is now
implemented (B-f60c): a unified lock in `core/main-write-lock.ts` over the canonical
`.koala/locks/main-write.lock/` path, held by DONE / done_recover / gap_log / audit /
story_create / B-META finding writes, with idempotency enforced inside the lock and a
doctor stuck-lock check. The remaining rollout steps it describes — story owner lease
(step 2), takeover UX, and session_brief ownership rendering — are not yet implemented;
that work is tracked as separate follow-up stories.

## Problem

Koala supports parallel story worktrees, but it does not yet mechanically own write coordination across sessions.

Observed failures:

- Two sessions can mutate the same story metadata and confuse phase or evidence state.
- Two DONE flows can race on main and leave partial-DONE recovery work.
- Shared B-META writes such as `gap_log` can duplicate findings.
- Agents currently rely on human chat coordination instead of Koala-enforced ownership.

Koala must allow parallel work while making write authority explicit.

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
- `review_run_start`
- `review_pass_set`
- `finding_add` for a normal story
- `finding_resolve` or `finding_dismiss` for a normal story
- `validate` when it writes evidence
- `delivery_check_set`
- `summary_set`

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
6. Lock acquisition failure is blocking. Koala must not proceed optimistically.

## Storage

Preferred storage:

- story lease: `.koala/story/actives/<storyId>/owner-lease.json`
- main write lock: `.koala/locks/main-write.lock/`
- command event trail: existing process-events/activity stream

> Runtime note (B-f60c): `.koala/locks/main-write.lock/` is the single canonical
> main write lock path. The former DONE-specific merge serialization lock
> `.koala/runtime/done-main-merge.lock` has been retired with no back-compat
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

Example:

```text
B-6974 is owned by session abc123, heartbeat 8m ago. This command mutates story state.
Use read-only commands, wait for the owner, or rerun with --takeover after the lease is stale.
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

For B-META, `session_brief` must show shared audit state separately and must not suggest `story_advance`.

## Idempotency Requirements

Inside the relevant lock:

- `story_create` deduplicates by normalized name and keyword overlap.
- `gap_log` deduplicates by normalized title, category, source, and evidence fingerprint.
- finding mutations reject duplicate active findings unless explicitly linked as `duplicate-of`.
- DONE recovery detects already-merged branches and already-removed worktrees.

## Out of Scope

This design does not solve:

- cryptographic identity or unforgeable agent identity
- cross-clone distributed locking
- reviewer identity attestation
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

1. Add this document and command classification table.
2. Implement story owner lease for story-scoped mutations.
3. Implement main write lock for DONE, B-META, audit, `story_create`, and recovery commands.
4. Add `session_brief` ownership rendering and ownership-aware errors.
5. Add doctor checks for stale leases and stuck locks.
6. Add convergence/session smoke tests for multi-session behavior.
