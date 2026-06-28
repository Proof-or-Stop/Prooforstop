#!/usr/bin/env node
/**
 * Autopilot M1 resume smoke.
 *
 * Verifies checkpoint-ledger-backed resume projection without real providers:
 * fresh runs project as resumable, stale/corrupt ledger state fails closed,
 * corrupt snapshots recover from a valid ledger, committed done checkpoints are
 * not re-dispatched, and authority/proof booleans stay false.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

type JsonObject = Record<string, unknown>;
type AuthorityBoundary = {
  authorityChanged?: boolean;
  receiptVerified?: boolean;
  productionDone?: boolean;
  canClaimProductionDone?: boolean;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value as JsonObject).sort()) {
      const child = (value as JsonObject)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
  }, null, 2) + '\n');
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'packages/main/src/generated'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const smoke = true;\n');
  writeFileSync(join(root, 'README.md'), '# autopilot resume smoke\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'lattice@example.com']);
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-04T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: `autopilot-resume-${storyId}`,
    title: `Autopilot resume ${storyId}`,
    description: 'Smoke story for checkpoint-ledger-backed autopilot resume.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: `story/${storyId}` }],
  };
  const checklist: ChecklistData = {
    items: [{ id: 'CHK-001', title: 'Autopilot resume flow', status: 'done', startTime: now, endTime: now }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function assertNoProductionOverclaim(value: unknown, label = 'result'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProductionOverclaim(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as JsonObject;
  for (const key of ['authorityChanged', 'receiptVerified', 'productionDone', 'canClaimProductionDone']) {
    if (key in record) assert.equal(record[key], false, `${label}.${key}`);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (nested && typeof nested === 'object') assertNoProductionOverclaim(nested, `${label}.${key}`);
  }
}

function dispatchCount(root: string): number {
  const dir = join(root, '.lattice', 'dispatches');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(name => !name.startsWith('.')).length;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function appendStaleCheckpoint(root: string, runId: string): void {
  const ledgerPath = join(root, '.lattice', 'autopilot-runs', runId, 'checkpoint-events.jsonl');
  const events = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as JsonObject);
  const last = events[events.length - 1];
  const checkpoint = { ...(last.checkpoint as JsonObject), status: 'stale', note: 'smoke-injected stale checkpoint' };
  const withoutHash = {
    schemaVersion: 'lattice.autopilot_checkpoint_ledger.v1',
    sequence: events.length,
    at: new Date().toISOString(),
    runId,
    type: 'checkpoint',
    previousHash: last.eventHash,
    checkpoint,
  };
  writeFileSync(ledgerPath, `${JSON.stringify({ ...withoutHash, eventHash: digest(withoutHash) })}\n`, { flag: 'a' });
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'lattice-autopilot-resume-'));
const root = join(sandboxRoot, 'repo', 'root');

try {
  initRepo(root);
  resetConfigCache();

  const store = new StoryStore(root);
  for (const storyId of ['B-green', 'B-stale', 'B-corrupt-snapshot', 'B-stale-checkpoint', 'B-early-fail', 'B-policy-drift', 'B-missing-git']) {
    seedStory(store, storyId);
  }
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const run = <T>(name: string, args: Record<string, unknown> = {}): T => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler({ ...args, json: true }) as T;
  };

  run('dispatch_policy_create', {
    policy: 'fake-dispatch',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: ['README.md'],
    maxParallel: 5,
    maxRuntimeMinutes: 10,
    maxBudgetUSD: 5,
    network: 'none',
    commandAllowlist: ['node -e "process.exit(0)"'],
    requireReceipt: true,
    requireReview: true,
    allowAutoMerge: false,
    allowProductionDone: false,
  });
  run('autopilot_policy_create', {
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

  const green = run<JsonObject & AuthorityBoundary>('autopilot_run', {
    runId: 'AP-green',
    mode: 'conservative',
    storyId: 'B-green',
    policy: 'fake',
    objective: 'Fresh resume projection.',
    allowedPaths: ['packages/main/src/generated/green.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(green.status, 'manual_review_ready');
  const beforeDispatches = dispatchCount(root);
  const greenResume = run<JsonObject & AuthorityBoundary>('autopilot_resume', { runId: 'AP-green' });
  assert.equal(greenResume.status, 'resume_ready');
  assert.equal((greenResume.projection as JsonObject).remainingSteps, 0);
  assert.deepEqual((greenResume.projection as JsonObject).skippedDoneSteps, ['iteration-0']);
  assert.equal(dispatchCount(root), beforeDispatches, 'autopilot_resume must not dispatch a new worker');
  assertNoProductionOverclaim(greenResume, 'greenResume');

  const stale = run<JsonObject & AuthorityBoundary>('autopilot_run', {
    runId: 'AP-stale',
    mode: 'conservative',
    storyId: 'B-stale',
    policy: 'fake',
    objective: 'Stale resume refusal.',
    allowedPaths: ['packages/main/src/generated/stale.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  const staleRunJson = join(root, '.lattice', 'autopilot-runs', 'AP-stale', 'run.json');
  writeJson(staleRunJson, { ...readJson<JsonObject>(staleRunJson), updatedAt: '2000-01-01T00:00:00.000Z' });
  const staleResume = run<JsonObject & AuthorityBoundary>('autopilot_resume', { runId: stale.runId, maxResumeAgeMs: 60_000 });
  assert.equal(staleResume.status, 'refused');
  assert.equal(staleResume.reason, 'stale_state');
  assertNoProductionOverclaim(staleResume, 'staleResume');

  const corruptSnapshot = run<JsonObject & AuthorityBoundary>('autopilot_run', {
    runId: 'AP-corrupt-snapshot',
    mode: 'conservative',
    storyId: 'B-corrupt-snapshot',
    policy: 'fake',
    objective: 'Recover corrupt run.json from valid checkpoint ledger.',
    allowedPaths: ['packages/main/src/generated/corrupt-snapshot.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  const corruptRunJson = join(root, '.lattice', 'autopilot-runs', 'AP-corrupt-snapshot', 'run.json');
  writeFileSync(corruptRunJson, '{not-json\n');
  const recoveredResume = run<JsonObject & AuthorityBoundary>('autopilot_resume', { runId: corruptSnapshot.runId, maxResumeAgeMs: 60_000 });
  assert.equal(recoveredResume.status, 'resume_ready');
  assert.equal((recoveredResume.projection as JsonObject).recoveredFromLedger, true);
  assert.equal(readJson<JsonObject>(corruptRunJson).runId, 'AP-corrupt-snapshot', 'resume should rewrite a valid run.json projection');
  assertNoProductionOverclaim(recoveredResume, 'recoveredResume');

  const staleCheckpoint = run<JsonObject & AuthorityBoundary>('autopilot_run', {
    runId: 'AP-stale-checkpoint',
    mode: 'conservative',
    storyId: 'B-stale-checkpoint',
    policy: 'fake',
    objective: 'Fail closed on stale checkpoint.',
    allowedPaths: ['packages/main/src/generated/stale-checkpoint.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  appendStaleCheckpoint(root, staleCheckpoint.runId as string);
  const staleCheckpointResume = run<JsonObject & AuthorityBoundary>('autopilot_resume', { runId: staleCheckpoint.runId, maxResumeAgeMs: 60_000 });
  assert.equal(staleCheckpointResume.status, 'refused');
  assert.equal(staleCheckpointResume.reason, 'stale_state');
  assertNoProductionOverclaim(staleCheckpointResume, 'staleCheckpointResume');

  const earlyFail = run<JsonObject & AuthorityBoundary>('autopilot_run', {
    runId: 'AP-early-fail',
    mode: 'authority-verified',
    storyId: 'B-early-fail',
    policy: 'fake',
    objective: 'Fail before any committed step checkpoint.',
    allowedPaths: ['packages/main/src/generated/early-fail.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  assert.equal(earlyFail.status, 'failed');
  const earlyFailResume = run<JsonObject & AuthorityBoundary>('autopilot_resume', { runId: earlyFail.runId, maxResumeAgeMs: 60_000 });
  assert.equal(earlyFailResume.status, 'refused');
  assert.equal(earlyFailResume.reason, 'unsafe_state');
  assertNoProductionOverclaim(earlyFailResume, 'earlyFailResume');

  const policyDrift = run<JsonObject & AuthorityBoundary>('autopilot_run', {
    runId: 'AP-policy-drift',
    mode: 'conservative',
    storyId: 'B-policy-drift',
    policy: 'fake',
    objective: 'Fail closed when policy digest changes.',
    allowedPaths: ['packages/main/src/generated/policy-drift.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  run('autopilot_policy_create', {
    policy: 'fake',
    dispatchPolicy: 'fake-dispatch',
    mode: 'conservative',
    allowAutoDispatch: true,
    allowAutoValidate: true,
    allowAutoFix: false,
    allowStoryIntegration: false,
    allowDoneAdvance: false,
    allowMainMerge: false,
    requireServerReceipt: true,
    maxIterations: 1,
    maxRuntimeMinutes: 10,
    stopOnConflict: true,
    stopOnScopeViolation: true,
  });
  const policyDriftResume = run<JsonObject & AuthorityBoundary>('autopilot_resume', { runId: policyDrift.runId, maxResumeAgeMs: 60_000 });
  assert.equal(policyDriftResume.status, 'refused');
  assert.equal(policyDriftResume.reason, 'stale_state');
  assert.match(String(policyDriftResume.nextAction), /validityPolicyDigest changed/);
  assertNoProductionOverclaim(policyDriftResume, 'policyDriftResume');

  run('autopilot_policy_create', {
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

  const missingGit = run<JsonObject & AuthorityBoundary>('autopilot_run', {
    runId: 'AP-missing-git',
    mode: 'conservative',
    storyId: 'B-missing-git',
    policy: 'fake',
    objective: 'Fail closed when freshness probes are unavailable.',
    allowedPaths: ['packages/main/src/generated/missing-git.txt'],
    requiredCommands: ['node -e "process.exit(0)"'],
  });
  const gitDir = join(root, '.git');
  const movedGitDir = join(root, '.git.moved-for-autopilot-resume-smoke');
  renameSync(gitDir, movedGitDir);
  try {
    const missingGitResume = run<JsonObject & AuthorityBoundary>('autopilot_resume', { runId: missingGit.runId, maxResumeAgeMs: 60_000 });
    assert.equal(missingGitResume.status, 'refused');
    assert.equal(missingGitResume.reason, 'stale_state');
    assert.match(String(missingGitResume.nextAction), /headHash could not be recomputed/);
    assertNoProductionOverclaim(missingGitResume, 'missingGitResume');
  } finally {
    renameSync(movedGitDir, gitDir);
  }

  assertNoProductionOverclaim([green, stale, corruptSnapshot, staleCheckpoint, earlyFail, policyDrift, missingGit], 'runs');
  console.log('autopilot-resume smoke passed: fresh ledger projection, stale refusal, no re-dispatch, corrupt snapshot recovery, stale checkpoint fail-closed, early failed no-checkpoint refusal, policy drift fail-closed, missing freshness fail-closed, and authority boundaries verified');
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
