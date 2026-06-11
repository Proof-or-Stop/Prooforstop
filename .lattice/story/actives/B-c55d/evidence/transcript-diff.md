# B-c55d real-machine verification — transcript & diff

User-perspective real-machine test of the story owner lease, run 2026-05-19 against
the worktree-built CLI (`node packages/main/dist/cli.js`) — the global `koala` is the
`main` build and does not yet carry the gate, so the gate was exercised through the
worktree build.

Two sessions are simulated by the priority-1 anchor `KOALA_SESSION_ID`:
the **owner** = the natural Claude Code session (`CLAUDE_CODE_SESSION_ID`
`c6f1f20d-…`, `sessionSource: claude-code-env`); the **intruder** =
`KOALA_SESSION_ID=koala-foreign-B` (`sessionSource: koala-env`).

## Expected (PLAN outcome)

Multi-session parallel work on one story is mechanically coordinated by Koala:
one story has one mutating owner; a non-owner's story-scoped mutating command is
fail-closed rejected with owner guidance; read-only commands are never blocked;
`session_brief` renders ownership and tells a non-owner to wait / stay read-only;
a stale lease can be taken over with `--takeover`, an active lease only with the
deliberate `--forceTakeover` override, and every takeover is logged.

## Actual transcript

| Step | Command (session) | Result |
|---|---|---|
| 1 | show `owner-lease.json` | lease present — owner `c6f1f20d-…`, `sessionSource: claude-code-env`, cwd, acquiredAt, heartbeatAt |
| 2 | `verification_evidence_refresh_stale --storyId=B-c55d` (owner) | **allowed**, exit 0; heartbeatAt advanced `03:40:48Z → 04:16:08Z` |
| 3 | `verification_evidence_refresh_stale --storyId=B-c55d` (koala-foreign-B) | **fail-closed reject**, exit 1: `B-c55d is owned by Koala session c6f1f20d-…, heartbeat 25s ago (owner cwd: …). "verification_evidence_refresh_stale" is an owner-gated storyScopedMutating command, so this session (koala-foreign-B) cannot run it. The owner lease is still ACTIVE. Use read-only commands, wait for the owner, or rerun with --forceTakeover…` |
| 4 | `checklist_get '{"storyId":"B-c55d"}'` (koala-foreign-B) | **allowed**, exit 0 — read-only is never lease-gated |
| 5 | `session_brief` (koala-foreign-B) | renders `## Story ownership (active)` — owner session + `[claude-code-env]`, owner cwd, `last heartbeat: 40s ago`, `this session: NOT owner (koala-foreign-B)`, `recommended: read-only only …` |
| 6 | `verification_evidence_refresh_stale --storyId=B-c55d --takeover` (koala-foreign-B) | **rejected**, exit 1: lease is ACTIVE, `--takeover` only transfers a STALE lease (30+ min) — `rerun with --forceTakeover` |
| 7 | `verification_evidence_refresh_stale --storyId=B-c55d --forceTakeover` (koala-foreign-B) | **allowed**, exit 0 — lease seized; `owner-lease.json` now `sessionId: koala-foreign-B`; `.koala/activity.jsonl` gains `story-owner-lease-takeover` event `kind:forceTakeover, fromSessionId:c6f1f20d-…, toSessionId:koala-foreign-B, fromWasStale:false` |

## Diff (expected vs actual)

No differences. Every observed behavior matches the PLAN outcome:
- one-story-one-owner enforced — owner allowed (step 2), non-owner fail-closed (step 3);
- read-only never blocked (step 4);
- `session_brief` ownership rendering with a non-owner recommendation (step 5);
- `--takeover` refuses an active lease (step 6); `--forceTakeover` overrides and logs the event (step 7).

The gate also correctly composes with the existing phase gate: a non-owner
`checklist_update` first hit the TEST-phase tool restriction (`checklist_update` is
not a TEST-phase command) — so the foreign-rejection step used
`verification_evidence_refresh_stale`, a storyScopedMutating command valid in TEST.

Mechanical backing: `koala validate --story=B-c55d` → `ALL PASS`, verification
intent coverage 26/26; the `story-owner-lease-smoke` (cases 1-25) and
`command-ownership-contract` (94 commands) suites drive the same gate / lease
internals.

The test lease (`owner-lease.json`) was removed after the run — it is a gitignored
runtime artifact and is not part of the committed story state.
