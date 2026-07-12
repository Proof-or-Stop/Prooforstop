# B-623a Plan — Push-based host long-thread burn detection

## Problem

B-70e9 (DONE, v0.3.184) shipped `lattice usage_sweep`, a read-only retro-attribution report over the host transcript stores (`~/.codex/sessions`, `~/.claude/projects`). It works — it attributed a month-old Codex Desktop thread (rollout 019e40d0) at 1.76B cumulative input tokens across 13,648 turns (per-turn prompt grown 47k→247k; one execution-plan doc re-paid 1251 times) plus 9 concurrently-open proofbound desktop threads — but it is PULL-based: detection happens only when someone remembers to run it. Interactive desktop threads re-send their entire accumulated context every turn, and lattice cannot terminate sessions it did not launch (B-70e9 non-goal: desktop sessions are report-only), so early loud detection is the only available lever.

## Approach

Make detection PUSH-based on two existing surfaces, advisory-only (no gate, gateEvidence=false):

1. **`lattice doctor` burn scan** — doctor already is the habitual health surface. Add a "Host burn scan (advisory)" section that reuses the core/usage-sweep.ts scanners (stat + stream-read, zero writes) over a bounded recent-activity window and prints a prominent warning per flagged session naming the session file, cwd, and cumulative tokens.
2. **`usage_sweep --alert`** — opt-in mode that appends the same alert evaluation to the normal report and exits non-zero when any session exceeds thresholds, so an unattended cron job can drive notifications.

## Design

## CHK-001 — pure core evaluator (`packages/main/src/core/usage-burn-alert.ts`, new)

- `evaluateBurnAlerts(rows: SweepSessionRow[], { nowMs, thresholds, fileSizeOf? })` → `{ thresholds, scanned, findings[] }`.
- Follows the usage-sweep pure-core contract: no `process.env`, no `Date.now()` inside; clock and thresholds injected; `fileSizeOf` injectable (default lstat-free `statSync` wrapper) so tests are hermetic.
- Three flag reasons, all strictly-greater (at-threshold does NOT flag):
  - `file-size`: transcript file size in bytes > `fileBytes`.
  - `input-tokens`: burn input tokens > `inputTokens`. Codex rows use the LAST cumulative `total_token_usage.input` (already includes cached); Claude rows use summed `input + cacheRead + cacheCreation` — deliberately including cache reads because the runaway pattern IS repeated cache re-payment. Null usage never flags this reason.
  - `session-age`: `firstTimestamp` parseable AND `nowMs - firstMs > ageDays`. The "still active" half comes from the scan window itself (caller sweeps with `sinceMs = nowMs - recentHours`), so every scanned row already has recent mtime. Unparseable/missing firstTimestamp never flags this reason.
- Findings ordered deterministically: burn input tokens desc, then sessionId asc.
- Read-only: the only filesystem access is `stat` on already-discovered transcript paths.

## CHK-002 — env threshold resolver (same module)

- `resolveBurnAlertThresholds(env: Record<string, string | undefined>)` — pure function of an env RECORD (handlers pass `process.env`), keeping core env-free while making thresholds env-tunable:
  - `LATTICE_BURN_ALERT_FILE_MB` → fileBytes (default 100 MB)
  - `LATTICE_BURN_ALERT_INPUT_TOKENS` → inputTokens (default 100,000,000)
  - `LATTICE_BURN_ALERT_AGE_DAYS` → ageDays (default 7)
  - `LATTICE_BURN_ALERT_RECENT_HOURS` → recentHours scan window (default 48; `0` disables the doctor burn scan entirely)
- Non-numeric / non-finite / negative values fall back to the default for that variable (never throw — doctor must not break on a typo'd env).

## CHK-003 — doctor advisory section (`packages/main/src/handlers/doctor.ts`)

- `doctor()` becomes `async` (the CLI dispatch layer already awaits handler results; usage_sweep is already async). Known sync call sites updated to await: `tasks/doctor-gitroot-probe-smoke.ts`, `tasks/story-metadata-protection-smoke.ts`, `tasks/storydir-inside-gitroot-suite.ts` (grep-verified complete list).
- Section behavior:
  - thresholds = `resolveBurnAlertThresholds(process.env)`; `recentHours == 0` → print a "disabled" line and skip scanning (also the hermeticity switch for unrelated doctor smokes).
  - Sweep both stores (default `~/.codex/sessions`, `~/.claude/projects` — same defaults as the usage_sweep handler) with `sinceMs = now - recentHours`.
  - Per flagged session print a prominent block naming host, session id, cumulative tokens, file path + size, cwd, first/last activity, and which thresholds tripped, plus the advisory action line (close/restart the thread; lattice cannot stop sessions it did not launch).
  - Clean → single ✓ line with scanned count and window. JSON mode → `hostBurnScan { advisory: true, gateEvidence: false, thresholds, recentHours, scanned, findings }`.
- Advisory-only: plain doctor exit code unchanged regardless of findings; no gate consumes this output.

## CHK-004 — `usage_sweep --alert` (`handlers/usage-sweep.ts` + `cli-engine.ts` + `cli/command-catalog.ts`)

- Handler: `alert?: boolean` arg. After building the report, evaluate alerts over the swept rows using `resolveBurnAlertThresholds(process.env)` and `nowMs = now()`. The recency window for `--alert` is the caller's `--since` (documented). Human output appends a BURN ALERT section; JSON output gains an `alert` field. The handler NEVER exits/throws on fired alerts (stays pure for in-process tests); it exposes `alertFired`.
- CLI: a `usage_sweep` dispatch wrapper in cli-engine follows the existing recover_evidence pattern — print the full result FIRST, then throw when `args.alert && alertFired`, so `process.exitCode=1` for cron while the report still lands on stdout. Plain `usage_sweep` dispatch is byte-identical to today.
- Classification: `--alert` performs ZERO writes → no changes to `ownership-gate.ts` / `activity-policy.ts`; the smoke asserts `usage_sweep {alert:true}` still resolves readOnly on both surfaces.
- `command-catalog.ts`: add the `alert` boolean to the usage_sweep schema; `core/process-fact-levels.ts` usage_sweep rationale extended to mention the exit-code-only alert mode (still L0 read).

## CHK-005 — smoke (`packages/main/src/tasks/usage-burn-alert-smoke.ts`, new)

- OS-temp fixtures only (never the real home stores), reusing usage-sweep-smoke patterns:
  1. resolver defaults; each env override; garbage/negative/empty env falls back.
  2. evaluator boundaries: exactly-at-threshold not flagged; just-over flagged; per-reason isolation; null-usage and unparseable-firstTimestamp never flag their reasons; codex vs claude token formula; deterministic ordering.
  3. doctor text mode: flagged fixture prints the warning naming file/cwd/tokens; clean fixture prints the ✓ line; `RECENT_HOURS=0` prints disabled and skips scanning; JSON `hostBurnScan.advisory === true && gateEvidence === false`.
  4. `--alert` end-to-end via the real built CLI: flagged fixture → non-zero exit AND report on stdout; clean fixture → exit 0; flagged fixture WITHOUT `--alert` → exit 0 (opt-in only).
  5. zero-writes snapshot of the store dirs across doctor burn scan and `--alert` sweep.
  6. classification: `isReadOnlyCommand('usage_sweep', {alert:true}) === true`; `resolveEffectiveOwnershipClass('usage_sweep', {alert:true}, null) === 'readOnly'`.
- Wiring: `test:usage-burn-alert` npm scripts (root + packages/main) mirroring `test:usage-sweep`; run-all-smokes auto-discovers `dist/tasks/*-smoke.js` so `npm run test:all` picks it up without further wiring.

## Non-goals (frozen scope)

- No gate wiring; burn alerts never produce gate evidence and never block a phase.
- No usage-ledger reads/writes (usage-sweep independence contract intact).
- No mutation of host sessions or transcript stores; no notification delivery (cron owns that); no daemon; no config-file schema (env-only thresholds).

## Verification

Each CHK carries test-intent-authored verificationIntent; the smoke covers happy/edge/adversarial mechanically; `npm --prefix packages/main run build` + the new smoke + the touched existing smokes run in the story worktree; real-machine doctor + usage_sweep --alert runs against the real stores recorded at TEST (read-only).
