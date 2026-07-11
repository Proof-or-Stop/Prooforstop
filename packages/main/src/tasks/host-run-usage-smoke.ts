#!/usr/bin/env node
/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: smoke suite for the host-run choke point.
 *
 * Drives the CORE (runHostRun) with FAKE injected runners in OS temp dirs — no
 * real hosts, no repo pollution. Covers:
 *   - CHK-001: codex turn.completed -> estimate(seq1) + provider-reported final
 *     (seq2 superseding) with the uncached-remainder mapping and the ORIGINAL
 *     payload digest; claude stream-json result -> provider-reported final +
 *     served model; agy -> unavailable (provider antigravity); codex turn.failed
 *     / no usage -> unavailable-with-reason; LATTICE_USAGE_LEDGER=0 byte-identical
 *     (zero rows, zero dirs); host non-zero exit propagates; bounded parse buffer;
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
 *     F-023 / F-024: the residual EPIPE-window class is closed on BOTH the final
 *     diagnostic writes AND the live passthrough. F-024 covers the DEFAULT text-mode
 *     host STDOUT path: every passthrough + diagnostic write is settle-aware with
 *     outstanding-write accounting (write + counted callback, throughput NOT
 *     serialized), and the finally drains the pending counter (bounded by a 2s
 *     defensive cap) BEFORE removing the 'error' listeners, so a late EPIPE from the
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
 *   - CHK-003: the remaining lattice-initiated host spawns route through the same
 *     seam — autopilot claude repair (ledger ON adds --output-format json + records
 *     estimate/final rows with agentType autopilot-repair and an envelope-parsed
 *     excerpt; ledger OFF byte-identical). F-016: the repair also passes the SAME
 *     pre-spawn admission as host_run — an over-budget repair refuses before the
 *     runner is invoked (blocked row hard_budget_exceeded), a saturated
 *     concurrency cap refuses with a concurrency_cap_exceeded row and no spawn,
 *     the slot is HELD during a normal repair and released after, and ledger OFF
 *     applies no admission at all. Host readiness probes (per-host preflight
 *     + unavailable final agentType host-readiness-probe), the cross-host-review
 *     codex leaf (preflight + unavailable final with the documented reason, argv
 *     unchanged), and the seam-never-throws contract under a corrupt ledger.
 *
 * Prints per-check lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  acquireHostRunSlot,
  defaultHostRunRunner,
  releaseSlot,
  runHostRun,
  scanCodexTurnCompletedUsage,
  usageLineRetainerFor,
  hostRunSlotsDir,
  resolveMaxConcurrent,
  writeSlotFileExclusive,
  HOST_RUN_REFUSAL_EXIT_CODE,
  HOST_RUN_RETAINED_LINE_CAP,
  HOST_RUN_RETENTION_TRUNCATED_REASON,
  UsageLineScanner,
  type HostRunArgs,
  type HostRunChunk,
  type HostRunPassthrough,
  type HostRunRunner,
  type HostRunSpawnPlan,
  type HostRunSpawnResult,
  type HostRunStoryResolver,
} from '../core/host-run.js';
import {
  runClaudeRepair,
  type AutopilotCommandRequest,
  type AutopilotCommandResult,
  type AutopilotCommandRunner,
  type AutopilotExecuteArgs,
} from '../core/autopilot-executor.js';
import type { AutopilotRunResult, AutopilotStep } from '../core/autopilot.js';
import {
  recordHostReadinessProbeUsage,
  HOST_READINESS_PROBE_AGENT_TYPE,
  HOST_READINESS_PROBE_UNAVAILABLE_REASON,
} from '../handlers/review-escalation.js';
import { classifyHostExecutionReadiness } from '../core/host-execution-readiness.js';
import {
  runCodexReviewLeaf,
  CODEX_REVIEW_VERDICT_SCHEMA,
  CODEX_REVIEW_BUDGET_BLOCKED,
  CODEX_REVIEW_CONCURRENCY_CAP_EXCEEDED,
  CROSS_HOST_REVIEW_CODEX_AGENT_TYPE,
  CROSS_HOST_REVIEW_CODEX_NO_USAGE_REASON,
  type CodexReviewRunner,
} from '../core/codex-review-leaf.js';
import { adaptCodexTurnUsage } from '../core/usage-ledger/adapters/openai.js';
import { recordDispatchFinalCodex, recordDispatchFinalForProvider } from '../core/usage-ledger/dispatch-usage.js';
import { payloadDigest } from '../core/usage-ledger/adapters/shared.js';
import { mintAttemptId, mintLedgerCallId, mintRecordId } from '../core/usage-ledger/ids.js';
import {
  acquireLedgerLock,
  appendUsageRecord,
  releaseLedgerLock,
  resolveLedgerLockPath,
  resolveLedgerPath,
  verifyLedgerChain,
  USAGE_LEDGER_LOCK_OWNER_FILENAME,
} from '../core/usage-ledger/writer.js';
import type { UsageLedgerRecord, UsageLedgerRecordInput } from '../core/usage-ledger/record.js';

let passed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
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

const root = mkdtempSync(join(tmpdir(), 'host-run-usage-'));
let counter = 0;
function freshRoot(): string {
  return join(root, `case-${counter++}`);
}

const ON = { LATTICE_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;

// ---- Fake host outputs -----------------------------------------------------

/** codex input_tokens INCLUDES cached; remainder = 21210 - 11008 = 10202. */
const CODEX_USAGE = { input_tokens: 21210, cached_input_tokens: 11008, output_tokens: 85, reasoning_output_tokens: 40 };
const CODEX_STDOUT = [
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'x' } }),
  JSON.stringify({ type: 'turn.completed', usage: CODEX_USAGE }),
].join('\n') + '\n';

const CODEX_FAILED_STDOUT = [
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }),
].join('\n') + '\n';

const CLAUDE_MODEL = 'claude-opus-4-8';
const CLAUDE_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({
    type: 'result',
    result: 'Reviewed OK, no blockers',
    model: CLAUDE_MODEL,
    usage: { input_tokens: 4200, output_tokens: 320, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
  }),
].join('\n') + '\n';

const AGY_STDOUT = 'READY: reviewed, no blockers found\n';

// ---- Runner factory --------------------------------------------------------

interface RunnerSink {
  calls: number;
  lastPlan: HostRunSpawnPlan | null;
}

function makeRunner(spec: Partial<HostRunSpawnResult> & { stdout: string }, sink?: RunnerSink): HostRunRunner {
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

function baseArgs(over: Partial<HostRunArgs> & { root: string }): HostRunArgs {
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

function readLedger(sub: string): UsageLedgerRecord[] {
  const path = resolveLedgerPath(sub);
  if (!existsSync(path)) return [];
  return verifyLedgerChain(path);
}

/**
 * F-005 seam: a fake store-backed story resolver. Maps known storyIds to their
 * phase; an unknown storyId resolves to null (so the core refuses it pre-spawn),
 * exactly like ctx.store.readStory throwing for a missing story.
 */
function fakeStoreResolver(phases: Record<string, string>): HostRunStoryResolver {
  return (storyId: string) => (Object.prototype.hasOwnProperty.call(phases, storyId) ? { phase: phases[storyId] } : null);
}

/** Seed a FIXED-INDEX slot file (`slot-<index>.json`) as a live/stale occupant. */
function seedSlot(dir: string, index: number, pid: number): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `slot-${index}.json`);
  writeFileSync(file, JSON.stringify({ pid, startedAt: '2000-01-01T00:00:00.000Z', host: 'codex', storyId: null, agentType: 'reviewer' }), 'utf8');
  return file;
}

function slotMeta(agentType: string): { pid: number; startedAt: string; host: string; storyId: string | null; agentType: string } {
  return { pid: process.pid, startedAt: '2026-07-10T00:00:00.000Z', host: 'codex', storyId: null, agentType };
}

const DEAD_PID = 2147483646; // a pid that is (all but certainly) not running

// ---- CHK-003 fixtures ------------------------------------------------------

interface RepairSink {
  calls: number;
  lastArgs: string[] | null;
}

function makeRepairRunner(result: AutopilotCommandResult, sink: RepairSink): AutopilotCommandRunner {
  return (request: AutopilotCommandRequest) => {
    sink.calls += 1;
    sink.lastArgs = request.args;
    return result;
  };
}

function repairStep(): AutopilotStep {
  return { id: 'validate', command: 'lattice validate', purpose: 'run gates', mutates: false, authorityRequired: false };
}

function repairRequest(): AutopilotCommandRequest {
  return { executable: process.execPath, args: ['/x/cli.js', '--root', '/x', 'validate'], cwd: '/x', timeoutMS: 1000 };
}

function repairFailResult(): AutopilotCommandResult {
  return { exitCode: 1, stdout: 'validate failed: 1 gate red', stderr: 'boom' };
}

function repairPlan(storyId: string | null, targetPhase: string): AutopilotRunResult {
  return { story: { storyId, phase: null, exists: true }, mode: 'local', targetPhase } as unknown as AutopilotRunResult;
}

const NO_REPAIR_ARGS: AutopilotExecuteArgs = {};

/** Seed a corrupt ledger line so the next append THROWS at chain time (swallowed by the seam). */
function seedCorruptLedger(sub: string): void {
  const path = resolveLedgerPath(sub);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'this is not valid json\n', 'utf8');
}

// ---- F-012 fixtures ----------------------------------------------------------

/** A minimal valid provider-reported record body (the writer owns integrity). */
function minimalValidUsageRecord(): UsageLedgerRecordInput {
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

async function main(): Promise<void> {
  // =========================================================================
  // CHK-001 happy: codex turn.completed -> estimate + provider-reported final
  // =========================================================================
  await checkAsync('CHK-001 codex happy: estimate(seq1) + provider-reported final(seq2) with uncached-remainder mapping', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });

    assert.equal(sink.calls, 1, 'runner invoked once');
    assert.equal(result.exitCode, 0);
    assert.equal(result.spawned, true);
    // argv built from canonical spec: <prompt> substituted, no placeholder left.
    assert.ok(sink.lastPlan);
    assert.equal(sink.lastPlan!.command, 'codex');
    assert.equal(sink.lastPlan!.argv.includes('<prompt>'), false);
    assert.ok(sink.lastPlan!.argv.includes('Review the change and report findings honestly.'));

    const records = readLedger(sub);
    assert.equal(records.length, 2, 'estimate + final');
    const estimate = records.find((r) => r.usage.source === 'prompt-size-estimate');
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(estimate && final);
    assert.equal(estimate!.sequence, 1);
    assert.equal(final!.sequence, 2);
    assert.deepEqual(final!.supersedesRecordIds, [estimate!.recordId]);
    assert.equal(final!.ledgerCallId, estimate!.ledgerCallId);
    assert.equal(final!.attemptId, estimate!.attemptId);

    // Uncached-remainder mapping.
    assert.equal(final!.usage.canonical?.input, 10202, 'canonical.input = input_tokens - cached_input_tokens');
    assert.equal(final!.usage.canonical?.cacheRead, 11008, 'cacheRead = cached_input_tokens');
    assert.equal(final!.usage.canonical?.cacheCreation, null, 'codex reports no cache-write => null');
    assert.equal(final!.usage.canonical?.output, 85);
    assert.equal(final!.usage.inputTokens, 10202);
    assert.equal(final!.provider?.name, 'openai');

    // Raw digest covers the ORIGINAL codex usage (reasoning_output_tokens preserved).
    assert.equal(final!.usage.raw?.payloadDigest, payloadDigest(CODEX_USAGE), 'digest must be over the ORIGINAL payload');

    // Summary echoes the mapped values + recordId.
    assert.equal(result.usageSummary.recorded, 'provider-reported');
    assert.equal(result.usageSummary.provider, 'openai');
    assert.equal(result.usageSummary.input, 10202);
    assert.equal(result.usageSummary.cacheRead, 11008);
    assert.equal(result.usageSummary.output, 85);
    assert.ok((result.usageSummary.recordId ?? '').startsWith('llmuse_'));
  });

  // =========================================================================
  // CHK-001 happy: claude stream-json result -> provider-reported final
  // =========================================================================
  await checkAsync('CHK-001 claude happy: stream-json result -> provider-reported final with served model', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude' }), { runner: makeRunner({ stdout: CLAUDE_STDOUT }, sink) });

    assert.equal(sink.calls, 1);
    // claude launcher materializes an absolute prompt-file path (no placeholder).
    assert.ok(sink.lastPlan);
    assert.equal(sink.lastPlan!.command, 'claude');
    assert.equal(sink.lastPlan!.argv.includes('<prompt-file>'), false);
    const promptArg = sink.lastPlan!.argv.find((a) => a.endsWith('prompt.txt'));
    assert.ok(promptArg && isAbsolute(promptArg), 'claude prompt file is absolute');
    // temp prompt file cleaned up after the run.
    assert.equal(existsSync(promptArg!), false, 'claude prompt file cleaned up');

    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final);
    assert.equal(final!.usage.inputTokens, 4200);
    assert.equal(final!.usage.outputTokens, 320);
    assert.equal(final!.usage.cacheReadInputTokens, 1500);
    assert.equal(final!.provider?.name, 'anthropic');
    assert.equal(final!.provider?.model, CLAUDE_MODEL, 'served model bound');
    assert.equal(result.usageSummary.provider, 'anthropic');
    assert.equal(result.usageSummary.input, 4200);
  });

  // =========================================================================
  // CHK-001 happy: agy -> unavailable final (provider antigravity)
  // =========================================================================
  await checkAsync('CHK-001 agy happy: unavailable final, provider antigravity, explicit reason', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'agy', agyPrintTimeout: '30m' }), { runner: makeRunner({ stdout: AGY_STDOUT }, sink) });

    assert.equal(sink.calls, 1);
    // agy print-timeout override flows into the canonical launcher.
    assert.ok(sink.lastPlan);
    const argv = sink.lastPlan!.argv;
    const tIdx = argv.indexOf('--print-timeout');
    assert.ok(tIdx >= 0 && argv[tIdx + 1] === '30m', 'agy --print-timeout override applied');

    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final);
    assert.equal(final!.provider?.name, 'antigravity');
    assert.equal(final!.provider?.model, 'unknown');
    assert.equal(final!.usage.unavailableReason, 'agy_print_mode_reports_no_usage');
    assert.equal(result.usageSummary.recorded, 'unavailable');
    assert.equal(result.usageSummary.provider, 'antigravity');
  });

  // =========================================================================
  // CHK-001 edge: codex turn.failed (no usage) -> unavailable-with-reason
  // =========================================================================
  await checkAsync('CHK-001 codex edge: turn.failed / no usage -> unavailable (no_turn_completed_usage_event), never a fabricated zero', async () => {
    const sub = freshRoot();
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_FAILED_STDOUT, exitCode: 1 }) });
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final);
    assert.equal(final!.provider?.name, 'openai');
    assert.equal(final!.usage.unavailableReason, 'no_turn_completed_usage_event');
    assert.equal(final!.usage.inputTokens, null, 'no fabricated zero');
    assert.equal(result.exitCode, 1, 'host exit propagates on the result');
  });

  // =========================================================================
  // CHK-001 edge: LATTICE_USAGE_LEDGER=0 -> byte-identical (zero rows, zero dirs)
  // =========================================================================
  await checkAsync('CHK-001 edge: ledger OFF -> zero rows, zero dirs, run still spawns + exit propagates', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env: OFF }), { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 2 }, sink) });
    assert.equal(sink.calls, 1, 'runner still invoked when ledger OFF');
    assert.equal(result.exitCode, 2, 'exit propagates when OFF');
    assert.equal(result.usageSummary.recorded, 'disabled');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'no ledger file');
    assert.equal(existsSync(join(sub, '.lattice')), false, 'no .lattice dir created');
    assert.equal(existsSync(hostRunSlotsDir(sub)), false, 'no slot dir created');
  });

  // =========================================================================
  // CHK-001 edge: host non-zero exit propagates while rows still record
  // =========================================================================
  await checkAsync('CHK-001 edge: host non-zero exit propagates while codex rows still record', async () => {
    const sub = freshRoot();
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 2 }) });
    assert.equal(result.exitCode, 2);
    const records = readLedger(sub);
    assert.equal(records.length, 2, 'estimate + final still recorded on host failure');
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'));
  });

  // =========================================================================
  // CHK-001 adversarial: bounded parse buffer + last-usage-wins
  // =========================================================================
  check('CHK-001 adversarial: flooding stdout is line-streamed; last turn.completed usage wins', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50000; i++) lines.push(JSON.stringify({ type: 'noise', i }));
    lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
    lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 7 } }));
    const usage = scanCodexTurnCompletedUsage(lines.join('\n')) as Record<string, unknown>;
    assert.ok(usage);
    assert.equal(usage.input_tokens, 900, 'last turn.completed usage wins');
    assert.equal(usage.output_tokens, 7);
    assert.equal(scanCodexTurnCompletedUsage('no json here\nplain text'), null);
  });

  // =========================================================================
  // CHK-001 adversarial: prototype-pollution / wrong-typed payload honesty
  // =========================================================================
  await checkAsync('CHK-001 adversarial: inherited/polluted usage never fabricates counts (own-property projection)', async () => {
    // Only inherited primaries -> unavailable (no own counts to read).
    const inheritedOnly = Object.create({ input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 });
    const u1 = adaptCodexTurnUsage(inheritedOnly);
    assert.equal(u1.source, 'unavailable', 'inherited-only primaries -> unavailable');

    // Own value wins over an inherited/polluted value of the same key.
    const mixed = Object.assign(Object.create({ input_tokens: 999999, output_tokens: 999999 }), { input_tokens: 100, output_tokens: 10 });
    const u2 = adaptCodexTurnUsage(mixed);
    assert.equal(u2.source, 'provider-reported');
    assert.equal(u2.canonical?.input, 100, 'own input read, not the inherited 999999');

    // cached greater than input is unusable -> unavailable, never a negative remainder.
    const u3 = adaptCodexTurnUsage({ input_tokens: 10, cached_input_tokens: 50, output_tokens: 3 });
    assert.equal(u3.source, 'unavailable', 'cached > input -> unavailable, no fabricated remainder');

    // string tokens -> the assembled record is rejected -> the seam records unavailable (never throws).
    const sub = freshRoot();
    const badStdout = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 'lots', output_tokens: 5 } }) + '\n';
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: badStdout }) });
    assert.equal(result.exitCode, 0);
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'unavailable'), 'wrong-typed usage -> unavailable final');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'no fabricated provider-reported row');
  });

  // =========================================================================
  // CHK-002: binding (threadId=reviewRunId, subagentId=lane) + phase resolution
  // =========================================================================
  await checkAsync('CHK-002 binding: reviewRunId->threadId, lane->subagentId, phase resolves from the configured store', async () => {
    const sub = freshRoot();
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', reviewRunId: 'B-70e9:RR-001', lane: 'lattice-review-quality', agentType: 'reviewer' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
    );
    assert.equal(result.phase, 'REVIEW', 'phase resolved from the configured store (no story-path read)');
    const records = readLedger(sub);
    assert.ok(records.length >= 1);
    for (const r of records) {
      assert.equal(r.threadId, 'B-70e9:RR-001');
      assert.equal(r.subagentId, 'lattice-review-quality');
      assert.equal(r.storyId, 'B-70e9');
      assert.equal(r.phase, 'REVIEW');
    }
  });

  await checkAsync('CHK-002 edge: omitted reviewRunId/lane -> threadId/subagentId null (no empty-string pollution)', async () => {
    const sub = freshRoot();
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', phase: 'adhoc' }), { runner: makeRunner({ stdout: CODEX_STDOUT }) });
    assert.equal(result.phase, 'adhoc');
    const records = readLedger(sub);
    for (const r of records) {
      assert.equal(r.threadId, null);
      assert.equal(r.subagentId, null);
      assert.notEqual(r.threadId, '');
      assert.notEqual(r.subagentId, '');
    }
  });

  await checkAsync('CHK-002 edge: unknown storyId (per configured store) fails pre-spawn (runner never invoked)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    await assert.rejects(
      () => runHostRun(
        baseArgs({ root: sub, host: 'codex', storyId: 'B-9999' }),
        { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
      ),
      /unknown story/i,
    );
    assert.equal(sink.calls, 0, 'no spawn on unknown story');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'no rows written for an unknown-story refusal');
  });

  await checkAsync('CHK-002 adversarial: cross-story reviewRunId refused pre-spawn (runner never invoked)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    await assert.rejects(
      () => runHostRun(
        baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', reviewRunId: 'B-1234:RR-009' }),
        { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
      ),
      /does not belong to story/i,
    );
    assert.equal(sink.calls, 0, 'no spawn on cross-story reviewRunId');
  });

  // =========================================================================
  // F-005: story metadata resolves through the configured store, NOT a hard-coded
  // .lattice/story/actives path; an explicit --phase never reads the store.
  // =========================================================================
  await checkAsync('F-005: explicit --phase is honored AS-IS with NO story-store read (fake resolver never consulted)', async () => {
    const sub = freshRoot();
    let resolverCalls = 0;
    const resolveStory: HostRunStoryResolver = (id: string) => {
      resolverCalls += 1;
      return id === 'B-70e9' ? { phase: 'REVIEW' } : null;
    };
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', phase: 'DEV' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory },
    );
    assert.equal(result.phase, 'DEV', 'explicit --phase used verbatim');
    assert.equal(resolverCalls, 0, 'the configured store is NEVER consulted when --phase is explicit');
    assert.equal(sink.calls, 1, 'the host still launches');
  });

  await checkAsync('F-005: unknown story is NOT refused when --phase overrides (the exact configured-storyDir bug)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    // The resolver would refuse B-9999 (unknown per the store), but --phase means
    // the store is never asked, so the host launches. Under the old hard-coded
    // .lattice/story/actives read this was refused pre-spawn.
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-9999', phase: 'REVIEW' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
    );
    assert.equal(sink.calls, 1, 'host launches even though the store does not know B-9999');
    assert.equal(result.phase, 'REVIEW', 'explicit phase honored');
    assert.equal(result.spawned, true);
  });

  await checkAsync('F-005: storyId with a store phase of null falls back to adhoc (no fabricated phase)', async () => {
    const sub = freshRoot();
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }), resolveStory: () => ({ phase: null }) },
    );
    assert.equal(result.phase, 'adhoc', 'a store with no recorded phase resolves to adhoc');
  });

  // =========================================================================
  // F-006: the DEFAULT production runner streams host output live (async spawn),
  // retains only bounded usage state, and never OOMs / fabricates on huge lines.
  // =========================================================================
  await checkAsync('F-006: default runner streams stdout live — first line reaches the sink BEFORE process exit', async () => {
    const chunks: Array<{ stream: string; text: string; at: number }> = [];
    // Print a line immediately, sleep, then print the usage event line. If the
    // runner buffered (old spawnSync), the first line would only arrive at exit.
    const script =
      'process.stdout.write("hello-live\\n");' +
      'setTimeout(function(){process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,cached_input_tokens:0,output_tokens:2}})+"\\n");}, 150);';
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      onChunk: (c: HostRunChunk) => chunks.push({ stream: c.stream, text: c.text, at: Date.now() }),
    });
    const resolvedAt = Date.now();
    const first = chunks.find((c) => c.text.includes('hello-live'));
    assert.ok(first, 'the first line streamed through the passthrough');
    assert.ok(
      resolvedAt - first!.at >= 80,
      `first line was delivered live, well before exit (gap ${resolvedAt - first!.at}ms >= the host sleep, proving streaming not buffering)`,
    );
    assert.equal(result.exitCode, 0);
    // Only the BOUNDED usage line is retained for parsing (not the first line).
    const usage = scanCodexTurnCompletedUsage(result.stdout) as Record<string, unknown> | null;
    assert.ok(usage && usage.input_tokens === 5, 'the retained usage line parses to the reported counts');
    assert.equal(result.retentionTruncated, false, 'a normal line is not flagged truncated');
  });

  await checkAsync('F-006: host output is delivered through the passthrough EXACTLY once (no double-print) with a buffered runner', async () => {
    const sub = freshRoot();
    const seen: string[] = [];
    const passthrough: HostRunPassthrough = (c) => { if (c.stream === 'stdout') seen.push(c.text); };
    // A buffered fake runner streams nothing live; the core flushes its stdout to
    // the passthrough once. The handler returns '' in text mode, so there is no
    // second copy.
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }), passthrough },
    );
    const occurrences = seen.join('').split('turn.completed').length - 1;
    assert.equal(occurrences, 1, 'buffered host stdout reached the passthrough exactly once');
    assert.equal(result.spawned, true);
  });

  await checkAsync('F-006: an oversized single usage line is bounded (dropped + truncation flag) -> no parse target, never OOM/fabrication', async () => {
    // Build a turn.completed line whose padding pushes it past the 1 MiB cap.
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const script =
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1},pad:pad})+"\\n");';
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      onChunk: () => { /* discard live (bounded memory) */ },
    });
    assert.equal(result.retentionTruncated, true, 'the over-cap line is flagged truncated');
    assert.equal(result.stdout, '', 'the over-cap line is NOT retained as a parse target');
    assert.equal(scanCodexTurnCompletedUsage(result.stdout), null, 'no usage can be parsed from an empty retention');

    // End-to-end: an empty retention (the bounded-drop outcome) records an honest
    // `unavailable` final via the seam, never a fabricated count.
    const sub = freshRoot();
    const summ = await runHostRun(
      baseArgs({ root: sub, host: 'codex' }),
      { runner: makeRunner({ stdout: '' }) },
    );
    assert.equal(summ.usageSummary.recorded, 'unavailable', 'empty retention -> unavailable, not a fabricated zero');
    assert.equal(summ.usageSummary.input, null);
  });

  // =========================================================================
  // F-013: retention truncation must force an UNAVAILABLE final. When the
  // scanner drops a LATER over-cap line, the EARLIER retained usage line is
  // known-stale (the dropped line may have carried the real final numbers).
  // Against the old code both checks below recorded a provider-reported final
  // with the stale earlier counts (runHostRun ignored spawn.retentionTruncated).
  // =========================================================================
  await checkAsync('F-013 codex: valid turn.completed then an over-cap final usage line -> unavailable (usage_line_retention_truncated), never the stale earlier numbers', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    // A REAL child through the REAL default runner: the first (valid, retained)
    // usage line is the stale decoy; the second line carries the "real" final
    // usage but blows the 1 MiB cap and is dropped by the scanner.
    const script =
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:11,cached_input_tokens:1,output_tokens:2}})+"\\n");' +
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:999,cached_input_tokens:0,output_tokens:99},pad:pad})+"\\n");';
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner });
    assert.equal(result.spawned, true);
    // The scanner DID retain the stale earlier line — exactly the trap.
    const retained = scanCodexTurnCompletedUsage(result.stdout) as Record<string, unknown> | null;
    assert.ok(retained && retained.input_tokens === 11, 'precondition: the stale EARLIER usage line is what the scanner retained');
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'unavailable final recorded');
    assert.equal(final!.usage.unavailableReason, HOST_RUN_RETENTION_TRUNCATED_REASON);
    assert.equal(final!.provider?.name, 'openai', 'unavailable final stays provider-honest');
    assert.equal(final!.usage.inputTokens, null, 'no stale count on the row');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'NO provider-reported row from the stale retained line');
    assert.equal(result.usageSummary.recorded, 'unavailable', 'result surface says unavailable');
    assert.equal(result.usageSummary.reason, HOST_RUN_RETENTION_TRUNCATED_REASON, 'result surface carries the truncation reason');
    assert.equal(result.usageSummary.input, null, 'summary never echoes the stale numbers');
  });

  await checkAsync('F-013 claude: valid result envelope then an over-cap line -> unavailable (usage_line_retention_truncated), not the stale envelope', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const staleEnvelope = JSON.stringify({
      type: 'result',
      result: 'stale earlier envelope',
      model: CLAUDE_MODEL,
      usage: { input_tokens: 4200, output_tokens: 320, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
    });
    const script =
      `process.stdout.write(${JSON.stringify(staleEnvelope)}+"\\n");` +
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(JSON.stringify({type:"result",result:"the real final",usage:{input_tokens:9,output_tokens:9},pad:pad})+"\\n");';
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude' }), { runner });
    assert.equal(result.spawned, true);
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'unavailable final recorded');
    assert.equal(final!.usage.unavailableReason, HOST_RUN_RETENTION_TRUNCATED_REASON);
    assert.equal(final!.provider?.name, 'anthropic', 'unavailable final stays provider-honest');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'NO provider-reported row from the stale envelope');
    assert.equal(result.usageSummary.recorded, 'unavailable');
    assert.equal(result.usageSummary.reason, HOST_RUN_RETENTION_TRUNCATED_REASON);
    assert.equal(result.usageSummary.input, null, 'summary never echoes the stale 4200');
  });

  // =========================================================================
  // F-026: truncation poisoning must be RELATIVE to the retained candidate.
  // Against the OLD code the scanner set a GLOBAL truncated flag on ANY
  // over-cap line, so a huge NON-usage output line early in the stream forced
  // an unavailable final even though a perfectly valid usage-bearing line was
  // retained AFTER it. Only a drop after (or without) the retained candidate
  // may poison the final (F-013/F-006 preserved).
  // =========================================================================
  check('F-026 scanner unit: drop-then-candidate clears the flag; candidate-then-drop sets it (F-013); drop-only stays set (F-006); a retained-nothing line never clears it', () => {
    const retain = usageLineRetainerFor('codex');
    const usageLine = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    const big = 'x'.repeat(HOST_RUN_RETAINED_LINE_CAP + 16);

    const dropThenCandidate = new UsageLineScanner(retain);
    dropThenCandidate.push(`${big}\n${usageLine}\n`);
    dropThenCandidate.flush();
    assert.equal(dropThenCandidate.truncated, false, 'a candidate retained AFTER the drop clears the poison');
    assert.equal(dropThenCandidate.retainedText(), usageLine, 'the candidate is the retained parse target');

    const candidateThenDrop = new UsageLineScanner(retain);
    candidateThenDrop.push(`${usageLine}\n${big}\n`);
    candidateThenDrop.flush();
    assert.equal(candidateThenDrop.truncated, true, 'a drop AFTER the candidate stays poisoned (F-013)');

    const dropOnly = new UsageLineScanner(retain);
    dropOnly.push(`${big}\n`);
    dropOnly.flush();
    assert.equal(dropOnly.truncated, true, 'a drop with NO candidate stays poisoned (F-006)');
    assert.equal(dropOnly.retainedText(), '', 'nothing retained');

    const dropThenNoise = new UsageLineScanner(retain);
    dropThenNoise.push(`${big}\n${JSON.stringify({ type: 'noise' })}\n`);
    dropThenNoise.flush();
    assert.equal(dropThenNoise.truncated, true, 'an under-cap NON-usage line never clears the poison');
  });

  await checkAsync('F-026 codex (the RED): an over-cap NON-usage line followed by a valid turn.completed -> provider-reported final with the candidate numbers (the OLD global flag forced unavailable here)', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    // A REAL child through the REAL default runner: a huge non-usage line first
    // (dropped over-cap), then the valid final usage event, retained normally.
    const script =
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(pad+"\\n");' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:21,cached_input_tokens:1,output_tokens:4}})+"\\n");';
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner });
    assert.equal(result.spawned, true);
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'provider-reported final recorded — the retained candidate postdates the drop');
    assert.equal(final!.usage.canonical?.input, 20, 'the honest candidate numbers land (uncached remainder 21-1)');
    assert.equal(final!.usage.canonical?.output, 4);
    assert.equal(records.some((r) => r.usage.source === 'unavailable'), false, 'NO unavailable row for a pre-candidate drop');
    assert.equal(result.usageSummary.recorded, 'provider-reported', 'result surface reports the recorded usage');
    assert.equal(result.usageSummary.input, 20);
    assert.notEqual(result.usageSummary.reason, HOST_RUN_RETENTION_TRUNCATED_REASON, 'no truncation reason for a superseded drop');
  });

  await checkAsync('F-026 claude: an over-cap NON-usage line followed by a valid result envelope -> provider-reported final with the served model (mirror)', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const envelope = JSON.stringify({
      type: 'result',
      result: 'the real final',
      model: CLAUDE_MODEL,
      usage: { input_tokens: 4200, output_tokens: 320, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
    });
    const script =
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(pad+"\\n");' +
      `process.stdout.write(${JSON.stringify(envelope)}+"\\n");`;
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude' }), { runner });
    assert.equal(result.spawned, true);
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'provider-reported final recorded — the retained envelope postdates the drop');
    assert.equal(final!.usage.inputTokens, 4200);
    assert.equal(final!.provider?.model, CLAUDE_MODEL, 'served model bound from the honest envelope');
    assert.equal(records.some((r) => r.usage.source === 'unavailable'), false, 'NO unavailable row for a pre-candidate drop');
    assert.equal(result.usageSummary.recorded, 'provider-reported');
    assert.equal(result.usageSummary.input, 4200);
  });

  // =========================================================================
  // F-021: the usage summary must reflect the ACTUAL ledger append, not merely
  // that the provider envelope parsed. A corrupt ledger makes appendUsageRecord
  // THROW (swallowed by the never-throw seam) while the claude/codex stdout DOES
  // carry a valid usage envelope. Against the OLD code the summary reported
  // `recorded: 'provider-reported'` (keyed on parsed usage) even though ZERO
  // rows landed — silently hiding an under-count in the honesty choke point.
  // The fix reports the skipped state (`recorded: 'none'`, reason
  // `ledger_append_failed(...)`) and never a false provider-reported claim; the
  // run still completes and the host exit code propagates.
  // =========================================================================
  await checkAsync('F-021 claude: valid stream-json usage BUT a failing (corrupt) ledger -> summary reports skipped (none, ledger_append_failed), NEVER provider-reported; run completes + exit code propagates', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub); // the next append throws at chain time (swallowed by the seam)
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'claude' }),
      { runner: makeRunner({ stdout: CLAUDE_STDOUT, exitCode: 2 }, sink) },
    );
    assert.equal(sink.calls, 1, 'the host still ran despite the failing ledger');
    assert.equal(result.spawned, true, 'the run completed');
    assert.equal(result.exitCode, 2, 'the host exit code propagates unchanged');
    // The valid usage WAS parsed (proving the false-claim trap is live), yet no
    // row landed, so the summary must NOT claim provider-reported.
    assert.notEqual(result.usageSummary.recorded, 'provider-reported', 'no false provider-reported claim when the append failed');
    assert.notEqual(result.usageSummary.recorded, 'unavailable', 'not conflated with "provider reported nothing"');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.provider, 'anthropic', 'provider still surfaced for attribution');
    assert.equal(result.usageSummary.input, null, 'no token counts for a row that never landed');
    assert.equal(result.usageSummary.cacheRead, null);
    assert.equal(result.usageSummary.output, null);
    assert.ok((result.usageSummary.reason ?? '').startsWith('ledger_append_failed('), `reason names the append failure (got ${result.usageSummary.reason})`);
    // The stderr surface: recorded='none' renders as "usage: ledger_append_failed(...)"
    // (the handler's non-"recorded" fallback line), never "usage recorded: ...".
    assert.equal(result.usageSummary.recordId, null, 'no recordId for a row that never landed');
  });

  await checkAsync('F-021 codex: valid turn.completed usage BUT a failing (corrupt) ledger -> summary reports skipped (none, ledger_append_failed), NEVER provider-reported', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 5 }, sink) },
    );
    assert.equal(sink.calls, 1, 'the host still ran despite the failing ledger');
    assert.equal(result.spawned, true);
    assert.equal(result.exitCode, 5, 'the host exit code propagates unchanged');
    // scanCodexTurnCompletedUsage(CODEX_STDOUT) is a valid provider usage — the
    // false-claim trap is live — but the append fails, so no provider-reported.
    assert.notEqual(result.usageSummary.recorded, 'provider-reported', 'no false provider-reported claim when the append failed');
    assert.notEqual(result.usageSummary.recorded, 'unavailable', 'not conflated with "provider reported nothing"');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.provider, 'openai', 'provider still surfaced for attribution');
    assert.equal(result.usageSummary.input, null, 'no token counts for a row that never landed');
    assert.ok((result.usageSummary.reason ?? '').startsWith('ledger_append_failed('), `reason names the append failure (got ${result.usageSummary.reason})`);
    assert.equal(result.usageSummary.recordId, null);
  });

  // =========================================================================
  // F-029: separate a codex provider-record BUILD failure from an APPEND
  // failure. The OLD recordDispatchFinalCodex caught buildProviderRecord AND
  // appendUsageRecord in ONE try; a provider-reported record that BUILT fine but
  // whose ledger APPEND threw (transient corrupt chain / lock-wait skip) fell
  // through to recordDispatchUnavailableFinal — and if that SECOND append
  // succeeded, a source=unavailable row landed although provider usage WAS
  // parsed, corrupting source semantics + undercounting real codex usage.
  //
  // The fix builds+validates first, then appends in its OWN try: an append throw
  // returns recorded=false with the ledger_append_failed reason and source stays
  // 'provider-reported' (keyed on the PARSED usage, never degraded to
  // 'unavailable'), and NO unavailable final is attempted.
  //
  // Determinism note: a first-append-fail / second-append-SUCCEED construction is
  // not honestly buildable from ledger state — the provider record A and the
  // fallback unavailable record B chain off the SAME predecessor and share the
  // same cross-process lock, so appendUsageRecord fails (or succeeds) IDENTICALLY
  // for both (a corrupt last line throws in readLastRecordHash for either record).
  // The observable that flips OLD->NEW under the corrupt-ledger harness is the
  // RETURNED CodexFinalResult: OLD degraded it to source='unavailable', mapped=null
  // after the swallowed provider append; NEW keeps source='provider-reported',
  // mapped=<parsed canonical>, recorded=false. The row-landing manifestation of the
  // bug (the false unavailable row) is the RED under a revert-in-dist harness; here
  // the invariant is asserted directly on the return value + the untouched ledger.
  // The healthy-ledger sub-case proves the happy path (a provider row DOES land)
  // and that source is keyed on the parse, not the append outcome.
  // =========================================================================
  await checkAsync('F-029 codex: a provider-record whose ledger APPEND fails stays source=provider-reported (recorded=false, ledger_append_failed), never degraded to a false unavailable row', async () => {
    const ctx = { storyId: 'B-70e9', phase: 'DEV', agentType: 'reviewer' };
    const opts = { recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: ON };

    // Healthy ledger (genesis): the provider record BUILDS and APPENDS — the happy
    // path is preserved by the restructure, and a provider-reported row lands.
    const okRoot = freshRoot();
    const ok = recordDispatchFinalCodex(okRoot, ctx, null, null, CODEX_USAGE, null, opts);
    assert.equal(ok.recorded, true, 'happy path: provider final appended');
    assert.equal(ok.source, 'provider-reported', 'happy path: source is provider-reported');
    assert.ok(ok.mapped, 'happy path: canonical mapping present');
    assert.equal(ok.unavailableReason, null, 'happy path: no reason');
    const okRows = readLedger(okRoot);
    assert.equal(okRows.length, 1, 'happy path: exactly one final row landed');
    assert.equal(okRows[0].usage.source, 'provider-reported', 'happy path: the landed row is provider-reported');

    // Corrupt ledger: buildProviderRecord still succeeds (valid usage), but the
    // append THROWS at chain time. The provider count is real — so it must NOT be
    // re-recorded as an unavailable final.
    const badRoot = freshRoot();
    seedCorruptLedger(badRoot); // the next append throws in readLastRecordHash
    const bad = recordDispatchFinalCodex(badRoot, ctx, null, null, CODEX_USAGE, null, opts);
    assert.equal(bad.recorded, false, 'append failed: nothing recorded');
    assert.equal(bad.source, 'provider-reported', 'F-029: source stays provider-reported — NEVER degraded to unavailable on an append failure (the OLD code returned unavailable here)');
    assert.ok(bad.mapped, 'F-029: the parsed canonical is preserved — the usage WAS parsed, only the append failed (OLD returned mapped=null)');
    assert.ok((bad.unavailableReason ?? '').startsWith('ledger_append_failed('), `F-029: honest append-failure reason (got ${bad.unavailableReason})`);
    assert.equal(bad.recordId, null, 'no recordId for a row that never landed');
    // The ledger is byte-untouched: NO second (unavailable) append was attempted,
    // so only the corrupt seed line remains — no false unavailable row landed.
    const rawLines = readFileSync(resolveLedgerPath(badRoot), 'utf8').split('\n').filter((l) => l.trim().length > 0);
    assert.equal(rawLines.length, 1, 'no final row appended (the fallback unavailable append was NOT attempted)');
    assert.equal(rawLines[0], 'this is not valid json', 'only the corrupt seed line remains — no unavailable row was written');
  });

  // =========================================================================
  // F-030: the SAME build-vs-append conflation, in the VOID codex/gemini
  // sibling recordDispatchFinalForProvider (used by lattice-dispatch
  // runBoundedRealLeafDispatch). The OLD code wrapped buildProviderRecord AND
  // appendUsageRecord in ONE try; a provider-reported record that BUILT fine
  // but whose ledger APPEND threw fell through to the unavailable-final branch,
  // and if that SECOND append succeeded a FALSE source=unavailable row landed
  // although provider usage WAS parsed. The fix mirrors F-029: build in its own
  // try (a build failure still degrades to the unavailable fallback,
  // unchanged), append in its own try (a throw is swallowed and the function
  // RETURNS — void never-throw seam, honest under-count, NO unavailable
  // attempt).
  //
  // Honesty note on what this committed check can and cannot flip: the function
  // is VOID (no CodexFinalResult to key on like F-029), and per the F-029
  // determinism note the fallback unavailable append fails IDENTICALLY under
  // any ledger-state fault (corrupt last line / ledger-as-directory: record A
  // and fallback B chain off the SAME predecessor through the same writer), so
  // under this corrupt-ledger harness OLD and NEW both land zero rows. The
  // row-landing manifestation (the false unavailable row) was proven RED with a
  // throwaway dist harness that reverts the restructure AND injects a
  // first-append-throws fault (transient-fault shape: first append fails,
  // second succeeds — OLD lands 1 source=unavailable row, NEW lands 0); see the
  // F-030 fix commit message. What THIS check pins deterministically: (healthy)
  // the happy path survives the restructure — exactly one provider-reported row
  // lands, keyed on the parse; (corrupt) the seam still never throws and NO row
  // of ANY source lands (ledger byte-untouched — regression guard for the
  // no-second-append contract half that IS observable here).
  // =========================================================================
  await checkAsync('F-030 provider (void sibling): build-vs-append separated — healthy ledger lands exactly one provider-reported row; corrupt ledger lands NO row of any source and never throws', async () => {
    const ctx = { storyId: 'B-70e9', phase: 'DEV', agentType: 'reviewer' };
    const opts = { recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: ON };
    // A valid bare openai usage object (the openai adapter's extractRawUsage
    // accepts it directly) — buildProviderRecord succeeds.
    const OPENAI_USAGE = { prompt_tokens: 500, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 50 } };

    // Healthy ledger (genesis): the provider record BUILDS and APPENDS — the
    // happy path is preserved by the restructure and source is keyed on the
    // parse (provider-reported, never unavailable).
    const okRoot = freshRoot();
    recordDispatchFinalForProvider(okRoot, ctx, null, null, 'openai', OPENAI_USAGE, 'gpt-5-codex', opts);
    const okRows = readLedger(okRoot);
    assert.equal(okRows.length, 1, 'happy path: exactly one final row landed');
    assert.equal(okRows[0].usage.source, 'provider-reported', 'happy path: the landed row is provider-reported (parsed usage is never degraded)');
    assert.equal(okRows[0].provider?.name, 'openai', 'happy path: provider attribution preserved');

    // Corrupt ledger: buildProviderRecord still succeeds (valid usage), but the
    // append THROWS at chain time. The void seam must swallow (never throw) and
    // must NOT land ANY row — in particular no source=unavailable row for usage
    // that WAS parsed.
    const badRoot = freshRoot();
    seedCorruptLedger(badRoot); // the next append throws in readLastRecordHash
    let threw = false;
    try {
      recordDispatchFinalForProvider(badRoot, ctx, null, null, 'openai', OPENAI_USAGE, 'gpt-5-codex', opts);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'void seam contract: an append failure never propagates to the dispatch caller');
    const rawLines = readFileSync(resolveLedgerPath(badRoot), 'utf8').split('\n').filter((l) => l.trim().length > 0);
    assert.equal(rawLines.length, 1, 'no final row appended (no unavailable fallback row for parsed usage)');
    assert.equal(rawLines[0], 'this is not valid json', 'only the corrupt seed line remains — the ledger is byte-untouched');
  });

  // =========================================================================
  // F-027: the F-021 honesty gate extended to the BLOCKED summaries. A cap
  // refusal writes its blocked row through the same swallowing seam — under a
  // corrupt ledger the row never lands, yet the OLD code unconditionally
  // reported `recorded: 'blocked'` and (concurrency) exposed a minted recordId
  // for a row that never persisted. The fix keys the blocked claim on the
  // ACTUAL append outcome: refusal stays fail-closed (no spawn, nonzero exit),
  // summary reports the honest skipped state (`recorded: 'none'`, no recordId)
  // with the refusal kept visible in a composed reason
  // (`<refusal>; ledger_append_failed(...)`).
  // =========================================================================
  await checkAsync('F-027 concurrency: saturated cap + failing (corrupt) ledger -> refusal fail-closed BUT summary reports none + composed reason, NEVER a blocked row / minted recordId', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub); // every append (preflight AND blocked row) throws, swallowed by the seam
    const dir = hostRunSlotsDir(sub);
    for (let i = 0; i < 4; i++) seedSlot(dir, i, process.pid); // slot-0..slot-3 held live
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    // The refusal itself is unchanged: fail-closed, no spawn, nonzero exit.
    assert.equal(sink.calls, 0, 'runner NOT invoked at the cap even with a failing ledger');
    assert.equal(result.spawned, false);
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.notEqual(result.exitCode, 0);
    // The honesty gate: no blocked-row claim for a row that never landed.
    assert.notEqual(result.usageSummary.recorded, 'blocked', 'no blocked-row claim when the append failed');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.recordId, null, 'no minted recordId for a row that never persisted');
    const reason = result.usageSummary.reason ?? '';
    assert.ok(reason.startsWith('concurrency_cap_exceeded ('), `refusal stays visible in the composed reason (got ${reason})`);
    assert.ok(reason.includes('; ledger_append_failed('), `composed reason names the append failure (got ${reason})`);
  });

  await checkAsync('F-027 budget: over-budget + failing (corrupt) ledger -> refusal fail-closed BUT summary reports none + composed reason, NEVER a blocked row', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude', env }), { runner: makeRunner({ stdout: CLAUDE_STDOUT }, sink) });
    // The refusal itself is unchanged: fail-closed, no spawn, nonzero exit.
    assert.equal(sink.calls, 0, 'runner NOT invoked over budget even with a failing ledger');
    assert.equal(result.spawned, false);
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'hard_budget_exceeded');
    assert.notEqual(result.exitCode, 0);
    // The honesty gate: no blocked-row claim for a row that never landed.
    assert.notEqual(result.usageSummary.recorded, 'blocked', 'no blocked-row claim when the append failed');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.recordId, null);
    const reason = result.usageSummary.reason ?? '';
    assert.ok(reason.startsWith('hard_budget_exceeded ('), `refusal stays visible in the composed reason (got ${reason})`);
    assert.ok(reason.includes('; ledger_append_failed('), `composed reason names the append failure (got ${reason})`);
  });

  // =========================================================================
  // F-008: a throwing passthrough sink must degrade honestly, never crash the
  // run. Against the OLD code this check dies twice: (a) the default runner
  // let the onChunk throw escape a stdout 'data' listener as an uncaught
  // EventEmitter exception (process crash, orphaned child, leaked slot); (b)
  // the core's onChunk wrapper rethrew, so runHostRun rejected with NO ledger
  // final and NO result.
  // =========================================================================
  await checkAsync('F-008: throwing passthrough — run completes, no retry, final row records, slot releases, exit + passthroughError propagate', async () => {
    // (a) Default streaming runner + real child: onChunk throws on the FIRST
    // chunk; later chunks must NOT retry the broken sink but MUST still reach
    // the usage scanner; the child's exit code must still propagate.
    let onChunkCalls = 0;
    const script =
      'process.stdout.write("first-chunk\\n");' +
      'setTimeout(function(){' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,cached_input_tokens:0,output_tokens:2}})+"\\n");' +
      'setTimeout(function(){process.exit(7);}, 60);' +
      '}, 120);';
    const spawnResult = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      onChunk: () => {
        onChunkCalls += 1;
        throw new Error('EPIPE: simulated consumer closed the pipe');
      },
    });
    assert.equal(onChunkCalls, 1, 'delivery stops at the FIRST sink failure (no per-chunk retry)');
    assert.equal(spawnResult.exitCode, 7, 'child exit code still propagates');
    assert.ok(spawnResult.passthroughError?.includes('EPIPE'), 'runner result reports the sink failure');
    const retained = scanCodexTurnCompletedUsage(spawnResult.stdout) as Record<string, unknown> | null;
    assert.ok(retained && retained.input_tokens === 5, 'usage scanner kept consuming after the sink broke');

    // (b) End-to-end through runHostRun (ledger ON, cap=1): a streaming fake
    // runner drives the core onChunk wrapper against a throwing passthrough dep.
    const sub = freshRoot();
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    let sinkCalls = 0;
    const passthrough: HostRunPassthrough = () => {
      sinkCalls += 1;
      throw new Error('EPIPE: simulated consumer closed the pipe');
    };
    const streamingRunner: HostRunRunner = (plan) => {
      plan.onChunk?.({ stream: 'stdout', text: 'live-one\n' });
      plan.onChunk?.({ stream: 'stdout', text: CODEX_STDOUT });
      return { stdout: CODEX_STDOUT, stderr: '', exitCode: 0, timedOut: false };
    };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: streamingRunner, passthrough });
    assert.equal(sinkCalls, 1, 'core wrapper never re-invokes the broken sink');
    assert.equal(result.spawned, true, 'the run completed instead of crashing');
    assert.equal(result.exitCode, 0, 'exit code propagates');
    assert.ok(result.passthroughError?.includes('EPIPE'), 'result surfaces passthroughError honestly');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row still records');
    // Slot released despite the broken sink: a fresh cap=1 admission succeeds.
    const dir = hostRunSlotsDir(sub);
    const after = acquireHostRunSlot(dir, 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('after-broken-sink'));
    assert.equal(after?.file, join(dir, 'slot-0.json'), 'concurrency slot was released (cap=1 re-admission succeeds)');
  });

  // =========================================================================
  // F-020: a REAL async stream EPIPE must be contained too. F-008 only proved a
  // SYNCHRONOUSLY-throwing sink degrades honestly; a closed downstream pipe
  // instead surfaces as an ASYNCHRONOUS 'error' event on process.stdout/stderr,
  // which the sink try/catch cannot see. Against the OLD handler (no stream
  // 'error' listener) this crashes the driver mid-run: the process dies with a
  // nonzero exit, NO ledger final row, the slot leaks, and no passthroughError is
  // ever surfaced. A REAL subprocess proves the fix: the driver drives the
  // compiled handler in --json mode (host output routes to stderr) with a fake
  // streaming runner emitting many chunks over ~250ms; the parent reads the first
  // line then DESTROYS the pipe, so the driver's later writes hit a real EPIPE.
  // =========================================================================
  await checkAsync('F-020: real subprocess — a live-output consumer that closes mid-stream (async EPIPE) is CONTAINED: driver exits 0, slot released, ledger final recorded, passthroughError surfaced', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const resultFile = join(sub, 'f020-result.json');
    const driverFile = join(sub, 'f020-driver.mjs');

    // The driver imports the COMPILED handler + core and runs host_run against a
    // fake streaming runner. Chunks carry no newline: the parent triggers on the
    // first stderr 'data' event (not a line), and the codex usage line parses
    // without a trailing newline — so no escaping is needed in this template.
    const driverScript = `
import { writeFileSync, readdirSync } from 'node:fs';
const ROOT = process.env.F020_ROOT;
const RESULT = process.env.F020_RESULT;
const { createHostRunHandlers } = await import(process.env.F020_HANDLER_URL);
const { hostRunSlotsDir, acquireHostRunSlot } = await import(process.env.F020_CORE_URL);
const store = { readStory() { throw new Error('no store'); } };
const ctx = { store, root: ROOT, scanRoot: ROOT };
const runner = (plan) => new Promise((resolve) => {
  const chunk = 'x'.repeat(8192);
  let n = 0;
  const tick = () => {
    if (plan.onChunk) plan.onChunk({ stream: 'stdout', text: chunk });
    n += 1;
    if (n >= 120) {
      resolve({ stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }), stderr: '', exitCode: 0, timedOut: false });
      return;
    }
    setTimeout(tick, 2);
  };
  setTimeout(tick, 2);
});
const handlers = createHostRunHandlers(ctx, { runner });
const out = await handlers.host_run({ host: 'codex', agentType: 'reviewer', prompt: 'driver prompt', phase: 'adhoc', json: true });
let leftover = [];
try { leftover = readdirSync(hostRunSlotsDir(ROOT)).filter((f) => f.startsWith('slot-') && f.endsWith('.json')); } catch { /* no slot dir */ }
const reAcquired = acquireHostRunSlot(hostRunSlotsDir(ROOT), 1, 6 * 60 * 60 * 1000, Date.now(), { pid: process.pid, startedAt: new Date().toISOString(), host: 'codex', storyId: null, agentType: 'after' }) !== null;
const obj = out && typeof out === 'object' ? out : {};
writeFileSync(RESULT, JSON.stringify({ passthroughError: obj.passthroughError ?? null, spawned: obj.spawned ?? null, exitCode: obj.exitCode ?? null, leftover, reAcquired }));
`;
    writeFileSync(driverFile, driverScript, 'utf8');

    const childEnv = {
      ...process.env,
      LATTICE_USAGE_LEDGER: '1',
      LATTICE_HOST_RUN_MAX_CONCURRENT: '1',
      F020_ROOT: sub,
      F020_RESULT: resultFile,
      F020_HANDLER_URL: new URL('../handlers/host-run.js', import.meta.url).href,
      F020_CORE_URL: new URL('../core/host-run.js', import.meta.url).href,
    } as NodeJS.ProcessEnv;

    // --json mode routes host output to process.stderr; close THAT pipe mid-stream.
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [driverFile], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
      let closed = false;
      child.stderr?.on('data', () => {
        if (!closed) {
          closed = true;
          // Read one line's worth, then destroy the read end so the driver's next
          // writes hit a real EPIPE.
          setTimeout(() => child.stderr?.destroy(), 5);
        }
      });
      child.on('close', (code) => resolve(code));
    });

    assert.equal(exitCode, 0, 'the driver exited 0 — the async EPIPE was CONTAINED (the OLD handler crashes nonzero here)');
    assert.ok(existsSync(resultFile), 'the driver wrote its result AFTER host_run returned (it never crashed mid-run)');
    const res = JSON.parse(readFileSync(resultFile, 'utf8')) as { passthroughError: unknown; spawned: unknown; exitCode: unknown; leftover: unknown; reAcquired: unknown };
    assert.equal(res.spawned, true, 'the run completed');
    assert.equal(res.exitCode, 0, 'the host exit code propagates on the result surface');
    assert.ok(typeof res.passthroughError === 'string' && res.passthroughError.length > 0, 'the JSON result surface carries a non-null passthroughError (the real EPIPE surfaced honestly)');
    assert.ok(/EPIPE|stream error/i.test(res.passthroughError as string), 'passthroughError names the async stream failure');
    assert.deepEqual(res.leftover, [], 'the concurrency slot was released (no leftover slot files after the run)');
    assert.equal(res.reAcquired, true, 'a fresh cap=1 slot admission succeeds after the run (the slot was truly released)');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row recorded despite the broken live pipe');
  });

  // =========================================================================
  // F-023: the residual window of F-020. F-020 attaches stderr 'error' listeners
  // for the run and removes them in the handler's finally. But the FINAL diagnostic
  // stderr write (the usage line) fired synchronously and returned BEFORE the write
  // settled, so a real EPIPE queued by THAT write lands asynchronously AFTER the
  // finally removed the listener — zero 'error' listeners -> process crash. The
  // crux, uncovered by F-020, is a QUIET TEXT-MODE run: host output goes to stdout,
  // stderr sees NO writes during the run, so stderrBroken never opens and the usage
  // line is the FIRST stderr write. When stderr is already closed, the OLD handler
  // crashes here (nonzero exit) even though the run completed and the ledger row
  // was written. The fix makes emitStderr settle-aware and AWAITS it before the
  // finally, so the EPIPE 'error' fires while our listener is still attached.
  // Real subprocess: the driver runs host_run in TEXT mode against a stdout-only
  // runner; the parent destroys the driver's stderr pipe at spawn, before the
  // quiet run's first (usage-line) stderr write.
  // =========================================================================
  await checkAsync('F-023: real subprocess — TEXT-mode quiet run whose stderr is closed before the FIRST (usage-line) stderr write is CONTAINED: driver exits 0, slot released, ledger final recorded (no post-finally async EPIPE crash)', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const resultFile = join(sub, 'f023-result.json');
    const driverFile = join(sub, 'f023-driver.mjs');

    // TEXT mode: host output routes to process.stdout (parent ignores it); the
    // runner emits ONLY stdout — never stderr — so the handler's final usage line
    // is the FIRST stderr write of the whole run (stderrBroken never opened).
    const driverScript = `
import { writeFileSync, readdirSync } from 'node:fs';
const ROOT = process.env.F023_ROOT;
const RESULT = process.env.F023_RESULT;
const { createHostRunHandlers } = await import(process.env.F023_HANDLER_URL);
const { hostRunSlotsDir, acquireHostRunSlot } = await import(process.env.F023_CORE_URL);
const store = { readStory() { throw new Error('no store'); } };
const ctx = { store, root: ROOT, scanRoot: ROOT };
const runner = (plan) => new Promise((resolve) => {
  const chunk = 'y'.repeat(4096);
  let n = 0;
  const tick = () => {
    if (plan.onChunk) plan.onChunk({ stream: 'stdout', text: chunk });
    n += 1;
    if (n >= 40) {
      resolve({ stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3 } }), stderr: '', exitCode: 0, timedOut: false });
      return;
    }
    setTimeout(tick, 2);
  };
  setTimeout(tick, 2);
});
const handlers = createHostRunHandlers(ctx, { runner });
// TEXT mode (json omitted): success returns '' after the usage line hits stderr.
const out = await handlers.host_run({ host: 'codex', agentType: 'reviewer', prompt: 'driver prompt', phase: 'adhoc' });
let leftover = [];
try { leftover = readdirSync(hostRunSlotsDir(ROOT)).filter((f) => f.startsWith('slot-') && f.endsWith('.json')); } catch { /* no slot dir */ }
const reAcquired = acquireHostRunSlot(hostRunSlotsDir(ROOT), 1, 6 * 60 * 60 * 1000, Date.now(), { pid: process.pid, startedAt: new Date().toISOString(), host: 'codex', storyId: null, agentType: 'after' }) !== null;
writeFileSync(RESULT, JSON.stringify({ completed: out === '', leftover, reAcquired }));
`;
    writeFileSync(driverFile, driverScript, 'utf8');

    const childEnv = {
      ...process.env,
      LATTICE_USAGE_LEDGER: '1',
      LATTICE_HOST_RUN_MAX_CONCURRENT: '1',
      F023_ROOT: sub,
      F023_RESULT: resultFile,
      F023_HANDLER_URL: new URL('../handlers/host-run.js', import.meta.url).href,
      F023_CORE_URL: new URL('../core/host-run.js', import.meta.url).href,
    } as NodeJS.ProcessEnv;

    // Destroy the stderr read end AT SPAWN — before the run's first stderr write.
    // A quiet stdout-only run issues NO stderr data before the final usage line, so
    // there is no stderr 'data' event to trigger on; destroying proactively makes
    // that final usage line the write that hits the already-closed pipe (EPIPE).
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [driverFile], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
      child.once('spawn', () => child.stderr?.destroy());
      child.on('close', (code) => resolve(code));
    });

    assert.equal(exitCode, 0, 'the driver exited 0 — the post-finally async EPIPE was CONTAINED (the OLD handler crashes nonzero here)');
    assert.ok(existsSync(resultFile), 'the driver wrote its result AFTER host_run returned (it never crashed mid/after run)');
    const res = JSON.parse(readFileSync(resultFile, 'utf8')) as { completed: unknown; leftover: unknown; reAcquired: unknown };
    assert.equal(res.completed, true, 'host_run returned normally in text mode (empty string) — no crash');
    assert.deepEqual(res.leftover, [], 'the concurrency slot was released (no leftover slot files after the run)');
    assert.equal(res.reAcquired, true, 'a fresh cap=1 slot admission succeeds after the run (the slot was truly released)');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row recorded intact despite the closed-before-first-write stderr');
  });

  // =========================================================================
  // F-024: the LAST member of the F-020/F-023 EPIPE-window class, now on the LIVE
  // stdout passthrough itself. F-020 attaches stdout/stderr 'error' listeners for
  // the run and F-023 awaits the final DIAGNOSTIC writes, but the live TEXT-mode
  // host stdout CHUNK writes (process.stdout.write(chunk.text)) were fire-and-forget:
  // a late EPIPE from the FINAL chunk(s) can land asynchronously AFTER the finally
  // removes the listeners (zero 'error' listeners -> process crash) — and text mode
  // (host stdout -> process.stdout) is the DEFAULT path, previously exercised only
  // on stderr. The fix gives every passthrough + diagnostic write outstanding-write
  // accounting (write + counted callback, NOT serialized) and drains the pending
  // counter (bounded by a 2s defensive cap) BEFORE listener removal, so the final
  // chunk's EPIPE fires while our named listeners are still attached.
  // Real subprocess (mirrors the F-023 harness but kills STDOUT, not stderr): the
  // driver runs host_run in TEXT mode against a stdout-only runner bursting chunks
  // right up to process exit; the parent pipes the driver's STDOUT and DESTROYS its
  // read end mid/late-stream, so the driver's live chunk writes hit a real EPIPE.
  // =========================================================================
  await checkAsync('F-024: real subprocess — TEXT-mode live stdout passthrough whose consumer destroys the driver STDOUT mid/late-stream is CONTAINED: driver exits 0, slot released, ledger final recorded (no post-finally async EPIPE crash on the final chunk)', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const resultFile = join(sub, 'f024-result.json');
    const driverFile = join(sub, 'f024-driver.mjs');

    // TEXT mode (json omitted): host stdout chunks route to process.stdout — the
    // very pipe the parent destroys. The runner emits a SYNCHRONOUS burst of large
    // stdout chunks and then returns (a burst right up to process exit): every live
    // write is issued in ONE tick so asyncStreamError stays null across the whole
    // burst, and the chunks that overflow the pipe buffer stay queued in the
    // driver's writable — when the parent destroys the read end they all fail with a
    // real EPIPE. Against the pre-F-024 handler (fire-and-forget stdout writes, no
    // drain) host_run returns and the driver WRITES ITS RESULT, then the buffered
    // writes' EPIPE lands AFTER the finally removed the stdout 'error' listener —
    // zero listeners -> the driver crashes (nonzero) post-completion. The fix's
    // outstanding-write accounting + bounded drain settles those writes' callbacks
    // BEFORE listener removal, so the EPIPE is contained. Chunks carry no newline;
    // the codex usage line parses without a trailing newline.
    const driverScript = `
import { writeFileSync, readdirSync } from 'node:fs';
const ROOT = process.env.F024_ROOT;
const RESULT = process.env.F024_RESULT;
const { createHostRunHandlers } = await import(process.env.F024_HANDLER_URL);
const { hostRunSlotsDir, acquireHostRunSlot } = await import(process.env.F024_CORE_URL);
const store = { readStory() { throw new Error('no store'); } };
const ctx = { store, root: ROOT, scanRoot: ROOT };
const runner = (plan) => {
  // Synchronous burst: 40 x 64 KiB stdout chunks then return. The pipe buffer holds
  // ~64 KiB; the remaining ~2.5 MiB stays queued in the driver's writable and fails
  // with EPIPE the instant the parent destroys the read end.
  const chunk = 'z'.repeat(65536);
  for (let i = 0; i < 40; i++) { if (plan.onChunk) plan.onChunk({ stream: 'stdout', text: chunk }); }
  return { stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 4 } }), stderr: '', exitCode: 0, timedOut: false };
};
const handlers = createHostRunHandlers(ctx, { runner });
// TEXT mode (json omitted): success returns '' after the usage line hits stderr.
const out = await handlers.host_run({ host: 'codex', agentType: 'reviewer', prompt: 'driver prompt', phase: 'adhoc' });
let leftover = [];
try { leftover = readdirSync(hostRunSlotsDir(ROOT)).filter((f) => f.startsWith('slot-') && f.endsWith('.json')); } catch { /* no slot dir */ }
const reAcquired = acquireHostRunSlot(hostRunSlotsDir(ROOT), 1, 6 * 60 * 60 * 1000, Date.now(), { pid: process.pid, startedAt: new Date().toISOString(), host: 'codex', storyId: null, agentType: 'after' }) !== null;
writeFileSync(RESULT, JSON.stringify({ completed: out === '', leftover, reAcquired }));
`;
    writeFileSync(driverFile, driverScript, 'utf8');

    const childEnv = {
      ...process.env,
      LATTICE_USAGE_LEDGER: '1',
      LATTICE_HOST_RUN_MAX_CONCURRENT: '1',
      F024_ROOT: sub,
      F024_RESULT: resultFile,
      F024_HANDLER_URL: new URL('../handlers/host-run.js', import.meta.url).href,
      F024_CORE_URL: new URL('../core/host-run.js', import.meta.url).href,
    } as NodeJS.ProcessEnv;

    // TEXT mode routes host stdout to process.stdout; PIPE that (fd 1) and DESTROY
    // the read end the instant the first data arrives (mid-stream) so the driver's
    // still-queued live chunk writes hit a real EPIPE. stderr stays ignored (the
    // usage line writes fine there) — the window under test is purely the live
    // stdout passthrough.
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [driverFile], { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] });
      let closed = false;
      child.stdout?.on('data', () => {
        if (!closed) {
          closed = true;
          child.stdout?.destroy();
        }
      });
      child.on('close', (code) => resolve(code));
    });

    assert.equal(exitCode, 0, 'the driver exited 0 — the async EPIPE on the still-queued LIVE stdout passthrough writes was CONTAINED (the pre-F-024 handler crashes nonzero here, post-completion, on the unhandled stdout error event)');
    assert.ok(existsSync(resultFile), 'the driver wrote its result AFTER host_run returned (it never crashed mid/after run)');
    const res = JSON.parse(readFileSync(resultFile, 'utf8')) as { completed: unknown; leftover: unknown; reAcquired: unknown };
    assert.equal(res.completed, true, 'host_run returned normally in text mode (empty string) — no crash');
    assert.deepEqual(res.leftover, [], 'the concurrency slot was released (no leftover slot files after the run)');
    assert.equal(res.reAcquired, true, 'a fresh cap=1 slot admission succeeds after the run (the slot was truly released)');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row recorded intact despite the destroyed live stdout pipe');
  });

  // =========================================================================
  // F-011: the host subprocess executes in the RESOLVED PROJECT ROOT (args.cwd,
  // the same value the ledger attributes as root), never the caller's process
  // cwd. Against the old code the spawn plan carried NO cwd at all, so the host
  // inherited whatever directory the CLI happened to be invoked from while the
  // ledger still pointed at --root.
  // =========================================================================
  await checkAsync('F-011: plan.cwd is the injected resolved root while process.cwd() is intentionally elsewhere; empty cwd refused pre-spawn', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), 'host-run-caller-cwd-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(elsewhere);
      // The smoke process now sits in a directory that is NOT the injected root
      // — exactly the reported bug setup (`lattice --root <worktree> host_run`
      // invoked from somewhere else).
      assert.notEqual(realpathSync(sub), process.cwd(), 'precondition: caller cwd differs from the injected root');
      const sink: RunnerSink = { calls: 0, lastPlan: null };
      const result = await runHostRun(baseArgs({ root: sub }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
      assert.equal(result.spawned, true);
      assert.equal(sink.calls, 1);
      assert.ok(sink.lastPlan);
      assert.equal(sink.lastPlan!.cwd, sub, 'plan.cwd === the injected root (the ledger-attribution root), NOT the caller cwd');
      assert.notEqual(realpathSync(sink.lastPlan!.cwd), process.cwd(), 'the caller cwd never leaks into the spawn plan');

      // Fail-closed: a missing/empty cwd is refused BEFORE any spawn (and before
      // any ledger row) rather than silently falling back to the caller cwd.
      const sub2 = freshRoot();
      const sink2: RunnerSink = { calls: 0, lastPlan: null };
      await assert.rejects(
        () => runHostRun({ ...baseArgs({ root: sub2 }), cwd: '' }, { runner: makeRunner({ stdout: CODEX_STDOUT }, sink2) }),
        /cwd is required/i,
      );
      assert.equal(sink2.calls, 0, 'no spawn without a resolved cwd');
      assert.equal(existsSync(resolveLedgerPath(sub2)), false, 'no rows written for a missing-cwd refusal');
    } finally {
      process.chdir(originalCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  await checkAsync('F-011: the DEFAULT runner spawns the real child IN plan.cwd — child process.cwd() equals the injected root, not the smoke cwd', async () => {
    const target = mkdtempSync(join(tmpdir(), 'host-run-cwd-target-'));
    try {
      const chunks: string[] = [];
      const result = await defaultHostRunRunner({
        command: process.execPath,
        argv: ['-e', 'console.log(process.cwd());'],
        env: process.env,
        cwd: target,
        host: 'codex',
        retainUsageLine: usageLineRetainerFor('codex'),
        onChunk: (c: HostRunChunk) => { if (c.stream === 'stdout') chunks.push(c.text); },
      });
      assert.equal(result.exitCode, 0);
      const printed = chunks.join('').trim();
      assert.ok(printed.length > 0, 'child printed its cwd');
      assert.equal(realpathSync(printed), realpathSync(target), 'the child executed in the injected root (spawn received plan.cwd)');
      assert.notEqual(realpathSync(printed), process.cwd(), 'and NOT in the smoke process cwd (the old no-cwd inheritance)');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // CHK-007a: hard-budget cap
  // =========================================================================
  await checkAsync('CHK-007a budget: over-budget preflight refuses before spawn, writes blocked row (hard_budget_exceeded)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked when over budget');
    assert.equal(result.blocked, true);
    assert.equal(result.spawned, false);
    assert.equal(result.refusalReason, 'hard_budget_exceeded');
    assert.notEqual(result.exitCode, 0);
    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'a blocked ledger row is written');
    assert.equal(blocked!.decision.reasonCode, 'hard_budget_exceeded');
    assert.ok(records.some((r) => r.usage.source === 'prompt-size-estimate'), 'preflight estimate present');
    // F-027 positive path: with a healthy ledger the summary still claims the row.
    assert.equal(result.usageSummary.recorded, 'blocked', 'healthy ledger keeps the blocked claim');
    assert.ok((result.usageSummary.reason ?? '').startsWith('hard_budget_exceeded ('), 'reason stays the plain refusal (no append-failure suffix)');
    assert.equal((result.usageSummary.reason ?? '').includes('ledger_append_failed'), false);
  });

  await checkAsync('CHK-007a budget (F-004): blocked rows are provider-honest — codex=openai, claude=anthropic (legacy shape byte-compat)', async () => {
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;

    // codex budget refusal -> provider.name openai (was mis-attributed anthropic).
    const sub1 = freshRoot();
    const r1 = await runHostRun(baseArgs({ root: sub1, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }) });
    assert.equal(r1.blocked, true);
    const b1 = readLedger(sub1).find((r) => r.decision.kind === 'blocked');
    assert.ok(b1, 'codex blocked row written');
    assert.equal(b1!.provider?.name, 'openai', 'codex budget block attributed to openai (F-004)');
    assert.equal(b1!.decision.reasonCode, 'hard_budget_exceeded');

    // claude budget refusal -> provider.name anthropic, and the legacy blocked-row
    // shape is unchanged (source/estimator/model default byte-compat).
    const sub2 = freshRoot();
    const r2 = await runHostRun(baseArgs({ root: sub2, host: 'claude', env }), { runner: makeRunner({ stdout: CLAUDE_STDOUT }) });
    assert.equal(r2.blocked, true);
    const b2 = readLedger(sub2).find((r) => r.decision.kind === 'blocked');
    assert.ok(b2, 'claude blocked row written');
    assert.equal(b2!.provider?.name, 'anthropic', 'claude blocked row stays anthropic');
    assert.equal(b2!.provider?.model, 'unknown', 'model default unchanged');
    assert.equal(b2!.usage.source, 'prompt-size-estimate', 'blocked usage stays the preflight estimate');
    assert.equal(b2!.usage.estimator?.name, 'bytes-chars-heuristic', 'estimator provenance unchanged');
    assert.equal(b2!.decision.kind, 'blocked');
    assert.equal(b2!.decision.reasonCode, 'hard_budget_exceeded');
  });

  // =========================================================================
  // CHK-007b: concurrency cap
  // =========================================================================
  await checkAsync('CHK-007b concurrency: 5th run under cap 4 refuses, writes blocked row (concurrency_cap_exceeded)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    for (let i = 0; i < 4; i++) seedSlot(dir, i, process.pid); // slot-0..slot-3 held live
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked when at the concurrency cap');
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.equal(result.liveRuns?.length, 4, 'live-run list surfaced');
    assert.notEqual(result.exitCode, 0);
    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked);
    assert.equal(blocked!.decision.reasonCode, 'concurrency_cap_exceeded');
    // F-027 positive path: with a healthy ledger the summary claims the row and
    // the surfaced recordId is the APPENDED blocked row's id (never minted).
    assert.equal(result.usageSummary.recorded, 'blocked', 'healthy ledger keeps the blocked claim');
    assert.equal(result.usageSummary.recordId, blocked!.recordId, 'summary recordId matches the appended blocked row');
    assert.ok((result.usageSummary.reason ?? '').startsWith('concurrency_cap_exceeded ('), 'reason stays the plain refusal');
    assert.equal((result.usageSummary.reason ?? '').includes('ledger_append_failed'), false);
    // F-004: a codex refusal is attributed to openai, never anthropic.
    assert.equal(blocked!.provider?.name, 'openai', 'codex concurrency block attributed to openai');
    // Slot metadata never leaks into a ledger row (slots carry pid/timestamps only).
    const ledgerText = readFileSync(resolveLedgerPath(sub), 'utf8');
    assert.equal(ledgerText.includes('2000-01-01T00:00:00.000Z'), false, 'slot startedAt marker must not appear in the ledger');
  });

  await checkAsync('CHK-007b concurrency: dead-pid slot is reclaimed so the run proceeds', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const dead = seedSlot(dir, 0, DEAD_PID);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(existsSync(dead), false, 'dead-pid slot reclaimed (reused + released)');
    assert.equal(sink.calls, 1, 'run proceeds after reclaim');
    assert.equal(result.blocked, false);
  });

  await checkAsync('F-025 live-holder protection: a LIVE-pid slot is NEVER age-reclaimed — the cap=1 waiter refuses fail-closed and the slot file survives (the OLD mtime rule reclaimed it here)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const held = seedSlot(dir, 0, process.pid); // a LIVE holder...
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000); // ...whose slot looks ancient (7h > the 6h window)
    utimesSync(held, old, old);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked — the live slot was not stolen by age');
    assert.equal(result.blocked, true, 'the waiter refuses at cap instead of reclaiming a live run');
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.equal(result.liveRuns?.length, 1, 'the live holder still appears in the refusal live list');
    assert.equal(existsSync(held), true, 'the live holder keeps its slot file');
  });

  await checkAsync('F-025 meta-less orphan backstop: a slot whose meta never landed (corrupt/empty file) is waited out while FRESH (cap=1 refusal) and reclaimed only PAST the mtime backstop', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, 'slot-0.json');
    writeFileSync(orphan, '', 'utf8'); // the crash-between-wx-create-and-meta-write window: no parseable meta
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;

    // FRESH meta-less slot: possibly a holder mid-way through its meta write —
    // never stolen; the run refuses fail-closed.
    const sinkFresh: RunnerSink = { calls: 0, lastPlan: null };
    const fresh = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sinkFresh) });
    assert.equal(sinkFresh.calls, 0, 'a young meta-less slot is waited out, not stolen');
    assert.equal(fresh.blocked, true);
    assert.equal(existsSync(orphan), true, 'the young orphan survives');

    // PAST the backstop: pid liveness is unknowable, so mtime age is the only
    // signal left — the orphan is reclaimed and the run proceeds.
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);
    const sinkOld: RunnerSink = { calls: 0, lastPlan: null };
    const reclaimed = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sinkOld) });
    assert.equal(sinkOld.calls, 1, 'the aged orphan is reclaimed and the run proceeds');
    assert.equal(reclaimed.blocked, false);
    assert.equal(existsSync(orphan), false, 'the aged orphan slot was reclaimed (and released after the run)');
  });

  check('F-025 release-token guard: a reclaimed+reacquired slot survives the ORIGINAL holder\'s late release (token mismatch), the cap stays enforced, and a matching-token release still works', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const staleMs = 6 * 60 * 60 * 1000;

    // Matching token: acquire records pid + token on disk; release unlinks.
    const happy = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('happy-holder'));
    assert.ok(happy, 'admission returns the slot handle');
    assert.equal(happy!.file, join(dir, 'slot-0.json'));
    const onDiskHappy = JSON.parse(readFileSync(happy!.file, 'utf8')) as { pid?: number; token?: string };
    assert.equal(onDiskHappy.pid, process.pid, 'the slot file records the holder pid');
    assert.equal(onDiskHappy.token, happy!.token, 'the slot file records the acquire-minted token');
    releaseSlot(happy!.file, happy!.token);
    assert.equal(existsSync(happy!.file), false, 'matching token: release unlinks the slot');

    // The F-025 bug scenario: original holder A is judged reclaimable by a racing
    // contender (simulated unlink — e.g. a pid-death false positive) and a NEW
    // holder B re-acquires the SAME fixed slot-0 path. A's LATE release must not
    // delete B's live admission. Against the OLD blind-unlink releaseSlot, B's
    // slot vanished here and the cap admitted a third run.
    const a = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('original-holder'));
    assert.ok(a, 'original holder admitted');
    rmSync(a!.file, { force: true }); // the reclaimer's unlink
    const b = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('new-holder'));
    assert.ok(b, 'new holder re-acquires the reclaimed slot');
    assert.equal(b!.file, a!.file, 'same fixed slot path, different owner');
    assert.notEqual(b!.token, a!.token, 'each acquire mints a fresh token');
    releaseSlot(a!.file, a!.token); // the ORIGINAL holder's late release
    assert.equal(existsSync(b!.file), true, 'the new holder\'s slot survives the stale release');
    const onDisk = JSON.parse(readFileSync(b!.file, 'utf8')) as { token?: string; agentType?: string };
    assert.equal(onDisk.token, b!.token, 'the on-disk token is still the NEW holder\'s');
    assert.equal(onDisk.agentType, 'new-holder', 'the on-disk meta is still the NEW holder\'s');
    assert.equal(
      acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('third-run')),
      null,
      'cap=1 stays enforced under the surviving slot (the OLD code admitted this run)',
    );
    releaseSlot(b!.file, b!.token);
    assert.equal(existsSync(b!.file), false, 'the new holder\'s own release still works');
  });

  await checkAsync('CHK-007b adversarial (F-003): cap=1 real contention — second admission fails while the first holds (index wx IS the cap decision)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const staleMs = 6 * 60 * 60 * 1000;

    // Two concurrent admissions: the first wx-wins slot-0; the second (NO release
    // in between) must be refused. Against the old check-then-acquire design both
    // would have been admitted (unique names always wx-succeed after a racy scan).
    const first = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('winner'));
    assert.equal(first?.file, join(dir, 'slot-0.json'), 'first admission wins slot-0');
    const second = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('loser'));
    assert.equal(second, null, 'second admission refused while the first still holds (atomic, no TOCTOU)');

    // Full-run refusal under the held slot: an agy run with cap=1 must refuse
    // fail-closed with the blocked row attributed to antigravity (F-004).
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'agy', env }), { runner: makeRunner({ stdout: AGY_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked under contention refusal');
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.equal(result.liveRuns?.length, 1, 'live-run list surfaced');
    assert.notEqual(result.exitCode, 0);
    const blocked = readLedger(sub).find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'blocked ledger row written');
    assert.equal(blocked!.decision.reasonCode, 'concurrency_cap_exceeded');
    assert.equal(blocked!.provider?.name, 'antigravity', 'agy concurrency block attributed to antigravity (F-004)');
  });

  check('CHK-007b adversarial (F-003): stale-reclaim race — exactly one of two reclaimers wins the wx re-create', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const staleMs = 6 * 60 * 60 * 1000;
    const file = seedSlot(dir, 0, DEAD_PID); // dead pid => stale occupant of slot-0
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(file, old, old);

    // Reclaimer A: observes staleness, unlink + wx re-create — wins slot-0.
    const a = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('reclaimer-a'));
    assert.equal(a?.file, file, 'reclaimer A wins the stale slot');
    // Reclaimer B races the SAME slot: its fresh pre-unlink staleness probe now
    // sees A's live fresh slot (NOT stale => it must not unlink A), and cap=1
    // leaves no other index => B loses.
    const b = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('reclaimer-b'));
    assert.equal(b, null, 'reclaimer B loses (never unlinks the winner)');
    // The slot on disk is A's, untouched by B; and a direct wx re-create (the
    // losing half of the reclaim race) fails EEXIST-atomically.
    const held = JSON.parse(readFileSync(file, 'utf8')) as { agentType?: string };
    assert.equal(held.agentType, 'reclaimer-a', 'winner slot content intact');
    assert.equal(writeSlotFileExclusive(file, { ...slotMeta('reclaimer-b'), token: 'reclaimer-b-token' }), false, 'losing wx re-create fails atomically');
  });

  check('CHK-007b edge: LATTICE_HOST_RUN_MAX_CONCURRENT unset/invalid falls back to 4; valid honored', () => {
    assert.equal(resolveMaxConcurrent({} as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ LATTICE_HOST_RUN_MAX_CONCURRENT: '0' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ LATTICE_HOST_RUN_MAX_CONCURRENT: '-3' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ LATTICE_HOST_RUN_MAX_CONCURRENT: 'abc' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ LATTICE_HOST_RUN_MAX_CONCURRENT: '3.5' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ LATTICE_HOST_RUN_MAX_CONCURRENT: '8' } as NodeJS.ProcessEnv), 8);
  });

  // =========================================================================
  // CHK-003: autopilot claude repair coverage
  // =========================================================================
  check('CHK-003 autopilot repair ON: --output-format json argv + estimate/final rows (agentType autopilot-repair) + envelope-parsed excerpt', () => {
    const sub = freshRoot();
    const sink: RepairSink = { calls: 0, lastArgs: null };
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Applied the smallest safe fix.',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1200, output_tokens: 88, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 },
    });
    const attempt = runClaudeRepair(
      sub, NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: envelope, stderr: '' }, sink),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'), ON,
    );

    assert.equal(sink.calls, 1, 'repair runner invoked once');
    assert.ok(sink.lastArgs);
    const ofIdx = sink.lastArgs!.indexOf('--output-format');
    assert.ok(ofIdx >= 0 && sink.lastArgs![ofIdx + 1] === 'json', '--output-format json added when ledger ON');
    // The excerpt is the parsed envelope .result text, NOT the raw JSON blob.
    assert.equal(attempt.stdoutExcerpt, 'Applied the smallest safe fix.');
    assert.equal(attempt.status, 'passed');
    assert.ok(attempt.command.includes('--output-format json'), 'recorded command label reflects the added flag');

    const records = readLedger(sub);
    assert.equal(records.length, 2, 'estimate + final');
    const estimate = records.find((r) => r.usage.source === 'prompt-size-estimate');
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(estimate && final);
    assert.equal(estimate!.sequence, 1);
    assert.equal(final!.sequence, 2);
    assert.deepEqual(final!.supersedesRecordIds, [estimate!.recordId]);
    for (const r of records) {
      assert.equal(r.agentType, 'autopilot-repair');
      assert.equal(r.storyId, 'B-70e9');
      assert.equal(r.phase, 'REVIEW', 'phase = plan.targetPhase');
      assert.equal(r.command, 'autopilot-repair:claude');
    }
    assert.equal(final!.provider?.name, 'anthropic');
    assert.equal(final!.provider?.model, 'claude-opus-4-8', 'served model bound from envelope');
    assert.equal(final!.usage.inputTokens, 1200);
    assert.equal(final!.usage.outputTokens, 88);
    assert.equal(final!.usage.cacheReadInputTokens, 300);
  });

  check('CHK-003 autopilot repair OFF: byte-identical argv (no --output-format json), zero rows, zero dirs — even with budget/cap env set (F-016: no admission when OFF)', () => {
    // F-016 hard invariant: with the ledger OFF, the budget/cap env vars that
    // would refuse an ON repair pre-spawn are NEVER consulted — the repair
    // spawns byte-identically and creates no dirs (so no slot registry either).
    const OFF = {
      LATTICE_USAGE_LEDGER: '0',
      LATTICE_HARD_BUDGET_TOKENS: '1',
      LATTICE_HOST_RUN_MAX_CONCURRENT: '1',
    } as NodeJS.ProcessEnv;
    // Capture an ON run's prompt arg to prove the OFF argv only DROPPED the ledger
    // flag (same prompt text), i.e. the ON path merely ADDED flags.
    const sinkOn: RepairSink = { calls: 0, lastArgs: null };
    runClaudeRepair(
      freshRoot(), NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: '{}', stderr: '' }, sinkOn),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'), ON,
    );

    const sub = freshRoot();
    const sinkOff: RepairSink = { calls: 0, lastArgs: null };
    const plainStdout = 'Plain repair output text.';
    const offAttempt = runClaudeRepair(
      sub, NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: plainStdout, stderr: '' }, sinkOff),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'), OFF,
    );

    assert.deepEqual(sinkOff.lastArgs, ['-p', sinkOn.lastArgs![1]], 'OFF argv is exactly [-p, <same prompt>]');
    assert.equal(sinkOff.lastArgs!.includes('--output-format'), false, 'no --output-format json when OFF');
    assert.equal(offAttempt.command, 'claude -p <repair-prompt>', 'OFF command label byte-identical to today');
    assert.equal(offAttempt.stdoutExcerpt, plainStdout, 'OFF excerpt is the raw stdout (unchanged)');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'no ledger file when OFF');
    assert.equal(existsSync(join(sub, '.lattice')), false, 'no .lattice dir when OFF');
    assert.equal(existsSync(hostRunSlotsDir(sub)), false, 'no slot registry when OFF (admission never ran)');
  });

  // =========================================================================
  // F-016: the autopilot repair passes the SAME pre-spawn admission as host_run.
  // Against the old code both checks below fail loudly: the repair recorded the
  // preflight and then invoked the runner directly (sink.calls === 1, no blocked
  // row, no slot ever held), so LATTICE_HARD_BUDGET_TOKENS and a saturated
  // LATTICE_HOST_RUN_MAX_CONCURRENT could not stop an autopilot repair.
  // =========================================================================
  check('F-016 repair budget admission: ledger ON + LATTICE_HARD_BUDGET_TOKENS=1 refuses PRE-SPAWN (runner never invoked) + blocked row (hard_budget_exceeded, anthropic, autopilot-repair)', () => {
    const sub = freshRoot();
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const sink: RepairSink = { calls: 0, lastArgs: null };
    const attempt = runClaudeRepair(
      sub, NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: '{}', stderr: '' }, sink),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'), env,
    );

    assert.equal(sink.calls, 0, 'runner NOT invoked when the hard budget refuses the launch');
    assert.equal(attempt.status, 'failed', 'a refused repair is an honestly FAILED attempt (never passed/skipped)');
    assert.equal(attempt.exitCode, HOST_RUN_REFUSAL_EXIT_CODE, 'refusal sentinel matches a host_run cap refusal');
    assert.ok(attempt.stderrExcerpt.includes('hard_budget_exceeded'), 'stderrExcerpt names the refusal reason');
    assert.ok(attempt.command.includes('--output-format json'), 'command reports the exact launch that was refused');
    assert.equal(attempt.stdoutExcerpt, '', 'no fabricated output for a launch that never happened');

    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'a blocked ledger row is written');
    assert.equal(blocked!.decision.reasonCode, 'hard_budget_exceeded');
    assert.equal(blocked!.provider?.name, 'anthropic', 'a repair is a claude launch -> anthropic');
    assert.equal(blocked!.agentType, 'autopilot-repair');
    assert.ok(records.some((r) => r.usage.source === 'prompt-size-estimate'), 'preflight estimate still present');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'no final row for a run that never spawned');
    // Same ordering as runHostRun: budget refuses BEFORE any slot machinery.
    assert.equal(existsSync(hostRunSlotsDir(sub)), false, 'budget refusal happens before any slot acquire (no slot dir)');
  });

  check('F-016 repair concurrency admission: saturated cap refuses pre-spawn (concurrency_cap_exceeded row, no spawn); OFF ignores the cap; slot HELD during a normal run and RELEASED after', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    seedSlot(dir, 0, process.pid); // a live occupant saturates cap=1

    const sink: RepairSink = { calls: 0, lastArgs: null };
    const attempt = runClaudeRepair(
      sub, NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: '{}', stderr: '' }, sink),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'), env,
    );
    assert.equal(sink.calls, 0, 'runner NOT invoked at the concurrency cap');
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.exitCode, HOST_RUN_REFUSAL_EXIT_CODE);
    assert.ok(attempt.stderrExcerpt.includes('concurrency_cap_exceeded'), 'stderrExcerpt names the refusal reason');
    const afterRefusal = readLedger(sub);
    const blocked = afterRefusal.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'a blocked ledger row is written');
    assert.equal(blocked!.decision.reasonCode, 'concurrency_cap_exceeded');
    assert.equal(blocked!.provider?.name, 'anthropic');
    assert.equal(blocked!.agentType, 'autopilot-repair');

    // Ledger OFF against the SAME saturated registry: no admission, the repair
    // spawns with the byte-identical OFF argv, and zero rows are added.
    const sinkOff: RepairSink = { calls: 0, lastArgs: null };
    const off = runClaudeRepair(
      sub, NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: 'plain', stderr: '' }, sinkOff),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'),
      { LATTICE_USAGE_LEDGER: '0', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv,
    );
    assert.equal(sinkOff.calls, 1, 'OFF: the repair spawns despite the saturated cap (no admission when OFF)');
    assert.equal(off.status, 'passed');
    assert.equal(sinkOff.lastArgs!.includes('--output-format'), false, 'OFF argv byte-identical');
    assert.equal(readLedger(sub).length, afterRefusal.length, 'OFF adds zero rows');

    // Free the seeded slot: a normal ON repair must ACQUIRE slot-0 for the
    // duration of the run (observed from inside the fake runner) and RELEASE it
    // after, so a fresh cap=1 admission succeeds.
    rmSync(join(dir, 'slot-0.json'), { force: true });
    let slotHeldDuringRun = false;
    const envelope = JSON.stringify({
      type: 'result',
      result: 'fixed',
      model: CLAUDE_MODEL,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const observingRunner: AutopilotCommandRunner = () => {
      slotHeldDuringRun = existsSync(join(dir, 'slot-0.json'));
      return { exitCode: 0, stdout: envelope, stderr: '' };
    };
    const ok = runClaudeRepair(
      sub, NO_REPAIR_ARGS, observingRunner,
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'), env,
    );
    assert.equal(ok.status, 'passed', 'the repair runs normally once a slot is free');
    assert.equal(slotHeldDuringRun, true, 'the repair HELD slot-0 while the runner executed');
    const after = acquireHostRunSlot(dir, 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('after-repair'));
    assert.equal(after?.file, join(dir, 'slot-0.json'), 'slot released after the repair (cap=1 re-admission succeeds)');
  });

  // =========================================================================
  // CHK-003: host readiness probe coverage (extracted pure wiring helper)
  // =========================================================================
  check('CHK-003 probe wiring: per-host preflight+unavailable rows (agentType host-readiness-probe), provider mapping, documented reason', () => {
    const sub = freshRoot();
    // All three hosts SPAWNED the readiness prompt (F-015 keep-recording kinds:
    // none = success, timeout / auth = spawned-but-failed) so all three record.
    const hosts = [
      { host: 'codex', failureKind: 'none' as const, outputBytes: 12 },
      { host: 'claude', failureKind: 'timeout' as const, outputBytes: 0 },
      { host: 'agy', failureKind: 'auth' as const, outputBytes: 40, exitCode: 1 },
    ];
    const rows = recordHostReadinessProbeUsage({
      root: sub, storyId: 'B-70e9', phase: 'REVIEW', hosts,
      env: ON, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });
    assert.equal(rows.length, 3);

    const records = readLedger(sub);
    assert.equal(records.length, 6, '3 hosts × (estimate + final)');
    const estimates = records.filter((r) => r.usage.source === 'prompt-size-estimate');
    const finals = records.filter((r) => r.usage.source === 'unavailable');
    assert.equal(estimates.length, 3);
    assert.equal(finals.length, 3);
    for (const r of records) {
      assert.equal(r.agentType, HOST_READINESS_PROBE_AGENT_TYPE);
      assert.equal(r.storyId, 'B-70e9');
      assert.equal(r.phase, 'REVIEW');
    }
    for (const f of finals) {
      assert.equal(f.sequence, 2);
      assert.equal(f.usage.unavailableReason, HOST_READINESS_PROBE_UNAVAILABLE_REASON);
      assert.equal(f.usage.inputTokens, null, 'no fabricated count');
    }
    const providerByCommand = new Map(finals.map((f) => [f.command, f.provider?.name]));
    assert.equal(providerByCommand.get('host-readiness-probe:codex'), 'openai');
    assert.equal(providerByCommand.get('host-readiness-probe:claude'), 'anthropic');
    assert.equal(providerByCommand.get('host-readiness-probe:agy'), 'antigravity');

    // Re-running with the same spawned hosts records the SAME 3 rows (these all
    // spawned; F-015 filtering is exercised by the dedicated check below).
    const sub2 = freshRoot();
    const rows2 = recordHostReadinessProbeUsage({
      root: sub2, storyId: 'B-70e9', phase: 'probe', hosts,
      env: ON, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });
    assert.equal(rows2.length, 3);
    assert.equal(readLedger(sub2).length, 6);

    // Ledger OFF -> strict no-op (no rows, no dir).
    const sub3 = freshRoot();
    const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    const rows3 = recordHostReadinessProbeUsage({
      root: sub3, storyId: 'B-70e9', phase: 'probe', hosts,
      env: OFF, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });
    assert.equal(rows3.length, 0, 'OFF -> no rows returned');
    assert.equal(existsSync(join(sub3, '.lattice')), false, 'OFF -> no .lattice dir');
  });

  // =========================================================================
  // F-015: no phantom rows for hosts that never spawned the readiness prompt.
  // The probe returns rows for hosts that never launched a subprocess
  // (missing_executable / version_failed) or were rejected at launcher-argv
  // classification BEFORE spawnSync (pre-spawn wrong_launcher). Those must NOT
  // become usage rows; only a host that actually attempted the readiness
  // subprocess (here: a timed-out real spawn) may.
  // =========================================================================
  check('F-015 probe filter: rows recorded ONLY for hosts whose readiness prompt actually spawned (missing_executable / version_failed / pre-spawn wrong_launcher skipped)', () => {
    // Build the four honest probe row shapes via the REAL classifier so the
    // discriminator is exercised against production failureKinds, not hand-forged
    // labels.
    const missing = classifyHostExecutionReadiness({ host: 'codex', versionOk: false, durationMs: 0 });
    assert.equal(missing.failureKind, 'missing_executable', 'no executablePath -> missing_executable (no --version, no readiness spawn)');
    assert.equal(missing.outputBytes, undefined, 'missing_executable carries no spawn-result evidence');

    const versionFailed = classifyHostExecutionReadiness({ host: 'claude', executablePath: '/usr/bin/claude', versionOk: false, durationMs: 0 });
    assert.equal(versionFailed.failureKind, 'version_failed', '--version failed -> version_failed (readiness prompt never spawned)');
    assert.equal(versionFailed.outputBytes, undefined, 'version_failed carries no spawn-result evidence');

    // Pre-spawn wrong_launcher: executablePath+versionOk but a bad launcher argv is
    // classified BEFORE spawnSync, so no result / no outputBytes.
    const wrongLauncher = classifyHostExecutionReadiness({ host: 'agy', executablePath: '/usr/bin/agy', versionOk: true, durationMs: 0, observedLauncherArgv: ['agy'] });
    assert.equal(wrongLauncher.failureKind, 'wrong_launcher', 'bad launcher argv -> wrong_launcher (launcher classification, no spawn)');
    assert.equal(wrongLauncher.outputBytes, undefined, 'pre-spawn wrong_launcher carries no spawn-result evidence');
    assert.equal(wrongLauncher.exitCode, undefined, 'pre-spawn wrong_launcher has no exit code');

    // Real attempted host: executablePath+versionOk with a classified spawn result
    // (a timeout) -> DID launch, so it must record.
    const attempted = classifyHostExecutionReadiness({
      host: 'codex',
      executablePath: '/usr/bin/codex',
      versionOk: true,
      durationMs: 5,
      result: { error: Object.assign(new Error('etimedout'), {}), signal: 'SIGTERM', stderr: '', stdout: '', status: null },
      timedOut: true,
      outputBytes: 0,
    });
    assert.equal(attempted.failureKind, 'timeout', 'a timed-out spawn is a real launch (keep recording)');
    assert.notEqual(attempted.outputBytes, undefined, 'a spawned host carries outputBytes (present even at 0)');

    const sub = freshRoot();
    const rows = recordHostReadinessProbeUsage({
      root: sub, storyId: 'B-70e9', phase: 'REVIEW',
      hosts: [
        { host: 'codex-missing', failureKind: missing.failureKind, ...(missing.exitCode !== undefined ? { exitCode: missing.exitCode } : {}), ...(missing.outputBytes !== undefined ? { outputBytes: missing.outputBytes } : {}) },
        { host: 'claude-versionfailed', failureKind: versionFailed.failureKind, ...(versionFailed.exitCode !== undefined ? { exitCode: versionFailed.exitCode } : {}), ...(versionFailed.outputBytes !== undefined ? { outputBytes: versionFailed.outputBytes } : {}) },
        { host: 'agy-wronglauncher', failureKind: wrongLauncher.failureKind, ...(wrongLauncher.exitCode !== undefined ? { exitCode: wrongLauncher.exitCode } : {}), ...(wrongLauncher.outputBytes !== undefined ? { outputBytes: wrongLauncher.outputBytes } : {}) },
        { host: 'codex-attempted', failureKind: attempted.failureKind, ...(attempted.exitCode !== undefined ? { exitCode: attempted.exitCode } : {}), ...(attempted.outputBytes !== undefined ? { outputBytes: attempted.outputBytes } : {}) },
      ],
      env: ON, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });

    // Only the attempted host is returned + written.
    assert.equal(rows.length, 1, 'exactly one host recorded (the attempted spawn)');
    assert.equal(rows[0].host, 'codex-attempted', 'the recorded host is the one that actually spawned');
    const records = readLedger(sub);
    assert.equal(records.length, 2, 'one recorded host -> estimate + unavailable final only');
    for (const r of records) {
      assert.equal(r.command, 'host-readiness-probe:codex-attempted', 'no ledger row for a non-spawning host');
    }

    // OFF is still a strict no-op even with a spawning host present.
    const subOff = freshRoot();
    const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    const offRows = recordHostReadinessProbeUsage({
      root: subOff, storyId: 'B-70e9', phase: 'REVIEW',
      hosts: [{ host: 'codex-attempted', failureKind: 'timeout', outputBytes: 0 }],
      env: OFF, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });
    assert.equal(offRows.length, 0, 'OFF -> no rows even for a spawned host');
    assert.equal(existsSync(join(subOff, '.lattice')), false, 'OFF -> no .lattice dir');
  });

  // =========================================================================
  // CHK-003: cross-host-review codex leaf coverage (fake CodexReviewRunner)
  // =========================================================================
  await checkAsync('CHK-003 cross-host-review codex leaf ON: preflight + unavailable final (agentType cross-host-review:codex) with documented reason, argv unchanged', async () => {
    const sub = freshRoot();
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'no blocking defects' });
    const runner: CodexReviewRunner = () => ({ stdout: `${verdict}\n`, exitCode: 0, timedOut: false });
    const leaf = await runCodexReviewLeaf(
      {
        storyId: 'B-70e9', storyWorktree: sub, materialHash: MH, timeoutMs: 1000,
        usageLedger: { root: sub, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: ON, phase: 'REVIEW' },
      },
      runner,
    );
    assert.equal(leaf.hostBVerdict.decision, 'pass', 'the leaf still returns its real verdict');

    const records = readLedger(sub);
    assert.equal(records.length, 2, 'estimate + unavailable final');
    const estimate = records.find((r) => r.usage.source === 'prompt-size-estimate');
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(estimate && final);
    assert.equal(estimate!.sequence, 1);
    assert.equal(final!.sequence, 2);
    assert.deepEqual(final!.supersedesRecordIds, [estimate!.recordId]);
    for (const r of records) {
      assert.equal(r.agentType, CROSS_HOST_REVIEW_CODEX_AGENT_TYPE);
      assert.equal(r.storyId, 'B-70e9');
      assert.equal(r.phase, 'REVIEW');
      assert.equal(r.command, 'cross-host-review:codex');
    }
    assert.equal(final!.provider?.name, 'openai');
    assert.equal(final!.provider?.model, 'unknown');
    assert.equal(final!.usage.unavailableReason, CROSS_HOST_REVIEW_CODEX_NO_USAGE_REASON);
    assert.equal(final!.usage.inputTokens, null, 'no fabricated count from plain stdout');
  });

  await checkAsync('CHK-003/F-017 cross-host-review codex leaf: absent binding AND ledger OFF both byte-identical — runner invoked, zero rows, NO admission even with budget/cap env set', async () => {
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'ok' });

    // Absent binding: ledger gating never runs, so no admission fires and no
    // rows/dirs are created — the runner still executes.
    const sub1 = freshRoot();
    let calls1 = 0;
    const runner1: CodexReviewRunner = () => { calls1 += 1; return { stdout: `${verdict}\n`, exitCode: 0, timedOut: false }; };
    const leaf1 = await runCodexReviewLeaf({ storyId: 'B-70e9', storyWorktree: sub1, materialHash: MH, timeoutMs: 1000 }, runner1);
    assert.equal(calls1, 1, 'no binding -> the codex runner still runs (no admission)');
    assert.equal(leaf1.hostBVerdict.decision, 'pass');
    assert.equal(existsSync(resolveLedgerPath(sub1)), false, 'no rows without a usageLedger binding');
    assert.equal(existsSync(hostRunSlotsDir(sub1)), false, 'no slot registry without a binding');

    // Ledger OFF hard invariant (F-017): the budget/cap env vars that would
    // refuse an ON leaf pre-spawn are NEVER consulted — the leaf runs, creates
    // no dirs (so no slot registry), and adds zero rows.
    const sub2 = freshRoot();
    const OFF = { LATTICE_USAGE_LEDGER: '0', LATTICE_HARD_BUDGET_TOKENS: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    let calls2 = 0;
    const runner2: CodexReviewRunner = () => { calls2 += 1; return { stdout: `${verdict}\n`, exitCode: 0, timedOut: false }; };
    const leaf2 = await runCodexReviewLeaf(
      { storyId: 'B-70e9', storyWorktree: sub2, materialHash: MH, timeoutMs: 1000, usageLedger: { root: sub2, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: OFF, phase: 'REVIEW' } },
      runner2,
    );
    assert.equal(calls2, 1, 'OFF: the leaf runs despite budget/cap env (no admission when OFF)');
    assert.equal(leaf2.hostBVerdict.decision, 'pass');
    assert.equal(existsSync(resolveLedgerPath(sub2)), false, 'no rows when ledger OFF');
    assert.equal(existsSync(hostRunSlotsDir(sub2)), false, 'no slot registry when OFF (admission never ran)');
  });

  // =========================================================================
  // F-017: the cross-host-review codex leaf passes the SAME pre-spawn admission
  // as host_run / the autopilot repair. Against the old leaf all three checks
  // fail loudly: the leaf recorded the preflight and then invoked the runner
  // directly (calls === 1, no blocked row, no slot ever held), so
  // LATTICE_HARD_BUDGET_TOKENS and a saturated LATTICE_HOST_RUN_MAX_CONCURRENT
  // could not stop the codex review spawn.
  // =========================================================================
  await checkAsync('F-017 codex leaf budget admission: ledger ON + LATTICE_HARD_BUDGET_TOKENS=1 refuses PRE-SPAWN (runner never invoked) + blocked row (hard_budget_exceeded, openai) + synthesized blocked verdict', async () => {
    const sub = freshRoot();
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'ok' });
    let calls = 0;
    const runner: CodexReviewRunner = () => { calls += 1; return { stdout: `${verdict}\n`, exitCode: 0, timedOut: false }; };
    const leaf = await runCodexReviewLeaf(
      { storyId: 'B-70e9', storyWorktree: sub, materialHash: MH, timeoutMs: 1000, usageLedger: { root: sub, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env, phase: 'REVIEW' } },
      runner,
    );
    assert.equal(calls, 0, 'the codex runner is NOT invoked when the hard budget refuses the launch');
    assert.equal(leaf.hostBVerdict.decision, 'blocked', 'a refused leaf synthesizes a BLOCKED verdict (never a fabricated pass/fail)');
    assert.equal(leaf.hostBVerdict.reason, CODEX_REVIEW_BUDGET_BLOCKED, 'the synthesized verdict names the budget refusal');
    assert.equal(leaf.hostBVerdict.materialHash, MH, 'the synthesized verdict binds the reviewed materialHash (jointDecision sees NO material mismatch)');
    assert.equal(leaf.exitCode, HOST_RUN_REFUSAL_EXIT_CODE, 'refusal sentinel matches a host_run cap refusal');
    assert.equal(leaf.timedOut, false, 'a refusal is not a timeout');

    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'a blocked ledger row is written');
    assert.equal(blocked!.decision.reasonCode, 'hard_budget_exceeded');
    assert.equal(blocked!.provider?.name, 'openai', 'a codex leaf is a codex launch -> openai');
    assert.equal(blocked!.agentType, CROSS_HOST_REVIEW_CODEX_AGENT_TYPE);
    assert.ok(records.some((r) => r.usage.source === 'prompt-size-estimate'), 'preflight estimate still present');
    assert.equal(records.some((r) => r.usage.source === 'unavailable'), false, 'no unavailable final for a leaf that never spawned');
    // Same ordering as runHostRun: budget refuses BEFORE any slot machinery.
    assert.equal(existsSync(hostRunSlotsDir(sub)), false, 'budget refusal happens before any slot acquire (no slot dir)');
  });

  await checkAsync('F-017 codex leaf concurrency admission: saturated cap refuses pre-spawn (concurrency_cap_exceeded row provider openai, no spawn) + synthesized blocked verdict', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    seedSlot(dir, 0, process.pid); // a live occupant saturates cap=1
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'ok' });
    let calls = 0;
    const runner: CodexReviewRunner = () => { calls += 1; return { stdout: `${verdict}\n`, exitCode: 0, timedOut: false }; };
    const leaf = await runCodexReviewLeaf(
      { storyId: 'B-70e9', storyWorktree: sub, materialHash: MH, timeoutMs: 1000, usageLedger: { root: sub, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env, phase: 'REVIEW' } },
      runner,
    );
    assert.equal(calls, 0, 'the codex runner is NOT invoked at the concurrency cap');
    assert.equal(leaf.hostBVerdict.decision, 'blocked');
    assert.equal(leaf.hostBVerdict.reason, CODEX_REVIEW_CONCURRENCY_CAP_EXCEEDED);
    assert.equal(leaf.exitCode, HOST_RUN_REFUSAL_EXIT_CODE);

    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'a blocked ledger row is written');
    assert.equal(blocked!.decision.reasonCode, 'concurrency_cap_exceeded');
    assert.equal(blocked!.provider?.name, 'openai');
    assert.equal(blocked!.agentType, CROSS_HOST_REVIEW_CODEX_AGENT_TYPE);
    assert.equal(records.some((r) => r.usage.source === 'unavailable'), false, 'no final row for a leaf that never spawned');
  });

  await checkAsync('F-017 codex leaf normal run: the admission slot is HELD during the run and RELEASED after (cap=1 re-admission succeeds)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'ok' });
    let slotHeldDuringRun = false;
    const runner: CodexReviewRunner = () => {
      slotHeldDuringRun = existsSync(join(dir, 'slot-0.json'));
      return { stdout: `${verdict}\n`, exitCode: 0, timedOut: false };
    };
    const leaf = await runCodexReviewLeaf(
      { storyId: 'B-70e9', storyWorktree: sub, materialHash: MH, timeoutMs: 1000, usageLedger: { root: sub, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env, phase: 'REVIEW' } },
      runner,
    );
    assert.equal(leaf.hostBVerdict.decision, 'pass', 'a normal admitted leaf still returns its real verdict');
    assert.equal(slotHeldDuringRun, true, 'the leaf HELD slot-0 while the runner executed');
    const after = acquireHostRunSlot(dir, 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('after-codex-leaf'));
    assert.equal(after?.file, join(dir, 'slot-0.json'), 'slot released after the leaf (cap=1 re-admission succeeds)');
  });

  // =========================================================================
  // CHK-003 adversarial: a corrupt ledger never breaks repair / probe / review
  // =========================================================================
  await checkAsync('CHK-003 adversarial: a corrupt ledger never breaks repair / probe / codex-review (seam never throws)', async () => {
    // ---- autopilot repair
    const sub1 = freshRoot();
    seedCorruptLedger(sub1);
    const sink: RepairSink = { calls: 0, lastArgs: null };
    const attempt = runClaudeRepair(
      sub1, NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: '{"type":"result","result":"fixed"}', stderr: '' }, sink),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'), ON,
    );
    assert.equal(sink.calls, 1, 'repair still ran despite a corrupt ledger');
    assert.equal(attempt.status, 'passed');

    // ---- probe wiring helper
    const sub2 = freshRoot();
    seedCorruptLedger(sub2);
    const rows = recordHostReadinessProbeUsage({
      root: sub2, storyId: 'B-70e9', phase: 'probe',
      hosts: [
        { host: 'codex', failureKind: 'none', outputBytes: 12 },
        { host: 'claude', failureKind: 'timeout', outputBytes: 0 },
        { host: 'agy', failureKind: 'auth', outputBytes: 40, exitCode: 1 },
      ],
      env: ON, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });
    assert.equal(rows.length, 3, 'probe wiring returned without throwing');

    // ---- codex review leaf
    const sub3 = freshRoot();
    seedCorruptLedger(sub3);
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'ok' });
    const runner: CodexReviewRunner = () => ({ stdout: `${verdict}\n`, exitCode: 0, timedOut: false });
    const leaf = await runCodexReviewLeaf(
      { storyId: 'B-70e9', storyWorktree: sub3, materialHash: MH, timeoutMs: 1000, usageLedger: { root: sub3, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: ON, phase: 'REVIEW' } },
      runner,
    );
    assert.equal(leaf.hostBVerdict.decision, 'pass', 'codex review still returned its verdict despite a corrupt ledger');
  });

  // =========================================================================
  // F-012: cross-process append serialization at the writer choke point.
  // Against the OLD writer the parallel check below breaks near-deterministically:
  // all rows land (appendFileSync) but verifyLedgerChain throws, because
  // concurrent processes read the same predecessor before appending.
  // =========================================================================
  await checkAsync('F-012 parallel writes: 6 REAL concurrent processes x 5 appends each -> zero skips, no lost writes, hash chain intact', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const CHILDREN = 6;
    const APPENDS = 5;
    // Each child dynamically imports the COMPILED writer + ids modules and
    // appends APPENDS minimal valid records against the SAME root — the exact
    // shape of concurrent host_run processes (ledger default-ON, cap 4).
    const childScript = [
      '(async () => {',
      '  const writer = await import(process.env.F012_WRITER_URL);',
      '  const ids = await import(process.env.F012_IDS_URL);',
      '  const template = JSON.parse(process.env.F012_TEMPLATE);',
      '  for (let i = 0; i < Number(process.env.F012_APPENDS); i++) {',
      '    const record = { ...template, recordId: ids.mintRecordId(), ledgerCallId: ids.mintLedgerCallId(), attemptId: ids.mintAttemptId() };',
      '    const res = writer.appendUsageRecord(process.env.F012_ROOT, record, { env: { LATTICE_USAGE_LEDGER: "1" } });',
      '    if (!res.written) throw new Error("append reported not-written");',
      '  }',
      '})().catch((err) => { console.error(String((err && err.message) || err)); process.exit(1); });',
    ].join('\n');
    const childEnv = {
      ...process.env,
      F012_WRITER_URL: new URL('../core/usage-ledger/writer.js', import.meta.url).href,
      F012_IDS_URL: new URL('../core/usage-ledger/ids.js', import.meta.url).href,
      F012_TEMPLATE: JSON.stringify(minimalValidUsageRecord()),
      F012_ROOT: sub,
      F012_APPENDS: String(APPENDS),
    };
    const codes = await Promise.all(
      Array.from({ length: CHILDREN }, () => new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ['-e', childScript], { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('close', (code) => resolve(code));
      })),
    );
    // Zero skips at N=6: a bounded-wait skip throws in the child (non-zero
    // exit). Skips are acceptable only under pathological contention, which
    // 6 processes x 5 quick appends is not.
    assert.deepEqual(codes, Array.from({ length: CHILDREN }, () => 0), 'every child appended all its rows (zero skips)');
    const records = verifyLedgerChain(resolveLedgerPath(sub)); // throws if any previousRecordHash breaks the chain
    assert.equal(records.length, CHILDREN * APPENDS, 'no lost writes: row count == sum of the children appends');
    assert.equal(existsSync(resolveLedgerLockPath(sub)), false, 'the append lock is released after the run');
  });

  check('F-012/F-018 ownerless orphan reclaim: a lock dir with NO owner.json and an old mtime (crash-before-owner-write window) is reclaimed by the backstop — a single append succeeds and releases it', () => {
    const sub = freshRoot();
    const lockDir = resolveLedgerLockPath(sub);
    // No owner.json: pid liveness is unknowable, so the mtime backstop applies.
    mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000); // older than the 30s orphan backstop default
    utimesSync(lockDir, old, old);
    const res = appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON });
    assert.equal(res.written, true, 'the append reclaimed the ownerless orphan lock and succeeded');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'exactly one valid row');
    assert.equal(existsSync(lockDir), false, 'the reclaimed lock is released after the append');
  });

  check('F-012 bounded-wait skip-not-corrupt: a HELD fresh lock + tiny wait -> the append throws (skips), chain stays valid, foreign lock not stolen', () => {
    const sub = freshRoot();
    // Seed one real row so a corrupting append would have a predecessor to race.
    assert.equal(appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON }).written, true);
    const lockDir = resolveLedgerLockPath(sub);
    // An ownerless lock with a FRESH mtime (younger than the orphan backstop):
    // possibly a holder mid-way between mkdir and its owner.json write — waited
    // out, never reclaimed within the bounded budget.
    mkdirSync(lockDir, { recursive: true });
    const env = {
      LATTICE_USAGE_LEDGER: '1',
      LATTICE_USAGE_LEDGER_LOCK_WAIT_MS: '50',
      LATTICE_USAGE_LEDGER_LOCK_STALE_MS: '60000',
    } as NodeJS.ProcessEnv;
    assert.throws(
      () => appendUsageRecord(sub, minimalValidUsageRecord(), { env }),
      /skip-not-corrupt/,
      'the writer surfaces the skip through its existing throw path (seam callers catch -> honest under-count)',
    );
    assert.equal(existsSync(lockDir), true, 'a fresh (non-orphaned) foreign lock is never stolen on a bounded-wait failure');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'no row appended on the skip — the chain is intact');
    rmSync(lockDir, { recursive: true, force: true });
  });

  check('F-018 live-holder protection: a LIVE pid with valid owner.json is never reclaimed regardless of lock age — bounded wait then skip-not-corrupt, lock + token intact', () => {
    const sub = freshRoot();
    // Seed one real row so a stolen lock would have a predecessor to corrupt.
    assert.equal(appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON }).written, true);
    const lockDir = resolveLedgerLockPath(sub);
    const ownerPath = join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME);
    // A live holder: THIS process's pid, but the lock dir looks ancient. The
    // pre-F-018 writer reclaimed on mtime age alone and stole exactly this
    // lock (the holder was merely slow/suspended inside the critical section).
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, token: 'live-holder-token', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const env = {
      LATTICE_USAGE_LEDGER: '1',
      LATTICE_USAGE_LEDGER_LOCK_WAIT_MS: '50',
      LATTICE_USAGE_LEDGER_LOCK_STALE_MS: '1', // even an absurdly tiny backstop must not matter
    } as NodeJS.ProcessEnv;
    assert.throws(
      () => appendUsageRecord(sub, minimalValidUsageRecord(), { env }),
      /skip-not-corrupt/,
      'the waiter waits out its bounded budget and skips — it never steals a live lock',
    );
    assert.equal(existsSync(lockDir), true, 'the live holder keeps its lock');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string };
    assert.equal(owner.token, 'live-holder-token', 'owner.json untouched (same token)');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'no row appended on the skip — the chain is intact');
    rmSync(lockDir, { recursive: true, force: true });
  });

  await checkAsync('F-018 dead-holder reclaim: owner.json with a REAL dead pid is reclaimed immediately (age-independent) — the append succeeds', async () => {
    const sub = freshRoot();
    // A genuinely dead pid: spawn a child that exits at once and wait for it.
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', () => resolve(child.pid as number));
    });
    const lockDir = resolveLedgerLockPath(sub);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME),
      JSON.stringify({ pid: deadPid, token: 'dead-holder-token', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    // FRESH mtime + a huge orphan backstop: pid death ALONE authorizes reclaim.
    const env = {
      LATTICE_USAGE_LEDGER: '1',
      LATTICE_USAGE_LEDGER_LOCK_STALE_MS: '3600000',
    } as NodeJS.ProcessEnv;
    const res = appendUsageRecord(sub, minimalValidUsageRecord(), { env });
    assert.equal(res.written, true, 'the append reclaimed the dead holder lock and succeeded');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'exactly one valid row');
    assert.equal(existsSync(lockDir), false, 'the reclaimed lock is released after the append');
  });

  check('F-018 release-token guard: release removes the lock only while owner.json still carries OUR token — a reclaimed+reacquired foreign lock survives a stale release', () => {
    const sub = freshRoot();
    const lockDir = resolveLedgerLockPath(sub);
    mkdirSync(dirname(lockDir), { recursive: true });
    const ownerPath = join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME);

    // Happy path: acquire mints a token and records pid+token; a matching
    // release removes the lock.
    const ownToken = acquireLedgerLock(lockDir, ON);
    assert.ok(ownToken, 'acquire returns a token');
    const recorded = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number; token?: string };
    assert.equal(recorded.pid, process.pid, 'owner.json records the holder pid');
    assert.equal(recorded.token, ownToken, 'owner.json records the minted token');
    releaseLedgerLock(lockDir, ownToken as string);
    assert.equal(existsSync(lockDir), false, 'matching token: release removes the lock');

    // Guard: simulate "we were judged dead and reclaimed; a NEW holder
    // re-acquired" by swapping owner.json to a foreign token. Our late release
    // must NOT remove the foreign holder's lock.
    const staleToken = acquireLedgerLock(lockDir, ON);
    assert.ok(staleToken, 're-acquired for the guard scenario');
    writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, token: 'foreign-reclaimer-token', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    releaseLedgerLock(lockDir, staleToken as string);
    assert.equal(existsSync(lockDir), true, 'foreign lock dir survives our stale release');
    const foreign = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string };
    assert.equal(foreign.token, 'foreign-reclaimer-token', 'foreign owner.json survives with its token');
    rmSync(lockDir, { recursive: true, force: true });
  });

  check('F-018/F-019 owner-write-failure rollback: when owner.json cannot be written after a successful mkdir, acquire returns null AND gives the dir back — no ownerless lock left behind', () => {
    const sub = freshRoot();
    const lockDir = resolveLedgerLockPath(sub);
    const ownerPath = join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME);
    // The usage dir (the lock dir's PARENT) is created BEFORE the umask change
    // so it stays writable: rmdir of the lock dir needs write on the parent
    // only, so the rollback itself is never blocked by this setup.
    mkdirSync(dirname(lockDir), { recursive: true });
    // Deterministic owner-write failure WITHOUT touching the writer (its ESM
    // named fs imports are snapshot bindings, so monkey-patching fs from here
    // would not intercept): a 0o277 umask makes acquire's own mkdirSync create
    // the lock dir as 0o500 (dr-x------), so the immediately following
    // writeFileSync(owner.json) fails EACCES (non-root) — exactly the
    // mkdir-succeeded-but-owner-write-failed branch. WAIT_MS=0 bounds the
    // retry loop to a single pass through that branch.
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_USAGE_LEDGER_LOCK_WAIT_MS: '0' } as NodeJS.ProcessEnv;
    const prevUmask = process.umask(0o277);
    let res: string | null;
    try {
      res = acquireLedgerLock(lockDir, env);
    } finally {
      process.umask(prevUmask);
    }
    assert.equal(res, null, 'the failed acquire returns null — no lock is held by the caller');
    assert.equal(
      existsSync(lockDir),
      false,
      'rollback: the just-created lock dir was given back (rmdirSync ran) — an ownerless lock that only the mtime backstop could age out is never left behind',
    );
    assert.equal(existsSync(ownerPath), false, 'the failure path never wrote a partial owner.json');
    // The same lock path is immediately acquirable once writes succeed again.
    const token = acquireLedgerLock(lockDir, ON);
    assert.ok(token, 'a subsequent unimpaired acquire succeeds');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number; token?: string };
    assert.equal(owner.pid, process.pid, 'owner.json records the holder pid after the clean acquire');
    assert.equal(owner.token, token, 'owner.json records the minted token after the clean acquire');
    releaseLedgerLock(lockDir, token as string);
    assert.equal(existsSync(lockDir), false, 'the clean acquire releases normally');
  });

  // =========================================================================
  // Isolation
  // =========================================================================
  check('isolation: all artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()));
    assert.ok(statSync(root).isDirectory());
    // Every sub-root created a slot dir only where the concurrency path ran.
    const entries = readdirSync(root);
    assert.ok(entries.length > 0);
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
      console.error(`\n✗ host-run usage smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ host-run usage smoke passed (${passed} checks)`);
  });
