#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import {
  buildStoryReadinessReport,
  renderMainSyncReadinessAdvisory,
  buildMainSyncReadiness,
} from '../core/lifecycle-readiness.js';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo, TestEvidenceData } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createSessionHandlers } from '../handlers/session.js';

const BEHIND_STORY = 'B-ms-behind';
const SYNCED_STORY = 'B-ms-synced';
const NOW = '2026-06-23T12:00:00.000Z';
const COMMIT_ENV = ['-c', 'user.email=main-sync-smoke@example.test', '-c', 'user.name=Main Sync Smoke'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', message]);
}

function writeConfig(root: string): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
  }, null, 2) + '\n');
  resetConfigCache();
}

function story(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId.toLowerCase(),
    title: `${storyId} main sync readiness smoke`,
    description: 'Synthetic story for local main-sync readiness smoke coverage.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

function checklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic main-sync readiness item',
      context: 'Covers the behind-main advisory behavior.',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
      verificationIntent: {
        happy: [{ desc: 'behind-main advisory appears', type: 'cli', priority: 'must' }],
        edge: [{ desc: 'synced branch has no false warning', type: 'cli', priority: 'must' }],
        adversarial: [{ desc: 'readiness is advisory and read-only', type: 'logic', priority: 'must' }],
      },
      verificationEvidence: [
        { intentRef: 'CHK-001:happy:0', kind: 'logic_test', result: 'pass', note: 'synthetic smoke setup covers happy lane' },
        { intentRef: 'CHK-001:edge:0', kind: 'logic_test', result: 'pass', note: 'synthetic smoke setup covers edge lane' },
        { intentRef: 'CHK-001:adversarial:0', kind: 'logic_test', result: 'pass', note: 'synthetic smoke setup covers adversarial lane' },
      ],
    }],
  };
}

function testEvidence(root: string): TestEvidenceData {
  return {
    command: 'main-sync-readiness-smoke synthetic validation',
    output: 'synthetic validation passed',
    result: 'PASS',
    timestamp: NOW,
    headHash: currentGitHead(root) ?? undefined,
    materialHash: currentMaterialHash(root, 'HEAD', root) ?? undefined,
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root) ?? undefined,
    verificationCoverage: {
      total: 3,
      required: 3,
      covered: 3,
      missingRequired: 0,
      entries: [],
    },
  };
}

function writeStoryState(root: string, storyId: string): void {
  const store = new StoryStore(root);
  store.writeStory(storyId, story(storyId));
  store.writeChecklist(storyId, checklist());
  store.writeTestEvidence(storyId, testEvidence(root));
  store.writeBugs(storyId, { bugs: [] });
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        out[relative(root, path)] = readFileSync(path, 'utf8');
      }
    }
  }
  walk(dir);
  return out;
}

function ctx(root: string): HandlerContext {
  return {
    root,
    scanRoot: join(root, 'packages/main'),
    store: new StoryStore(root),
  };
}

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-main-sync-readiness-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  write(root, '.gitignore', '.lattice/learning/\n');
  write(root, 'README.md', '# main sync readiness smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const value = 1;\n');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  commitAll(root, 'base');

  git(root, ['checkout', '-b', `story/${BEHIND_STORY}`]);
  writeStoryState(root, BEHIND_STORY);
  commitAll(root, 'behind story metadata');

  git(root, ['checkout', 'main']);
  write(root, 'main-only.txt', 'main moved after the story branch was created\n');
  commitAll(root, 'main moved');

  git(root, ['checkout', '-b', `story/${SYNCED_STORY}`]);
  writeStoryState(root, SYNCED_STORY);
  commitAll(root, 'synced story metadata');

  return root;
}

function assertBehindStory(root: string): void {
  git(root, ['checkout', `story/${BEHIND_STORY}`]);
  resetConfigCache();
  const store = new StoryStore(root);
  const context = ctx(root);
  const storyDir = store.storyDirPath(BEHIND_STORY);
  const beforeSnapshot = snapshotDir(root, storyDir);
  const beforeStatus = gitStatus(root);
  const beforeHead = git(root, ['rev-parse', 'HEAD']);
  const beforePhase = store.readStory(BEHIND_STORY).phase;
  assert.equal(gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', 'HEAD']), false, 'behind fixture must not contain main before readiness checks');
  assert.equal(existsSync(join(root, 'main-only.txt')), false, 'behind fixture must not have main-only file before readiness checks');

  const readiness = buildMainSyncReadiness({ storyId: BEHIND_STORY, gitCwd: root });
  assert.equal(readiness.status, 'behind');
  assert.equal(readiness.behindCount, 1);
  assert.equal(
    renderMainSyncReadinessAdvisory(readiness),
    `main-sync readiness: story/${BEHIND_STORY} is behind main by 1 commits; advisory/read-only; run lattice done_prepare '{"storyId":"${BEHIND_STORY}","mergeMain":true,"refreshStale":true,"validate":true}'`,
  );

  const reviewReport = buildStoryReadinessReport({ storyId: BEHIND_STORY, target: 'REVIEW', store, root });
  const reviewRow = reviewReport.readiness.find((row) => row.code === 'branch_behind_main_advisory');
  assert.ok(reviewRow, 'REVIEW readiness includes behind-main advisory');
  assert.equal(reviewRow.blocking, false, 'REVIEW advisory is non-blocking');
  assert.equal(reviewReport.claims.localReady, true, 'behind-main state alone does not fail REVIEW readiness');

  const testReport = buildStoryReadinessReport({ storyId: BEHIND_STORY, target: 'TEST', store, root });
  const testRow = testReport.readiness.find((row) => row.code === 'branch_behind_main_advisory');
  assert.ok(testRow, 'TEST readiness includes behind-main advisory');
  assert.equal(testRow.blocking, false, 'TEST advisory is non-blocking');
  assert.equal(testReport.claims.localReady, true, 'behind-main state alone does not fail TEST readiness');

  const brief = createSessionHandlers(context).session_brief();
  assert.match(brief, new RegExp(`main-sync readiness: story/${BEHIND_STORY} is behind main by 1 commits; advisory/read-only; run lattice done_prepare`));
  assert.match(brief, /## Main-sync readiness/);

  assert.equal(store.readStory(BEHIND_STORY).phase, beforePhase, 'readiness checks must not mutate phase');
  assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'readiness checks must not mutate story metadata');
  assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead, 'readiness checks must not create commits or merge main');
  assert.equal(gitStatus(root), beforeStatus, 'readiness checks must leave git status unchanged');
  assert.equal(gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', 'HEAD']), false, 'readiness checks must not merge main into the story branch');
  assert.equal(existsSync(join(root, 'main-only.txt')), false, 'readiness checks must not materialize main-only files in the story branch');
}

function assertSyncedStory(root: string): void {
  git(root, ['checkout', `story/${SYNCED_STORY}`]);
  resetConfigCache();
  const store = new StoryStore(root);
  assert.equal(gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', 'HEAD']), true, 'synced fixture must contain main');

  const readiness = buildMainSyncReadiness({ storyId: SYNCED_STORY, gitCwd: root });
  assert.equal(readiness.status, 'synced');
  assert.equal(renderMainSyncReadinessAdvisory(readiness), null);

  const report = buildStoryReadinessReport({ storyId: SYNCED_STORY, target: 'REVIEW', store, root });
  assert.equal(report.readiness.some((row) => row.code === 'branch_behind_main_advisory'), false, 'synced branch must not get a false lifecycle warning');
  const brief = createSessionHandlers(ctx(root)).session_brief();
  assert.doesNotMatch(brief, /main-sync readiness:/, 'synced branch must not get a false session warning');
}

const root = createRepo();
try {
  assertBehindStory(root);
  assertSyncedStory(root);
  process.stdout.write('main-sync-readiness smoke passed\n');
} finally {
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}
