/**
 * B-623a: push-based host long-thread burn detection — pure core.
 *
 * Evaluates usage-sweep session rows (core/usage-sweep.ts scanners) against
 * burn thresholds and renders the advisory warning blocks shared by the two
 * push surfaces: the `lattice doctor` "Host burn scan (advisory)" section and
 * the `usage_sweep --alert` exit-nonzero mode.
 *
 * DESIGN CONTRACT (mirrors the usage-sweep pure-core rules):
 *   - No process.env reads and no Date.now() in the evaluator: the clock
 *     (nowMs) and thresholds are injected. The env→thresholds resolver below
 *     is a pure function of a caller-supplied env RECORD (handlers pass
 *     process.env at the boundary).
 *   - Read-only: the only filesystem access is stat() on already-discovered
 *     transcript paths (injectable via fileSizeOf for hermetic tests).
 *   - ADVISORY-ONLY: nothing here produces gate evidence (gateEvidence=false
 *     on every rendered/JSON surface), blocks a phase, or mutates host
 *     sessions. Desktop sessions stay report-only (B-70e9 non-goal).
 *
 * Why this exists (mechanism, verified twice): interactive desktop threads
 * re-send their ENTIRE accumulated context every model call, so burn ∝
 * calls × pinned context. Rollout 019e40d0 hit 1.76B cumulative input over a
 * month; the 2026-07-12 B-8038 incident burned ~0.92B real input in ONE day
 * across 11 Codex Desktop threads whose rollout files were only 1-1.6MB —
 * which is why `input-tokens` is the load-bearing threshold and `file-size`
 * is a backstop for the month-old giant-file case. Cumulative counters of
 * forked desktop threads include parent history (attribution hint, not
 * billing truth — the same NON-AUTHORITATIVE stance as the sweep).
 */

import { statSync } from 'node:fs';
import type { ClaudeUsageTotals, CodexUsageTotals, SweepSessionRow } from './usage-sweep.js';

// ── Thresholds + env resolver ────────────────────────────────────────────────

export interface BurnAlertThresholds {
  /** Transcript file size threshold in BYTES (flag when strictly greater). */
  fileBytes: number;
  /** Cumulative burn input tokens threshold (flag when strictly greater). */
  inputTokens: number;
  /** Session age threshold in days (flag when strictly older AND recently active). */
  ageDays: number;
  /** Recent-activity scan window in hours for the doctor scan; 0 disables it. */
  recentHours: number;
}

export const DEFAULT_BURN_ALERT_THRESHOLDS: BurnAlertThresholds = {
  fileBytes: 100 * 1024 * 1024,
  inputTokens: 100_000_000,
  ageDays: 7,
  recentHours: 48,
};

export const BURN_ALERT_ENV = {
  fileMb: 'LATTICE_BURN_ALERT_FILE_MB',
  inputTokens: 'LATTICE_BURN_ALERT_INPUT_TOKENS',
  ageDays: 'LATTICE_BURN_ALERT_AGE_DAYS',
  recentHours: 'LATTICE_BURN_ALERT_RECENT_HOURS',
  codexDir: 'LATTICE_BURN_ALERT_CODEX_DIR',
  claudeDir: 'LATTICE_BURN_ALERT_CLAUDE_DIR',
} as const;

/**
 * Parse one env number. Invalid (non-numeric / non-finite / negative, or zero
 * where zero is not meaningful) falls back to the default for that variable —
 * a typo'd env must never break or silently zero a diagnostic surface.
 */
function envNumber(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  opts: { allowZero?: boolean } = {},
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  if (value === 0 && !opts.allowZero) return fallback;
  return value;
}

/**
 * Resolve burn-alert thresholds from an env record (pure; handlers pass
 * process.env). LATTICE_BURN_ALERT_FILE_MB is given in MB and converted to
 * bytes; LATTICE_BURN_ALERT_RECENT_HOURS accepts 0 as the explicit
 * "disable the doctor burn scan" switch.
 */
export function resolveBurnAlertThresholds(
  env: Record<string, string | undefined>,
): BurnAlertThresholds {
  const d = DEFAULT_BURN_ALERT_THRESHOLDS;
  const fileMb = envNumber(env, BURN_ALERT_ENV.fileMb, d.fileBytes / (1024 * 1024));
  return {
    fileBytes: Math.round(fileMb * 1024 * 1024),
    inputTokens: envNumber(env, BURN_ALERT_ENV.inputTokens, d.inputTokens),
    ageDays: envNumber(env, BURN_ALERT_ENV.ageDays, d.ageDays),
    recentHours: envNumber(env, BURN_ALERT_ENV.recentHours, d.recentHours, { allowZero: true }),
  };
}

// ── Evaluator ────────────────────────────────────────────────────────────────

export type BurnAlertReason = 'file-size' | 'input-tokens' | 'session-age';

/** One flagged session, flattened for report/JSON surfaces. */
export interface BurnAlertFinding {
  host: SweepSessionRow['host'];
  sessionId: string;
  file: string;
  cwd: string | null;
  originLabel: SweepSessionRow['originLabel'];
  reasons: BurnAlertReason[];
  /** stat() size of the transcript file; null when unreadable. */
  fileBytes: number | null;
  /** Cumulative burn input tokens (see burnInputTokensOf); null when usage unknown. */
  burnInputTokens: number | null;
  /** Whole days since firstTimestamp at nowMs; null when unparseable/missing. */
  ageDays: number | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export interface BurnAlertEvaluation {
  /** Constant advisory markers so every JSON consumer sees the boundary. */
  advisory: true;
  gateEvidence: false;
  thresholds: BurnAlertThresholds;
  scanned: number;
  findings: BurnAlertFinding[];
}

/**
 * The burn input-token metric per host. Codex rows report the LAST cumulative
 * total_token_usage input (which already INCLUDES cached input). Claude rows
 * sum input + cacheRead + cacheCreation — cache reads are included on purpose:
 * the runaway pattern IS repeated cache re-payment, and subscription limits
 * count it. Null when the session never reported usage.
 */
export function burnInputTokensOf(row: SweepSessionRow): number | null {
  if (!row.usage) return null;
  if (row.host === 'codex') {
    return (row.usage as CodexUsageTotals).inputTokens;
  }
  const u = row.usage as ClaudeUsageTotals;
  return u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
}

function defaultFileSizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

export interface EvaluateBurnAlertsOptions {
  /** Injected clock (epoch ms) — the evaluator never calls Date.now(). */
  nowMs: number;
  thresholds: BurnAlertThresholds;
  /** Test seam: transcript file size probe (default statSync().size, null on error). */
  fileSizeOf?: (file: string) => number | null;
}

/**
 * Evaluate swept session rows against the thresholds. All comparisons are
 * STRICTLY greater (an at-threshold session is not flagged). A session with
 * unknown usage is never flagged on input-tokens; an unparseable/missing
 * firstTimestamp is never flagged on session-age. The "recently active" half
 * of session-age comes from the caller's scan window (rows were discovered
 * with mtime >= sinceMs), not from this evaluator.
 */
export function evaluateBurnAlerts(
  rows: SweepSessionRow[],
  opts: EvaluateBurnAlertsOptions,
): BurnAlertEvaluation {
  const fileSizeOf = opts.fileSizeOf ?? defaultFileSizeOf;
  const { nowMs, thresholds } = opts;
  const findings: BurnAlertFinding[] = [];

  for (const row of rows) {
    const reasons: BurnAlertReason[] = [];
    const fileBytes = fileSizeOf(row.file);
    if (fileBytes !== null && fileBytes > thresholds.fileBytes) reasons.push('file-size');

    const burnInputTokens = burnInputTokensOf(row);
    if (burnInputTokens !== null && burnInputTokens > thresholds.inputTokens) {
      reasons.push('input-tokens');
    }

    let ageDays: number | null = null;
    if (row.firstTimestamp) {
      const firstMs = Date.parse(row.firstTimestamp);
      if (!Number.isNaN(firstMs)) {
        ageDays = Math.floor((nowMs - firstMs) / 86_400_000);
        if (nowMs - firstMs > thresholds.ageDays * 86_400_000) reasons.push('session-age');
      }
    }

    if (reasons.length === 0) continue;
    findings.push({
      host: row.host,
      sessionId: row.sessionId,
      file: row.file,
      cwd: row.cwd,
      originLabel: row.originLabel,
      reasons,
      fileBytes,
      burnInputTokens,
      ageDays,
      firstTimestamp: row.firstTimestamp,
      lastTimestamp: row.lastTimestamp,
    });
  }

  findings.sort((a, b) => {
    const at = a.burnInputTokens ?? -1;
    const bt = b.burnInputTokens ?? -1;
    if (bt !== at) return bt - at;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  return { advisory: true, gateEvidence: false, thresholds, scanned: rows.length, findings };
}

// ── Rendering (pure string building, shared by doctor + usage_sweep) ────────

/** Group digits with underscores (locale-free), same style as the sweep report. */
function fmt(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The prominent per-session warning block (file, cwd, cumulative tokens). */
export function renderBurnFindingBlock(f: BurnAlertFinding): string[] {
  const tokens = f.burnInputTokens === null ? 'unknown' : `~${fmt(f.burnInputTokens)}`;
  const lines: string[] = [];
  lines.push(`  ✗ BURN ALERT ${f.host} ${f.sessionId} (${f.originLabel}) ${tokens} input tokens`);
  lines.push(`      file: ${f.file}${f.fileBytes === null ? '' : ` (${mb(f.fileBytes)})`}`);
  lines.push(`      cwd:  ${f.cwd ?? '(no cwd)'}`);
  const age = f.ageDays === null ? '' : ` (${f.ageDays} day(s) old)`;
  lines.push(`      first activity ${f.firstTimestamp ?? '?'}${age}, last ${f.lastTimestamp ?? '?'}`);
  lines.push(`      tripped: ${f.reasons.join(', ')}`);
  lines.push(
    '      → Long-lived interactive thread re-paying its full context every turn. ' +
      'Close/restart it; lattice cannot stop sessions it did not launch (advisory only, no gate).',
  );
  return lines;
}

export interface RenderHostBurnScanOptions {
  /** True when the scan was skipped via LATTICE_BURN_ALERT_RECENT_HOURS=0. */
  disabled: boolean;
}

/** The `lattice doctor` section. */
export function renderHostBurnScan(
  evaluation: BurnAlertEvaluation,
  opts: RenderHostBurnScanOptions,
): string[] {
  const lines: string[] = [];
  lines.push('Host burn scan (advisory):');
  if (opts.disabled) {
    lines.push(`  - disabled (${BURN_ALERT_ENV.recentHours}=0); no host transcript stores were scanned`);
    return lines;
  }
  const t = evaluation.thresholds;
  lines.push(
    `  window: sessions active in the last ${t.recentHours}h | thresholds: ` +
      `file > ${mb(t.fileBytes)}, input > ${fmt(t.inputTokens)} tok, age > ${t.ageDays}d ` +
      `(env-tunable via ${BURN_ALERT_ENV.fileMb}/${BURN_ALERT_ENV.inputTokens}/${BURN_ALERT_ENV.ageDays}/${BURN_ALERT_ENV.recentHours})`,
  );
  if (evaluation.findings.length === 0) {
    lines.push(`  ✓ no host sessions over burn thresholds (${evaluation.scanned} scanned)`);
    return lines;
  }
  for (const f of evaluation.findings) lines.push(...renderBurnFindingBlock(f));
  lines.push(
    `  → ${evaluation.findings.length} session(s) over burn thresholds out of ${evaluation.scanned} scanned. ` +
      'Advisory only: this never gates a phase and produces no gate evidence.',
  );
  return lines;
}

/** The `usage_sweep --alert` trailer section appended to the human report. */
export function renderSweepAlertSection(evaluation: BurnAlertEvaluation): string[] {
  const lines: string[] = [];
  if (evaluation.findings.length === 0) {
    lines.push(`BURN ALERT: no session over thresholds (${evaluation.scanned} scanned) — exit 0`);
    return lines;
  }
  lines.push(
    `BURN ALERT: ${evaluation.findings.length} session(s) over burn thresholds ` +
      `(${evaluation.scanned} scanned) — exiting non-zero`,
  );
  for (const f of evaluation.findings) lines.push(...renderBurnFindingBlock(f));
  return lines;
}
