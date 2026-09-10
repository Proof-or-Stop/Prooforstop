#!/usr/bin/env node
/**
 * Focused smoke for REAL bounded `provider.codex` execution (M7).
 *
 * The stubbed provider suite in `planner-unattended-smoke.ts` drives the executor
 * gates with an injected `BoundedProviderExecutor`. This smoke instead exercises
 * the REAL spawn seam — `codexCliAvailable` + `runBoundedCodexProvider` against an
 * actual temp `codex` binary on PATH, plus one end-to-end `executePlannedSteps`
 * run with the DEFAULT executor — so the parts a stub can never prove are covered:
 *
 *   - the availability preflight actually resolves the binary on PATH;
 *   - a real spawn captures stdout/stderr as digests + byte counts, exit code, and
 *     duration, and NEVER surfaces raw output (no credential/transcript leakage);
 *   - stdin is closed so a bounded action cannot hang on an interactive prompt;
 *   - a non-zero exit, missing binary, argv-too-large spawn failure, generic
 *     spawn failure, and a timeout each classify correctly;
 *   - through the executor: provider success is gated, redacted, and NEVER equals
 *     validation success or authority DONE; disabled/unavailable fail closed.
 *
 * Run: npm run test:legacy -- provider-codex
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCliAvailable, runBoundedCodexProvider } from '../providers/codex-cli.js';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import { runAgentLivenessSuiteForPinnedEvidence, agentLivenessSuiteChildEnvironment } from './agent-liveness-suite-smoke.js';

type JsonObject = Record<string, any>;

const sha256Json = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const work = mkdtempSync(join(tmpdir(), 'proof-or-stop-provider-codex-'));
const binDir = join(work, 'bin');
const emptyBinDir = join(work, 'empty-bin');
const projectRoot = join(work, 'project');
for (const dir of [binDir, emptyBinDir, projectRoot]) mkdirSync(dir, { recursive: true });

/** Install a fake `codex` executable that behaves per the embedded script body. */
function installFakeCodex(body: string): void {
  const path = join(binDir, 'codex');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

const STDOUT_MARKER = 'CODEX_STDOUT_MARKER_a1b2c3';
const STDERR_MARKER = 'CODEX_STDERR_MARKER_d4e5f6';

try {
  // ----------------------------------------------------------------------------
  // 1. codexCliAvailable preflight resolves the real binary on PATH (B3a).
  // ----------------------------------------------------------------------------
  installFakeCodex('exit 0');
  assert.equal(codexCliAvailable({ PATH: binDir }), true, 'codex on PATH is available');
  assert.equal(codexCliAvailable({ PATH: emptyBinDir }), false, 'codex absent from PATH is unavailable');
  assert.equal(codexCliAvailable({}), false, 'no PATH at all is unavailable, never throws');

  // ----------------------------------------------------------------------------
  // 2. runBoundedCodexProvider: REAL spawn capture — digests/bytes/exit/duration,
  //    and raw stdout/stderr is NEVER surfaced in the structured result.
  // ----------------------------------------------------------------------------
  installFakeCodex(`printf '%s' '${STDOUT_MARKER}'\nprintf '%s' '${STDERR_MARKER}' 1>&2\nexit 0`);
  const ok = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec', '--task', 'implement'],
    cwd: projectRoot,
    timeoutMs: 10_000,
    maxAttempts: 1,
    env: { PATH: binDir },
  });
  assert.equal(ok.provider, 'codex');
  assert.equal(ok.exitCode, 0, 'clean exit is captured');
  assert.equal(ok.spawnError, false);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.attempts, 1);
  assert.equal(ok.stdoutBytes, Buffer.byteLength(STDOUT_MARKER, 'utf8'), 'stdout byte count is captured');
  assert.equal(ok.stderrBytes, Buffer.byteLength(STDERR_MARKER, 'utf8'), 'stderr byte count is captured');
  assert.equal(ok.stdoutDigest, sha256Json(STDOUT_MARKER), 'stdout digest matches sha256(JSON(stdout))');
  assert.equal(ok.stderrDigest, sha256Json(STDERR_MARKER), 'stderr digest matches sha256(JSON(stderr))');
  assert.equal(ok.argvDigest, sha256Json(['exec', '--task', 'implement']), 'argv digest is over the argv array');
  assert.equal(typeof ok.durationMs, 'number');
  assert.ok(ok.durationMs >= 0, 'duration is recorded');
  // The single most important leakage invariant: raw transcript never escapes.
  const okSerialized = JSON.stringify(ok);
  assert.ok(!okSerialized.includes(STDOUT_MARKER), 'raw stdout must never appear in the provider result');
  assert.ok(!okSerialized.includes(STDERR_MARKER), 'raw stderr must never appear in the provider result');

  // ----------------------------------------------------------------------------
  // 3. stdin is closed: a script that blocks on stdin must still terminate, not hang.
  //    (`read` returns EOF immediately because stdin is closed by the runner.)
  // ----------------------------------------------------------------------------
  installFakeCodex('read LINE\nexit 0');
  const stdinClosed = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 1,
    env: { PATH: binDir },
  });
  assert.equal(stdinClosed.timedOut, false, 'stdin-closed bounded action does not hang on a prompt');
  assert.equal(stdinClosed.spawnError, false);

  // ----------------------------------------------------------------------------
  // 4. Non-zero exit is captured terminally (not retried, not promoted to success).
  // ----------------------------------------------------------------------------
  installFakeCodex(`printf 'boom' 1>&2\nexit 3`);
  const failed = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 3,
    env: { PATH: binDir },
  });
  assert.equal(failed.exitCode, 3, 'non-zero exit code is captured');
  assert.equal(failed.timedOut, false);
  assert.equal(failed.spawnError, false);
  assert.equal(failed.attempts, 1, 'a definite non-zero exit is terminal — retries are not burned');

  // ----------------------------------------------------------------------------
  // 5. Missing binary -> spawnError, exitCode null (fail-closed signal upstream).
  // ----------------------------------------------------------------------------
  const missing = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 2,
    env: { PATH: emptyBinDir },
  });
  assert.equal(missing.spawnError, true, 'a missing codex binary is a spawnError');
  assert.equal(missing.exitCode, null, 'spawnError yields a null exit code');
  assert.equal(missing.attempts, 1, 'a missing binary is not retryable');
  assert.equal(missing.spawnErrorKind, 'missing_executable', 'ENOENT is classified as missing_executable');
  assert.equal(missing.spawnErrorCode, 'ENOENT', 'spawnErrorCode preserves ENOENT');

  // ----------------------------------------------------------------------------
  // 6. Spawn setup failures classify E2BIG distinctly from generic spawn errors.
  // ----------------------------------------------------------------------------
  const argvTooLarge = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec', 'large-prompt-placeholder'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 3,
    env: { PATH: binDir },
  }, () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('argv too large'), { code: 'E2BIG' }) as NodeJS.ErrnoException,
  }));
  assert.equal(argvTooLarge.spawnError, true, 'E2BIG is a spawnError');
  assert.equal(argvTooLarge.exitCode, null, 'E2BIG spawn failure yields a null exit code');
  assert.equal(argvTooLarge.spawnErrorKind, 'argv_too_large', 'E2BIG is classified as argv_too_large');
  assert.equal(argvTooLarge.spawnErrorCode, 'E2BIG', 'spawnErrorCode preserves E2BIG');
  assert.equal(argvTooLarge.attempts, 1, 'E2BIG is not retried');

  const genericSpawnFailure = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 3,
    env: { PATH: binDir },
  }, () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('permission denied'), { code: 'EACCES' }) as NodeJS.ErrnoException,
  }));
  assert.equal(genericSpawnFailure.spawnError, true, 'non-timeout spawn error is a spawnError');
  assert.equal(genericSpawnFailure.exitCode, null, 'generic spawn failure yields a null exit code');
  assert.equal(genericSpawnFailure.spawnErrorKind, 'spawn_failed', 'non-ENOENT/E2BIG spawn errors classify as spawn_failed');
  assert.equal(genericSpawnFailure.spawnErrorCode, 'EACCES', 'spawnErrorCode preserves the original generic spawn error code');
  assert.equal(genericSpawnFailure.attempts, 1, 'generic spawn setup failure is not retried');

  // ----------------------------------------------------------------------------
  // 7. Timeout -> timedOut true (bounded wall-clock is enforced via the kill signal).
  //    Pure-builtin infinite loop (no external `sleep`), so the only env it needs is
  //    the binDir on PATH — the bounded timeout SIGTERMs it at ~250ms.
  // ----------------------------------------------------------------------------
  installFakeCodex('while :; do :; done');
  const timed = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 250,
    maxAttempts: 1,
    env: { PATH: binDir },
  });
  assert.equal(timed.timedOut, true, 'a bounded timeout is detected from the kill signal');
  assert.equal(timed.attempts, 1);

  // Injected-runner coverage makes the retry contract deterministic: only a
  // timeout retries, the policy caps attempts at five, and the first later
  // non-timeout result (success or failure) is terminal.
  let timeoutThenSuccessCalls = 0;
  const timeoutThenSuccess = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 4,
    env: { PATH: binDir },
  }, () => {
    timeoutThenSuccessCalls += 1;
    return timeoutThenSuccessCalls < 3
      ? { status: null, signal: 'SIGTERM', stdout: '', stderr: '' }
      : { status: 0, signal: null, stdout: 'done', stderr: '' };
  });
  assert.equal(timeoutThenSuccessCalls, 3, 'timeout-only failures retry until a non-timeout result arrives');
  assert.equal(timeoutThenSuccess.attempts, 3, 'attempt evidence includes both timeouts and the terminal success');
  assert.equal(timeoutThenSuccess.exitCode, 0);
  assert.equal(timeoutThenSuccess.timedOut, false, 'the terminal attempt determines final timeout classification');

  let cappedTimeoutCalls = 0;
  const cappedTimeout = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 99,
    env: { PATH: binDir },
  }, () => {
    cappedTimeoutCalls += 1;
    return { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
  });
  assert.equal(cappedTimeoutCalls, 5, 'maxAttempts values above policy are capped at exactly five runner calls');
  assert.equal(cappedTimeout.attempts, 5, 'bounded result records the exact five-attempt policy cap');
  assert.equal(cappedTimeout.timedOut, true);

  let timeoutThenFailureCalls = 0;
  const timeoutThenFailure = runBoundedCodexProvider({
    provider: 'codex',
    argv: ['exec'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 5,
    env: { PATH: binDir },
  }, () => {
    timeoutThenFailureCalls += 1;
    return timeoutThenFailureCalls === 1
      ? { status: null, signal: 'SIGTERM', stdout: '', stderr: '' }
      : { status: 7, signal: null, stdout: '', stderr: 'terminal failure' };
  });
  assert.equal(timeoutThenFailureCalls, 2, 'a later non-timeout failure stops retries early');
  assert.equal(timeoutThenFailure.attempts, 2);
  assert.equal(timeoutThenFailure.exitCode, 7);
  assert.equal(timeoutThenFailure.timedOut, false);

  // ----------------------------------------------------------------------------
  // 8. End-to-end through executePlannedSteps with the DEFAULT executor (real spawn):
  //    enabled + credentialed + available codex runs, evidence is redacted, and
  //    success NEVER equals validation success or authority DONE.
  // ----------------------------------------------------------------------------
  const envProbeFile = join(work, 'codex-env-probe.txt');
  if (existsSync(envProbeFile)) rmSync(envProbeFile);
  // Fake codex records the two credentials it actually received, then succeeds.
  // Pure-builtin (printf + redirection) so it needs nothing but the binDir on PATH:
  // an allowlisted var expands to its value; a redacted var expands to empty.
  installFakeCodex(
    `printf 'CODEX_KEY=%s\\n' "$CODEX_KEY" > '${envProbeFile}'\n`
    + `printf 'UNRELATED_SECRET=%s\\n' "$UNRELATED_SECRET" >> '${envProbeFile}'\n`
    + `printf '%s' '${STDOUT_MARKER}'\nexit 0`,
  );

  const store = {
    readStory: () => ({ phase: 'DEV' } as JsonObject),
    storyExists: () => true,
    listStoryIds: () => [] as string[],
    appendProcessEvent: () => {},
  } as any;

  const codexStep = (overrides: JsonObject = {}): JsonObject => ({
    stepId: 'step-codex',
    type: 'provider.codex',
    title: 'bounded codex',
    purpose: 'bounded provider action',
    cwdPolicy: 'story-worktree',
    timeoutMs: 10_000,
    maxAttempts: 1,
    requiresCleanWorktree: false,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: true,
    provider: 'codex',
    evidenceBinding: 'B-codex:provider',
    args: { operation: 'implement', argv: ['exec', '--task', 'implement'] },
    ...overrides,
  });

  const plan = (step: JsonObject, providerPolicy: JsonObject): JsonObject => ({
    schemaVersion: 'lattice.job_plan.v1',
    plannerRunId: 'run-codex',
    storyId: 'B-codex',
    mode: 'local',
    until: 'TEST',
    developmentWorkflow: 'standard',
    plannedSteps: [step],
    coverageMap: [],
    multiHostPolicy: {},
    providerPolicy,
    plannerDigest: 'pd',
    jobPlanDigest: 'jd',
    status: 'planned',
  });

  const exec = (jobPlan: JsonObject, env: JsonObject): JsonObject =>
    executePlannedSteps({ root: projectRoot, store, jobPlan: jobPlan as any, env }) as JsonObject;

  const e2e = exec(
    plan(codexStep(), {
      allowedProviders: ['codex'],
      productionDoneProviders: ['codex'],
      credentialsEnvAllowlist: ['CODEX_KEY'],
    }),
    { PATH: binDir, HOME: work, CODEX_KEY: 'super-secret-value', UNRELATED_SECRET: 'do-not-leak' },
  );
  const e2eStep = e2e.steps[0];
  assert.equal(e2eStep.status, 'passed', 'real codex spawn through the executor passes');
  assert.equal(e2eStep.type, 'provider.codex');
  assert.equal(e2eStep.summary.exitCode, 0);
  assert.equal(e2eStep.summary.validationSatisfied, false, 'provider success never equals validation success');
  assert.equal(e2eStep.summary.providerProseAcceptedAsEvidence, false);
  assert.equal(e2eStep.summary.productionAuthorityEligible, false, 'bounded provider evidence is never production-authority-eligible');
  assert.equal(e2e.authorityDone, false, 'provider success is never authority DONE');
  assert.equal(e2e.fullAuthorityDone, false);
  assert.equal(e2e.receiptVerified, false);
  assert.equal(e2e.multiHostVerified, false);
  // No raw credential anywhere in the structured execution result.
  assert.ok(!JSON.stringify(e2e).includes('super-secret-value'), 'raw credential must never surface in execution evidence');

  // Redaction proof: the credential the policy allowlists reaches the child; an
  // unrelated secret in the ambient env does NOT (redactedProviderEnv strips it).
  assert.ok(existsSync(envProbeFile), 'fake codex actually ran and recorded its environment');
  const childEnv = readFileSync(envProbeFile, 'utf8');
  assert.ok(/^CODEX_KEY=super-secret-value$/m.test(childEnv), 'allowlisted credential is projected to the provider process');
  assert.ok(/^UNRELATED_SECRET=$/m.test(childEnv), 'non-allowlisted var resolves empty in the child (it was stripped)');
  assert.ok(!childEnv.includes('do-not-leak'), 'non-allowlisted secret value never reaches the provider env projection');

  // ----------------------------------------------------------------------------
  // 8. Fail-closed through the executor: not enabled, and enabled-but-unavailable.
  // ----------------------------------------------------------------------------
  const disabled = exec(
    plan(codexStep(), { allowedProviders: [], credentialsEnvAllowlist: [] }),
    { PATH: binDir, CODEX_KEY: 'k' },
  );
  assert.equal(disabled.steps[0].status, 'blocked');
  assert.equal(disabled.steps[0].reason, 'disabled', 'codex must be explicitly enabled in providerPolicy.allowedProviders');
  assert.equal(disabled.authorityDone, false);

  const unavailable = exec(
    plan(codexStep(), { allowedProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] }),
    { PATH: emptyBinDir, CODEX_KEY: 'k' },
  );
  assert.equal(unavailable.steps[0].status, 'blocked');
  assert.equal(unavailable.steps[0].reason, 'provider_unavailable', 'codex blocks when the CLI is unavailable on this host');

  // F-181: a provider smoke can itself run under a managed reviewer. Its
  // nested liveness children must remain ordinary CLI fixtures rather than
  // inheriting provider-only direct-evidence restrictions.
  const pollutedLivenessEnvironment = {
    ...process.env,
    LATTICE_MANAGED_HOST_RUN_ID: 'provider-codex-parent-managed-run',
    LATTICE_MANAGED_REVIEW_INVOCATION_FD: '3',
    LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY: 'provider-codex-parent-capability',
    LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD: '4',
    PROOF_OR_STOP_AGENT: 'lattice-review-docs',
    PROOF_OR_STOP_ACTIVITY_ROLE: 'lattice-review-docs',
    LATTICE_REVIEWER_READONLY: '1',
  };
  if (process.argv.includes('--canonical-core')) {
    // Preserve F-181 at a real child CLI mutation boundary without replaying
    // any registered suite. The negative control checks the unsanitized env.
    const fixture = join(work, 'f181-cli'); mkdirSync(fixture);
    writeFileSync(join(fixture, 'proof-or-stop.config.json'), JSON.stringify({storyDir:'.proof-or-stop/story/actives'}));
    const fixtureStore = new StoryStore(fixture);
    const storyId = 'B-f181';
    fixtureStore.writeStory(storyId, {storyId,phase:'INIT',title:'Before independent fixture CLI',createdAt:new Date().toISOString()} as any);
    const probe = join(fixture, 'check-child-environment.mjs');
    const forbidden = ['LATTICE_MANAGED_HOST_RUN_ID','LATTICE_MANAGED_REVIEW_INVOCATION_FD',
      'LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY','LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD',
      'PROOF_OR_STOP_AGENT','PROOF_OR_STOP_ACTIVITY_ROLE','LATTICE_REVIEWER_READONLY'];
    writeFileSync(probe, `import assert from 'node:assert/strict';
for(const key of ${JSON.stringify(forbidden)})assert.equal(process.env[key],undefined,'F181_AMBIENT_AUTHORITY_LEAK '+key);
`);
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const title = 'Independent fixture CLI authority preserved';
    const argv = ['--import',probe,cli,'story_update','--storyId='+storyId,'--title='+title];
    const unsanitized = spawnSync(process.execPath,argv,{cwd:fixture,env:pollutedLivenessEnvironment,encoding:'utf8',timeout:30000});
    assert.notEqual(unsanitized.status,0,'F-181 unsanitized child must be refused');
    assert.match(unsanitized.stderr,/F181_AMBIENT_AUTHORITY_LEAK/);
    assert.equal(fixtureStore.readStory(storyId).title,'Before independent fixture CLI');
    const sanitized = spawnSync(process.execPath,argv,{cwd:fixture,env:agentLivenessSuiteChildEnvironment(pollutedLivenessEnvironment),encoding:'utf8',timeout:30000});
    assert.equal(sanitized.status,0,`${sanitized.stdout}\n${sanitized.stderr}`);
    assert.equal(fixtureStore.readStory(storyId).title,title,'F-181 actual child CLI writes only its own fixture');
    console.log('provider-codex F181 independent child CLI boundary PASS');
  } else runAgentLivenessSuiteForPinnedEvidence(pollutedLivenessEnvironment);
  if (process.argv.includes('--canonical-core')) console.log('provider-codex-smoke: CANONICAL CORE PASS');
  else console.log('✓ provider codex smoke passed: real codexCliAvailable preflight; bounded spawn capture (digest/bytes/exit/duration, no raw transcript leakage); stdin-closed no-hang; non-zero/missing/E2BIG/generic-spawn/timeout classification; end-to-end executor run with redacted env where provider success never equals validation or authority DONE; disabled/unavailable fail closed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
