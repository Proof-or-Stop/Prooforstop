import { isManagedInventoryCritic, managedInventoryCriticJsonSchema, type ManagedInventoryCritic } from './managed-inventory-critic.js';
import { prepareManagedReadonlyLaunch, type ManagedReadonlyLayout } from './managed-review-readonly.js';
import { ACCEPTANCE_REVIEW_FINAL_SCHEMA, acceptanceReviewJsonSchema } from './acceptance-amendment-review.js';
/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: the host-run choke point.
 *
 * `runHostRun` is the single core entry that LAUNCHES a canonical reviewer/quorum
 * host — codex or claude only — via the B-d8ef canonical launcher argv AND writes
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
 *   - The ledger seam mirrors runClaudeCodeRealLeafDispatch (proof-or-stop-dispatch.ts):
 *     preflight estimate (sequence 1) -> budget guard -> concurrency guard ->
 *     spawn -> provider/unavailable final (sequence 2, supersedes the estimate).
 *     Every ledger call is fail-open (never throws to the caller).
 *   - PROOF_OR_STOP_USAGE_LEDGER=0 disables usage preflight/budget/final rows only.
 *     Shared provider-process admission remains mandatory before every spawn.
 *   - This core imports the usage seam ONLY through usage-ledger/dispatch-usage.js
 *     (the single thin import surface); it never reaches into other ledger modules.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import {
  canonicalReviewHostLauncherSpec,
  classifyHostExecutionDiagnosticText,
  classifyHostExecutionFailure,
  materializeLauncherArgv,
  type CanonicalReviewHost,
  type HostExecutionFailureKind,
} from './host-execution-readiness.js';
import {
  isUsageLedgerEnabled,
  parseClaudeCliOutput,
  parseLiveProviderUsage,
  type LiveProviderUsage,
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
import {
  acquireProviderProcessAdmission,
  releaseProviderProcessAdmission,
  transferProviderProcessAdmissionToProvider,
  type ProviderProcessAdmission,
} from './provider-process-admission.js';
import type {
  AcquiredProviderProcessSlot,
  ProviderProcessLiveDescriptor,
} from './provider-process-registry.js';
import { providerProcessSlotsDir } from './provider-process-registry.js';
import {
  diagnoseManagedReviewerReadEvidence,
  normalizeReviewerReadLogEvidence,
  normalizeReviewerReadManifest,
} from './reviewer-read-evidence.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

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

/**
 * Stable-enough identity for later managed-run reconciliation. A pid/pgid by
 * itself is never sufficient because the OS may reuse it; `startFingerprint`
 * is captured from the live process immediately after spawn. When that capture
 * is unavailable, a detached supervisor may observe but must not blindly kill.
 */
export interface HostRunProcessIdentity {
  pid: number;
  pgid: number | null;
  spawnedAt: string;
  startFingerprint: string | null;
  processGroupIsolated: boolean;
}

export interface HostRunProcessCleanup {
  termSent: boolean;
  killSent: boolean;
  reaped: boolean;
  residualProcessGroup: boolean;
}

/**
 * `detached: true` creates a new POSIX process group whose leader is the
 * spawned provider itself. Never signal a persisted/injected identity unless
 * it still names exactly that shape: a malformed pgid of 1 would turn
 * `process.kill(-pgid, signal)` into the POSIX broadcast form.
 */
export function isSafeIsolatedProviderProcessGroup(
  identity: HostRunProcessIdentity | null,
): identity is HostRunProcessIdentity & { pgid: number; startFingerprint: string } {
  return identity !== null
    && identity.processGroupIsolated
    && Number.isSafeInteger(identity.pid)
    && identity.pid > 1
    && identity.pgid !== null
    && Number.isSafeInteger(identity.pgid)
    && identity.pgid > 1
    && identity.pgid === identity.pid
    && typeof identity.startFingerprint === 'string'
    && identity.startFingerprint.length > 0;
}

/** The plan handed to the injected runner (or the default streaming runner). */
export interface HostRunSpawnPlan {
  /** Executable name for a supported managed host (codex or claude). */
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
  /** Optional silence budget. Cleared by the first stdout OR stderr byte. */
  startupTimeoutMs?: number;
  /** Optional caller cancellation; termination still waits for child close/reap. */
  signal?: AbortSignal;
  /** The absolute prompt-file path for claude (informational; runner reads argv). */
  promptFile?: string;
  /** The launcher host (lets the default runner pick the right usage-line scanner). */
  host?: HostRunHost;
  finalResultSchema?: typeof ACCEPTANCE_REVIEW_FINAL_SCHEMA;
  /** Which complete lines to retain for usage parsing (bounded, last-wins). */
  retainUsageLine?: HostRunUsageLineRetainer;
  /** Prompt bytes written to child stdin and then closed (Codex uses `exec ... -`). */
  stdinText?: string;
  /** Called exactly once after a successful spawn and identity capture. */
  onSpawn?: (identity: HostRunProcessIdentity) => void;
  /** Authoritative child close, before any asynchronous descendant cleanup. */
  onClose?: (closedAt: string) => void;
  /**
   * Managed-review adapter seam. The worker holds the signing key in memory;
   * the runner exposes only this signed, identity-bound payload on child fd 3.
   */
  reviewInvocationPayload?: (identity: HostRunProcessIdentity) => string;
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
  /**
   * Digest of every raw stdout byte observed by the runner. The production
   * runner retains only bounded parser state, so provenance must not be
   * reconstructed from `stdout` (which may be only the retained usage line).
   */
  stdoutDigest?: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /**
   * The default runner observed the child's authoritative `close` boundary
   * before any later deadline callback. Consumers use this only to keep a
   * managed terminal from contradicting the sealed provider result while
   * post-close process-group cleanup is still running.
   */
  closeObserved?: boolean;
  /**
   * Exact wall-clock close boundary from the production runner. A managed
   * close fence may accept a deadline request only when it was persisted at
   * or after this boundary; injected runners without this proof stay
   * fail-closed.
   */
  closeObservedAt?: string | null;
  timeoutKind?: 'startup_no_output_timeout' | 'total_timeout' | null;
  terminalReason?: 'completed' | 'exit_nonzero' | 'spawn_error' | 'child_error' | 'aborted' | 'startup_no_output_timeout' | 'total_timeout';
  firstOutputMs?: number | null;
  durationMs?: number;
  failureKind?: HostExecutionFailureKind;
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
   * Provider-adapter-owned final assistant result. This is a separate bounded
   * lane from `stdout`: the latter is only the usage parser lane for the
   * production runner and arbitrary live chunks remain passthrough-only.
   */
  finalAssistantResult?: string | null;
  /** Number of trusted terminal assistant-result candidates observed. */
  finalAssistantResultCount?: number;
  /** A trusted terminal result candidate exceeded the bounded lane. */
  finalAssistantResultTruncated?: boolean;
  /**
   * F-008: non-null when the live passthrough sink threw (e.g. EPIPE after the
   * consumer closed the pipe). Delivery stopped at the FIRST failure (no
   * per-chunk retry) but the run itself completed and usage scanning continued;
   * the message surfaces the degradation honestly instead of crashing the run.
   */
  passthroughError?: string | null;
  processIdentity?: HostRunProcessIdentity | null;
  /** True only after the child closed and its isolated process group is empty. */
  replacementSafe?: boolean;
  residualProcessGroup?: boolean;
  processCleanup?: HostRunProcessCleanup | null;
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
  /** Sealed layout from managed worker. */
  managedReadonlyLayout?: ManagedReadonlyLayout;
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
  /** Optional first-output deadline, independent of timeoutMs total runtime. */
  startupTimeoutMs?: number;
  /** Optional caller cancellation. */
  signal?: AbortSignal;
  /** Exact protected launcher profile owned by cross_host_review or the managed-review worker. */
  launchProfile?: 'cross_host_review_codex' | 'managed_reviewer';
  finalResultSchema?: typeof ACCEPTANCE_REVIEW_FINAL_SCHEMA;
  /**
   * Internal durable-run identity for the managed Claude prompt custody path.
   * It is deliberately not a public CLI argument: the managed worker supplies
   * its sealed spec.runId so terminal reconciliation can remove only this
   * run's cwd-local one-shot prompt leaf after an abnormal worker exit.
   */
  managedRunId?: string;
  env: NodeJS.ProcessEnv;
  /** Optional accounting/admission env; provider still receives only `env`. */
  usageEnv?: NodeJS.ProcessEnv;
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
  /** Complete bounded provider stdout usage events, never arbitrary tool text or stderr. */
  onProviderUsage?: (usage: LiveProviderUsage) => void;
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
  /** Durable supervisor hook for provider pid/pgid/fingerprint persistence. */
  onProcessSpawn?: (identity: HostRunProcessIdentity) => void;
  /** Supervisor fence; closing the provider does not yet prove descendant cleanup. */
  onProcessClose?: (closedAt: string) => void;
  reviewInvocationPayload?: (identity: HostRunProcessIdentity) => string;
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
  /** See HostRunSpawnResult.closeObserved; injected legacy runners project false. */
  closeObserved?: boolean;
  /** See HostRunSpawnResult.closeObservedAt; null without a production close timestamp. */
  closeObservedAt?: string | null;
  timeoutKind: 'startup_no_output_timeout' | 'total_timeout' | null;
  terminalReason: HostRunSpawnResult['terminalReason'] | null;
  firstOutputMs: number | null;
  durationMs: number | null;
  failureKind: HostExecutionFailureKind | null;
  stdout: string;
  /** Complete raw stdout digest when the runner can observe the full stream. */
  stdoutDigest?: string;
  stderr: string;
  usageSummary: HostRunUsageSummary;
  /**
   * F-008: non-null when the live passthrough sink failed mid-run (first failure
   * disables further delivery; the run, usage parsing, slot release, and the
   * ledger final all still complete). Null when live output delivered cleanly
   * or the run never spawned.
   */
  passthroughError: string | null;
  processIdentity: HostRunProcessIdentity | null;
  replacementSafe: boolean;
  residualProcessGroup: boolean;
  processCleanup: HostRunProcessCleanup | null;
  finalAssistantResult: string | null;
  finalAssistantResultCount: number;
  finalAssistantResultTruncated: boolean;
}

/** Nonzero process-exit sentinel for a fail-closed cap refusal. */
export const HOST_RUN_REFUSAL_EXIT_CODE = 3;


// ---------------------------------------------------------------------------
// Attribution / phase resolution
// ---------------------------------------------------------------------------

function ledgerHostKind(host: HostRunHost): string {
  return host === 'codex' ? 'codex' : host === 'claude' ? 'claude-code' : 'antigravity';
}

function hostProviderName(host: HostRunHost): string {
  return host === 'codex' ? 'openai' : host === 'claude' ? 'anthropic' : 'antigravity';
}

function resolvePhase(
  storyId: string | null,
  explicitPhase: string | undefined,
  resolveStory: HostRunStoryResolver | undefined,
): string {
  if (storyId === null) return explicitPhase && explicitPhase.length > 0 ? explicitPhase : 'adhoc';
  if (explicitPhase && explicitPhase.length > 0) return explicitPhase;
  if (!resolveStory) {
    throw new Error(
      `host_run: cannot resolve a phase for story "${storyId}" without --phase and without a configured story resolver `
      + '(internal: the handler must inject resolveStory); pass --phase or run adhoc',
    );
  }
  const meta = resolveStory(storyId);
  if (meta === null) {
    throw new Error(`host_run: unknown story "${storyId}" (not found in the configured story store); refuse pre-spawn`);
  }
  return meta.phase && meta.phase.length > 0 ? meta.phase : 'adhoc';
}

function assertReviewRunIdBinding(
  storyId: string | null,
  reviewRunId: string | null | undefined,
): void {
  if (!reviewRunId) return;
  if (storyId && !reviewRunId.startsWith(`${storyId}:`)) {
    throw new Error(
      `host_run: reviewRunId "${reviewRunId}" does not belong to story "${storyId}" `
      + '(a reviewRunId must be "<storyId>:..."); refuse pre-spawn to avoid a cross-story ledger mis-join',
    );
  }
}

/**
 * Deprecated compatibility aliases. The canonical implementation and all
 * ownership/reclaim semantics live exclusively in provider-process-registry.
 */
export {
  PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT as HOST_RUN_MAX_CONCURRENT_DEFAULT,
  acquireProviderProcessSlot as acquireHostRunSlot,
  providerProcessSlotsDir as hostRunSlotsDir,
  releaseProviderProcessSlot as releaseSlot,
  resolveProviderProcessMaxConcurrent as resolveMaxConcurrent,
  resolveProviderProcessSlotStaleMs as resolveSlotStaleMs,
  scanLiveProviderProcessSlots as scanLiveSlots,
  writeProviderProcessSlotExclusive as writeSlotFileExclusive,
} from './provider-process-registry.js';
export interface AcquiredHostRunSlot extends AcquiredProviderProcessSlot {}
export type HostRunLiveDescriptor = ProviderProcessLiveDescriptor;

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
export const HOST_RUN_FAILURE_TEXT_CAP = 64 * 1024;
export const HOST_RUN_FINAL_ASSISTANT_RESULT_CAP = 256 * 1024;
const HOST_RUN_FAILURE_CLASSIFICATION_WINDOW = 2 * 1024;

// Stable precedence for concurrently observable terminal facts. More specific
// launch/authentication diagnoses win over generic timeout/unknown outcomes and
// are sticky once observed from either output stream.
const HOST_FAILURE_PRECEDENCE: Readonly<Record<HostExecutionFailureKind, number>> = {
  none: 0,
  unknown: 1,
  unsupported: 2,
  silent_final_output: 2,
  version_failed: 3,
  timeout: 4,
  wrong_launcher: 5,
  interactive: 6,
  auth: 7,
  missing_executable: 8,
};

function preferredHostFailure(
  current: HostExecutionFailureKind,
  observed: HostExecutionFailureKind,
): HostExecutionFailureKind {
  return HOST_FAILURE_PRECEDENCE[observed] > HOST_FAILURE_PRECEDENCE[current] ? observed : current;
}

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
 * Bounded, provider-specific terminal-result lane. It accepts only the
 * canonical adapter events emitted by the provider CLI and never examines
 * stderr, tool-log payloads, or arbitrary passthrough chunks as evidence.
 */
export const MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION = 'lattice.managed_review_final_proposal.v1' as const;
export const MANAGED_REVIEW_CLAUDE_JSON_SCHEMA_MAX_BYTES = 16 * 1024;

export interface ManagedReviewFinalEnvelopeReadManifest extends Record<string, unknown> {
  filesReadFully: string[];
  filesTriagedByName: string[];
  scanEscalationReason: string | null;
  candidateSpecSetDigest: string;
  corpusDigest: string;
}

export interface ManagedReviewFinalEnvelopeFinding extends Record<string, unknown> {
  desc: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'happy' | 'edge' | 'adversarial' | 'missing';
  files?: string[];
  evidenceState?: 'suspected' | 'verified';
  uncertaintyReason?: string;
}

export interface ManagedReviewFinalEnvelopeRecord extends Record<string, unknown> {
  schemaVersion: typeof MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION;
  storyId: string;
  providerAgent: string;
  lane: string;
  reviewRunId: string;
  conclusion: 'pass' | 'findings';
  note?: string;
  findings?: ManagedReviewFinalEnvelopeFinding[];
  inventoryCritic?: ManagedInventoryCritic;
  readManifest: ManagedReviewFinalEnvelopeReadManifest;
  readLog: Record<string, unknown>;
}

/**
 * Claude Code's structured-output schema is necessarily a CLI argument. Keep it
 * bounded and non-secret: it contains only the already-auditable managed review
 * tuple plus public vocabulary, never prompt bytes, capabilities, or verdicts.
 */
export function managedReviewClaudeJsonSchema(args: HostRunArgs): string {
  if (!args.storyId || !args.reviewRunId || !args.lane || args.agentType !== args.lane) {
    throw new Error('host_run: managed Claude JSON Schema requires exact storyId/reviewRunId/lane/agentType binding');
  }
  // Keep the provider schema inside Claude Structured Outputs' supported core
  // subset. Richer semantic constraints (non-blank text, digests, non-empty
  // findings, and pass/findings exclusivity) are still enforced by the exact
  // local envelope parser before any bytes are sealed as evidence.
  const nonBlankString = { type: 'string' };
  const stringArray = { type: 'array', items: { type: 'string' } };
  const digest = { type: 'string' };
  const readManifest = {
    type: 'object',
    additionalProperties: false,
    required: ['filesReadFully', 'filesTriagedByName', 'scanEscalationReason', 'candidateSpecSetDigest', 'corpusDigest'],
    properties: {
      filesReadFully: stringArray,
      filesTriagedByName: stringArray,
      scanEscalationReason: { type: ['string', 'null'] },
      candidateSpecSetDigest: digest,
      corpusDigest: digest,
    },
  };
  const readLog = {
    type: 'object',
    additionalProperties: false,
    required: ['filesReadFully', 'filesTriagedByName', 'summary', 'digest'],
    properties: {
      filesReadFully: stringArray,
      filesTriagedByName: stringArray,
      summary: {
        type: 'object',
        additionalProperties: false,
        required: ['readCount', 'tokenCount'],
        properties: {
          // B-137a: state the constraint the gate actually enforces.
          // diagnoseManagedReviewerReadEvidence requires
          // readCount === filesReadFully.length (unique paths), but the schema
          // previously said only "integer". A provider reasonably read this as
          // "number of read operations I performed" and reported its tool-call
          // count (e.g. 14) against a 1-entry filesReadFully, so a substantive,
          // otherwise-valid verdict was discarded as malformed with no hint at
          // which field was wrong. Describing the invariant here is the prompt
          // half of the two-layer process-fact contract; the gate remains the
          // hard fallback and is unchanged.
          readCount: {
            type: 'integer',
            description: 'MUST equal the number of unique paths in filesReadFully (not the number of read operations performed).',
          },
          tokenCount: { type: ['integer', 'null'] },
        },
      },
      digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  };
  const finding = {
    type: 'object',
    additionalProperties: false,
    required: ['desc', 'severity', 'category'],
    properties: {
      desc: nonBlankString,
      severity: { enum: ['critical', 'high', 'medium', 'low'] },
      category: { enum: ['happy', 'edge', 'adversarial', 'missing'] },
      files: { type: 'array', items: nonBlankString },
      evidenceState: { enum: ['suspected', 'verified'] },
      uncertaintyReason: nonBlankString,
    },
  };
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'storyId', 'providerAgent', 'lane', 'reviewRunId', 'conclusion', 'readManifest', 'readLog'],
    properties: {
      schemaVersion: { const: MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION },
      storyId: { const: args.storyId },
      providerAgent: { const: args.agentType },
      lane: { const: args.lane },
      reviewRunId: { const: args.reviewRunId },
      conclusion: { enum: ['pass', 'findings'] },
      // Claude's raw provider schema rejects minLength. The exact local parser
      // below enforces the trimmed 10-character diagnostic-note minimum before
      // any proposal can reach persistence.
      note: nonBlankString,
      findings: { type: 'array', items: finding },
      ...(args.lane === 'proof-or-stop-review-topology-critic' ? { inventoryCritic: managedInventoryCriticJsonSchema } : {}),
      readManifest,
      readLog,
      readDiagnostics: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'severity', 'message'],
          properties: {
            code: { enum: [
              'read_manifest_missing_full_read',
              'read_manifest_extra_full_read',
              'read_manifest_missing_triage',
              'read_manifest_extra_triage',
              'full_scan_without_scanEscalationReason',
            ] },
            severity: { const: 'finding' },
            message: nonBlankString,
            path: nonBlankString,
          },
        },
      },
    },
    // Claude Code forwards this raw provider input_schema, whose top level
    // rejects oneOf/allOf/anyOf. Keep provider-facing common shape constraints
    // flat; the unchanged local parser remains authoritative for conclusion-
    // specific note/findings presence, exclusivity, and non-empty semantics.
  };
  const encoded = JSON.stringify(schema);
  if (Buffer.byteLength(encoded, 'utf8') > MANAGED_REVIEW_CLAUDE_JSON_SCHEMA_MAX_BYTES) {
    throw new Error(`host_run: managed Claude JSON Schema exceeds ${MANAGED_REVIEW_CLAUDE_JSON_SCHEMA_MAX_BYTES} bytes`);
  }
  return encoded;
}

export type ManagedReviewFinalEnvelopeClassification =
  | { kind: 'ordinary' }
  | { kind: 'malformed' }
  | { kind: 'valid'; envelope: ManagedReviewFinalEnvelopeRecord };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Shared strict validator consumed at adapter, persistence, and import/gate boundaries. */
export function isStrictManagedReviewFindingProposal(value: unknown): value is ManagedReviewFinalEnvelopeFinding {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(['desc', 'severity', 'category', 'files', 'evidenceState', 'uncertaintyReason']);
  if (Object.keys(value).some(key => !allowed.has(key))) return false;
  if (typeof value.desc !== 'string' || value.desc.trim().length === 0) return false;
  if (typeof value.severity !== 'string' || !['critical', 'high', 'medium', 'low'].includes(value.severity)) return false;
  if (typeof value.category !== 'string' || !['happy', 'edge', 'adversarial', 'missing'].includes(value.category)) return false;
  if (value.files !== undefined
    && (!isStringArray(value.files) || value.files.some(file => file.trim().length === 0))) return false;
  if (value.evidenceState !== undefined
    && value.evidenceState !== 'suspected'
    && value.evidenceState !== 'verified') return false;
  if (value.evidenceState === 'suspected') {
    if (typeof value.uncertaintyReason !== 'string' || value.uncertaintyReason.trim().length === 0) return false;
  } else if (value.uncertaintyReason !== undefined) {
    return false;
  }
  return true;
}

/**
 * A formal managed verdict cannot be a bare assertion. The provider must
 * supply non-empty read evidence and both routing digests; the managed import
 * handler then binds those digests to the current candidate artifact even
 * while that artifact's rollout mode is shadow.
 */
export function hasRequiredManagedReviewReadEvidence(
  readManifest: unknown,
  readLog: unknown,
): boolean {
  try {
    const manifest = normalizeReviewerReadManifest(readManifest);
    const log = normalizeReviewerReadLogEvidence(readLog);
    return manifest.filesReadFully.length > 0
      && log.filesReadFully.length > 0
      && log.summary.readCount > 0
      && !!manifest.candidateSpecSetDigest
      && !!manifest.corpusDigest
      && diagnoseManagedReviewerReadEvidence({ readManifest: manifest, readLog: log }).length === 0;
  } catch {
    return false;
  }
}

/**
 * Classify one provider-owned final assistant text without treating ordinary
 * Codex progress messages as proposal candidates. A message that explicitly
 * names the managed proposal schema remains fail-closed when malformed; valid
 * envelopes receive a second semantic/provenance validation in the managed
 * worker before any immutable proposal is written.
 */
export function classifyManagedReviewFinalEnvelope(text: string): ManagedReviewFinalEnvelopeClassification {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.includes(MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION)
      ? { kind: 'malformed' }
      : { kind: 'ordinary' };
  }
  if (!isPlainRecord(parsed)) return { kind: 'ordinary' };
  if (parsed.schemaVersion !== MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION) {
    return trimmed.includes(MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION)
      ? { kind: 'malformed' }
      : { kind: 'ordinary' };
  }

  const conclusion = parsed.conclusion;
  const allowed = new Set([
    'schemaVersion', 'storyId', 'providerAgent', 'lane', 'reviewRunId', 'conclusion',
    'readManifest', 'readLog', 'readDiagnostics', 'note', 'findings', 'inventoryCritic',
  ]);
  const readManifest = parsed.readManifest;
  const validReadManifest = isPlainRecord(readManifest)
    && isStringArray(readManifest.filesReadFully)
    && isStringArray(readManifest.filesTriagedByName)
    && (readManifest.scanEscalationReason === null || typeof readManifest.scanEscalationReason === 'string')
    && typeof readManifest.candidateSpecSetDigest === 'string'
    && typeof readManifest.corpusDigest === 'string';
  const validDiagnosticNote = typeof parsed.note === 'string' && parsed.note.trim().length >= 10;
  const validConclusionPayload = conclusion === 'pass'
    ? validDiagnosticNote
      && (parsed.findings === undefined || (Array.isArray(parsed.findings) && parsed.findings.length === 0))
    : conclusion === 'findings'
      && Array.isArray(parsed.findings)
      && parsed.findings.length > 0
      && parsed.findings.every(isStrictManagedReviewFindingProposal)
      && (parsed.note === undefined || validDiagnosticNote);
  if (Object.keys(parsed).some(key => !allowed.has(key))
    || typeof parsed.storyId !== 'string'
    || typeof parsed.providerAgent !== 'string'
    || typeof parsed.lane !== 'string'
    || typeof parsed.reviewRunId !== 'string'
    || !validReadManifest
    || !hasRequiredManagedReviewReadEvidence(readManifest, parsed.readLog)
    || !validConclusionPayload
    || (parsed.inventoryCritic !== undefined && !isManagedInventoryCritic(parsed.inventoryCritic, String(parsed.lane), String(parsed.providerAgent), Array.isArray(parsed.findings) ? parsed.findings.length : 0))
    || (parsed.readDiagnostics !== undefined && !Array.isArray(parsed.readDiagnostics))) {
    return { kind: 'malformed' };
  }
  return { kind: 'valid', envelope: parsed as ManagedReviewFinalEnvelopeRecord };
}

export class FinalAssistantResultScanner {
  private partial = '';
  private skippingCandidate = false;
  /**
   * Codex's ordinary `exec` transport is not JSONL. Retain only one bounded
   * contiguous raw stdout block, so an exact standalone proposal can be
   * recognized at terminal flush without treating arbitrary lines as evidence.
   */
  private rawCodexStdout = '';
  private rawCodexStdoutTruncated = false;
  private result: string | null = null;
  private candidateCount = 0;
  private candidateTruncated = false;

  constructor(
    private readonly host: HostRunHost | undefined,
    private readonly cap: number = HOST_RUN_FINAL_ASSISTANT_RESULT_CAP,
    private readonly schemaVersion: string = MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION,
  ) {}

  private classification(text: string): { kind: string } {
    if (this.schemaVersion === MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION) return classifyManagedReviewFinalEnvelope(text);
    // Capture only this purpose; the worker validates the full bound schema before signing.
    return { kind: text.includes(this.schemaVersion) ? 'candidate' : 'ordinary' };
  }

  push(text: string): void {
    if ((this.host !== 'codex' && this.host !== 'claude') || text.length === 0) return;
    let data = text;
    while (data.length > 0) {
      const nl = data.indexOf('\n');
      if (nl === -1) {
        if (this.skippingCandidate) return;
        if (this.partial.length + data.length > this.cap) {
          this.markOversizeCandidate(`${this.partial}${data.slice(0, Math.max(0, this.cap - this.partial.length))}`);
          this.partial = '';
          this.skippingCandidate = true;
          return;
        }
        this.partial += data;
        return;
      }
      const segment = data.slice(0, nl);
      data = data.slice(nl + 1);
      if (this.skippingCandidate) {
        this.skippingCandidate = false;
        this.partial = '';
        continue;
      }
      if (this.partial.length + segment.length > this.cap) {
        this.markOversizeCandidate(`${this.partial}${segment.slice(0, Math.max(0, this.cap - this.partial.length))}`);
        this.partial = '';
        continue;
      }
      this.consider(this.partial + segment, true);
      this.partial = '';
    }
  }

  flush(): void {
    if (this.skippingCandidate) {
      this.skippingCandidate = false;
      this.partial = '';
      return;
    }
    if (this.partial.length > 0) this.consider(this.partial, false);
    this.partial = '';
    this.flushRawCodexStdout();
  }

  /**
   * B-137a:F-104 — record that a canonical-looking candidate was too large.
   *
   * `candidateTruncated` is a LATCH on purpose: an oversize canonical candidate
   * must never be silently forgotten, because
   * parseManagedReviewFinalProposal() checks finalAssistantResultTruncated
   * first and refuses the run rather than accept a possibly-truncated verdict.
   * That is deliberately fail-closed.
   *
   * The asymmetry the reviewer flagged is real but intended. Note the reset in
   * consider() is CODEX-ONLY (it sits inside `if (this.host === 'codex')`):
   * codex may emit several assistant messages, so later ordinary prose proves
   * an earlier candidate was not the terminal one and the latch may be cleared.
   * For claude there is no such reset at all — one result envelope is expected,
   * so nothing can retroactively prove an earlier candidate non-terminal.
   *
   * Either way an oversize candidate carries no proof of non-terminality: a
   * following valid proposal could be a second verdict rather than a
   * correction, and silently preferring it would let a provider retry its way
   * past the single-verdict guard. So the latch stays, and the run fails closed
   * with managed_review_final_result_oversize.
   */
  private markOversizeCandidate(prefix: string): void {
    const looksCanonical = this.host === 'codex'
      ? prefix.includes(this.schemaVersion)
        && (!prefix.includes('"item.completed"') || prefix.includes('"agent_message"'))
      : prefix.includes('"type":"result"') || prefix.includes('"type": "result"');
    if (looksCanonical) {
      this.candidateCount += 1;
      this.candidateTruncated = true;
      this.result = null;
    } else if (this.host === 'codex' && !prefix.includes('"item.completed"')) {
      // A non-JSONL raw block after a wrapped proposal proves that proposal was
      // not the exact terminal assistant result. Do not let an oversized
      // ordinary stdout line preserve earlier REVIEW evidence.
      this.clearCodexCandidate();
    }
  }

  private consider(line: string, terminated: boolean): void {
    const event = parseJsonObjectLine(line);
    let candidate: unknown;
    if (this.host === 'codex') {
      // `codex exec` without --json writes the final assistant text directly
      // to stdout. A top-level managed envelope (including malformed text that
      // names the schema) is a bounded raw candidate. JSONL events retain the
      // existing item.completed/agent_message-only behavior.
      if (!event) {
        this.appendRawCodexStdout(`${line}${terminated ? '\n' : ''}`);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(event, 'schemaVersion') || typeof event.type !== 'string') {
        this.appendRawCodexStdout(`${line}${terminated ? '\n' : ''}`);
        return;
      }
      this.flushRawCodexStdout();
      if (event.type !== 'item.completed') return;
      const item = event.item;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
      const record = item as Record<string, unknown>;
      if (record.type !== 'agent_message') return;
      candidate = record.text;
    } else if (this.host === 'claude') {
      if (!event) return;
      if (event.type !== 'result') return;
      // F-142: only a successful provider-validated structured_output is a
      // proposal candidate. Error/non-success result events and success events
      // without structured_output are ignored; event.result is never used.
      if (event.subtype !== 'success') return;
      if (!Object.prototype.hasOwnProperty.call(event, 'structured_output')) return;
      candidate = JSON.stringify(event.structured_output);
    } else {
      return;
    }
    if (typeof candidate !== 'string') return;
    if (this.host === 'codex') {
      this.considerCodexCandidate(candidate);
      return;
    }
    this.recordCandidate(candidate);
  }

  private appendRawCodexStdout(text: string): void {
    if (this.rawCodexStdoutTruncated) return;
    const next = `${this.rawCodexStdout}${text}`;
    if (Buffer.byteLength(next, 'utf8') > this.cap) {
      this.rawCodexStdout = Buffer.from(next, 'utf8').subarray(0, this.cap).toString('utf8');
      this.rawCodexStdoutTruncated = true;
      return;
    }
    this.rawCodexStdout = next;
  }

  private flushRawCodexStdout(): void {
    if (this.host !== 'codex') return;
    const raw = this.rawCodexStdout;
    const truncated = this.rawCodexStdoutTruncated;
    this.rawCodexStdout = '';
    this.rawCodexStdoutTruncated = false;
    const candidate = raw.trim();
    if (candidate.length === 0) return;
    if (truncated) {
      if (this.classification(candidate).kind === 'ordinary') {
        this.clearCodexCandidate();
      } else {
        this.candidateCount += 1;
        this.candidateTruncated = true;
        this.result = null;
      }
      return;
    }
    this.considerCodexCandidate(candidate);
  }

  private considerCodexCandidate(candidate: string): void {
    const classification = this.classification(candidate);
    if (classification.kind === 'ordinary') {
      // Codex may emit multiple assistant messages. Only the terminal one is
      // authoritative: later ordinary prose invalidates any earlier proposal
      // candidate instead of letting a progress message masquerade as final.
      this.clearCodexCandidate();
      return;
    }
    this.recordCandidate(candidate);
  }

  private clearCodexCandidate(): void {
    this.result = null;
    this.candidateCount = 0;
    this.candidateTruncated = false;
  }

  private recordCandidate(candidate: string): void {
    this.candidateCount += 1;
    if (Buffer.byteLength(candidate, 'utf8') > this.cap) {
      this.candidateTruncated = true;
      this.result = null;
      return;
    }
    this.result = candidate;
  }

  snapshot(): { result: string | null; count: number; truncated: boolean } {
    return { result: this.result, count: this.candidateCount, truncated: this.candidateTruncated };
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
export interface HostRunRunnerRuntime {
  spawnChild?: (command: string, argv: string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'] | ['pipe', 'pipe', 'pipe', 'pipe'];
    detached?: boolean;
  }) => ReturnType<typeof spawn>;
  schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  cancel?: (timer: NodeJS.Timeout) => void;
  /** Testable process-boundary seams; production uses POSIX probes/signals. */
  processGroupIsolated?: boolean;
  readProcessStartFingerprint?: (pid: number) => string | null;
  isProcessGroupAlive?: (pgid: number | null) => boolean;
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => boolean;
  /** Test seam invoked after the authoritative child-close fence is installed. */
  onChildCloseObserved?: () => void;
}

const HOST_RUN_PROCESS_GROUP_TERM_GRACE_MS = 250;
const HOST_RUN_PROCESS_GROUP_KILL_GRACE_MS = 250;
function processStartFingerprint(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  // `spawn()` publishes a pid before the child has necessarily entered the
  // process table. A single immediate `ps` probe can therefore return an
  // empty result for a perfectly valid detached provider. Treat that as a
  // transient observation gap and retry briefly; otherwise the old fallback
  // fingerprint would permanently make the real group unverified, causing a
  // timeout to wait forever because the PGID (and the direct pid fallback) are
  // correctly refused. This retry never widens signalling authority: only an
  // exact OS start fingerprint can authorize a PGID signal.
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (value.length > 0) return value;
    } catch {
      // The process may not have reached the table yet; retry below.
    }
    if (attempt + 1 < attempts) Atomics.wait(waitBuffer, 0, 0, 10);
  }
  return null;
}

function isolatedProcessGroupAlive(pgid: number | null): boolean {
  if (process.platform === 'win32' || !pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalIsolatedProcessGroup(
  identity: HostRunProcessIdentity | null,
  signal: NodeJS.Signals,
  readStartFingerprint: (pid: number) => string | null,
  send: (pgid: number, signal: NodeJS.Signals) => boolean,
): boolean {
  if (!isSafeIsolatedProviderProcessGroup(identity)) return false;
  // A stale PID/PGID must never be signalled. This exact revalidation mirrors
  // managed reconciliation: the detached group leader is authority only while
  // its observed start fingerprint still names the spawned leader.
  if (readStartFingerprint(identity.pid) !== identity.startFingerprint) return false;
  return send(identity.pgid, signal);
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32' || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    return false;
  }
}

export function defaultHostRunRunner(plan: HostRunSpawnPlan, runtime: HostRunRunnerRuntime = {}): Promise<HostRunSpawnResult> {
  return new Promise<HostRunSpawnResult>((resolve) => {
    const schedule = runtime.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const cancel = runtime.cancel ?? ((timer: NodeJS.Timeout) => clearTimeout(timer));
    const readStartFingerprint = runtime.readProcessStartFingerprint ?? processStartFingerprint;
    // Keep injected fingerprint seams deterministic while giving a custom
    // seam the same bounded retry contract as the production `ps` probe.
    const readStartFingerprintWithRetry: (pid: number) => string | null = runtime.readProcessStartFingerprint
      ? (pid: number) => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const value = readStartFingerprint(pid);
          if (value) return value;
        }
        return null;
      }
      : processStartFingerprint;
    const groupAlive = runtime.isProcessGroupAlive ?? isolatedProcessGroupAlive;
    const signalGroup = runtime.signalProcessGroup ?? signalProcessGroup;
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
    const finalResultScanner = new FinalAssistantResultScanner(plan.host, HOST_RUN_FINAL_ASSISTANT_RESULT_CAP, plan.finalResultSchema);
    const stdoutDecoder = new StringDecoder('utf8');
    const startedAt = Date.now();
    let settled = false;
    let closeObserved = false;
    let closeObservedAt: string | null = null;
    let timedOut = false;
    let timeoutKind: 'startup_no_output_timeout' | 'total_timeout' | null = null;
    let terminalReason: HostRunSpawnResult['terminalReason'] = 'completed';
    let firstOutputMs: number | null = null;
    let startupTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    let retainedStderr = '';
    // Hash the complete provider stdout stream while retaining only bounded
    // parser state. This keeps provenance honest after the retention ceiling
    // without ever persisting or surfacing the raw transcript.
    const fullStdoutHash = createHash('sha256');
    const classificationTail: Record<HostRunChunk['stream'], string> = { stdout: '', stderr: '' };
    let failureKind: HostExecutionFailureKind = 'none';
    let asyncSpawnError = false;
    let child: ReturnType<typeof spawn> | null = null;
    let processIdentity: HostRunProcessIdentity | null = null;
    let replacementSafe = true;
    let residualProcessGroup = false;
    let termSent = false;
    let killSent = false;
    const processGroupIsolated = runtime.processGroupIsolated ?? (process.platform !== 'win32' && runtime.spawnChild === undefined);
    // Managed launches publish the actual provider PID and may deliver a signed
    // descriptor on fd 3. Preserve that newer lifecycle unchanged. Plain host
    // commands can retain an owned group leader until descendant cleanup.
    const useGroupAnchor = processGroupIsolated && runtime.spawnChild === undefined
      && !plan.onSpawn && !plan.reviewInvocationPayload
      && !runtime.readProcessStartFingerprint && !runtime.signalProcessGroup;
    let providerClose: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let anchorMessageHandler: ((message: unknown) => void) | null = null;
    let stdoutHandler: ((chunk: Buffer | string) => void) | null = null;
    let stderrHandler: ((text: string) => void) | null = null;
    let stdinErrorHandler: ((error: NodeJS.ErrnoException) => void) | null = null;
    let descriptorErrorHandler: ((error: NodeJS.ErrnoException) => void) | null = null;
    let errorHandler: ((error: NodeJS.ErrnoException) => void) | null = null;
    let closeHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    let handleStdoutText: (text: string) => void = () => {};

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

    /**
     * A direct-child signal is only a safe fallback for an isolated provider
     * group while the child still proves it is the original group leader.  A
     * failed PGID revalidation may mean that the numeric child pid was reused;
     * signalling it would simply move the same unsafe authority from -pgid to
     * pid.  Preserve the residual for reconciliation instead.
     */
    const signalDirectChild = (signal: NodeJS.Signals): boolean => {
      if (processIdentity?.processGroupIsolated) {
        const leaderStillVerified = isSafeIsolatedProviderProcessGroup(processIdentity)
          && readStartFingerprint(processIdentity.pid) === processIdentity.startFingerprint;
        if (!leaderStillVerified) {
          residualProcessGroup = true;
          replacementSafe = false;
          return false;
        }
      }
      try {
        return child?.kill(signal) === true;
      } catch {
        return false;
      }
    };

    /**
     * A provider can win the spawn-vs-`ps` race even after the bounded capture
     * retries above. While the Node ChildProcess is still open, its PID cannot
     * have been reused: the original child has not reached its close/reap
     * fence. Bind the first real OS start fingerprint observed at that point,
     * then let the normal isolated-PGID predicate revalidate it. If the probe
     * remains unavailable, leave the placeholder untouched and stay fail-closed.
     */
    const bindLateStartFingerprint = (): void => {
      if (!processIdentity?.processGroupIsolated || !child || child.exitCode !== null || child.signalCode !== null) return;
      if (!processIdentity.startFingerprint?.startsWith('spawn-observed:')) return;
      // Reuse the bounded spawn-race retry here as well. Under aggregate
      // refresh load the process can remain live while one `ps` probe is
      // transiently empty; a single late probe would leave a safe provider
      // permanently unverified and make cleanup wait for the deadline.
      const observed = readStartFingerprintWithRetry(processIdentity.pid);
      if (observed) processIdentity = { ...processIdentity, startFingerprint: observed };
    };

    const clearTimersAndListener = (): void => {
      if (startupTimer) cancel(startupTimer);
      if (totalTimer) cancel(totalTimer);
      if (killTimer) cancel(killTimer);
      startupTimer = null;
      totalTimer = null;
      killTimer = null;
      if (abortListener && plan.signal) plan.signal.removeEventListener('abort', abortListener);
      abortListener = null;
    };
    const fenceDeadlineAfterClose = (): void => {
      // The close event is the child process's authoritative terminal boundary.
      // Its process-group cleanup may await after this point, but an already
      // queued deadline/abort callback must not rewrite a successful/failed
      // child close into a contradictory timeout result during that cleanup.
      if (startupTimer) cancel(startupTimer);
      if (totalTimer) cancel(totalTimer);
      startupTimer = null;
      totalTimer = null;
      if (abortListener && plan.signal) plan.signal.removeEventListener('abort', abortListener);
      abortListener = null;
    };
    const detachChildListeners = (): void => {
      if (!child) return;
      if (stdoutHandler) child.stdout?.removeListener('data', stdoutHandler);
      if (stderrHandler) child.stderr?.removeListener('data', stderrHandler);
      if (stdinErrorHandler) child.stdin?.removeListener?.('error', stdinErrorHandler);
      if (errorHandler) child.removeListener('error', errorHandler);
      if (closeHandler) child.removeListener('close', closeHandler);
      if (anchorMessageHandler) child.removeListener('message', anchorMessageHandler);
      stdoutHandler = null;
      stderrHandler = null;
      stdinErrorHandler = null;
      errorHandler = null;
      closeHandler = null;
    };
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimersAndListener();
      // stdout is consumed as raw bytes so stdoutDigest is a digest of the
      // provider's exact stream. Flush any incomplete trailing UTF-8 sequence
      // only into the bounded text/parser lanes; those lanes must never alter
      // the byte provenance already recorded above.
      const trailingStdoutText = stdoutDecoder.end();
      if (trailingStdoutText.length > 0) handleStdoutText(trailingStdoutText);
      scanner.flush();
      failureScanner.flush();
      finalResultScanner.flush();
      detachChildListeners();
      const finalResult = finalResultScanner.snapshot();
      resolve({
        stdout: scanner.retainedText(),
        stdoutDigest: fullStdoutHash.digest('hex'),
        stderr: retainedStderr,
        exitCode,
        timedOut,
        closeObserved,
        closeObservedAt,
        timeoutKind,
        terminalReason,
        firstOutputMs,
        durationMs: Math.max(0, Date.now() - startedAt),
        failureKind,
        retentionTruncated: scanner.truncated,
        failureText: failureScanner.retainedText(),
        // B-3ddc (codex round-1 F1): honor the failure lane's own truncation.
        failureRetentionTruncated: failureScanner.truncated,
        finalAssistantResult: finalResult.result,
        finalAssistantResultCount: finalResult.count,
        finalAssistantResultTruncated: finalResult.truncated,
        passthroughError,
        processIdentity,
        replacementSafe,
        residualProcessGroup,
        processCleanup: processIdentity
          ? { termSent, killSent, reaped: replacementSafe, residualProcessGroup }
          : null,
      });
    };

    try {
      child = useGroupAnchor ? spawn(process.execPath, [
        fileURLToPath(new URL('./host-run-group-anchor.js', import.meta.url)), plan.command, ...plan.argv,
      ], { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], detached: true })
        : (runtime.spawnChild ?? spawn)(plan.command, plan.argv, {
        cwd: plan.cwd,
        env: plan.reviewInvocationPayload
          ? { ...plan.env, LATTICE_MANAGED_REVIEW_INVOCATION_FD: '3' }
          : plan.env,
        stdio: plan.reviewInvocationPayload
          ? ['pipe', 'pipe', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe'],
        detached: processGroupIsolated,
      });
    } catch {
      terminalReason = 'spawn_error';
      failureKind = 'unknown';
      finish(1);
      return;
    }

    if (child.pid) {
      const spawnedAt = new Date().toISOString();
      processIdentity = {
        pid: child.pid,
        pgid: processGroupIsolated ? child.pid : null,
        spawnedAt,
        // When ps is hidden by a brokered sandbox, retain an exact
        // spawn-observation fingerprint bound to pid+time. It cannot authorize
        // PGID discovery, but the worker-signed descriptor can bind this exact
        // invocation without pretending ancestry was observable.
        startFingerprint: processGroupIsolated
          ? readStartFingerprint(child.pid) ?? `spawn-observed:${child.pid}:${spawnedAt}`
          : null,
        processGroupIsolated,
      };
    }

    const signalOwnedGroup = (): boolean => {
      if (!useGroupAnchor || !child || child.exitCode !== null || child.signalCode !== null) return false;
      bindLateStartFingerprint();
      const sent = signalIsolatedProcessGroup(processIdentity, 'SIGKILL', readStartFingerprint, signalGroup);
      killSent = sent || killSent;
      return sent;
    };
    const requestAnchorStop = (): void => {
      // Ask the owned helper to signal itself through private IPC. Explicitly
      // disconnecting from the parent can suppress ChildProcess close on Node
      // 26; retain the channel until the actual process and pipe close fence.
      if (child?.connected) child.send({ schema: 'host-group-anchor.v1', event: 'terminate' }, () => {});
    };
    const terminate = (reason: 'startup_no_output_timeout' | 'total_timeout' | 'aborted'): void => {
      if (settled || closeObserved || timeoutKind !== null || terminalReason === 'aborted') return;
      if (reason === 'aborted') {
        terminalReason = 'aborted';
      } else {
        timedOut = true;
        timeoutKind = reason;
        terminalReason = reason;
        failureKind = preferredHostFailure(failureKind, 'timeout');
      }
      clearTimersAndListener();
      if (useGroupAnchor) {
        if (!signalOwnedGroup()) requestAnchorStop();
      } else if (processIdentity?.processGroupIsolated) {
        bindLateStartFingerprint();
        const sentToGroup = signalIsolatedProcessGroup(processIdentity, 'SIGTERM', readStartFingerprint, signalGroup);
        termSent = sentToGroup || termSent;
        // An unobservable/mismatched group leader is never safe to signal by
        // PGID *or* by its bare pid: either numeric identity can have been
        // reused. Keep the residual replacement-unsafe rather than risking an
        // unrelated process.
        if (!sentToGroup) {
          termSent = signalDirectChild('SIGTERM') || termSent;
        }
        killTimer = schedule(() => {
          const killedGroup = signalIsolatedProcessGroup(processIdentity, 'SIGKILL', readStartFingerprint, signalGroup);
          killSent = killedGroup || killSent;
          if (!killedGroup) {
            killSent = signalDirectChild('SIGKILL') || killSent;
          }
        }, HOST_RUN_PROCESS_GROUP_TERM_GRACE_MS);
      } else {
        try {
          child?.kill('SIGTERM');
        } catch {
          // best-effort; settlement still waits for error/close
        }
      }
    };
    const markFirstOutput = (): void => {
      if (firstOutputMs !== null) return;
      firstOutputMs = Math.max(0, Date.now() - startedAt);
      if (startupTimer) cancel(startupTimer);
      startupTimer = null;
    };
    const observeFailureText = (stream: HostRunChunk['stream'], text: string): void => {
      if (!text) return;
      const combined = `${classificationTail[stream]}${text}`;
      const observed = classifyHostExecutionDiagnosticText(combined);
      classificationTail[stream] = combined.slice(-HOST_RUN_FAILURE_CLASSIFICATION_WINDOW);
      if (observed) {
        failureKind = preferredHostFailure(failureKind, observed);
      }
    };
    const failPromptDelivery = (
      channel: 'stdin' | 'review invocation descriptor',
      error: NodeJS.ErrnoException,
    ): void => {
      if (settled) return;
      terminalReason = 'child_error';
      failureKind = preferredHostFailure(failureKind, 'unknown');
      const detail = error.code ?? error.message ?? 'unknown';
      retainedStderr = `${retainedStderr}host_run ${channel} delivery failed: ${detail}`
        .slice(-HOST_RUN_FAILURE_TEXT_CAP);
      if (processIdentity?.processGroupIsolated) {
        const killedGroup = signalIsolatedProcessGroup(processIdentity, 'SIGKILL', readStartFingerprint, signalGroup);
        killSent = killedGroup || killSent;
        if (!killedGroup) {
          killSent = signalDirectChild('SIGKILL') || killSent;
        }
      } else {
        try { child?.kill('SIGKILL'); } catch { /* settlement remains close-owned */ }
      }
    };

    if (processIdentity && plan.onSpawn) {
      try {
        plan.onSpawn(processIdentity);
      } catch (error) {
        terminalReason = 'child_error';
        failureKind = preferredHostFailure(failureKind, 'unknown');
        retainedStderr = `${retainedStderr}host_run onSpawn failed: ${error instanceof Error ? error.message : String(error)}`
          .slice(-HOST_RUN_FAILURE_TEXT_CAP);
        if (processIdentity.processGroupIsolated) {
          const killedGroup = signalIsolatedProcessGroup(processIdentity, 'SIGKILL', readStartFingerprint, signalGroup);
          killSent = killedGroup || killSent;
          if (!killedGroup) {
            killSent = signalDirectChild('SIGKILL') || killSent;
          }
        }
        else {
          try { child?.kill('SIGKILL'); } catch { /* best-effort */ }
        }
      }
    }

    if (processIdentity && plan.reviewInvocationPayload && terminalReason !== 'child_error') {
      try {
        const descriptor = child.stdio[3];
        if (!descriptor || !('end' in descriptor)) throw new Error('provider invocation descriptor fd 3 is unavailable');
        descriptorErrorHandler = error => failPromptDelivery('review invocation descriptor', error);
        descriptor.on?.('error', descriptorErrorHandler);
        descriptor.end(plan.reviewInvocationPayload(processIdentity));
      } catch (error) {
        failPromptDelivery('review invocation descriptor', error as NodeJS.ErrnoException);
      }
    }

    // Codex's canonical managed launcher consumes the prompt from stdin (`-`).
    // Other launchers receive an empty stdin exactly as before.
    stdinErrorHandler = error => failPromptDelivery('stdin', error);
    child.stdin?.on?.('error', stdinErrorHandler);
    try {
      child.stdin?.end(plan.stdinText ?? '');
    } catch (error) {
      failPromptDelivery('stdin', error as NodeJS.ErrnoException);
    }

    if (plan.startupTimeoutMs && plan.startupTimeoutMs > 0) {
      startupTimer = schedule(() => terminate('startup_no_output_timeout'), plan.startupTimeoutMs);
    }
    if (plan.timeoutMs && plan.timeoutMs > 0) {
      totalTimer = schedule(() => terminate('total_timeout'), plan.timeoutMs);
    }
    abortListener = () => terminate('aborted');
    if (plan.signal?.aborted) abortListener();
    else plan.signal?.addEventListener('abort', abortListener, { once: true });

    handleStdoutText = (text: string): void => {
      if (text.length > 0) markFirstOutput();
      deliver({ stream: 'stdout', text });
      observeFailureText('stdout', text);
      scanner.push(text);
      // B-3ddc: the failure lane sees the same live text; delivery above is
      // untouched (the lane only keeps a bounded copy, never suppresses).
      failureScanner.push(text);
      finalResultScanner.push(text);
    };
    // Do not call setEncoding on stdout: Node would decode and replace invalid
    // bytes before the provenance hash sees them. StringDecoder preserves
    // chunk boundaries for text consumers while the hash receives raw bytes.
    stdoutHandler = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      fullStdoutHash.update(bytes);
      handleStdoutText(Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : chunk);
    };
    child.stdout?.on('data', stdoutHandler);
    child.stderr?.setEncoding('utf8');
    stderrHandler = (text: string) => {
      if (text.length > 0) markFirstOutput();
      retainedStderr = `${retainedStderr}${text}`.slice(-HOST_RUN_FAILURE_TEXT_CAP);
      deliver({ stream: 'stderr', text });
      observeFailureText('stderr', text);
    };
    child.stderr?.on('data', stderrHandler);

    errorHandler = (error: NodeJS.ErrnoException) => {
      if (!timedOut && terminalReason !== 'aborted') {
        asyncSpawnError = error.code === 'ENOENT' || error.code === 'EACCES';
        terminalReason = asyncSpawnError ? 'spawn_error' : 'child_error';
        failureKind = preferredHostFailure(failureKind, error.code === 'ENOENT' ? 'missing_executable' : 'unknown');
      }
      // Node emits `close` after `error`; settle there so every spawned child
      // follows the same close/reap boundary before capacity can be released.
    };
    child.on('error', errorHandler);
    if (useGroupAnchor) {
      anchorMessageHandler = message => {
        if (!message || typeof message !== 'object') return;
        const row = message as { schema?: string; event?: string; code?: number | string | null; signal?: NodeJS.Signals | null };
        if (row.schema !== 'host-group-anchor.v1') return;
        if (row.event === 'spawn-error') {
          asyncSpawnError = true;
          terminalReason = 'spawn_error';
          failureKind = preferredHostFailure(failureKind, row.code === 'ENOENT' ? 'missing_executable' : 'unknown');
        }
        if (row.event !== 'close' || providerClose) return;
        providerClose = { code: typeof row.code === 'number' ? row.code : null, signal: row.signal ?? null };
        if (timedOut || terminalReason === 'aborted') return;
        // Provider output is flushed before this private IPC message. Preserve
        // its outcome and clean the live group before releasing the result.
        fenceDeadlineAfterClose();
        if (!signalOwnedGroup()) {
          providerClose.code = 1;
          if (!asyncSpawnError) terminalReason = 'child_error';
          failureKind = preferredHostFailure(failureKind, 'unknown');
          const text = 'HOST_GROUP_CLEANUP_UNVERIFIED\n';
          retainedStderr = `${retainedStderr}${text}`.slice(-HOST_RUN_FAILURE_TEXT_CAP);
          deliver({ stream: 'stderr', text });
          // The private anchor can terminate its own group on disconnect;
          // never replace a failed external attestation with a bare PID kill.
          requestAnchorStop();
        }
      };
      child.on('message', anchorMessageHandler);
    }
    closeHandler = (code, signal) => {
      if (providerClose) ({ code, signal } = providerClose);
      if (settled || closeObserved) return;
      closeObserved = true;
      closeObservedAt = new Date().toISOString();
      fenceDeadlineAfterClose();
      try { plan.onClose?.(closeObservedAt); }
      catch (error) { passthroughError ??= `provider close observer: ${error instanceof Error ? error.message : String(error)}`; }
      runtime.onChildCloseObserved?.();
      if (!timedOut && terminalReason !== 'aborted' && terminalReason !== 'child_error' && terminalReason !== 'spawn_error') {
        failureKind = preferredHostFailure(failureKind, classifyHostExecutionFailure({
          error: undefined,
          signal,
          stderr: retainedStderr,
          stdout: scanner.retainedText(),
          status: code,
        }));
        terminalReason = typeof code === 'number' && code === 0 ? 'completed' : 'exit_nonzero';
      }
      const exitCode = timedOut
        ? 124
        : terminalReason === 'aborted'
          ? 130
          : asyncSpawnError || terminalReason === 'child_error' || terminalReason === 'spawn_error'
            ? 1
            : typeof code === 'number' && code >= 0 ? code : 1;
      void (async () => {
        if (processIdentity?.processGroupIsolated && groupAlive(processIdentity.pgid)) {
          const leaderStillVerified = isSafeIsolatedProviderProcessGroup(processIdentity)
            && readStartFingerprint(processIdentity.pid) === processIdentity.startFingerprint;
          if (!leaderStillVerified) {
            // The original leader has exited or can no longer be proven to be
            // the spawned process. Even when descendants remain in the old
            // PGID, that is insufficient authority for a negative-PGID signal:
            // preserve the unresolved group as replacement-unsafe instead.
            residualProcessGroup = true;
            replacementSafe = false;
            // F-209 removed the former TERM/KILL waits on this path. Yield one
            // event-loop turn so an onChildCloseObserved consumer can durably
            // write its cancellation request before terminal settlement. The
            // managed worker compares that request to closeObservedAt, so this
            // is a scheduling/persistence fence only: no signal is sent and
            // the residual group remains unsafe.
            await new Promise<void>(resolveWait => setImmediate(resolveWait));
          } else {
            termSent = signalIsolatedProcessGroup(
              processIdentity, 'SIGTERM', readStartFingerprint, signalGroup,
            ) || termSent;
            await new Promise(resolveWait => setTimeout(resolveWait, HOST_RUN_PROCESS_GROUP_TERM_GRACE_MS));
            if (groupAlive(processIdentity.pgid)) {
              killSent = signalIsolatedProcessGroup(
                processIdentity, 'SIGKILL', readStartFingerprint, signalGroup,
              ) || killSent;
              await new Promise(resolveWait => setTimeout(resolveWait, HOST_RUN_PROCESS_GROUP_KILL_GRACE_MS));
            }
            residualProcessGroup = groupAlive(processIdentity.pgid);
            replacementSafe = !residualProcessGroup;
          }
        }
        finish(exitCode);
      })();
    };
    child.on('close', closeHandler);
  });
}

// ---------------------------------------------------------------------------
// Argv materialization (writes the claude prompt file when needed)
// ---------------------------------------------------------------------------

interface MaterializedLaunch {
  command: string;
  argv: string[];
  stdinText?: string;
  promptFile?: string;
  cleanup: () => void;
}

function assertManagedPromptRunId(runId: string | undefined): asserts runId is string {
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId.includes('..')) {
    throw new Error('host_run: managed Claude prompt custody requires a safe durable managedRunId');
  }
}

/**
 * The managed worker is the sole caller for this deterministic leaf.  Unlike
 * mkdtemp's opaque name, the sealed run id lets ManagedHostRun reconciliation
 * remove exactly the crashed worker's prompt without scanning or deleting a
 * sibling reviewer prompt.
 */
export function managedClaudePromptDirectoryForRun(cwd: string, runId: string): string {
  assertManagedPromptRunId(runId);
  if (!cwd) throw new Error('host_run: managed Claude prompt custody requires the exact provider cwd');
  // B-137a main-merge fix: this resolver is the authoritative custody path and
  // must agree with the `mkdirSync` parent in materializeLaunch, which derives
  // the CANONICAL state dir. While this literal still said `.lattice`, the
  // parent directory and the per-run leaf disagreed, so the managed Claude
  // prompt never materialized (the e2e crash probe timed out waiting for it).
  return join(cwd, PROOF_OR_STOP_DIR, 'runtime', 'host-run-prompts', runId);
}

function materializeLaunch(args: HostRunArgs): MaterializedLaunch {
  if (args.launchProfile === 'cross_host_review_codex'
    || (args.launchProfile === 'managed_reviewer' && args.host === 'codex')) {
    if (args.host !== 'codex') throw new Error('host_run: protected Codex review profile requires host=codex');
    // The managed-review worker already runs the provider inside the signed
    // Darwin read-only lane. Asking Codex to install a second seatbelt profile
    // inside that lane fails with sandbox_apply: Operation not permitted and
    // prevents even read-only evidence collection. Disable only the nested
    // provider sandbox; the outer lane remains the enforcement boundary.
    const sandboxMode = args.launchProfile === 'managed_reviewer'
      ? 'danger-full-access'
      : 'read-only';
    return {
      command: 'codex',
      // Formal managed review consumes Codex's observable JSON event stream:
      // final proposal and usage/progress parsing require the terminal event,
      // not ordinary rendered final prose.
      argv: ['exec', '--json', '-s', sandboxMode, '-C', args.cwd, '-'],
      stdinText: args.promptText,
      cleanup: () => {},
    };
  }
  const spec = canonicalReviewHostLauncherSpec(args.host);
  if (args.host === 'claude') {
    // Claude Code's tool sandbox permits file reads only beneath its working
    // directory. Formal managed reviewers therefore receive the authoritative
    // one-shot prompt from the ignored runtime tree inside that exact cwd;
    // ordinary host_run keeps its legacy OS-temp transport. The leaf created by
    // mkdtemp is private and the prompt itself remains mode 0600.
    const promptParent = args.launchProfile === 'managed_reviewer'
      ? join(args.cwd, PROOF_OR_STOP_DIR, 'runtime', 'host-run-prompts')
      : tmpdir();
    if (args.launchProfile === 'managed_reviewer') {
      mkdirSync(promptParent, { recursive: true, mode: 0o700 });
    }
    const dir = args.launchProfile === 'managed_reviewer'
      ? managedClaudePromptDirectoryForRun(args.cwd, args.managedRunId ?? '')
      : mkdtempSync(join(promptParent, 'proof-or-stop-host-run-'));
    if (args.launchProfile === 'managed_reviewer') {
      try {
        // A durable run is single-launch. Reusing a prompt leaf would turn a
        // stale artifact into ambient prompt authority, so fail before spawn.
        mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          throw new Error(`host_run: managed Claude prompt custody leaf already exists for ${args.managedRunId}`);
        }
        throw error;
      }
    }
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, args.promptText, { encoding: 'utf8', mode: 0o600 });
    const full = materializeLauncherArgv(spec, { promptFile });
    const argv = full.slice(1);
    if (args.launchProfile === 'managed_reviewer') {
      // A detached managed reviewer has no human terminal on which Claude can
      // approve its required inspection/Lattice commands. Scope this mode to
      // the signed managed-review profile; ordinary Claude runs retain policy.
      argv.splice(
        Math.max(0, argv.length - 1),
        0,
        '--permission-mode', 'bypassPermissions',
        '--json-schema', args.finalResultSchema === ACCEPTANCE_REVIEW_FINAL_SCHEMA ? JSON.stringify(acceptanceReviewJsonSchema()) : managedReviewClaudeJsonSchema(args),
      );
    }
    return {
      command: full[0],
      argv,
      promptFile,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  if (args.host === 'agy') {
    throw new Error(
      'host_run: agy is unavailable for managed execution because its current print launcher accepts the prompt only in argv; '
      + 'refusing pre-spawn until the provider exposes a stdin or protected prompt-file transport',
    );
  }
  const full = materializeLauncherArgv(spec, {});
  return {
    command: full[0],
    argv: full.slice(1),
    ...(args.host === 'codex' ? { stdinText: args.promptText } : {}),
    cleanup: () => {},
  };
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
  // B-137a:F-110 — `agy` is accepted as a RECOGNISED host id here but is refused
  // before spawn in materializeLaunch (its print launcher takes the prompt only
  // in argv). Two layers on purpose: an unknown host is a caller error ("expected
  // codex | claude | agy"), whereas agy is a known host with an unmet transport
  // precondition, which deserves the specific refusal message rather than being
  // misreported as an unsupported host.
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
  const usageEnv = args.usageEnv ?? args.env;
  const passthrough = deps.passthrough ?? (() => {});
  const phase = resolvePhase(args.storyId, args.phase, deps.resolveStory);
  assertReviewRunIdBinding(args.storyId, args.reviewRunId);
  let providerSpawnObserved = false;
  const releaseAdmissionAfterResult = (
    admission: ProviderProcessAdmission,
    spawn: HostRunSpawnResult,
  ): void => {
    const cleanup = spawn.processCleanup;
    const replacementSafe = spawn.replacementSafe !== false
      && spawn.residualProcessGroup !== true
      && (cleanup === undefined || cleanup === null
        || (cleanup.reaped && !cleanup.residualProcessGroup));
    if (replacementSafe) releaseProviderProcessAdmission(admission);
    // An unsafe result intentionally leaves the token-owned slot in place.
    // The canonical registry reclaims it only after the transferred provider
    // identity is mechanically dead, preventing residual-group oversubscription.
  };

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
  const invokeRunner = async (
    launch: MaterializedLaunch,
    admission: ProviderProcessAdmission,
  ): Promise<HostRunSpawnResult> => {
    let streamed = false;
    const onChunk = (chunk: HostRunChunk): void => {
      streamed = true;
      safeDeliver(chunk);
    };
    let spawn: HostRunSpawnResult;
    try {
      const guardedLaunch = args.managedReadonlyLayout
        ? prepareManagedReadonlyLaunch(args.managedReadonlyLayout, {command: launch.command, argv: launch.argv, cwd: args.cwd})
        : {command: launch.command, argv: launch.argv, cwd: args.cwd};
      spawn = await runner({
        command: guardedLaunch.command,
        argv: guardedLaunch.argv,
        env: args.env,
        // F-011: every spawn path executes in the resolved project root.
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        startupTimeoutMs: args.startupTimeoutMs,
        signal: args.signal,
        promptFile: launch.promptFile,
        host: args.host,
        finalResultSchema: args.finalResultSchema,
        retainUsageLine: line => {
          const retained = usageLineRetainerFor(args.host)?.(line) ?? false;
          if (retained && deps.onProviderUsage) {
            const usage = parseLiveProviderUsage(args.host, line);
            if (usage) deps.onProviderUsage(usage);
          }
          return retained;
        },
        // B-3ddc: the second bounded failure lane (codex-only retainer).
        retainFailureLine: failureLineRetainerFor(args.host),
        stdinText: launch.stdinText,
        onSpawn: identity => {
          // Transfer the slot to the verified isolated provider group before
          // publishing any managed snapshot. If the worker dies in the
          // publication hand-off, the registry already retains capacity while
          // the provider PGID is live; a contender can never reclaim the slot
          // merely because the supervisor PID disappeared.
          if (!transferProviderProcessAdmissionToProvider(admission, identity)) {
            throw new Error('provider process admission transfer failed; refusing untracked provider execution');
          }
          // The durable snapshot is still published immediately afterwards,
          // preserving the exact identity for reconciliation and cleanup.
          deps.onProcessSpawn?.(identity);
          providerSpawnObserved = true;
        },
        reviewInvocationPayload: deps.reviewInvocationPayload,
        onClose: deps.onProcessClose,
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
    env: usageEnv,
  };

  const ledgerOn = isUsageLedgerEnabled(usageEnv);

  // Ledger OFF disables usage accounting and budget enforcement only. Provider
  // process admission remains mandatory: turning off a diagnostic ledger must
  // never turn off the cross-provider concurrency/supervision boundary.
  if (!ledgerOn) {
    const admission = acquireProviderProcessAdmission({
      root: args.root,
      env: usageEnv,
      host: args.host,
      storyId: args.storyId,
      agentType: args.agentType,
      startedAt: args.recordedAt,
    });
    if (!admission.admitted) {
      return {
        host: args.host,
        storyId: args.storyId,
        phase,
        agentType: args.agentType,
        spawned: false,
        blocked: true,
        refusalReason: 'concurrency_cap_exceeded',
        liveRuns: admission.liveRuns,
        exitCode: HOST_RUN_REFUSAL_EXIT_CODE,
        timedOut: false,
        timeoutKind: null,
        terminalReason: null,
        firstOutputMs: null,
        durationMs: null,
        failureKind: null,
        stdout: '',
        stderr: '',
        usageSummary: { ...disabledSummary(), reason: `concurrency_cap_exceeded (cap ${admission.cap}; usage ledger disabled)` },
        passthroughError: null,
        processIdentity: null,
        replacementSafe: true,
        residualProcessGroup: false,
        processCleanup: null,
        finalAssistantResult: null,
        finalAssistantResultCount: 0,
        finalAssistantResultTruncated: false,
      };
    }
    let spawn: HostRunSpawnResult;
    try {
      spawn = await invokeRunner(materializeLaunch(args), admission);
    } catch (error) {
      if (!providerSpawnObserved) releaseProviderProcessAdmission(admission);
      throw error;
    }
    releaseAdmissionAfterResult(admission, spawn);
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
      closeObserved: spawn.closeObserved === true,
      closeObservedAt: spawn.closeObservedAt ?? null,
      timeoutKind: spawn.timeoutKind ?? null,
      terminalReason: spawn.terminalReason ?? null,
      firstOutputMs: spawn.firstOutputMs ?? null,
      durationMs: spawn.durationMs ?? null,
      failureKind: spawn.failureKind ?? null,
      stdout: spawn.stdout,
      stdoutDigest: spawn.stdoutDigest ?? createHash('sha256').update(spawn.stdout, 'utf8').digest('hex'),
      stderr: spawn.stderr,
      usageSummary: disabledSummary(),
      passthroughError: passthroughFailure,
      processIdentity: spawn.processIdentity ?? null,
      replacementSafe: spawn.replacementSafe !== false,
      residualProcessGroup: spawn.residualProcessGroup === true,
      processCleanup: spawn.processCleanup ?? null,
      finalAssistantResult: spawn.finalAssistantResult ?? null,
      finalAssistantResultCount: spawn.finalAssistantResultCount ?? 0,
      finalAssistantResultTruncated: spawn.finalAssistantResultTruncated === true,
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
      timeoutKind: null,
      terminalReason: null,
      firstOutputMs: null,
      durationMs: null,
      failureKind: null,
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
      processIdentity: null,
      replacementSafe: true,
      residualProcessGroup: false,
      processCleanup: null,
      finalAssistantResult: null,
      finalAssistantResultCount: 0,
      finalAssistantResultTruncated: false,
    };
  }

  // Shared provider admission remains independent from usage accounting. The
  // budget guard above still runs first when accounting is enabled.
  const admission = acquireProviderProcessAdmission({
    root: args.root,
    env: usageEnv,
    host: args.host,
    storyId: args.storyId,
    agentType: args.agentType,
    startedAt: args.recordedAt,
  });
  if (!admission.admitted) {
    const blockRow = recordConcurrencyBlock(args.root, ctx, handle, args.promptText, admission.cap, opts, blockedProvider);
    // B-137a:F-126 — the count is an approximate post-refusal snapshot taken
    // after the admission lock was released, so it can read lower than the cap
    // even though the refusal was correct when decided. Say "observed" rather
    // than implying an exact figure that races the decision.
    const refusalDetail = `concurrency_cap_exceeded (${admission.liveRuns.length} live host runs observed, cap ${admission.cap})`;
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
      liveRuns: admission.liveRuns,
      exitCode: HOST_RUN_REFUSAL_EXIT_CODE,
      timedOut: false,
      timeoutKind: null,
      terminalReason: null,
      firstOutputMs: null,
      durationMs: null,
      failureKind: null,
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
      processIdentity: null,
      replacementSafe: true,
      residualProcessGroup: false,
      processCleanup: null,
      finalAssistantResult: null,
      finalAssistantResultCount: 0,
      finalAssistantResultTruncated: false,
    };
  }

  let spawn: HostRunSpawnResult;
  try {
    spawn = await invokeRunner(materializeLaunch(args), admission);
  } catch (error) {
    if (!providerSpawnObserved) releaseProviderProcessAdmission(admission);
    throw error;
  }
  // F-025: token-verified release — never deletes a reclaimed+reacquired slot.
  releaseAdmissionAfterResult(admission, spawn);

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
    closeObserved: spawn.closeObserved === true,
    closeObservedAt: spawn.closeObservedAt ?? null,
    timeoutKind: spawn.timeoutKind ?? null,
    terminalReason: spawn.terminalReason ?? null,
    firstOutputMs: spawn.firstOutputMs ?? null,
    durationMs: spawn.durationMs ?? null,
    failureKind: spawn.failureKind ?? null,
    stdout: spawn.stdout,
    stdoutDigest: spawn.stdoutDigest ?? createHash('sha256').update(spawn.stdout, 'utf8').digest('hex'),
    stderr: spawn.stderr,
    usageSummary: summary,
    passthroughError: passthroughFailure,
    processIdentity: spawn.processIdentity ?? null,
    replacementSafe: spawn.replacementSafe !== false,
    residualProcessGroup: spawn.residualProcessGroup === true,
    processCleanup: spawn.processCleanup ?? null,
    finalAssistantResult: spawn.finalAssistantResult ?? null,
    finalAssistantResultCount: spawn.finalAssistantResultCount ?? 0,
    finalAssistantResultTruncated: spawn.finalAssistantResultTruncated === true,
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
  return existsSync(providerProcessSlotsDir(root));
}
