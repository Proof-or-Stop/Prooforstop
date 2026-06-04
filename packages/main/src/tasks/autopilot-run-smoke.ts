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
  mkdirSync,
  mkdtempSync,
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
  host?: string;
  dispatchId?: string;
  status: 'created' | 'running' | 'needs_receipt' | 'manual_review_ready' | 'missing_authority_receipt' | 'cancelled' | 'failed';
  maxIterations: number;
  stopReason?: string;
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

function runCliJson<T>(root: string, args: string[]): T {
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
  })) as T;
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'lattice-autopilot-run-suite-'));
const root = join(sandboxRoot, 'repo', 'root');

try {
  initRepo(root);
  resetConfigCache();

  const store = new StoryStore(root);
  seedStory(store, 'B-demo');
  seedStory(store, 'B-cancel-demo');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const run = <T>(name: string, args: Record<string, unknown> = {}): T => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler({ ...args, json: true }) as T;
  };

  for (const command of EXPECTED_COMMANDS) assertFiveWayRegistration(command, registry);

  const dispatchPolicy = run<Record<string, unknown>>('dispatch_policy_create', {
    policy: 'fake',
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
    policy: 'fake-authority',
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

  const policy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake',
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
  assert.equal(policy.mode, 'conservative');
  assert.equal(policy.allowMainMerge, false);
  assert.equal(policy.requireServerReceipt, false);
  assertAuthorityFalse(policy, 'policy');

  const authorityPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-authority',
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
  assert.equal(authorityPolicy.requireServerReceipt, true);
  assertAuthorityFalse(authorityPolicy, 'authorityPolicy');

  const fullPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-full',
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
  assert.equal(fullPolicy.maxIterations, 2);
  assertAuthorityFalse(fullPolicy, 'fullPolicy');

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
  assertAuthorityFalse(cliFlatCreate, 'cliFlatCreate');

  const cliNestedCreate = runCliJson<AutopilotPolicy>(root, [
    'autopilot',
    'policy',
    'create',
    '--policy=cli-nested',
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
  assertAuthorityFalse(cliNestedCreate, 'cliNestedCreate');

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
  assert.equal(conservative.storyId, 'B-demo');
  assert.equal(conservative.policy, 'fake');
  assert.equal(conservative.host, 'fake');
  assert.equal(conservative.status, 'manual_review_ready');
  assert.equal(conservative.mergeDecision?.manualOnly, true);
  assert.equal(conservative.delegation?.hostNative, true);
  assert.equal(conservative.delegation?.receiptRequired, true);
  assert.equal(conservative.delegation?.transcriptRequired, true);
  assertAuthorityFalse(conservative, 'conservative');

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

  const conservativeReview = run<AutopilotStatusResult>('autopilot_review', {
    runId: conservative.runId,
  });
  assert.equal(conservativeReview.schemaVersion, 'lattice.autopilot_review.v1');
  assert.equal(conservativeReview.mergeDecision?.manualOnly, true);
  assertAuthorityFalse(conservativeReview, 'conservativeReview');

  const fakeServerAuthorityReceipt = {
    schemaVersion: 'lattice.authority_receipt.v1',
    source: 'fake-test-server',
    receiptId: 'AUTH-B-demo-1',
    subjectDigest: 'abc123',
    signature: 'fake-signature',
    verified: true,
  };

  const verified = run<AutopilotRunResult>('autopilot_run', {
    mode: 'authority-verified',
    storyId: 'B-demo',
    policy: 'fake-authority',
    serverAuthorityReceipt: fakeServerAuthorityReceipt,
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
  assert.equal(missingAuthority.authorityReceiptGate.verified, false);
  assertAuthorityFalse(missingAuthority, 'missingAuthority');

  const full = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-demo',
    policy: 'fake',
    serverAuthorityReceipt: fakeServerAuthorityReceipt,
    objective: 'Full autopilot bounded smoke run.',
    allowedPaths: ['packages/main/src/generated/full-autopilot.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
    maxIterations: 2,
    maxBudgetUSD: 5,
  });
  assert.equal(full.mode, 'full-autopilot');
  assert.equal(full.status, 'manual_review_ready');
  assert.equal(full.authorityReceiptGate.verified, true);
  assertAuthorityFalse(full, 'full');

  const maxIterationStop = run<AutopilotRunResult>('autopilot_run', {
    mode: 'conservative',
    storyId: 'B-demo',
    policy: 'fake',
    objective: 'Max iteration stop smoke run.',
    allowedPaths: ['packages/main/src/generated/max-iterations.txt'],
    maxIterations: 0,
  });
  assert.equal(maxIterationStop.status, 'failed');
  assert.equal(maxIterationStop.stopReason, 'max_iterations');
  assertAuthorityFalse(maxIterationStop, 'maxIterationStop');

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
  assertAuthorityFalse(cancellable, 'cancellable');

  const cancelled = run<AutopilotStatusResult>('autopilot_cancel', {
    runId: cancellable.runId,
  });
  assert.equal(cancelled.status, 'cancelled');
  assertAuthorityFalse(cancelled, 'cancelled');

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

  assertNoProductionOverclaim([
    conservative,
    conservativeStatus,
    conservativeWatch,
    conservativeReview,
    verified,
    missingAuthority,
    full,
    maxIterationStop,
    cancellable,
    cancelled,
    resumeRefusal,
    cliPolicyCheck,
    cliNestedPolicyCheck,
    cliConservative,
  ], 'allResults');

  console.log('autopilot-run smoke passed: registration, policy gates, conservative manual_review_ready, authority-verified fake server gate success/refusal, full-autopilot bounded run, host-native delegation contract, cancel, resume refusal, and authority boundaries verified');
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
