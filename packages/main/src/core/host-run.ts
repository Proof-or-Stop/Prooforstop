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
 *     drive it with fake hosts and no real subprocess. The default PRODUCTION
 *     runner is an ASYNC child_process.spawn that PASSES HOST OUTPUT THROUGH LIVE
 *     (F-006): stdout/stderr chunks reach the injected `passthrough` sink as they
 *     arrive, and only BOUNDED state is retained for usage parsing (the last
 *     usage-bearing line — codex turn.completed / the claude result envelope —
 *     capped per line, with an honest truncation flag so a truncated retention
 *     records `unavailable` and never a fabricated or stale value). B-3ddc adds
 *     a SECOND bounded lane with the same cap discipline: the last codex
 *     turn.failed / terminal `error` line is retained so a no-usage final can
 *     record the honest turn_failed(<digest>) reason instead of the generic
 *     no_turn_completed_usage_event (which stays the fallback); the usage lane
 *     and its truncation semantics are untouched. The core
 *     delivers host output to the passthrough EXACTLY ONCE (live for the
 *     streaming runner; a single buffered flush for a non-streaming fake
 *     runner), so the HANDLER never re-prints it.
 *   - F-005: this core keeps ZERO story-path/config knowledge. Phase + story
 *     existence are resolved through the injected `resolveStory` seam (the HANDLER
 *     builds it from the configured StoryStore); an explicit --phase is honored
 *     as-is WITHOUT consulting the store at all.
 *   - F-011: the host subprocess ALWAYS executes in the resolved project root
 *     (HostRunArgs.cwd — bound by the handler to the SAME root the ledger rows
 *     attribute), never the caller's process.cwd(); a missing cwd is refused
 *     pre-spawn, so execution and ledger attribution cannot diverge.
 *   - The ledger seam mirrors runClaudeCodeRealLeafDispatch (lattice-dispatch.ts):
 *     preflight estimate (sequence 1) -> budget guard -> concurrency guard ->
 *     spawn -> provider/unavailable final (sequence 2, supersedes the estimate).
 *     Every ledger call is fail-open (never throws to the caller).
 *   - LATTICE_USAGE_LEDGER=0 keeps the run byte-identical: no preflight, no budget
 *     guard, no concurrency slots (no dirs), no final — just build argv + spawn.
 *   - This core imports the usage seam ONLY through usage-ledger/dispatch-usage.js
 *     (the single thin import surface); it never reaches into other ledger modules.
 */

import { spawn } from 'node:child_process';
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

/** A single live output chunk from a host, as it arrives. */
export interface HostRunChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

/**
 * Live passthrough sink: the default streaming runner (via the core) forwards
 * every host chunk here as it arrives. The HANDLER supplies the real sink and
 * decides routing (text mode: stdout->process.stdout, stderr->process.stderr;
 * json mode: EVERYTHING->process.stderr so process.stdout stays clean for the
 * JSON result). The core default is a no-op so smokes stay quiet unless they
 * inject a recording sink.
 */
export type HostRunPassthrough = (chunk: HostRunChunk) => void;

/**
 * A predicate over a COMPLETE host output line: does this line carry the
 * usage-bearing event the default runner must retain for parsing? The streaming
 * runner keeps only the LAST line for which this returns true (bounded state).
 * When omitted (agy, which surfaces no usage) nothing is retained.
 */
export type HostRunUsageLineRetainer = (line: string) => boolean;

/** The plan handed to the injected runner (or the default streaming runner). */
export interface HostRunSpawnPlan {
  /** Executable name (host command: codex / claude / agy). */
  command: string;
  /** Args passed to the executable (argv WITHOUT the leading command token). */
  argv: string[];
  env: NodeJS.ProcessEnv;
  /**
   * F-011: the working directory the host subprocess MUST execute in — always
   * the resolved project root threaded from HostRunArgs.cwd, never the caller's
   * process.cwd(), so where the host actually runs cannot diverge from the root
   * the ledger rows attribute.
   */
  cwd: string;
  timeoutMs?: number;
  /** The absolute prompt-file path for claude (informational; runner reads argv). */
  promptFile?: string;
  /** The launcher host (lets the default runner pick the right usage-line scanner). */
  host?: HostRunHost;
  /** Which complete lines to retain for usage parsing (bounded, last-wins). */
  retainUsageLine?: HostRunUsageLineRetainer;
  /**
   * B-3ddc: which complete lines to retain in the SECOND bounded failure lane
   * (codex turn.failed / terminal `error`), same cap + last-wins discipline as
   * the usage lane. Omitted for hosts with no such failure surface.
   */
  retainFailureLine?: HostRunUsageLineRetainer;
  /** Live passthrough for host output chunks (the streaming runner calls this). */
  onChunk?: (chunk: HostRunChunk) => void;
}

/**
 * What the injected runner returns after the host run completes.
 *
 * NOTE (F-006): for the default STREAMING runner `stdout` is the BOUNDED
 * usage-parse text (the last retained usage-bearing line, capped) — NOT a full
 * transcript. The full transcript is delivered live via the passthrough. Fake
 * runners may still return the full buffered stdout (small in tests); the core
 * treats `stdout` uniformly as "the text to parse for usage", and both the codex
 * and claude parsers accept a single line or a multi-line buffer.
 */
export interface HostRunSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /**
   * True when an over-cap line was dropped AFTER (or without) the last retained
   * usage-bearing line (F-013/F-026: truncation is tracked RELATIVE to the
   * retained candidate). The usage final then records `unavailable` with reason
   * `usage_line_retention_truncated`, because the dropped line may have carried
   * the real final numbers and any retained text is then a stale parse target.
   * A drop FOLLOWED by a retained usage-bearing line clears the flag: even if
   * the dropped line carried usage, the LATER retained candidate supersedes it
   * (last-usage-wins), so the candidate is recorded honestly instead of being
   * poisoned by an unrelated earlier over-cap line.
   */
  retentionTruncated?: boolean;
  /**
   * B-3ddc: the retained failure line from the second bounded lane ('' when
   * none was retained). Fake runners may omit it — the core then falls back to
   * scanning their buffered stdout for failure events. When the failure lane
   * dropped an over-cap line AFTER (or without) this retained candidate the
   * companion `failureRetentionTruncated` flag is set and this text is
   * known-stale: recordFinalForHost then refuses to scan it (see below).
   */
  failureText?: string;
  /**
   * B-3ddc (codex round-1 F1): true when the SECOND (failure) bounded lane
   * dropped an over-cap line AFTER (or without) its retained failure candidate,
   * mirroring the usage lane's `retentionTruncated` (F-013/F-026) EXACTLY. When
   * true the streaming `failureText` is UNTRUSTED — the dropped line may have
   * superseded the retained failure line — so recordFinalForHost must NOT scan
   * it and the codex no-usage reason honestly degrades to the generic
   * no_turn_completed_usage_event fallback rather than a possibly stale
   * turn_failed(<digest>). A drop FOLLOWED by a retained failure line clears it
   * (last-wins supersedes, F-026). DISTINCT from `retentionTruncated` (the usage
   * lane), which still has ABSOLUTE priority: it forces the whole final to
   * unavailable before the failure lane is ever consulted.
   */
  failureRetentionTruncated?: boolean;
  /**
   * F-008: non-null when the live passthrough sink threw (e.g. EPIPE after the
   * consumer closed the pipe). Delivery stopped at the FIRST failure (no
   * per-chunk retry) but the run itself completed and usage scanning continued;
   * the message surfaces the degradation honestly instead of crashing the run.
   */
  passthroughError?: string | null;
}

export type HostRunRunner = (plan: HostRunSpawnPlan) => HostRunSpawnResult | Promise<HostRunSpawnResult>;

/** Story metadata the core needs for phase attribution (resolved by the handler). */
export interface HostRunStoryMeta {
  /** The story's current phase, or null when the store has none recorded. */
  phase: string | null;
}

/**
 * F-005 seam: resolve a story's metadata through the CONFIGURED store. Returns
 * null when the story does not exist per that store (so the core can refuse an
 * unknown story pre-spawn). The core never touches a story path itself.
 */
export type HostRunStoryResolver = (storyId: string) => HostRunStoryMeta | null;

export interface HostRunArgs {
  host: HostRunHost;
  storyId: string | null;
  agentType: string;
  /** When omitted and storyId is set, resolved from the configured store; else 'adhoc'. */
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
  /**
   * F-011: the working directory for the host subprocess. The handler binds
   * this to the SAME resolved project root it passes as `root` (the ledger
   * attribution root), so execution and attribution cannot diverge; the
   * caller's process.cwd() is never used. Required — an empty value is refused
   * pre-spawn.
   */
  cwd: string;
  root: string;
  recordedAt: string;
  projectRootHash: string;
}

export interface HostRunDeps {
  /** Injected runner (default: the async streaming child_process.spawn runner). */
  runner?: HostRunRunner;
  /**
   * F-005: resolve story phase + existence via the configured store. Required in
   * production for a story-bound run with no explicit --phase; smokes inject a
   * fake resolver. Omitting it is only valid for adhoc / explicit-phase runs.
   */
  resolveStory?: HostRunStoryResolver;
  /** F-006: live host-output passthrough sink (default: no-op). */
  passthrough?: HostRunPassthrough;
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
  /**
   * F-008: non-null when the live passthrough sink failed mid-run (first failure
   * disables further delivery; the run, usage parsing, slot release, and the
   * ledger final all still complete). Null when live output delivered cleanly
   * or the run never spawned.
   */
  passthroughError: string | null;
}

/** Nonzero process-exit sentinel for a fail-closed cap refusal. */
export const HOST_RUN_REFUSAL_EXIT_CODE = 3;

const HOST_RUN_SLOTS_RELATIVE = join('.lattice', 'usage', 'host-run-slots');

export const HOST_RUN_MAX_CONCURRENT_DEFAULT = 4;
/**
 * Orphan backstop: a slot whose meta is MISSING/CORRUPT (the holder crashed in
 * the tiny window between the wx create and the meta bytes landing, or the file
 * was externally damaged) is reclaimed once older than this. F-025: the age
 * backstop applies ONLY to that meta-less case — a slot with a valid recorded
 * pid is judged by pid liveness alone (dead => reclaim at any age; ALIVE =>
 * never age-reclaimed, however long the host run takes).
 */
const HOST_RUN_SLOT_STALE_MS_DEFAULT = 6 * 60 * 60 * 1000; // 6h

// ---------------------------------------------------------------------------
// Attribution / phase resolution
// ---------------------------------------------------------------------------

/** The canonical ledger host.kind for each launcher host. */
function ledgerHostKind(host: HostRunHost): string {
  return host === 'codex' ? 'codex' : host === 'claude' ? 'claude-code' : 'antigravity';
}

/**
 * B-70e9 F-004: the ledger provider.name for each launcher host, threaded into
 * the blocked-record paths (budget + concurrency) so a codex/agy refusal is
 * recorded under openai/antigravity — never mis-attributed to anthropic. Mirrors
 * the provider names the per-host FINAL recorders already bind.
 */
function hostProviderName(host: HostRunHost): string {
  return host === 'codex' ? 'openai' : host === 'claude' ? 'anthropic' : 'antigravity';
}

/**
 * Resolve the attribution phase WITHOUT any story-path/config knowledge (F-005).
 *
 *   - storyId null            -> explicit phase else 'adhoc' (no store read).
 *   - explicit --phase given  -> used AS-IS, the store is NEVER consulted (so an
 *                                explicit phase works with or without a storyId,
 *                                even if the store cannot resolve the story).
 *   - storyId + no --phase    -> resolved through the injected `resolveStory`
 *                                seam; an unknown story (resolver returns null)
 *                                refuses pre-spawn with a clear error.
 *
 * The store is only ever touched on the storyId+no-phase path, which is exactly
 * the case the configured StoryStore can answer.
 */
function resolvePhase(
  storyId: string | null,
  explicitPhase: string | undefined,
  resolveStory: HostRunStoryResolver | undefined,
): string {
  if (storyId === null) {
    return explicitPhase && explicitPhase.length > 0 ? explicitPhase : 'adhoc';
  }
  if (explicitPhase && explicitPhase.length > 0) return explicitPhase;
  if (!resolveStory) {
    throw new Error(
      `host_run: cannot resolve a phase for story "${storyId}" without --phase and without a configured story resolver ` +
      `(internal: the handler must inject resolveStory); pass --phase or run adhoc`,
    );
  }
  const meta = resolveStory(storyId);
  if (meta === null) {
    throw new Error(`host_run: unknown story "${storyId}" (not found in the configured story store); refuse pre-spawn`);
  }
  return meta.phase && meta.phase.length > 0 ? meta.phase : 'adhoc';
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

/**
 * F-025: the on-disk slot record — the caller meta plus an acquire-minted
 * ownership token (crypto.randomUUID), mirroring the F-018 usage-ledger lock
 * owner.json. The token is what releaseSlot must present to unlink the file,
 * so a slot that was reclaimed and re-acquired by a NEW holder survives the
 * ORIGINAL holder's late release. Metadata-only; never copied into a ledger row.
 */
interface SlotFileMeta extends SlotMeta {
  token: string;
}

/** What acquireHostRunSlot hands an admitted caller: the slot path + the release token (F-025). */
export interface AcquiredHostRunSlot {
  file: string;
  token: string;
}

/** Result of reading a slot file's on-disk record for ownership/staleness decisions (F-025). */
type SlotOccupant =
  | { state: 'valid'; pid: number; token: string | null; meta: Record<string, unknown> }
  | { state: 'corrupt' } // present but unreadable, unparseable, or missing a valid pid
  | { state: 'missing' };

/** Read + classify a slot file's occupant. Never throws. */
function readSlotOccupant(file: string): SlotOccupant {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'missing' } : { state: 'corrupt' };
  }
  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { state: 'corrupt' };
    meta = parsed as Record<string, unknown>;
  } catch {
    return { state: 'corrupt' };
  }
  const pid = ownNumber(meta, 'pid');
  if (pid === null) return { state: 'corrupt' };
  return { state: 'valid', pid, token: ownString(meta, 'token'), meta };
}

/** Same occupant as judged earlier? (valid occupants must match pid AND token.) */
function sameSlotOccupant(a: SlotOccupant, b: SlotOccupant): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'valid' && b.state === 'valid') return a.pid === b.pid && a.token === b.token;
  return true;
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

/** Resolve the slot staleness window; invalid / <=0 / unset falls back to 6h. */
export function resolveSlotStaleMs(env: NodeJS.ProcessEnv): number {
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
 * Scan the slot registry: reclaim (unlink) any RECLAIMABLE slot — dead recorded
 * pid (any age), or missing/corrupt meta past the mtime orphan backstop (F-025:
 * a LIVE recorded pid is never reclaimed by age; see isSlotReclaimable) — and
 * return the live descriptors. A missing dir yields an empty list (no dir is
 * created here).
 *
 * B-70e9 F-003: this scan is REPORTING + reclaim-backstop only — the cap
 * admission decision is acquireHostRunSlot's atomic per-index wx create, never
 * a count taken here (a scan-then-acquire count is exactly the TOCTOU that let
 * concurrent starts all pass). It reads EVERY live slot file, including any at
 * index >= a lowered cap, so the refusal live-list stays honest mid-flight.
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
    const occupant = readSlotOccupant(file);
    if (isSlotReclaimable(occupant, file, now, staleMs)) {
      // F-025: re-verify the occupant immediately before the unlink so a racing
      // reclaim-then-reacquire (a NEW holder now on this path) is never deleted.
      if (occupant.state !== 'missing' && sameSlotOccupant(readSlotOccupant(file), occupant)) {
        try {
          unlinkSync(file);
        } catch {
          // Best-effort reclaim; a racing reclaim by another run is fine.
        }
      }
      continue;
    }
    if (occupant.state !== 'valid') continue; // young meta-less orphan: not live, not yet reclaimable
    live.push({
      pid: occupant.pid,
      startedAt: ownString(occupant.meta, 'startedAt') ?? '',
      host: ownString(occupant.meta, 'host') ?? '',
      storyId: ownString(occupant.meta, 'storyId'),
      agentType: ownString(occupant.meta, 'agentType') ?? '',
    });
  }
  return live;
}

/**
 * Attempt an ATOMIC exclusive create of a slot file (`wx` flag). Returns true when
 * this call created the file, false when the file already existed (the race
 * loser). Other fs errors propagate (an unwritable registry is a real failure).
 * The file content (caller meta + the F-025 ownership token) is metadata only
 * and is NEVER copied into a ledger row.
 */
export function writeSlotFileExclusive(file: string, meta: SlotFileMeta): boolean {
  try {
    writeFileSync(file, JSON.stringify(meta), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Reclaimability judgment for an occupied slot (F-025, narrowing the old
 * "dead pid OR old mtime" rule to the F-018 ownership doctrine):
 *
 *   - valid meta (a recorded pid): pid liveness ALONE decides. A DEAD pid is
 *     reclaimable at any age; a LIVE pid is NEVER reclaimed by age — a long
 *     host run legitimately outlives any window, and the old age rule reclaimed
 *     exactly such live slots (re-issuing the same fixed slot-N path to a new
 *     holder whom the original holder's late release then deleted, breaking the
 *     cap). Accepted residual: a dead holder's pid may have been reused by an
 *     unrelated live process (standard pid-reuse residual) — such a slot is
 *     simply never age-reclaimed and waiters refuse at cap.
 *   - missing/corrupt meta (the holder crashed between the wx create and the
 *     meta bytes landing, or external damage): pid liveness is unknowable, so
 *     the LATTICE_HOST_RUN_SLOT_STALE_MS mtime backstop is the only signal
 *     left — reclaim only past that age (env semantics unchanged; its scope is
 *     just narrowed to this meta-less window). A YOUNG meta-less slot is
 *     waited out, never stolen.
 *   - a file that VANISHED between the wx failure and the probe is treated as
 *     reclaimable — the wx re-create is what decides.
 */
function isSlotReclaimable(occupant: SlotOccupant, file: string, now: number, staleMs: number): boolean {
  if (occupant.state === 'missing') return true;
  if (occupant.state === 'valid') return !isPidAlive(occupant.pid);
  // Corrupt/meta-less: the mtime orphan backstop is the only remaining signal.
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return true;
  }
  const ageMs = now - mtimeMs;
  return !Number.isFinite(ageMs) || ageMs > staleMs;
}

/**
 * B-70e9 F-003: ATOMIC cap admission via FIXED numbered slots.
 *
 * The admission decision IS the exclusive create: slot files are named
 * `slot-0.json` .. `slot-(cap-1).json`, and each index is tried in order with an
 * atomic `wx` create — success on index i means this process is admitted (only
 * `cap` contenders can ever hold the `cap` fixed names, so N concurrent starts
 * can never all pass the way the old scan-then-unique-acquire TOCTOU allowed).
 *
 * Per-index reclaim: when an index is occupied, a FRESH reclaimability probe
 * runs immediately before any reclaim (F-025 semantics — see isSlotReclaimable:
 * dead recorded pid at any age, or meta-less past the mtime orphan backstop; a
 * LIVE recorded pid is never age-reclaimed). A reclaimable slot is reclaimed by
 * re-verify -> unlink -> a NEW wx create: the occupant is RE-READ immediately
 * before the unlink and the unlink is skipped when it no longer matches the
 * judged occupant (F-018 pattern) — a racing reclaimer may have already won and
 * a NEW holder re-created this slot, and unlinking then would delete the new
 * holder's live admission. The wx decides the winner among racing reclaimers —
 * a lost race (EEXIST after our unlink, because another reclaimer re-created
 * first) just moves on to the next index; unlink+create is NEVER treated as
 * guaranteed admission.
 *
 * Cap semantics under a mid-flight change: a cap RAISE simply exposes more
 * indexes to try; a cap LOWER means live slots at index >= cap still count as
 * "live" for reporting (scanLiveSlots reads every slot file) but new acquires
 * only ever try slot-0..slot-(cap-1), so admissions converge onto the lowered
 * cap as the high-index runs drain.
 *
 * Returns the acquired slot path PLUS the acquire-minted ownership token that
 * releaseSlot must present (F-025), or null when every index 0..cap-1 is held
 * by a live run (the caller refuses fail-closed). Slot content stays
 * metadata-only (pid/startedAt/host/storyId/agentType + token) and is never
 * copied into a ledger row.
 */
export function acquireHostRunSlot(
  dir: string,
  cap: number,
  staleMs: number,
  now: number,
  meta: SlotMeta,
): AcquiredHostRunSlot | null {
  mkdirSync(dir, { recursive: true });
  const boundedCap = Number.isFinite(cap) && Number.isInteger(cap) && cap > 0 ? cap : HOST_RUN_MAX_CONCURRENT_DEFAULT;
  const token = randomUUID();
  const record: SlotFileMeta = { ...meta, token };
  for (let index = 0; index < boundedCap; index++) {
    const file = join(dir, `slot-${index}.json`);
    // Free index: the exclusive create IS the atomic admission.
    if (writeSlotFileExclusive(file, record)) return { file, token };

    // Occupied: fresh reclaimability probe immediately before any reclaim.
    const judged = readSlotOccupant(file);
    if (!isSlotReclaimable(judged, file, now, staleMs)) continue;

    // Reclaimable: re-verify -> unlink -> a fresh exclusive create. The re-read
    // backs off when the occupant changed since we judged it (a racing reclaimer
    // won and a NEW holder re-created the slot: unlinking now would delete that
    // holder's live admission — the same ownership class F-025 closes on
    // release). The remaining read -> unlink gap is the pid-reuse-class residual
    // documented on releaseSlot.
    if (judged.state !== 'missing') {
      if (!sameSlotOccupant(readSlotOccupant(file), judged)) continue;
      try {
        unlinkSync(file);
      } catch {
        // Another reclaimer unlinked first; the wx below still decides the winner.
      }
    }
    if (writeSlotFileExclusive(file, record)) return { file, token };
    // Lost the reclaim race to another contender — move on to the next index.
  }
  return null;
}

/**
 * Ownership-verified slot release (F-025, mirroring the F-018 ledger-lock
 * release guard): read-verify-then-unlink. The slot file is unlinked ONLY while
 * its on-disk token still matches the token minted at OUR acquire. A mismatch —
 * or a missing/corrupt slot file — means the slot was legitimately reclaimed
 * after we were judged dead/orphaned and may already be a NEW holder's live
 * admission: return WITHOUT touching it (the old blind unlink deleted the new
 * holder's slot and let subsequent runs bypass the cap). A null file/token is a
 * no-op (the ledger-OFF paths). The tiny read-verify -> unlink window is the
 * same pid-reuse-class residual documented on the usage-ledger lock (F-018);
 * a slot leaked by a skipped release is reclaimed by pid-death (or, for
 * meta-less files, the mtime orphan backstop).
 *
 * Exported so the autopilot claude repair path (F-016) and the codex review
 * leaf (F-017) release their admission slots the same way host_run does.
 */
export function releaseSlot(file: string | null, token: string | null): void {
  if (!file || !token) return;
  try {
    const occupant = readSlotOccupant(file);
    if (occupant.state !== 'valid' || occupant.token !== token) return;
    unlinkSync(file);
  } catch {
    // Best-effort release; pid-death / the orphan backstop reclaims a leak.
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
// Codex turn.failed / terminal error scan (B-3ddc)
// ---------------------------------------------------------------------------

/** B-3ddc: a scanned codex failure event (last-wins across both event types). */
export interface CodexTurnFailedEvent {
  /** 'turn.failed' or 'error' — whichever matching event came LAST. */
  eventType: string;
  /** The extractable string message, or null when the event carried none. */
  message: string | null;
}

/**
 * B-3ddc: scan codex `exec --json` output for the LAST failure event — a
 * `{"type":"turn.failed","error":{"message":...}}` or a terminal
 * `{"type":"error","message":...}` line — mirroring the bounded
 * scanCodexTurnCompletedUsage walk (only the current line and the last match
 * are held; own-property guarded). A matching event with no extractable
 * string message still counts as a failure (message: null); last-wins applies
 * ACROSS both event types. Returns null when no failure event is present.
 */
export function scanCodexTurnFailed(text: string): CodexTurnFailedEvent | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  let last: CodexTurnFailedEvent | null = null;
  let index = 0;
  const len = text.length;
  while (index <= len) {
    let newline = text.indexOf('\n', index);
    if (newline === -1) newline = len;
    const line = text.slice(index, newline).trim();
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
        if (type === 'turn.failed') {
          const error = Object.prototype.hasOwnProperty.call(event, 'error') ? event.error : undefined;
          let message: string | null = null;
          if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
            const errObj = error as Record<string, unknown>;
            const m = Object.prototype.hasOwnProperty.call(errObj, 'message') ? errObj.message : undefined;
            if (typeof m === 'string') message = m;
          }
          last = { eventType: 'turn.failed', message };
        } else if (type === 'error') {
          const m = Object.prototype.hasOwnProperty.call(event, 'message') ? event.message : undefined;
          last = { eventType: 'error', message: typeof m === 'string' ? m : null };
        }
      }
    }
    if (newline === len) break;
  }
  return last;
}

/** B-3ddc: hard cap (chars) on the sanitized turn_failed(<digest>) excerpt. */
export const CODEX_TURN_FAILED_DIGEST_MAX_CHARS = 160;

/** B-3ddc: depth cap when drilling a JSON-encoded message for the innermost error.message. */
const CODEX_TURN_FAILED_NESTED_DEPTH_CAP = 4;

/**
 * B-3ddc: render the honest unavailable reason `turn_failed(<digest>)` for a
 * scanned failure event. The digest is a short sanitized excerpt of the
 * error message — deliberately human-readable (not a hash) so the ledger row
 * itself names the failure:
 *   - null/empty (after trim) message -> 'no_error_message';
 *   - a message that itself parses as a JSON object (the observed B-3928
 *     payload string-encodes a nested 400 body) is drilled to the INNERMOST
 *     `error.message` string (bounded depth; falls back to the original
 *     message when nothing extractable is found);
 *   - control characters (\n \r \t, NUL, DEL) and whitespace runs collapse to
 *     a single space; the result is hard-capped at
 *     CODEX_TURN_FAILED_DIGEST_MAX_CHARS total with a trailing '…' when cut.
 */
export function codexTurnFailedReason(failure: CodexTurnFailedEvent): string {
  return `turn_failed(${codexTurnFailedDigest(failure.message)})`;
}

function codexTurnFailedDigest(message: string | null): string {
  if (message === null || message.trim().length === 0) return 'no_error_message';
  let text = message;
  // Drill: when the message itself parses as a JSON object, descend through
  // own `error` object properties (bounded depth) and prefer the DEEPEST own
  // `message` string found; keep the original message when none is extractable.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    let node = parsed as Record<string, unknown>;
    let deepest: string | null = null;
    for (let depth = 0; depth < CODEX_TURN_FAILED_NESTED_DEPTH_CAP; depth++) {
      const m = Object.prototype.hasOwnProperty.call(node, 'message') ? node.message : undefined;
      if (typeof m === 'string') deepest = m;
      const err = Object.prototype.hasOwnProperty.call(node, 'error') ? node.error : undefined;
      if (typeof err !== 'object' || err === null || Array.isArray(err)) break;
      node = err as Record<string, unknown>;
    }
    if (deepest !== null && deepest.trim().length > 0) text = deepest;
  }
  // Sanitize: every control-character/whitespace run becomes a single space,
  // then B-3ddc (codex round-1 F2) neutralize parentheses — '(' -> '[' and
  // ')' -> ']' — so an error.message containing ')' or '(' can never close or
  // reopen the enclosing turn_failed(...) reason delimiters (a delimiter-
  // injection guard). The pinned B-3928 upgrade message contains no parens, so
  // its expected reason string is unchanged.
  const sanitized = text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').replace(/\(/g, '[').replace(/\)/g, ']').trim();
  if (sanitized.length === 0) return 'no_error_message';
  if (sanitized.length > CODEX_TURN_FAILED_DIGEST_MAX_CHARS) {
    return `${sanitized.slice(0, CODEX_TURN_FAILED_DIGEST_MAX_CHARS - 1)}…`;
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Default runner (F-006): async streaming spawn with bounded usage retention
// ---------------------------------------------------------------------------

/** Per-retained-line cap. A single line over this is dropped (not retained). */
export const HOST_RUN_RETAINED_LINE_CAP = 1024 * 1024; // 1 MiB

/**
 * F-013: the unavailable reason recorded when the scanner dropped an over-cap
 * line AFTER (or without) the retained usage-bearing candidate (F-026). The
 * retained stdout is then known-stale (the dropped line may have carried the
 * real final usage), so the final must never be provider-reported.
 */
export const HOST_RUN_RETENTION_TRUNCATED_REASON = 'usage_line_retention_truncated';

/**
 * A memory-BOUNDED line scanner. It reads host stdout chunk-by-chunk and keeps
 * only the LAST complete line for which `retain(line)` is true, capped at
 * HOST_RUN_RETAINED_LINE_CAP. A line that exceeds the cap (with or without a
 * terminating newline) is DROPPED — never retained as a bogus parse target and
 * never accumulated in full (an over-cap line switches to skip-until-newline
 * mode, so a flooding host cannot exhaust memory).
 *
 * F-026 truncation semantics: the `truncated` flag tracks whether a drop
 * happened SINCE the last retained candidate — set on every over-cap drop,
 * CLEARED when a usage-bearing line is subsequently retained. At end-of-stream
 * a true flag means the dropped line postdates (or there never was) the
 * retained candidate, so it may have carried the real final numbers and the
 * final records unavailable (F-013). A drop followed by a retained candidate
 * records that candidate honestly — last-usage-wins makes the later retained
 * line the freshest usage information regardless of what the dropped line held.
 */
export class UsageLineScanner {
  private partial = '';
  private retained: string | null = null;
  private truncatedSinceLastCandidate = false;
  private skipping = false;

  constructor(
    private readonly retain: HostRunUsageLineRetainer | undefined,
    private readonly cap: number = HOST_RUN_RETAINED_LINE_CAP,
  ) {}

  push(text: string): void {
    if (!this.retain || text.length === 0) return;
    let data = text;
    while (data.length > 0) {
      const nl = data.indexOf('\n');
      if (nl === -1) {
        if (this.skipping) return; // still dropping an over-cap line
        if (this.partial.length + data.length > this.cap) {
          // This line has already blown the cap without a newline: drop it and
          // skip until its newline (bounded memory).
          this.truncatedSinceLastCandidate = true;
          this.skipping = true;
          this.partial = '';
          return;
        }
        this.partial += data;
        return;
      }
      const segment = data.slice(0, nl);
      data = data.slice(nl + 1);
      if (this.skipping) {
        // Reached the newline that ends the over-cap line: resume normal scan.
        this.skipping = false;
        this.partial = '';
        continue;
      }
      if (this.partial.length + segment.length > this.cap) {
        this.truncatedSinceLastCandidate = true;
        this.partial = '';
        continue; // drop this over-cap line
      }
      const line = this.partial + segment;
      this.partial = '';
      this.consider(line);
    }
  }

  /** Fold any trailing partial (a final line with no newline) into the scan. */
  flush(): void {
    if (!this.retain) return;
    if (this.skipping) {
      this.skipping = false;
      this.partial = '';
      return;
    }
    if (this.partial.length > 0) this.consider(this.partial);
    this.partial = '';
  }

  private consider(line: string): void {
    if (line.length > this.cap) {
      this.truncatedSinceLastCandidate = true;
      return;
    }
    try {
      if (this.retain && this.retain(line)) {
        this.retained = line;
        // F-026: a freshly retained usage-bearing candidate supersedes any
        // earlier over-cap drop (last-usage-wins) — clear the poison so the
        // candidate is recorded honestly. Only a retained CANDIDATE clears it;
        // ordinary under-cap non-usage lines leave the flag untouched.
        this.truncatedSinceLastCandidate = false;
      }
    } catch {
      // A retain predicate must never throw; ignore a malformed line.
    }
  }

  /** The retained usage-bearing line (or '' when none was retained). */
  retainedText(): string {
    return this.retained ?? '';
  }

  /** F-026: true when an over-cap drop happened after (or without) the retained candidate. */
  get truncated(): boolean {
    return this.truncatedSinceLastCandidate;
  }
}

/**
 * Build the per-host usage-line retainer. codex keeps the last `turn.completed`
 * event that carries a usage object; claude keeps the last stream-json `result`
 * envelope; agy has no usage surface, so nothing is retained.
 */
export function usageLineRetainerFor(host: HostRunHost): HostRunUsageLineRetainer | undefined {
  if (host === 'codex') {
    return (line: string): boolean => {
      const event = parseJsonObjectLine(line);
      if (event === null) return false;
      const type = Object.prototype.hasOwnProperty.call(event, 'type') ? event.type : undefined;
      if (type !== 'turn.completed') return false;
      const usage = Object.prototype.hasOwnProperty.call(event, 'usage') ? event.usage : undefined;
      return typeof usage === 'object' && usage !== null && !Array.isArray(usage);
    };
  }
  if (host === 'claude') {
    return (line: string): boolean => {
      const event = parseJsonObjectLine(line);
      if (event === null) return false;
      const type = Object.prototype.hasOwnProperty.call(event, 'type') ? event.type : undefined;
      const result = Object.prototype.hasOwnProperty.call(event, 'result') ? event.result : undefined;
      return type === 'result' || typeof result === 'string';
    };
  }
  return undefined;
}

/**
 * B-3ddc: build the per-host FAILURE-line retainer for the second bounded
 * lane. codex keeps the last `{"type":"turn.failed",...}` or terminal
 * `{"type":"error",...}` event line (own-property guarded) so a no-usage
 * final can name the real failure; claude and agy surface no such single-line
 * failure event, so nothing is retained.
 */
export function failureLineRetainerFor(host: HostRunHost): HostRunUsageLineRetainer | undefined {
  if (host !== 'codex') return undefined;
  return (line: string): boolean => {
    const event = parseJsonObjectLine(line);
    if (event === null) return false;
    const type = Object.prototype.hasOwnProperty.call(event, 'type') ? event.type : undefined;
    return type === 'turn.failed' || type === 'error';
  };
}

function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * The default PRODUCTION runner: async child_process.spawn that streams host
 * output to `plan.onChunk` as it arrives (live passthrough) while retaining only
 * the bounded last usage-bearing line for parsing. Exit-code / timeout semantics
 * match the previous piped implementation (SIGKILL on timeoutMs -> timedOut=true,
 * exit 124; a spawn error -> exit 1).
 */
export function defaultHostRunRunner(plan: HostRunSpawnPlan): Promise<HostRunSpawnResult> {
  return new Promise<HostRunSpawnResult>((resolve) => {
    const scanner = new UsageLineScanner(plan.retainUsageLine);
    // B-3ddc: the SECOND bounded lane — same scanner class, same cap, same
    // last-wins discipline — retains the last failure event line. Its truncated
    // flag now feeds `failureRetentionTruncated` (codex round-1 F1): an over-cap
    // drop AFTER (or without) the retained candidate marks the retained failure
    // text stale, so the codex no-usage reason degrades to the generic
    // no_turn_completed_usage_event fallback instead of a possibly stale
    // turn_failed(<digest>). The usage lane's own flag still feeds
    // retentionTruncated with ABSOLUTE priority (F-013/F-026 unchanged).
    const failureScanner = new UsageLineScanner(plan.retainFailureLine);
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    // F-008: a throwing onChunk (e.g. EPIPE from a closed consumer pipe) must
    // never escape a 'data' listener as an uncaught EventEmitter exception —
    // that would crash the process, orphan the child, and leak the concurrency
    // slot. First failure flips the flag: delivery stops (no per-chunk retry),
    // chunks keep flowing to the usage scanner, and the run finishes normally
    // with the failure surfaced on the result.
    let passthroughBroken = false;
    let passthroughError: string | null = null;
    const deliver = (chunk: HostRunChunk): void => {
      if (passthroughBroken || !plan.onChunk) return;
      try {
        plan.onChunk(chunk);
      } catch (err) {
        passthroughBroken = true;
        passthroughError = err instanceof Error ? err.message : String(err);
      }
    };

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      scanner.flush();
      failureScanner.flush();
      resolve({
        stdout: scanner.retainedText(),
        stderr: '',
        exitCode,
        timedOut,
        retentionTruncated: scanner.truncated,
        failureText: failureScanner.retainedText(),
        // B-3ddc (codex round-1 F1): honor the failure lane's own truncation.
        failureRetentionTruncated: failureScanner.truncated,
        passthroughError,
      });
    };

    let child;
    try {
      child = spawn(plan.command, plan.argv, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish(1);
      return;
    }

    // No stdin payload — mirror the previous `input: ''`.
    try {
      child.stdin?.end();
    } catch {
      // best-effort
    }

    if (plan.timeoutMs && plan.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // best-effort
        }
      }, plan.timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      deliver({ stream: 'stdout', text });
      scanner.push(text);
      // B-3ddc: the failure lane sees the same live text; delivery above is
      // untouched (the lane only keeps a bounded copy, never suppresses).
      failureScanner.push(text);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      deliver({ stream: 'stderr', text });
    });

    child.on('error', () => finish(timedOut ? 124 : 1));
    child.on('close', (code, signal) => {
      const timed = timedOut || signal === 'SIGKILL' || signal === 'SIGTERM';
      timedOut = timed;
      const exitCode = typeof code === 'number' ? code : timed ? 124 : 1;
      finish(exitCode);
    });
  });
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
 * B-70e9 F-021: the honest summary when the ledger append FAILED (corrupt or
 * lock-timed-out ledger). The provider parsed usage, but no row landed, so the
 * summary must NOT claim 'provider-reported'/'unavailable' (which would read as
 * "usage recorded"). We reuse the existing 'none' state — already rendered by the
 * handler as "usage: <reason>" with no "recorded" verb — carrying the specific
 * ledger_append_failed(...) reason. The provider is still surfaced for
 * attribution; token counts are null because nothing was persisted.
 */
function appendFailedSummary(provider: string | null, reason: string | null): HostRunUsageSummary {
  return {
    recorded: 'none',
    provider,
    input: null,
    cacheRead: null,
    output: null,
    recordId: null,
    reason: reason && reason.length > 0 ? reason : 'ledger_append_failed(unknown)',
  };
}

/**
 * Launch a canonical host and write the usage-ledger rows. See file header for
 * the full seam ordering. Input-validation failures (unknown story, cross-story
 * reviewRunId) THROW pre-spawn; cap refusals return a blocked result (a ledger
 * blocked row is written) with a nonzero exit and NO spawn.
 */
export async function runHostRun(args: HostRunArgs, deps: HostRunDeps = {}): Promise<HostRunResult> {
  if (args.host !== 'codex' && args.host !== 'claude' && args.host !== 'agy') {
    throw new Error(`host_run: unsupported host "${String(args.host)}" (expected codex | claude | agy)`);
  }
  if (typeof args.promptText !== 'string' || args.promptText.length === 0) {
    throw new Error('host_run: promptText is required (empty prompt refused pre-spawn)');
  }
  // F-011: the host must execute in the resolved project root, never the
  // caller's process cwd. A missing/empty cwd is refused BEFORE any spawn so a
  // host can never silently run in whatever directory the CLI was invoked from
  // while the ledger attributes the run to `root`.
  if (typeof args.cwd !== 'string' || args.cwd.length === 0) {
    throw new Error('host_run: cwd is required (the resolved project root); refuse pre-spawn rather than spawn in the caller cwd');
  }

  const runner = deps.runner ?? defaultHostRunRunner;
  const passthrough = deps.passthrough ?? (() => {});
  const phase = resolvePhase(args.storyId, args.phase, deps.resolveStory);
  assertReviewRunIdBinding(args.storyId, args.reviewRunId);

  /**
   * Invoke the runner with the live passthrough wired in. The streaming default
   * runner delivers host output via onChunk as it arrives; a non-streaming fake
   * runner delivers nothing live, so its buffered stdout/stderr is flushed to the
   * passthrough ONCE here. Either way host output reaches the sink EXACTLY ONCE,
   * so the handler never double-prints.
   *
   * F-008: every passthrough invocation is guarded. A throwing sink flips
   * `passthroughFailure` on the FIRST failure and delivery stops (no per-chunk
   * retry) — the run, usage parsing, slot release, and the ledger final all
   * still complete, and the failure is surfaced on the result.
   */
  let passthroughFailure: string | null = null;
  const safeDeliver = (chunk: HostRunChunk): void => {
    if (passthroughFailure !== null) return;
    try {
      passthrough(chunk);
    } catch (err) {
      passthroughFailure = err instanceof Error ? err.message : String(err);
    }
  };
  const invokeRunner = async (launch: MaterializedLaunch): Promise<HostRunSpawnResult> => {
    let streamed = false;
    const onChunk = (chunk: HostRunChunk): void => {
      streamed = true;
      safeDeliver(chunk);
    };
    let spawn: HostRunSpawnResult;
    try {
      spawn = await runner({
        command: launch.command,
        argv: launch.argv,
        env: args.env,
        // F-011: every spawn path executes in the resolved project root.
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        promptFile: launch.promptFile,
        host: args.host,
        retainUsageLine: usageLineRetainerFor(args.host),
        // B-3ddc: the second bounded failure lane (codex-only retainer).
        retainFailureLine: failureLineRetainerFor(args.host),
        onChunk,
      });
    } finally {
      launch.cleanup();
    }
    if (!streamed) {
      if (spawn.stdout.length > 0) safeDeliver({ stream: 'stdout', text: spawn.stdout });
      if (spawn.stderr.length > 0) safeDeliver({ stream: 'stderr', text: spawn.stderr });
    }
    // A runner that guards its own onChunk calls (the default) reports the sink
    // failure on ITS result; merge it so the caller sees one honest field.
    if (passthroughFailure === null && typeof spawn.passthroughError === 'string' && spawn.passthroughError.length > 0) {
      passthroughFailure = spawn.passthroughError;
    }
    return spawn;
  };

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
    const spawn = await invokeRunner(materializeLaunch(args));
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
      passthroughError: passthroughFailure,
    };
  }

  // ---- Ledger ON: preflight -> budget guard -> concurrency guard -> spawn -> final.
  let handle: DispatchPreflightHandle | null = null;
  try {
    handle = recordDispatchPreflight(args.root, ctx, args.promptText, opts);
  } catch {
    handle = null;
  }

  // The ledger provider for THIS host — threaded into both blocked-record paths
  // (F-004) so a codex/agy refusal is never attributed to anthropic.
  const blockedProvider = { name: hostProviderName(args.host), model: null };

  // CHK-007a: hard-budget cap (fail-closed BEFORE spawn).
  const budget = recordBudgetBlock(args.root, ctx, handle, args.promptText, opts, blockedProvider);
  if (budget.blocked) {
    const refusalDetail = `hard_budget_exceeded (${budget.budgetPolicyId ?? 'hard-budget'}${
      budget.hardBudgetTokens !== null ? `, cap ${budget.hardBudgetTokens}` : ''
    })`;
    // F-027: claim a recorded blocked row ONLY when the append actually landed.
    // The refusal itself (no spawn, nonzero exit) is unchanged either way; when
    // the write was swallowed (corrupt / lock-timed-out ledger) the summary is
    // the honest skipped state with the refusal kept visible in the reason.
    const rowAppended = budget.appended === true;
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
        recorded: rowAppended ? 'blocked' : 'none',
        provider: null,
        input: null,
        cacheRead: null,
        output: null,
        recordId: null,
        reason: rowAppended
          ? refusalDetail
          : `${refusalDetail}; ${budget.appendFailureReason ?? 'ledger_append_failed(unknown)'}`,
      },
      passthroughError: null,
    };
  }

  // CHK-007b: concurrency cap (fail-closed BEFORE spawn). Slot registry is only
  // touched when the ledger is ON (keeps the OFF path dir-free).
  //
  // F-003: admission is ATOMIC — acquireHostRunSlot's per-index exclusive create
  // IS the cap decision (no scan-then-acquire TOCTOU). scanLiveSlots below runs
  // ONLY on the refusal path, purely to report the live-run list.
  const dir = hostRunSlotsDir(args.root);
  const cap = resolveMaxConcurrent(args.env);
  const staleMs = resolveSlotStaleMs(args.env);
  const slotMeta: SlotMeta = {
    pid: process.pid,
    startedAt: args.recordedAt,
    host: args.host,
    storyId: args.storyId,
    agentType: args.agentType,
  };
  const slot = acquireHostRunSlot(dir, cap, staleMs, Date.now(), slotMeta);
  if (slot === null) {
    const live = scanLiveSlots(dir, Date.now(), staleMs);
    const blockRow = recordConcurrencyBlock(args.root, ctx, handle, args.promptText, cap, opts, blockedProvider);
    const refusalDetail = `concurrency_cap_exceeded (${live.length} live host runs, cap ${cap})`;
    // F-027: `recorded: 'blocked'` + the recordId are claimed ONLY when the
    // blocked row actually appended (blockRow.recorded keys on the real
    // appendUsageRecord outcome). On a swallowed write the summary reports the
    // honest skipped state — no minted recordId for a row that never landed —
    // while the refusal (no spawn, nonzero exit) stays fail-closed and visible.
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
        recorded: blockRow.recorded ? 'blocked' : 'none',
        provider: null,
        input: null,
        cacheRead: null,
        output: null,
        recordId: blockRow.recorded ? blockRow.recordId : null,
        reason: blockRow.recorded
          ? refusalDetail
          : `${refusalDetail}; ${blockRow.reason ?? 'ledger_append_failed(unknown)'}`,
      },
      passthroughError: null,
    };
  }

  let spawn: HostRunSpawnResult;
  try {
    spawn = await invokeRunner(materializeLaunch(args));
  } finally {
    // F-025: token-verified release — never deletes a reclaimed+reacquired slot.
    releaseSlot(slot.file, slot.token);
  }

  const summary = recordFinalForHost(
    args,
    ctx,
    handle,
    opts,
    spawn.stdout,
    spawn.retentionTruncated === true,
    spawn.failureText ?? '',
    // B-3ddc (codex round-1 F1): thread the failure lane's truncation flag so an
    // untrusted (stale) failure line degrades the codex reason honestly.
    spawn.failureRetentionTruncated === true,
  );

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
    passthroughError: passthroughFailure,
  };
}

/** Record the per-host provider/unavailable final and describe it for the caller. */
function recordFinalForHost(
  args: HostRunArgs,
  ctx: DispatchUsageContext,
  handle: DispatchPreflightHandle | null,
  opts: DispatchUsageOptions,
  stdout: string,
  retentionTruncated: boolean,
  failureText: string,
  failureRetentionTruncated: boolean,
): HostRunUsageSummary {
  const correlation = handle?.correlation ?? null;
  const estimateRecordId = handle?.estimateRecordId ?? null;

  try {
    // F-013/F-026: retentionTruncated is true only when an over-cap line was
    // dropped AFTER (or without) the retained usage-bearing candidate — the
    // dropped line may have carried the real final numbers, so any retained
    // stdout is known-stale. Never parse it: record a provider-specific
    // unavailable final instead of a stale provider-reported one. (A drop
    // FOLLOWED by a retained candidate arrives here with the flag already
    // cleared by the scanner, so the candidate records honestly.) agy falls
    // through to its existing (more specific) always-unavailable reason below.
    if (retentionTruncated && (args.host === 'codex' || args.host === 'claude')) {
      const providerName = hostProviderName(args.host);
      const res = recordDispatchUnavailableFinal(
        args.root,
        ctx,
        correlation,
        estimateRecordId,
        { name: providerName, model: null },
        HOST_RUN_RETENTION_TRUNCATED_REASON,
        opts,
      );
      // F-021: only claim the unavailable row when it actually appended.
      if (!res.recorded) return appendFailedSummary(providerName, res.reason ?? null);
      return {
        recorded: 'unavailable',
        provider: providerName,
        input: null,
        cacheRead: null,
        output: null,
        recordId: res.recordId,
        reason: HOST_RUN_RETENTION_TRUNCATED_REASON,
      };
    }

    if (args.host === 'claude') {
      const parsed = parseClaudeCliOutput(stdout);
      // F-021: gate the "recorded" claim on the ACTUAL append outcome, not on
      // whether the envelope parsed. A corrupt / lock-timed-out ledger swallows
      // the write; reporting provider-reported then would hide a zero-row ledger.
      const status = recordDispatchFinal(args.root, ctx, correlation, estimateRecordId, parsed.anthropicUsage, parsed.model, opts);
      if (!status.appended) return appendFailedSummary('anthropic', status.reason ?? null);
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
        // B-3ddc: no usage event — consult the SECOND bounded lane (streaming
        // runners) falling back to the buffered stdout (fake runners omit
        // failureText) for the last turn.failed / terminal error event, and
        // refine the unavailable REASON to the honest turn_failed(<digest>).
        // Only the reason string changes: usage numbers stay null (never
        // fabricated from a failure event) and no failure event preserves the
        // documented no_turn_completed_usage_event fallback exactly as today.
        //
        // B-3ddc (codex round-1 F1): when the failure lane dropped an over-cap
        // line AFTER (or without) its retained candidate, that streaming failure
        // text is UNTRUSTED (the dropped line may have superseded it) — force the
        // source to '' so scanCodexTurnFailed finds nothing and the reason
        // honestly degrades to no_turn_completed_usage_event. The fake-runner
        // stdout fallback applies ONLY when failureText is absent AND the flag is
        // clear. (The usage lane's retentionTruncated was already honored above
        // with absolute priority, so a truncated USAGE lane never reaches here.)
        const failureSource = failureRetentionTruncated ? '' : (failureText.length > 0 ? failureText : stdout);
        const failure = scanCodexTurnFailed(failureSource);
        const reason = failure !== null ? codexTurnFailedReason(failure) : 'no_turn_completed_usage_event';
        const res = recordDispatchUnavailableFinal(
          args.root,
          ctx,
          correlation,
          estimateRecordId,
          { name: 'openai', model: null },
          reason,
          opts,
        );
        // F-021: only claim the unavailable row when it actually appended.
        if (!res.recorded) return appendFailedSummary('openai', res.reason ?? null);
        return {
          recorded: 'unavailable',
          provider: 'openai',
          input: null,
          cacheRead: null,
          output: null,
          recordId: res.recordId,
          reason,
        };
      }
      const codex = recordDispatchFinalCodex(args.root, ctx, correlation, estimateRecordId, usage, null, opts);
      // F-021: codex.recorded reflects the ACTUAL append (true only after a
      // successful appendUsageRecord). When it is false the provider parsed a
      // usage but no row landed — report the skipped state, never provider-
      // reported / unavailable (which read as "recorded").
      if (!codex.recorded) return appendFailedSummary('openai', codex.unavailableReason ?? null);
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
    // F-021: only claim the unavailable row when it actually appended.
    if (!res.recorded) return appendFailedSummary('antigravity', res.reason ?? null);
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
