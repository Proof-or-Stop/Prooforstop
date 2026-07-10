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
import { parseGitPorcelainRow } from '../core/dirty-worktree.js';
import { gitStatusRowsForDonePrepareGeneratedMetadata } from '../core/done-prepare-generated-metadata.js';
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

async function assertModifiedTrackedPathExactness(): Promise<void> {
  const { root, storyId } = setupFixture();
  try {
    // Seed tracked files: a story lifecycle metadata file (sorts before "notes/"
    // in porcelain output, so it lands on the first row) and an unrelated file.
    write(root, `.lattice/story/actives/${storyId}/process-metrics.json`, '{"seed":true}\n');
    write(root, 'notes/keep.txt', 'original\n');
    commitAll(root, 'seed tracked lifecycle metadata and unrelated file');

    // Modify both: modified rows (" M path") are the case where a whole-output
    // trim() used to eat the first row's leading char (".lattice" -> "lattice").
    write(root, `.lattice/story/actives/${storyId}/process-metrics.json`, '{"seed":false}\n');
    write(root, 'notes/keep.txt', 'edited\n');

    // F-002 regression: the generated-metadata core helper must also keep the
    // first porcelain row intact (its first row here is " M .lattice/...").
    const coreRows = gitStatusRowsForDonePrepareGeneratedMetadata(root);
    assert.ok(coreRows.length >= 2, `expected two dirty rows, got: ${JSON.stringify(coreRows)}`);
    assert.match(coreRows[0]!, /^ M \./, `first core status row must keep its leading status space: ${JSON.stringify(coreRows[0])}`);
    assert.equal(
      parseGitPorcelainRow(coreRows[0]!)?.path,
      `.lattice/story/actives/${storyId}/process-metrics.json`,
      'core helper first-row path must keep its leading dot',
    );
    const transcript = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: false,
      validate: false,
    });

    assert.match(transcript, /^DONE prepare: BLOCKED/, transcript);
    assert.match(transcript, /^\s+- notes\/keep\.txt: unrelated dirty file$/m, transcript);
    assert.match(transcript, /files:\n  - notes\/keep\.txt/, transcript);
    assert.doesNotMatch(transcript, /^\s*- lattice\//m, `first-row path must keep its leading dot:\n${transcript}`);
    assert.doesNotMatch(
      transcript,
      /process-metrics\.json: unrelated dirty file/,
      `pre-existing lifecycle metadata must not be classified as unrelated:\n${transcript}`,
    );

    // With only the lifecycle metadata left dirty, preflight must classify it
    // as pre-existing story lifecycle metadata rather than blocking on it.
    write(root, 'notes/keep.txt', 'original\n');
    const metadataOnly = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: false,
      validate: false,
    });
    assert.match(
      metadataOnly,
      /only pre-existing Proofbound story lifecycle metadata is dirty/,
      metadataOnly,
    );
    assert.doesNotMatch(metadataOnly, /process-metrics\.json: unrelated dirty file/, metadataOnly);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertRerunReasonAfterRefreshCommit(): Promise<void> {
  const { root, storyId } = setupFixture();
  try {
    // Re-seed the checklist with stale non-command evidence: refreshStale can
    // safely refresh it, which commits mid-run and must surface the re-run
    // reason section with the current binding.
    const store = new StoryStore(root);
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Merge/rerun smoke fixture',
        context: 'Synthetic done item for done_prepare merge/rerun coverage.',
        status: 'done',
        startTime: NOW,
        endTime: NOW,
        verificationIntent: {
          happy: [{ desc: 'docs check', type: 'docs', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'docs_check',
          file: 'README.md',
          result: 'pass',
          note: 'seeded docs evidence',
          timestamp: NOW,
          headHash: '0'.repeat(40),
          materialHash: 'stale-material-hash',
        }],
      }],
    } as ChecklistData);
    commitAll(root, 'seed stale docs evidence');

    const transcript = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: true,
      validate: false,
    });

    assert.match(transcript, /^DONE prepare: BLOCKED/, transcript);
    assert.match(transcript, /done_prepare re-run reason:/, transcript);
    assert.match(transcript, /generated commit: [0-9a-f]{7}/, transcript);
    assert.match(transcript, /current binding:/, transcript);
    assert.match(transcript, /currentHead: [0-9a-f]{40}/, transcript);
    assert.match(transcript, /currentMaterialHash: \S+/, transcript);
    assert.match(transcript, /currentStoryFilesHash: \S+/, transcript);
    assert.match(transcript, /next: review the generated commit\(s\), then rerun lattice done_prepare from the new HEAD/, transcript);
    assertNoSelfAttestationLanguage(transcript);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertMetadataCommitNoRebindAndAutoCloseExit(): Promise<void> {
  const { root, storyId } = setupFixture({ validateWritesMetadata: true });
  try {
    const sfhBefore = currentStoryFilesHash(root, 'HEAD', root);
    const first = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: false,
      validate: true,
    });
    assert.match(first, /^DONE prepare: BLOCKED/, first);
    assert.match(first, /generated by this done_prepare run:/, first);
    assert.doesNotMatch(first, /rebind/i, `generated metadata must not demand review rebinding:\n${first}`);

    // Follow the printed guidance verbatim: commit only the generated metadata.
    git(root, ['add', `.lattice/story/actives/${storyId}`]);
    git(root, ['commit', '-m', `lattice: prepare ${storyId} for DONE`]);

    // Hash-excluded generated metadata: committing it must not move the
    // story-files binding, so review assurance cannot be forced to rebind.
    const sfhAfter = currentStoryFilesHash(root, 'HEAD', root);
    assert.equal(sfhAfter, sfhBefore, 'generated metadata commit must not change storyFilesHash');

    // Loop exit: the documented one-command closeout reaches PASS with a clean
    // tree instead of regenerating metadata forever.
    const second = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
    });
    assert.match(second, /^DONE prepare: PASS/, second);
    assert.match(second, /autoCloseoutCommit: [0-9a-f]{40}/, second);
    assert.match(second, /validationReused: true/, second);
    assert.doesNotMatch(second, /merge hazard:/, second);
    assert.doesNotMatch(second, /dirty file classification:/, second);
    assertNoSelfAttestationLanguage(second);
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
      '',
      'auto-closeout must leave the worktree clean',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertPlainNoHazardPass(): Promise<void> {
  // F-001: a first-run, default-flags, no-hazard story must reach PASS through
  // the existing flow with none of the new hazard/auto-closeout sections.
  const { root, storyId } = setupFixture();
  try {
    const statusBefore = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    const storyBefore = readTreeSnapshot(root, `.lattice/story/actives/${storyId}`);
    const transcript = await runDonePrepare(root, storyId, {
      mergeMain: false,
      refreshStale: false,
      validate: false,
    });

    assert.match(transcript, /^DONE prepare: PASS/, transcript);
    assert.match(transcript, /doneClosure: PASS/, transcript);
    assert.match(transcript, /worktreeClean: PASS/, transcript);
    assert.doesNotMatch(transcript, /merge hazard:/, transcript);
    assert.doesNotMatch(transcript, /dirty file classification:/, transcript);
    assert.doesNotMatch(transcript, /generated by this done_prepare run:/, transcript);
    assert.doesNotMatch(transcript, /done_prepare re-run reason:/, transcript);
    assert.doesNotMatch(transcript, /autoClose/, `plain run must not print auto-closeout lines:\n${transcript}`);
    assertNoSelfAttestationLanguage(transcript);
    assert.equal(
      git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
      statusBefore,
      'plain no-hazard pass must leave git status unchanged',
    );
    assert.deepEqual(
      readTreeSnapshot(root, `.lattice/story/actives/${storyId}`),
      storyBefore,
      'plain no-hazard pass must leave story metadata byte-identical',
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
    await assertModifiedTrackedPathExactness();
    await assertRerunReasonAfterRefreshCommit();
    await assertMetadataCommitNoRebindAndAutoCloseExit();
    await assertPlainNoHazardPass();
    console.log('done-prepare-merge-rerun smoke passed');
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
})();
