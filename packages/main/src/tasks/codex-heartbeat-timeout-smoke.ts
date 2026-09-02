#!/usr/bin/env node
/**
 * Regression smoke for the global-fallback heartbeat timeout (B-cdf6 / B-META F-013).
 *
 * The defect: `verify_codex`'s "Global fallback heartbeat" check ran the real installed
 * `session_brief` under a FIXED 30s budget. `session_brief` aggregates every active story
 * before writing its heartbeat, so on a large repository (319 active story entries here,
 * ~101s) it was always killed — and the kill was reported as
 * `heartbeat command failed: [0.1s] running session_brief...`, i.e. the truncated stderr
 * progress line of the killed process presented as if it were the cause. That reads as an
 * adapter/brand defect and sent three debugging attempts hunting the wrong thing, while
 * the underlying entrypoint was perfectly healthy. `verify_codex` also exposed no way to
 * raise the budget, so there was no honest way to pass the check on a large repo.
 *
 * What this smoke pins:
 *  1. TIMEOUT IS DISTINCT: a heartbeat killed by the budget reports
 *     `[heartbeat_command_timeout]`, names the armed budget, and must NOT be reported as
 *     the generic `heartbeat command failed`.
 *  2. STILL FAILS WHEN GENUINELY BROKEN (negative test): a global fallback that exits
 *     non-zero, or that runs fine but records no/incorrect activity, still FAILS. The
 *     timeout branch must not become a blanket amnesty.
 *  3. BOUNDED + ATTRIBUTED OVERRIDE: above the cap is REFUSED (never clamped), a short or
 *     missing reason is refused, and a reason without a budget is refused — enforced by
 *     the runtime resolver, i.e. on Zod-BYPASSING paths too (Handler 编码约定).
 *  4. DEFAULT PATH UNCHANGED: with no override the resolved budget is exactly the
 *     pre-F-013 default.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CODEX_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS,
  GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS,
  HEARTBEAT_TIMEOUT_REASON_MIN_CHARS,
  resolveGlobalFallbackHeartbeatTimeoutMs,
  runCodexAdapterChecks,
} from '../core/codex-adapter-checks.js';

const PASS_LINE =
  '✓ codex heartbeat timeout smoke passed: timeout reported distinctly; broken fallback still fails; override bounded + attributed';

const LONG_REASON =
  'This repository has 319 active story entries so session_brief aggregation needs far longer than the default.';

assert.ok(
  LONG_REASON.trim().length >= HEARTBEAT_TIMEOUT_REASON_MIN_CHARS,
  'fixture reason must clear the minimum bar',
);

// ---------------------------------------------------------------------------
// (4) Default path is unchanged: no override => exactly the pre-F-013 default.
// ---------------------------------------------------------------------------
{
  const noOverride = resolveGlobalFallbackHeartbeatTimeoutMs();
  assert.equal(noOverride.timeoutMs, DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS);
  assert.equal(noOverride.override, undefined, 'no override block when nothing was raised');

  const emptyOverride = resolveGlobalFallbackHeartbeatTimeoutMs({});
  assert.equal(emptyOverride.timeoutMs, DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS);
  assert.equal(emptyOverride.override, undefined);

  // The legacy single `timeoutMs` knob still wins when no explicit override is given,
  // so existing callers (scripts/verify-codex-assets.mjs) keep their behaviour.
  const legacy = resolveGlobalFallbackHeartbeatTimeoutMs(undefined, 1234);
  assert.equal(legacy.timeoutMs, 1234);
  assert.equal(legacy.override, undefined);

  // The global budget must stay strictly larger than the deliberately conservative local
  // wrapper probe: raising one must never be a way to loosen the other.
  assert.ok(DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS > DEFAULT_CODEX_HEARTBEAT_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// (3) Bounded + attributed override, enforced on Zod-BYPASSING paths.
// These calls go straight at the core resolver, exactly as an internal fn call or a
// stale JSON payload would — no Zod schema is involved anywhere below.
// ---------------------------------------------------------------------------
{
  // Accepted: at the cap boundary (inclusive) with a sufficient reason.
  const atCap = resolveGlobalFallbackHeartbeatTimeoutMs({
    timeoutMs: GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS,
    reason: LONG_REASON,
  });
  assert.equal(atCap.timeoutMs, GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS);
  assert.equal(atCap.override?.timeoutMs, GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS);
  assert.equal(atCap.override?.reason, LONG_REASON.trim());

  // REFUSED above the cap — and specifically NOT clamped down to the cap.
  assert.throws(
    () => resolveGlobalFallbackHeartbeatTimeoutMs({
      timeoutMs: GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS + 1,
      reason: LONG_REASON,
    }),
    /heartbeat_timeout_above_cap/,
    'above-cap budget must be refused',
  );

  // A short / whitespace-only reason is refused (trim-aware, like the F-012 bar).
  for (const badReason of ['', '   ', 'too short', ' '.repeat(80)]) {
    assert.throws(
      () => resolveGlobalFallbackHeartbeatTimeoutMs({ timeoutMs: 60_000, reason: badReason }),
      /heartbeat_timeout_reason_too_short/,
      `reason ${JSON.stringify(badReason)} must be refused`,
    );
  }
  assert.throws(
    () => resolveGlobalFallbackHeartbeatTimeoutMs({ timeoutMs: 60_000 }),
    /heartbeat_timeout_reason_too_short/,
    'a raised budget with no reason at all must be refused',
  );

  // A reason with no budget is refused rather than silently ignored: accepting it would
  // let an operator believe a budget was armed when nothing was raised.
  assert.throws(
    () => resolveGlobalFallbackHeartbeatTimeoutMs({ reason: LONG_REASON }),
    /heartbeat_timeout_reason_without_override/,
    'reason without a budget must be refused',
  );

  // Non-integer / non-positive / non-finite values are refused, not coerced.
  for (const badTimeout of [0, -1, -60_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveGlobalFallbackHeartbeatTimeoutMs({ timeoutMs: badTimeout, reason: LONG_REASON }),
      /heartbeat_timeout_invalid|heartbeat_timeout_above_cap/,
      `timeoutMs ${String(badTimeout)} must be refused`,
    );
  }
  // A string that a JSON payload might carry is refused too (no implicit coercion).
  assert.throws(
    () => resolveGlobalFallbackHeartbeatTimeoutMs({ timeoutMs: '60000' as unknown as number, reason: LONG_REASON }),
    /heartbeat_timeout_invalid/,
    'string timeoutMs must be refused',
  );
}

// ---------------------------------------------------------------------------
// (1) + (2) Behavioural checks against a FAKE global CLI on PATH.
//
// A fake `proof-or-stop` on PATH lets us drive the real runCodexAdapterChecks heartbeat
// path deterministically: one variant sleeps past the budget (timeout), one exits
// non-zero (genuinely broken), one succeeds but records no activity (broken in a
// different way). We import the module fresh per scenario because PATH is read at call
// time; a small fixture project supplies the adapter assets the earlier checks need.
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  /** Body of the fake global CLI shell script. */
  script: string;
  timeoutMs?: number;
  reason?: string;
  /** Assert on the resulting global-fallback-heartbeat check detail. */
  assertDetail: (detail: string, status: string) => void;
}

function writeFakeGlobalCli(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  for (const bin of ['proof-or-stop', 'proof-or-stop']) {
    const path = join(dir, bin);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf-8');
    chmodSync(path, 0o755);
  }
}

const scenarios: Scenario[] = [
  {
    name: 'killed by the budget => distinct timeout, never a generic failure',
    // Sleeps well past the tiny budget below, printing the same kind of progress line the
    // real CLI prints. Under the old code this exact stderr text became the failure
    // reason; now it must be reported as a timeout naming the budget.
    script: 'echo "[0.1s] running session_brief..." >&2; sleep 30',
    timeoutMs: 1_000,
    reason: LONG_REASON,
    assertDetail: (detail, status) => {
      assert.equal(status, 'fail', 'a killed heartbeat is still a failure');
      assert.match(detail, /\[heartbeat_command_timeout\]/, 'must use the distinct timeout code');
      assert.match(detail, /armed budget of 1000ms/, 'must name the armed budget');
      assert.doesNotMatch(
        detail,
        /heartbeat command failed/,
        'a timeout must NOT be reported as a generic command failure (the F-013 misdiagnosis)',
      );
      assert.match(detail, /--heartbeatTimeoutMs=/, 'must state the remedy');
    },
  },
  {
    name: 'genuinely broken fallback (non-zero exit) still FAILS',
    script: 'echo "boom: global fallback is broken" >&2; exit 3',
    assertDetail: (detail, status) => {
      assert.equal(status, 'fail', 'a broken global fallback must still fail');
      assert.match(detail, /heartbeat command failed/, 'a real error keeps the generic failure text');
      assert.doesNotMatch(
        detail,
        /heartbeat_command_timeout/,
        'a non-timeout error must not be relabelled as a timeout',
      );
    },
  },
  {
    name: 'fallback that records no activity still FAILS',
    // Exits 0 immediately but writes no activity row: the check must not pass just
    // because the process was quick and clean.
    script: 'exit 0',
    assertDetail: (detail, status) => {
      assert.equal(status, 'fail', 'no recorded heartbeat must still fail');
      assert.match(detail, /no activity heartbeat with the expected entrypoint/);
    },
  },
];

function makeFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-heartbeat-timeout-smoke-'));
  // Minimal adapter surface: the heartbeat check we exercise runs regardless of the
  // earlier asset checks' verdicts, and we only assert on the heartbeat check itself.
  mkdirSync(join(dir, '.proof-or-stop'), { recursive: true });
  writeFileSync(join(dir, '.proof-or-stop', 'activity.jsonl'), '', 'utf-8');
  return dir;
}

const previousPath = process.env.PATH;
const previousHome = process.env.HOME;
const createdDirs: string[] = [];
try {
  // HOME is isolated as a second line of defence against a real user-local shim.
  // The production PATH probe intentionally uses a non-login shell so this fixture's
  // fake CLI remains the command under test.
  const isolatedHome = mkdtempSync(join(tmpdir(), 'codex-heartbeat-isolated-home-'));
  createdDirs.push(isolatedHome);
  process.env.HOME = isolatedHome;

  for (const scenario of scenarios) {
    const fakeBin = mkdtempSync(join(tmpdir(), 'codex-heartbeat-fake-bin-'));
    const projectDir = makeFixtureProject();
    createdDirs.push(fakeBin, projectDir);
    writeFakeGlobalCli(fakeBin, scenario.script);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    // A single statically imported module is fine: the heartbeat resolves the global CLI
    // from PATH on every call, so each scenario's PATH takes effect without reloading.
    const result = runCodexAdapterChecks(projectDir, {
      executeGlobalHeartbeat: true,
      executeLocalHeartbeat: false,
      heartbeatTimeoutMs: scenario.timeoutMs,
      heartbeatTimeoutReason: scenario.reason,
    });

    const check = result.checks.find(c => c.id === 'global-fallback-heartbeat');
    assert.ok(check, `${scenario.name}: global-fallback-heartbeat check must be present`);
    try {
      scenario.assertDetail(String(check.detail || ''), String(check.status));
    } catch (e) {
      console.error(`scenario failed: ${scenario.name}\ndetail: ${check.detail}`);
      throw e;
    }
    assert.equal(result.ok, false, `${scenario.name}: a hard heartbeat failure must fail the whole result`);
  }
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The CLI surface must actually expose the override, otherwise an operator on a large
// repo still has no honest way to pass the check (the original F-013 complaint).
// ---------------------------------------------------------------------------
{
  const help = execFileSync(process.execPath, ['bin/proof-or-stop.js', 'verify_codex', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.match(help, /--heartbeatTimeoutMs/, 'verify_codex --help must advertise the budget override');
  assert.match(help, /--heartbeatTimeoutReason/, 'verify_codex --help must advertise the required reason');
}

console.log(PASS_LINE);
