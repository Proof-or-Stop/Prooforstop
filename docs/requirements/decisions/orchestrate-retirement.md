# Orchestrate Retirement And Canonical Proof-or-Stop Root

## Decision

`/Users/jek/Documents/Work/proofbound` is the canonical active checkout for new
Proof-or-Stop work.

`/Users/jek/Documents/Work/Orchestrate` is a retired, read-only legacy evidence
root. It remains useful for local evidence lookup and paper/research traceability,
but it must not accept new story, checklist, review, validation, or evidence
writes.

## CLI Behavior

A retired root is expressed in project config with:

```json
{
  "retiredRoot": true,
  "canonicalRoot": "/Users/jek/Documents/Work/proofbound"
}
```

Read-only workflow commands remain available so old evidence can still be
inspected. Mutating workflow commands fail before handler dispatch and print:

```text
Proof-or-Stop root is retired: /Users/jek/Documents/Work/Orchestrate
Use canonicalRoot: /Users/jek/Documents/Work/proofbound
```

This behavior is Host-neutral and Agent-neutral. It belongs to the Proof-or-Stop
workflow layer and does not depend on Codex, Claude, shell hooks, or a local Git
remote setting.

## Migrated Active Stories

The old active Orchestrate worktrees were preserved under proof-or-stop:

| Story | Preserved proof-or-stop worktree | Status |
| --- | --- | --- |
| B-3523 | `/Users/jek/Documents/Work/proofbound/.worktrees/B-3523` | preserved, not normalized |
| B-fbb6 | `/Users/jek/Documents/Work/proofbound/.worktrees/B-fbb6` | preserved, not normalized |

This retirement story does not finish, rebase, normalize, or merge those story
branches. It only prevents new writes from landing in the old root.

Any remaining Orchestrate lab or temporary worktrees are separate legacy
artifacts. They are not counted as active migrated story worktrees.

## Evidence Policy

Legacy Orchestrate evidence stays local-only unless it is deliberately curated
into public-safe documentation. Do not publish raw `.proof-or-stop/story/**`,
authority trust files, local transcripts, or runtime logs to GitHub.

New Proof-or-Stop Authority runner diagnostics, including `jobs_stream` notification
hints from `/v1/runners/{runnerId}/jobs/stream`, belong only in the canonical
proof-or-stop workflow. They must not create new evidence or runtime writes under
the retired Orchestrate root.
