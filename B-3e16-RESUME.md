# B-3e16 — one human action away from DONE

The migration is complete and independently verified. `story_advance DONE` is blocked by
the convergence breaker, which is human-only by design.

## Run this

```bash
cd /Users/qipan/work/repo/Prooforstop/.worktrees/B-3e16
node bin/proof-or-stop.js story_resume --storyId=B-3e16 --ack \
  --reason="Reviewed: 12 independent host rounds, 12 defects fixed, npm test 58/58, delivery check 13/13"

node bin/proof-or-stop.js story_advance '{"storyId":"B-3e16","phase":"DONE"}'
```

If `story_advance DONE` then reports stale reviewer passes (`RP-016`–`RP-019`), the four
lanes need re-running in REVIEW at current material: `dev_memory_preflight_ack`, then
`story_advance DEV` → `REVIEW`, re-run the four `lattice-review-*` lanes, then `TEST` → `DONE`.

## Why it froze

`gate-repeat 2>=2`. Each defect fix moved `materialHash`, invalidating the host verdicts
recorded before it, so the same gate was hit repeatedly. The brake exists because story
B-f458 burned 14 hours in this pattern. It fired correctly.

`story_resume --ack` is documented in `command-policy.ts:155` as refused under
autopilot/non-interactive sessions "so a looping agent cannot self-service the freeze."
The agent session declined to run it for that reason.

## State

| | |
|---|---|
| Branch | `story/B-3e16`, tree clean |
| main | untouched (`8a44611980`), nothing pushed to origin |
| Command | `proof-or-stop graph` → 369 stories, 426 relations |
| Checklist / findings | 6/6 · 18/18 resolved |
| `npm test` / `validate` | 58/58 · 116/116, 0 dirty |
| Host verdicts | 3× PASS — "nothing here should not ship" |
| `done_required_validate` | PASS |
| Delivery check | 13/13 docs promises verified |

## What the review found

Twelve independent-host rounds (codex, then claude) found twelve real defects that eleven
in-session reviewer passes had approved. Six were in guards written to close the previous
finding:

- live arbitrary code execution via unvalidated `--root`
- a provenance guard defeated by a nested same-name producer, then by an overload, then by
  an aliased `node:url` export, then by a parameter default, then by a type widening
- a hand-built `file://` URL breaking on `#`/`?` paths
- a guard that *printed coverage it did not have* (the worker path it claimed to exercise
  never ran)
- three separate guards that passed on exactly the defect they existed to catch

Recorded as bounded limitations rather than closed: the worker-thread rebuild path is not
exercised by the write guard; write-then-delete within one scan is invisible; sibling
worktrees are outside the snapshot; pruned paths (`node_modules`, `dist`, `.git`) are not
hashed. Each is documented in `packages/graph/scripts/verify-no-project-writes.mjs`.

Three lessons were captured to project dev-memory (guard-bypass, anti-pattern, workflow).
