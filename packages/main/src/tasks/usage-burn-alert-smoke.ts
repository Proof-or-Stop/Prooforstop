#!/usr/bin/env node
/**
 * B-623a: fixture-driven smoke for push-based host burn detection.
 *
 * Everything runs against OS temp fixture dirs (never the real ~/.codex or
 * ~/.claude stores). Covers the CHK-001..CHK-005 verificationIntent:
 *   - resolver defaults + per-variable env overrides + garbage/negative/empty
 *     env fallback (RECENT_HOURS=0 is the explicit disable switch);
 *   - evaluator boundaries: exactly-at-threshold NOT flagged, just-over
 *     flagged, per-reason isolation, null-usage / unparseable-firstTimestamp
 *     never flag their reasons, codex vs claude burn-token formula,
 *     deterministic ordering;
 *   - doctor section: flagged fixture prints the prominent warning naming
 *     file/cwd/tokens; clean scan prints the ✓ line; RECENT_HOURS=0 prints
 *     disabled and skips scanning; JSON hostBurnScan is advisory-only
 *     (advisory=true, gateEvidence=false); plain doctor exits 0 even when
 *     sessions are flagged (advisory contract);
 *   - usage_sweep --alert via the REAL built CLI: flagged fixture exits
 *     non-zero AND still prints the full report; clean fixture exits 0;
 *     flagged fixture WITHOUT --alert exits 0 (opt-in only);
 *   - ZERO WRITES to the store dirs across doctor burn scan + --alert sweep;
 *   - read-only classification: {alert:true} stays readOnly on the ownership
 *     gate and the activity/hook layer (no accidental write escalation).
 *
 * Prints per-check lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BURN_ALERT_ENV,
  DEFAULT_BURN_ALERT_THRESHOLDS,
  burnInputTokensOf,
  evaluateBurnAlerts,
  renderHostBurnScan,
  renderSweepAlertSection,
  resolveBurnAlertThresholds,
  type BurnAlertThresholds,
} from '../core/usage-burn-alert.js';
import { sweepCodexSessions, type SweepSessionRow } from '../core/usage-sweep.js';
import { StoryStore } from '../core/store.js';
import { createDoctorHandlers } from '../handlers/doctor.js';
import {
  createUsageSweepHandlers,
  dispatchUsageSweepAlertWithExit,
  type UsageSweepAlertResult,
} from '../handlers/usage-sweep.js';
import type { HandlerContext } from '../handlers/context.js';
import { resolveEffectiveOwnershipClass } from '../cli/ownership-gate.js';
import { isReadOnlyCommand, shouldWriteActivityLog } from '../cli/activity-policy.js';

let passed = 0;
const failures: string[] = [];

async function checkAsync(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

const root = mkdtempSync(join(tmpdir(), 'usage-burn-alert-smoke-'));

// Real clock for the end-to-end fixtures (doctor/CLI resolve their own now);
// fixture timestamps are derived RELATIVE to it so age semantics are stable.
const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');

/** Env keys this smoke mutates; saved/restored around every check. */
const ENV_KEYS = [
  BURN_ALERT_ENV.fileMb,
  BURN_ALERT_ENV.inputTokens,
  BURN_ALERT_ENV.ageDays,
  BURN_ALERT_ENV.recentHours,
  BURN_ALERT_ENV.codexDir,
  BURN_ALERT_ENV.claudeDir,
] as const;

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Await INSIDE the try so the env stays applied across every await in fn
    // (a sync restore here would race the async doctor/sweep calls).
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeJsonl(file: string, lines: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function codexRollout(opts: {
  id: string;
  cwd: string;
  firstTs: string;
  inputTokens: number | null;
  pad?: number;
}): string[] {
  const lines = [
    JSON.stringify({
      timestamp: opts.firstTs,
      type: 'session_meta',
      payload: { id: opts.id, cwd: opts.cwd, originator: 'Codex Desktop', source: 'desktop' },
    }),
  ];
  if (opts.inputTokens !== null) {
    lines.push(
      JSON.stringify({
        timestamp: iso(NOW - 60_000),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: opts.inputTokens,
              cached_input_tokens: Math.max(0, opts.inputTokens - 1000),
              output_tokens: 500,
              reasoning_output_tokens: 100,
              total_tokens: opts.inputTokens + 500,
            },
          },
        },
      }),
    );
  }
  if (opts.pad && opts.pad > 0) {
    lines.push(JSON.stringify({ timestamp: iso(NOW - 30_000), type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(opts.pad) } }));
  }
  return lines;
}

/** Synthetic row builder for pure evaluator checks (no filesystem needed). */
function row(over: Partial<SweepSessionRow> & { host: SweepSessionRow['host'] }): SweepSessionRow {
  return {
    sessionId: 'synthetic',
    file: '/nonexistent/synthetic.jsonl',
    cwd: '/tmp/synth',
    originator: 'synthetic',
    originLabel: over.host === 'codex' ? 'codex-desktop' : 'claude-code',
    latticeCwd: false,
    firstTimestamp: iso(NOW - 60_000),
    lastTimestamp: iso(NOW),
    usage: null,
    storyMentions: [],
    parseErrors: 0,
    ...over,
  };
}

function codexUsage(inputTokens: number) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    uncachedInputTokens: inputTokens,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

/** Recursive {path -> "mtimeMs:size"} snapshot for the zero-writes assertion. */
function snapshotDir(dir: string): Map<string, string> {
  const snap = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const st = statSync(full);
        snap.set(full, `${st.mtimeMs}:${st.size}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return snap;
}

function makeCtx(subdir: string): HandlerContext {
  const projectRoot = join(root, subdir);
  mkdirSync(projectRoot, { recursive: true });
  const store = new StoryStore(projectRoot);
  return { store, root: projectRoot, scanRoot: join(projectRoot, 'packages/main') };
}

const T: BurnAlertThresholds = { fileBytes: 1000, inputTokens: 1000, ageDays: 7, recentHours: 48 };

async function main(): Promise<void> {
  // ── Fixture stores ──────────────────────────────────────────────────────────
  const codexDir = join(root, 'codex-sessions');
  const claudeDir = join(root, 'claude-projects');
  const emptyCodexDir = join(root, 'codex-empty');
  const emptyClaudeDir = join(root, 'claude-empty');
  mkdirSync(emptyCodexDir, { recursive: true });
  mkdirSync(emptyClaudeDir, { recursive: true });

  // HOT: 150M cumulative input, first activity 10 days ago, recent mtime →
  // trips input-tokens (default 100M) AND session-age (default 7d).
  writeJsonl(
    join(codexDir, '2026', '07', '02', 'rollout-hot.jsonl'),
    codexRollout({ id: 'codex-burn-A', cwd: '/tmp/burning-desktop-thread', firstTs: iso(NOW - 10 * DAY), inputTokens: 150_000_000 }),
  );
  // OK: small and young → no flags.
  writeJsonl(
    join(codexDir, '2026', '07', '12', 'rollout-ok.jsonl'),
    codexRollout({ id: 'codex-ok-B', cwd: '/tmp/fine', firstTs: iso(NOW - 60_000), inputTokens: 5_000 }),
  );
  // MEGA: young session with a BIGGER burn than HOT (250M) — flagged on
  // input-tokens only. It sorts FIRST (burn desc), so any check that must find
  // codex-burn-A's warning block is forced to actually locate it instead of
  // grabbing the first flagged block (kills the F-004 sort-order coincidence).
  writeJsonl(
    join(codexDir, '2026', '07', '12', 'rollout-mega.jsonl'),
    codexRollout({ id: 'codex-mega-M', cwd: '/tmp/mega-young-burner', firstTs: iso(NOW - 60_000), inputTokens: 250_000_000 }),
  );
  // AT: exactly at the default 100M threshold → NOT flagged (strictly greater).
  writeJsonl(
    join(codexDir, '2026', '07', '12', 'rollout-at.jsonl'),
    codexRollout({ id: 'codex-at-C', cwd: '/tmp/at-threshold', firstTs: iso(NOW - 60_000), inputTokens: 100_000_000 }),
  );
  // OLD-MTIME: over-threshold usage but mtime pushed outside the scan window →
  // must not even be scanned by the doctor window.
  const oldFile = join(codexDir, '2026', '01', '01', 'rollout-oldmtime.jsonl');
  writeJsonl(oldFile, codexRollout({ id: 'codex-old-D', cwd: '/tmp/old', firstTs: iso(NOW - 180 * DAY), inputTokens: 900_000_000 }));
  const oldSec = (NOW - 30 * DAY) / 1000;
  utimesSync(oldFile, oldSec, oldSec);

  // Claude CACHE-HEAVY: input 1k but cacheRead 120M → burn tokens over 100M.
  writeJsonl(join(claudeDir, 'proj-x', 'claude-cache-heavy.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: iso(NOW - 120_000), cwd: '/tmp/claude-cache-heavy', requestId: 'req_1', message: { id: 'msg_1', usage: { input_tokens: 1_000, cache_creation_input_tokens: 500, cache_read_input_tokens: 120_000_000, output_tokens: 10 } } }),
  ]);

  // ── 1. resolver defaults ────────────────────────────────────────────────────
  await checkAsync('resolver: empty env yields the documented defaults (100MB/100M/7d/48h)', () => {
    const t = resolveBurnAlertThresholds({});
    assert.deepEqual(t, DEFAULT_BURN_ALERT_THRESHOLDS, 'defaults object');
    assert.equal(t.fileBytes, 100 * 1024 * 1024, '100MB in bytes');
    assert.equal(t.inputTokens, 100_000_000, '100M tokens');
    assert.equal(t.ageDays, 7, '7 days');
    assert.equal(t.recentHours, 48, '48h window');
  });

  // ── 2. resolver overrides ───────────────────────────────────────────────────
  await checkAsync('resolver: each env variable overrides its threshold; RECENT_HOURS=0 disables', () => {
    const t = resolveBurnAlertThresholds({
      [BURN_ALERT_ENV.fileMb]: '1',
      [BURN_ALERT_ENV.inputTokens]: '50000000',
      [BURN_ALERT_ENV.ageDays]: '3',
      [BURN_ALERT_ENV.recentHours]: '0',
    });
    assert.equal(t.fileBytes, 1024 * 1024, 'FILE_MB=1 → 1MiB');
    assert.equal(t.inputTokens, 50_000_000, 'INPUT_TOKENS=50000000');
    assert.equal(
      resolveBurnAlertThresholds({ [BURN_ALERT_ENV.inputTokens]: '500000' }).inputTokens,
      500_000,
      'INPUT_TOKENS=500000 applies alone (CHK-002:happy:2 literal)',
    );
    assert.equal(t.ageDays, 3, 'AGE_DAYS=3');
    assert.equal(t.recentHours, 0, 'RECENT_HOURS=0 is accepted (disable switch)');
    const frac = resolveBurnAlertThresholds({ [BURN_ALERT_ENV.fileMb]: '0.001' });
    assert.equal(frac.fileBytes, Math.round(0.001 * 1024 * 1024), 'fractional MB supported');
  });

  // ── 3. resolver garbage fallback ────────────────────────────────────────────
  await checkAsync('resolver: garbage / negative / empty / zero-where-meaningless env falls back per-variable', () => {
    const t = resolveBurnAlertThresholds({
      [BURN_ALERT_ENV.fileMb]: 'abc',
      [BURN_ALERT_ENV.inputTokens]: '-5',
      [BURN_ALERT_ENV.ageDays]: '   ',
      [BURN_ALERT_ENV.recentHours]: 'Infinity',
    });
    assert.deepEqual(t, DEFAULT_BURN_ALERT_THRESHOLDS, 'all four fall back');
    const zero = resolveBurnAlertThresholds({ [BURN_ALERT_ENV.inputTokens]: '0', [BURN_ALERT_ENV.fileMb]: '0', [BURN_ALERT_ENV.ageDays]: '0' });
    assert.deepEqual(zero, DEFAULT_BURN_ALERT_THRESHOLDS, 'zero is meaningless for file/tokens/age → fallback');
    const mixed = resolveBurnAlertThresholds({ [BURN_ALERT_ENV.inputTokens]: 'NaN', [BURN_ALERT_ENV.ageDays]: '14' });
    assert.equal(mixed.inputTokens, DEFAULT_BURN_ALERT_THRESHOLDS.inputTokens, 'NaN falls back');
    assert.equal(mixed.ageDays, 14, 'valid neighbor still applies');
  });

  // ── 4. evaluator boundaries (pure; injected file sizes) ─────────────────────
  await checkAsync('evaluator: at-threshold not flagged; just-over flagged; per-reason isolation', () => {
    const nowMs = NOW;
    const sizeOf = (size: number | null) => (_file: string) => size;
    // file-size: at vs over (usage/timestamps kept under thresholds).
    const young = iso(nowMs - 1000);
    const atFile = evaluateBurnAlerts([row({ host: 'codex', sessionId: 's1', firstTimestamp: young })], { nowMs, thresholds: T, fileSizeOf: sizeOf(1000) });
    assert.equal(atFile.findings.length, 0, 'file size == threshold → not flagged');
    const overFile = evaluateBurnAlerts([row({ host: 'codex', sessionId: 's1', firstTimestamp: young })], { nowMs, thresholds: T, fileSizeOf: sizeOf(1001) });
    assert.deepEqual(overFile.findings[0]?.reasons, ['file-size'], 'file size threshold+1 → flagged on file-size only');
    // input-tokens: at vs over.
    const atTok = evaluateBurnAlerts([row({ host: 'codex', sessionId: 's2', firstTimestamp: young, usage: codexUsage(1000) })], { nowMs, thresholds: T, fileSizeOf: sizeOf(0) });
    assert.equal(atTok.findings.length, 0, 'tokens == threshold → not flagged');
    const overTok = evaluateBurnAlerts([row({ host: 'codex', sessionId: 's2', firstTimestamp: young, usage: codexUsage(1001) })], { nowMs, thresholds: T, fileSizeOf: sizeOf(0) });
    assert.deepEqual(overTok.findings[0]?.reasons, ['input-tokens'], 'tokens threshold+1 → flagged on input-tokens only');
    // session-age: at vs over (7 days exactly vs just over).
    const atAge = evaluateBurnAlerts([row({ host: 'codex', sessionId: 's3', firstTimestamp: iso(nowMs - 7 * DAY) })], { nowMs, thresholds: T, fileSizeOf: sizeOf(0) });
    assert.equal(atAge.findings.length, 0, 'age == threshold → not flagged');
    const overAge = evaluateBurnAlerts([row({ host: 'codex', sessionId: 's3', firstTimestamp: iso(nowMs - 7 * DAY - 1000) })], { nowMs, thresholds: T, fileSizeOf: sizeOf(0) });
    assert.deepEqual(overAge.findings[0]?.reasons, ['session-age'], 'age just over threshold → flagged on session-age only');
    assert.equal(overAge.findings[0]?.ageDays, 7, 'ageDays floors to whole days');
    // advisory markers always present.
    assert.equal(overAge.advisory, true, 'evaluation is advisory');
    assert.equal(overAge.gateEvidence, false, 'evaluation is never gate evidence');
  });

  await checkAsync('evaluator: null usage / unparseable firstTimestamp / unreadable file never flag their reasons', () => {
    const nowMs = NOW;
    const clean = evaluateBurnAlerts(
      [row({ host: 'codex', sessionId: 'u1', usage: null, firstTimestamp: 'not-a-date' })],
      { nowMs, thresholds: T, fileSizeOf: () => null },
    );
    assert.equal(clean.findings.length, 0, 'unknown usage + bad timestamp + unreadable file → no flags at all');
    assert.equal(clean.scanned, 1, 'row still counted as scanned');
    // missing firstTimestamp likewise.
    const noTs = evaluateBurnAlerts([row({ host: 'codex', sessionId: 'u2', firstTimestamp: null })], { nowMs, thresholds: T, fileSizeOf: () => 0 });
    assert.equal(noTs.findings.length, 0, 'null firstTimestamp → session-age never flagged');
    // F-003 (CHK-001:edge:3): zero-usage sessions are never flagged for input-tokens.
    const zeros = evaluateBurnAlerts(
      [
        row({ host: 'codex', sessionId: 'z1', firstTimestamp: iso(nowMs - 1000), usage: codexUsage(0) }),
        row({ host: 'claude', sessionId: 'z2', firstTimestamp: iso(nowMs - 1000), usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } }),
      ],
      { nowMs, thresholds: T, fileSizeOf: () => 0 },
    );
    assert.equal(zeros.findings.length, 0, 'codex inputTokens=0 and claude all-zero usage never flag input-tokens');
  });

  await checkAsync('evaluator: codex vs claude burn-token formula + deterministic ordering', () => {
    const codexRow = row({ host: 'codex', sessionId: 'c1', usage: codexUsage(5000) });
    assert.equal(burnInputTokensOf(codexRow), 5000, 'codex burn = cumulative input (includes cached)');
    const claudeRow = row({ host: 'claude', sessionId: 'a1', usage: { inputTokens: 100, cacheCreationInputTokens: 200, cacheReadInputTokens: 4000, outputTokens: 999 } });
    assert.equal(burnInputTokensOf(claudeRow), 4300, 'claude burn = input + cacheRead + cacheCreation (output excluded)');
    assert.equal(burnInputTokensOf(row({ host: 'codex', sessionId: 'c2', usage: null })), null, 'unknown usage → null');
    // Ordering: burn tokens desc, then sessionId asc; null-usage (file-size-only) findings last.
    const nowMs = NOW;
    const young = iso(nowMs - 1000);
    const rows = [
      row({ host: 'claude', sessionId: 'bbb', firstTimestamp: young, usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 2000, outputTokens: 0 } }),
      row({ host: 'codex', sessionId: 'aaa', firstTimestamp: young, usage: codexUsage(2000) }),
      row({ host: 'codex', sessionId: 'zzz', firstTimestamp: young, usage: codexUsage(9000) }),
      row({ host: 'codex', sessionId: 'nul', firstTimestamp: young, usage: null }),
    ];
    const ev = evaluateBurnAlerts(rows, { nowMs, thresholds: T, fileSizeOf: () => 5000 });
    assert.deepEqual(
      ev.findings.map((f) => f.sessionId),
      ['zzz', 'aaa', 'bbb', 'nul'],
      'sorted by burn tokens desc, ties by sessionId asc, unknown-usage last',
    );
    // F-C (codex post-merge quorum r1): unknown usage must sort last even
    // against NEGATIVE usage (null was previously coded as -1, so -5 sorted
    // below it), and Infinity ties must still fall through to the sessionId
    // tie-break (subtraction gave NaN and bypassed it).
    const edgeRows = [
      row({ host: 'codex', sessionId: 'neg', firstTimestamp: young, usage: codexUsage(-5) }),
      row({ host: 'codex', sessionId: 'unknown', firstTimestamp: young, usage: null }),
      row({ host: 'codex', sessionId: 'inf-b', firstTimestamp: young, usage: codexUsage(Number.POSITIVE_INFINITY) }),
      row({ host: 'codex', sessionId: 'inf-a', firstTimestamp: young, usage: codexUsage(Number.POSITIVE_INFINITY) }),
    ];
    const edge = evaluateBurnAlerts(edgeRows, { nowMs, thresholds: T, fileSizeOf: () => 5000 });
    assert.deepEqual(
      edge.findings.map((f) => f.sessionId),
      ['inf-a', 'inf-b', 'neg', 'unknown'],
      'Infinity ties break by sessionId; negative usage sorts above unknown; unknown is unconditionally last',
    );
  });

  // ── 5. scanners + evaluator integration over the fixture store ─────────────
  await checkAsync('integration: swept fixtures flag HOT (input-tokens + session-age), spare OK/AT, respect the mtime window', async () => {
    const nowMs = NOW;
    const sinceMs = nowMs - 48 * 3_600_000;
    const rows = await sweepCodexSessions({ dir: codexDir, sinceMs });
    assert.equal(rows.find((r) => r.sessionId === 'codex-old-D'), undefined, 'old-mtime rollout excluded by the window before reading');
    const ev = evaluateBurnAlerts(rows, { nowMs, thresholds: DEFAULT_BURN_ALERT_THRESHOLDS });
    const hot = ev.findings.find((f) => f.sessionId === 'codex-burn-A');
    assert.ok(hot, 'HOT session flagged');
    assert.deepEqual([...hot.reasons].sort(), ['input-tokens', 'session-age'], 'HOT trips input-tokens + session-age');
    assert.equal(hot.burnInputTokens, 150_000_000, 'cumulative tokens surfaced');
    assert.equal(hot.cwd, '/tmp/burning-desktop-thread', 'cwd surfaced');
    assert.equal(ev.findings.find((f) => f.sessionId === 'codex-ok-B'), undefined, 'OK session not flagged');
    assert.equal(ev.findings.find((f) => f.sessionId === 'codex-at-C'), undefined, 'AT-threshold session not flagged (strictly greater)');
  });

  // ── 6. doctor text + JSON (in-process handler, hermetic dirs) ───────────────
  await checkAsync('doctor: flagged store prints the prominent warning naming file/cwd/tokens; JSON is advisory-only', async () => {
    const ctx = makeCtx('doctor-flagged');
    const handlers = createDoctorHandlers(ctx);
    await withEnv(
      { [BURN_ALERT_ENV.codexDir]: codexDir, [BURN_ALERT_ENV.claudeDir]: claudeDir },
      async () => {
        const text = String(await handlers.doctor({ format: 'text' }));
        assert.ok(text.includes('Host burn scan (advisory):'), 'section header present');
        assert.ok(text.includes('✗ BURN ALERT codex codex-burn-A'), 'warning names host + session id');
        assert.ok(text.includes('rollout-hot.jsonl'), 'warning names the session file');
        assert.ok(text.includes('/tmp/burning-desktop-thread'), 'warning names the cwd');
        assert.ok(text.includes('~150_000_000'), 'warning names cumulative tokens');
        assert.ok(text.includes('input-tokens'), 'tripped thresholds listed');
        assert.ok(text.includes('claude claude-cache-heavy'), 'claude cache-heavy session flagged too');
        const json = (await handlers.doctor({ format: 'json' })) as Record<string, any>;
        assert.equal(json.hostBurnScan.advisory, true, 'JSON advisory=true');
        assert.equal(json.hostBurnScan.gateEvidence, false, 'JSON gateEvidence=false');
        assert.equal(json.hostBurnScan.disabled, false, 'scan ran');
        assert.equal(json.hostBurnScan.scanWindowHours, 48, 'scanWindowHours field carries the recent-activity window');
        assert.ok(json.hostBurnScan.findings.length >= 2, 'both flagged sessions in JSON');
      },
    );
  });

  await checkAsync('doctor: clean stores print the ✓ line; RECENT_HOURS=0 prints disabled and skips scanning', async () => {
    const ctx = makeCtx('doctor-clean');
    const handlers = createDoctorHandlers(ctx);
    await withEnv(
      { [BURN_ALERT_ENV.codexDir]: emptyCodexDir, [BURN_ALERT_ENV.claudeDir]: emptyClaudeDir },
      async () => {
        const text = String(await handlers.doctor({ format: 'text' }));
        assert.ok(text.includes('✓ no host sessions over burn thresholds'), 'clean line present');
      },
    );
    await withEnv(
      {
        [BURN_ALERT_ENV.recentHours]: '0',
        // Nonexistent dirs prove the disabled path never touches the stores.
        [BURN_ALERT_ENV.codexDir]: join(root, 'no-such-codex'),
        [BURN_ALERT_ENV.claudeDir]: join(root, 'no-such-claude'),
      },
      async () => {
        const text = String(await handlers.doctor({ format: 'text' }));
        assert.ok(text.includes('disabled'), 'disabled line present');
        assert.ok(!text.includes('BURN ALERT'), 'no warnings when disabled');
        const json = (await handlers.doctor({ format: 'json' })) as Record<string, any>;
        assert.equal(json.hostBurnScan.disabled, true, 'JSON reports disabled');
        assert.equal(json.hostBurnScan.scanned, 0, 'nothing scanned');
      },
    );
  });

  // ── 6b. F-002 (CHK-003:edge:4 + CHK-001:happy:5): all three reasons at once ──
  await checkAsync('doctor: a session tripping file-size + input-tokens + session-age lists all three reasons', async () => {
    // Evaluator level: old + huge usage + big injected file size.
    const ev = evaluateBurnAlerts(
      [row({ host: 'codex', sessionId: 'triple', firstTimestamp: iso(NOW - 10 * DAY), usage: codexUsage(5000) })],
      { nowMs: NOW, thresholds: T, fileSizeOf: () => 5000 },
    );
    assert.deepEqual([...(ev.findings[0]?.reasons ?? [])].sort(), ['file-size', 'input-tokens', 'session-age'], 'evaluator lists all three tripped reasons');
    // Doctor level: FILE_MB tiny enough that the real HOT fixture file (~a few
    // hundred bytes) trips file-size alongside input-tokens + session-age.
    const ctx = makeCtx('doctor-triple');
    const handlers = createDoctorHandlers(ctx);
    await withEnv(
      {
        [BURN_ALERT_ENV.codexDir]: codexDir,
        [BURN_ALERT_ENV.claudeDir]: emptyClaudeDir,
        [BURN_ALERT_ENV.fileMb]: '0.0001',
      },
      async () => {
        const text = String(await handlers.doctor({ format: 'text' }));
        // F-004: bind the tripped-line assertion to codex-burn-A's OWN warning
        // block (the session id is on the block header, not the tripped line),
        // instead of grabbing the first 'tripped:' line in the whole output.
        const lines = text.split('\n');
        const headerIdx = lines.findIndex((line) => line.includes('✗ BURN ALERT codex codex-burn-A'));
        assert.ok(headerIdx >= 0, 'codex-burn-A warning block present');
        const nextHeader = lines.findIndex((line, i) => i > headerIdx && line.includes('✗ BURN ALERT'));
        const hotBlock = lines.slice(headerIdx, nextHeader === -1 ? lines.length : nextHeader);
        const hotTripped = hotBlock.find((line) => line.includes('tripped:'));
        const json = (await handlers.doctor({ format: 'json' })) as Record<string, any>;
        // Selector rigor: codex-mega-M (250M, young) sorts FIRST, so the first
        // 'tripped:' line in the output is NOT codex-burn-A's — a regression to
        // the pre-F-004 first-line selector would fail these assertions.
        assert.equal(json.hostBurnScan.findings[0]?.sessionId, 'codex-mega-M', 'bigger-burn young session sorts first');
        const firstTrippedIdx = lines.findIndex((line) => line.includes('tripped:'));
        assert.ok(firstTrippedIdx >= 0 && firstTrippedIdx < headerIdx, 'first tripped line precedes the codex-burn-A block (mega renders first)');
        assert.ok(!(lines[firstTrippedIdx] ?? '').includes('session-age'), 'first tripped line belongs to codex-mega-M (no session-age) — block slicing is load-bearing');
        const hot = json.hostBurnScan.findings.find((f: any) => f.sessionId === 'codex-burn-A');
        assert.ok(hot, 'HOT fixture flagged');
        assert.deepEqual([...hot.reasons].sort(), ['file-size', 'input-tokens', 'session-age'], 'doctor JSON lists all three reasons');
        assert.ok(hotTripped && hotTripped.includes('file-size') && hotTripped.includes('input-tokens') && hotTripped.includes('session-age'), 'codex-burn-A block tripped line lists all three reasons');
      },
    );
  });

  // ── 7. renderers ────────────────────────────────────────────────────────────
  await checkAsync('renderers: doctor section and sweep alert trailer carry the advisory action line', () => {
    const ev = evaluateBurnAlerts(
      [row({ host: 'codex', sessionId: 'r1', firstTimestamp: iso(NOW - 1000), usage: codexUsage(5000) })],
      { nowMs: NOW, thresholds: T, fileSizeOf: () => 0 },
    );
    const doctorLines = renderHostBurnScan(ev, { disabled: false }).join('\n');
    assert.ok(doctorLines.includes('✗ BURN ALERT codex r1'), 'doctor block flags the session');
    assert.ok(doctorLines.includes('lattice cannot stop sessions it did not launch'), 'advisory action line present');
    const sweepLines = renderSweepAlertSection(ev).join('\n');
    assert.ok(sweepLines.includes('BURN ALERT: 1 session(s) over burn thresholds'), 'sweep trailer counts findings');
    const clean = evaluateBurnAlerts([], { nowMs: NOW, thresholds: T, fileSizeOf: () => 0 });
    assert.ok(renderSweepAlertSection(clean).join('\n').includes('no session over thresholds'), 'clean trailer');
  });

  // ── 8. usage_sweep handler --alert shape (in-process; never throws itself) ──
  await checkAsync('handler: --alert returns the structured alert result (alertFired) and never throws by itself', async () => {
    const ctx = makeCtx('sweep-alert');
    const handlers = createUsageSweepHandlers(ctx, { now: () => NOW });
    await withEnv({ [BURN_ALERT_ENV.inputTokens]: '1000' }, async () => {
      const fired = (await handlers.usage_sweep({ since: '2d', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, alert: true })) as UsageSweepAlertResult;
      assert.equal(fired.kind, 'usage_sweep_alert', 'structured kind');
      assert.equal(fired.alertFired, true, 'alert fired');
      assert.ok(fired.flaggedCount >= 1, 'flagged count');
      assert.ok(typeof fired.output === 'string' && fired.output.includes('BURN ALERT'), 'human output carries the alert section');
      assert.ok((fired.output as string).includes('NON-AUTHORITATIVE'), 'normal report still present');
      const json = (await handlers.usage_sweep({ since: '2d', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, alert: true, json: true })) as UsageSweepAlertResult;
      const payload = json.output as Record<string, any>;
      assert.equal(payload.alert.advisory, true, 'JSON alert advisory=true');
      assert.equal(payload.alert.gateEvidence, false, 'JSON alert gateEvidence=false');
      assert.ok(payload.alert.findings.length >= 1, 'JSON alert findings');
    });
    const clean = (await handlers.usage_sweep({ since: '2d', codexSessionsDir: emptyCodexDir, claudeProjectsDir: emptyClaudeDir, alert: true })) as UsageSweepAlertResult;
    assert.equal(clean.alertFired, false, 'clean stores → not fired');
  });

  await checkAsync('dispatcher: prints the report first, then throws only when fired', async () => {
    const ctx = makeCtx('sweep-dispatch');
    const handlers = createUsageSweepHandlers(ctx, { now: () => NOW });
    let printed = '';
    const stdout = { write: (chunk: string) => { printed += chunk; return true; } };
    await withEnv({ [BURN_ALERT_ENV.inputTokens]: '1000' }, async () => {
      await assert.rejects(
        () => dispatchUsageSweepAlertWithExit({ handler: handlers.usage_sweep as any, data: { since: '2d', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, alert: true }, stdout }),
        /over burn thresholds/,
        'fired alert throws AFTER printing',
      );
      assert.ok(printed.includes('BURN ALERT'), 'report printed before the throw');
    });
    printed = '';
    const result = await dispatchUsageSweepAlertWithExit({ handler: handlers.usage_sweep as any, data: { since: '2d', codexSessionsDir: emptyCodexDir, claudeProjectsDir: emptyClaudeDir, alert: true }, stdout });
    assert.ok(typeof result === 'string', 'clean run returns output for the normal printer');
    assert.equal(printed, '', 'clean run prints nothing itself (runCli prints the returned output)');
  });

  // ── 9. real-CLI exit codes ──────────────────────────────────────────────────
  await checkAsync('CLI: --alert exits non-zero on flagged stores AND still prints the report; clean/opt-out exit 0; plain doctor exits 0', async () => {
    // CHK-005:adversarial:0 — skip gracefully (with a loud warning) when the
    // CLI is not built, rather than failing the whole smoke.
    if (!existsSync(cliPath)) {
      console.warn('⚠ dist/cli.js not built — skipping the CLI end-to-end checks (run npm run build first)');
      return;
    }
    const fixtureRoot = join(root, 'cli-project');
    mkdirSync(fixtureRoot, { recursive: true });
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ENV_KEYS) delete baseEnv[key];
    const runCli = (args: string[], env: NodeJS.ProcessEnv): { code: number; stdout: string } => {
      try {
        const stdout = execFileSync(process.execPath, [cliPath, '--root', fixtureRoot, ...args], { cwd: fixtureRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout };
      } catch (err: any) {
        return { code: err.status ?? 1, stdout: String(err.stdout ?? '') };
      }
    };
    const flaggedEnv = { ...baseEnv, [BURN_ALERT_ENV.inputTokens]: '1000' };

    const fired = runCli(['usage_sweep', '--since=2d', `--codexSessionsDir=${codexDir}`, `--claudeProjectsDir=${claudeDir}`, '--alert'], flaggedEnv);
    assert.notEqual(fired.code, 0, '--alert on flagged stores exits non-zero');
    assert.ok(fired.stdout.includes('BURN ALERT'), 'alert section printed');
    assert.ok(fired.stdout.includes('NON-AUTHORITATIVE'), 'full report printed before the non-zero exit');

    const optOut = runCli(['usage_sweep', '--since=2d', `--codexSessionsDir=${codexDir}`, `--claudeProjectsDir=${claudeDir}`], flaggedEnv);
    assert.equal(optOut.code, 0, 'same flagged stores WITHOUT --alert exit 0 (opt-in only)');

    const clean = runCli(['usage_sweep', '--since=2d', `--codexSessionsDir=${emptyCodexDir}`, `--claudeProjectsDir=${emptyClaudeDir}`, '--alert'], flaggedEnv);
    assert.equal(clean.code, 0, '--alert on clean stores exits 0');

    const doctorEnv = { ...flaggedEnv, [BURN_ALERT_ENV.codexDir]: codexDir, [BURN_ALERT_ENV.claudeDir]: claudeDir };
    const doctor = runCli(['doctor'], doctorEnv);
    assert.equal(doctor.code, 0, 'plain doctor exits 0 even with flagged sessions (advisory contract)');
    assert.ok(doctor.stdout.includes('✗ BURN ALERT'), 'doctor still printed the warning');
  });

  // ── 10. zero writes ─────────────────────────────────────────────────────────
  await checkAsync('zero writes: store dirs byte-identical across doctor burn scan and --alert sweep', async () => {
    const beforeCodex = snapshotDir(codexDir);
    const beforeClaude = snapshotDir(claudeDir);
    const ctx = makeCtx('zero-writes');
    const doctorHandlers = createDoctorHandlers(ctx);
    const sweepHandlers = createUsageSweepHandlers(ctx, { now: () => NOW });
    await withEnv({ [BURN_ALERT_ENV.codexDir]: codexDir, [BURN_ALERT_ENV.claudeDir]: claudeDir }, async () => {
      await doctorHandlers.doctor({ format: 'text' });
      // CHK-003:adversarial:3 — --repair repairs worktree/metadata residue only;
      // it must never touch (let alone delete) flagged burn sessions.
      const repaired = (await doctorHandlers.doctor({ format: 'json', repair: true })) as Record<string, any>;
      assert.equal(repaired.hostBurnScan.advisory, true, '--repair run still reports the scan as advisory');
      assert.ok(repaired.hostBurnScan.findings.length >= 1, '--repair run still sees the flagged sessions');
    });
    await sweepHandlers.usage_sweep({ since: '2d', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, alert: true });
    assert.deepEqual([...snapshotDir(codexDir).entries()].sort(), [...beforeCodex.entries()].sort(), 'codex store untouched');
    assert.deepEqual([...snapshotDir(claudeDir).entries()].sort(), [...beforeClaude.entries()].sort(), 'claude store untouched');
  });

  // ── 11a. evaluator robustness: NaN / Infinity / negative usage ─────────────
  await checkAsync('evaluator: NaN / Infinity / negative token counts never throw or corrupt findings', () => {
    const nowMs = NOW;
    const young = iso(nowMs - 1000);
    const rows = [
      row({ host: 'codex', sessionId: 'nan', firstTimestamp: young, usage: { inputTokens: Number.NaN, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }),
      row({ host: 'codex', sessionId: 'inf', firstTimestamp: young, usage: { inputTokens: Number.POSITIVE_INFINITY, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }),
      row({ host: 'codex', sessionId: 'neg', firstTimestamp: young, usage: codexUsage(-5) }),
    ];
    const ev = evaluateBurnAlerts(rows, { nowMs, thresholds: T, fileSizeOf: () => 0 });
    assert.equal(ev.scanned, 3, 'all rows scanned without throwing');
    assert.equal(ev.findings.find((f) => f.sessionId === 'nan'), undefined, 'NaN usage never flags (NaN > t is false)');
    assert.equal(ev.findings.find((f) => f.sessionId === 'neg'), undefined, 'negative usage never flags');
    const inf = ev.findings.find((f) => f.sessionId === 'inf');
    assert.ok(inf && inf.reasons.length === 1 && inf.reasons[0] === 'input-tokens', 'Infinity flags input-tokens only, finding stays well-formed');
  });

  // ── 11b. resolver extremes: FILE_MB=50, huge values, proto pollution ────────
  await checkAsync('resolver: FILE_MB=50, very large values, prototype-pollution keys, unrelated-only env', () => {
    assert.equal(resolveBurnAlertThresholds({ [BURN_ALERT_ENV.fileMb]: '50' }).fileBytes, 50 * 1024 * 1024, 'FILE_MB=50 → 50MiB in bytes');
    const huge = resolveBurnAlertThresholds({ [BURN_ALERT_ENV.inputTokens]: '999999999999999' });
    assert.equal(huge.inputTokens, 999_999_999_999_999, 'very large token threshold accepted without overflow/NaN');
    const polluted = resolveBurnAlertThresholds(JSON.parse('{"__proto__": {"fileBytes": 1}, "constructor": "x"}'));
    assert.deepEqual(polluted, DEFAULT_BURN_ALERT_THRESHOLDS, 'prototype-pollution keys do not affect the result');
    assert.equal(({} as Record<string, unknown>).fileBytes, undefined, 'Object.prototype not polluted');
    const unrelated = resolveBurnAlertThresholds({ HOME: '/tmp/x', PATH: '/usr/bin' });
    assert.deepEqual(unrelated, DEFAULT_BURN_ALERT_THRESHOLDS, 'unrelated env keys leave all four defaults');
    // F-B (codex quorum r3): finite-but-absurd values are typos, not thresholds.
    // Unclamped they would overflow: RECENT_HOURS=1e308 → sinceMs=-Infinity (an
    // unbounded full-store doctor scan); FILE_MB=1e308 → fileBytes=Infinity
    // (serializes as null in JSON).
    const absurd = resolveBurnAlertThresholds({
      [BURN_ALERT_ENV.recentHours]: '1e308',
      [BURN_ALERT_ENV.fileMb]: '1e308',
      [BURN_ALERT_ENV.ageDays]: '999999',
      [BURN_ALERT_ENV.inputTokens]: '99999999999999999999',
    });
    assert.deepEqual(absurd, DEFAULT_BURN_ALERT_THRESHOLDS, 'absurdly large values fall back per-variable (no overflow weaponization)');
    assert.equal(resolveBurnAlertThresholds({ [BURN_ALERT_ENV.recentHours]: '8760' }).recentHours, 8760, 'the ceiling itself is still accepted (one year window)');
    assert.ok(Number.isFinite(resolveBurnAlertThresholds({ [BURN_ALERT_ENV.fileMb]: '1000000' }).fileBytes), '1TB FILE_MB stays finite');
  });

  // ── 11c. source-contract greps (pure-core + independence) ───────────────────
  await checkAsync('source contracts: core module has no Date.now/process.env in CODE; no usage-ledger imports anywhere here', () => {
    // Comments legitimately DESCRIBE the forbidden tokens (the pure-core rules
    // themselves), so strip comments first and check only executable code.
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
    const importsOf = (src: string): string[] => src.split('\n').filter((line) => /^import\b/.test(line.trim()));
    const ledgerNeedle = ['usage-', 'ledger'].join(''); // split so this file's own source never matches

    const coreSrc = readFileSync(join(packageRoot, 'src', 'core', 'usage-burn-alert.ts'), 'utf8');
    const coreCode = stripComments(coreSrc);
    assert.ok(!coreCode.includes('Date.now'), 'core module code never calls Date.now (clock injected)');
    assert.ok(!coreCode.includes('process.env'), 'core module code never reads process.env (resolver takes an env record)');
    assert.ok(!importsOf(coreSrc).some((line) => line.includes(ledgerNeedle)), 'core module never imports the usage ledger (independence contract)');

    const smokeSrc = readFileSync(join(packageRoot, 'src', 'tasks', 'usage-burn-alert-smoke.ts'), 'utf8');
    assert.ok(!importsOf(smokeSrc).some((line) => line.includes(ledgerNeedle)), 'this smoke never imports the usage ledger either');

    const doctorSrc = readFileSync(join(packageRoot, 'src', 'handlers', 'doctor.ts'), 'utf8');
    assert.ok(!importsOf(doctorSrc).some((line) => line.includes('ownership-gate')), 'doctor does not import ownership-gate (no classification changes)');
    assert.ok(!importsOf(doctorSrc).some((line) => line.includes('activity-policy')), 'doctor does not import activity-policy (no classification changes)');
  });

  // ── 11d. --alert with --out and CLI JSON validity when fired ───────────────
  await checkAsync('CLI: --alert --json prints parseable JSON (report+alert) before the non-zero exit; --alert --out still writes the report file', async () => {
    if (!existsSync(cliPath)) {
      console.warn('⚠ dist/cli.js not built — skipping the CLI --alert JSON/--out checks');
      return;
    }
    const fixtureRoot = join(root, 'cli-json-project');
    mkdirSync(fixtureRoot, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, [BURN_ALERT_ENV.inputTokens]: '1000' };
    for (const key of [BURN_ALERT_ENV.fileMb, BURN_ALERT_ENV.ageDays, BURN_ALERT_ENV.recentHours, BURN_ALERT_ENV.codexDir, BURN_ALERT_ENV.claudeDir]) delete env[key];
    const runCli = (args: string[]): { code: number; stdout: string } => {
      try {
        const stdout = execFileSync(process.execPath, [cliPath, '--root', fixtureRoot, ...args], { cwd: fixtureRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout };
      } catch (err: any) {
        return { code: err.status ?? 1, stdout: String(err.stdout ?? '') };
      }
    };
    const jsonRun = runCli(['usage_sweep', '--since=2d', `--codexSessionsDir=${codexDir}`, `--claudeProjectsDir=${claudeDir}`, '--alert', '--json']);
    assert.notEqual(jsonRun.code, 0, '--alert --json exits non-zero when fired');
    const parsed = JSON.parse(jsonRun.stdout) as Record<string, any>;
    assert.equal(parsed.label, 'NON-AUTHORITATIVE ESTIMATE', 'printed JSON is the full report');
    assert.ok(parsed.alert.findings.length >= 1, 'printed JSON carries the alert findings');
    assert.equal(parsed.alert.gateEvidence, false, 'alert evaluation is never gate evidence');

    const outRun = runCli(['usage_sweep', '--since=2d', `--codexSessionsDir=${codexDir}`, `--claudeProjectsDir=${claudeDir}`, '--alert', '--json', '--out=reports/alert-sweep.json']);
    assert.notEqual(outRun.code, 0, '--alert --out exits non-zero when fired');
    const outPath = join(fixtureRoot, 'reports', 'alert-sweep.json');
    assert.ok(existsSync(outPath), '--out report file written before the alert exit');
    const outParsed = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(outParsed.label, 'NON-AUTHORITATIVE ESTIMATE', 'written report parses');
  });

  // ── 11e. activity-log classification with --alert ───────────────────────────
  await checkAsync('classification: shouldWriteActivityLog(usage_sweep,{alert:true}) stays false by default', () => {
    const prev = process.env.LATTICE_ACTIVITY_RECORD_READONLY;
    delete process.env.LATTICE_ACTIVITY_RECORD_READONLY;
    try {
      assert.equal(shouldWriteActivityLog('usage_sweep', { alert: true }), false, '--alert writes no activity row by default');
      assert.equal(shouldWriteActivityLog('usage_sweep', { alert: true, out: 'r.json' }), true, '--out remains the only activity-write trigger');
    } finally {
      if (prev === undefined) delete process.env.LATTICE_ACTIVITY_RECORD_READONLY;
      else process.env.LATTICE_ACTIVITY_RECORD_READONLY = prev;
    }
  });

  // ── 11. read-only classification unchanged by --alert ──────────────────────
  await checkAsync('classification: usage_sweep {alert:true} stays readOnly on ownership + activity surfaces', () => {
    assert.equal(resolveEffectiveOwnershipClass('usage_sweep', { since: '2d', alert: true }, null), 'readOnly', 'ownership gate: --alert is not a write');
    assert.equal(isReadOnlyCommand('usage_sweep', { since: '2d', alert: true }), true, 'activity/hook layer: --alert is read-only');
    assert.equal(resolveEffectiveOwnershipClass('usage_sweep', { since: '2d', alert: true, out: 'r.json' }, null), 'storyScopedMutating', '--out still escalates independently of --alert');
  });
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    if (failures.length > 0) {
      console.error(`\n✗ usage-burn-alert smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-burn-alert smoke passed (${passed} checks)`);
  });
