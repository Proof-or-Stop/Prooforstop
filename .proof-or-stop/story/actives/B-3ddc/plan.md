# Plan — B-3ddc host_run codex turn.failed honest unavailableReason

Execution order: CHK-001 → CHK-002 → CHK-003 (single DEV pass; the smoke in CHK-003
is written red-first against the CHK-002 contract, then the implementation turns it green).

Chosen decision: `second-bounded-lane` — a second `UsageLineScanner` instance retains the
last codex `turn.failed` / terminal `error` line under the identical 1 MiB last-one-wins cap,
so the existing usage lane (and its F-013/F-026 truncation semantics) stays byte-identical.

## CHK-001 — Retain codex turn.failed / terminal error lines as a second bounded lane

Files: modify `packages/main/src/core/host-run.ts`

- Add `failureLineRetainerFor(host)` next to `usageLineRetainerFor`: for `codex`, matches a
  JSON object line whose `type` is `turn.failed` or `error` (own-property guarded); `undefined`
  for claude/agy (out of scope).
- `HostRunSpawnPlan` gains `retainFailureLine?: HostRunUsageLineRetainer`; `HostRunSpawnResult`
  gains `failureText?: string` (the retained failure line, `''` when none).
- `defaultHostRunRunner` instantiates a SECOND `UsageLineScanner` with `plan.retainFailureLine`,
  pushes the same stdout chunks, flushes at finish, and returns `failureText`. The usage lane,
  live passthrough, timeout/exit semantics, and the F-013/F-026 truncation flag are untouched.
- `runHostRun.invokeRunner` threads `retainFailureLine: failureLineRetainerFor(args.host)`.

## CHK-002 — Record turn_failed(<short digest of error.message>) with honest fallback

Files: modify `packages/main/src/core/host-run.ts`

- Add `scanCodexTurnFailed(text)`: line-streamed bounded scan (same shape as
  `scanCodexTurnCompletedUsage`), last-wins across `turn.failed` / terminal `error` events;
  extracts `error.message` (turn.failed) or `message` (error) when present as a string.
- Digest rules (from the PLAN decision): when the extracted message itself parses as nested
  JSON, drill to the innermost `error.message` string; collapse control chars/whitespace;
  hard-truncate to 160 chars with a trailing `…`; empty/unextractable message →
  `turn_failed(no_error_message)`.
- `recordFinalForHost` gains the retained `failureText` parameter. Codex branch: ONLY when
  `scanCodexTurnCompletedUsage` returns null, scan `failureText` (streaming lane) falling back
  to `stdout` (buffered fake runners); a found failure event records unavailableReason
  `turn_failed(<digest>)`, else `no_turn_completed_usage_event` exactly as today.
- Honesty invariants: usage numbers never fabricated; a genuine `turn.completed` usage still
  records provider-reported (failure lane never consulted); the F-013/F-026
  `usage_line_retention_truncated` priority path is unchanged; an over-cap-dropped failure
  line degrades to the generic fallback (no new truncation marker).

## CHK-003 — Pin the observed B-3928 turn.failed fixture in the host-run usage smoke

Files: test `packages/main/src/tasks/host-run-usage-smoke.ts`

- Pin the EXACT observed line as a string literal fixture:
  `{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\"}}"}}`
  and assert the recorded unavailableReason is `turn_failed(The 'gpt-5.6-sol' model requires a
  newer version of Codex. Please upgrade to the latest app or CLI and try again.)` (innermost
  message extracted from the nested JSON).
- Update the existing `CHK-001 codex edge: turn.failed` check: `CODEX_FAILED_STDOUT`
  (`error.message: "boom"`) now expects `turn_failed(boom)`.
- Add a pure-fallback case (no turn.completed, no failure event) asserting
  `no_turn_completed_usage_event` is still recorded.
- Add a precedence case (turn.completed usage AND a trailing turn.failed) asserting the final
  stays provider-reported with the same mapped numbers (usage never discarded).
- Add a streaming-lane case through `defaultHostRunRunner` (real subprocess echoing the pinned
  line) proving the failure line is retained end-to-end under the cap discipline.

Verification: `npm run build` (packages/main) then
`node packages/main/dist/tasks/host-run-usage-smoke.js` — all existing checks (notably F-013 /
F-026 truncation and the codex/claude/agy happy paths) must keep passing unchanged.
