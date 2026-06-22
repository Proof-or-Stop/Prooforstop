#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MAIN_TOOLS } from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signReviewPass } from '../core/finding-verify.js';
import { signReviewRun } from '../core/review-run.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { buildStoryReadinessReport, type StoryReadinessReport } from '../core/lifecycle-readiness.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';

const STORY_ID = 'B-life';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'lifecycle-check-smoke',
      GIT_AUTHOR_EMAIL: 'lifecycle-check-smoke@example.com',
      GIT_COMMITTER_NAME: 'lifecycle-check-smoke',
      GIT_COMMITTER_EMAIL: 'lifecycle-check-smoke@example.com',
    },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
      doneRequiredCommands: [
        { label: 'required pass', command: 'node', args: ['-e', 'process.exit(0)'] },
      ],
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function createFixture(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-lifecycle-check-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# lifecycle check smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const now = '2026-06-20T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'lifecycle-check-smoke',
    title: 'Lifecycle check smoke',
    description: 'Synthetic story for lifecycle_check V1 smoke coverage.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: 'round-1',
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic completed item',
      context: 'Synthetic completed context',
      status: 'done',
      startTime: now,
      endTime: now,
      verificationIntent: {
        happy: [{ desc: 'happy proof exists', type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        result: 'pass',
        note: 'synthetic proof for lifecycle_check smoke',
      }],
    }],
  });
  writeReviewerPass(root, store, 'lattice-review-concept');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function writeReviewerPass(root: string, store: StoryStore, lane: string): void {
  const story = store.readStory(STORY_ID);
  const reviewRound = story.currentReviewRound ?? 'round-1';
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(headHash, 'fixture git HEAD is available for reviewer run signing');
  assert.ok(materialHash, 'fixture material hash is available for reviewer run signing');

  const reviewRunId = `${STORY_ID}:RR-001`;
  const startedAt = '2026-06-20T00:01:00.000Z';
  store.writeReviewRuns(STORY_ID, {
    runs: [{
      reviewRunId,
      storyId: STORY_ID,
      agent: lane,
      lane,
      reviewRound,
      startedAt,
      headHash,
      materialHash,
      promptHash: '',
      _hash: signReviewRun(STORY_ID, reviewRunId, lane, lane, reviewRound, startedAt, headHash, materialHash, ''),
    }],
  });

  const id = `${STORY_ID}:RP-001`;
  const note = 'concept reviewer checked lifecycle smoke fixture and found no blocker';
  const createdAt = '2026-06-20T00:02:00.000Z';
  store.writeReviewPasses(STORY_ID, {
    passes: [{
      id,
      agent: lane,
      note,
      createdAt,
      reviewRound,
      reviewRunId,
      _hash: signReviewPass(STORY_ID, id, lane, note, createdAt, reviewRound, reviewRunId),
    }],
  });
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

function readinessCodes(report: StoryReadinessReport): Set<string> {
  return new Set(report.readiness.map((row) => row.code));
}

function assertReportShape(report: StoryReadinessReport): void {
  assert.equal(report.storyId, STORY_ID);
  assert.equal(report.target, 'DONE');
  assert.equal(report.phase, 'TEST');
  assert.equal(report.mode.runCommands, false);
  assert.equal(report.mode.writeEvidence, false);
  assert.ok(Array.isArray(report.readiness));
  assert.ok(Array.isArray(report.next));
  assert.equal(typeof report.claims.localReady, 'boolean');
  assert.equal(report.claims.authorityDone, false);
  assert.equal(report.claims.fullAuthorityDone, false);
  assert.equal(report.claims.productionDone, false);
}

function topLevelReportShape(report: StoryReadinessReport) {
  return {
    storyId: report.storyId,
    target: report.target,
    phase: report.phase,
    mode: report.mode,
    readiness: report.readiness.map((row) => Object.keys(row).sort()),
    next: report.next.map((action) => Object.keys(action).sort()),
    claims: {
      localReady: typeof report.claims.localReady,
    },
  };
}

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'lifecycle_check'), 'MAIN_TOOLS exposes lifecycle_check');
assert.equal(getCommandPolicy('lifecycle_check')?.ownershipClass, 'readOnly', 'lifecycle_check policy is readOnly');

{
  const { root, store, ctx } = createFixture();
  try {
    const registry = createMainRegistry(ctx);
    const handler = registry.get('lifecycle_check');
    assert.ok(handler, 'registry exposes lifecycle_check');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);
    const jsonReport = handler!({ storyId: STORY_ID, target: 'DONE', json: true }) as StoryReadinessReport;
    assertReportShape(jsonReport);
    const formatJsonReport = handler!({ storyId: STORY_ID, target: 'DONE', format: 'json' }) as StoryReadinessReport;
    assertReportShape(formatJsonReport);
    assert.deepEqual(
      topLevelReportShape(formatJsonReport),
      topLevelReportShape(jsonReport),
      'json:true and format:json return the same top-level report shape',
    );
    assert.equal(jsonReport.claims.localReady, false, 'missing DONE proof blocks localReady');
    assert.equal(jsonReport.readiness.some((row) => row.blocking), true, 'blocking rows are present');

    const codes = readinessCodes(jsonReport);
    assert.ok(codes.has('missing_required_review_lane'), 'one valid reviewer pass does not satisfy all required round-1 lanes');
    assert.ok(codes.has('missing_delivery_check'), 'missing delivery check is classified distinctly');
    assert.ok(codes.has('missing_story_summary'), 'missing summary is classified distinctly');
    assert.ok(codes.has('missing_done_required_validation'), 'missing done-required validation is classified distinctly');
    assert.ok(codes.has('missing_done_prepare_report'), 'missing done_prepare report is visible');
    assert.ok(
      jsonReport.next.some((action) => action.command === `lattice review_run_start '{"storyId":"${STORY_ID}","agent":"lattice-review-quality"}'`),
      'missing required reviewer lanes print exact review_run_start next command guidance',
    );
    assert.ok(
      jsonReport.next.some((action) => action.command?.includes('delivery_check_set')),
      'missing delivery check prints an exact delivery_check_set next command',
    );
    assert.equal(
      jsonReport.claims.localReady,
      !jsonReport.readiness.some((row) => row.blocking === true),
      'localReady is exactly the negation of blocking readiness rows',
    );
    assert.ok(
      jsonReport.next.some((action) => action.command?.includes('done_required_validate') || action.reason.includes('missing_done_required_validation')),
      'next actions include DONE-required guidance',
    );

    const textReport = handler!({ storyId: STORY_ID, target: 'DONE', format: 'text' }) as string;
    assert.match(textReport, /mode: read-only/);
    assert.match(textReport, /localReady: false/);
    assert.match(textReport, /blockers: \d+/);
    assert.match(textReport, /Next actions:/);
    assert.match(textReport, /missing_delivery_check/);

    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'lifecycle_check must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'lifecycle_check must leave git status unchanged');

    const directReport = buildStoryReadinessReport({ storyId: STORY_ID, target: 'DONE', store, root });
    assertReportShape(directReport);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const throwingStore = new Proxy({}, {
    get(_target, prop) {
      throw new Error(`store read should not happen before V1 rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/lifecycle-check-no-read', scanRoot: '/tmp/lifecycle-check-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('lifecycle_check');
  assert.ok(handler, 'registry exposes lifecycle_check for rejection test');
  assert.throws(
    () => handler!({ storyId: 'B-no-read', target: 'DONE', runCommands: true, json: true }),
    /runCommands=true.*later Full Vision layer/,
    'runCommands=true fails closed before store reads',
  );
  assert.throws(
    () => handler!({ storyId: 'B-no-read', target: 'DONE', writeEvidence: true, json: true }),
    /writeEvidence=true.*later Full Vision layer/,
    'writeEvidence=true fails closed before store reads',
  );
}

process.stdout.write('lifecycle_check smoke passed\n');
