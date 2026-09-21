import assert from 'node:assert/strict';



import { existsSync, readdirSync, rmSync } from 'node:fs';

import { join } from 'node:path';


import { acquireHostRunSlot, hostRunSlotsDir, HOST_RUN_REFUSAL_EXIT_CODE } from '../../core/host-run.js';
import { runClaudeRepair, type AutopilotCommandRunner } from '../../core/autopilot-executor.js';

import {
  recordHostReadinessProbeUsage,
  HOST_READINESS_PROBE_AGENT_TYPE,
  HOST_READINESS_PROBE_UNAVAILABLE_REASON,
} from '../../handlers/review-escalation.js';
import { classifyHostExecutionReadiness } from '../../core/host-execution-readiness.js';
import {
  runCodexReviewLeaf,
  CODEX_REVIEW_VERDICT_SCHEMA,
  CODEX_REVIEW_BUDGET_BLOCKED,
  CODEX_REVIEW_CONCURRENCY_CAP_EXCEEDED,
  CROSS_HOST_REVIEW_CODEX_AGENT_TYPE,
  CROSS_HOST_REVIEW_CODEX_NO_USAGE_REASON,
  type CodexReviewRunner,
} from '../../core/codex-review-leaf.js';




import { resolveLedgerPath } from '../../core/usage-ledger/writer.js';

import { check, freshRoot, RepairSink, NO_REPAIR_ARGS, makeRepairRunner, repairStep, repairRequest, repairFailResult, repairPlan, ON, readLedger, seedSlot, CLAUDE_MODEL, slotMeta, checkAsync, seedCorruptLedger } from "./support.js";

export async function case59(): Promise<void> {


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
}

export async function case60(): Promise<void> {


  check('CHK-003 autopilot repair OFF: provider argv stays byte-compatible, usage rows stay off, shared provider admission remains active', () => {
    // Usage budget stays disabled and provider argv stays compatible, but the
    // ledger-independent capacity registry still wraps the provider spawn.
    const OFF = {
      PROOF_OR_STOP_USAGE_LEDGER: '0',
      PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1',
      PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1',
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
    assert.equal(existsSync(hostRunSlotsDir(sub)), true, 'provider admission still runs when usage accounting is OFF');
    assert.deepEqual(readdirSync(hostRunSlotsDir(sub)), [], 'OFF-path slot released');
  });
}

export async function case61(): Promise<void> {


  // =========================================================================
  // F-016: the autopilot repair passes the SAME pre-spawn admission as host_run.
  // Against the old code both checks below fail loudly: the repair recorded the
  // preflight and then invoked the runner directly (sink.calls === 1, no blocked
  // row, no slot ever held), so PROOF_OR_STOP_HARD_BUDGET_TOKENS and a saturated
  // PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT could not stop an autopilot repair.
  // =========================================================================
  check('F-016 repair budget admission: ledger ON + PROOF_OR_STOP_HARD_BUDGET_TOKENS=1 refuses PRE-SPAWN (runner never invoked) + blocked row (hard_budget_exceeded, anthropic, autopilot-repair)', () => {
    const sub = freshRoot();
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
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
}

export async function case62(): Promise<void> {


  check('F-016 repair concurrency admission: saturated cap refuses pre-spawn (concurrency_cap_exceeded row, no spawn); OFF still enforces the cap; slot HELD during a normal run and RELEASED after', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
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

    // Ledger OFF against the SAME saturated registry: admission still refuses;
    // usage accounting remains disabled and adds zero rows.
    const sinkOff: RepairSink = { calls: 0, lastArgs: null };
    const off = runClaudeRepair(
      sub, NO_REPAIR_ARGS, makeRepairRunner({ exitCode: 0, stdout: 'plain', stderr: '' }, sinkOff),
      repairStep(), repairRequest(), repairFailResult(), repairPlan('B-70e9', 'REVIEW'),
      { PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv,
    );
    assert.equal(sinkOff.calls, 0, 'OFF: provider admission still refuses at the saturated cap');
    assert.equal(off.status, 'failed');
    assert.ok(off.stderrExcerpt.includes('concurrency_cap_exceeded'));
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
}

export async function case63(): Promise<void> {


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
    const OFF = { PROOF_OR_STOP_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    const rows3 = recordHostReadinessProbeUsage({
      root: sub3, storyId: 'B-70e9', phase: 'probe', hosts,
      env: OFF, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });
    assert.equal(rows3.length, 0, 'OFF -> no rows returned');
    assert.equal(existsSync(join(sub3, '.proof-or-stop')), false, 'OFF -> no .proof-or-stop dir');
  });
}

export async function case64(): Promise<void> {


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
    const OFF = { PROOF_OR_STOP_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    const offRows = recordHostReadinessProbeUsage({
      root: subOff, storyId: 'B-70e9', phase: 'REVIEW',
      hosts: [{ host: 'codex-attempted', failureKind: 'timeout', outputBytes: 0 }],
      env: OFF, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot',
    });
    assert.equal(offRows.length, 0, 'OFF -> no rows even for a spawned host');
    assert.equal(existsSync(join(subOff, '.proof-or-stop')), false, 'OFF -> no .proof-or-stop dir');
  });
}

export async function case65(): Promise<void> {


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
}

export async function case66(): Promise<void> {


  await checkAsync('CHK-003/F-017 cross-host-review codex leaf: absent binding AND ledger OFF keep zero usage rows while provider admission remains mandatory', async () => {
    const MH = 'sha256:deadbeefcafefeed0000000000000000000000000000000000000000';
    const verdict = JSON.stringify({ schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision: 'pass', materialHash: MH, findings: [], summary: 'ok' });

    // Absent binding: no usage rows, but the independent provider slot is held.
    const sub1 = freshRoot();
    let calls1 = 0;
    const runner1: CodexReviewRunner = () => { calls1 += 1; return { stdout: `${verdict}\n`, exitCode: 0, timedOut: false }; };
    const leaf1 = await runCodexReviewLeaf({ storyId: 'B-70e9', storyWorktree: sub1, materialHash: MH, timeoutMs: 1000 }, runner1);
    assert.equal(calls1, 1, 'no binding -> the admitted codex runner runs');
    assert.equal(leaf1.hostBVerdict.decision, 'pass');
    assert.equal(existsSync(resolveLedgerPath(sub1)), false, 'no rows without a usageLedger binding');
    assert.equal(existsSync(hostRunSlotsDir(sub1)), true, 'slot registry exists without a ledger binding');
    assert.deepEqual(readdirSync(hostRunSlotsDir(sub1)), [], 'slot released');

    // Ledger OFF: budget is not evaluated, provider capacity still is.
    const sub2 = freshRoot();
    const OFF = { PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    let calls2 = 0;
    const runner2: CodexReviewRunner = () => { calls2 += 1; return { stdout: `${verdict}\n`, exitCode: 0, timedOut: false }; };
    const leaf2 = await runCodexReviewLeaf(
      { storyId: 'B-70e9', storyWorktree: sub2, materialHash: MH, timeoutMs: 1000, usageLedger: { root: sub2, recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: OFF, phase: 'REVIEW' } },
      runner2,
    );
    assert.equal(calls2, 1, 'OFF: the admitted leaf runs (the free cap=1 slot is acquired)');
    assert.equal(leaf2.hostBVerdict.decision, 'pass');
    assert.equal(existsSync(resolveLedgerPath(sub2)), false, 'no rows when ledger OFF');
    assert.equal(existsSync(hostRunSlotsDir(sub2)), true, 'slot registry is independent of usage ledger state');
    assert.deepEqual(readdirSync(hostRunSlotsDir(sub2)), [], 'slot released');
  });
}

export async function case67(): Promise<void> {


  // =========================================================================
  // F-017: the cross-host-review codex leaf passes the SAME pre-spawn admission
  // as host_run / the autopilot repair. Against the old leaf all three checks
  // fail loudly: the leaf recorded the preflight and then invoked the runner
  // directly (calls === 1, no blocked row, no slot ever held), so
  // PROOF_OR_STOP_HARD_BUDGET_TOKENS and a saturated PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT
  // could not stop the codex review spawn.
  // =========================================================================
  await checkAsync('F-017 codex leaf budget admission: ledger ON + PROOF_OR_STOP_HARD_BUDGET_TOKENS=1 refuses PRE-SPAWN (runner never invoked) + blocked row (hard_budget_exceeded, openai) + synthesized blocked verdict', async () => {
    const sub = freshRoot();
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
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
}

export async function case68(): Promise<void> {


  await checkAsync('F-017 codex leaf concurrency admission: saturated cap refuses pre-spawn (concurrency_cap_exceeded row provider openai, no spawn) + synthesized blocked verdict', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
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
}

export async function case69(): Promise<void> {


  await checkAsync('F-017 codex leaf normal run: the admission slot is HELD during the run and RELEASED after (cap=1 re-admission succeeds)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
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
}

export async function case70(): Promise<void> {


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
}
