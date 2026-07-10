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
 *     F-011: the spawn plan binds cwd to the resolved project root (args.cwd,
 *     the same value the ledger attributes) — proven with a fake runner while
 *     the smoke process is chdir'd elsewhere, with a fail-closed empty-cwd
 *     refusal, and with a real child that prints its process.cwd().
 *     F-012: cross-process append serialization — 6 REAL concurrent child
 *     processes append via the compiled writer with zero skips, no lost
 *     writes, and an intact hash chain; a stale (abandoned) lock dir is
 *     reclaimed; a held lock + bounded wait skips (throws) instead of
 *     appending off a stale predecessor (skip-not-corrupt).
 *     F-013: a dropped over-cap line forces an UNAVAILABLE final
 *     (usage_line_retention_truncated) for codex AND claude even when an
 *     EARLIER usage line was retained — never a stale provider-reported final.
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
  runHostRun,
  scanCodexTurnCompletedUsage,
  usageLineRetainerFor,
  hostRunSlotsDir,
  resolveMaxConcurrent,
  writeSlotFileExclusive,
  HOST_RUN_REFUSAL_EXIT_CODE,
  HOST_RUN_RETAINED_LINE_CAP,
  HOST_RUN_RETENTION_TRUNCATED_REASON,
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
  CROSS_HOST_REVIEW_CODEX_AGENT_TYPE,
  CROSS_HOST_REVIEW_CODEX_NO_USAGE_REASON,
  type CodexReviewRunner,
} from '../core/codex-review-leaf.js';
import { adaptCodexTurnUsage } from '../core/usage-ledger/adapters/openai.js';
import { payloadDigest } from '../core/usage-ledger/adapters/shared.js';
import { mintAttemptId, mintLedgerCallId, mintRecordId } from '../core/usage-ledger/ids.js';
import {
  appendUsageRecord,
  resolveLedgerLockPath,
  resolveLedgerPath,
  verifyLedgerChain,
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
    assert.equal(after, join(dir, 'slot-0.json'), 'concurrency slot was released (cap=1 re-admission succeeds)');
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

  await checkAsync('CHK-007b concurrency: stale-mtime slot (live pid) is reclaimed by the staleness backstop', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const stale = seedSlot(dir, 0, process.pid);
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7h > 6h window
    utimesSync(stale, old, old);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(existsSync(stale), false, 'stale slot reclaimed by mtime backstop');
    assert.equal(sink.calls, 1);
    assert.equal(result.blocked, false);
  });

  await checkAsync('CHK-007b adversarial (F-003): cap=1 real contention — second admission fails while the first holds (index wx IS the cap decision)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const staleMs = 6 * 60 * 60 * 1000;

    // Two concurrent admissions: the first wx-wins slot-0; the second (NO release
    // in between) must be refused. Against the old check-then-acquire design both
    // would have been admitted (unique names always wx-succeed after a racy scan).
    const first = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('winner'));
    assert.equal(first, join(dir, 'slot-0.json'), 'first admission wins slot-0');
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
    assert.equal(a, file, 'reclaimer A wins the stale slot');
    // Reclaimer B races the SAME slot: its fresh pre-unlink staleness probe now
    // sees A's live fresh slot (NOT stale => it must not unlink A), and cap=1
    // leaves no other index => B loses.
    const b = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('reclaimer-b'));
    assert.equal(b, null, 'reclaimer B loses (never unlinks the winner)');
    // The slot on disk is A's, untouched by B; and a direct wx re-create (the
    // losing half of the reclaim race) fails EEXIST-atomically.
    const held = JSON.parse(readFileSync(file, 'utf8')) as { agentType?: string };
    assert.equal(held.agentType, 'reclaimer-a', 'winner slot content intact');
    assert.equal(writeSlotFileExclusive(file, slotMeta('reclaimer-b')), false, 'losing wx re-create fails atomically');
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
    assert.equal(after, join(dir, 'slot-0.json'), 'slot released after the repair (cap=1 re-admission succeeds)');
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

  await checkAsync('CHK-003 cross-host-review codex leaf: absent binding AND ledger OFF both record zero rows (byte-identical to non-opt-in callers)', async () => {
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'ok' });
    const runner: CodexReviewRunner = () => ({ stdout: `${verdict}\n`, exitCode: 0, timedOut: false });

    const sub1 = freshRoot();
    await runCodexReviewLeaf({ storyId: 'B-70e9', storyWorktree: sub1, materialHash: MH, timeoutMs: 1000 }, runner);
    assert.equal(existsSync(resolveLedgerPath(sub1)), false, 'no rows without a usageLedger binding');

    const sub2 = freshRoot();
    const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    await runCodexReviewLeaf(
      { storyId: 'B-70e9', storyWorktree: sub2, materialHash: MH, timeoutMs: 1000, usageLedger: { root: sub2, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: OFF, phase: 'REVIEW' } },
      runner,
    );
    assert.equal(existsSync(resolveLedgerPath(sub2)), false, 'no rows when ledger OFF');
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

  check('F-012 stale lock reclaim: an abandoned lock dir (old mtime) is reclaimed — a single append succeeds and releases it', () => {
    const sub = freshRoot();
    const lockDir = resolveLedgerLockPath(sub);
    mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000); // older than the 30s stale default
    utimesSync(lockDir, old, old);
    const res = appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON });
    assert.equal(res.written, true, 'the append reclaimed the abandoned lock and succeeded');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'exactly one valid row');
    assert.equal(existsSync(lockDir), false, 'the reclaimed lock is released after the append');
  });

  check('F-012 bounded-wait skip-not-corrupt: a HELD fresh lock + tiny wait -> the append throws (skips), chain stays valid, foreign lock not stolen', () => {
    const sub = freshRoot();
    // Seed one real row so a corrupting append would have a predecessor to race.
    assert.equal(appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON }).written, true);
    const lockDir = resolveLedgerLockPath(sub);
    mkdirSync(lockDir, { recursive: true }); // a live holder (fresh mtime, NOT stale)
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
    assert.equal(existsSync(lockDir), true, 'a live (non-stale) foreign lock is never stolen on a bounded-wait failure');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'no row appended on the skip — the chain is intact');
    rmSync(lockDir, { recursive: true, force: true });
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
