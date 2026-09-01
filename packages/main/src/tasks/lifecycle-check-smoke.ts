#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MAIN_TOOLS } from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import { runDoneRequiredValidation } from '../core/done-required-validation.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { signReviewPass } from '../core/finding-verify.js';
import { signReviewRun } from '../core/review-run.js';
import { StoryStore } from '../core/store.js';
import type { ClosingSelfCheck, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';
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
  writeConfigWithProfile(root, 'balanced');
}

function writeConfigWithProfile(root: string, profile: 'light' | 'balanced'): void {
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile },
      doneRequiredCommands: [
        { label: 'required pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      ],
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function createFixture(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lifecycle-check-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# lifecycle check smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
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
  writeReviewerPass(root, store, 'proof-or-stop-review-concept');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

async function createDoneReadyFixture(): Promise<{ root: string; store: StoryStore; ctx: HandlerContext }> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lifecycle-check-ready-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfigWithProfile(root, 'light');
  writeFileSync(join(root, 'README.md'), '# lifecycle check ready smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const ready = true;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const now = '2026-06-20T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'lifecycle-check-ready-smoke',
    title: 'Lifecycle check ready smoke',
    description: 'Synthetic DONE-ready story for lifecycle_check V1 smoke coverage.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
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
        note: 'synthetic proof for lifecycle_check ready smoke',
      }],
    }],
  });
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(headHash, 'fixture git HEAD is available for delivery-check freshness');
  assert.ok(materialHash, 'fixture material hash is available for delivery-check freshness');
  store.writeTestEvidence(STORY_ID, {
    command: 'lifecycle-check-ready-smoke',
    output: JSON.stringify({ allPass: true, summary: 'lifecycle check ready smoke passed' }),
    result: 'PASS',
    timestamp: now,
    headHash,
    materialHash,
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root),
    verificationCoverage: {
      total: 1,
      required: 1,
      covered: 1,
      missingRequired: 0,
      entries: [],
    },
  });
  store.writeBugs(STORY_ID, { bugs: [] });
  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'lifecycle_check ready fixture has synthetic real-machine coverage.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'lifecycle_check ready fixture closure evidence is complete.',
  };
  store.writeDeliveryCheck(STORY_ID, {
    storyId: STORY_ID,
    checkedAt: now,
    headHash,
    materialHash,
    reviewRound: '',
    agentId: 'proof-or-stop-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(STORY_ID, docsPromises, realMachineTests, closingSelfCheck, '', materialHash),
  });
  store.writeSummary(STORY_ID, {
    storyId: STORY_ID,
    createdAt: now,
    updatedAt: now,
    changes: 'Synthetic lifecycle_check ready fixture changes.',
    usage: 'Run lifecycle_check against the synthetic ready fixture.',
    expectedOutcome: 'The only missing done_prepare row is advisory.',
    actualTranscript: 'Synthetic fixture has all DONE oracle blockers satisfied.',
    outcomeDiff: 'No difference.',
    acceptanceVerdict: 'accepted',
    outcomeKind: 'success',
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'Synthetic smoke fixture only.',
    pitfalls: 'Keep done_prepare advisory only when DONE oracle rows are clean.',
  });
  await runDoneRequiredValidation({
    projectRoot: root,
    storyId: STORY_ID,
    store,
    gitCwd: root,
  });
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

function expectedDonePrepareCommand(storyId = STORY_ID): string {
  return `proof-or-stop done_prepare '{"storyId":"${storyId}","mergeMain":true,"refreshStale":true,"validate":true}'`;
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
    const doneRequiredRow = jsonReport.readiness.find((row) => row.code === 'missing_done_required_validation');
    assert.equal(
      doneRequiredRow?.nextCommand,
      expectedDonePrepareCommand(),
      'missing DONE-required validation routes through done_prepare recovery',
    );
    assert.ok(
      jsonReport.next.some((action) => action.command === `proof-or-stop review_run_start '{"storyId":"${STORY_ID}","agent":"proof-or-stop-review-quality"}'`),
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
      jsonReport.next.some((action) => action.command === expectedDonePrepareCommand()),
      'next actions route DONE-required guidance through done_prepare',
    );
    assert.ok(
      !jsonReport.next.some((action) => action.command?.includes('done_required_validate')),
      'next actions do not route directly to done_required_validate',
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
  const { root, store, ctx } = await createDoneReadyFixture();
  try {
    const registry = createMainRegistry(ctx);
    const handler = registry.get('lifecycle_check');
    assert.ok(handler, 'registry exposes lifecycle_check for ready fixture');

    const jsonReport = handler!({ storyId: STORY_ID, target: 'DONE', json: true }) as StoryReadinessReport;
    assertReportShape(jsonReport);
    const donePrepareRow = jsonReport.readiness.find((row) => row.code === 'missing_done_prepare_report');
    assert.ok(donePrepareRow, 'missing done_prepare row remains visible');
    assert.equal(donePrepareRow.blocking, false, 'missing done_prepare is advisory when DONE oracle rows have no blockers');
    assert.equal(donePrepareRow.status, 'warn');
    assert.equal(donePrepareRow.category, 'advisory');
    assert.match(donePrepareRow.reason, /advisory preflight guidance/);
    assert.equal(jsonReport.readiness.some((row) => row.blocking), false, 'ready fixture has no hard readiness blockers');
    assert.equal(jsonReport.claims.localReady, true, 'advisory missing done_prepare does not make localReady false');

    const textReport = handler!({ storyId: STORY_ID, target: 'DONE', format: 'text' }) as string;
    assert.match(textReport, /localReady: true/);
    assert.match(textReport, /\[WARN\] done\.done_prepare code=missing_done_prepare_report category=advisory/);

    const directReport = buildStoryReadinessReport({ storyId: STORY_ID, target: 'DONE', store, root });
    const directDonePrepareRow = directReport.readiness.find((row) => row.code === 'missing_done_prepare_report');
    assert.equal(directDonePrepareRow?.blocking, false, 'direct report keeps missing done_prepare advisory');
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
