#!/usr/bin/env node
/**
 * Unattended dispatch smoke — CHK-008
 *
 * Validates the full user-facing unattended dispatch flow:
 *   dispatch_policy_check → host_runtime_probe → dispatch_auto
 *   → dispatch_watch → dispatch_cancel → dispatch_review → dispatch_merge_plan
 *
 * All tests are deterministic (fake host, no real provider calls required).
 * Tests complement dispatch-run-smoke.ts without duplicating every variant.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  StoryInfo,
} from '../core/types.js';
import type {
  DispatchAutoResult,
  DispatchMergePlanResult,
  DispatchRecord,
  DispatchReviewResult,
  DispatchStatusResult,
  DispatchWatchResult,
  HostRuntimeProbe,
} from '../core/lattice-dispatch.js';
import type {
  DispatchPolicy,
  DispatchPolicyCheckResult,
} from '../core/dispatch-policy.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';
import { execFileSync } from 'node:child_process';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
  }, null, 2) + '\n');
}

function writeDispatchPolicy(root: string, policy: DispatchPolicy): void {
  const dir = join(root, '.koala/dispatch-policies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${policy.policy}.json`), JSON.stringify(policy, null, 2) + '\n');
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'packages/main/src/generated'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const smoke = true;\n');
  writeFileSync(join(root, 'README.md'), '# unattended dispatch smoke\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'lattice@example.com']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-03T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'unattended-dispatch-smoke',
    title: 'Unattended dispatch smoke story',
    description: 'Smoke story for unattended dispatch flow.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: `story/${storyId}` }],
  };
  const checklist: ChecklistData = {
    items: [{ id: 'CHK-001', title: 'Unattended flow', status: 'done', startTime: now, endTime: now }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function assertAuthorityFalse(value: unknown, label = 'result'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAuthorityFalse(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['authorityChanged', 'receiptVerified', 'productionDone']) {
    if (key in record) assert.equal(record[key], false, `${label}.${key}`);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (nested && typeof nested === 'object') assertAuthorityFalse(nested, `${label}.${key}`);
  }
}

function readDispatch(root: string, dispatchId: string): DispatchRecord {
  return JSON.parse(
    readFileSync(join(root, '.koala/dispatches', dispatchId, 'dispatch.json'), 'utf8'),
  ) as DispatchRecord;
}

function dispatchCount(root: string): number {
  const dir = join(root, '.koala/dispatches');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(entry => existsSync(join(dir, entry, 'dispatch.json'))).length;
}

function readCommandResults(root: string, record: DispatchRecord): Array<{ command: string; ok: boolean; output: string; timedOut?: boolean }> {
  return JSON.parse(
    readFileSync(join(root, record.collectFile.replace(/collect\.json$/, 'command-results.json')), 'utf8'),
  ) as Array<{ command: string; ok: boolean; output: string; timedOut?: boolean }>;
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'lattice-unattended-smoke-'));
const root = join(sandboxRoot, 'repo', 'root');
try {
  initRepo(root);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store, 'B-unattended');
  seedStory(store, 'B-cancel-test');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const run = <T>(name: string, args: Record<string, unknown> = {}): T => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler({ ...args, json: true }) as T;
  };
  const runText = (name: string, args: Record<string, unknown> = {}): string => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler(args) as string;
  };

  // ── Step 1: Create and check a bounded dispatch policy ──────────────────────

  const policy = run<DispatchPolicy>('dispatch_policy_create', {
    policy: 'unattended-safe',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    maxParallel: 2,
    maxRuntimeMinutes: 30,
    maxBudgetUSD: 5.0,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(0)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(policy.schemaVersion, 'lattice.dispatch_policy.v1');
  assert.equal(policy.policy, 'unattended-safe');
  assert.deepEqual(policy.allowedHosts, ['fake']);
  assert.equal(policy.allowAutoMerge, false, 'policy must not allow auto-merge');
  assert.equal(policy.allowProductionDone, false, 'policy must not allow productionDone');
  assertAuthorityFalse(policy, 'policy');

  const policyCheck = run<DispatchPolicyCheckResult>('dispatch_policy_check', { policy: 'unattended-safe' });
  assert.equal(policyCheck.schemaVersion, 'lattice.dispatch_policy_check.v1');
  assert.equal(policyCheck.authorized, true, 'bounded policy must be authorized');
  assert.equal(policyCheck.status, 'authorized');
  assert.equal(policyCheck.reasons.length, 0, 'authorized policy must have no denial reasons');
  assert.equal(policyCheck.authorityChanged, false);
  assert.equal(policyCheck.receiptVerified, false);
  assert.equal(policyCheck.productionDone, false);
  assertAuthorityFalse(policyCheck, 'policyCheck');

  // ── Step 2: probe claude-code capability ───────────────────────────────────
  // Must work whether or not claude CLI is installed.

  const claudeProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'claude-code' });
  assert.equal(claudeProbe.host, 'claude-code');
  assert.equal(claudeProbe.schemaVersion, 'lattice.host_runtime_probe.v1');
  // Structured capability fields are always present
  assert.ok(
    ['detected', 'unavailable', 'unknown'].includes(claudeProbe.versionStatus),
    `claude versionStatus must be known, got ${claudeProbe.versionStatus}`,
  );
  assert.ok(
    ['supported', 'unverified', 'unsupported'].includes(claudeProbe.noninteractiveSupport),
    `claude noninteractiveSupport must be known, got ${claudeProbe.noninteractiveSupport}`,
  );
  assert.ok(
    ['supported', 'unverified'].includes(claudeProbe.cwdSupport),
    `claude cwdSupport must be known, got ${claudeProbe.cwdSupport}`,
  );
  assert.ok(
    ['supported', 'unverified'].includes(claudeProbe.timeoutSupport),
    `claude timeoutSupport must be known, got ${claudeProbe.timeoutSupport}`,
  );
  assert.ok(
    ['supported', 'unverified'].includes(claudeProbe.transcriptSupport),
    `claude transcriptSupport must be known, got ${claudeProbe.transcriptSupport}`,
  );
  // unattendedSafe must never be true — dispatch_auto policy binding is required first
  assert.equal(claudeProbe.unattendedSafe, false,
    'claude-code must not claim unattendedSafe=true without dispatch_auto policy binding');
  assert.ok(Array.isArray(claudeProbe.unattendedReasons) && claudeProbe.unattendedReasons.length > 0,
    'claude probe must explain why unattendedSafe=false');
  assert.ok(
    claudeProbe.unattendedReasons.some(r => /dispatch_policy|dispatch_auto|policy/i.test(r)),
    'claude unattendedReasons must reference dispatch_policy_check / dispatch_auto policy binding requirement',
  );
  assert.ok(typeof claudeProbe.nextAction === 'string' && claudeProbe.nextAction.length > 0,
    'claude probe must have a nextAction');
  // nextAction must indicate supervised-only or unavailable — not full authorization
  assert.ok(
    /supervised-only|unavailable|policy|install|expose/i.test(claudeProbe.nextAction),
    `claude nextAction must indicate supervised-only or missing CLI, got: ${claudeProbe.nextAction}`,
  );
  assertAuthorityFalse(claudeProbe, 'claudeProbe');

  if (claudeProbe.available) {
    // CLI is installed: must still stay supervised-only until policy binding
    assert.equal(claudeProbe.unattendedSafe, false,
      'installed claude must not be unattendedSafe without dispatch_auto policy binding');
    assert.match(claudeProbe.nextAction, /supervised-only|dispatch_auto|policy/i,
      'installed claude without policy binding must surface supervised-only nextAction');
  } else {
    // CLI missing: explicit unavailable state
    assert.equal(claudeProbe.status, 'unavailable');
    assert.equal(claudeProbe.runtimeKind, 'missing-cli');
    assert.ok(
      claudeProbe.unattendedReasons.some(r => /not available|install|expose|PATH/i.test(r)),
      'unavailable claude must explain CLI is not in PATH',
    );
  }

  // ── Step 3: dispatch_auto with fake policy starts deterministic parallel workers ─

  const autoResult = run<DispatchAutoResult>('dispatch_auto', {
    storyId: 'B-unattended',
    policy: 'fake',
    allowedPaths: ['packages/main/src/generated/unattended-parallel.txt'],
    objective: 'CHK-008 unattended fake parallel flow',
  });
  assert.equal(autoResult.schemaVersion, 'lattice.dispatch_auto.v1',
    'dispatch_auto must return lattice.dispatch_auto.v1 schema');
  assert.equal(autoResult.status, 'accepted_local',
    'authorized fake dispatch_auto must reach accepted_local');
  assert.equal(autoResult.policy, 'fake', 'dispatch_auto result must echo policy name');
  assert.equal(autoResult.host, 'fake', 'dispatch_auto with fake policy must use fake host');
  assertAuthorityFalse(autoResult, 'autoResult');

  // ── Step 4: dispatch_watch reports lifecycle/runner status ────────────────────

  const watchResult = run<DispatchWatchResult>('dispatch_watch', { dispatchId: autoResult.dispatchId });
  assert.equal(watchResult.schemaVersion, 'lattice.dispatch_watch.v1',
    'dispatch_watch must return lattice.dispatch_watch.v1 schema');
  assert.equal(watchResult.dispatchId, autoResult.dispatchId,
    'dispatch_watch dispatchId must match');
  assert.equal(watchResult.storyId, 'B-unattended',
    'dispatch_watch storyId must match');
  assert.equal(watchResult.status, 'accepted_local',
    'dispatch_watch must report accepted_local after dispatch_auto');
  assert.ok(watchResult.runnerSummary !== undefined,
    'dispatch_watch must include runnerSummary after fake run');
  assert.equal(watchResult.runnerSummary!.runnerKind, 'fake',
    'dispatch_watch runnerSummary.runnerKind must be fake');
  assert.ok(typeof watchResult.nextAction === 'string' && watchResult.nextAction.length > 0,
    'dispatch_watch must have nextAction');
  assertAuthorityFalse(watchResult, 'watchResult');

  const watchText = runText('dispatch_watch', { dispatchId: autoResult.dispatchId });
  assert.match(watchText, /lattice\.dispatch_watch\.v1/, 'dispatch_watch text must include schema version');
  assert.match(watchText, /status: accepted_local/, 'dispatch_watch text must show status');

  // ── Step 5: dispatch_cancel on a prepared dispatch preserves evidence ────────
  // Use dispatch_prepare (prepared state) instead of a completed auto,
  // because fake dispatch_auto completes synchronously.

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-cancel-test',
    dispatchId: 'D-unattended-cancel',
    host: 'fake',
    objective: 'CHK-008 cancel preserves evidence',
    allowedPaths: ['packages/main/src/generated/unattended-cancel.txt'],
  });
  const beforeCancel = readDispatch(root, 'D-unattended-cancel');
  assert.equal(beforeCancel.status, 'prepared');

  run('dispatch_cancel', { dispatchId: 'D-unattended-cancel' });
  const cancelledRecord = readDispatch(root, 'D-unattended-cancel');
  assert.equal(cancelledRecord.status, 'cancelled', 'dispatch_cancel must move status to cancelled');

  // Evidence files (pack, prompt, dispatch.json) must survive cancel
  assert.ok(existsSync(join(root, cancelledRecord.packFile)), 'pack.json must survive cancel');
  assert.ok(existsSync(join(root, cancelledRecord.promptFile)), 'prompt.md must survive cancel');
  assert.ok(existsSync(join(root, cancelledRecord.statusFile)), 'dispatch.json must survive cancel');

  // dispatch_watch reports cancelled with nextAction
  const watchCancelled = run<DispatchWatchResult>('dispatch_watch', { dispatchId: 'D-unattended-cancel' });
  assert.equal(watchCancelled.status, 'cancelled',
    'dispatch_watch must report cancelled after dispatch_cancel');
  assert.ok(typeof watchCancelled.nextAction === 'string' && watchCancelled.nextAction.length > 0,
    'dispatch_watch cancelled must have nextAction');
  assertAuthorityFalse(watchCancelled, 'watchCancelled');

  // ── Step 6: dispatch_review surfaces transcript/diff/receipt/runner evidence ──

  const reviewResult = run<DispatchReviewResult>('dispatch_review', { dispatchId: autoResult.dispatchId });
  // transcript path and existence
  assert.ok(typeof reviewResult.transcriptPath === 'string' && reviewResult.transcriptPath.length > 0,
    'dispatch_review must surface transcriptPath');
  assert.equal(reviewResult.transcriptExists, true,
    'dispatch_review transcriptExists must be true for completed fake dispatch');
  // runner summary
  assert.ok(reviewResult.runnerSummary !== undefined,
    'dispatch_review must include runnerSummary for completed fake dispatch');
  assert.equal(reviewResult.runnerSummary!.runnerKind, 'fake',
    'dispatch_review runnerSummary.runnerKind must be fake');
  assert.equal(reviewResult.runnerSummary!.exitCode, 0,
    'dispatch_review runnerSummary.exitCode must be 0 for successful fake dispatch');
  assert.equal(reviewResult.runnerSummary!.timedOut, false,
    'dispatch_review runnerSummary.timedOut must be false');
  // changedFiles from git (not host prose)
  assert.ok(reviewResult.changedFiles.length > 0,
    'dispatch_review must surface changedFiles derived from git');
  // local receipt status — not production authority
  assert.equal(reviewResult.localReceiptStatus, 'accepted-local',
    'dispatch_review localReceiptStatus must be accepted-local for accepted dispatch');
  // manual nextAction (not auto-executable)
  assert.ok(typeof reviewResult.nextAction === 'string' && reviewResult.nextAction.length > 0,
    'dispatch_review must have a nextAction guiding manual merge');
  assertAuthorityFalse(reviewResult, 'reviewResult');

  const reviewText = runText('dispatch_review', { dispatchId: autoResult.dispatchId });
  assert.match(reviewText, /transcriptPath:/i, 'dispatch_review text must show transcriptPath');
  assert.match(reviewText, /transcriptExists: true/, 'dispatch_review text must show transcriptExists');
  assert.match(reviewText, /localReceiptStatus: accepted-local/, 'dispatch_review text must show localReceiptStatus');
  assert.match(reviewText, /runnerKind: fake/, 'dispatch_review text must show runner section');

  // ── Step 7: dispatch_merge_plan is manualOnly=true ─────────────────────────

  const mergePlan = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: autoResult.dispatchId });
  assert.equal(mergePlan.manualOnly, true,
    'dispatch_merge_plan must always be manualOnly=true — unattended completion is not production authority');
  assert.ok(mergePlan.commands.every(cmd => !/\bgit\s+(merge|cherry-pick)\b/.test(cmd)),
    'dispatch_merge_plan commands must not contain git merge or cherry-pick');
  assert.ok(mergePlan.warnings.some(w => /manual merge only/i.test(w)),
    'dispatch_merge_plan must warn that merge is manual-only');
  assertAuthorityFalse(mergePlan, 'mergePlan');

  // ── Step 8: Refusal cases ──────────────────────────────────────────────────

  // 8a: missing policy → explicit refusal
  assert.throws(
    () => run('dispatch_auto', {
      storyId: 'B-unattended',
      allowedPaths: ['packages/main/src/generated/auto-no-policy.txt'],
    }),
    /requires a policy name/i,
    'dispatch_auto without policy must refuse with a clear message',
  );

  // 8b: policy not found → explicit refusal (not pretend execution)
  assert.throws(
    () => run('dispatch_auto', {
      storyId: 'B-unattended',
      policy: 'nonexistent-xyz',
      allowedPaths: ['packages/main/src/generated/auto-missing-policy.txt'],
    }),
    /could not be loaded|policy not found/i,
    'dispatch_auto with unknown policy must refuse explicitly',
  );

  // 8c: real host unavailable → explicit refusal, no dispatch record created
  {
    const realPolicy = run<{ policy: string }>('dispatch_policy_create', {
      policy: 'chk008-real-only',
      allowedHosts: ['gemini'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 2,
      maxRuntimeMinutes: 30,
      maxBudgetUSD: 5.0,
      network: 'restricted',
      commandAllowlist: ['node -e "process.exit(0)"'],
    });
    assert.equal(realPolicy.policy, 'chk008-real-only');

    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      assert.throws(
        () => run('dispatch_auto', {
          storyId: 'B-unattended',
          policy: 'chk008-real-only',
          host: 'gemini',
          allowedPaths: ['packages/main/src/generated/chk008-gemini.txt'],
          objective: 'CHK-008 unavailable host refusal',
        }),
        /not available|not unattended-safe|unattendedSafe=false/i,
        'dispatch_auto must refuse unavailable real host with an explicit message',
      );
    } finally {
      process.env.PATH = savedPath;
    }

    // 8d: real host available but unattendedSafe=false → refusal even when CLI present
    assert.throws(
      () => run('dispatch_auto', {
        storyId: 'B-unattended',
        policy: 'chk008-real-only',
        host: 'gemini',
        allowedPaths: ['packages/main/src/generated/chk008-gemini-available.txt'],
        objective: 'CHK-008 unattendedSafe=false refusal',
      }),
      /not unattended-safe|unattendedSafe=false|not available/i,
      'dispatch_auto must refuse real host with unattendedSafe=false even if CLI is present',
    );
  }

  // ── Step 9: CHK-008 edge coverage ──────────────────────────────────────────

  const exitZeroCommand = 'node -e "process.exit(0)"';

  // 9a: allowedPaths override outside policy refuses before dispatch artifacts
  {
    run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'chk008-scope-boundary',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/policy-safe.txt'],
      maxParallel: 2,
      maxRuntimeMinutes: 30,
      maxBudgetUSD: 5.0,
      network: 'none',
      commandAllowlist: [exitZeroCommand],
    });
    const before = dispatchCount(root);
    assert.throws(
      () => run('dispatch_auto', {
        storyId: 'B-unattended',
        policy: 'chk008-scope-boundary',
        allowedPaths: ['README.md'],
        objective: 'CHK-008 unsafe path override must refuse',
      }),
      /policy scope|outside policy/i,
      'dispatch_auto must refuse allowedPaths outside policy before execution',
    );
    assert.equal(dispatchCount(root), before,
      'unsafe allowedPaths override must not create dispatch records');
  }

  // 9b: requiredCommand outside commandAllowlist refuses before command execution
  {
    const disallowedCommand =
      'node -e "require(\'fs\').writeFileSync(\'packages/main/src/generated/disallowed-command-ran.txt\', \'ran\')"';
    run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'chk008-command-boundary',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/command-boundary.txt'],
      maxParallel: 2,
      maxRuntimeMinutes: 30,
      maxBudgetUSD: 5.0,
      network: 'none',
      commandAllowlist: [exitZeroCommand],
    });
    const before = dispatchCount(root);
    assert.throws(
      () => run('dispatch_auto', {
        storyId: 'B-unattended',
        policy: 'chk008-command-boundary',
        allowedPaths: ['packages/main/src/generated/command-boundary.txt'],
        requiredCommands: [disallowedCommand],
        objective: 'CHK-008 disallowed command must refuse',
      }),
      /commandAllowlist|not in policy/i,
      'dispatch_auto must refuse commands outside policy.commandAllowlist before execution',
    );
    assert.equal(dispatchCount(root), before,
      'disallowed requiredCommand must not create dispatch records');
    assert.equal(existsSync(join(root, 'packages/main/src/generated/disallowed-command-ran.txt')), false,
      'disallowed requiredCommand must not run side effects');
  }

  // 9c: fake required commands run with filtered env and cannot read denied secrets
  {
    const secretValue = 'super-secret-value-that-must-not-leak';
    const savedSecret = process.env.KOALA_DENIED_SECRET;
    const leakProbeCommand =
      'node -e "if (process.env.KOALA_DENIED_SECRET) { console.error(process.env.KOALA_DENIED_SECRET); process.exit(2); } console.log(\'secret absent\')"';
    try {
      process.env.KOALA_DENIED_SECRET = secretValue;
      run<DispatchPolicy>('dispatch_policy_create', {
        policy: 'chk008-env-filter',
        allowedHosts: ['fake'],
        allowedPaths: ['packages/main/src/generated/env-filter.txt'],
        maxParallel: 2,
        maxRuntimeMinutes: 1,
        maxBudgetUSD: 5.0,
        network: 'none',
        envDenylist: ['KOALA_DENIED_SECRET'],
        commandAllowlist: [leakProbeCommand],
      });
      const envResult = run<DispatchAutoResult>('dispatch_auto', {
        storyId: 'B-unattended',
        policy: 'chk008-env-filter',
        allowedPaths: ['packages/main/src/generated/env-filter.txt'],
        requiredCommands: [leakProbeCommand],
        objective: 'CHK-008 denied env must not leak',
      });
      assert.equal(envResult.status, 'accepted_local',
        'denied secret env probe must pass when the secret is filtered out');
      const envRecord = readDispatch(root, envResult.dispatchId);
      const envCommands = readCommandResults(root, envRecord);
      assert.equal(envCommands[0].ok, true, 'env leak probe command must succeed');
      assert.match(envCommands[0].output, /secret absent/, 'env leak probe must observe missing secret');
      assert.doesNotMatch(envCommands[0].output, /super-secret-value-that-must-not-leak/,
        'command result output must not contain denied secret value');
      const envStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: envResult.dispatchId });
      assert.equal(envStatus.runner?.envSummary.safeVarNames.includes('KOALA_DENIED_SECRET'), false,
        'runner env summary must not list denied secret env var');
    } finally {
      if (savedSecret === undefined) delete process.env.KOALA_DENIED_SECRET;
      else process.env.KOALA_DENIED_SECRET = savedSecret;
    }
  }

  // 9d: maxRuntimeMinutes is enforced as a per-command timeout
  {
    const timeoutCommand = 'node -e "setTimeout(function () {}, 200)"';
    writeDispatchPolicy(root, {
      schemaVersion: 'lattice.dispatch_policy.v1',
      policy: 'chk008-timeout',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/timeout.txt'],
      deniedPaths: [],
      maxParallel: 2,
      maxRuntimeMinutes: 0.001,
      maxBudgetUSD: 5.0,
      network: 'none',
      envAllowlist: [],
      envDenylist: [],
      commandAllowlist: [timeoutCommand],
      retryLimit: 0,
      requireReceipt: true,
      requireReview: true,
      allowAutoMerge: false,
      allowProductionDone: false,
      createdAt: '2026-06-03T00:00:00.000Z',
    });
    const timeoutResult = run<DispatchAutoResult>('dispatch_auto', {
      storyId: 'B-unattended',
      policy: 'chk008-timeout',
      allowedPaths: ['packages/main/src/generated/timeout.txt'],
      requiredCommands: [timeoutCommand],
      objective: 'CHK-008 timeout command path',
    });
    assert.equal(timeoutResult.status, 'failed',
      'timeout command must leave fake dispatch in failed lifecycle status');
    const timeoutRecord = readDispatch(root, timeoutResult.dispatchId);
    const timeoutCommands = readCommandResults(root, timeoutRecord);
    assert.equal(timeoutCommands[0].timedOut, true,
      'command-results must mark timedOut=true');
    assert.match(timeoutCommands[0].output, /timed out after/i,
      'command-results output must surface timeout detail');
    const timeoutStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: timeoutResult.dispatchId });
    assert.equal(timeoutStatus.runner?.timedOut, true,
      'runner record must surface timedOut=true for dispatch_watch/review');
  }

  // 9e: missing receipt review/merge diagnostics are asserted directly
  {
    run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-unattended',
      dispatchId: 'D-chk008-missing-receipt',
      host: 'fake',
      objective: 'CHK-008 missing receipt diagnostics',
      allowedPaths: ['packages/main/src/generated/missing-receipt.txt'],
    });
    const missingReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-chk008-missing-receipt' });
    assert.equal(missingReview.localReceiptStatus, 'missing',
      'dispatch_review must report missing local receipt for prepared-only dispatch');
    assert.ok(missingReview.risks.some(risk => /receipt.*missing/i.test(risk)),
      'dispatch_review must include missing receipt risk');
    const missingMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-chk008-missing-receipt' });
    assert.equal(missingMerge.mergeable, false,
      'dispatch_merge_plan must refuse merge guidance for missing receipt');
  }

  // 9f: mixed worker outcomes are surfaced by review and merge diagnostics
  {
    const mixedCommand =
      'node -e "const fs=require(\'fs\'); process.exit(fs.existsSync(\'packages/main/src/generated/mixed-2.txt\') ? 1 : 0)"';
    run<DispatchPolicy>('dispatch_policy_create', {
      policy: 'chk008-mixed-workers',
      allowedHosts: ['fake'],
      allowedPaths: ['packages/main/src/generated/'],
      maxParallel: 2,
      maxRuntimeMinutes: 1,
      maxBudgetUSD: 5.0,
      network: 'none',
      commandAllowlist: [mixedCommand],
    });
    const mixedResult = run<DispatchAutoResult>('dispatch_auto', {
      storyId: 'B-unattended',
      policy: 'chk008-mixed-workers',
      allowedPaths: [
        'packages/main/src/generated/mixed-1.txt',
        'packages/main/src/generated/mixed-2.txt',
      ],
      requiredCommands: [mixedCommand],
      parallel: 2,
      objective: 'CHK-008 mixed worker outcome diagnostics',
    });
    assert.equal(mixedResult.status, 'diagnostic',
      'parallel dispatch with mixed worker statuses must aggregate to diagnostic');
    assert.deepEqual(
      mixedResult.workers.map(worker => worker.status).sort(),
      ['accepted_local', 'failed'],
      'mixed worker smoke must produce one accepted_local worker and one failed worker',
    );
    const mixedReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: mixedResult.dispatchId });
    assert.equal(mixedReview.localReceiptStatus, 'diagnostic',
      'dispatch_review must surface diagnostic localReceiptStatus for mixed workers');
    assert.equal(mixedReview.workers.length, 2,
      'dispatch_review must include both workers for mixed outcome diagnostics');
    assert.ok(mixedReview.workers.some(worker => worker.status === 'failed'),
      'dispatch_review worker diagnostics must include the failed worker');
    const mixedMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: mixedResult.dispatchId });
    assert.equal(mixedMerge.mergeable, false,
      'dispatch_merge_plan must withhold merge guidance for mixed worker outcomes');
  }

  // ── Step 10: All authority flags remain false throughout ───────────────────

  // Explicitly re-verify the three authority fields on each major surface
  {
    const autoAuth = run<DispatchAutoResult>('dispatch_auto', {
      storyId: 'B-unattended',
      policy: 'fake',
      allowedPaths: ['packages/main/src/generated/chk008-auth.txt'],
      objective: 'CHK-008 authority invariant',
    });
    assert.equal(autoAuth.authorityChanged, false, 'dispatch_auto.authorityChanged must be false');
    assert.equal(autoAuth.receiptVerified, false, 'dispatch_auto.receiptVerified must be false');
    assert.equal(autoAuth.productionDone, false, 'dispatch_auto.productionDone must be false');

    const watchAuth = run<DispatchWatchResult>('dispatch_watch', { dispatchId: autoAuth.dispatchId });
    assert.equal(watchAuth.authorityChanged, false, 'dispatch_watch.authorityChanged must be false');
    assert.equal(watchAuth.receiptVerified, false, 'dispatch_watch.receiptVerified must be false');
    assert.equal(watchAuth.productionDone, false, 'dispatch_watch.productionDone must be false');

    const reviewAuth = run<DispatchReviewResult>('dispatch_review', { dispatchId: autoAuth.dispatchId });
    assert.equal(reviewAuth.authorityChanged, false, 'dispatch_review.authorityChanged must be false');
    assert.equal(reviewAuth.receiptVerified, false, 'dispatch_review.receiptVerified must be false');
    assert.equal(reviewAuth.productionDone, false, 'dispatch_review.productionDone must be false');

    const mergeAuth = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: autoAuth.dispatchId });
    assert.equal(mergeAuth.manualOnly, true, 'dispatch_merge_plan.manualOnly must always be true');
    assert.equal(mergeAuth.authorityChanged, false, 'dispatch_merge_plan.authorityChanged must be false');
    assert.equal(mergeAuth.receiptVerified, false, 'dispatch_merge_plan.receiptVerified must be false');
    assert.equal(mergeAuth.productionDone, false, 'dispatch_merge_plan.productionDone must be false');
  }

  // ── Step 11: overflow_auto nextAction references dispatch_auto ─────────────

  const overflowResult = run<{ nextAction?: string; schemaVersion: string }>('overflow_auto', {
    storyId: 'B-unattended',
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/chk008-overflow.txt'],
  });
  assert.ok(
    typeof overflowResult.nextAction === 'string' && /dispatch_auto/i.test(overflowResult.nextAction),
    `overflow_auto nextAction must reference dispatch_auto as the policy-authorized unattended path, got: ${overflowResult.nextAction}`,
  );

  console.log('✓ unattended-dispatch-smoke passed — policy check, claude-code capability probe, fake parallel dispatch_auto, dispatch_watch lifecycle, dispatch_cancel evidence preservation, dispatch_review transcript/runner evidence, dispatch_merge_plan manualOnly, refusal for missing policy / unavailable / unattendedUnsafe host / out-of-policy scope / out-of-policy command, denied env filtering, timeout, missing receipt, mixed worker diagnostics, authority invariants, and overflow_auto→dispatch_auto migration guidance verified');
} finally {
  resetConfigCache();
  rmSync(sandboxRoot, { recursive: true, force: true });
}
