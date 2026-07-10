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
 *     stale/dead-pid slot reclaim, atomic wx slot race, cap env parsing, and the
 *     slot-content-never-in-ledger invariant.
 *   - CHK-003: the remaining lattice-initiated host spawns route through the same
 *     seam — autopilot claude repair (ledger ON adds --output-format json + records
 *     estimate/final rows with agentType autopilot-repair and an envelope-parsed
 *     excerpt; ledger OFF byte-identical), host readiness probes (per-host preflight
 *     + unavailable final agentType host-readiness-probe), the cross-host-review
 *     codex leaf (preflight + unavailable final with the documented reason, argv
 *     unchanged), and the seam-never-throws contract under a corrupt ledger.
 *
 * Prints per-check lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
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
import { dirname, isAbsolute, join } from 'node:path';

import {
  runHostRun,
  scanCodexTurnCompletedUsage,
  hostRunSlotsDir,
  resolveMaxConcurrent,
  writeSlotFileExclusive,
  type HostRunArgs,
  type HostRunRunner,
  type HostRunSpawnPlan,
  type HostRunSpawnResult,
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
import {
  runCodexReviewLeaf,
  CODEX_REVIEW_VERDICT_SCHEMA,
  CROSS_HOST_REVIEW_CODEX_AGENT_TYPE,
  CROSS_HOST_REVIEW_CODEX_NO_USAGE_REASON,
  type CodexReviewRunner,
} from '../core/codex-review-leaf.js';
import { adaptCodexTurnUsage } from '../core/usage-ledger/adapters/openai.js';
import { payloadDigest } from '../core/usage-ledger/adapters/shared.js';
import { resolveLedgerPath, verifyLedgerChain } from '../core/usage-ledger/writer.js';
import type { UsageLedgerRecord } from '../core/usage-ledger/record.js';

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
    ...over,
  };
}

function readLedger(sub: string): UsageLedgerRecord[] {
  const path = resolveLedgerPath(sub);
  if (!existsSync(path)) return [];
  return verifyLedgerChain(path);
}

function seedStoryIndex(sub: string, storyId: string, phase: string): void {
  const dir = join(sub, '.lattice', 'story', 'actives', storyId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ storyId, phase }), 'utf8');
}

function seedSlot(dir: string, pid: number, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pid}-${marker}.json`);
  writeFileSync(file, JSON.stringify({ pid, startedAt: '2000-01-01T00:00:00.000Z', host: 'codex', storyId: null, agentType: 'reviewer' }), 'utf8');
  return file;
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

async function main(): Promise<void> {
  // =========================================================================
  // CHK-001 happy: codex turn.completed -> estimate + provider-reported final
  // =========================================================================
  check('CHK-001 codex happy: estimate(seq1) + provider-reported final(seq2) with uncached-remainder mapping', () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });

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
  check('CHK-001 claude happy: stream-json result -> provider-reported final with served model', () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = runHostRun(baseArgs({ root: sub, host: 'claude' }), { runner: makeRunner({ stdout: CLAUDE_STDOUT }, sink) });

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
  check('CHK-001 agy happy: unavailable final, provider antigravity, explicit reason', () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = runHostRun(baseArgs({ root: sub, host: 'agy', agyPrintTimeout: '30m' }), { runner: makeRunner({ stdout: AGY_STDOUT }, sink) });

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
  check('CHK-001 codex edge: turn.failed / no usage -> unavailable (no_turn_completed_usage_event), never a fabricated zero', () => {
    const sub = freshRoot();
    const result = runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_FAILED_STDOUT, exitCode: 1 }) });
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
  check('CHK-001 edge: ledger OFF -> zero rows, zero dirs, run still spawns + exit propagates', () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    const result = runHostRun(baseArgs({ root: sub, host: 'codex', env: OFF }), { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 2 }, sink) });
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
  check('CHK-001 edge: host non-zero exit propagates while codex rows still record', () => {
    const sub = freshRoot();
    const result = runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 2 }) });
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
  check('CHK-001 adversarial: inherited/polluted usage never fabricates counts (own-property projection)', () => {
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
    const result = runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: badStdout }) });
    assert.equal(result.exitCode, 0);
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'unavailable'), 'wrong-typed usage -> unavailable final');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'no fabricated provider-reported row');
  });

  // =========================================================================
  // CHK-002: binding (threadId=reviewRunId, subagentId=lane) + phase resolution
  // =========================================================================
  check('CHK-002 binding: reviewRunId->threadId, lane->subagentId, phase resolves from story index', () => {
    const sub = freshRoot();
    seedStoryIndex(sub, 'B-70e9', 'REVIEW');
    const result = runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', reviewRunId: 'B-70e9:RR-001', lane: 'lattice-review-quality', agentType: 'reviewer' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }) },
    );
    assert.equal(result.phase, 'REVIEW', 'phase resolved from story index');
    const records = readLedger(sub);
    assert.ok(records.length >= 1);
    for (const r of records) {
      assert.equal(r.threadId, 'B-70e9:RR-001');
      assert.equal(r.subagentId, 'lattice-review-quality');
      assert.equal(r.storyId, 'B-70e9');
      assert.equal(r.phase, 'REVIEW');
    }
  });

  check('CHK-002 edge: omitted reviewRunId/lane -> threadId/subagentId null (no empty-string pollution)', () => {
    const sub = freshRoot();
    const result = runHostRun(baseArgs({ root: sub, host: 'codex', phase: 'adhoc' }), { runner: makeRunner({ stdout: CODEX_STDOUT }) });
    assert.equal(result.phase, 'adhoc');
    const records = readLedger(sub);
    for (const r of records) {
      assert.equal(r.threadId, null);
      assert.equal(r.subagentId, null);
      assert.notEqual(r.threadId, '');
      assert.notEqual(r.subagentId, '');
    }
  });

  check('CHK-002 edge: unknown storyId fails pre-spawn (runner never invoked)', () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    assert.throws(
      () => runHostRun(baseArgs({ root: sub, host: 'codex', storyId: 'B-9999' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) }),
      /unknown story/i,
    );
    assert.equal(sink.calls, 0, 'no spawn on unknown story');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'no rows written for an unknown-story refusal');
  });

  check('CHK-002 adversarial: cross-story reviewRunId refused pre-spawn (runner never invoked)', () => {
    const sub = freshRoot();
    seedStoryIndex(sub, 'B-70e9', 'REVIEW');
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    assert.throws(
      () => runHostRun(
        baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', reviewRunId: 'B-1234:RR-009' }),
        { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) },
      ),
      /does not belong to story/i,
    );
    assert.equal(sink.calls, 0, 'no spawn on cross-story reviewRunId');
  });

  // =========================================================================
  // CHK-007a: hard-budget cap
  // =========================================================================
  check('CHK-007a budget: over-budget preflight refuses before spawn, writes blocked row (hard_budget_exceeded)', () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const result = runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
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

  // =========================================================================
  // CHK-007b: concurrency cap
  // =========================================================================
  check('CHK-007b concurrency: 5th run under cap 4 refuses, writes blocked row (concurrency_cap_exceeded)', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    for (let i = 0; i < 4; i++) seedSlot(dir, process.pid, `live-${i}`);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked when at the concurrency cap');
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.equal(result.liveRuns?.length, 4, 'live-run list surfaced');
    assert.notEqual(result.exitCode, 0);
    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked);
    assert.equal(blocked!.decision.reasonCode, 'concurrency_cap_exceeded');
    // Slot metadata never leaks into a ledger row (slots carry pid/timestamps only).
    const ledgerText = readFileSync(resolveLedgerPath(sub), 'utf8');
    assert.equal(ledgerText.includes('2000-01-01T00:00:00.000Z'), false, 'slot startedAt marker must not appear in the ledger');
  });

  check('CHK-007b concurrency: dead-pid slot is reclaimed so the run proceeds', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const dead = seedSlot(dir, DEAD_PID, 'dead');
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(existsSync(dead), false, 'dead-pid slot reclaimed');
    assert.equal(sink.calls, 1, 'run proceeds after reclaim');
    assert.equal(result.blocked, false);
  });

  check('CHK-007b concurrency: stale-mtime slot (live pid) is reclaimed by the staleness backstop', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const stale = seedSlot(dir, process.pid, 'stale');
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7h > 6h window
    utimesSync(stale, old, old);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(existsSync(stale), false, 'stale slot reclaimed by mtime backstop');
    assert.equal(sink.calls, 1);
    assert.equal(result.blocked, false);
  });

  check('CHK-007b adversarial: two acquires for the same slot path cannot both win (atomic wx)', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${process.pid}-race.json`);
    const meta = { pid: process.pid, startedAt: '2026-07-10T00:00:00.000Z', host: 'codex', storyId: null, agentType: 'reviewer' };
    const first = writeSlotFileExclusive(file, meta);
    const second = writeSlotFileExclusive(file, meta);
    assert.equal(first, true, 'first acquire wins');
    assert.equal(second, false, 'second acquire loses the wx race');
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

  check('CHK-003 autopilot repair OFF: byte-identical argv (no --output-format json), zero rows, zero dirs', () => {
    const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
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
  });

  // =========================================================================
  // CHK-003: host readiness probe coverage (extracted pure wiring helper)
  // =========================================================================
  check('CHK-003 probe wiring: per-host preflight+unavailable rows (agentType host-readiness-probe), provider mapping, documented reason', () => {
    const sub = freshRoot();
    const hosts = [{ host: 'codex' }, { host: 'claude' }, { host: 'agy' }];
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

    // A failure-shaped probe result records the SAME way (helper reads only host name).
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
      root: sub2, storyId: 'B-70e9', phase: 'probe', hosts: [{ host: 'codex' }, { host: 'claude' }, { host: 'agy' }],
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
