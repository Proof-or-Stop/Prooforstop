# Plan: B-70e9 Unify host-side LLM usage capture: launcher choke-point ledger rows (M1) plus a read-only retro-attribution usage sweep (M2)

Design anchors (from decision.json): single ledger-writer choke point reusing the
existing dispatch-usage seam; diagnostics-only (gateEvidence=false); provider
truth over estimates (absence = explicit source=unavailable); fail-closed caps
before spawn; strictly read-only retro sweep. Verified host surfaces: codex
`exec --json` terminal `turn.completed` usage event (input_tokens includes
cached_input_tokens; --ephemeral means no rollout for canonical runs); claude
stream-json result usage via parseClaudeCliOutput; agy has no usage surface.

## CHK-001: M1: Add a host-run choke-point command (host_run)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/host-run.ts, packages/main/src/handlers/host-run.ts
- Modify: packages/main/src/cli/command-catalog.ts, packages/main/src/core/host-execution-readiness.ts, packages/main/src/core/command-policy.ts (if command registration requires a policy entry)
- Test: packages/main/src/tasks/host-run-usage-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` clean
- `node packages/main/dist/tasks/host-run-usage-smoke.js` all checks pass
- `node bin/lattice.js host_run --help` shows host/storyId/agentType/phase/promptFile/reviewRunId/lane args

**DoneWhen**:
- `host_run` builds argv from canonicalReviewHostLauncherSpec (codex/claude/agy), substituting `<prompt>`/`<prompt-file>` from --promptFile/--prompt; the agy `--print-timeout` slot is parameterizable via an explicit option while `launcherArgvMatchesCanonical` accepts any `\d+[smh]` value in that slot (probe default stays 30s)
- Ledger seam order per run: recordDispatchPreflight (estimate row, sequence 1) -> budget/concurrency guards -> spawn -> final row (sequence 2 superseding the estimate): codex = provider-reported via `turn.completed` usage mapped {input: input_tokens - cached_input_tokens, cacheRead: cached_input_tokens, cacheCreation: null, output: output_tokens} with the ORIGINAL usage payload digested raw (reasoning_output_tokens preserved in raw); claude = parseClaudeCliOutput anthropic four-field usage + served model; agy = unavailable final with provider {name: "antigravity"} and an explicit unavailableReason
- Host stdout passes through live (line-streamed, memory-bounded parse buffer keeps only the last usage-bearing event + result text); host exit code propagates; ledger failures never break the host run (seam never-throws contract)
- A parse miss (no turn.completed / no result usage) records an unavailable final with a reason, never a fabricated zero
- Core logic takes an injected runner (like providers/codex-cli.ts) so smokes run with fake hosts

## CHK-002: M1: Bind reviewer/quorum context into host-run usage rows

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/host-run.ts, packages/main/src/handlers/host-run.ts
- Test: packages/main/src/tasks/host-run-usage-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/host-run-usage-smoke.js` binding checks pass

**DoneWhen**:
- Optional --reviewRunId and --lane args flow into the existing schema fields: threadId = reviewRunId (e.g. "B-70e9:RR-001"), subagentId = lane (e.g. "lattice-review-quality"); convention documented in the new doc page (CHK-004) so ledger rows join against review-runs.json / readManifest-bearing review passes
- When --storyId is given without --phase, phase resolves from the story index at call time (attribution captured at preflight, per the execution plan)

## CHK-003: M1: Cover remaining lattice-initiated host spawns

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/autopilot-executor.ts, packages/main/src/handlers/review-escalation.ts (probe call site; adjust if probeCanonicalHost lives in core/review-escalation.ts), packages/main/src/handlers/cross-host-review.ts (or the codex-review-leaf call site)
- Test: packages/main/src/tasks/host-run-usage-smoke.ts (seam checks with injected runners)

**Verify**:
- `node packages/main/dist/tasks/host-run-usage-smoke.js` coverage checks pass
- Existing smokes stay green: `npm --prefix packages/main run build` + targeted autopilot/cross-host smokes if present

**DoneWhen**:
- autopilot runClaudeRepair records preflight + final rows (agentType "autopilot-repair", storyId from the plan, phase = plan target phase); when the ledger is enabled the repair launcher adds `--output-format json` and the excerpt comes from the parsed envelope result; ledger OFF stays byte-identical to today
- host readiness probes (review_host_availability_probe / host_runtime_probe call sites) record preflight + final rows per host with agentType "host-readiness-probe" (claude probe parses envelope usage; codex probe parses turn.completed when --json is in the probe argv, else unavailable; agy unavailable)
- cross_host_review codex leaf records preflight + unavailable final (argv unchanged: `codex exec -s read-only` has no JSON event stream; unavailableReason documents that) so the run is at least visible in the ledger
- No new imports INTO core/usage-ledger; all wiring happens at the callers

## CHK-004: M1: Update launch guidance to route through the choke point

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: docs/host-run-usage.md
- Modify: packages/main/src/handlers/reviewer-batch.ts (printed launch instructions), packages/main/src/handlers/review-escalation.ts (quorum/escalation guidance strings where they name raw host commands), CHANGELOG.md
- Test: none (guidance strings; smoke asserts reviewer_batch output mentions host_run where applicable)

**Verify**:
- `rg "codex exec" packages/main/src/handlers | rg -v host_run` shows no remaining raw-launch INSTRUCTION strings (spawn sites themselves excluded)
- reviewer_batch output naming check in smoke

**DoneWhen**:
- Every operator-facing instruction that previously said to run raw `codex exec` / `claude --print` / `agy --print` for lattice-initiated reviewer/quorum host runs now names `lattice host_run` with the binding args (storyId/agentType/reviewRunId/lane)
- docs/host-run-usage.md documents: command usage, binding conventions (threadId=reviewRunId, subagentId=lane), cap envs, agy unavailable semantics, and the non-goals (no gate evidence, desktop sessions out of reach)

## CHK-005: M2: Read-only usage_sweep command

**Owner**: lattice-implementer
**DependsOn**: none (parallel to M1)
**Files**:
- Create: packages/main/src/core/usage-sweep.ts, packages/main/src/handlers/usage-sweep.ts
- Modify: packages/main/src/cli/command-catalog.ts
- Test: packages/main/src/tasks/usage-sweep-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/usage-sweep-smoke.js` all checks pass
- `node bin/lattice.js usage_sweep --since 2026-07-01 --json` runs read-only against real stores (manual TEST-phase acceptance)

**DoneWhen**:
- Scans `~/.codex/sessions/**/rollout-*.jsonl` (dir override via --codexSessionsDir): first-line session_meta gives cwd/originator/source/id; per-session totals = LAST non-null cumulative info.total_token_usage (input includes cached; report both); story mentions via /B-[0-9a-f]{4}/i scan; mtime >= cutoff filter before reading
- Scans `~/.claude/projects/*/*.jsonl` (override via --claudeProjectsDir): four-field message.usage summed with dedupe by (requestId ?? message.id) keeping the last value per id; cwd from records; sessionId from filename
- Streams line-by-line (no whole-file buffering; desktop rollouts can be hundreds of MB)
- Report (human table + --json): per-session host, sessionId, cwd, originator (desktop vs exec vs claude-code), first/last timestamps, token totals, story mentions, and an origin label distinguishing lattice-launched-plausible from foreign; header states NON-AUTHORITATIVE ESTIMATE prominently in both modes
- Strictly read-only: no writes anywhere (no report files unless --out is explicitly passed; --out refuses paths outside the project)

## CHK-006: Smokes, npm scripts, docs

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-005
**Files**:
- Create: packages/main/src/tasks/host-run-usage-smoke.ts, packages/main/src/tasks/usage-sweep-smoke.ts (created in CHK-001/005; this item wires and finishes them)
- Modify: packages/main/package.json, package.json (test:host-run-usage, test:usage-sweep), packages/main/src/tasks/run-all-smokes.ts (if that is the aggregate pattern), CHANGELOG.md
- Test: the two smokes themselves

**Verify**:
- `npm --prefix packages/main run test:host-run-usage` and `npm --prefix packages/main run test:usage-sweep` (or root-level equivalents) pass
- Full `lattice validate` green before REVIEW

**DoneWhen**:
- Fixtures cover: codex turn.completed usage (plus turn.failed with no usage -> unavailable), claude stream-json result envelope (including split assistant events sharing message.id for the sweep dedupe), agy no-usage output, codex rollout with cumulative token_count lines and null-info lines, claude project transcript
- Smoke asserts row shape: correlation (ledgerCallId/attemptId/sequence/supersedes), attribution binding, provider mapping values, blocked rows for both caps

## CHK-007: M1: Per-dispatch budget cap + host-run concurrency cap (T2)

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/host-run.ts, packages/main/src/handlers/host-run.ts, docs/host-run-usage.md
- Test: packages/main/src/tasks/host-run-usage-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/host-run-usage-smoke.js` cap checks pass

**DoneWhen**:
- Budget cap: reuse shouldBlockDispatch/recordBudgetBlock (LATTICE_HARD_BUDGET_TOKENS) so an over-budget preflight estimate refuses BEFORE spawn with decision.kind=blocked row (existing reasonCode hard_budget_exceeded)
- Concurrency cap: slot registry under .lattice/usage/host-run-slots/ (one file per live run: pid + startedAt); acquiring beyond LATTICE_HOST_RUN_MAX_CONCURRENT (default 4; 0/unset-invalid falls back to default; explicit large value allowed) refuses fail-closed with exit != 0, prints the live-run list, and writes a blocked ledger row (decision.kind=blocked, reasonCode concurrency_cap_exceeded); slots with dead pids or stale mtime are reclaimed automatically; slot release on exit is best-effort with staleness as the backstop
- Both caps are diagnostics-honest: every refusal is a ledger row; no queuing in this story (documented)

## Execution order

CHK-001 -> CHK-002 -> CHK-007 -> CHK-003 -> CHK-005 -> CHK-006 -> CHK-004
(M2 CHK-005 may proceed in parallel after CHK-001 lands; CHK-004 last so guidance
names the final command shape.)
