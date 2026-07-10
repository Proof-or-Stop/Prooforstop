/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: the host-run choke point.
 *
 * `runHostRun` is the single core entry that LAUNCHES a canonical reviewer/quorum
 * host (codex / claude / agy) via the B-d8ef canonical launcher argv AND writes
 * the usage-ledger preflight + final rows (bound to storyId / phase / agentType /
 * provider, plus reviewRunId -> threadId and lane -> subagentId), enforcing the
 * per-dispatch hard-budget cap and the host-run concurrency cap BEFORE the spawn.
 *
 * Design:
 *   - PURE-ISH CORE with an INJECTED runner (like providers/*-cli.ts) so smokes
 *     drive it with fake hosts and no real subprocess. The default runner is a
 *     piped spawnSync; the HANDLER (not this core) echoes captured stdout.
 *   - The ledger seam mirrors runClaudeCodeRealLeafDispatch (lattice-dispatch.ts):
 *     preflight estimate (sequence 1) -> budget guard -> concurrency guard ->
 *     spawn -> provider/unavailable final (sequence 2, supersedes the estimate).
 *     Every ledger call is fail-open (never throws to the caller).
 *   - LATTICE_USAGE_LEDGER=0 keeps the run byte-identical: no preflight, no budget
 *     guard, no concurrency slots (no dirs), no final — just build argv + spawn.
 *   - This core imports the usage seam ONLY through usage-ledger/dispatch-usage.js
 *     (the single thin import surface); it never reaches into other ledger modules.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalReviewHostLauncherSpec,
  materializeLauncherArgv,
  type CanonicalReviewHost,
} from './host-execution-readiness.js';
import {
  isUsageLedgerEnabled,
  parseClaudeCliOutput,
  recordBudgetBlock,
  recordConcurrencyBlock,
  recordDispatchFinal,
  recordDispatchFinalCodex,
  recordDispatchPreflight,
  recordDispatchUnavailableFinal,
  type DispatchPreflightHandle,
  type DispatchUsageContext,
  type DispatchUsageOptions,
} from './usage-ledger/dispatch-usage.js';

export type HostRunHost = CanonicalReviewHost;

/** The plan handed to the injected runner (or the default spawnSync runner). */
export interface HostRunSpawnPlan {
  /** Executable name (host command: codex / claude / agy). */
  command: string;
  /** Args passed to the executable (argv WITHOUT the leading command token). */
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** The absolute prompt-file path for claude (informational; runner reads argv). */
  promptFile?: string;
}

/** What the injected runner returns after the host run completes. */
export interface HostRunSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export type HostRunRunner = (plan: HostRunSpawnPlan) => HostRunSpawnResult;

export interface HostRunArgs {
  host: HostRunHost;
  storyId: string | null;
  agentType: string;
  /** When omitted and storyId is set, resolved from the story index; else 'adhoc'. */
  phase?: string;
  promptText: string;
  /** Optional label for diagnostics only (never stored raw). */
  promptLabel?: string;
  reviewRunId?: string | null;
  lane?: string | null;
  timeoutMs?: number;
  /** agy --print-timeout override (e.g. '30m'); must match /^\d+[smh]$/. */
  agyPrintTimeout?: string;
  env: NodeJS.ProcessEnv;
  root: string;
  recordedAt: string;
  projectRootHash: string;
}

export interface HostRunDeps {
  /** Injected runner (default: piped spawnSync). */
  runner?: HostRunRunner;
}

/** A compact description of what the ledger recorded for this run. */
export interface HostRunUsageSummary {
  recorded: 'provider-reported' | 'unavailable' | 'blocked' | 'disabled' | 'none';
  provider: string | null;
  input: number | null;
  cacheRead: number | null;
  output: number | null;
  recordId: string | null;
  reason: string | null;
}

export interface HostRunResult {
  host: HostRunHost;
  storyId: string | null;
  phase: string;
  agentType: string;
  /** True once the host runner was invoked (false for a pre-spawn refusal). */
  spawned: boolean;
  /** True for a cap refusal (budget or concurrency). */
  blocked: boolean;
  /** 'hard_budget_exceeded' | 'concurrency_cap_exceeded' | null. */
  refusalReason: string | null;
  /** Live host-run descriptors for a concurrency refusal (else null). */
  liveRuns: HostRunLiveDescriptor[] | null;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  usageSummary: HostRunUsageSummary;
}

/** Nonzero process-exit sentinel for a fail-closed cap refusal. */
export const HOST_RUN_REFUSAL_EXIT_CODE = 3;

const STORY_ACTIVES_RELATIVE = join('.lattice', 'story', 'actives');
const HOST_RUN_SLOTS_RELATIVE = join('.lattice', 'usage', 'host-run-slots');

export const HOST_RUN_MAX_CONCURRENT_DEFAULT = 4;
/** Staleness backstop: a slot older than this is reclaimed even if its pid probe is ambiguous. */
const HOST_RUN_SLOT_STALE_MS_DEFAULT = 6 * 60 * 60 * 1000; // 6h

// ---------------------------------------------------------------------------
// Attribution / phase resolution
// ---------------------------------------------------------------------------

/** The canonical ledger host.kind for each launcher host. */
function ledgerHostKind(host: HostRunHost): string {
  return host === 'codex' ? 'codex' : host === 'claude' ? 'claude-code' : 'antigravity';
}

/**
 * Resolve the attribution phase. When storyId is set, the story index MUST exist
 * (unknown storyId fails fast, pre-spawn); phase comes from an explicit arg else
 * the story's current phase. When storyId is null, the run is adhoc.
 */
function resolvePhase(root: string, storyId: string | null, explicitPhase: string | undefined): string {
  if (storyId === null) {
    return explicitPhase && explicitPhase.length > 0 ? explicitPhase : 'adhoc';
  }
  const indexPath = join(root, STORY_ACTIVES_RELATIVE, storyId, 'index.json');
  let raw: string;
  try {
    raw = readFileSync(indexPath, 'utf8');
  } catch {
    throw new Error(`host_run: unknown story "${storyId}" (no ${STORY_ACTIVES_RELATIVE}/${storyId}/index.json); refuse pre-spawn`);
  }
  if (explicitPhase && explicitPhase.length > 0) return explicitPhase;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && Object.prototype.hasOwnProperty.call(parsed, 'phase')) {
      const phase = (parsed as Record<string, unknown>).phase;
      if (typeof phase === 'string' && phase.length > 0) return phase;
    }
  } catch {
    // fall through to a defensive default
  }
  return 'adhoc';
}

/**
 * Validate the reviewRunId binding: when both storyId and reviewRunId are given,
 * the reviewRunId MUST start with `<storyId>:` so a ledger row cannot silently
 * mis-join a cross-story review run. Refused pre-spawn.
 */
function assertReviewRunIdBinding(storyId: string | null, reviewRunId: string | null | undefined): void {
  if (!reviewRunId) return;
  if (storyId && !reviewRunId.startsWith(`${storyId}:`)) {
    throw new Error(
      `host_run: reviewRunId "${reviewRunId}" does not belong to story "${storyId}" ` +
      `(a reviewRunId must be "<storyId>:..."); refuse pre-spawn to avoid a cross-story ledger mis-join`,
    );
  }
}

// ---------------------------------------------------------------------------
// Concurrency slot registry (CHK-007b)
// ---------------------------------------------------------------------------

export interface HostRunLiveDescriptor {
  pid: number;
  startedAt: string;
  host: string;
  storyId: string | null;
  agentType: string;
}

interface SlotMeta {
  pid: number;
  startedAt: string;
  host: string;
  storyId: string | null;
  agentType: string;
}

/** Absolute host-run slot registry dir under a project root. */
export function hostRunSlotsDir(root: string): string {
  return join(root, HOST_RUN_SLOTS_RELATIVE);
}

/** Resolve the concurrency cap; invalid / <=0 / unset falls back to the default. */
export function resolveMaxConcurrent(env: NodeJS.ProcessEnv): number {
  const raw = env.LATTICE_HOST_RUN_MAX_CONCURRENT;
  if (typeof raw !== 'string' || raw.trim().length === 0) return HOST_RUN_MAX_CONCURRENT_DEFAULT;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return HOST_RUN_MAX_CONCURRENT_DEFAULT;
  return value;
}

function resolveSlotStaleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.LATTICE_HOST_RUN_SLOT_STALE_MS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return HOST_RUN_SLOT_STALE_MS_DEFAULT;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return HOST_RUN_SLOT_STALE_MS_DEFAULT;
  return value;
}

/** True when the pid is (or may be) a running process. ESRCH => dead; EPERM => alive. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function ownString(obj: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

function ownNumber(obj: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const value = obj[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Scan the slot registry: reclaim (unlink) any slot whose pid is dead or whose
 * mtime is older than the staleness window, and return the live descriptors.
 * A missing dir yields an empty list (no dir is created here).
 */
export function scanLiveSlots(dir: string, now: number, staleMs: number): HostRunLiveDescriptor[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const live: HostRunLiveDescriptor[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const pid = ownNumber(meta, 'pid');
    const ageMs = now - mtimeMs;
    const staleByTime = !Number.isFinite(ageMs) || ageMs > staleMs;
    const deadPid = pid === null || !isPidAlive(pid);
    if (deadPid || staleByTime) {
      try {
        unlinkSync(file);
      } catch {
        // Best-effort reclaim; a racing reclaim by another run is fine.
      }
      continue;
    }
    live.push({
      pid,
      startedAt: ownString(meta, 'startedAt') ?? '',
      host: ownString(meta, 'host') ?? '',
      storyId: ownString(meta, 'storyId'),
      agentType: ownString(meta, 'agentType') ?? '',
    });
  }
  return live;
}

/**
 * Attempt an ATOMIC exclusive create of a slot file (`wx` flag). Returns true when
 * this call created the file, false when the file already existed (the race
 * loser). Other fs errors propagate (an unwritable registry is a real failure).
 * The file content is metadata only and is NEVER copied into a ledger row.
 */
export function writeSlotFileExclusive(file: string, meta: SlotMeta): boolean {
  try {
    writeFileSync(file, JSON.stringify(meta), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
}

let slotSequence = 0;

/** Acquire a fresh slot (unique `<pid>-<monotonic>.json`), creating the dir. */
function acquireSlot(dir: string, meta: SlotMeta): string {
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt++) {
    const name = `${meta.pid}-${Date.now().toString(36)}-${(slotSequence++).toString(36)}-${randomUUID().slice(0, 8)}.json`;
    const file = join(dir, name);
    if (writeSlotFileExclusive(file, meta)) return file;
  }
  throw new Error('host_run: could not acquire a concurrency slot after retries');
}

function releaseSlot(file: string | null): void {
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    // Best-effort release; the staleness backstop reclaims a leaked slot.
  }
}

// ---------------------------------------------------------------------------
// Codex turn.completed usage scan (CHK-001)
// ---------------------------------------------------------------------------

/**
 * Scan codex `exec --json` stdout for the LAST `{"type":"turn.completed",
 * "usage":{...}}` event and return its raw usage object (own-property guarded),
 * or null when no turn.completed usage event is present. Line-streamed with a
 * BOUNDED parse buffer: only the current line and the last usage object are held,
 * so a flooding host cannot accumulate per-line state.
 */
export function scanCodexTurnCompletedUsage(stdout: string): unknown | null {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  let last: unknown = null;
  let index = 0;
  const len = stdout.length;
  while (index <= len) {
    let newline = stdout.indexOf('\n', index);
    if (newline === -1) newline = len;
    const line = stdout.slice(index, newline).trim();
    index = newline + 1;
    if (line.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const event = parsed as Record<string, unknown>;
        const type = Object.prototype.hasOwnProperty.call(event, 'type') ? event.type : undefined;
        if (type === 'turn.completed') {
          const usage = Object.prototype.hasOwnProperty.call(event, 'usage') ? event.usage : undefined;
          if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
            last = usage;
          }
        }
      }
    }
    if (newline === len) break;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Default runner
// ---------------------------------------------------------------------------

function defaultHostRunRunner(plan: HostRunSpawnPlan): HostRunSpawnResult {
  const result = spawnSync(plan.command, plan.argv, {
    cwd: plan.cwd,
    env: plan.env,
    encoding: 'utf8',
    timeout: plan.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input: '',
  });
  const timedOut =
    (!!result.error && /ETIMEDOUT|timed?\s*out/i.test(String(result.error.message))) ||
    result.signal === 'SIGTERM' ||
    result.signal === 'SIGKILL';
  const exitCode = typeof result.status === 'number' ? result.status : timedOut ? 124 : 1;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// Argv materialization (writes the claude prompt file when needed)
// ---------------------------------------------------------------------------

interface MaterializedLaunch {
  command: string;
  argv: string[];
  promptFile?: string;
  cleanup: () => void;
}

function materializeLaunch(args: HostRunArgs): MaterializedLaunch {
  const spec = canonicalReviewHostLauncherSpec(args.host);
  if (args.host === 'claude') {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-host-run-'));
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, args.promptText, { encoding: 'utf8', mode: 0o600 });
    const full = materializeLauncherArgv(spec, { promptFile });
    return {
      command: full[0],
      argv: full.slice(1),
      promptFile,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  const full = materializeLauncherArgv(spec, { prompt: args.promptText, agyPrintTimeout: args.agyPrintTimeout });
  return { command: full[0], argv: full.slice(1), cleanup: () => {} };
}

// ---------------------------------------------------------------------------
// runHostRun
// ---------------------------------------------------------------------------

function disabledSummary(): HostRunUsageSummary {
  return { recorded: 'disabled', provider: null, input: null, cacheRead: null, output: null, recordId: null, reason: null };
}

/**
 * Launch a canonical host and write the usage-ledger rows. See file header for
 * the full seam ordering. Input-validation failures (unknown story, cross-story
 * reviewRunId) THROW pre-spawn; cap refusals return a blocked result (a ledger
 * blocked row is written) with a nonzero exit and NO spawn.
 */
export function runHostRun(args: HostRunArgs, deps: HostRunDeps = {}): HostRunResult {
  if (args.host !== 'codex' && args.host !== 'claude' && args.host !== 'agy') {
    throw new Error(`host_run: unsupported host "${String(args.host)}" (expected codex | claude | agy)`);
  }
  if (typeof args.promptText !== 'string' || args.promptText.length === 0) {
    throw new Error('host_run: promptText is required (empty prompt refused pre-spawn)');
  }

  const runner = deps.runner ?? defaultHostRunRunner;
  const phase = resolvePhase(args.root, args.storyId, args.phase);
  assertReviewRunIdBinding(args.storyId, args.reviewRunId);

  const ctx: DispatchUsageContext = {
    storyId: args.storyId,
    phase,
    agentType: args.agentType,
    subagentId: args.lane ?? null,
    threadId: args.reviewRunId ?? null,
  };
  const opts: DispatchUsageOptions = {
    recordedAt: args.recordedAt,
    projectRootHash: args.projectRootHash,
    command: `host_run:${args.host}`,
    host: { kind: ledgerHostKind(args.host) },
    env: args.env,
  };

  const ledgerOn = isUsageLedgerEnabled(args.env);

  // OFF path: byte-identical to a raw launch — no preflight, no caps (no dirs), no
  // final. Just materialize argv + spawn + return.
  if (!ledgerOn) {
    const launch = materializeLaunch(args);
    let spawn: HostRunSpawnResult;
    try {
      spawn = runner({ command: launch.command, argv: launch.argv, env: args.env, timeoutMs: args.timeoutMs, promptFile: launch.promptFile });
    } finally {
      launch.cleanup();
    }
    return {
      host: args.host,
      storyId: args.storyId,
      phase,
      agentType: args.agentType,
      spawned: true,
      blocked: false,
      refusalReason: null,
      liveRuns: null,
      exitCode: spawn.exitCode,
      timedOut: spawn.timedOut,
      stdout: spawn.stdout,
      stderr: spawn.stderr,
      usageSummary: disabledSummary(),
    };
  }

  // ---- Ledger ON: preflight -> budget guard -> concurrency guard -> spawn -> final.
  let handle: DispatchPreflightHandle | null = null;
  try {
    handle = recordDispatchPreflight(args.root, ctx, args.promptText, opts);
  } catch {
    handle = null;
  }

  // CHK-007a: hard-budget cap (fail-closed BEFORE spawn).
  const budget = recordBudgetBlock(args.root, ctx, handle, args.promptText, opts);
  if (budget.blocked) {
    return {
      host: args.host,
      storyId: args.storyId,
      phase,
      agentType: args.agentType,
      spawned: false,
      blocked: true,
      refusalReason: 'hard_budget_exceeded',
      liveRuns: null,
      exitCode: HOST_RUN_REFUSAL_EXIT_CODE,
      timedOut: false,
      stdout: '',
      stderr: '',
      usageSummary: {
        recorded: 'blocked',
        provider: null,
        input: null,
        cacheRead: null,
        output: null,
        recordId: null,
        reason: `hard_budget_exceeded (${budget.budgetPolicyId ?? 'hard-budget'}${
          budget.hardBudgetTokens !== null ? `, cap ${budget.hardBudgetTokens}` : ''
        })`,
      },
    };
  }

  // CHK-007b: concurrency cap (fail-closed BEFORE spawn). Slot registry is only
  // touched when the ledger is ON (keeps the OFF path dir-free).
  const dir = hostRunSlotsDir(args.root);
  const cap = resolveMaxConcurrent(args.env);
  const staleMs = resolveSlotStaleMs(args.env);
  const live = scanLiveSlots(dir, Date.now(), staleMs);
  if (live.length >= cap) {
    const blockRow = recordConcurrencyBlock(args.root, ctx, handle, args.promptText, cap, opts);
    return {
      host: args.host,
      storyId: args.storyId,
      phase,
      agentType: args.agentType,
      spawned: false,
      blocked: true,
      refusalReason: 'concurrency_cap_exceeded',
      liveRuns: live,
      exitCode: HOST_RUN_REFUSAL_EXIT_CODE,
      timedOut: false,
      stdout: '',
      stderr: '',
      usageSummary: {
        recorded: 'blocked',
        provider: null,
        input: null,
        cacheRead: null,
        output: null,
        recordId: blockRow.recordId,
        reason: `concurrency_cap_exceeded (${live.length} live host runs, cap ${cap})`,
      },
    };
  }

  const slotMeta: SlotMeta = {
    pid: process.pid,
    startedAt: args.recordedAt,
    host: args.host,
    storyId: args.storyId,
    agentType: args.agentType,
  };
  const slotFile = acquireSlot(dir, slotMeta);

  const launch = materializeLaunch(args);
  let spawn: HostRunSpawnResult;
  try {
    spawn = runner({ command: launch.command, argv: launch.argv, env: args.env, timeoutMs: args.timeoutMs, promptFile: launch.promptFile });
  } finally {
    launch.cleanup();
    releaseSlot(slotFile);
  }

  const summary = recordFinalForHost(args, ctx, handle, opts, spawn.stdout);

  return {
    host: args.host,
    storyId: args.storyId,
    phase,
    agentType: args.agentType,
    spawned: true,
    blocked: false,
    refusalReason: null,
    liveRuns: null,
    exitCode: spawn.exitCode,
    timedOut: spawn.timedOut,
    stdout: spawn.stdout,
    stderr: spawn.stderr,
    usageSummary: summary,
  };
}

/** Record the per-host provider/unavailable final and describe it for the caller. */
function recordFinalForHost(
  args: HostRunArgs,
  ctx: DispatchUsageContext,
  handle: DispatchPreflightHandle | null,
  opts: DispatchUsageOptions,
  stdout: string,
): HostRunUsageSummary {
  const correlation = handle?.correlation ?? null;
  const estimateRecordId = handle?.estimateRecordId ?? null;

  try {
    if (args.host === 'claude') {
      const parsed = parseClaudeCliOutput(stdout);
      recordDispatchFinal(args.root, ctx, correlation, estimateRecordId, parsed.anthropicUsage, parsed.model, opts);
      if (parsed.anthropicUsage) {
        return {
          recorded: 'provider-reported',
          provider: 'anthropic',
          input: numOrNull(parsed.anthropicUsage.input_tokens),
          cacheRead: numOrNull(parsed.anthropicUsage.cache_read_input_tokens),
          output: numOrNull(parsed.anthropicUsage.output_tokens),
          recordId: null,
          reason: null,
        };
      }
      return {
        recorded: 'unavailable',
        provider: 'anthropic',
        input: null,
        cacheRead: null,
        output: null,
        recordId: null,
        reason: 'claude output carried no usage envelope',
      };
    }

    if (args.host === 'codex') {
      const usage = scanCodexTurnCompletedUsage(stdout);
      if (usage === null) {
        const res = recordDispatchUnavailableFinal(
          args.root,
          ctx,
          correlation,
          estimateRecordId,
          { name: 'openai', model: null },
          'no_turn_completed_usage_event',
          opts,
        );
        return {
          recorded: 'unavailable',
          provider: 'openai',
          input: null,
          cacheRead: null,
          output: null,
          recordId: res.recordId,
          reason: 'no_turn_completed_usage_event',
        };
      }
      const codex = recordDispatchFinalCodex(args.root, ctx, correlation, estimateRecordId, usage, null, opts);
      if (codex.source === 'provider-reported') {
        return {
          recorded: 'provider-reported',
          provider: 'openai',
          input: numOrNull(codex.mapped?.input),
          cacheRead: numOrNull(codex.mapped?.cacheRead),
          output: numOrNull(codex.mapped?.output),
          recordId: codex.recordId,
          reason: null,
        };
      }
      return {
        recorded: 'unavailable',
        provider: 'openai',
        input: null,
        cacheRead: null,
        output: null,
        recordId: codex.recordId,
        reason: codex.unavailableReason,
      };
    }

    // agy: no usage surface — always an unavailable final.
    const res = recordDispatchUnavailableFinal(
      args.root,
      ctx,
      correlation,
      estimateRecordId,
      { name: 'antigravity', model: null },
      'agy_print_mode_reports_no_usage',
      opts,
    );
    return {
      recorded: 'unavailable',
      provider: 'antigravity',
      input: null,
      cacheRead: null,
      output: null,
      recordId: res.recordId,
      reason: 'agy_print_mode_reports_no_usage',
    };
  } catch {
    // The seam never throws to the run; a final-record failure degrades the summary.
    return { recorded: 'none', provider: null, input: null, cacheRead: null, output: null, recordId: null, reason: 'ledger final skipped (non-fatal)' };
  }
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whether the slot registry dir currently exists (test/diagnostic helper). */
export function hostRunSlotsDirExists(root: string): boolean {
  return existsSync(hostRunSlotsDir(root));
}
