#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import {
  createHandoffPack,
  type HandoffPack,
  type HandoffReceipt,
  type HandoffReceiptSubmission,
  type HandoffWorktreeProjection,
  type HostDispatchProjection,
} from '../core/lattice-handoff.js';
import type { CapabilityProbe } from '../core/capabilities.js';
import { buildLatticeHostStatus, buildLatticeHostStatusFromProbe, type LatticeHostStatus } from '../core/lattice-hosts.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createMainRegistry } from '../registry.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createBranchCommit(
  root: string,
  args: {
    branch: string;
    baseRef: string;
    returnBranch: string;
    files: Record<string, string>;
    message: string;
  },
): string {
  git(root, ['checkout', '-b', args.branch, args.baseRef]);
  for (const [file, contents] of Object.entries(args.files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents, 'utf8');
  }
  git(root, ['add', ...Object.keys(args.files)]);
  git(root, ['commit', '-m', args.message]);
  const sha = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', args.returnBranch]);
  return sha;
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: 'Docs/story/actives',
  }, null, 2));
}

function writePlanDoc(root: string, relPath: string, body: string): void {
  mkdirSync(dirname(join(root, relPath)), { recursive: true });
  writeFileSync(join(root, relPath), `${body}\n`, 'utf8');
}

function dispatchFromHost(
  cliPath: string,
  root: string,
  packPath: string,
  host: string,
): HostDispatchProjection {
  return JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'lattice',
    'host',
    'dispatch',
    `--host=${host}`,
    `--file=${packPath}`,
    '--mode=supervised',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HostDispatchProjection;
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/core/worker.ts'), 'export const worker = "host-overflow";\n');
  writeFileSync(join(root, 'README.md'), '# host overflow fixture\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'lattice@example.com']);
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-02T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-overflow',
    name: 'host-overflow-smoke',
    title: 'Host overflow smoke story',
    description: 'Smoke story for Proofbound Host Overflow.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: 'story/B-overflow' }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Manual-first overflow',
        status: 'done',
        startTime: now,
        endTime: now,
      },
    ],
  };
  store.writeStory('B-overflow', story);
  store.writeChecklist('B-overflow', checklist);
}

function assertClaudeCodeStatus(result: LatticeHostStatus): void {
  assert.equal(result.schemaVersion, 'lattice.host_status.v1');
  assert.equal(result.host, 'claude-code');
  assert.equal(result.overflowReady, true);
  assert.ok(result.status === 'ready' || result.status === 'degraded');
  assert.equal(result.productionDone, false);
  assert.equal(result.receiptVerified, false);
  assert.equal(result.readiness.edit, 'available');
  assert.equal(result.readiness.shell, 'available');
  assert.equal(result.readiness.test, 'available');
  assert.equal(result.readiness.receipt, 'local-only');
  assert.ok(result.nextAction.length > 0);
}

function buildSemanticEditingProbe(): CapabilityProbe {
  return {
    schemaVersion: 'lattice.capability_probe.v1',
    host: 'semantic-editor',
    requestedHost: 'semantic-editor',
    matchedFallback: false,
    diagnosticOnly: true,
    authorityRules: {
      productionDoneRequiresReceipt: false,
      receiptCapability: 'receipt-verify',
      handoffCanManufactureProductionDone: false,
      proofAdmissibility: 'local-only',
      receiptBundleVerification: 'signed-offline-local',
      reviewQuorum: 'local',
    },
    profile: {
      id: 'semantic-editor',
      label: 'Semantic editor',
      summary: 'Synthetic editing profile used to verify overflow readiness follows capability semantics instead of host-id allowlists.',
      capabilities: [
        { category: 'file-edit', status: 'available', optional: false, note: 'Can edit files.' },
        { category: 'patch-apply', status: 'conditional', optional: true, note: 'Patch support is optional.' },
        { category: 'shell/pty', status: 'conditional', optional: true, note: 'Shell requires manual confirmation.' },
        { category: 'test-execution', status: 'available', optional: true, note: 'Can run tests.' },
        { category: 'browser-automation', status: 'unavailable', optional: true, note: 'No browser support.' },
        { category: 'approval', status: 'available', optional: true, note: 'Can request approval.' },
        { category: 'artifact-display', status: 'unavailable', optional: true, note: 'No artifact UI.' },
        { category: 'evidence-submit', status: 'unavailable', optional: true, note: 'No evidence submit path.' },
        { category: 'receipt-verify', status: 'unavailable', optional: true, note: 'No receipt verifier.' },
        { category: 'multimodal-research', status: 'unavailable', optional: true, note: 'No multimodal tooling.' },
      ],
      degradations: [],
    },
    degradations: [],
  };
}

function assertPack(pack: HandoffPack, head: string): void {
  assert.equal(pack.storyId, 'B-overflow');
  assert.equal(pack.fromHost, 'codex');
  assert.equal(pack.toHost, 'claude-code');
  assert.equal(pack.baseSha, head);
  assert.match(pack.packId, /^HP-[a-f0-9]{12}$/);
  assert.match(pack.packHash, /^sha256:/);
  assert.equal(pack.role, 'overflow-worker');
  assert.equal(pack.objective, 'Implement bounded host overflow changes only.');
  assert.deepEqual(pack.allowedPaths, ['packages/main/src/core/worker.ts']);
  assert.deepEqual(pack.deniedPaths, ['README.md']);
  assert.deepEqual(pack.requiredCommands, ['npm --prefix packages/main run build']);
  assert.deepEqual(pack.successCriteria, ['Do not claim release readiness']);
  assert.equal(pack.authorityBoundary.noAutoTrust, true);
  assert.equal(pack.authorityBoundary.noAutoMerge, true);
  assert.ok(pack.executionInstructions.some(step => /Do not auto-merge/i.test(step)));
}

const root = mkdtempSync(join(tmpdir(), 'lattice-host-overflow-'));
try {
  initRepo(root);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store);
  const head = git(root, ['rev-parse', 'HEAD']);
  const ownerBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const claudeStatus = buildLatticeHostStatus('claude-code');
  assertClaudeCodeStatus(claudeStatus);
  const semanticStatus = buildLatticeHostStatusFromProbe(buildSemanticEditingProbe());
  assert.equal(semanticStatus.host, 'semantic-editor');
  assert.equal(semanticStatus.overflowReady, true);
  assert.equal(semanticStatus.status, 'degraded');
  assert.equal(semanticStatus.readiness.shell, 'conditional');
  assert.equal(semanticStatus.readiness.worktree, 'conditional');
  const runnerStatus = buildLatticeHostStatus('local-runner');
  assert.equal(runnerStatus.status, 'unavailable');
  assert.equal(runnerStatus.overflowReady, false);
  assert.match(runnerStatus.nextAction, /file-edit, shell\/pty, test-execution, and approval/i);

  const pack = createHandoffPack(store, root, {
    storyId: 'B-overflow',
    fromHost: 'codex',
    toHost: 'claude-code',
    role: 'overflow-worker',
    objective: 'Implement bounded host overflow changes only.',
    allowedPaths: ['packages/main/src/core/worker.ts'],
    deniedPaths: ['README.md'],
    requiredCommands: ['npm --prefix packages/main run build'],
    successCriteria: ['Do not claim release readiness'],
  });
  assertPack(pack, head);

  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'host_status'));
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'handoff_receipt_submit'));
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'handoff_worktree_create'));
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'host_dispatch'));
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  assert.equal(registry.has('host_status'), true);
  assert.equal(registry.has('handoff_receipt_submit'), true);
  assert.equal(registry.has('handoff_worktree_create'), true);
  assert.equal(registry.has('host_dispatch'), true);
  assertClaudeCodeStatus(registry.get('host_status')!({ host: 'claude-code', json: true }) as LatticeHostStatus);

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const packPath = join(root, 'handoff-pack.json');
  writeFileSync(packPath, JSON.stringify(pack, null, 2) + '\n', 'utf8');
  const reviewedHead = createBranchCommit(root, {
    branch: 'overflow-reviewed',
    baseRef: head,
    returnBranch: ownerBranch,
    files: {
      'packages/main/src/core/worker.ts': 'export const worker = "host-overflow-reviewed";\n',
    },
    message: 'overflow reviewed',
  });
  const unrelatedHead = createBranchCommit(root, {
    branch: 'overflow-unrelated',
    baseRef: head,
    returnBranch: ownerBranch,
    files: {
      'other.txt': 'unrelated overflow result\n',
    },
    message: 'overflow unrelated',
  });

  const worktree = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'lattice',
    'handoff',
    'worktree',
    'create',
    `--file=${packPath}`,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffWorktreeProjection;
  assert.equal(worktree.schemaVersion, 'lattice.handoff_worktree_create.v1');
  assert.equal(worktree.status, 'projected');
  assert.equal(worktree.created, false);
  assert.equal(worktree.authorityChanged, false);
  assert.equal(worktree.productionDone, false);
  assert.equal(worktree.constraintStatus, 'pass');
  assert.match(worktree.branch, /^overflow\/B-overflow\/HP-/);
  assert.match(worktree.worktreePath, /^\.worktrees\/overflow\/B-overflow\/HP-/);
  assert.match(worktree.cleanupCommand, /git worktree remove/);

  const plannedDispatch = dispatchFromHost(cliPath, root, packPath, 'claude-code');
  assert.equal(plannedDispatch.schemaVersion, 'lattice.host_dispatch.v1');
  assert.equal(plannedDispatch.status, 'planned');
  assert.equal(plannedDispatch.overflowReady, true);
  assert.equal(plannedDispatch.authorityChanged, false);
  assert.equal(plannedDispatch.productionDone, false);
  assert.equal(plannedDispatch.prefetchManifest.verdict, 'no-block');
  assert.equal(plannedDispatch.prefetchManifest.targetStoryId, 'B-overflow');
  assert.equal(plannedDispatch.prefetchManifest.host, 'claude-code');
  assert.equal(plannedDispatch.prefetchManifest.staleSignals.length, 0);
  assert.equal(plannedDispatch.preflight.sessionBrief.status, 'ok');
  assert.equal(plannedDispatch.preflight.devMemoryPreflight.status, 'ok');
  assert.equal(plannedDispatch.preflight.activeStorySummary.status, 'ok');
  assert.equal(plannedDispatch.preflight.doneStorySummary.status, 'ok');
  assert.equal(plannedDispatch.preflight.gapAnalyzeSummary.status, 'ok');
  assert.equal(plannedDispatch.preflight.learningSignalSummary.status, 'ok');
  assert.equal(plannedDispatch.preflight.supersession.status, 'none');
  assert.equal(plannedDispatch.prefetchManifest.winSignal, 'activeStorySummary/gapAnalyze/learningValidate');
  assert.match(plannedDispatch.nextAction, /planned only/i);

  const baselineDocPath = 'Docs/story/actives/B-overflow/completion-note.md';
  writePlanDoc(root, baselineDocPath, `---
supersession:
  status: completed
  completedByStory: B-overflow
  completionCommit: ${head}
  completionNote: baseline completion evidence
  updatedAt: 2026-06-20
---

Baseline note.
`);
  const baseChecklist = store.readChecklist('B-overflow');
  store.writeChecklist('B-overflow', {
    ...baseChecklist,
    items: baseChecklist.items.map((item) => ({
      ...item,
      relatedDocs: [baselineDocPath],
    })),
  });

  const sameStorySupersessionDispatch = dispatchFromHost(cliPath, root, packPath, 'claude-code');
  assert.equal(sameStorySupersessionDispatch.prefetchManifest.verdict, 'uncertain');
  assert.equal(sameStorySupersessionDispatch.prefetchManifest.winSignal, 'supersession(B-overflow)');
  assert.equal(sameStorySupersessionDispatch.preflight.supersession.status, 'present');
  assert.equal(sameStorySupersessionDispatch.preflight.supersession.winner, 'B-overflow');

  writePlanDoc(root, baselineDocPath, `---
supersession:
  status: completed
  completedByStory: B-other
  completionCommit: ${head}
  completionNote: another story completion evidence
  updatedAt: 2026-06-20
---

Historical completion in another story.
`);
  const replacedStorySupersessionDispatch = dispatchFromHost(cliPath, root, packPath, 'claude-code');
  assert.equal(replacedStorySupersessionDispatch.prefetchManifest.verdict, 'uncertain');
  assert.equal(replacedStorySupersessionDispatch.prefetchManifest.winSignal, 'requires_revalidation');
  assert.equal(replacedStorySupersessionDispatch.preflight.supersession.status, 'stale');
  assert.equal(replacedStorySupersessionDispatch.prefetchManifest.staleSignals.length, 1);

  writePlanDoc(root, baselineDocPath, `# Missing supersession frontmatter\n\nNo yaml header.`);
  const invalidSupersessionDispatch = dispatchFromHost(cliPath, root, packPath, 'claude-code');
  assert.equal(invalidSupersessionDispatch.prefetchManifest.verdict, 'uncertain');
  assert.equal(invalidSupersessionDispatch.prefetchManifest.winSignal, 'requires_revalidation');
  assert.equal(invalidSupersessionDispatch.preflight.supersession.status, 'invalid');
  assert.ok(invalidSupersessionDispatch.prefetchManifest.staleSignals.length >= 1);

  const beforeDoneStory = store.readStory('B-overflow');
  const beforeDoneEvents = Array.isArray(beforeDoneStory.events) ? beforeDoneStory.events : [];
  store.writeStory('B-overflow', {
    ...beforeDoneStory,
    phase: 'DONE',
    endedAt: new Date().toISOString(),
    events: [...beforeDoneEvents, { phase: 'DONE', action: 'advance', timestamp: new Date().toISOString() }],
  });
  const doneDispatch = dispatchFromHost(cliPath, root, packPath, 'claude-code');
  assert.equal(doneDispatch.prefetchManifest.verdict, 'blocked');
  assert.equal(doneDispatch.prefetchManifest.winSignal, 'activeStorySummary.phase=DONE');

  const unavailableDispatch = registry.get('host_dispatch')!({
    host: 'local-runner',
    file: packPath,
    mode: 'supervised',
    format: 'json',
  }) as HostDispatchProjection;
  assert.equal(unavailableDispatch.status, 'unavailable');
  assert.equal(unavailableDispatch.overflowReady, false);

  const goodReceipt: HandoffReceipt = {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: pack.storyId,
    host: 'claude-code',
    packId: pack.packId,
    packHash: pack.packHash,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    baseSha: pack.baseSha,
    role: pack.role,
    objective: pack.objective,
    allowedPaths: pack.allowedPaths,
    deniedPaths: pack.deniedPaths,
    requiredCommands: pack.requiredCommands,
    successCriteria: pack.successCriteria,
    authorityBoundary: pack.authorityBoundary,
    executionInstructions: pack.executionInstructions,
    headSha: reviewedHead,
    changedFiles: ['packages/main/src/core/worker.ts'],
    commands: ['npm --prefix packages/main run build'],
    verdict: 'pass',
    summary: 'Overflow worker completed a bounded code change.',
    limitations: [],
  };
  const goodReceiptPath = join(root, 'receipt-good.json');
  writeFileSync(goodReceiptPath, JSON.stringify(goodReceipt, null, 2) + '\n', 'utf8');
  const accepted = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'lattice',
    'handoff',
    'receipt',
    'submit',
    `--file=${goodReceiptPath}`,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffReceiptSubmission;
  assert.equal(accepted.status, 'accepted-local');
  assert.equal(accepted.scopeStatus, 'pass');
  assert.equal(accepted.freshness, 'fresh');
  assert.equal(accepted.receiptVerified, false);
  assert.equal(accepted.productionDone, false);
  assert.equal(accepted.validations.headSha, 'pass');
  assert.equal(accepted.validations.headCommit, 'pass');

  const invalidHeadReceiptPath = join(root, 'receipt-invalid-head.json');
  writeFileSync(invalidHeadReceiptPath, JSON.stringify({
    ...goodReceipt,
    headSha: 'not-a-real-commit',
    limitations: ['invalid headSha for smoke'],
  }, null, 2) + '\n', 'utf8');
  const invalidHead = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_receipt_submit',
    `--file=${invalidHeadReceiptPath}`,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffReceiptSubmission;
  assert.equal(invalidHead.status, 'diagnostic');
  assert.equal(invalidHead.validations.headSha, 'fail');
  assert.equal(invalidHead.validations.headCommit, 'fail');
  assert.ok(invalidHead.warnings.some(warning => /could not be resolved/i.test(warning)));

  const unrelatedHeadReceiptPath = join(root, 'receipt-unrelated-head.json');
  writeFileSync(unrelatedHeadReceiptPath, JSON.stringify({
    ...goodReceipt,
    headSha: unrelatedHead,
    limitations: ['unrelated existing headSha for smoke'],
  }, null, 2) + '\n', 'utf8');
  const unrelatedHeadReceipt = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_receipt_submit',
    `--file=${unrelatedHeadReceiptPath}`,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffReceiptSubmission;
  assert.equal(unrelatedHeadReceipt.status, 'diagnostic');
  assert.equal(unrelatedHeadReceipt.validations.headSha, 'pass');
  assert.equal(unrelatedHeadReceipt.validations.headCommit, 'fail');
  assert.equal(unrelatedHeadReceipt.scopeStatus, 'fail');
  assert.ok(unrelatedHeadReceipt.warnings.some(warning => /not represented in git diff/i.test(warning)));

  const badReceiptPath = join(root, 'receipt-bad.json');
  writeFileSync(badReceiptPath, JSON.stringify({
    ...goodReceipt,
    packHash: 'sha256:tampered',
    changedFiles: ['README.md'],
    limitations: ['tampered for smoke'],
  }, null, 2) + '\n', 'utf8');
  const rejected = registry.get('handoff_receipt_submit')!({
    file: badReceiptPath,
    format: 'json',
  }) as HandoffReceiptSubmission;
  assert.equal(rejected.status, 'diagnostic');
  assert.equal(rejected.validations.packHash, 'fail');
  assert.equal(rejected.scopeStatus, 'fail');

  writeFileSync(join(root, 'packages/main/src/core/worker.ts'), 'export const worker = "host-overflow-stale";\n');
  git(root, ['add', 'packages/main/src/core/worker.ts']);
  git(root, ['commit', '-m', 'stale']);
  const staleReceiptPath = join(root, 'receipt-stale.json');
  writeFileSync(staleReceiptPath, JSON.stringify(goodReceipt, null, 2) + '\n', 'utf8');
  const stale = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_receipt_submit',
    `--file=${staleReceiptPath}`,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffReceiptSubmission;
  assert.equal(stale.status, 'diagnostic');
  assert.equal(stale.freshness, 'stale');
  assert.ok(stale.warnings.some(warning => /materialhash|HEAD/i.test(warning)));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ host overflow smoke passed');
