/**
 * B-70e9 CHK-005 (M2): read-only retro-attribution usage sweep — pure core.
 *
 * Scans the host transcript stores that proof-or-stop-initiated (and foreign) LLM host
 * runs leave behind and produces a NON-AUTHORITATIVE attribution estimate:
 *
 *   - Codex rollouts:  <codexSessionsDir>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   - Claude sessions: <claudeProjectsDir>/<munged-cwd>/<session-uuid>.jsonl
 *
 * DESIGN CONTRACT (independence keeps "no ledger backfill" mechanically true):
 *   - This module NEVER imports from core/usage-ledger. The four-field usage
 *     shapes are defined LOCALLY here on purpose.
 *   - Pure core: no ~ expansion, no process.env reads, no Date.now. Dirs, the
 *     since cutoff, and (for the report) a caller-supplied clock are injected.
 *   - Zero writes in the scanners: they only stat + stream-read files. The ONE
 *     write primitive in this module is `openReportFileExclusive` (the --out
 *     fence), which is create-only ('wx'), relative-path-only, and refuses
 *     symlinked ancestors — it can never overwrite or escape the project root.
 *   - Files can be hundreds of MB (a 30-hour desktop rollout hit 368.9M
 *     cumulative input tokens), so every file is read line-by-line via readline
 *     over a read stream — never readFileSync of a whole file.
 *
 * Attribution is a HINT, never billing truth. Codex per-session totals are the
 * LAST non-null cumulative `total_token_usage` (input_tokens INCLUDES
 * cached_input_tokens); Claude per-session totals sum the four
 * `message.usage` fields with dedupe by (requestId ?? message.id) keeping the
 * last usage per id (one assistant message can span multiple JSONL events).
 */

import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { deriveAdapterOwnerSessionId } from './owner-session-adapters.js';
import { USAGE_SWEEP_SCHEMA } from './artifact-schema.js';

// ── Local usage shapes (intentionally NOT imported from core/usage-ledger) ───

/** Codex per-session cumulative totals (input_tokens already INCLUDES cached). */
export interface CodexUsageTotals {
  /** Cumulative input tokens for the session; INCLUDES cachedInputTokens. */
  inputTokens: number;
  cachedInputTokens: number;
  /** Derived convenience: inputTokens - cachedInputTokens (never below 0). */
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** Claude per-session four-field sums (deduped by requestId/message.id). */
export interface ClaudeUsageTotals {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export type SweepHost = 'codex' | 'claude';
export type OriginLabel = 'codex-exec' | 'codex-desktop' | 'claude-code';

/** One transcript session's swept facts. `usage` is null when never reported. */
export interface SweepSessionRow {
  host: SweepHost;
  sessionId: string;
  file: string;
  cwd: string | null;
  /** Raw originator hint (codex: originator[/source]; claude: 'claude-code'). */
  originator: string | null;
  /** Coarse origin bucket for the report. */
  originLabel: OriginLabel;
  /**
   * Dumb, documented HINT (not attribution truth): the cwd looks like a proofOrStop
   * worktree/root. True when cwd contains '/.worktrees/'. A hint only.
   */
  proofOrStopCwd: boolean;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  usage: CodexUsageTotals | ClaudeUsageTotals | null;
  storyMentions: string[];
  parseErrors: number;
}

function ownerSessionProvider(host: SweepHost): 'codex' | 'claude-code' {
  return host === 'codex' ? 'codex' : 'claude-code';
}

const OPAQUE_OWNER_SESSION_ID_RE = /^sess-[a-f0-9]{32}$/;

function isProjectedSweepSessionRow(row: SweepSessionRow): boolean {
  return OPAQUE_OWNER_SESSION_ID_RE.test(row.sessionId)
    && row.file === `<${row.host}-transcript>/${row.sessionId}.jsonl`;
}

function redactNativeSessionMaterial<T extends string | null>(
  value: T,
  nativeSessionId: string,
  opaqueSessionId: string,
): T {
  if (value === null || nativeSessionId.length === 0) return value;
  return value.split(nativeSessionId).join(opaqueSessionId) as T;
}

/**
 * Project an internally useful transcript row onto a safe outward shape.
 * Scanners retain the real file path long enough to stream/stat it; callers
 * must use this projection before serializing or rendering a row.
 */
export function projectSweepSessionRowForOutput(
  row: SweepSessionRow,
  projectRoot: string,
): SweepSessionRow {
  // Idempotence requires the whole projection contract, not a loose `sess-`
  // prefix. A raw user value that merely resembles an owner id is re-hashed
  // unless its exact canonical id and host-bound locator already agree.
  if (isProjectedSweepSessionRow(row)) return row;
  const opaqueSessionId = deriveAdapterOwnerSessionId(
    projectRoot,
    ownerSessionProvider(row.host),
    row.sessionId,
    'main',
  );
  return {
    ...row,
    sessionId: opaqueSessionId,
    file: `<${row.host}-transcript>/${opaqueSessionId}.jsonl`,
    cwd: redactNativeSessionMaterial(row.cwd, row.sessionId, opaqueSessionId),
    originator: redactNativeSessionMaterial(row.originator, row.sessionId, opaqueSessionId),
    originLabel: redactNativeSessionMaterial(row.originLabel, row.sessionId, opaqueSessionId),
    firstTimestamp: redactNativeSessionMaterial(row.firstTimestamp, row.sessionId, opaqueSessionId),
    lastTimestamp: redactNativeSessionMaterial(row.lastTimestamp, row.sessionId, opaqueSessionId),
    storyMentions: row.storyMentions.map(value =>
      redactNativeSessionMaterial(value, row.sessionId, opaqueSessionId)),
  };
}

export interface SweepScanArgs {
  /** Explicit store dir (no ~ expansion inside core). */
  dir: string;
  /** Inclusive mtime cutoff in epoch ms; files with mtime < sinceMs are skipped BEFORE reading. */
  sinceMs: number;
}

// ── Prototype-pollution-safe own-property readers ────────────────────────────

function ownString(obj: unknown, key: string): string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function ownNumber(obj: unknown, key: string): number {
  if (typeof obj !== 'object' || obj === null) return 0;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return 0;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function ownObject(obj: unknown, key: string): Record<string, unknown> | null {
  if (typeof obj !== 'object' || obj === null) return null;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

// ── Story-id mentions ────────────────────────────────────────────────────────

/** Per-line story-id scan; bounded set collection keeps memory flat while streaming. */
const STORY_ID_RE = /\bB-[0-9a-f]{4}\b/gi;
const MAX_STORY_MENTIONS = 50;

/** Normalize to canonical "B-" + lowercase hex so case variants dedupe. */
function normalizeStoryId(raw: string): string {
  return `B-${raw.slice(2).toLowerCase()}`;
}

function collectStoryMentions(line: string, into: Set<string>): void {
  if (into.size >= MAX_STORY_MENTIONS) return;
  // Reset lastIndex defensively (module-level regex is stateful with /g).
  STORY_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STORY_ID_RE.exec(line)) !== null) {
    into.add(normalizeStoryId(m[0]));
    if (into.size >= MAX_STORY_MENTIONS) return;
  }
}

// ── File discovery (mtime-filtered, memory-bounded walk) ─────────────────────

/**
 * Recursively collect files under `dir` matching `match`, keeping only those
 * with mtime >= sinceMs. We rely on per-file mtime as the authoritative cutoff
 * rather than aggressively pruning YYYY/MM/DD date dirs, because a long-running
 * session's rollout file can be appended (mtime bumped) days after the
 * date-dir it was created under — date-dir end-of-day pruning would wrongly
 * drop such a still-active session. mtime filtering is both simple and correct.
 */
function collectFiles(
  dir: string,
  match: (name: string) => boolean,
  sinceMs: number,
  maxDepth = 8,
): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;

  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip, never throw
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && match(entry.name)) {
        let mtimeMs: number;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs >= sinceMs) out.push(full);
      }
    }
  };

  walk(dir, 0);
  out.sort();
  return out;
}

function isCodexRollout(name: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

function isJsonl(name: string): boolean {
  return name.endsWith('.jsonl');
}

async function readLines(file: string, onLine: (line: string) => void): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      onLine(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Dumb documented hint: does the cwd look like a proof-or-stop worktree/root? */
export function isProofOrStopCwdHint(cwd: string | null): boolean {
  if (!cwd) return false;
  return cwd.includes('/.worktrees/');
}

// ── Codex scanner ────────────────────────────────────────────────────────────

export async function sweepCodexSessions(args: SweepScanArgs): Promise<SweepSessionRow[]> {
  const files = collectFiles(args.dir, isCodexRollout, args.sinceMs);
  const rows: SweepSessionRow[] = [];
  for (const file of files) {
    rows.push(await sweepOneCodexRollout(file));
  }
  return rows;
}

async function sweepOneCodexRollout(file: string): Promise<SweepSessionRow> {
  let metaId: string | null = null;
  let cwd: string | null = null;
  let originator: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let lastUsage: CodexUsageTotals | null = null;
  let parseErrors = 0;
  const storyMentions = new Set<string>();

  await readLines(file, (line) => {
    collectStoryMentions(line, storyMentions);
    const record = parseJsonLine(line);
    if (record === undefined) {
      parseErrors += 1;
      return;
    }
    const ts = ownString(record, 'timestamp');
    if (ts) {
      if (firstTimestamp === null) firstTimestamp = ts;
      lastTimestamp = ts;
    }
    const type = ownString(record, 'type');
    const payload = ownObject(record, 'payload');
    if (type === 'session_meta' && payload && metaId === null && cwd === null && originator === null) {
      metaId = ownString(payload, 'id');
      cwd = ownString(payload, 'cwd');
      const rawOriginator = ownString(payload, 'originator');
      const source = ownString(payload, 'source');
      originator = rawOriginator
        ? source
          ? `${rawOriginator}/${source}`
          : rawOriginator
        : source;
      return;
    }
    if (type === 'event_msg' && payload && ownString(payload, 'type') === 'token_count') {
      // `info` may be null on some desktop token_count events — skip those.
      const info = ownObject(payload, 'info');
      if (!info) return;
      const total = ownObject(info, 'total_token_usage');
      if (!total) return;
      const inputTokens = ownNumber(total, 'input_tokens');
      const cachedInputTokens = ownNumber(total, 'cached_input_tokens');
      lastUsage = {
        inputTokens,
        cachedInputTokens,
        uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
        outputTokens: ownNumber(total, 'output_tokens'),
        reasoningOutputTokens: ownNumber(total, 'reasoning_output_tokens'),
      };
    }
  });

  const sessionId = metaId ?? basename(file).replace(/\.jsonl$/, '');
  const originLabel: OriginLabel = (originator ?? '').toLowerCase().includes('exec')
    ? 'codex-exec'
    : 'codex-desktop';

  return {
    host: 'codex',
    sessionId,
    file,
    cwd,
    originator,
    originLabel,
    proofOrStopCwd: isProofOrStopCwdHint(cwd),
    firstTimestamp,
    lastTimestamp,
    usage: lastUsage,
    storyMentions: [...storyMentions].sort(),
    parseErrors,
  };
}

// ── Claude scanner ───────────────────────────────────────────────────────────

export async function sweepClaudeProjects(args: SweepScanArgs): Promise<SweepSessionRow[]> {
  const files = collectFiles(args.dir, isJsonl, args.sinceMs);
  const rows: SweepSessionRow[] = [];
  for (const file of files) {
    rows.push(await sweepOneClaudeTranscript(file));
  }
  return rows;
}

async function sweepOneClaudeTranscript(file: string): Promise<SweepSessionRow> {
  let cwd: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let parseErrors = 0;
  const storyMentions = new Set<string>();
  // Dedupe: keep the LAST usage per (requestId ?? message.id). One assistant
  // message may span multiple JSONL events sharing that id — naive summing
  // double-counts, so we overwrite per key then total across keys at the end.
  const usageByKey = new Map<string, ClaudeUsageTotals>();

  await readLines(file, (line) => {
    collectStoryMentions(line, storyMentions);
    const record = parseJsonLine(line);
    if (record === undefined) {
      parseErrors += 1;
      return;
    }
    const ts = ownString(record, 'timestamp');
    if (ts) {
      if (firstTimestamp === null) firstTimestamp = ts;
      lastTimestamp = ts;
    }
    if (cwd === null) {
      const recCwd = ownString(record, 'cwd');
      if (recCwd) cwd = recCwd;
    }
    if (ownString(record, 'type') !== 'assistant') return;
    const message = ownObject(record, 'message');
    if (!message) return;
    const usage = ownObject(message, 'usage');
    if (!usage) return;
    const key = ownString(record, 'requestId') ?? ownString(message, 'id');
    if (!key) return;
    usageByKey.set(key, {
      inputTokens: ownNumber(usage, 'input_tokens'),
      cacheCreationInputTokens: ownNumber(usage, 'cache_creation_input_tokens'),
      cacheReadInputTokens: ownNumber(usage, 'cache_read_input_tokens'),
      outputTokens: ownNumber(usage, 'output_tokens'),
    });
  });

  let usage: ClaudeUsageTotals | null = null;
  if (usageByKey.size > 0) {
    usage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
    for (const v of usageByKey.values()) {
      usage.inputTokens += v.inputTokens;
      usage.cacheCreationInputTokens += v.cacheCreationInputTokens;
      usage.cacheReadInputTokens += v.cacheReadInputTokens;
      usage.outputTokens += v.outputTokens;
    }
  }

  const sessionId = basename(file).replace(/\.jsonl$/, '');
  return {
    host: 'claude',
    sessionId,
    file,
    cwd,
    originator: 'claude-code',
    originLabel: 'claude-code',
    proofOrStopCwd: isProofOrStopCwdHint(cwd),
    firstTimestamp,
    lastTimestamp,
    usage,
    storyMentions: [...storyMentions].sort(),
    parseErrors,
  };
}

// ── Report aggregation (deterministic; no Date.now inside) ───────────────────

/** Normalized comparable token metric for sorting/rollups (0 when usage unknown). */
export function rowTotalTokens(row: SweepSessionRow): number {
  if (!row.usage) return 0;
  if (row.host === 'codex') {
    const u = row.usage as CodexUsageTotals;
    // input already includes cached; reasoning is a subset of output.
    return u.inputTokens + u.outputTokens;
  }
  const u = row.usage as ClaudeUsageTotals;
  return u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens + u.outputTokens;
}

export interface CodexHostTotals {
  sessions: number;
  sessionsWithUsage: number;
  sessionsUnknownUsage: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ClaudeHostTotals {
  sessions: number;
  sessionsWithUsage: number;
  sessionsUnknownUsage: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export interface SweepBucket {
  sessionCount: number;
  totalTokens: number;
  codex: CodexHostTotals;
  claude: ClaudeHostTotals;
}

export interface SweepPerStoryRollup extends SweepBucket {
  storyId: string;
  /**
   * True when at least one contributing session mentioned MORE THAN ONE story,
   * so this story's totals are shared (multi-attributed), not exclusive.
   */
  multiAttribution: boolean;
}

export interface SweepReport {
  schemaVersion: typeof USAGE_SWEEP_SCHEMA;
  label: 'NON-AUTHORITATIVE ESTIMATE';
  since: string | null;
  sinceMs: number | null;
  sessionCount: number;
  parseErrorTotal: number;
  sessions: SweepSessionRow[];
  perStory: SweepPerStoryRollup[];
  unattributed: SweepBucket;
  grandTotals: { codex: CodexHostTotals; claude: ClaudeHostTotals };
}

/** Remove native host ids and transcript paths from every outward report row. */
export function projectSweepReportForOutput(
  report: SweepReport,
  projectRoot: string,
): SweepReport {
  return {
    ...report,
    sessions: report.sessions.map(row => projectSweepSessionRowForOutput(row, projectRoot)),
  };
}

function emptyCodexTotals(): CodexHostTotals {
  return {
    sessions: 0,
    sessionsWithUsage: 0,
    sessionsUnknownUsage: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function emptyClaudeTotals(): ClaudeHostTotals {
  return {
    sessions: 0,
    sessionsWithUsage: 0,
    sessionsUnknownUsage: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
}

function emptyBucket(): SweepBucket {
  return { sessionCount: 0, totalTokens: 0, codex: emptyCodexTotals(), claude: emptyClaudeTotals() };
}

function accumulateBucket(bucket: SweepBucket, row: SweepSessionRow): void {
  bucket.sessionCount += 1;
  bucket.totalTokens += rowTotalTokens(row);
  if (row.host === 'codex') {
    const t = bucket.codex;
    t.sessions += 1;
    if (row.usage) {
      t.sessionsWithUsage += 1;
      const u = row.usage as CodexUsageTotals;
      t.inputTokens += u.inputTokens;
      t.cachedInputTokens += u.cachedInputTokens;
      t.uncachedInputTokens += u.uncachedInputTokens;
      t.outputTokens += u.outputTokens;
      t.reasoningOutputTokens += u.reasoningOutputTokens;
    } else {
      t.sessionsUnknownUsage += 1;
    }
  } else {
    const t = bucket.claude;
    t.sessions += 1;
    if (row.usage) {
      t.sessionsWithUsage += 1;
      const u = row.usage as ClaudeUsageTotals;
      t.inputTokens += u.inputTokens;
      t.cacheCreationInputTokens += u.cacheCreationInputTokens;
      t.cacheReadInputTokens += u.cacheReadInputTokens;
      t.outputTokens += u.outputTokens;
    } else {
      t.sessionsUnknownUsage += 1;
    }
  }
}

export interface BuildSweepReportOptions {
  /** Display label of the cutoff (ISO / shorthand) recorded in the report. */
  since?: string | null;
  /** Numeric cutoff (epoch ms) recorded in the report. */
  sinceMs?: number | null;
}

/**
 * Aggregate scanned rows into a deterministic report. A session's totals are
 * counted into EACH mentioned story (multi-attribution marked), so per-story
 * sums intentionally overlap; sessions with no story mention go to the
 * `unattributed` bucket. Never calls Date.now — the caller stamps generatedAt.
 */
export function buildSweepReport(
  rows: SweepSessionRow[],
  options: BuildSweepReportOptions = {},
): SweepReport {
  const sessions = [...rows].sort((a, b) => {
    const diff = rowTotalTokens(b) - rowTotalTokens(a);
    if (diff !== 0) return diff;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  const grandCodex = emptyCodexTotals();
  const grandClaude = emptyClaudeTotals();
  const perStoryMap = new Map<string, SweepPerStoryRollup>();
  const unattributed = emptyBucket();
  let parseErrorTotal = 0;

  for (const row of rows) {
    parseErrorTotal += row.parseErrors;
    // Grand totals (each session counted once).
    accumulateBucket(
      { sessionCount: 0, totalTokens: 0, codex: grandCodex, claude: grandClaude },
      row,
    );

    if (row.storyMentions.length === 0) {
      accumulateBucket(unattributed, row);
      continue;
    }
    const multi = row.storyMentions.length > 1;
    for (const storyId of row.storyMentions) {
      let rollup = perStoryMap.get(storyId);
      if (!rollup) {
        rollup = { storyId, multiAttribution: false, ...emptyBucket() };
        perStoryMap.set(storyId, rollup);
      }
      if (multi) rollup.multiAttribution = true;
      accumulateBucket(rollup, row);
    }
  }

  const perStory = [...perStoryMap.values()].sort((a, b) => {
    const diff = b.totalTokens - a.totalTokens;
    if (diff !== 0) return diff;
    return a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0;
  });

  return {
    schemaVersion: USAGE_SWEEP_SCHEMA,
    label: 'NON-AUTHORITATIVE ESTIMATE',
    since: options.since ?? null,
    sinceMs: options.sinceMs ?? null,
    sessionCount: rows.length,
    parseErrorTotal,
    sessions,
    perStory,
    unattributed,
    grandTotals: { codex: grandCodex, claude: grandClaude },
  };
}

// ── since parsing + hardened --out fence (injectable clock/root) ─────────────

export interface ParsedSince {
  sinceMs: number;
  label: string;
}

/**
 * Parse a since argument into an epoch-ms cutoff. Accepts:
 *   - `<N>d` shorthand      → nowMs - N*86400000
 *   - `YYYY-MM-DD`          → that date at UTC midnight
 *   - any Date-parseable ISO datetime
 * Throws on an unparseable value. nowMs is injected for determinism.
 */
export function parseSinceToMs(raw: string, nowMs: number): ParsedSince {
  const value = raw.trim();
  if (value.length === 0) throw new Error('usage_sweep: --since is required (YYYY-MM-DD, ISO datetime, or <N>d)');

  const dayMatch = /^(\d+)d$/i.exec(value);
  if (dayMatch) {
    const days = Number.parseInt(dayMatch[1], 10);
    return { sinceMs: nowMs - days * 86_400_000, label: `${days}d (last ${days} days)` };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(ms)) throw new Error(`usage_sweep: unparseable --since date "${raw}"`);
    return { sinceMs: ms, label: value };
  }

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`usage_sweep: unparseable --since "${raw}" (expected YYYY-MM-DD, ISO datetime, or <N>d)`);
  }
  return { sinceMs: ms, label: value };
}

/** Typed refusal reasons for the hardened --out fence (F-010). */
export type UsageSweepOutErrorCode =
  | 'empty'
  | 'absolute'
  | 'outside-root'
  | 'symlink-ancestor'
  | 'ancestor-not-dir'
  | 'already-exists';

export class UsageSweepOutError extends Error {
  readonly code: UsageSweepOutErrorCode;
  constructor(code: UsageSweepOutErrorCode, message: string) {
    super(message);
    this.name = 'UsageSweepOutError';
    this.code = code;
  }
}

/** A validated, exclusively created --out report file. Caller writes fd, then closes it. */
export interface ReportOutFile {
  /** Fully validated absolute path of the newly created report file. */
  absPath: string;
  /** Descriptor opened with the exclusive-create 'wx' flag (O_CREAT|O_EXCL). */
  fd: number;
}

/** True when `rel` (a path.relative result) points at or outside the base. */
function escapesBase(rel: string): boolean {
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * F-010 hardened --out fence. Validates a report path and CREATES it
 * exclusively; the usage sweep can never overwrite an existing file or write
 * outside the project root. Rules, in order:
 *
 *   1. --out must be a RELATIVE path (absolute paths are refused outright).
 *   2. The lexical resolution against `root` must stay inside root (no '..'
 *      traversal past root; the root itself is not a valid report file).
 *   3. Every EXISTING ancestor directory below root is lstat'ed: symlinks are
 *      refused (an inside-root symlink must not redirect the write), and a
 *      non-directory ancestor is refused. After realpath of the deepest
 *      existing ancestor, the target must STILL land inside the realpath'd
 *      root (catches symlink chains above the deepest missing segment).
 *   4. Missing trailing directories are created only AFTER those checks pass.
 *   5. The file itself is opened with the exclusive-create 'wx' flag, so the
 *      never-overwrite guarantee is atomic (open fails with EEXIST even when
 *      the existing path is a symlink — O_EXCL does not follow it).
 *
 * Returns the validated absolute path plus the open fd; throws
 * UsageSweepOutError with a typed code on any refusal.
 */
export function openReportFileExclusive(root: string, out: string): ReportOutFile {
  const trimmed = out.trim();
  if (trimmed.length === 0) {
    throw new UsageSweepOutError('empty', 'usage_sweep: --out path is empty');
  }
  if (isAbsolute(trimmed)) {
    throw new UsageSweepOutError(
      'absolute',
      `usage_sweep: --out "${out}" is an absolute path; --out must be a RELATIVE path inside the project root ` +
        '(it only ever CREATES a new report file there; it never overwrites).',
    );
  }

  const rootResolved = resolve(root);
  const target = resolve(rootResolved, trimmed);
  if (escapesBase(relative(rootResolved, target))) {
    throw new UsageSweepOutError(
      'outside-root',
      `usage_sweep: --out "${out}" resolves to "${target}", which is outside the project root "${root}"; refusing to write. ` +
        'Pass a relative path inside the project (the sweep only ever writes when --out is given).',
    );
  }

  // Walk every EXISTING ancestor directory strictly below root.
  const parent = dirname(target);
  const relDir = relative(rootResolved, parent);
  const segments = relDir === '' ? [] : relDir.split(sep);
  let current = rootResolved;
  let deepestExisting = rootResolved;
  for (const segment of segments) {
    current = join(current, segment);
    let st: Stats | null = null;
    try {
      st = lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (st === null) break; // first missing segment: the rest cannot exist either
    if (st.isSymbolicLink()) {
      throw new UsageSweepOutError(
        'symlink-ancestor',
        `usage_sweep: --out "${out}" traverses "${current}", which is a symlink; refusing to write through symlinked ancestors.`,
      );
    }
    if (!st.isDirectory()) {
      throw new UsageSweepOutError(
        'ancestor-not-dir',
        `usage_sweep: --out "${out}" traverses "${current}", which exists but is not a directory.`,
      );
    }
    deepestExisting = current;
  }

  // Realpath containment: resolve the deepest EXISTING ancestor (and the root
  // itself) and require the target to still land inside the real root.
  const realRoot = realpathSync(rootResolved);
  const realDeepest = realpathSync(deepestExisting);
  const realTarget = resolve(realDeepest, relative(deepestExisting, target));
  if (escapesBase(relative(realRoot, realTarget))) {
    throw new UsageSweepOutError(
      'outside-root',
      `usage_sweep: --out "${out}" resolves (after symlinks) to "${realTarget}", which is outside the real project root "${realRoot}"; refusing to write.`,
    );
  }

  // Only AFTER validation may missing trailing directories be created.
  if (deepestExisting !== parent) mkdirSync(parent, { recursive: true });

  let fd: number;
  try {
    fd = openSync(target, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new UsageSweepOutError(
        'already-exists',
        `usage_sweep: --out "${out}" already exists at "${target}"; usage_sweep never overwrites — pass a path to a NEW report file.`,
      );
    }
    throw err;
  }
  return { absPath: target, fd };
}
