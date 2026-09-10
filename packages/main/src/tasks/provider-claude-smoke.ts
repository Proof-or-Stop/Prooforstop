#!/usr/bin/env node
/**
 * Smoke coverage for real bounded `provider.claude` execution (M7).
 *
 * Drives the pure auth/credential helpers and `runBoundedClaudeProvider` with an
 * INJECTED process runner (never spawns a real Claude CLI), then drives the
 * executor gates through `executePlannedSteps` with a stubbed bounded executor.
 *
 * It pins the Claude-specific fail-closed contract:
 * - real Claude execution runs only when explicitly enabled in providerPolicy;
 * - noninteractive auth is required (allowlisted AND present recognized credential)
 *   — Claude never falls back to an interactive login;
 * - a secretRef alone cannot satisfy local Claude noninteractive auth;
 * - the redacted env carries ONLY allowlisted credentials to the child;
 * - evidence records credential KEY NAMES / counts only, never secret values;
 * - provider success is NEVER validation success, prose evidence, or authority DONE.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import {
  acquireProviderProcessAdmission,
  releaseProviderProcessAdmission,
} from '../core/provider-process-admission.js';
import {
  claudeNoninteractiveAuthAvailable,
  claudeProviderAvailable,
  runBoundedClaudeProvider,
  CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS,
  type ProviderProcessRunner,
} from '../providers/claude-cli.js';
import type {
  BoundedProviderExecutor,
  ProviderExecRequest,
  ProviderExecResult,
} from '../providers/types.js';

type JsonObject = Record<string, any>;

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-provider-claude-'));

const PASS_LINE =
  '✓ provider-claude smoke passed: enable-gated bounded Claude execution, noninteractive auth preflight, secretRefs enforcement, env redaction summary, and never-validation/never-DONE invariants verified';

try {
  // --- Part 1: claudeNoninteractiveAuthAvailable (pure preflight) -------------
  assert.equal(
    claudeNoninteractiveAuthAvailable({ ANTHROPIC_API_KEY: 'sk-xxx' }, ['ANTHROPIC_API_KEY']),
    true,
    'allowlisted + present recognized credential → noninteractive auth available',
  );
  assert.equal(
    claudeNoninteractiveAuthAvailable({ ANTHROPIC_API_KEY: 'sk-xxx' }, []),
    false,
    'present but NOT allowlisted → redacted out before reaching the CLI → not available',
  );
  assert.equal(
    claudeNoninteractiveAuthAvailable({}, ['ANTHROPIC_API_KEY']),
    false,
    'allowlisted but absent → not available',
  );
  assert.equal(
    claudeNoninteractiveAuthAvailable({ ANTHROPIC_API_KEY: '   ' }, ['ANTHROPIC_API_KEY']),
    false,
    'whitespace-only credential is empty → not available',
  );
  assert.equal(
    claudeNoninteractiveAuthAvailable({ CLAUDE_KEY: 'x' }, ['CLAUDE_KEY']),
    false,
    'an unrelated allowlisted var is not a recognized Claude noninteractive auth credential',
  );
  assert.equal(
    claudeNoninteractiveAuthAvailable({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, ['CLAUDE_CODE_OAUTH_TOKEN']),
    true,
    'an OAuth token is a recognized noninteractive auth credential',
  );
  assert(CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS.includes('ANTHROPIC_API_KEY'));
  assert.equal(typeof claudeProviderAvailable({}), 'boolean', 'availability preflight returns a boolean');

  // --- Part 2: runBoundedClaudeProvider with an injected runner ---------------
  let captured: { binary: string; argv: string[]; env: JsonObject } | null = null;
  const okRunner: ProviderProcessRunner = (binary, argv, opts) => {
    captured = { binary, argv, env: opts.env as JsonObject };
    return {
      status: 0,
      stdout: '{"type":"system","model":"claude-sonnet-4-20250514"}\n{"type":"result","result":"applied the change"}',
      stderr: '',
      signal: null,
    };
  };
  const baseReq: ProviderExecRequest = {
    provider: 'claude',
    argv: ['-p', 'implement', '--output-format', 'stream-json'],
    cwd: root,
    timeoutMs: 30_000,
    maxAttempts: 2,
    env: { ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin' },
  };
  const okRes = runBoundedClaudeProvider(baseReq, okRunner);
  assert.equal(okRes.provider, 'claude');
  assert.equal(okRes.exitCode, 0);
  assert.equal(okRes.model, 'claude-sonnet-4-20250514', 'model metadata is extracted best-effort from stream-json');
  assert.equal(okRes.attempts, 1, 'a clean exit terminates after a single attempt');
  assert.equal(okRes.timedOut, false);
  assert.equal(okRes.spawnError, false);
  assert.equal(okRes.stdoutDigest.length, 64, 'stdout is captured as a sha256 hex digest, not raw text');
  assert(okRes.stdoutBytes > 0);
  assert.deepEqual(captured!.argv, ['-p', 'implement', '--output-format', 'stream-json'], 'argv is mapped verbatim to the CLI');
  assert.equal(captured!.binary, 'claude');
  assert(!JSON.stringify(okRes).includes('applied the change'), 'raw provider stdout text is never surfaced (digest only)');
  assert(!JSON.stringify(okRes).includes('sk-secret'), 'credential value never surfaces in the provider result');

  // spawn error (missing binary) → null exit, not retried
  const enoentRunner: ProviderProcessRunner = () => ({
    status: null, stdout: '', stderr: '',
    error: Object.assign(new Error('not found'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
  });
  const enoentRes = runBoundedClaudeProvider({ ...baseReq, maxAttempts: 3 }, enoentRunner);
  assert.equal(enoentRes.spawnError, true);
  assert.equal(enoentRes.exitCode, null, 'a never-spawned binary has a null exit code');
  assert.equal(enoentRes.attempts, 1, 'a missing binary is not retried');

  // timeout → retried up to the attempt cap
  let timeoutCalls = 0;
  const timeoutRunner: ProviderProcessRunner = () => {
    timeoutCalls++;
    return { status: null, stdout: '', stderr: '', signal: 'SIGTERM' };
  };
  const timeoutRes = runBoundedClaudeProvider({ ...baseReq, maxAttempts: 3 }, timeoutRunner);
  assert.equal(timeoutRes.timedOut, true);
  assert.equal(timeoutRes.attempts, 3, 'a timeout is retried up to the attempt cap');
  assert.equal(timeoutCalls, 3);

  // non-zero exit → terminal, never retried
  let failCalls = 0;
  const failRunner: ProviderProcessRunner = () => {
    failCalls++;
    return { status: 2, stdout: '', stderr: 'boom', signal: null };
  };
  const failRes = runBoundedClaudeProvider({ ...baseReq, maxAttempts: 3 }, failRunner);
  assert.equal(failRes.exitCode, 2);
  assert.equal(failRes.timedOut, false);
  assert.equal(failRes.attempts, 1, 'a non-zero exit is terminal, never retried');
  assert.equal(failCalls, 1);

  // --- Part 3: executor gates (stubbed bounded executor; never spawns) --------
  const provStore = {
    readStory: () => ({ phase: 'DEV' } as JsonObject),
    storyExists: () => true,
    listStoryIds: () => [] as string[],
    appendProcessEvent: () => {},
  } as any;
  const provStub = (available: boolean, result?: Partial<ProviderExecResult>): BoundedProviderExecutor => ({
    available: () => available,
    run: (req): ProviderExecResult => ({
      provider: req.provider, argvDigest: 'ad', exitCode: 0, stdoutDigest: 'sd', stderrDigest: 'ed',
      stdoutBytes: 5, stderrBytes: 0, durationMs: 3, attempts: 1, timedOut: false, spawnError: false, ...result,
    }),
  });
  const claudeStep = (argv?: string[]): JsonObject => ({
    stepId: 'step-claude', type: 'provider.claude', title: 'bounded claude', purpose: 'bounded claude action',
    cwdPolicy: 'story-worktree', timeoutMs: 30_000, maxAttempts: 1, requiresCleanWorktree: true,
    producesEvidence: true, blocksUntilEvidenceUploaded: true, provider: 'claude', evidenceBinding: 'B-syn:claude',
    args: argv ? { operation: 'implement', argv } : { operation: 'implement' },
  });
  const plan = (step: JsonObject, providerPolicy: JsonObject): JsonObject => ({
    schemaVersion: 'proof-or-stop.job_plan.v1', plannerRunId: 'run-syn', storyId: 'B-syn', mode: 'local', until: 'DONE',
    developmentWorkflow: 'standard', plannedSteps: [step], coverageMap: [], multiHostPolicy: {}, providerPolicy,
    plannerDigest: 'pd', jobPlanDigest: 'jd', status: 'planned',
  });
  const exec = (jobPlan: JsonObject, env: JsonObject, executor: BoundedProviderExecutor): JsonObject =>
    executePlannedSteps({ root, store: provStore, jobPlan: jobPlan as any, env, providerExecutor: executor }) as JsonObject;

  // disabled: claude not in allowedProviders → fail closed before any spawn
  const disabled = exec(
    plan(claudeStep(['-p', 'x']), { allowedProviders: [], credentialsEnvAllowlist: ['ANTHROPIC_API_KEY'] }),
    { ANTHROPIC_API_KEY: 'sk' }, provStub(true));
  assert.equal(disabled.steps[0].reason, 'disabled');
  assert.equal(disabled.authorityDone, false);

  // provider_unavailable: enabled + auth present, but CLI not available (fires before auth gate)
  const unavailable = exec(
    plan(claudeStep(['-p', 'x']), { allowedProviders: ['claude'], credentialsEnvAllowlist: ['ANTHROPIC_API_KEY'] }),
    { ANTHROPIC_API_KEY: 'sk' }, provStub(false));
  assert.equal(unavailable.steps[0].reason, 'provider_unavailable');

  // credential_unavailable: enabled + available, but no credential configured at all
  const noCred = exec(
    plan(claudeStep(['-p', 'x']), { allowedProviders: ['claude'], credentialsEnvAllowlist: ['ANTHROPIC_API_KEY'] }),
    {}, provStub(true));
  assert.equal(noCred.steps[0].reason, 'credential_unavailable');

  // noninteractive_auth_unavailable: credential present but NOT a recognized Claude auth var
  const authBlock = exec(
    plan(claudeStep(['-p', 'do']), { allowedProviders: ['claude'], credentialsEnvAllowlist: ['CLAUDE_KEY'] }),
    { CLAUDE_KEY: 'present' }, provStub(true));
  assert.equal(authBlock.steps[0].status, 'blocked');
  assert.equal(authBlock.steps[0].reason, 'noninteractive_auth_unavailable');
  assert.equal(authBlock.stopReason, 'noninteractive_auth_unavailable');
  assert.equal(authBlock.steps[0].summary.validationSatisfied, false);
  assert.deepEqual(authBlock.steps[0].summary.recognizedAuthEnvVars, [...CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS]);
  assert.equal(authBlock.authorityDone, false);
  assert.equal(authBlock.receiptVerified, false);
  assert(authBlock.nextActions.some((a: string) => a.includes('ANTHROPIC_API_KEY')),
    'a blocked auth gate points the operator at a recognized noninteractive auth credential');

  const admissionEnv = {
    ANTHROPIC_API_KEY: 'sk-secret',
    PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1',
  };
  const admissionHolder = acquireProviderProcessAdmission({
    root,
    env: admissionEnv,
    host: 'codex',
    storyId: 'B-syn',
    agentType: 'planned-step-admission-holder',
  });
  assert.equal(admissionHolder.admitted, true, 'planned-step admission fixture must hold the sole provider slot');
  try {
    let providerExecutorCalls = 0;
    const admissionBlocked = exec(
      plan(claudeStep(['-p', 'implement']), {
        allowedProviders: ['claude'],
        credentialsEnvAllowlist: ['ANTHROPIC_API_KEY'],
      }),
      admissionEnv,
      {
        available: () => true,
        run: (request): ProviderExecResult => {
          providerExecutorCalls += 1;
          return {
            provider: request.provider,
            argvDigest: 'not-reached',
            exitCode: 0,
            stdoutDigest: 'not-reached',
            stderrDigest: 'not-reached',
            stdoutBytes: 0,
            stderrBytes: 0,
            durationMs: 0,
            attempts: 1,
            timedOut: false,
            spawnError: false,
          };
        },
      },
    );
    assert.equal(admissionBlocked.steps[0].reason, 'concurrency_cap_exceeded');
    assert.equal(providerExecutorCalls, 0, 'planned-steps admission must run before the injected provider executor');
  } finally {
    releaseProviderProcessAdmission(admissionHolder);
  }

  // success: recognized auth var + available → passes; evidence is redacted + never DONE
  let capReq: JsonObject | null = null;
  const okExec = exec(
    plan(claudeStep(['-p', 'implement', '--output-format', 'stream-json']),
      { allowedProviders: ['claude'], productionDoneProviders: ['claude'], credentialsEnvAllowlist: ['ANTHROPIC_API_KEY'] }),
    { ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin', UNRELATED_SECRET: 'leak-me' },
    {
      available: () => true,
      run: (req): ProviderExecResult => {
        capReq = req as any;
        return { provider: req.provider, argvDigest: 'ad', exitCode: 0, stdoutDigest: 'sd', stderrDigest: 'ed', stdoutBytes: 4, stderrBytes: 0, durationMs: 6, attempts: 1, timedOut: false, spawnError: false };
      },
    });
  const okStep = okExec.steps[0];
  assert.equal(okStep.status, 'passed');
  assert.equal(okStep.type, 'provider.claude');
  assert.equal(okStep.summary.validationSatisfied, false, 'provider success must never equal validation success');
  assert.equal(okStep.summary.providerProseAcceptedAsEvidence, false);
  assert.equal(okStep.summary.productionAuthorityEligible, false);
  assert.equal(okStep.summary.envRedacted, true);
  assert.deepEqual(okStep.summary.credentialEnvKeysProjected, ['ANTHROPIC_API_KEY'],
    'evidence records the projected credential KEY NAME only');
  assert.equal(okStep.summary.secretRefCount, 0);
  // redacted env to the child: ONLY the allowlisted credential, never unrelated secrets
  assert.equal(capReq!.env.ANTHROPIC_API_KEY, 'sk-secret', 'allowlisted credential is projected to the provider process');
  assert.equal(capReq!.env.UNRELATED_SECRET, undefined, 'non-allowlisted env is redacted out of the provider projection');
  assert.equal(capReq!.cwd, root);
  assert.equal(capReq!.timeoutMs, 30_000);
  assert(!JSON.stringify(okExec).includes('sk-secret'), 'raw credential value never surfaces in execution evidence');
  assert.equal(okExec.authorityDone, false);
  assert.equal(okExec.fullAuthorityDone, false);
  assert.equal(okExec.receiptVerified, false);
  assert.equal(okExec.multiHostVerified, false);

  // --- Part 4: secretRefs enforcement ----------------------------------------
  // A secretRef-only policy is "credential configured" (Gate 4 passes — the secret is
  // referenced externally, never inlined), but it cannot authenticate the LOCAL Claude
  // CLI noninteractively, so Gate 4b still fails closed rather than hanging on a login.
  const secretRefClaude = exec(
    plan(claudeStep(['-p', 'x']), { allowedProviders: ['claude'], credentialsEnvAllowlist: [], secretRefs: ['vault://claude/key'] }),
    {}, provStub(true));
  assert.equal(secretRefClaude.steps[0].reason, 'noninteractive_auth_unavailable',
    'a secretRef alone cannot satisfy local Claude noninteractive auth (passes Gate 4, blocks Gate 4b)');
  assert.equal(secretRefClaude.steps[0].status, 'blocked');
  assert.equal(secretRefClaude.steps[0].summary.validationSatisfied, false);

  // No env AND no secretRefs → credential_unavailable (contrast with the secretRef case above).
  const noConfig = exec(
    plan(claudeStep(['-p', 'x']), { allowedProviders: ['claude'], credentialsEnvAllowlist: [], secretRefs: [] }),
    {}, provStub(true));
  assert.equal(noConfig.steps[0].reason, 'credential_unavailable',
    'with neither env credential nor secretRef configured, the credential gate fails closed');
  assert.equal(noConfig.steps[0].summary.secretRefCount, 0);

  console.log(PASS_LINE);
} finally {
  rmSync(root, { recursive: true, force: true });
}
