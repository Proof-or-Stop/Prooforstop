# B-94a6 real-machine verification — transcript & diff

Real-machine test of authority evidence submission, run 2026-05-21 in the
B-94a6 worktree against the worktree-built CLI (`node packages/main/dist/cli.js`)
and a throwaway fake authority HTTP server.

## Expected (understanding.outcome)

`koala verification_evidence_add` in three modes: off (default) = byte-identical
to post-B-2157, zero network; shadow = local write + best-effort POST, authority
failure → stderr `[warning]` only, exit 0; enforce + failing authority → exit
non-zero, **0 local write** (no local/remote divergence). Local preflight failure
→ 0 POST + 0 local write in every mode. batch_add all-or-nothing.

## Actual transcript — live CLI (highest-value, non-mutating cases)

A fake authority server (node http, counts POSTs) was stood up; the worktree CLI
ran `verification_evidence_add` against B-94a6 / CHK-001 / `CHK-001:happy:0`.
B-94a6 CHK-001 evidence count = 5 before.

| Demo | Command | Result |
|---|---|---|
| 1 | `KOALA_AUTHORITY_MODE=enforce KOALA_AUTHORITY_URL=http://127.0.0.1:<port>` (server returns 500) | **exit 1**; `verification_evidence_add failed: authority POST failed (enforce, no local write): http_error status=500 ...`; evidence count after = **5 (unchanged)**; fake server log shows it **received 1 POST** (pre-POST happened) but local was not written |
| 2 | `KOALA_AUTHORITY_MODE=enforce KOALA_AUTHORITY_URL=http://127.0.0.1:1` (connection refused) | **exit 1**; `authority POST failed (enforce, no local write): error: fetch failed`; evidence count after = **5 (unchanged)** |

Post-condition: `git status` showed `checklist.json` (where verificationEvidence
lives) **NOT modified** — confirming 0 local evidence write under enforce failure.
The A-prepost ordering means the POST is attempted (server saw it) but the local
write is gated behind POST success, so authority failure leaves zero local trace —
no divergence window, no rollback needed.

## Actual — mechanical (all modes / all failure types)

`packages/main/src/tasks/authority-evidence-flow-smoke.ts` drives the REAL
`verification_evidence_add` / `verification_evidence_batch_add` handlers through a
POST-counting fake client across every mode and failure kind:
- off: local write, `server.calls === 0` (zero network).
- local preflight failure (bad itemId / note<5 / waiverType-kind / batch bad entry): `server.calls === 0` + 0 local write; batch all-or-nothing.
- shadow + {5xx, timeout, connection-refused, client throw, malformed 2xx body, batch failure}: exit 0, local write kept, one stderr `[warning]`, warning absent from stdout.
- enforce + {5xx, timeout, connection-refused, authority-rejected, client throw, malformed 2xx body, batch whole-reject, batch partial-accept}: throws controlled gating error, re-read checklist shows entry NOT present (0 local write); partial-accept → whole batch 0 writes.

`koala validate --story=B-94a6` → ALL PASS; verification intent coverage 17/17.
`test:verification-context-pack` + `test:process-fact-contract` (hard blockers) green.

## Diff (expected vs actual)

No differences. The live CLI demonstrates the load-bearing Blocker-4 behavior
(enforce + authority failure → non-zero exit + zero local evidence write, no
divergence), and the smoke exhaustively covers off/shadow/enforce × every failure
kind including the F-001 malformed-2xx path. off mode is byte-identical to
post-B-2157 (zero network); B-2157 VCP behavior is byte-identical (additive-only,
authority-contracts.ts 0 deletions, VCP smoke green).
