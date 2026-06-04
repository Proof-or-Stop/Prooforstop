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
  modes: AutopilotMode[];
  allowedHosts: string[];
  allowedPaths: string[];
  maxParallel: number;
  allowAutoMerge: boolean;
  allowProductionDone: boolean;
}

interface AutopilotPolicyCheckResult extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_policy_check.v1';
  policy: string;
  mode: AutopilotMode;
  status: 'authorized' | 'refused' | 'supervised_only';
  authorized: boolean;
  reasons: string[];
  nextAction?: string;
}

interface HostNativeDelegation {
  kind: 'host-native';
  host: 'claude-code' | 'gemini' | 'codex' | 'fake';
  commandPreview: string[];
  promptFile: string;
  authorityBoundary: 'execution-only';
}

interface AutopilotRunResult extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_run.v1';
  autopilotId: string;
  storyId: string;
  mode: AutopilotMode;
  policy: string;
  host: string;
  status: 'accepted_local' | 'authority_verified' | 'delegated' | 'stopped' | 'cancelled' | 'refused';
  bounded: boolean;
  stopReason?: 'bounded' | 'cancelled' | 'complete';
  localDiagnosticReceipts?: unknown[];
  authorityReceipt?: {
    receiptId: string;
    verified: boolean;
    issuer: string;
  };
  delegation?: HostNativeDelegation;
  nextAction?: string;
}

interface AutopilotStatusResult extends AuthorityBoundary {
  schemaVersion: 'lattice.autopilot_status.v1' | 'lattice.autopilot_watch.v1' | 'lattice.autopilot_review.v1';
  autopilotId: string;
  storyId: string;
  mode: AutopilotMode;
  status: string;
  bounded: boolean;
  manualOnly?: boolean;
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

  const policy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake',
    modes: ['conservative', 'authority-verified', 'full-autopilot'],
    allowedHosts: ['fake', 'claude-code'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 2,
    maxRuntimeMinutes: 10,
    maxSteps: 4,
    network: 'none',
    requireAuthorityReceipt: false,
    requireReview: true,
    allowHostNativeDelegation: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(policy.schemaVersion, 'lattice.autopilot_policy.v1');
  assert.equal(policy.policy, 'fake');
  assert.deepEqual(policy.modes, ['conservative', 'authority-verified', 'full-autopilot']);
  assert.equal(policy.allowAutoMerge, false);
  assert.equal(policy.allowProductionDone, false);
  assertAuthorityFalse(policy, 'policy');

  const authorityPolicy = run<AutopilotPolicy>('autopilot_policy_create', {
    policy: 'fake-authority',
    modes: ['authority-verified'],
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    maxParallel: 1,
    maxRuntimeMinutes: 10,
    maxSteps: 3,
    network: 'none',
    requireAuthorityReceipt: true,
    fakeAuthority: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  assert.equal(authorityPolicy.policy, 'fake-authority');
  assert.equal(authorityPolicy.allowProductionDone, false);
  assertAuthorityFalse(authorityPolicy, 'authorityPolicy');

  const policyCheck = run<AutopilotPolicyCheckResult>('autopilot_policy_check', {
    policy: 'fake',
    mode: 'conservative',
  });
  assert.equal(policyCheck.schemaVersion, 'lattice.autopilot_policy_check.v1');
  assert.equal(policyCheck.status, 'authorized');
  assert.equal(policyCheck.authorized, true);
  assert.deepEqual(policyCheck.reasons, []);
  assertAuthorityFalse(policyCheck, 'policyCheck');

  const cliFlatCreate = runCliJson<AutopilotPolicy>(root, [
    'lattice',
    'autopilot_policy_create',
    '--policy=cli-flat',
    '--modes=conservative',
    '--allowedHosts=fake',
    '--allowedPaths=packages/main/src/generated/',
    '--maxParallel=1',
    '--maxRuntimeMinutes=5',
    '--allowAutoMerge=false',
    '--allowProductionDone=false',
    '--json',
  ]);
  assert.equal(cliFlatCreate.policy, 'cli-flat');
  assertAuthorityFalse(cliFlatCreate, 'cliFlatCreate');

  const cliNestedCreate = runCliJson<AutopilotPolicy>(root, [
    'lattice',
    'autopilot',
    'policy',
    'create',
    '--policy=cli-nested',
    '--modes=conservative',
    '--allowedHosts=fake',
    '--allowedPaths=packages/main/src/generated/',
    '--maxParallel=1',
    '--maxRuntimeMinutes=5',
    '--allowAutoMerge=false',
    '--allowProductionDone=false',
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
    maxSteps: 2,
  });
  assert.equal(conservative.schemaVersion, 'lattice.autopilot_run.v1');
  assert.equal(conservative.mode, 'conservative');
  assert.equal(conservative.storyId, 'B-demo');
  assert.equal(conservative.policy, 'fake');
  assert.equal(conservative.host, 'fake');
  assert.equal(conservative.status, 'accepted_local');
  assert.equal(conservative.bounded, true);
  assertAuthorityFalse(conservative, 'conservative');

  const conservativeStatus = run<AutopilotStatusResult>('autopilot_status', {
    autopilotId: conservative.autopilotId,
  });
  assert.equal(conservativeStatus.schemaVersion, 'lattice.autopilot_status.v1');
  assert.equal(conservativeStatus.status, 'accepted_local');
  assert.equal(conservativeStatus.bounded, true);
  assertAuthorityFalse(conservativeStatus, 'conservativeStatus');

  const conservativeWatch = run<AutopilotStatusResult>('autopilot_watch', {
    autopilotId: conservative.autopilotId,
  });
  assert.equal(conservativeWatch.schemaVersion, 'lattice.autopilot_watch.v1');
  assert.equal(conservativeWatch.status, 'accepted_local');
  assertAuthorityFalse(conservativeWatch, 'conservativeWatch');

  const conservativeReview = run<AutopilotStatusResult>('autopilot_review', {
    autopilotId: conservative.autopilotId,
  });
  assert.equal(conservativeReview.schemaVersion, 'lattice.autopilot_review.v1');
  assert.equal(conservativeReview.manualOnly, true);
  assertAuthorityFalse(conservativeReview, 'conservativeReview');

  const verified = run<AutopilotRunResult>('autopilot_run', {
    mode: 'authority-verified',
    storyId: 'B-demo',
    policy: 'fake-authority',
    authority: 'fake',
    fakeAuthorityReceipt: 'valid',
    objective: 'Authority-verified fake server autopilot smoke run.',
    allowedPaths: ['packages/main/src/generated/authority-verified.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
    maxSteps: 2,
  });
  assert.equal(verified.mode, 'authority-verified');
  assert.equal(verified.status, 'authority_verified');
  assert.equal(verified.receiptVerified, true, 'fake authority success must verify an authority receipt');
  assert.equal(verified.authorityReceipt?.verified, true, 'authority receipt must be verified');
  assert.equal(verified.authorityReceipt?.issuer, 'fake');
  assertNoProductionOverclaim(verified, 'verified');

  assert.throws(
    () => run<AutopilotRunResult>('autopilot_run', {
      mode: 'authority-verified',
      storyId: 'B-demo',
      policy: 'fake-authority',
      authority: 'fake',
      fakeAuthorityReceipt: 'missing',
      objective: 'Authority-verified mode must refuse missing receipts.',
      allowedPaths: ['packages/main/src/generated/missing-receipt.txt'],
    }),
    /authority.*receipt.*missing|missing.*authority.*receipt|receipt.*required/i,
    'authority-verified mode must refuse when no authority receipt is available',
  );

  const full = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-demo',
    policy: 'fake',
    objective: 'Full autopilot bounded smoke run.',
    allowedPaths: ['packages/main/src/generated/full-autopilot.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
    maxSteps: 2,
    stopAfter: 'bounded',
  });
  assert.equal(full.mode, 'full-autopilot');
  assert.equal(full.status, 'stopped');
  assert.equal(full.stopReason, 'bounded');
  assert.equal(full.bounded, true);
  assertAuthorityFalse(full, 'full');

  const delegated = run<AutopilotRunResult>('autopilot_run', {
    mode: 'conservative',
    storyId: 'B-demo',
    policy: 'fake',
    host: 'claude-code',
    hostNative: true,
    delegateOnly: true,
    objective: 'Host-native delegation shape smoke run.',
    allowedPaths: ['packages/main/src/generated/delegated.txt'],
  });
  assert.equal(delegated.status, 'delegated');
  assert.equal(delegated.delegation?.kind, 'host-native');
  assert.equal(delegated.delegation?.host, 'claude-code');
  assert.ok(Array.isArray(delegated.delegation?.commandPreview), 'delegation must include commandPreview');
  assert.ok(typeof delegated.delegation?.promptFile === 'string' && delegated.delegation.promptFile.length > 0);
  assert.equal(delegated.delegation?.authorityBoundary, 'execution-only');
  assertAuthorityFalse(delegated, 'delegated');

  const cancellable = run<AutopilotRunResult>('autopilot_run', {
    mode: 'full-autopilot',
    storyId: 'B-cancel-demo',
    policy: 'fake',
    objective: 'Create a cancellable full-autopilot job.',
    allowedPaths: ['packages/main/src/generated/cancellable.txt'],
    startPaused: true,
    maxSteps: 4,
  });
  assert.equal(cancellable.bounded, true);
  assertAuthorityFalse(cancellable, 'cancellable');

  const cancelled = run<AutopilotStatusResult>('autopilot_cancel', {
    autopilotId: cancellable.autopilotId,
  });
  assert.equal(cancelled.status, 'cancelled');
  assertAuthorityFalse(cancelled, 'cancelled');

  assert.throws(
    () => run<AutopilotRunResult>('autopilot_resume', {
      autopilotId: cancellable.autopilotId,
    }),
    /cancelled.*cannot.*resume|resume.*refused|not resumable/i,
    'cancelled autopilot jobs must refuse resume',
  );

  const cliPolicyCheck = runCliJson<AutopilotPolicyCheckResult>(root, [
    'lattice',
    'autopilot_policy_check',
    '--policy=fake',
    '--mode=conservative',
    '--json',
  ]);
  assert.equal(cliPolicyCheck.policy, 'fake');
  assert.equal(cliPolicyCheck.mode, 'conservative');
  assertAuthorityFalse(cliPolicyCheck, 'cliPolicyCheck');

  const cliNestedPolicyCheck = runCliJson<AutopilotPolicyCheckResult>(root, [
    'lattice',
    'autopilot',
    'policy',
    'check',
    '--policy=fake',
    '--mode=conservative',
    '--json',
  ]);
  assert.equal(cliNestedPolicyCheck.policy, 'fake');
  assert.equal(cliNestedPolicyCheck.mode, 'conservative');
  assertAuthorityFalse(cliNestedPolicyCheck, 'cliNestedPolicyCheck');

  const cliConservative = runCliJson<AutopilotRunResult>(root, [
    'lattice',
    'autopilot_run',
    '--mode=conservative',
    '--storyId=B-demo',
    '--policy=fake',
    '--allowedPaths=packages/main/src/generated/cli-conservative.txt',
    '--json',
  ]);
  assert.equal(cliConservative.mode, 'conservative');
  assert.equal(cliConservative.storyId, 'B-demo');
  assertAuthorityFalse(cliConservative, 'cliConservative');

  assertNoProductionOverclaim([
    conservative,
    conservativeStatus,
    conservativeWatch,
    conservativeReview,
    verified,
    full,
    delegated,
    cancellable,
    cancelled,
    cliPolicyCheck,
    cliNestedPolicyCheck,
    cliConservative,
  ], 'allResults');

  console.log('autopilot-run smoke passed: registration, conservative success, authority-verified fake authority success/refusal, full-autopilot bounded stop, host-native delegation, cancel, resume refusal, and authority boundaries verified');
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
