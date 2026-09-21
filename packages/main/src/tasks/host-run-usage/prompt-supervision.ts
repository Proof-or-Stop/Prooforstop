import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';


import { existsSync, readFileSync, statSync } from 'node:fs';

import { isAbsolute, relative } from 'node:path';


import { acquireHostRunSlot, defaultHostRunRunner, releaseSlot, runHostRun, hostRunSlotsDir, type HostRunRunner } from '../../core/host-run.js';











import { supervisorHardeningCheckAsync, freshRoot, baseArgs, CLAUDE_STDOUT, slotMeta, deterministicHostRuntime } from "./support.js";

export async function case02(): Promise<void> {


  await supervisorHardeningCheckAsync('F-054/F-070/F-072/F-079 prompt transport and unsafe residual supervision fail closed', async () => {
    const managedClaudeRoot = freshRoot();
    const managedClaudeArgs = baseArgs({
      root: managedClaudeRoot,
      host: 'claude',
      storyId: 'B-managed-claude',
      agentType: 'lattice-review-quality',
      phase: 'REVIEW',
      lane: 'lattice-review-quality',
      reviewRunId: 'B-managed-claude:RR-001',
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0', LATTICE_PROVIDER_MAX_CONCURRENT: '1' },
      launchProfile: 'managed_reviewer',
      managedRunId: 'managed-claude-transport-smoke',
    });
    let managedPromptFile: string | null = null;
    await runHostRun(managedClaudeArgs, {
      runner: plan => {
        managedPromptFile = plan.promptFile ?? null;
        assert.ok(managedPromptFile, 'managed Claude receives an authoritative prompt file');
        const promptRelativeToCwd = relative(plan.cwd, managedPromptFile!);
        assert.ok(
          promptRelativeToCwd.length > 0
            && promptRelativeToCwd !== '..'
            && !promptRelativeToCwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
            && !isAbsolute(promptRelativeToCwd),
          'managed Claude prompt must be readable inside the provider working directory',
        );
        assert.equal(statSync(managedPromptFile!).mode & 0o777, 0o600, 'managed Claude prompt remains mode 0600');
        assert.equal(readFileSync(managedPromptFile!, 'utf8'), managedClaudeArgs.promptText, 'managed Claude prompt file carries the exact authoritative bytes');
        assert.equal(plan.argv.includes(managedClaudeArgs.promptText), false, 'managed Claude argv never carries plaintext prompt bytes');
        assert.deepEqual(
          plan.argv.slice(plan.argv.indexOf('--permission-mode'), plan.argv.indexOf('--permission-mode') + 2),
          ['--permission-mode', 'bypassPermissions'],
          'managed Claude uses an explicit non-interactive permission mode so required Lattice reads cannot await approval',
        );
        const schemaIndex = plan.argv.indexOf('--json-schema');
        assert.ok(schemaIndex >= 0, 'managed Claude requires provider-validated structured final output');
        const schemaText = plan.argv[schemaIndex + 1] ?? '';
        assert.ok(Buffer.byteLength(schemaText, 'utf8') > 0 && Buffer.byteLength(schemaText, 'utf8') <= 16 * 1024,
          'managed Claude JSON Schema is explicit and bounded');
        assert.equal(schemaText.includes(managedClaudeArgs.promptText), false, 'JSON Schema argv contains no prompt/private bytes');
        const schema = JSON.parse(schemaText) as {
          required: string[];
          properties: Record<string, { const?: string; enum?: string[]; required?: string[]; items?: { required?: string[] } }>;
          [key: string]: unknown;
        };
        assert.equal(schema.properties.schemaVersion?.const, 'lattice.managed_review_final_proposal.v1');
        assert.equal(schema.properties.storyId?.const, managedClaudeArgs.storyId);
        assert.equal(schema.properties.providerAgent?.const, managedClaudeArgs.agentType);
        assert.equal(schema.properties.lane?.const, managedClaudeArgs.lane);
        assert.equal(schema.properties.reviewRunId?.const, managedClaudeArgs.reviewRunId);
        for (const required of ['schemaVersion', 'storyId', 'providerAgent', 'lane', 'reviewRunId', 'conclusion', 'readManifest']) {
          assert.ok(schema.required.includes(required), `managed Claude schema requires ${required}`);
        }
        for (const unsupportedTopLevelComposition of ['oneOf', 'allOf', 'anyOf']) {
          assert.equal(Object.prototype.hasOwnProperty.call(schema, unsupportedTopLevelComposition), false,
            `provider-facing Claude input_schema rejects top-level ${unsupportedTopLevelComposition}`);
        }
        assert.deepEqual(schema.properties.conclusion.enum, ['pass', 'findings'],
          'managed Claude schema keeps the public conclusion vocabulary flat');
        assert.ok(schema.properties.note && schema.properties.findings,
          'flat schema still exposes pass/findings fields for the provider while the strict local parser enforces exclusivity');
        assert.deepEqual(schema.properties.readManifest.required,
          ['filesReadFully', 'filesTriagedByName', 'scanEscalationReason', 'candidateSpecSetDigest', 'corpusDigest'],
          'managed Claude schema requires exact read-manifest and routing-binding evidence');
        assert.deepEqual(schema.properties.readLog.required,
          ['filesReadFully', 'filesTriagedByName', 'summary', 'digest'],
          'managed Claude schema constrains a supplied read-log to the canonical shape');
        assert.deepEqual(schema.properties.findings.items?.required, ['desc', 'severity', 'category'],
          'managed Claude schema constrains every provider finding before local semantic validation');
        for (const unsupportedConstraint of ['minimum', 'maximum', 'minLength', 'maxLength']) {
          assert.equal(schemaText.includes(`"${unsupportedConstraint}"`), false,
            `raw Claude CLI schema avoids unsupported ${unsupportedConstraint} constraints`);
        }
        return { stdout: CLAUDE_STDOUT, stderr: '', exitCode: 0, timedOut: false };
      },
    });
    assert.ok(managedPromptFile);
    assert.equal(existsSync(managedPromptFile!), false, 'managed Claude prompt is removed after provider settlement');

    const sub = freshRoot();
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '0', LATTICE_PROVIDER_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const runner: HostRunRunner = plan => defaultHostRunRunner({
      ...plan,
      command: process.execPath,
      argv: ['-e', 'process.exit(0)'],
      stdinText: 'x'.repeat(8 * 1024 * 1024),
    });
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner });
    assert.notEqual(result.exitCode, 0, 'stdin EPIPE fails closed instead of fabricating provider success');
    assert.equal(result.terminalReason, 'child_error');
    assert.match(result.stderr, /stdin delivery failed: EPIPE/);
    assert.equal(result.processCleanup?.reaped, true, 'the provider close/reap boundary remains authoritative');
    const next = acquireHostRunSlot(hostRunSlotsDir(sub), 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('after-stdin-epipe'));
    assert.ok(next, 'stdin EPIPE cleanup releases the provider admission slot exactly once');
    if (next) releaseSlot(next.file, next.token);

    const syncHarness = deterministicHostRuntime();
    (syncHarness.child as typeof syncHarness.child & { pid: number }).pid = 987_655;
    syncHarness.child.stdin.end = () => {
      const error = new Error('synchronous stdin end failure') as NodeJS.ErrnoException;
      error.code = 'EPIPE';
      throw error;
    };
    const syncPending = defaultHostRunRunner({
      command: 'fixture-provider', argv: [], env: {}, cwd: sub, host: 'codex',
      stdinText: 'prompt', onChunk: () => {},
    }, syncHarness.runtime);
    assert.equal(syncHarness.killCount(), 1, 'a synchronous stdin.end failure immediately terminates the exact child');
    syncHarness.child.emit('close', 0, null);
    const syncResult = await syncPending;
    assert.equal(syncResult.terminalReason, 'child_error');
    assert.match(syncResult.stderr, /stdin delivery failed: EPIPE/);

    const descriptorRoot = freshRoot();
    const descriptorResult = await runHostRun(baseArgs({
      root: descriptorRoot,
      host: 'codex',
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0', LATTICE_PROVIDER_MAX_CONCURRENT: '1' },
    }), {
      runner: plan => defaultHostRunRunner({
        ...plan,
        command: process.execPath,
        argv: ['-e', 'require("node:fs").closeSync(3); setTimeout(() => {}, 100)'],
      }),
      reviewInvocationPayload: () => 'x'.repeat(2 * 1024 * 1024),
    });
    assert.equal(descriptorResult.terminalReason, 'child_error', 'async fd3 EPIPE is a normal failed result');
    assert.match(descriptorResult.stderr, /review invocation descriptor delivery failed: EPIPE/);
    assert.equal(descriptorResult.processCleanup?.reaped, true, 'fd3 failure waits for exact child reap');

    const residualRoot = freshRoot();
    let provider: ReturnType<typeof spawn> | null = null;
    const unsafe = await runHostRun(baseArgs({
      root: residualRoot,
      host: 'codex',
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0', LATTICE_PROVIDER_MAX_CONCURRENT: '1' },
    }), {
      runner: async plan => {
        provider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
        assert.ok(provider.pid);
        plan.onSpawn?.({
          pid: provider.pid,
          pgid: provider.pid,
          spawnedAt: new Date().toISOString(),
          startFingerprint: null,
          processGroupIsolated: true,
        });
        return {
          stdout: '', stderr: '', exitCode: 1, timedOut: false, terminalReason: 'child_error',
          replacementSafe: false, residualProcessGroup: true,
          processCleanup: { termSent: true, killSent: true, reaped: false, residualProcessGroup: true },
        };
      },
    });
    assert.equal(unsafe.replacementSafe, false);
    assert.equal(
      acquireHostRunSlot(hostRunSlotsDir(residualRoot), 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('blocked-by-residual')),
      null,
      'unsafe live residual provider retains the canonical capacity slot',
    );
    const providerExit = new Promise<void>(resolveExit => provider!.once('close', () => resolveExit()));
    provider!.kill('SIGKILL');
    await providerExit;
    const reclaimed = acquireHostRunSlot(hostRunSlotsDir(residualRoot), 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('after-residual-death'));
    assert.ok(reclaimed, 'the retained slot becomes reclaimable only after exact provider death');
    if (reclaimed) releaseSlot(reclaimed.file, reclaimed.token);
  });
}
