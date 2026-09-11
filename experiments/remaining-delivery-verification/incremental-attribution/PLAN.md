# Incremental attribution and lost-owner queue repair

Baseline: 1d48c13e126db2ad0ceab850a346afffbfb5d476. This includes every prior Lab repair and main700e1983. Historical speedups are not credited again. Only the Lab checkout and experimental output may change; real Story metadata, other owners, main, global installations and versions remain outside mutation scope.

Measurement: freeze the latest30-day activity window with original bytes and line references; collect current Story state via the canonical CLI at resolved authoritative cwd. Command intervals are observed occupancy, not automatically execution or waste. Sum and union are separate. Unknown queue/review/model time remains unknown. Recent logged sessions form an observed cohort, not a live process census. A current read-only probe does not establish what another existing process loaded.

Hypothesis: withOwnerLeaseHeartbeat latches a failed renewal but does not notify capacity acquisition. An invocation that loses its lease while queued can wait for the full holder and enter its callback before the deferred error is thrown. This is a bounded mechanism hypothesis, not a retroactive diagnosis of every historical lease failure.

RED: same real withOfficialValidationExecution plus workspace capacity and owner lease APIs; keep a private holder for1000ms, wait until the contender reports queue contention, revoke its own private lease via releaseOwnerLease, observe settlement and child launch. Require no child after lease loss and refusal within400ms of revocation. Run3 replicates, retain all rows. Existing valid-owner waiting and caller abort must retain their outcomes. Deliberate refusal latency is comparable; neither arm is a successful Story delivery sample.

GREEN: same exact test command, no change to holder duration, heartbeat20ms, polling10ms, marker oracle or timing budget. Forward lease-loss cancellation to the capacity wait while preserving any caller abort signal. Do not promise cancellation of already-running subprocesses. Preserve owner generation fencing and lock cleanup. Test no revoked callback, healthy waiting, caller cancellation and subsequent acquisition.

Audit: Claude independently reviews source delta, raw RED/GREEN output, original activity calculations and scope. The original expensive250-case identity test is unchanged and need not be rerun to compare this queue repair. Existing targeted runtime/ownership regressions run when relevant.

Completion statements: claim only measured refusal latency/launch prevention, current observed timing coverage and enrolled probe scope. Full Story end-to-end benefit and migration of foreign owner/reviewer processes still require actual deployment/follow-up evidence; Lab cannot invent those records.

Second bounded measurement repair, after queue repair3b0b8530: the frozen24-hour
activity cohort has897 rows with session/entrypoint labels and no implementation
digest. This does not prove non-adoption. Test actual ordinary/Codex CLI commands
in a private Git root with the existing read-only-recording opt-in. RED must show
that successful pinned entry checks fail to persist their actual digest/entry/PID
in those records. GREEN reuses the already checked in-memory identity, marks
unbound calls unverified, retains default read-only behavior and rejects wrong
pins before any success record. It does not migrate foreign running sessions.
