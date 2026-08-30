/**
 * B-623a: push-based host long-thread burn detection — pure core.
 *
 * Evaluates usage-sweep session rows (core/usage-sweep.ts scanners) against
 * burn thresholds and renders the advisory warning blocks shared by the two
 * push surfaces: the `proof-or-stop doctor` "Host burn scan (advisory)" section and
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
import {
  projectSweepSessionRowForOutput,
  type ClaudeUsageTotals,
  type CodexUsageTotals,
  type SweepSessionRow,
} from './usage-sweep.js';
import { readBrandEnv } from './brand-env.js';

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
  fileMb: 'PROOF_OR_STOP_BURN_ALERT_FILE_MB',
  inputTokens: 'PROOF_OR_STOP_BURN_ALERT_INPUT_TOKENS',
  ageDays: 'PROOF_OR_STOP_BURN_ALERT_AGE_DAYS',
  recentHours: 'PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS',
  codexDir: 'PROOF_OR_STOP_BURN_ALERT_CODEX_DIR',
  claudeDir: 'PROOF_OR_STOP_BURN_ALERT_CLAUDE_DIR',
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
  opts: { allowZero?: boolean; max: number },
): number {
  const raw = readBrandEnv(key, env);
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  if (value === 0 && !opts.allowZero) return fallback;
  // Absurdly large values are treated as typos and fall back, same as garbage:
  // a finite-but-huge RECENT_HOURS would overflow the sinceMs arithmetic to a
  // -Infinity cutoff (an unbounded full-store scan) and a huge FILE_MB would
  // overflow fileBytes to Infinity (which serializes as null in JSON).
  if (value > opts.max) return fallback;
  return value;
}

/** Per-variable sanity ceilings (values above these are typos, not thresholds). */
export const BURN_ALERT_ENV_MAX = {
  /** 1 TB expressed in MB. */
  fileMb: 1_000_000,
  inputTokens: Number.MAX_SAFE_INTEGER,
  /** 100 years. */
  ageDays: 36_500,
  /** 1 year — also caps the doctor scan window arithmetic. */
  recentHours: 8_760,
} as const;

/**
 * Resolve burn-alert thresholds from an env record (pure; handlers pass
 * process.env). PROOF_OR_STOP_BURN_ALERT_FILE_MB is given in MB and converted to
 * bytes; PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS accepts 0 as the explicit
 * "disable the doctor burn scan" switch.
 */
export function resolveBurnAlertThresholds(
  env: Record<string, string | undefined>,
): BurnAlertThresholds {
  const d = DEFAULT_BURN_ALERT_THRESHOLDS;
  const fileMb = envNumber(env, BURN_ALERT_ENV.fileMb, d.fileBytes / (1024 * 1024), { max: BURN_ALERT_ENV_MAX.fileMb });
  return {
    fileBytes: Math.round(fileMb * 1024 * 1024),
    inputTokens: envNumber(env, BURN_ALERT_ENV.inputTokens, d.inputTokens, { max: BURN_ALERT_ENV_MAX.inputTokens }),
    ageDays: envNumber(env, BURN_ALERT_ENV.ageDays, d.ageDays, { max: BURN_ALERT_ENV_MAX.ageDays }),
    recentHours: envNumber(env, BURN_ALERT_ENV.recentHours, d.recentHours, { allowZero: true, max: BURN_ALERT_ENV_MAX.recentHours }),
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
 * Redact native host ids and transcript locations after internal file probes
 * have completed but before JSON/text renderers can observe the findings.
 */
export function projectBurnAlertEvaluationForOutput(
  evaluation: BurnAlertEvaluation,
  projectRoot: string,
): BurnAlertEvaluation {
  return {
    ...evaluation,
    findings: evaluation.findings.map((finding) => {
      const projected = projectSweepSessionRowForOutput({
        host: finding.host,
        sessionId: finding.sessionId,
        file: finding.file,
        cwd: finding.cwd,
        originator: finding.originLabel,
        originLabel: finding.originLabel,
        proofOrStopCwd: false,
        firstTimestamp: finding.firstTimestamp,
        lastTimestamp: finding.lastTimestamp,
        usage: null,
        storyMentions: [],
        parseErrors: 0,
      }, projectRoot);
      return {
        ...finding,
        sessionId: projected.sessionId,
        file: projected.file,
        cwd: projected.cwd,
        originLabel: projected.originLabel,
        firstTimestamp: projected.firstTimestamp,
        lastTimestamp: projected.lastTimestamp,
      };
    }),
  };
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

    // F-005: normalize a NaN burn value (malformed synthetic usage) to null at
    // CONSTRUCTION so every downstream consumer — the input-tokens check, the
    // sort (NaN would make the comparator non-transitive: it falls through to
    // the tie-break as if equal to every number), the renderers, and JSON —
    // uniformly treats it as unknown. Unreachable via the real scanners
    // (ownNumber filters non-finite to 0); this is the exported pure API's own
    // robustness contract.
    const burnRaw = burnInputTokensOf(row);
    const burnInputTokens = burnRaw !== null && Number.isNaN(burnRaw) ? null : burnRaw;
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
    // Unknown usage sorts UNCONDITIONALLY last (a null is not comparable to any
    // number — including negatives from malformed transcripts), and the numeric
    // branch uses explicit comparisons instead of subtraction so non-finite
    // values (Infinity) cannot produce a NaN comparator and bypass the
    // deterministic sessionId tie-break.
    const at = a.burnInputTokens;
    const bt = b.burnInputTokens;
    if (at === null && bt !== null) return 1;
    if (at !== null && bt === null) return -1;
    if (at !== null && bt !== null) {
      if (at < bt) return 1;
      if (at > bt) return -1;
    }
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
      'Close/restart it; proof-or-stop cannot stop sessions it did not launch (advisory only, no gate).',
  );
  return lines;
}

export interface RenderHostBurnScanOptions {
  /** True when the scan was skipped via PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS=0. */
  disabled: boolean;
  /** Keep actionable counts and a bounded sample; doctor --full retains every detail line. */
  brief?: boolean;
}

/** The `proof-or-stop doctor` section. */
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
  if (opts.brief) {
    for (const finding of evaluation.findings.slice(0, 3)) {
      const tokens = finding.burnInputTokens === null ? 'unknown' : `~${fmt(finding.burnInputTokens)}`;
      lines.push(`  ✗ BURN ALERT ${finding.host} ${finding.sessionId} (${finding.originLabel}) ${tokens} input tokens; tripped: ${finding.reasons.join(', ')}`);
    }
    if (evaluation.findings.length > 3) {
      lines.push(`  ... and ${evaluation.findings.length - 3} more over threshold (use proof-or-stop doctor --full for every session detail)`);
    }
    lines.push(
      `  → ${evaluation.findings.length} session(s) over burn thresholds out of ${evaluation.scanned} scanned. ` +
        'Close/restart long-lived sessions; use proof-or-stop doctor --full for every session detail; advisory only, never gate evidence.',
    );
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
