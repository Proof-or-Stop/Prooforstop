/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: smoke suite for the host-run choke point.
 *
 * Drives the CORE (runHostRun) with FAKE injected runners in OS temp dirs — no
 * real hosts, no repo pollution. Covers:
 *   - CHK-001: codex turn.completed -> estimate(seq1) + provider-reported final
 *     (seq2 superseding) with the uncached-remainder mapping and the ORIGINAL
 *     payload digest; claude stream-json result -> provider-reported final +
 *     served model; agy -> pre-spawn refusal while its prompt transport is argv-only; codex turn.failed
 *     / no usage -> unavailable-with-reason; PROOF_OR_STOP_USAGE_LEDGER=0 keeps provider
 *     argv/output byte-compatible and writes zero usage rows while provider
 *     admission remains mandatory; host non-zero exit propagates; bounded parse buffer;
 *     prototype-pollution honesty.
 *   - CHK-002: reviewRunId->threadId, lane->subagentId, omitted -> null; phase
 *     resolves from the story index; unknown storyId + cross-story reviewRunId
 *     refused pre-spawn (runner never invoked).
 *   - CHK-007: hard-budget block (no spawn, blocked row); concurrency cap (5th run
 *     refused, blocked row reasonCode concurrency_cap_exceeded, live-run list),
 *     stale/dead-pid slot reclaim, cap env parsing, and the
 *     slot-content-never-in-ledger invariant. F-003: ATOMIC fixed-index admission
 *     (slot-0..slot-(cap-1) wx create IS the cap decision) under real contention
 *     (cap=1 double-admission, stale-reclaim race with exactly one winner).
 *     F-004: blocked rows are provider-honest (codex=openai, agy=antigravity,
 *     claude=anthropic byte-compat). F-008: a throwing passthrough sink degrades
 *     honestly (run completes, no per-chunk retry, usage final records, slot
 *     releases, passthroughError reported) instead of crashing the run.
 *     F-020: a REAL async stream EPIPE is contained too — a REAL subprocess pipes
 *     host_run's live output to a consumer that closes mid-stream, and the driver
 *     exits 0 (no crash), releases its slot, records the ledger final, and
 *     surfaces a non-null passthroughError instead of dying on an unhandled
 *     stdout/stderr 'error' event.
 *     F-023 / F-024 / F-152: the residual EPIPE-window class is closed on BOTH the final
 *     diagnostic writes AND the live passthrough. F-024 covers the DEFAULT text-mode
 *     host STDOUT path: every passthrough + diagnostic write is settle-aware with
 *     outstanding-write accounting (write + counted callback, throughput NOT
 *     serialized), and the finally drains the pending counter (bounded by a 2s
 *     defensive cap) while retaining the named 'error' listeners until any cap-losing
 *     write settles, so a late EPIPE from the
 *     FINAL chunk fires while the listeners are still attached — a real subprocess
 *     bursts stdout chunks to exit while the parent destroys the driver's STDOUT
 *     read end mid/late-stream, and the driver exits 0, releases its slot, and
 *     records the ledger final.
 *     F-011: the spawn plan binds cwd to the resolved project root (args.cwd,
 *     the same value the ledger attributes) — proven with a fake runner while
 *     the smoke process is chdir'd elsewhere, with a fail-closed empty-cwd
 *     refusal, and with a real child that prints its process.cwd().
 *     F-012: cross-process append serialization — 6 REAL concurrent child
 *     processes append via the compiled writer with zero skips, no lost
 *     writes, and an intact hash chain; a held lock + bounded wait skips
 *     (throws) instead of appending off a stale predecessor (skip-not-corrupt).
 *     F-018: ownership-aware lock reclaim — a LIVE holder (valid owner.json,
 *     alive pid) is NEVER reclaimed regardless of lock age; a DEAD holder
 *     (real exited child pid) is reclaimed immediately regardless of age; an
 *     ownerless orphan (no owner.json, old mtime — the crash-before-owner-write
 *     window) is reclaimed by the mtime backstop; release removes the lock
 *     only while owner.json still carries OUR token (a reclaimed+reacquired
 *     foreign lock survives a stale release).
 *     F-013: a dropped over-cap line forces an UNAVAILABLE final
 *     (usage_line_retention_truncated) for codex AND claude when the drop
 *     happened AFTER the retained usage line — never a stale provider-reported
 *     final.
 *     F-026: truncation poisoning is RELATIVE to the retained candidate — an
 *     over-cap NON-usage line followed by a later valid usage-bearing line
 *     records the provider-reported final honestly (the old GLOBAL flag forced
 *     unavailable); candidate-then-drop still records unavailable (F-013), and
 *     drop-only still records unavailable (F-006).
 *     F-025: slot registry ownership — acquire mints a release token into the
 *     slot file and releaseSlot unlinks ONLY on a token match, so a
 *     reclaimed+reacquired slot survives the original holder's late release
 *     (cap stays enforced); a LIVE-pid slot is never age-reclaimed (waiters
 *     refuse at cap), a dead-pid slot reclaims at any age, and the mtime
 *     backstop applies only to meta-less (crash-window / corrupt) slots.
 *     B-3ddc: a SECOND bounded lane retains the last codex turn.failed /
 *     terminal error line (same 1 MiB last-wins cap; usage lane untouched); a
 *     codex final with NO turn.completed usage records the honest
 *     turn_failed(<digest>) reason (innermost nested error.message, sanitized
 *     + hard-capped), no_turn_completed_usage_event stays the pure fallback,
 *     and a genuine usage never consults the failure lane — pinned against the
 *     exact observed B-3928 version-skew line.
 *     B-3ddc (codex round-1 F1): the failure lane's OWN retention-truncation is
 *     honored (failureRetentionTruncated) — a candidate-then-over-cap-drop marks
 *     the retained failure line stale so the reason degrades to
 *     no_turn_completed_usage_event, while a drop-then-candidate clears the flag
 *     and keeps the honest turn_failed(...) (F-026 mirror).
 *     B-3ddc (codex round-1 F2): parentheses in an error.message are neutralized
 *     ('(' -> '[', ')' -> ']') so the digest can never inject the enclosing
 *     turn_failed(...) delimiters (no-parens digest invariant).
 *   - CHK-003: the remaining proof-or-stop-initiated host spawns route through the same
 *     seam — autopilot claude repair (ledger ON adds --output-format json + records
 *     estimate/final rows with agentType autopilot-repair and an envelope-parsed
 *     excerpt; ledger OFF preserves provider argv but not mandatory admission I/O).
 *     F-016: the repair also passes the SAME
 *     pre-spawn admission as host_run — an over-budget repair refuses before the
 *     runner is invoked (blocked row hard_budget_exceeded), a saturated
 *     concurrency cap refuses with a concurrency_cap_exceeded row and no spawn,
 *     the slot is HELD during a normal repair and released after, including when
 *     the ledger is OFF. Host readiness probes (per-host preflight
 *     + unavailable final agentType host-readiness-probe), the cross-host-review
 *     codex leaf (preflight + unavailable final with the documented reason, argv
 *     unchanged), and the seam-never-throws contract under a corrupt ledger.
 *
 * Prints per-check lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type HostRunArgs, type HostRunRunner, type HostRunSpawnPlan, type HostRunSpawnResult, type HostRunStoryResolver, type HostRunRunnerRuntime } from '../../core/host-run.js';
import { type AutopilotCommandRequest, type AutopilotCommandResult, type AutopilotCommandRunner, type AutopilotExecuteArgs } from '../../core/autopilot-executor.js';
import type { AutopilotRunResult, AutopilotStep } from '../../core/autopilot.js';






import { mintAttemptId, mintLedgerCallId, mintRecordId } from '../../core/usage-ledger/ids.js';
import { resolveLedgerPath, verifyLedgerChain } from '../../core/usage-ledger/writer.js';
import type { UsageLedgerRecord, UsageLedgerRecordInput } from '../../core/usage-ledger/record.js';

export let corePassed = 0;

export let extensionPassed = 0;

export let supervisorHardeningPassed = 0;

export let streamHardeningPassed = 0;

export let evidenceMappingPassed = 0;

export const failures: string[] = [];

export const canonicalCore = process.argv.includes('--canonical-core');

export const tasksDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function check(label: string, fn: () => void): void {
  try {
    fn();
    corePassed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

export async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    corePassed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

export function extensionCheck(label: string, fn: () => void): void {
  try {
    fn();
    extensionPassed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

export async function extensionCheckAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    extensionPassed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

export async function supervisorHardeningCheckAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    supervisorHardeningPassed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

export async function streamHardeningCheckAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    streamHardeningPassed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

export function evidenceMappingCheck(label: string, childName: string, selector: string): void {
  try {
    const output = execFileSync(process.execPath, [join(tasksDir, childName)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    evidenceMappingPassed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

export const root = mkdtempSync(join(tmpdir(), 'host-run-usage-'));

export let counter = 0;

export function freshRoot(): string {
  return join(root, `case-${counter++}`);
}

export const ON = { PROOF_OR_STOP_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;

export const CODEX_USAGE = { input_tokens: 21210, cached_input_tokens: 11008, output_tokens: 85, reasoning_output_tokens: 40 };

export const CODEX_STDOUT = [
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'x' } }),
  JSON.stringify({ type: 'turn.completed', usage: CODEX_USAGE }),
].join('\n') + '\n';

export const CODEX_FAILED_STDOUT = [
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }),
].join('\n') + '\n';

export const CODEX_TURN_FAILED_B3928_LINE = '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-5.6-sol\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\\"}}"}}';

export const B3928_UPGRADE_MESSAGE = 'The \'gpt-5.6-sol\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.';

export const CLAUDE_MODEL = 'claude-opus-4-8';

export const CLAUDE_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({
    type: 'result',
    result: 'Reviewed OK, no blockers',
    model: CLAUDE_MODEL,
    usage: { input_tokens: 4200, output_tokens: 320, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
  }),
].join('\n') + '\n';

export const AGY_STDOUT = 'READY: reviewed, no blockers found\n';

export interface RunnerSink {
  calls: number;
  lastPlan: HostRunSpawnPlan | null;
}

export function makeRunner(spec: Partial<HostRunSpawnResult> & { stdout: string }, sink?: RunnerSink): HostRunRunner {
  return (plan) => {
    if (sink) {
      sink.calls += 1;
      sink.lastPlan = plan;
    }
    return {
      stdout: spec.stdout,
      stderr: spec.stderr ?? '',
      exitCode: spec.exitCode ?? 0,
      timedOut: spec.timedOut ?? false,
    };
  };
}

export function baseArgs(over: Partial<HostRunArgs> & { root: string }): HostRunArgs {
  return {
    host: 'codex',
    storyId: null,
    agentType: 'reviewer',
    promptText: 'Review the change and report findings honestly.',
    env: ON,
    recordedAt: '2026-07-10T00:00:00.000Z',
    projectRootHash: 'sha256:testroot',
    // F-011: like the production handler, bind the execution cwd to the SAME
    // root the ledger rows attribute (overridable per check).
    cwd: over.root,
    ...over,
  };
}

export function readLedger(sub: string): UsageLedgerRecord[] {
  const path = resolveLedgerPath(sub);
  if (!existsSync(path)) return [];
  return verifyLedgerChain(path);
}

export function fakeStoreResolver(phases: Record<string, string>): HostRunStoryResolver {
  return (storyId: string) => (Object.prototype.hasOwnProperty.call(phases, storyId) ? { phase: phases[storyId] } : null);
}

export function seedSlot(dir: string, index: number, pid: number): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `slot-${index}.json`);
  writeFileSync(file, JSON.stringify({ pid, startedAt: '2000-01-01T00:00:00.000Z', host: 'codex', storyId: null, agentType: 'reviewer' }), 'utf8');
  return file;
}

export function slotMeta(agentType: string): { pid: number; startedAt: string; host: string; storyId: string | null; agentType: string } {
  return { pid: process.pid, startedAt: '2026-07-10T00:00:00.000Z', host: 'codex', storyId: null, agentType };
}

export function deterministicHostRuntime() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: { end(): void };
    stdout: PassThrough;
    stderr: PassThrough;
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.pid = 4242;
  child.stdin = { end() {} };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killCount = 0;
  child.kill = () => { killCount += 1; return true; };
  const scheduled = new Map<NodeJS.Timeout, { callback: () => void; delayMs: number }>();
  const runtime: HostRunRunnerRuntime = {
    spawnChild: () => child as unknown as ReturnType<typeof spawn>,
    schedule: (callback, delayMs) => {
      const timer = {} as NodeJS.Timeout;
      scheduled.set(timer, { callback, delayMs });
      return timer;
    },
    cancel: timer => { scheduled.delete(timer); },
  };
  return {
    child,
    runtime,
    fire(delayMs: number) {
      const found = [...scheduled.entries()].find(([, task]) => task.delayMs === delayMs);
      assert.ok(found, `expected active ${delayMs}ms timer`);
      scheduled.delete(found[0]);
      found[1].callback();
    },
    activeTimers: () => scheduled.size,
    killCount: () => killCount,
    listenerCount: () => child.listenerCount('error') + child.listenerCount('close')
      + child.stdout.listenerCount('data') + child.stderr.listenerCount('data'),
  };
}

export function trackedAbortSignal() {
  let listener: (() => void) | null = null;
  let listenerCount = 0;
  const signal = {
    aborted: false,
    addEventListener(_type: string, callback: EventListenerOrEventListenerObject) {
      listener = typeof callback === 'function' ? callback as () => void : () => callback.handleEvent(new Event('abort'));
      listenerCount += 1;
    },
    removeEventListener() {
      listener = null;
      listenerCount = Math.max(0, listenerCount - 1);
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort() {
      (signal as unknown as { aborted: boolean }).aborted = true;
      listener?.();
    },
    listenerCount: () => listenerCount,
  };
}

export const DEAD_PID = 2147483646;

export interface RepairSink {
  calls: number;
  lastArgs: string[] | null;
}

export function makeRepairRunner(result: AutopilotCommandResult, sink: RepairSink): AutopilotCommandRunner {
  return (request: AutopilotCommandRequest) => {
    sink.calls += 1;
    sink.lastArgs = request.args;
    return result;
  };
}

export function repairStep(): AutopilotStep {
  return { id: 'validate', command: 'proof-or-stop validate', purpose: 'run gates', mutates: false, authorityRequired: false };
}

export function repairRequest(): AutopilotCommandRequest {
  return { executable: process.execPath, args: ['/x/cli.js', '--root', '/x', 'validate'], cwd: '/x', timeoutMS: 1000 };
}

export function repairFailResult(): AutopilotCommandResult {
  return { exitCode: 1, stdout: 'validate failed: 1 gate red', stderr: 'boom' };
}

export function repairPlan(storyId: string | null, targetPhase: string): AutopilotRunResult {
  return { story: { storyId, phase: null, exists: true }, mode: 'local', targetPhase } as unknown as AutopilotRunResult;
}

export const NO_REPAIR_ARGS: AutopilotExecuteArgs = {};

export function seedCorruptLedger(sub: string): void {
  const path = resolveLedgerPath(sub);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'this is not valid json\n', 'utf8');
}

export function minimalValidUsageRecord(): UsageLedgerRecordInput {
  return {
    schemaVersion: 1,
    recordId: mintRecordId(),
    ledgerCallId: mintLedgerCallId(),
    attemptId: mintAttemptId(),
    sequence: 1,
    supersedesRecordIds: [],
    recordedAt: '2026-07-10T00:00:00.000Z',
    projectRootHash: 'sha256:testroot',
    storyId: 'B-70e9',
    phase: 'DEV',
    agentType: 'implementer',
    subagentId: null,
    threadId: null,
    decision: { kind: 'allowed', budgetPolicyId: 'local-default', reasonCode: 'within_budget' },
    usage: {
      source: 'provider-reported',
      inputTokens: 1200,
      outputTokens: 340,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      canonical: { input: 1200, output: 340, cacheCreation: 0, cacheRead: 0 },
      raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:def' },
      estimator: null,
      unavailableReason: null,
    },
    privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
    authority: { mode: 'local', receiptId: null, receiptVerified: false },
  };
}
