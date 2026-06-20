#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import {
  upsertAuthorityGateReceiptRef,
  type AuthorityGateDecisionReceiptRef,
} from '../core/authority-gate-receipts.js';
import type { ChecklistData, ClosingSelfCheck, DocsPromise, ProcessEvent, RealMachineTest, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const COMMIT_ENV = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke'];

interface RepoOptions {
  storyId: string;
  phase?: StoryInfo['phase'];
  validateCommand?: string;
  changedFile?: { path: string; content: string };
  staleEvidence?: 'safe' | 'command';
  storyHashCommandEvidence?: boolean;
  hostVerdict?: boolean;
  staleHostVerdict?: boolean;
  baseConflictFile?: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function runLattice(
  cwd: string,
  command: string,
  args: Record<string, unknown>,
  envOverrides: Record<string, string | undefined> = {},
): string {
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
  for (const key of Object.keys(env)) {
    if (key.startsWith('LATTICE_AUTHORITY_')) delete (env as Record<string, string | undefined>)[key];
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete (env as Record<string, string | undefined>)[key];
    else env[key] = value;
  }
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function status(root: string): string {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function writeDoneGateEvidence(store: StoryStore, root: string, storyId: string): void {
  const now = '2026-06-19T12:00:00.000Z';
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  store.writeTestEvidence(storyId, {
    command: 'done-prepare-smoke',
    output: JSON.stringify({ allPass: true, summary: 'done prepare smoke ready' }),
    result: 'PASS',
    timestamp: now,
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root),
    ...(storyFilesHash ? { storyFilesHash } : {}),
    verificationCoverage: {
      total: 0,
      required: 0,
      covered: 0,
      missingRequired: 0,
      entries: [],
    },
  });

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'done_prepare smoke synthetic evidence covers the local ready path.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'done_prepare smoke closure evidence is complete.',
  };
  store.writeDeliveryCheck(storyId, {
    storyId,
    checkedAt: now,
    reviewRound: '',
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, ''),
  });
}

function appendHostVerdict(store: StoryStore, root: string, storyId: string): void {
  const materialHash = currentMaterialHash(root);
  assert.ok(materialHash, 'smoke repo must have a material hash for host verdict');
  const event: Omit<ProcessEvent, 'timestamp'> = {
    type: 'host_verdict',
    verdictId: `${storyId}-round-1-local`,
    runId: `${storyId}-round-1`,
    hostId: 'local-smoke-host',
    provider: 'local-smoke',
    sessionId: 'local-smoke-session',
    keyId: 'local-smoke-key',
    decision: 'pass',
    materialDigest: materialHash,
    validationDigest: `${storyId}-validation`,
    promptDigest: `${storyId}-prompt`,
  };
  store.appendProcessEvent(storyId, event);
}

function authorityDoneRefFor(root: string, storyId: string): AuthorityGateDecisionReceiptRef {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  assert.ok(headHash, 'smoke repo must have git HEAD');
  assert.ok(materialHash, 'smoke repo must have material hash');
  return {
    receiptId: 'AR-DONE-PREPARE',
    receiptKind: 'gate_decision',
    classification: 'production-gate-decision',
    authorityUrl: 'https://authority.example',
    authorityKeyId: 'server-key-1',
    authorityPublicKeyDigest: 'sha256:key',
    decisionId: 'GD-DONE-PREPARE',
    stateVersion: 7,
    gateInputDigest: 'sha256:input-done-prepare',
    decisionDigest: 'sha256:decision-done-prepare',
    decisionVerdict: 'pass',
    storyId,
    targetPhase: 'DONE',
    headHash,
    materialHash,
    policyMode: 'light',
    authorityMode: 'enforce',
    producerRunIds: ['run-producer-1'],
    verifierRunIds: ['run-verifier-1'],
    runnerSessionIds: ['session-1'],
    evidenceDigests: ['sha256:evidence-1'],
    verifiedAt: new Date().toISOString(),
    verifiedBy: 'lattice authority receipt verify',
    eligibleGates: ['DONE'],
    status: 'active',
    consumptionEvents: [],
  };
}

function ignoreWorktreePath(root: string, relPath: string): void {
  const excludePath = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  appendFileSync(isAbsolute(excludePath) ? excludePath : join(root, excludePath), `\n/${relPath}\n`, 'utf-8');
}

function writeIgnoredAuthorityDoneRef(root: string, storyId: string): void {
  const relPath = `.lattice/story/actives/${storyId}/authority-receipt-refs.json`;
  ignoreWorktreePath(root, relPath);
  const store = new StoryStore(root);
  const ref = authorityDoneRefFor(root, storyId);
  store.writeAuthorityReceiptRefs(storyId, upsertAuthorityGateReceiptRef(undefined, ref, ref.verifiedAt!));
}

function writeStaleChecklistEvidence(store: StoryStore, root: string, storyId: string, mode: 'safe' | 'command'): void {
  const oldHead = currentGitHead(root);
  const oldMaterial = currentMaterialHash(root);
  assert.ok(oldHead, 'smoke repo must have old head for stale evidence');
  assert.ok(oldMaterial, 'smoke repo must have old material hash for stale evidence');
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'stale evidence smoke intent', type: 'cli', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: mode === 'command' ? 'logic_test' : 'manual_transcript',
        ...(mode === 'command' ? { command: 'npm run test:done-prepare-smoke-rerun' } : {}),
        result: 'pass',
        note: 'stale evidence smoke record',
        headHash: oldHead,
        materialHash: oldMaterial,
      }],
    }],
  };
  store.writeChecklist(storyId, checklist);
}

function writeStoryHashCommandChecklistEvidence(store: StoryStore, root: string, storyId: string): void {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  assert.ok(headHash, 'smoke repo must have head for storyFilesHash evidence');
  assert.ok(materialHash, 'smoke repo must have material hash for storyFilesHash evidence');
  assert.ok(storyFilesHash, 'smoke repo must have storyFilesHash for storyFilesHash evidence');
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'storyFilesHash evidence smoke intent', type: 'cli', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        command: 'npm run test:done-prepare-smoke-rerun',
        result: 'pass',
        note: 'storyFilesHash command evidence smoke record',
        headHash,
        materialHash,
        storyFilesHash,
      }],
    }],
  };
  store.writeChecklist(storyId, checklist);
}

function buildRepo(options: RepoOptions): { root: string; worktreePath: string } {
  const root = mkdtempSync(join(tmpdir(), `lattice-done-prepare-${options.storyId}-`));
  const validate = options.validateCommand
    ? { validate: { commands: [{ label: 'done-prepare-smoke', command: options.validateCommand, shell: true }] } }
    : {};
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
    ...validate,
  }, null, 2));
  write(root, '.gitignore', '.worktrees/\n.lattice/activity.jsonl\n');
  write(root, 'README.md', `done_prepare smoke ${options.storyId}\n`);
  if (options.baseConflictFile) write(root, 'conflict.txt', 'base\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'base']);
  resetConfigCache();

  const now = '2026-06-19T12:00:00.000Z';
  const phase = options.phase ?? 'TEST';
  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: options.storyId,
    name: 'done-prepare-smoke',
    title: `done_prepare smoke ${options.storyId}`,
    description: 'Synthetic TEST story for done_prepare smoke coverage.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    worktree: {
      path: `.worktrees/${options.storyId}`,
      branch: `story/${options.storyId}`,
      createdAt: now,
    },
    events: [{ phase, action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(options.storyId, story);
  store.writeChecklist(options.storyId, checklist);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story metadata']);
  git(root, ['branch', `story/${options.storyId}`]);

  const worktreePath = join(root, '.worktrees', options.storyId);
  git(root, ['worktree', 'add', worktreePath, `story/${options.storyId}`]);
  resetConfigCache();

  const worktreeStore = new StoryStore(worktreePath);
  if (options.staleEvidence) {
    writeStaleChecklistEvidence(worktreeStore, worktreePath, options.storyId, options.staleEvidence);
  }
  if (options.staleHostVerdict) {
    appendHostVerdict(worktreeStore, worktreePath, options.storyId);
  }
  if (options.changedFile) {
    write(worktreePath, options.changedFile.path, options.changedFile.content);
  }
  if (options.staleEvidence || options.changedFile) {
    git(worktreePath, ['add', '.']);
    git(worktreePath, [...COMMIT_ENV, 'commit', '-m', 'story material']);
  }
  if (options.hostVerdict) {
    appendHostVerdict(worktreeStore, worktreePath, options.storyId);
  }
  if (options.storyHashCommandEvidence) {
    writeStoryHashCommandChecklistEvidence(worktreeStore, worktreePath, options.storyId);
  }
  writeDoneGateEvidence(worktreeStore, worktreePath, options.storyId);
  git(worktreePath, ['add', '.']);
  git(worktreePath, [...COMMIT_ENV, 'commit', '-m', 'story ready']);
  return { root, worktreePath };
}

function withRepo(name: string, options: RepoOptions, fn: (repo: { root: string; worktreePath: string }) => void): void {
  const repo = buildRepo(options);
  try {
    fn(repo);
    console.log(`  ✓ ${name}`);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}

function assertBlocked(output: string, blockedAt: string): void {
  assert.match(output, /DONE prepare: BLOCKED/);
  assert.match(output, new RegExp(`blockedAt: ${blockedAt}`));
}

withRepo('clean ready path prints exactly one DONE next command', { storyId: 'B-dp-clean' }, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-clean', validate: false });
  assert.match(output, /DONE prepare: PASS/);
  assert.match(output, /localDoneReady: true/);
  assert.match(output, /authorityDone: false/);
  assert.match(output, /fullAuthorityDone: false/);
  assert.match(output, /productionDone: false/);
  const matches = output.match(/lattice story_advance/g) || [];
  assert.equal(matches.length, 1, output);
});

withRepo('authority receipt verified runbook still prints local-only PASS boundary', {
  storyId: 'B-dp-receipt-boundary',
}, ({ worktreePath }) => {
  writeIgnoredAuthorityDoneRef(worktreePath, 'B-dp-receipt-boundary');
  assert.equal(status(worktreePath), '', 'precondition: ignored receipt ref must not make done_prepare preflight dirty');

  const runbook = JSON.parse(runLattice(
    worktreePath,
    'done_closure',
    { storyId: 'B-dp-receipt-boundary', json: true },
    { LATTICE_AUTHORITY_MODE: 'enforce' },
  ));
  assert.equal(runbook.authorityServerPath.receiptVerified, true, 'precondition: done_closure runbook reaches receiptVerified=true');

  const output = runLattice(
    worktreePath,
    'done_prepare',
    { storyId: 'B-dp-receipt-boundary', validate: false },
    { LATTICE_AUTHORITY_MODE: 'enforce' },
  );
  assert.match(output, /DONE prepare: PASS/);
  assert.match(output, /authorityReceiptRequired: true/);
  assert.doesNotMatch(output, /receiptVerified: true/);
  assert.match(output, /receiptVerified: false \(not evaluated by done_prepare; Authority receipt verification is outside done_prepare\)/);
  assert.match(output, /authorityDone: false/);
  assert.match(output, /fullAuthorityDone: false/);
  assert.match(output, /productionDone: false/);
  assert.doesNotMatch(output, /authorityDone: true/);
  assert.doesNotMatch(output, /fullAuthorityDone: true/);
  assert.doesNotMatch(output, /productionDone: true/);
});

withRepo('dirty preflight blocks before mutation', { storyId: 'B-dp-dirty' }, ({ worktreePath }) => {
  write(worktreePath, 'dirty.txt', 'dirty\n');
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-dirty', validate: false });
  assertBlocked(output, 'cleanTree');
  assert.match(output, /dirty\.txt/);
});

withRepo('non-TEST phase blocks before mutation', {
  storyId: 'B-dp-dev-phase',
  phase: 'DEV',
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-dev-phase', validate: false });
  assertBlocked(output, 'preflight');
  assert.match(output, /only runs for TEST stories/);
  assert.match(output, /story_advance '\{"storyId":"B-dp-dev-phase","phase":"TEST"\}'/);
});

withRepo('wrong cwd blocks before mutation', { storyId: 'B-dp-wrong-cwd' }, ({ root }) => {
  const output = runLattice(root, 'done_prepare', { storyId: 'B-dp-wrong-cwd', validate: false });
  assertBlocked(output, 'preflight');
  assert.match(output, /current cwd is not the requested story worktree/);
});

withRepo('wrong branch blocks before mutation', { storyId: 'B-dp-wrong-branch' }, ({ worktreePath }) => {
  git(worktreePath, ['checkout', '-b', 'not-the-story-branch']);
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-wrong-branch', validate: false });
  assertBlocked(output, 'preflight');
  assert.match(output, /expected story\/B-dp-wrong-branch/);
});

withRepo('missing local main blocks before mutation', { storyId: 'B-dp-missing-main' }, ({ root, worktreePath }) => {
  git(root, ['checkout', '--detach']);
  git(root, ['branch', '-D', 'main']);
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-missing-main', validate: false });
  assertBlocked(output, 'preflight');
  assert.match(output, /local main cannot be found/);
});

withRepo('stale refresh disabled blocks with refresh guidance', {
  storyId: 'B-dp-stale-disabled',
  staleEvidence: 'safe',
  changedFile: { path: 'docs/requirements/decisions/stale-disabled.md', content: '# stale disabled\n' },
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', {
    storyId: 'B-dp-stale-disabled',
    validate: false,
    refreshStale: false,
  });
  assertBlocked(output, 'evidenceFreshness');
  assert.match(output, /verification_evidence_refresh_stale --storyId=B-dp-stale-disabled/);
});

withRepo('validate fail stops before DONE guidance', {
  storyId: 'B-dp-validate-fail',
  validateCommand: 'node -e "process.exit(1)"',
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-validate-fail', mergeMain: false });
  assertBlocked(output, 'validate');
  assert.doesNotMatch(output, /lattice story_advance/);
});

withRepo('runtime source diff reports post-DONE version bump required', {
  storyId: 'B-dp-runtime',
  changedFile: { path: 'packages/main/src/handlers/done-prepare-runtime-smoke.ts', content: 'export const smoke = 1;\n' },
  hostVerdict: true,
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-runtime', validate: false });
  assert.match(output, /DONE prepare: PASS/);
  assert.match(output, /postDoneRuntimeVersionBumpRequired: true/);
  assert.match(output, /packages\/main\/src\/handlers\/done-prepare-runtime-smoke\.ts/);
});

withRepo('docs-only diff reports no post-DONE version bump required', {
  storyId: 'B-dp-docs',
  changedFile: { path: 'docs/requirements/decisions/done-prepare-docs-smoke.md', content: '# docs smoke\n' },
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-docs', validate: false });
  assert.match(output, /DONE prepare: PASS/);
  assert.match(output, /postDoneRuntimeVersionBumpRequired: false/);
  assert.match(output, /runtimeChangeClassification: docs-only/);
});

withRepo('validate-created metadata blocks at final cleanTree', {
  storyId: 'B-dp-post-mutation',
  validateCommand: 'node -e "console.log(\'pass\')"',
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-post-mutation', mergeMain: false });
  assertBlocked(output, 'cleanTree');
  assert.match(output, /test-evidence\.json/);
});

withRepo('safe stale refresh auto-commit blocks with generated commit guidance', {
  storyId: 'B-dp-refresh-commit',
  staleEvidence: 'safe',
  changedFile: { path: 'docs/requirements/decisions/refresh-commit.md', content: '# refresh commit\n' },
}, ({ worktreePath }) => {
  const beforeHead = currentGitHead(worktreePath);
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-refresh-commit', validate: false });
  const afterHead = currentGitHead(worktreePath);
  assert.notEqual(afterHead, beforeHead, output);
  assertBlocked(output, 'cleanTree');
  assert.match(output, /commits:/);
  assert.match(output, /lattice: record B-dp-refresh-commit verification_evidence_refresh_stale metadata/);
  assert.match(output, /rerun lattice done_prepare from the new HEAD/);
  assert.doesNotMatch(output, /DONE prepare: PASS/);
});

withRepo('merge conflict blocks at mergeMain', {
  storyId: 'B-dp-conflict',
  baseConflictFile: true,
}, ({ root, worktreePath }) => {
  write(worktreePath, 'conflict.txt', 'story\n');
  git(worktreePath, ['add', 'conflict.txt']);
  git(worktreePath, [...COMMIT_ENV, 'commit', '-m', 'story conflict side']);
  write(root, 'conflict.txt', 'main\n');
  git(root, ['add', 'conflict.txt']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'main conflict side']);
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-conflict', validate: false });
  assertBlocked(output, 'mergeMain');
  assert.match(output, /conflict\.txt/);
});

withRepo('command-backed stale evidence requires rerun', {
  storyId: 'B-dp-rerun',
  staleEvidence: 'command',
  changedFile: { path: 'docs/requirements/decisions/rerun-stale.md', content: '# rerun stale\n' },
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-rerun', validate: false });
  assertBlocked(output, 'evidenceFreshness');
  assert.match(output, /npm run test:done-prepare-smoke-rerun/);
  assert.match(output, /will not freshen it by rewriting hashes/);
});

withRepo('matching storyFilesHash command evidence survives unrelated main material drift', {
  storyId: 'B-dp-story-hash',
  storyHashCommandEvidence: true,
  changedFile: { path: 'docs/requirements/decisions/story-hash-evidence.md', content: '# story hash evidence\n' },
}, ({ root, worktreePath }) => {
  write(root, 'README.md', 'done_prepare smoke B-dp-story-hash\n\nmain-only drift\n');
  git(root, ['add', 'README.md']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'main material drift']);

  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-story-hash', validate: false });
  assert.match(output, /DONE prepare: PASS/);
  assert.match(output, /staleEvidenceRefresh: PASS/);
  assert.doesNotMatch(output, /stale command-backed evidence must be rerun/);
  assert.doesNotMatch(output, /npm run test:done-prepare-smoke-rerun/);
});

withRepo('stale review material blocks without verdict rebind', {
  storyId: 'B-dp-stale-review',
  staleHostVerdict: true,
  changedFile: { path: 'packages/main/src/handlers/stale-review-material-smoke.ts', content: 'export const staleReview = 1;\n' },
}, ({ worktreePath }) => {
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-stale-review', validate: false });
  assertBlocked(output, 'doneClosure');
  assert.match(output, /review-assurance-floor/);
  assert.match(output, /review_escalation_status/);
  assert.match(output, /autopilot_review_submit/);
  assert.doesNotMatch(output, /localDoneReady: true/);
  assert.doesNotMatch(output, /authorityDone: true/);
  assert.doesNotMatch(output, /productionDone: true/);
});

withRepo('dryRun reports without mutation', { storyId: 'B-dp-dryrun' }, ({ worktreePath }) => {
  const before = status(worktreePath);
  const output = runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-dryrun', dryRun: true });
  const after = status(worktreePath);
  assert.equal(after, before, output);
  assert.match(output, /DONE prepare: PASS/);
  assert.match(output, /dryRun: true/);
});

withRepo('dryRun skips planned merge refresh validate and build mutations', {
  storyId: 'B-dp-dryrun-planned',
  staleEvidence: 'safe',
  changedFile: { path: 'docs/requirements/decisions/dryrun-stale.md', content: '# dryRun stale\n' },
}, ({ root, worktreePath }) => {
  write(root, 'main-ahead.txt', 'main ahead\n');
  git(root, ['add', 'main-ahead.txt']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'main ahead']);

  const checklistPath = join(worktreePath, '.lattice/story/actives/B-dp-dryrun-planned/checklist.json');
  const beforeStatus = status(worktreePath);
  const beforeHead = currentGitHead(worktreePath);
  const beforeChecklist = readFileSync(checklistPath, 'utf-8');
  const output = runLattice(worktreePath, 'done_prepare', {
    storyId: 'B-dp-dryrun-planned',
    dryRun: true,
    build: true,
  });
  assert.equal(status(worktreePath), beforeStatus, output);
  assert.equal(currentGitHead(worktreePath), beforeHead, output);
  assert.equal(readFileSync(checklistPath, 'utf-8'), beforeChecklist, output);
  assert.match(output, /mergeMain: SKIPPED.*planned mutation skipped: dryRun would run git merge main/);
  assert.match(output, /staleEvidenceRefresh: SKIPPED.*planned mutation skipped: dryRun would refresh 1 metadata-only stale evidence item/);
  assert.match(output, /validate: SKIPPED.*planned mutation skipped: dryRun does not run lattice validate/);
  assert.match(output, /worktreeVersionCheck: SKIPPED.*planned mutation skipped: dryRun does not build/);
});

withRepo('version bump mode is rejected by command schema', { storyId: 'B-dp-version-reject' }, ({ worktreePath }) => {
  try {
    runLattice(worktreePath, 'done_prepare', { storyId: 'B-dp-version-reject', versionBump: 'patch' });
  } catch (err: any) {
    const output = `${err?.stdout?.toString?.() ?? ''}\n${err?.stderr?.toString?.() ?? ''}`;
    assert.match(output, /versionBump/);
    return;
  }
  assert.fail('versionBump input should be rejected');
});

const thisSource = readFileSync(new URL(import.meta.url), 'utf-8');
assert.match(thisSource, /authorityDone: false/, 'smoke must assert authorityDone false wording');
assert.match(thisSource, /productionDone: false/, 'smoke must assert productionDone false wording');

console.log('✓ done-prepare smoke passed');
