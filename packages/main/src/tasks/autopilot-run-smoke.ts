#!/usr/bin/env node
/**
 * Autopilot run smoke -- B-47cd test/docs lane.
 *
 * Forward contract for the unattended host-to-host autopilot surfaces:
 *   autopilot_policy_create -> autopilot_policy_check -> autopilot_run
 *   -> autopilot_status/watch/review/cancel/resume
 *
 * Tests are deterministic and use the fake host / fake authority boundary.
 * No real provider calls are required.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import { PROCESS_FACT_LEVEL_BY_NAME } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  StoryInfo,
} from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const EXPECTED_COMMANDS = [
  'autopilot_policy_create',
  'autopilot_policy_check',
  'autopilot_run',
  'autopilot_status',
  'autopilot_watch',
  'autopilot_review',
  'autopilot_cancel',
  'autopilot_resume',
] as const;

const READ_ONLY_EXPECTED = new Set([
  'autopilot_policy_check',
  'autopilot_status',
  'autopilot_watch',
  'autopilot_review',
]);

type AutopilotMode = 'conservative' | 'authority-verified' | 'full-autopilot';

interface AuthorityBoundary {
  authorityChanged?: boolean;
  receiptVerified?: boolean;
  productionDone?: boolean;
  canClaimProductionDone?: boolean;
}

interface AutopilotPolicy extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_policy.v1';
  policy: string;
  dispatchPolicy: string;
  mode: AutopilotMode;
  allowAutoDispatch: boolean;
  allowAutoValidate: boolean;
  allowAutoFix: boolean;
  allowStoryIntegration: boolean;
  allowDoneAdvance: boolean;
  allowMainMerge: boolean;
  requireServerReceipt: boolean;
  maxIterations: number;
  maxRuntimeMinutes?: number;
  maxBudgetUSD?: number;
  stopOnConflict: boolean;
  stopOnScopeViolation: boolean;
}

interface AutopilotPolicyCheckResult extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_policy_check.v1';
  policy: string;
  mode: AutopilotMode;
  status: 'authorized' | 'refused' | 'supervised';
  authorized: boolean;
  reasons: string[];
  nextAction?: string;
}

interface AutopilotRunResult extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_run.v1';
  runId: string;
  storyId: string;
  mode: AutopilotMode;
  policy: string;
  dispatchPolicy?: string;
  host?: string;
  dispatchId?: string;
  status: 'created' | 'running' | 'needs_receipt' | 'manual_review_ready' | 'missing_authority_receipt' | 'cancelled' | 'failed';
  maxIterations: number;
  maxBudgetUSD?: number;
  stopReason?: string;
  stopDetails?: string;
  iterations: Array<{
    index: number;
    status: string;
    stopReason?: string;
    dispatchId?: string;
  }>;
  errors?: string[];
  delegation?: {
    hostNative: true;
    receiptRequired: true;
    transcriptRequired: true;
    nextAction: string;
  };
  authorityReceiptGate: {
    required: boolean;
    present: boolean;
    verified: boolean;
    source: string;
  };
  mergeDecision?: {
    manualOnly: true;
    mergeable: boolean;
    nextAction: string;
  };
  dispatch?: {
    auto?: unknown;
    watch?: unknown;
    review?: unknown;
    mergePlan?: unknown;
  };
  nextAction?: string;
}

interface AutopilotStatusResult extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_run.v1' | 'lattice.autopilot_watch.v1' | 'lattice.autopilot_review.v1';
  runId: string;
  storyId: string;
  mode: AutopilotMode;
  status: string;
  mergeDecision?: {
    manualOnly: true;
  };
  nextAction?: string;
}

interface AutopilotCancelResult extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_cancel.v1';
  runId: string;
  storyId?: string;
  status: 'cancelled';
  dispatchId?: string;
  nextAction?: string;
  record: AutopilotRunResult;
}

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

function initRepo(root: string): void {
  mkdirSync(join(root, 'packages/main/src/generated'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const smoke = true;\n');
  writeFileSync(join(root, 'README.md'), '# autopilot run smoke\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'lattice@example.com']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-04T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'autopilot-run-smoke',
    title: 'Autopilot run smoke story',
    description: 'Smoke story for Lattice unattended host-to-host autopilot execution modes.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: `story/${storyId}` }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Autopilot flow',
        status: 'done',
        startTime: now,
        endTime: now,
      },
    ],
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

function assertNoProductionOverclaim(value: unknown, label = 'result'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProductionOverclaim(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['authorityChanged', 'productionDone', 'canClaimProductionDone']) {
    if (key in record) assert.equal(record[key], false, `${label}.${key}`);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (nested && typeof nested === 'object') assertNoProductionOverclaim(nested, `${label}.${key}`);
  }
}

function assertFiveWayRegistration(command: string, registry: ReturnType<typeof createMainRegistry>): void {
  const policyByName = COMMAND_POLICIES as Record<string, { ownershipClass: string } | undefined>;
  const factByName = PROCESS_FACT_LEVEL_BY_NAME as Record<string, unknown>;

  // TODO(B-47cd core lane): keep these intended public command names aligned
  // with CLI/handler/registry/process-fact wiring when autopilot core lands.
  assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `${command} missing MAIN_TOOLS entry`);
  assert.equal(registry.has(command), true, `${command} missing registry handler`);
  assert.ok(policyByName[command], `${command} missing command policy`);
  assert.ok(factByName[command], `${command} missing process fact level`);
  if (READ_ONLY_EXPECTED.has(command)) {
    assert.equal(policyByName[command]?.ownershipClass, 'readOnly', `${command} should stay read-only`);
  }
}

function runCliJson<T>(root: string, args: string[], env: Record<string, string | undefined> = {}): T {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  return JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })) as T;
}

function runCliFailure(root: string, args: string[], env: Record<string, string | undefined> = {}): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  try {
    execFileSync(process.execPath, [
      cliPath,
      '--root',
      root,
      ...args,
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
  } catch (error) {
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return `${String(failed.stdout ?? '')}\n${String(failed.stderr ?? '')}`;
  }
  assert.fail(`expected CLI failure for: ${args.join(' ')}`);
}

function assertCliRejectsUnknownFlag(root: string, args: string[], flag: string, env: Record<string, string | undefined> = {}): void {
  const output = runCliFailure(root, args, env);
  assert.match(output, new RegExp(flag, 'i'), `CLI error should mention rejected flag ${flag}`);
  assert.match(output, /unrecognized|unknown|unsupported/i, 'CLI error should reject the unknown flag before core handling');
}

function assertNoCliMetaLeak(result: unknown, label: string): void {
  if (Array.isArray(result)) {
    result.forEach((entry, index) => assertNoCliMetaLeak(entry, `${label}[${index}]`));
    return;
  }
  if (!result || typeof result !== 'object') return;
  const record = result as Record<string, unknown>;
  assert.equal(record.takeover, undefined, `${label} must not expose takeover in JSON output`);
  assert.equal(record.forceTakeover, undefined, `${label} must not expose forceTakeover in JSON output`);
  for (const [key, nested] of Object.entries(record)) {
    if (nested && typeof nested === 'object') assertNoCliMetaLeak(nested, `${label}.${key}`);
  }
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'lattice-autopilot-run-suite-'));
const root = join(sandboxRoot, 'repo', 'root');

try {
  initRepo(root);
  resetConfigCache();

  const store = new StoryStore(root);
  seedStory(store, 'B-demo');
  seedStory(store, 'B-retry-demo');
  seedStory(store, 'B-budget-retry-demo');
  seedStory(store, 'B-conflict-demo');
  seedStory(store, 'B-cancel-demo');
  seedStory(store, 'B-owner-gate-cancel-demo');
  seedStory(store, 'B-owner-gate-resume-demo');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const run = <T>(name: string, args: Record<string, unknown> = {}): T => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler({ ...args, json: true }) as T;
  };

  for (const command of EXPECTED_COMMANDS) assertFiveWayRegistration(command, registry);

  const dispatchPolicy = run<Record<string, unknown>>('dispatch_policy_create', {
    policy: 'fake-dispatch',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 2,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(0)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(dispatchPolicy.schemaVersion, 'lattice.dispatch_policy.v1');
  assertAuthorityFalse(dispatchPolicy, 'dispatchPolicy');

  const authorityDispatchPolicy = run<Record<string, unknown>>('dispatch_policy_create', {
    policy: 'fake-authority-dispatch',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 1,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(0)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(authorityDispatchPolicy.schemaVersion, 'lattice.dispatch_policy.v1');
  assertAuthorityFalse(authorityDispatchPolicy, 'authorityDispatchPolicy');

  const fullDispatchPolicy = run<Record<string, unknown>>('dispatch_policy_create', {
    policy: 'fake-full-dispatch',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 1,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(0)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(fullDispatchPolicy.schemaVersion, 'lattice.dispatch_policy.v1');
  assertAuthorityFalse(fullDispatchPolicy, 'fullDispatchPolicy');

  const retryDispatchPolicy = run<Record<string, unknown>>('dispatch_policy_create', {
    policy: 'fake-retry-dispatch',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 1,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(1)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(retryDispatchPolicy.schemaVersion, 'lattice.dispatch_policy.v1');
  assertAuthorityFalse(retryDispatchPolicy, 'retryDispatchPolicy');

  const unmeasuredBudgetDispatchPolicy = run<Record<string, unknown>>('dispatch_policy_create', {
    policy: 'unmeasured-spend-dispatch',
    allowedHosts: ['claude-code'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 1,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(1)"'],
    requireReceipt: true,
    requireReview: true,
    allowRealHostSubprocess: false,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(unmeasuredBudgetDispatchPolicy.schemaVersion, 'lattice.dispatch_policy.v1');
  assertAuthorityFalse(unmeasuredBudgetDispatchPolicy, 'unmeasuredBudgetDispatchPolicy');

  const conflictDispatchPolicy = run<Record<string, unknown>>('dispatch_policy_create', {
    policy: 'fake-conflict-dispatch',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 1,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(0)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(conflictDispatchPolicy.schemaVersion, 'lattice.dispatch_policy.v1');
  assertAuthorityFalse(conflictDispatchPolicy, 'conflictDispatchPolicy');

  const policy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake',
    dispatchPolicy: 'fake-dispatch',
    mode: 'conservative',
    allowAutoDispatch: true,
    allowAutoValidate: true,
    allowAutoFix: false,
    allowStoryIntegration: false,
    allowDoneAdvance: false,
    allowMainMerge: false,
    requireServerReceipt: false,
    maxIterations: 1,
    maxRuntimeMinutes: 10,
    stopOnConflict: true,
    stopOnScopeViolation: true,
  });
  assert.equal(policy.schemaVersion, 'lattice.autopilot_policy.v1');
  assert.equal(policy.policy, 'fake');
  assert.equal(policy.dispatchPolicy, 'fake-dispatch');
  assert.equal(policy.mode, 'conservative');
  assert.equal(policy.allowMainMerge, false);
  assert.equal(policy.requireServerReceipt, false);
  assertAuthorityFalse(policy, 'policy');

  const authorityPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-authority',
    dispatchPolicy: 'fake-authority-dispatch',
    mode: 'authority-verified',
    allowAutoDispatch: true,
    allowAutoValidate: true,
    allowAutoFix: true,
    allowStoryIntegration: false,
    allowDoneAdvance: false,
    allowMainMerge: false,
    requireServerReceipt: true,
    maxIterations: 1,
    maxRuntimeMinutes: 10,
    stopOnConflict: true,
    stopOnScopeViolation: true,
  });
  assert.equal(authorityPolicy.policy, 'fake-authority');
  assert.equal(authorityPolicy.dispatchPolicy, 'fake-authority-dispatch');
  assert.equal(authorityPolicy.requireServerReceipt, true);
  assertAuthorityFalse(authorityPolicy, 'authorityPolicy');

  const fullPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-full',
    dispatchPolicy: 'fake-full-dispatch',
    mode: 'full-autopilot',
    allowAutoDispatch: true,
    allowAutoValidate: true,
    allowAutoFix: true,
    allowStoryIntegration: false,
    allowDoneAdvance: false,
    allowMainMerge: false,
    requireServerReceipt: true,
    maxIterations: 2,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    stopOnConflict: true,
    stopOnScopeViolation: true,
  });
  assert.equal(fullPolicy.mode, 'full-autopilot');
  assert.equal(fullPolicy.dispatchPolicy, 'fake-full-dispatch');
  assert.equal(fullPolicy.maxIterations, 2);
  assertAuthorityFalse(fullPolicy, 'fullPolicy');

  const budgetRetryPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-retry-budget',
    dispatchPolicy: 'unmeasured-spend-dispatch',
    mode: 'full-autopilot',
    allowAutoDispatch: true,
    allowAutoValidate: true,
    allowAutoFix: true,
    allowStoryIntegration: false,
    allowDoneAdvance: false,
    allowMainMerge: false,
    requireServerReceipt: true,
    maxIterations: 2,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    stopOnConflict: true,
    stopOnScopeViolation: true,
  });
  assert.equal(budgetRetryPolicy.mode, 'full-autopilot');
  assert.equal(budgetRetryPolicy.dispatchPolicy, 'unmeasured-spend-dispatch');
  assert.equal(budgetRetryPolicy.maxBudgetUSD, 5);
  assertAuthorityFalse(budgetRetryPolicy, 'budgetRetryPolicy');

  const retryPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-retry',
    dispatchPolicy: 'fake-retry-dispatch',
    mode: 'full-autopilot',
    allowAutoDispatch: true,
    allowAutoValidate: true,
    allowAutoFix: true,
    allowStoryIntegration: false,
    allowDoneAdvance: false,
    allowMainMerge: false,
    requireServerReceipt: true,
    maxIterations: 2,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    stopOnConflict: true,
    stopOnScopeViolation: true,
  });
  assert.equal(retryPolicy.mode, 'full-autopilot');
  assert.equal(retryPolicy.dispatchPolicy, 'fake-retry-dispatch');
  assert.equal(retryPolicy.maxBudgetUSD, 5);
  assertAuthorityFalse(retryPolicy, 'retryPolicy');

  const conflictPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-conflict',
    dispatchPolicy: 'fake-conflict-dispatch',
    mode: 'conservative',
    allowAutoDispatch: true,
    allowAutoValidate: true,
    allowAutoFix: false,
    allowStoryIntegration: false,
    allowDoneAdvance: false,
    allowMainMerge: false,
    requireServerReceipt: false,
    maxIterations: 1,
    maxRuntimeMinutes: 10,
    stopOnConflict: true,
    stopOnScopeViolation: true,
  });
  assert.equal(conflictPolicy.mode, 'conservative');
  assert.equal(conflictPolicy.dispatchPolicy, 'fake-conflict-dispatch');
  assertAuthorityFalse(conflictPolicy, 'conflictPolicy');

  assert.throws(
    () => run<AutopilotPolicy>('autopilot_policy_create', {
      policy: 'bad-full-missing-bounds',
      dispatchPolicy: 'fake-full-dispatch',
      mode: 'full-autopilot',
      allowAutoDispatch: true,
      allowAutoValidate: true,
      allowAutoFix: true,
      requireServerReceipt: true,
      stopOnConflict: true,
      stopOnScopeViolation: true,
    }),
    /full-autopilot requires bounded maxIterations|full-autopilot requires bounded maxRuntimeMinutes/,
    'unbounded full-autopilot policy must be refused',
  );

  assert.throws(
    () => run<AutopilotPolicy>('autopilot_policy_create', {
      policy: 'bad-full-stop-flags',
      dispatchPolicy: 'fake-full-dispatch',
      mode: 'full-autopilot',
      allowAutoDispatch: true,
      allowAutoValidate: true,
      allowAutoFix: true,
      requireServerReceipt: true,
      maxIterations: 2,
      maxRuntimeMinutes: 10,
      maxBudgetUSD: 5,
      stopOnConflict: false,
      stopOnScopeViolation: false,
    }),
    /full-autopilot requires stopOnConflict=true|full-autopilot requires stopOnScopeViolation=true/,
    'full-autopilot policy must require conflict/scope stop flags',
  );

  assert.throws(
    () => run<AutopilotPolicy>('autopilot_policy_create', {
      policy: 'bad-unsupported-autopilot-field',
      dispatchPolicy: 'fake-dispatch',
      mode: 'conservative',
      allowedHosts: ['fake'],
    }),
    /unsupported autopilot policy field "allowedHosts"/,
    'autopilot policy must not silently drop host/path/command restrictions',
  );

  const policyCheck = run<AutopilotPolicyCheckResult>('autopilot_policy_check', {
    policy: 'fake',
  });
  assert.equal(policyCheck.schemaVersion, 'lattice.autopilot_policy_check.v1');
  assert.equal(policyCheck.status, 'authorized');
  assert.equal(policyCheck.authorized, true);
  assert.deepEqual(policyCheck.reasons, []);
  assertAuthorityFalse(policyCheck, 'policyCheck');

  const cliFlatCreate = runCliJson<AutopilotPolicy>(root, [
    'autopilot_policy_create',
    '--policy=cli-flat',
    '--dispatchPolicy=fake-dispatch',
    '--mode=conservative',
    '--allowAutoDispatch=true',
    '--allowAutoValidate=true',
    '--allowMainMerge=false',
    '--requireServerReceipt=false',
    '--maxIterations=1',
    '--maxRuntimeMinutes=5',
    '--stopOnConflict=true',
    '--stopOnScopeViolation=true',
    '--json',
  ]);
  assert.equal(cliFlatCreate.policy, 'cli-flat');
  assert.equal(cliFlatCreate.dispatchPolicy, 'fake-dispatch');
  assertAuthorityFalse(cliFlatCreate, 'cliFlatCreate');

  const cliNestedCreate = runCliJson<AutopilotPolicy>(root, [
    'autopilot',
    'policy',
    'create',
    '--policy=cli-nested',
    '--dispatchPolicy=fake-dispatch',
    '--mode=conservative',
    '--allowAutoDispatch=true',
    '--allowAutoValidate=true',
    '--allowMainMerge=false',
    '--requireServerReceipt=false',
    '--maxIterations=1',
    '--maxRuntimeMinutes=5',
    '--stopOnConflict=true',
    '--stopOnScopeViolation=true',
    '--json',
  ]);
  assert.equal(cliNestedCreate.policy, 'cli-nested');
  assert.equal(cliNestedCreate.dispatchPolicy, 'fake-dispatch');
  assertAuthorityFalse(cliNestedCreate, 'cliNestedCreate');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_policy_create',
    '--policy=bad-cli-owner-meta',
    '--dispatchPolicy=fake-dispatch',
    '--mode=conservative',
    '--allowAutoDispatch=true',
    '--allowAutoValidate=true',
    '--allowMainMerge=false',
    '--requireServerReceipt=false',
    '--maxIterations=1',
    '--maxRuntimeMinutes=5',
    '--stopOnConflict=true',
    '--stopOnScopeViolation=true',
    '--forceTakeover=true',
    '--json',
  ], 'forceTakeover');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_policy_create',
    '--policy=bad-cli-deprecated-policy-field',
    '--dispatchPolicy=fake-dispatch',
    '--mode=conservative',
    '--allowAutoDispatch=true',
    '--allowAutoValidate=true',
    '--allowMainMerge=false',
    '--requireServerReceipt=false',
    '--maxIterations=1',
    '--maxRuntimeMinutes=5',
    '--stopOnConflict=true',
    '--stopOnScopeViolation=true',
    '--allowedHosts=fake',
    '--json',
  ], 'allowedHosts');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_run',
    '--mode=conservative',
    '--storyId=B-demo',
    '--policy=fake',
    '--maxBudgetUSD=1',
    '--json',
  ], 'maxBudgetUSD');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_run',
    '--storyId=B-demo',
    '--policy=fake',
    '--trustedTestAuthorityReceipt=fake-test-server',
    '--json',
  ], 'trustedTestAuthorityReceipt');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_resume',
    '--runId=AP-B-demo-deprecated',
    '--policy=fake',
    '--json',
  ], 'policy');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_policy_check',
    '--policy=fake',
    '--allowedHosts=fake',
    '--json',
  ], 'allowedHosts');

  const missingAutopilotPolicy = run<AutopilotRunResult>('autopilot_run', {
    storyId: 'B-demo',
    policy: 'fake-dispatch',
    objective: 'Dispatch-only policy must not satisfy autopilot policy.',
    allowedPaths: ['packages/main/src/generated/dispatch-only.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(missingAutopilotPolicy.status, 'failed');
  assert.equal(missingAutopilotPolicy.stopReason, 'validation_failed');
  assert.equal(missingAutopilotPolicy.dispatchId, undefined, 'missing autopilot policy must stop before dispatch_auto');
  assert.match(missingAutopilotPolicy.nextAction ?? '', /Create the policy first|autopilot_policy_create/);
  assertAuthorityFalse(missingAutopilotPolicy, 'missingAutopilotPolicy');

  const modeOverrideRefused = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-demo',
    policy: 'fake',
    serverAuthorityReceipt: {
      schemaVersion: 'lattice.authority_receipt.v1',
      source: 'fake-test-server',
      receiptId: 'AUTH-mode-override',
      subjectDigest: 'abc123',
      signature: 'fake-signature',
      verified: true,
    },
    objective: 'CLI mode assertion cannot widen a conservative policy.',
    allowedPaths: ['packages/main/src/generated/mode-override.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(modeOverrideRefused.status, 'failed');
  assert.equal(modeOverrideRefused.stopReason, 'validation_failed');
  assert.equal(modeOverrideRefused.dispatchId, undefined, 'mode mismatch must stop before dispatch_auto');
  assert.match(modeOverrideRefused.stopDetails ?? '', /does not match persisted autopilot policy/);
  assertAuthorityFalse(modeOverrideRefused, 'modeOverrideRefused');

  const conservative = run<AutopilotRunResult>('autopilot_run', {
    mode: 'conservative',
    storyId: 'B-demo',
    policy: 'fake',
    objective: 'Conservative autopilot smoke run.',
    allowedPaths: ['packages/main/src/generated/conservative.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
    maxIterations: 1,
  });
  assert.equal(conservative.schemaVersion, 'lattice.autopilot_run.v1');
  assert.equal(conservative.mode, 'conservative');
  assert.equal(conservative.dispatchPolicy, 'fake-dispatch');
  assert.equal(conservative.storyId, 'B-demo');
  assert.equal(conservative.policy, 'fake');
  assert.equal(conservative.host, 'fake');
  assert.equal(conservative.status, 'manual_review_ready');
  assert.equal(conservative.mergeDecision?.manualOnly, true);
  assert.equal(conservative.delegation?.hostNative, true);
  assert.equal(conservative.delegation?.receiptRequired, true);
  assert.equal(conservative.delegation?.transcriptRequired, true);
  assertAuthorityFalse(conservative, 'conservative');
  const conservativeRunPath = join(root, '.koala', 'autopilot-runs', conservative.runId, 'run.json');

  const conservativeStatus = run<AutopilotStatusResult>('autopilot_status', {
    runId: conservative.runId,
  });
  assert.equal(conservativeStatus.schemaVersion, 'lattice.autopilot_run.v1');
  assert.equal(conservativeStatus.status, 'manual_review_ready');
  assertAuthorityFalse(conservativeStatus, 'conservativeStatus');

  const conservativeWatch = run<AutopilotStatusResult>('autopilot_watch', {
    runId: conservative.runId,
  });
  assert.equal(conservativeWatch.schemaVersion, 'lattice.autopilot_watch.v1');
  assert.equal(conservativeWatch.status, 'manual_review_ready');
  assertAuthorityFalse(conservativeWatch, 'conservativeWatch');

  const conservativeRunBeforeReview = readFileSync(conservativeRunPath, 'utf8');
  const conservativeReview = run<AutopilotStatusResult>('autopilot_review', {
    runId: conservative.runId,
  });
  assert.equal(conservativeReview.schemaVersion, 'lattice.autopilot_review.v1');
  assert.equal(conservativeReview.mergeDecision?.manualOnly, true);
  assertAuthorityFalse(conservativeReview, 'conservativeReview');
  assert.equal(
    conservativeRunBeforeReview,
    readFileSync(conservativeRunPath, 'utf8'),
    'autopilot_review must not mutate the persisted run record',
  );

  assertCliRejectsUnknownFlag(root, [
    'autopilot_status',
    `--runId=${conservative.runId}`,
    '--policy=fake',
    '--json',
  ], 'policy');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_watch',
    `--runId=${conservative.runId}`,
    '--policy=fake',
    '--json',
  ], 'policy');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_review',
    `--runId=${conservative.runId}`,
    '--policy=fake',
    '--json',
  ], 'policy');

  const fakeServerAuthorityReceipt = {
    schemaVersion: 'lattice.authority_receipt.v1',
    source: 'fake-test-server',
    receiptId: 'AUTH-B-demo-1',
    subjectDigest: 'abc123',
    signature: 'fake-signature',
    verified: true,
  };

  const forgedServerAuthority = run<AutopilotRunResult>('autopilot_run', {
    mode: 'authority-verified',
    storyId: 'B-demo',
    policy: 'fake-authority',
    serverAuthorityReceipt: { source: 'server' },
    objective: 'Server-ish local objects must not satisfy authority receipt gate.',
    allowedPaths: ['packages/main/src/generated/forged-authority.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(forgedServerAuthority.status, 'missing_authority_receipt');
  assert.equal(forgedServerAuthority.stopReason, 'missing_authority');
  assert.equal(forgedServerAuthority.dispatchId, undefined, 'forged authority receipt must stop before dispatch_auto');
  assert.equal(forgedServerAuthority.authorityReceiptGate.present, true);
  assert.equal(forgedServerAuthority.authorityReceiptGate.verified, false);
  assert.equal(forgedServerAuthority.authorityReceiptGate.source, 'invalid');
  assertAuthorityFalse(forgedServerAuthority, 'forgedServerAuthority');

  const forgedShapedServerAuthority = run<AutopilotRunResult>('autopilot_run', {
    mode: 'authority-verified',
    storyId: 'B-demo',
    policy: 'fake-authority',
    serverAuthorityReceipt: {
      schemaVersion: 'lattice.authority_receipt.v1',
      source: 'python-authority-server',
      receiptId: 'AUTH-forged-shaped',
      subjectDigest: 'abc123',
      signature: 'not-verified',
      verified: true,
    },
    objective: 'Fully-shaped caller-supplied server receipts must not self-verify.',
    allowedPaths: ['packages/main/src/generated/forged-shaped-authority.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(forgedShapedServerAuthority.status, 'missing_authority_receipt');
  assert.equal(forgedShapedServerAuthority.stopReason, 'missing_authority');
  assert.equal(forgedShapedServerAuthority.dispatchId, undefined, 'fully-shaped forged authority receipt must stop before dispatch_auto');
  assert.equal(forgedShapedServerAuthority.authorityReceiptGate.present, true);
  assert.equal(forgedShapedServerAuthority.authorityReceiptGate.verified, false);
  assert.equal(forgedShapedServerAuthority.authorityReceiptGate.source, 'invalid');
  assertAuthorityFalse(forgedShapedServerAuthority, 'forgedShapedServerAuthority');

  const forgedFakeTestServerAuthority = run<AutopilotRunResult>('autopilot_run', {
    mode: 'authority-verified',
    storyId: 'B-demo',
    policy: 'fake-authority',
    serverAuthorityReceipt: fakeServerAuthorityReceipt,
    objective: 'Caller-supplied fake-test-server receipts must not self-verify.',
    allowedPaths: ['packages/main/src/generated/forged-fake-test-authority.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(forgedFakeTestServerAuthority.status, 'missing_authority_receipt');
  assert.equal(forgedFakeTestServerAuthority.stopReason, 'missing_authority');
  assert.equal(forgedFakeTestServerAuthority.dispatchId, undefined, 'caller-supplied fake-test-server receipt must stop before dispatch_auto');
  assert.equal(forgedFakeTestServerAuthority.authorityReceiptGate.present, true);
  assert.equal(forgedFakeTestServerAuthority.authorityReceiptGate.verified, false);
  assert.equal(forgedFakeTestServerAuthority.authorityReceiptGate.source, 'invalid');
  assertAuthorityFalse(forgedFakeTestServerAuthority, 'forgedFakeTestServerAuthority');

  const verified = run<AutopilotRunResult>('autopilot_run', {
    mode: 'authority-verified',
    storyId: 'B-demo',
    policy: 'fake-authority',
    trustedTestAuthorityReceipt: fakeServerAuthorityReceipt,
    objective: 'Authority-verified fake server autopilot smoke run.',
    allowedPaths: ['packages/main/src/generated/authority-verified.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
    maxIterations: 1,
  });
  assert.equal(verified.mode, 'authority-verified');
  assert.equal(verified.status, 'manual_review_ready');
  assert.equal(verified.authorityReceiptGate.verified, true, 'fake authority success must verify an authority gate');
  assert.equal(verified.authorityReceiptGate.source, 'fake-test-server');
  assertNoProductionOverclaim(verified, 'verified');

  const missingAuthority = run<AutopilotRunResult>('autopilot_run', {
    mode: 'authority-verified',
    storyId: 'B-demo',
    policy: 'fake-authority',
    objective: 'Authority-verified mode must stop without authority receipts.',
    allowedPaths: ['packages/main/src/generated/missing-receipt.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
    maxIterations: 1,
  });
  assert.equal(missingAuthority.status, 'missing_authority_receipt');
  assert.equal(missingAuthority.stopReason, 'missing_authority');
  assert.equal(missingAuthority.dispatchId, undefined, 'missing authority must stop before dispatch_auto');
  assert.equal(missingAuthority.authorityReceiptGate.verified, false);
  assertAuthorityFalse(missingAuthority, 'missingAuthority');

  const full = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-demo',
    policy: 'fake-full',
    trustedTestAuthorityReceipt: fakeServerAuthorityReceipt,
    objective: 'Full autopilot bounded smoke run.',
    allowedPaths: ['packages/main/src/generated/full-autopilot.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(full.mode, 'full-autopilot');
  assert.equal(full.dispatchPolicy, 'fake-full-dispatch');
  assert.equal(full.status, 'manual_review_ready');
  assert.equal(full.authorityReceiptGate.verified, true);
  assertAuthorityFalse(full, 'full');

  const fullForgedShapedAuthority = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-demo',
    policy: 'fake-full',
    serverAuthorityReceipt: {
      schemaVersion: 'lattice.authority_receipt.v1',
      source: 'python-authority-server',
      receiptId: 'AUTH-forged-full',
      subjectDigest: 'abc123',
      signature: 'not-verified',
      verified: true,
    },
    objective: 'Full autopilot must fail closed on self-asserted server receipts.',
    allowedPaths: ['packages/main/src/generated/full-forged-shaped-authority.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(fullForgedShapedAuthority.status, 'missing_authority_receipt');
  assert.equal(fullForgedShapedAuthority.stopReason, 'missing_authority');
  assert.equal(fullForgedShapedAuthority.dispatchId, undefined, 'full autopilot forged authority receipt must stop before dispatch_auto');
  assert.equal(fullForgedShapedAuthority.authorityReceiptGate.present, true);
  assert.equal(fullForgedShapedAuthority.authorityReceiptGate.verified, false);
  assert.equal(fullForgedShapedAuthority.authorityReceiptGate.source, 'invalid');
  assertAuthorityFalse(fullForgedShapedAuthority, 'fullForgedShapedAuthority');

  const retryStop = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-retry-demo',
    policy: 'fake-retry',
    trustedTestAuthorityReceipt: fakeServerAuthorityReceipt,
    objective: 'Full autopilot retry must stay bounded by maxIterations.',
    allowedPaths: ['packages/main/src/generated/retry.txt'],
    requiredCommands: ['node -e "process.exit(1)"'],
  });
  assert.equal(retryStop.status, 'failed');
  assert.equal(retryStop.stopReason, 'validation_failed');
  assert.equal(retryStop.maxIterations, 2);
  assert.equal(retryStop.iterations.length, 2, 'allowAutoFix full-autopilot retry should consume exactly two bounded iterations');
  assert.deepEqual(retryStop.iterations.map(iteration => iteration.stopReason), ['validation_failed', 'validation_failed']);
  assert.equal(retryStop.dispatchPolicy, 'fake-retry-dispatch');
  assert.match((retryStop.errors ?? []).join('\n'), /command failed|validation/i);
  assertAuthorityFalse(retryStop, 'retryStop');

  const budgetRetryStop = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-budget-retry-demo',
    policy: 'fake-retry-budget',
    trustedTestAuthorityReceipt: fakeServerAuthorityReceipt,
    objective: 'Budget-capped retry must fail closed when spend cannot be measured.',
    allowedPaths: ['packages/main/src/generated/budget-retry.txt'],
    requiredCommands: ['node -e "process.exit(1)"'],
  });
  assert.equal(budgetRetryStop.status, 'failed');
  assert.equal(budgetRetryStop.stopReason, 'budget_exhausted');
  assert.equal(budgetRetryStop.maxBudgetUSD, 5);
  assert.equal(budgetRetryStop.iterations.length, 1, 'budget-capped retry must fail closed before a second iteration without measured spend');
  assert.deepEqual(budgetRetryStop.iterations.map(iteration => iteration.stopReason), ['validation_failed']);
  assert.match(budgetRetryStop.stopDetails ?? '', /cannot measure provider spend/);
  assert.match(budgetRetryStop.nextAction ?? '', /Fail closed|measured spend/i);
  assertAuthorityFalse(budgetRetryStop, 'budgetRetryStop');

  const activeConflictDispatch = run<Record<string, unknown>>('dispatch_prepare', {
    storyId: 'B-conflict-demo',
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/conflict-active.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(activeConflictDispatch.schemaVersion, 'lattice.dispatch_record.v1');

  const conflictStop = run<AutopilotRunResult>('autopilot_run', {
    mode: 'conservative',
    storyId: 'B-conflict-demo',
    policy: 'fake-conflict',
    objective: 'Existing active dispatch should trigger conflict stop.',
    allowedPaths: ['packages/main/src/generated/conflict-stop.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(conflictStop.status, 'failed');
  assert.equal(conflictStop.stopReason, 'conflict');
  assert.equal(conflictStop.dispatchId, undefined, 'maxParallel conflict must stop before creating a new dispatch');
  assert.equal(conflictStop.iterations.length, 1);
  assert.equal(conflictStop.iterations[0]?.status, 'failed');
  assert.equal(conflictStop.iterations[0]?.stopReason, 'conflict');
  assert.match(conflictStop.nextAction ?? '', /Manual repair|required|resolve/i);
  assert.match((conflictStop.errors ?? []).join('\n'), /maxParallel|active dispatch|conflict/i);
  const conflictRunPath = join(root, '.koala', 'autopilot-runs', conflictStop.runId, 'run.json');
  assert.equal(existsSync(conflictRunPath), true, 'conflict stop must persist run.json evidence');
  const conflictRecord = JSON.parse(readFileSync(conflictRunPath, 'utf8')) as AutopilotRunResult & { events?: Array<{ type?: string; stopReason?: string }> };
  assert.equal(conflictRecord.status, 'failed', 'conflict run.json preserves failed status');
  assert.equal(conflictRecord.stopReason, 'conflict', 'conflict run.json preserves stopReason');
  assert.equal(conflictRecord.iterations.length, 1, 'conflict run.json preserves the failed iteration');
  assert.equal(conflictRecord.iterations[0]?.status, 'failed', 'conflict run.json preserves iteration status');
  assert.equal(conflictRecord.iterations[0]?.stopReason, 'conflict', 'conflict run.json preserves iteration stopReason');
  assert.match(conflictRecord.nextAction ?? '', /Manual repair|required|resolve/i, 'conflict run.json preserves manual-repair nextAction');
  assert.match((conflictRecord.errors ?? []).join('\n'), /maxParallel|active dispatch|conflict/i, 'conflict run.json preserves refusal error evidence');
  assert.ok(
    (conflictRecord.events ?? []).some(event => event.type === 'dispatch_auto_failed' && event.stopReason === 'conflict'),
    'conflict run.json preserves dispatch_auto_failed event evidence',
  );
  assertAuthorityFalse(conflictStop, 'conflictStop');

  const cancellable = run<AutopilotRunResult>('autopilot_run', {
    mode: 'conservative',
    storyId: 'B-cancel-demo',
    policy: 'fake',
    objective: 'Create a cancellable autopilot job.',
    allowedPaths: ['packages/main/src/generated/cancellable.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
    maxIterations: 1,
  });
  assert.equal(cancellable.status, 'manual_review_ready');
  assert.ok(cancellable.dispatchId, 'cancellable run must preserve a dispatchId before cancel');
  assert.equal(cancellable.iterations.length, 1, 'cancellable run must preserve one completed iteration before cancel');
  assert.equal(cancellable.iterations[0]?.dispatchId, cancellable.dispatchId, 'cancellable iteration must reference the dispatch');
  assert.ok(cancellable.dispatch?.auto, 'cancellable run must preserve dispatch auto evidence before cancel');
  assert.ok(cancellable.dispatch?.watch, 'cancellable run must preserve dispatch watch evidence before cancel');
  assert.ok(cancellable.dispatch?.review, 'cancellable run must preserve dispatch review evidence before cancel');
  assert.ok(cancellable.dispatch?.mergePlan, 'cancellable run must preserve dispatch merge-plan evidence before cancel');
  const cancellableRunPath = join(root, '.koala', 'autopilot-runs', cancellable.runId, 'run.json');
  assert.equal(existsSync(cancellableRunPath), true, 'cancellable run.json must exist before cancel');
  assertAuthorityFalse(cancellable, 'cancellable');

  assertCliRejectsUnknownFlag(root, [
    'autopilot_cancel',
    `--runId=${cancellable.runId}`,
    '--policy=fake',
    '--json',
  ], 'policy');

  const cancelled = run<AutopilotCancelResult>('autopilot_cancel', {
    runId: cancellable.runId,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.dispatchId, cancellable.dispatchId, 'cancelled result keeps dispatchId evidence');
  assert.equal(cancelled.record.status, 'cancelled', 'cancelled result embeds the updated run record');
  assert.equal(cancelled.record.dispatchId, cancellable.dispatchId, 'cancelled record preserves dispatchId');
  assert.equal(cancelled.record.iterations.length, cancellable.iterations.length, 'cancelled record preserves iteration evidence');
  assert.equal(cancelled.record.iterations[0]?.dispatchId, cancellable.dispatchId, 'cancelled iteration preserves dispatch ref');
  assert.ok(cancelled.record.dispatch?.auto, 'cancelled record preserves dispatch auto evidence');
  assert.ok(cancelled.record.dispatch?.watch, 'cancelled record preserves dispatch watch evidence');
  assert.ok(cancelled.record.dispatch?.review, 'cancelled record preserves dispatch review evidence');
  assert.ok(cancelled.record.dispatch?.mergePlan, 'cancelled record preserves dispatch merge-plan evidence');
  assert.equal(existsSync(cancellableRunPath), true, 'cancelled run.json must still exist');
  const cancelledRunBeforeReview = readFileSync(cancellableRunPath, 'utf8');
  const cancelledReview = run<AutopilotStatusResult>('autopilot_review', {
    runId: cancellable.runId,
  });
  assert.equal(cancelledReview.schemaVersion, 'lattice.autopilot_review.v1');
  assert.equal(cancelledReview.status, 'cancelled', 'autopilot_review must preserve persisted cancelled status');
  assert.equal(cancelledReview.nextAction, cancelled.record.nextAction, 'autopilot_review must preserve persisted cancelled nextAction');
  assert.equal(
    cancelledRunBeforeReview,
    readFileSync(cancellableRunPath, 'utf8'),
    'autopilot_review must not rewrite cancelled run.json',
  );
  assertAuthorityFalse(cancelled, 'cancelled');
  assertAuthorityFalse(cancelledReview, 'cancelledReview');

  const resumeRefusal = run<Record<string, unknown> & AuthorityBoundary>('autopilot_resume', {
    runId: cancellable.runId,
  });
  assert.equal(resumeRefusal.schemaVersion, 'lattice.autopilot_resume.v1');
  assert.equal(resumeRefusal.status, 'refused');
  assertAuthorityFalse(resumeRefusal, 'resumeRefusal');

  const cliPolicyCheck = runCliJson<AutopilotPolicyCheckResult>(root, [
    'autopilot_policy_check',
    '--policy=fake',
    '--json',
  ]);
  assert.equal(cliPolicyCheck.policy, 'fake');
  assert.equal(cliPolicyCheck.mode, 'conservative');
  assertAuthorityFalse(cliPolicyCheck, 'cliPolicyCheck');

  const cliNestedPolicyCheck = runCliJson<AutopilotPolicyCheckResult>(root, [
    'autopilot',
    'policy',
    'check',
    '--policy=fake',
    '--json',
  ]);
  assert.equal(cliNestedPolicyCheck.policy, 'fake');
  assert.equal(cliNestedPolicyCheck.mode, 'conservative');
  assertAuthorityFalse(cliNestedPolicyCheck, 'cliNestedPolicyCheck');

  const cliConservative = runCliJson<AutopilotRunResult>(root, [
    'autopilot_run',
    '--mode=conservative',
    '--storyId=B-demo',
    '--policy=fake',
    '--allowedPaths=packages/main/src/generated/cli-conservative.txt',
    '--requiredCommands=node -e "process.exit(0)"',
    '--json',
  ]);
  assert.equal(cliConservative.mode, 'conservative');
  assert.equal(cliConservative.storyId, 'B-demo');
  assert.equal(cliConservative.status, 'manual_review_ready');
  assertAuthorityFalse(cliConservative, 'cliConservative');

  const cliTakeoverRun = runCliJson<AutopilotRunResult>(root, [
    'autopilot_run',
    '--mode=conservative',
    '--storyId=B-demo',
    '--policy=fake',
    '--allowedPaths=packages/main/src/generated/cli-takeover-run.txt',
    '--requiredCommands=node -e "process.exit(0)"',
    '--forceTakeover=true',
    '--json',
  ]);
  assert.equal(cliTakeoverRun.status, 'manual_review_ready');
  assertNoCliMetaLeak(cliTakeoverRun, 'cliTakeoverRun');
  assertAuthorityFalse(cliTakeoverRun, 'cliTakeoverRun');

  const cliTakeoverCancel = runCliJson<AutopilotStatusResult>(root, [
    'autopilot_cancel',
    `--runId=${cliTakeoverRun.runId}`,
    '--takeover=true',
    '--json',
  ]);
  assert.equal(cliTakeoverCancel.status, 'cancelled');
  assertNoCliMetaLeak(cliTakeoverCancel, 'cliTakeoverCancel');
  assertAuthorityFalse(cliTakeoverCancel, 'cliTakeoverCancel');

  const cliResumeTarget = runCliJson<AutopilotRunResult>(root, [
    'autopilot_run',
    '--mode=conservative',
    '--storyId=B-demo',
    '--policy=fake',
    '--allowedPaths=packages/main/src/generated/cli-resume-target.txt',
    '--requiredCommands=node -e "process.exit(0)"',
    '--takeover=true',
    '--json',
  ]);
  assert.equal(cliResumeTarget.status, 'manual_review_ready');
  assertNoCliMetaLeak(cliResumeTarget, 'cliResumeTarget');
  assertAuthorityFalse(cliResumeTarget, 'cliResumeTarget');

  const cliTakeoverResume = runCliJson<Record<string, unknown> & AuthorityBoundary>(root, [
    'autopilot_resume',
    `--runId=${cliResumeTarget.runId}`,
    '--forceTakeover=true',
    '--json',
  ]);
  assert.equal(cliTakeoverResume.schemaVersion, 'lattice.autopilot_resume.v1');
  assert.equal(cliTakeoverResume.status, 'refused');
  assertNoCliMetaLeak(cliTakeoverResume, 'cliTakeoverResume');
  assertAuthorityFalse(cliTakeoverResume, 'cliTakeoverResume');

  const ownerGateCancelRun = runCliJson<AutopilotRunResult>(root, [
    'autopilot_run',
    '--mode=conservative',
    '--storyId=B-owner-gate-cancel-demo',
    '--policy=fake',
    '--allowedPaths=packages/main/src/generated/owner-gate-cancel.txt',
    '--requiredCommands=node -e "process.exit(0)"',
    '--json',
  ], { KOALA_SESSION_ID: 'sess-autopilot-owner' });
  assert.equal(ownerGateCancelRun.status, 'manual_review_ready');
  assert.equal(ownerGateCancelRun.storyId, 'B-owner-gate-cancel-demo');
  const ownerGateCancelRefusal = runCliFailure(root, [
    'autopilot_cancel',
    `--runId=${ownerGateCancelRun.runId}`,
    '--json',
  ], { KOALA_SESSION_ID: 'sess-autopilot-intruder' });
  assert.match(ownerGateCancelRefusal, /B-owner-gate-cancel-demo/, 'autopilot_cancel owner gate must resolve storyId from runId');
  assert.match(ownerGateCancelRefusal, /sess-autopilot-owner/, 'autopilot_cancel owner gate must reject the non-owner session');
  assert.match(ownerGateCancelRefusal, /owner-gated/, 'autopilot_cancel runId owner gate refusal must name owner-gated semantics');
  const ownerGateCancelTakeover = runCliJson<AutopilotCancelResult>(root, [
    'autopilot_cancel',
    `--runId=${ownerGateCancelRun.runId}`,
    '--forceTakeover=true',
    '--json',
  ], { KOALA_SESSION_ID: 'sess-autopilot-intruder' });
  assert.equal(ownerGateCancelTakeover.status, 'cancelled');
  assert.equal(ownerGateCancelTakeover.record.storyId, 'B-owner-gate-cancel-demo');
  assertNoCliMetaLeak(ownerGateCancelTakeover, 'ownerGateCancelTakeover');
  assertAuthorityFalse(ownerGateCancelTakeover, 'ownerGateCancelTakeover');

  const ownerGateResumeRun = runCliJson<AutopilotRunResult>(root, [
    'autopilot_run',
    '--mode=conservative',
    '--storyId=B-owner-gate-resume-demo',
    '--policy=fake',
    '--allowedPaths=packages/main/src/generated/owner-gate-resume.txt',
    '--requiredCommands=node -e "process.exit(0)"',
    '--json',
  ], { KOALA_SESSION_ID: 'sess-autopilot-owner' });
  assert.equal(ownerGateResumeRun.status, 'manual_review_ready');
  assert.equal(ownerGateResumeRun.storyId, 'B-owner-gate-resume-demo');
  const ownerGateResumeRefusal = runCliFailure(root, [
    'autopilot_resume',
    `--runId=${ownerGateResumeRun.runId}`,
    '--json',
  ], { KOALA_SESSION_ID: 'sess-autopilot-intruder' });
  assert.match(ownerGateResumeRefusal, /B-owner-gate-resume-demo/, 'autopilot_resume owner gate must resolve storyId from runId');
  assert.match(ownerGateResumeRefusal, /sess-autopilot-owner/, 'autopilot_resume owner gate must reject the non-owner session');
  assert.match(ownerGateResumeRefusal, /owner-gated/, 'autopilot_resume runId owner gate refusal must name owner-gated semantics');
  const ownerGateResumeTakeover = runCliJson<Record<string, unknown> & AuthorityBoundary>(root, [
    'autopilot_resume',
    `--runId=${ownerGateResumeRun.runId}`,
    '--forceTakeover=true',
    '--json',
  ], { KOALA_SESSION_ID: 'sess-autopilot-intruder' });
  assert.equal(ownerGateResumeTakeover.schemaVersion, 'lattice.autopilot_resume.v1');
  assert.equal(ownerGateResumeTakeover.status, 'refused');
  assertNoCliMetaLeak(ownerGateResumeTakeover, 'ownerGateResumeTakeover');
  assertAuthorityFalse(ownerGateResumeTakeover, 'ownerGateResumeTakeover');

  assertNoProductionOverclaim([
    conservative,
    conservativeStatus,
    conservativeWatch,
    conservativeReview,
    missingAutopilotPolicy,
    modeOverrideRefused,
    forgedServerAuthority,
    forgedShapedServerAuthority,
    forgedFakeTestServerAuthority,
    verified,
    missingAuthority,
    full,
    fullForgedShapedAuthority,
    retryStop,
    budgetRetryStop,
    conflictStop,
    cancellable,
    cancelled,
    resumeRefusal,
    cliPolicyCheck,
    cliNestedPolicyCheck,
    cliConservative,
    cliTakeoverRun,
    cliTakeoverCancel,
    cliResumeTarget,
    cliTakeoverResume,
    ownerGateCancelRun,
    ownerGateCancelTakeover,
    ownerGateResumeRun,
    ownerGateResumeTakeover,
  ], 'allResults');

  console.log('autopilot-run smoke passed: registration, two-policy linkage, policy gates, deprecated CLI flag refusal, autopilot_policy_create owner-meta refusal, full autopilot-surface unknown flag refusal, runId owner-gate refusal/takeover for cancel/resume, owner meta preservation, strict autopilot read-only flag refusal, read-only review immutability, dispatch-only refusal, mode-override refusal, forged authority refusal, fully-shaped server receipt refusal, caller-supplied fake-test-server receipt refusal, authority-verified fake server gate success/refusal, full-autopilot bounded retry, budget-capped retry fail-closed, conflict stop evidence preservation, host-native delegation contract, cancel evidence preservation, cancelled review immutability, resume refusal, and authority boundaries verified');
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
