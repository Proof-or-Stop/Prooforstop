# Lab validation-queue-wait-outside-command-timeout: detailed record

## Problem
A validation command's configured `timeoutMs` started before the command waited on the same-user
machine validation queue. Time spent queued behind another session's validation consumed the
command's budget: a healthy command whose wait exceeded its timeout was reported timed out
(code 124, `effectiveTimeoutMs` 0) without ever starting, and one that did start got only the
remainder. The operator decided on 2026-09-18 that queue waiting must not count toward the command
timeout.

## Behavior change
- `runValidationCommand` bounds the machine queue wait by `MACHINE_FIXED_PORT_RUNTIME_POLICY.queueDeadlineMs`
  (300 s) and the caller's outer deadline only. Once admitted, the command's timer is armed with its
  whole configured timeout, still capped by the caller's outer deadline and, under delegation, the live
  grant.
- The admitted work and the reservation it holds are bounded by the latest possible admission plus the
  configured timeout, never beyond the outer deadline.
- `ValidationCapacityLockOptions` gains `waitDeadlineAt`, which bounds only the wait for admission;
  `deadlineAt` keeps bounding the admitted work. An inherited (delegated) grant request honors the same
  wait bound without affecting the granted frame. An expired wait bound alone is reported as the capacity
  wait deadline (`machine queue wait deadline exceeded before child launch`), not as the caller's deadline.
- Because the admitted work may now be bounded up to the queue deadline plus the configured timeout, a
  reservation can extend past Node's 2^31-1 ms timer ceiling for timeouts near the supported maximum. The
  delegation module's handshake and grant-expiry timers therefore use a segmented `deadlineTimer` that
  re-arms in bounded steps instead of passing the whole duration to `setTimeout` (which would silently
  fire after 1 ms). Found by the first independent audit of this Lab.
- The earlier contract - "a queue wait consumes the configured budget", recorded in
  `docs/lab/nested-verification-machine-owner.md` and asserted by mode `queue-wait-cap` of
  `scripts/verify-nested-validation-result-contract.mjs`, and "a queued command timeout launches zero" in
  `scripts/verify-machine-port-boundaries.mjs` and `scripts/verify-machine-heavy-boundaries.mjs` - is
  superseded. Those checks now assert the new contract (the boundary suites also keep a case where an outer
  deadline shorter than the wait still launches nothing), and the old record carries a superseded note.

## Verification
RED/GREEN: `node scripts/verify-validation-queue-wait-outside-command-timeout.mjs` (private fixture machine
queue; a helper process holds a real queue ticket through the product API).

| scenario | before | after |
|---|---|---|
| queued ~4 s, command timeout 2000 ms | code 124, timed out, effective 0 ms | code 0, ran, effective 2000 ms |
| queued ~2 s, 1 s command, timeout 2500 ms | code 124, timed out, effective 635 ms | code 0, ran, effective 2500 ms |
| lock API: queued, wait bound 1000 ms, caller deadline 60 s | waited ~3.8 s and ran | refused after ~1.0 s as a capacity wait |

Audit round 1 regression: an outer command and its delegated nested command both at the maximum timeout
(2147483647 ms). Without the segmented timers the nested command was refused at once with
`VALIDATION_DELEGATION_REFUSED: handshake deadline` and a `TimeoutOverflowWarning`; with them it runs and
exits 0. (On main before this Lab the reservation never exceeded the ceiling, so this scenario guards the
new bound rather than an old defect.)

Before: 4 failing expectations. After: 10 checks. Controls kept in both: an uncontended command runs; a
command overrunning its own timeout is still killed; an outer deadline still bounds the queue wait; work
admitted in time runs past the wait bound; a caller deadline still reports the caller's own error.
`verify-nested-validation-result-contract.mjs queue-wait-cap` after the change: queued ~1.6 s, armed 4000 ms,
killed at 4103 ms.
