# B-9f2c — one command from DONE

The story graph dossier migration is **complete and verified**. It is blocked only by a
convergence-breaker freeze that, by design, only a human at a real terminal can clear.

## Run this to finish

```bash
cd /Users/qipan/work/repo/Prooforstop/.worktrees/B-9f2c
node packages/main/dist/cli.js story_resume --storyId=B-9f2c --ack \
  --reason="Breaker tripped on gate-repeat only; dryRun shows the sole blocker is being 1 commit behind main (3aa57145d8), merge-tree reports zero conflicts, and done_required_validate passed with npm test 59/59."

# then, in ONE process tree (TRACEPARENT must be unset for both, or the
# effectiveEnvironmentDigest will not match between earn and gate):
env -u TRACEPARENT bash -c '
  node packages/main/dist/cli.js done_prepare "{\"storyId\":\"B-9f2c\",\"mergeMain\":true,\"refreshStale\":true,\"validate\":true}"
  node packages/main/dist/cli.js story_advance "{\"storyId\":\"B-9f2c\",\"phase\":\"DONE\"}"
'
```

## Why it froze

`gate-repeat 2>=2` — the same gate was retried twice. That is a deliberate brake against
runaway retry loops. It fired correctly. `story_resume --ack` requires `isTTY === true`
(`core/convergence-breaker.ts:isInteractiveAckAllowed`), which an agent tool cannot supply.
Spoofing a TTY would forge an audit record claiming human review, so it was not done.

## Why it is safe to clear

`done_prepare --dryRun` reports one blocker: `story/B-9f2c is behind main by 1 commits`.
That commit is `3aa57145d8` (the d3 hard-failure + on-demand client build, committed
separately at the user's direction). `git merge-tree` reports **zero conflicts**.

| Gate | State |
|---|---|
| done_required_validate | PASS — packages/main build + `npm test` 59/59 |
| Reviewer lanes | RP-021 quality, RP-022 concept, RP-023 docs, RP-024 test-coverage |
| Delivery check | 8/8 docsPromises verified, 0 unverified, 5 realMachineTests |
| Review assurance floor | satisfied (degraded-single-host; 3 hosts installed, 0 review-ready) |
| Certification window | CW-004 ADMITTED |
| Open findings | none (4 raised, 4 resolved) |

## What shipped

- All four upstream dossier commits (4c3bde0, 7ecad9a, a0b14da, 1536588) ported into
  `packages/graph`; `dossier.js` byte-identical to upstream (sha256 verified).
- `proof-or-stop graph --story=B-xxxx` opens `/story/<id>`; an unknown id is refused
  **before** the server listens, naming near-miss candidates.
- Verified live: 200 on `/story/B-9f2c`, 404 on `/story/a/b`, exit 1 on a typo.
- Docs: `CLAUDE.md` flag table + dossier paragraph; `packages/graph/README.md` section
  and endpoint row.
- New smoke task registered in all THREE test-membership authorities.

## Defects found and fixed en route

- **F-002 (high)** `graph-command-migration.md` documented TWO test authorities; there are
  three. CHK-005 copied that framing and under-registered the new task, which aborted the
  entire root suite (`npm test` exit 1 in 858ms).
- **F-004 (medium)** the F-002 fix missed a second stale claim in the same file.
- **F-001 / F-003 (accepted_risk)** frozen-intent clauses that no available fix could
  address — both attempted fixes were correctly refused by the framework.

Delete this file once merged.
