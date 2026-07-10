#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  EMPTY_STORY_FILES_HASH,
} from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  ClosingSelfCheck,
  DeliveryCheckData,
  DocsPromise,
  RealMachineTest,
  StoryInfo,
  TestEvidenceData,
} from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createDonePrepareHandlers } from '../handlers/done-prepare.js';

const NOW = '2026-07-10T00:00:00.000Z';
const STORY_ID = 'B-done-prepare-merge-rerun';
const MAIN_ONLY_PATH = 'notes/main-only.txt';

interface Fixture {
  root: string;
  storyId: string;
}

interface FixtureOptions {
  validateWritesMetadata?: boolean;
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function gitIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: 'done-prepare-merge-rerun-smoke',
    GIT_AUTHOR_EMAIL: 'done-prepare-merge-rerun-smoke@example.test',
    GIT_COMMITTER_NAME: 'done-prepare-merge-rerun-smoke',
    GIT_COMMITTER_EMAIL: 'done-prepare-merge-rerun-smoke@example.test',
  };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...gitIdentityEnv(),
    },
  }).trim();
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function mkCtx(root: string): HandlerContext {
  resetConfigCache();
  return {
    root,
    scanRoot: root,
    store: new StoryStore(root),
  };
}

function readTreeSnapshot(root: string, relDir: string): Record<string, string> {
  const base = join(root, relDir);
  const snapshot: Record<string, string> = {};
  if (!existsSync(base)) return snapshot;
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        snapshot[relative(base, path).replace(/\\/g, '/')] = readFileSync(path).toString('base64');
      }
    }
  };
  visit(base);
  return snapshot;
}

function seedDoneGateEvidence(root: string, storyId: string): void {
  const store = new StoryStore(root);
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const rawStoryFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  const storyFilesHash = rawStoryFilesHash && rawStoryFilesHash !== EMPTY_STORY_FILES_HASH
    ? rawStoryFilesHash
    : undefined;
  assert.ok(headHash, 'fixture must have a git HEAD');
  assert.ok(materialHash, 'fixture must have a material hash');

  const testEvidence: TestEvidenceData = {
    command: 'done_prepare merge/rerun smoke seed',
    output: JSON.stringify({ allPass: true, summary: 'synthetic seed validation passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
    ...(rawStoryFilesHash ? { storyFilesHash: rawStoryFilesHash } : {}),
  };
  store.writeTestEvidence(storyId, testEvidence);

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'done-prepare-merge-rerun',
    transcript: 'Synthetic fixture proves done_prepare merge/rerun guidance.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Synthetic delivery check covers done_prepare merge/rerun guidance.',
  };
  const deliveryCheck: DeliveryCheckData = {
    storyId,
    checkedAt: NOW,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    reviewRound: NOW,
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, NOW, materialHash, storyFilesHash),
  };
  store.writeDeliveryCheck(storyId, deliveryCheck);
}

function setupFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-prepare-merge-rerun-'));
  const config: Record<string, unknown> = {
    scanRoot: '.',
    rootDir: '.',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    staleThresholds: {
      phaseStale: 10_000_000,
      itemStale: 10_000_000,
      idleLattice: 10_000_000,
      bugStale: 10_000_000,
    },
  };
  if (options.validateWritesMetadata) {
    config.validate = {
      commands: [{
        label: 'smoke validate',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 2000,
      }],
    };
    config.doneRequiredCommands = [{
      label: 'smoke DONE-required validation',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 2000,
    }];
  }

  write(root, 'lattice.config.json', JSON.stringify(config, null, 2) + '\n');
  write(root, '.gitignore', [
    '.lattice/activity.jsonl',
    '.lattice/learning/runtime-memory-pack-cache/',
    '.lattice/locks/',
    '',
  ].join('\n'));
  write(root, 'README.md', '# done_prepare merge/rerun fixture\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed done_prepare merge/rerun fixture');
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);

  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, {
    storyId: STORY_ID,
    name: 'done-prepare-merge-rerun',
    title: 'done_prepare merge/rerun smoke',
    description: 'Synthetic TEST story for done_prepare merge/rerun UX coverage.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    currentReviewRound: NOW,
    riskSignals: [],
    worktree: {
      path: root,
      branch: `story/${STORY_ID}`,
      createdAt: NOW,
    },
    events: [{ phase: 'TEST', action: 'advance', timestamp: NOW }],
  } as StoryInfo);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Merge/rerun smoke fixture',
      context: 'Synthetic done item for done_prepare merge/rerun coverage.',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  } as ChecklistData);
  seedDoneGateEvidence(root, STORY_ID);
  commitAll(root, 'seed done_prepare merge/rerun story metadata');
  assert.equal(git(root, ['status', '--porcelain']), '', 'fixture must start clean');
  return { root, storyId: STORY_ID };
}

async function runDonePrepare(root: string, storyId: string, args: Record<string, unknown>): Promise<string> {
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    return String(await createDonePrepareHandlers(mkCtx(root)).done_prepare({ storyId, ...args }));
  } finally {
    process.chdir(oldCwd);
  }
}

function assertNoSelfAttestationLanguage(text: string): void {
  const forbidden = [
    /owner\/main can self[- ]attest/i,
    /\bmain(?: agent| session)? can self[- ](?:sign|attest)/i,
    /\bowner(?: session)? can self[- ](?:sign|attest)/i,
    /self[- ]attest(?:ed|ing)? (?:reviewer|host|fallback) evidence/i,
    /self[- ]sign(?:ed|ing)? (?:reviewer|host|fallback) evidence/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(text, pattern, `guidance must not imply reviewer/host/fallback self-attestation:\n${text}`);
  }
}

async function assertUntrackedOverwriteHazard(): Promise<void> {
  const { root, storyId } = setupFixture();
  try {
    git(root, ['checkout', 'main']);
    write(root, MAIN_ONLY_PATH, 'tracked on main\n');
    commitAll(root, 'add main-only tracked file');
    git(root, ['checkout', `story/${storyId}`]);
    write(root, MAIN_ONLY_PATH, 'local untracked work\n');

    const statusBefore = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    const storyBefore = readTreeSnapshot(root, `.lattice/story/actives/${storyId}`);
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const transcript = await runDonePrepare(root, storyId, {
      mergeMain: true,
      refreshStale: false,
      validate: false,
    });

    assert.match(transcript, /^DONE prepare: BLOCKED/, transcript);
    assert.match(transcript, new RegExp(`merge hazard: untracked file would be overwritten: ${MAIN_ONLY_PATH}`));
    assert.match(transcript, /safe next step: preserve or move the file, then rerun done_prepare/);
    assert.match(transcript, new RegExp(`files:\\n  - ${MAIN_ONLY_PATH}`));
    assert.match(transcript, /dirty file classification:/);
    assert.doesNotMatch(transcript, /\b(?:stash|git add|git commit|delete)\b/i);
    assertNoSelfAttestationLanguage(transcript);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore, 'hazard block must not merge or commit');
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
      statusBefore,
      'hazard block must leave git status unchanged',
    );
    assert.deepEqual(
      readTreeSnapshot(root, `.lattice/story/actives/${storyId}`),
      storyBefore,
      'hazard block must leave story metadata byte-identical',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertGeneratedMetadataGuidance(): Promise<void> {
  const { root, storyId } = setupFixture({ validateWritesMetadata: true });
  try {
    const transcript = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: false,
      validate: true,
    });

    assert.match(transcript, /^DONE prepare: BLOCKED/, transcript);
    assert.ok(
      transcript.includes('done_prepare re-run reason:') || transcript.includes('generated by this done_prepare run:'),
      transcript,
    );
    assert.match(transcript, /generated by this done_prepare run:/);
    assert.match(transcript, new RegExp(`\\.lattice/story/actives/${storyId}/test-evidence\\.json`));
    assert.match(transcript, new RegExp(`\\.lattice/story/actives/${storyId}/done-required-evidence\\.json`));
    assertNoSelfAttestationLanguage(transcript);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDryRunNoMutation(): Promise<void> {
  const { root, storyId } = setupFixture({ validateWritesMetadata: true });
  try {
    const statusBefore = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    const storyBefore = readTreeSnapshot(root, `.lattice/story/actives/${storyId}`);
    const transcript = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: false,
      validate: true,
      dryRun: true,
    });

    assert.match(transcript, /^DONE prepare: (?:PASS|BLOCKED)/, transcript);
    assert.match(transcript, /^dryRun: no files will be written$/m);
    assertNoSelfAttestationLanguage(transcript);
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
      statusBefore,
      'dryRun must leave git status unchanged',
    );
    assert.deepEqual(
      readTreeSnapshot(root, `.lattice/story/actives/${storyId}`),
      storyBefore,
      'dryRun must leave story metadata byte-identical',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void (async () => {
  try {
    await assertUntrackedOverwriteHazard();
    await assertGeneratedMetadataGuidance();
    await assertDryRunNoMutation();
    console.log('done-prepare-merge-rerun smoke passed');
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
})();
