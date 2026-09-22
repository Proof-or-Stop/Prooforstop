#!/usr/bin/env node
/**
 * Lifecycle Readiness P7 — reviewer_batch smoke.
 *
 * Proves the read-only reviewer-launcher PLAN producer (handlers/reviewer-batch.ts)
 * over a deterministic REVIEW-phase fixture story with four active lanes:
 *   - concept       — a current-round pass bound to the CURRENT head (no change
 *                     since) → current-pass.
 *   - quality       — a prior pass bound to an EARLIER head, with a material file
 *                     changed since → scope-changed / needs-rerun.
 *   - test-coverage — no pass at all → no-receipt / launch.
 *   - behavior      — a blocking verified finding open for the lane → awaiting-repair
 *                     (+ gate blockedBy).
 *
 * Asserts (mirroring the P3 evidence-plan smoke, pure read-only):
 *   (a) READ-ONLY — no story-metadata mutation, git status unchanged, no command
 *       run, AND no review-runs/review-passes/findings written by the command
 *       (review_run_start is never invoked).
 *   (b) correct per-lane classification (current / scope-changed / no-receipt /
 *       blocking).
 *   (c) each needs-run lane carries the correct Agent-spawn launchInstruction
 *       (matches /^Agent\(\{ subagent_type: "proof-or-stop-review-<lane>"/, contains the
 *       storyId, and never the dispatch CLI form); the current-pass lane carries
 *       launchInstruction=null.
 *   (d) gate.blockedBy reflects the missing passes + the blocking finding, and
 *       gate.ready=false.
 *   (e) no phase-advance / Authority / delivery-sign artifacts.
 *   (f) idempotent across two runs (story snapshot + git unchanged).
 *   (g) a storyId path-traversal id is rejected (isCanonicalStoryId guard), and
 *       every side-effect flag fails closed BEFORE any store read.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { StoryStore } from '../core/store.js';
import { createMainRegistry } from '../registry.js';
import { buildStoryReadinessReport } from '../core/lifecycle-readiness.js';
import { currentGitHead, currentStoryFilesHash, checkEvidenceFreshnessForGit, classifyEvidenceFreshness } from '../core/evidence-freshness.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { readOwnerLease, releaseOwnerLease } from '../core/story-owner-lease.js';
import { listRuntimeArtifactIgnorePatterns } from '../core/runtime-artifact-registry.js';
import { adapterSessionEnv, adapterSessionId } from './adapter-session-env.js';
import type { HandlerContext } from '../handlers/context.js';
import { buildReviewerExecutionPlan, renderReviewerBatchReport, type ReviewerBatchReport } from '../handlers/reviewer-batch.js';
import type {
  ChecklistData,
  StoryEvent,
  StoryInfo,
} from '../core/types.js';

import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from './native-review-fixture.js';
import { runIsolatedFindingFixture } from './isolated-finding-fixture.js';
if (await runIsolatedFindingFixture(import.meta.url)) process.exit(0);

const STORY_ID = 'B-rbatch';
const NOW = '2026-06-20T00:00:00.000Z';
const COMMIT_ENV = ['-c', 'user.email=rbatch-smoke@example.test', '-c', 'user.name=Reviewer Batch Smoke'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
      promptEnvelope: { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: Object.fromEntries(
        ['concept', 'quality', 'behavior', 'test-coverage'].map(lane => [`proof-or-stop-review-${lane}`, 'full-envelope'])) },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

const BASE_MS = Date.parse('2026-06-16T00:00:00.000Z');
function ts(n: number): string {
  return new Date(BASE_MS + n * 60_000).toISOString();
}

/** A fixed current round with producer-issued run/envelope/pass bindings. */
function reviewStory(): StoryInfo {
  const events: StoryEvent[] = [
    { phase: 'REVIEW', action: 'advance', timestamp: ts(1) } as StoryEvent,
  ];
  return {
    storyId: STORY_ID,
    name: 'reviewer-batch-smoke',
    title: 'reviewer_batch smoke',
    description: 'Read-only reviewer-launcher PLAN producer fixture.',
    type: 'feature',
    priority: 'high',
    phase: 'REVIEW',
    currentReviewRound: ts(1),
    riskSignals: [{ category: 'gate', note: 'activates behavior reviewer' }],
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events,
  } as unknown as StoryInfo;
}

function checklist(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'reviewer batch lanes',
        context: 'four active lanes in REVIEW',
        status: 'done',
        startTime: null,
        endTime: null,
      },
    ],
  };
}

const fixtureRoots = new Set<string>();
const cliPath = fileURLToPath(new URL('../../../../bin/proof-or-stop.js', import.meta.url));
function fixtureCli(root: string, lane: string, command: string, payload: Record<string, unknown>): string {
  assert.ok(fixtureRoots.has(root), 'CLI review arrangement is confined to its disposable fixture');
  const task = `reviewer-batch-${lane}`;
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...adapterSessionEnv(task, lane), PROOF_OR_STOP_AGENT: lane,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE: lane, PROOF_OR_STOP_PROJECT_ROOT: root },
    }).trim();
  } finally {
    const storyDir = new StoryStore(root).storyDirPath(STORY_ID);
    const lease = readOwnerLease(storyDir);
    if (lease?.sessionId === adapterSessionId(root, task, lane)) assert.equal(releaseOwnerLease(storyDir), true);
  }
}

/** Main-only drift keeps quality's real run fresh while requiring incremental review. */
async function createFixture(): Promise<{
  root: string; store: StoryStore; ctx: HandlerContext;
  conceptPassId: string; qualityPassId: string; behaviorFindingId: string;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'proof-or-stop-reviewer-batch-')));
  fixtureRoots.add(root);
  try {
    writeConfig(root);
    write(root, '.gitignore', listRuntimeArtifactIgnorePatterns().join('\n') + '\n');
    for (const name of ['concept', 'quality', 'testcov']) write(root, `src/${name}.ts`, `export const ${name} = 1;\n`);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'rbatch-smoke@example.test']);
    git(root, ['config', 'user.name', 'Reviewer Batch Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base on main']);
    git(root, ['checkout', '-b', `story/${STORY_ID}`]);
    write(root, 'src/story-owned.ts', 'export const storyOwned = 1;\n');
    const store = new StoryStore(root);
    store.writeStory(STORY_ID, reviewStory());
    store.writeChecklist(STORY_ID, checklist());
    store.writeUnderstanding(STORY_ID, {
      task: 'Exercise four real reviewer lane states', outcome: 'Preserve trusted incremental review and reject missing or blocking lanes',
      facts: ['The fixture acceptance requires storyOwned to equal 2.'], constraints: [], unknowns: [],
      touchpoints: ['src/story-owned.ts', 'src/concept.ts', 'src/quality.ts', 'src/testcov.ts'], timestamp: NOW,
    });
    assert.equal(store.readScopeContract(STORY_ID), null, 'This narrow fixture declares no scope contract');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'arrange fixed REVIEW round and story-owned source']);
    const initialStoryHash = currentStoryFilesHash(root);
    assert.ok(initialStoryHash);
    const observedFiles = ['src/story-owned.ts', 'src/concept.ts', 'src/quality.ts', 'src/testcov.ts'];
    const readManifest = { filesReadFully: observedFiles, filesTriagedByName: [], scanEscalationReason: null };
    const readEvents = observedFiles.map(path => ({ path, mode: 'full', action: 'Read', tokenCount: 8 }));
    const observe = async (short: string, finding = false) => {
      const lane = `proof-or-stop-review-${short}`;
      for (const path of observedFiles) assert.ok(readFileSync(join(root, path), 'utf8').length > 0);
      fixtureCli(root, lane, 'dispatch', { storyId: STORY_ID, agentType: lane });
      const started = fixtureCli(root, lane, 'review_run_start', { storyId: STORY_ID, agent: lane });
      const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
      assert.ok(reviewRunId, started);
      if (finding) {
        assert.match(readFileSync(join(root, 'src/story-owned.ts'), 'utf8'), /storyOwned = 1/);
        await runBrokeredNativeReviewCli({ root, store, storyId: STORY_ID, agent: lane, reviewRunId, command: 'finding_add', payload: { storyId: STORY_ID, agent: lane, reviewRunId,
          desc: 'The fixture acceptance requires storyOwned to equal 2, but src/story-owned.ts exports 1.',
          severity: 'critical', category: 'missing', evidenceState: 'verified', files: ['src/story-owned.ts'], readManifest, readEvents } });
        const row = store.readFindings(STORY_ID).findings.find(row => row.reviewRunId === reviewRunId);
        assert.ok(row); return row.id;
      }
      await runBrokeredNativeReviewCli({ root, store, storyId: STORY_ID, agent: lane, reviewRunId, command: 'review_pass_set', payload: { storyId: STORY_ID, agent: lane, reviewRunId,
        note: 'The fixed fixture review of this lane found no additional blocker.', readManifest, readEvents } });
      const row = store.readReviewPasses(STORY_ID).passes.find(row => row.reviewRunId === reviewRunId);
      assert.ok(row); return row.id;
    };
    const qualityPassId = await observe('quality');
    const qualityRun = store.readReviewRuns(STORY_ID).runs.find(row => row.agent === 'proof-or-stop-review-quality')!;
    assert.equal(qualityRun.storyFilesHash, initialStoryHash);
    git(root, ['add', '.']);
    if (git(root, ['status', '--porcelain']).trim()) {
      git(root, ['commit', '-m', 'freeze quality producer evidence on Story']);
    }
    git(root, ['checkout', 'main']);
    write(root, 'src/quality.ts', 'export const quality = 2; // incoming main change\n');
    git(root, ['add', 'src/quality.ts']);
    git(root, ['commit', '-m', 'main-only quality update']);
    git(root, ['checkout', `story/${STORY_ID}`]);
    git(root, ['merge', '--no-ff', 'main', '-m', 'merge unrelated main material']);
    assert.equal(currentStoryFilesHash(root), initialStoryHash, 'Main drift keeps the nonempty Story-owned input unchanged');
    const freshness = checkEvidenceFreshnessForGit(root, qualityRun.headHash, qualityRun.materialHash, root, qualityRun.storyFilesHash);
    assert.equal(freshness.fresh, true, 'Real quality run remains freshness-admissible after main-only drift');
    const conceptPassId = await observe('concept');
    const behaviorFindingId = await observe('behavior', true);
    assert.equal(store.readStory(STORY_ID).currentReviewRound, ts(1), 'Fixture producer round never rotates');
    const ctx: HandlerContext = { store, root, scanRoot: root };
    return { root, store, ctx, conceptPassId, qualityPassId, behaviorFindingId };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    fixtureRoots.delete(root);
    throw error;
  }
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  (function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  })(dir);
  return out;
}

function laneByName(report: ReviewerBatchReport, lane: string) {
  const found = report.lanes.find((entry) => entry.lane === `proof-or-stop-review-${lane}`);
  assert.ok(found, `report has lane ${lane}`);
  return found!;
}

/**
 * Assert a needs-run lane carries the complete host-neutral fresh-context launch
 * contract rather than the legacy Claude-only Agent(...) shortcut.
 */
function assertAgentLaunchInstruction(instruction: string | null, lane: string): void {
  assert.ok(instruction, `${lane}: needs-run lane carries a launch instruction`);
  const value = instruction!;
  assert.match(value, new RegExp(`agentType[^\\n]+proof-or-stop-review-${lane}`));
  assert.ok(value.includes(STORY_ID), `${lane}: launch instruction names the storyId`);
  assert.match(value, /spawn_agent\(\{ task_name:/, `${lane}: Codex launch is present`);
  assert.match(value, /fork_turns: "none"/, `${lane}: Codex launch drops parent history`);
  assert.match(value, /followup_task\(\{ target: <returned reviewer target>, message: <the same exact prompt> \}\)/,
    `${lane}: Codex launch redundantly delivers the canonical prompt to the returned target`);
  assert.match(value, /agent id or canonical task name/, `${lane}: current Codex target forms are accepted`);
  assert.match(value, /do not wait until the reviewer has acknowledged the assignment/i,
    `${lane}: the owner waits only after delivery acknowledgement`);
  assert.match(value, /Agent\(\{ subagent_type:/, `${lane}: Claude launch is present`);
  assert.match(value, /Other hosts launch one equivalent fresh-context reviewer task/, `${lane}: other hosts retain the boundary`);
  assert.match(value, /passes the returned prompt unchanged/, `${lane}: launch uses the canonical dispatch prompt`);
  assert.match(value, /Retain every returned child agent id/, `${lane}: exact child ids are retained`);
  assert.match(value, /never call wait with an empty target\/receiver set/, `${lane}: empty waits are forbidden`);
  assert.match(value, /child id must be nonempty/, `${lane}: empty child ids are forbidden`);
  assert.match(value, /multiple lanes.*distinct/, `${lane}: parallel lane child ids must be distinct`);
  const taskName = value.match(/spawn_agent\(\{ task_name: "([^"]+)"/)?.[1];
  assert.match(taskName ?? '', /^[a-z0-9_]+$/, `${lane}: Codex task name uses only accepted characters`);
  assert.equal(taskName, `review_${lane.replace(/-/g, '_')}`, `${lane}: Codex task name is canonical`);
}

// ---- Policy / registration assertions -------------------------------------

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'reviewer_batch'), 'MAIN_TOOLS exposes reviewer_batch');
const policy = getCommandPolicy('reviewer_batch');
assert.equal(policy?.ownershipClass, 'readOnly', 'reviewer_batch policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'reviewer_batch policy has no destructive risk');
assert.equal(isCommandAllowed('reviewer_batch', 'REVIEW', DEFAULT_PHASE_TOOLS), true, 'reviewer_batch available in REVIEW');
assert.equal(isCommandAllowed('reviewer_batch', 'TEST', DEFAULT_PHASE_TOOLS), true, 'reviewer_batch available in TEST');
assert.equal(isCommandAllowed('reviewer_batch', 'DONE', DEFAULT_PHASE_TOOLS), true, 'reviewer_batch available in DONE');

// ---- (g) Fail-closed boundary (no store read on side-effect flags / traversal)

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before reviewer_batch rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/reviewer-batch-no-read', scanRoot: '/tmp/reviewer-batch-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('reviewer_batch');
  assert.ok(handler, 'registry exposes reviewer_batch for rejection test');
  for (const flag of ['runCommands', 'writeEvidence', 'advancePhase', 'launchReviewers', 'write', 'launch', 'run', 'authorityDone', 'fullAuthorityDone', 'productionDone'] as const) {
    assert.throws(
      () => handler!({ storyId: STORY_ID, [flag]: true, json: true }),
      /read-only PLAN producer|no story facts were read/,
      `${flag}=true fails closed before store reads`,
    );
  }
  // Path-traversal id is rejected by isCanonicalStoryId (no filesystem path derived).
  assert.throws(
    () => handler!({ storyId: '../../etc/passwd', json: true }),
    /not a canonical, path-safe Proof-or-Stop story id/,
    'path-traversal storyId is rejected',
  );
}

// ---- (a)–(e) Core classification + read-only invariants --------------------

{
  const { root, store, ctx, conceptPassId, qualityPassId, behaviorFindingId } = await createFixture();
  try {
    const handler = createMainRegistry(ctx).get('reviewer_batch');
    assert.ok(handler, 'registry exposes reviewer_batch');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: STORY_ID, json: true }) as ReviewerBatchReport;
    assert.equal(report.storyId, STORY_ID);
    assert.equal(report.mode.runCommands, false);
    assert.equal(report.mode.writeEvidence, false);
    assert.equal(report.claims.authorityDone, false);
    assert.equal(report.claims.productionDone, false);

    // The four active lanes (concept/quality/test-coverage baseline + behavior via riskSignal).
    const laneNames = report.lanes.map((entry) => entry.lane).sort();
    assert.deepEqual(laneNames, ['behavior', 'concept', 'quality', 'test-coverage'].map(lane => `proof-or-stop-review-${lane}`), 'four canonical active lanes resolved');

    // (b) per-lane classification.
    const concept = laneByName(report, 'concept');
    const quality = laneByName(report, 'quality');
    const testcov = laneByName(report, 'test-coverage');
    const behavior = laneByName(report, 'behavior');

    assert.equal(concept.state, 'current-pass', 'concept: current-round pass bound to HEAD, no change since');
    assert.equal(concept.scopeChanged, false, 'concept: nothing changed since its last pass');
    assert.ok(concept.priorVerdict && concept.priorVerdict.includes(conceptPassId), 'concept priorVerdict references its pass');

    assert.equal(quality.state, 'scope-changed', `quality: prior pass at baseSha, material changed since; evidence=${JSON.stringify(collectReviewerEvidenceState(store, STORY_ID, root).invalid)}`);
    assert.equal(quality.scopeChanged, true, 'quality: src/quality.ts changed since its last pass');
    assert.ok(quality.changedFilesSinceLastPass.includes('src/quality.ts'), 'quality changedFiles includes the edited material file');
    assert.ok(quality.priorVerdict && quality.priorVerdict.includes(qualityPassId), 'quality priorVerdict references its pass');

    assert.equal(testcov.state, 'no-receipt', 'test-coverage: no pass → no-receipt');
    assert.equal(testcov.scopeChanged, true, 'test-coverage: first-pass full diff → scopeChanged=true');

    assert.equal(behavior.state, 'awaiting-repair', 'behavior: current first blocking observation awaits repair without a prior PASS');
    assert.deepEqual(behavior.blockingFindings, [behaviorFindingId], 'behavior lane lists the blocking finding id');

    // (c) launch instructions: each needs-run lane carries the canonical Agent-spawn
    //     form (asserted by SHAPE, so the old dispatch CLI template would fail);
    //     the current-pass lane carries launchInstruction=null.
    assert.equal(concept.launchInstruction, null, 'current-pass lane has no launch instruction');
    assertAgentLaunchInstruction(quality.launchInstruction, 'quality');
    assertAgentLaunchInstruction(testcov.launchInstruction, 'test-coverage');
    assert.equal(behavior.launchInstruction, null, 'Current first blocker must not request duplicate observation');

    // Performance regression: the owner must receive one explicit batch barrier,
    // not a list that can be interpreted as launch-one/wait-one serial work.
    const executionPlan = (report as ReviewerBatchReport & {
      executionPlan?: {
        strategy: string;
        launchableLanes: string[];
        launchAllBeforeWait: boolean;
        waitPolicy: string;
        maxConcurrency: number;
      };
    }).executionPlan;
    assert.deepEqual(executionPlan, {
      strategy: 'parallel-barrier',
      launchableLanes: [quality.lane, testcov.lane],
      launchAllBeforeWait: true,
      waitPolicy: 'collective-child-ids-after-all-launched',
      maxConcurrency: 2,
    }, 'all currently launchable reviewer lanes share one explicit parallel barrier');

    // Agent controllers commonly inspect a bounded JSON preview before deciding
    // which host actions to issue. Keep the complete scheduling control header
    // ahead of verbose per-lane prompts so a 4 KiB preview cannot accidentally
    // turn the required launch-all barrier into launch-one/wait-one execution.
    const boundedPreview = JSON.stringify(report, null, 1).slice(0, 4_000);
    const executionPlanOffset = boundedPreview.indexOf('"executionPlan"');
    const lanesOffset = boundedPreview.indexOf('"lanes"');
    assert.ok(
      executionPlanOffset >= 0 && lanesOffset >= 0 && executionPlanOffset < lanesOffset,
      'the scheduling control header precedes verbose lane records',
    );
    assert.match(boundedPreview, /"waitPolicy": "collective-child-ids-after-all-launched"/);
    for (const lane of executionPlan.launchableLanes) {
      assert.match(boundedPreview, new RegExp(`"${lane}"`), `bounded preview retains launchable lane ${lane}`);
    }

    // (d) gate: missing passes + blocking finding → blockedBy non-empty, not ready.
    assert.equal(report.gate.ready, false, 'gate is not ready while lanes are missing/blocking');
    assert.ok(report.gate.blockedBy.length > 0, 'gate.blockedBy is non-empty');
    assert.ok(
      report.gate.blockedBy.includes('open_blocking_review_finding'),
      `gate.blockedBy reflects the blocking finding, got ${JSON.stringify(report.gate.blockedBy)}`,
    );
    assert.ok(
      report.gate.blockedBy.includes('missing_required_review_lane'),
      `gate.blockedBy reflects a missing required lane, got ${JSON.stringify(report.gate.blockedBy)}`,
    );

    // The plan embeds the V1 StoryReadinessReport verbatim. reviewer_batch reports
    // the REVIEW->TEST gate, so the embedded report is the TEST-target projection
    // (the only one that emits the per-lane buildReviewGateRows review rows).
    const directReport = buildStoryReadinessReport({ storyId: STORY_ID, target: 'TEST', store, root });
    assert.deepEqual(report.readinessReport, directReport, 'reviewer_batch embeds the V1 (TEST-target) StoryReadinessReport verbatim');

    // text render is coherent and read-only.
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /Reviewer batch \(B-rbatch\)/);
    assert.match(text, /mode: read-only \(no reviewer launched/);
    assert.match(text, /gate: BLOCKED/);
    assert.match(text, /concept \[current-pass\]/);
    assert.match(text, /quality \[scope-changed\]/);
    assert.match(text, /test-coverage \[no-receipt\]/);
    assert.match(text, /behavior \[awaiting-repair\]/);
    assert.match(text, /parallel-barrier: launchableLanes=\[proof-or-stop-review-quality, proof-or-stop-review-test-coverage\]/);
    assert.match(text, /issue every listed lane's launchInstruction before any wait/);
    assert.match(text, /one host wait call with the complete child-id set/);
    assert.match(text, /admissibilityStatus: reviewer-launch-preview/);
    assert.match(text, /assuranceLevel: local/);
    assert.match(text, /evidenceScope: review-readiness/);

    // (a) + (e) read-only: no metadata / git mutation; no authority/evidence artifacts
    //     beyond the FIXTURE-seeded ones, and the seeded review-runs/passes/findings
    //     are byte-identical (the command itself wrote nothing).
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'reviewer_batch must not mutate story metadata');
    assert.equal(gitStatus(root), beforeStatus, 'reviewer_batch must leave git status unchanged');
    assert.equal(store.readStory(STORY_ID).phase, 'REVIEW', 'reviewer_batch must not advance phase');
    for (const artifact of ['test-evidence.json', 'delivery-check.json', 'summary.json', 'done-required-evidence.json', 'authority-receipt-refs.json']) {
      assert.equal(existsSync(store.storyFilePath(STORY_ID, artifact)), false, `${artifact} must not be written`);
    }

    // (f) idempotent: a second run leaves the story snapshot + git byte-identical
    //     and returns a structurally identical report.
    const report2 = handler!({ storyId: STORY_ID, json: true }) as ReviewerBatchReport;
    assert.deepEqual(report2, report, 'reviewer_batch is idempotent across two runs');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'second run leaves story metadata unchanged');
    assert.equal(gitStatus(root), beforeStatus, 'second run leaves git status unchanged');
    // Reuse the same authenticated fixture for the adversarial checks.
    const before = handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport;
    assert.equal(laneByName(before, 'behavior').state, 'awaiting-repair');
    const readFindings = store.readFindings.bind(store);
    const findingData = readFindings(STORY_ID);
    // Corrupt only disposable records: no invalid signature may suppress launch.
    for (const change of [{ _signature: 'invalid' }, { agent: 'proof-or-stop-review-quality' }, { reviewRound: '1900-01-01T00:00:00.000Z' }]) {
      const altered = structuredClone(findingData);
      const finding = altered.findings.find(row => row.id === behaviorFindingId)!;
      Object.assign(finding, change);
      // Changing signed content guarantees invalidity even if a signature field is renamed.
      finding.desc += ' deliberately invalid fixture';
      // Inject at the reader boundary: the canonical ledger supersedes legacy JSON.
      store.readFindings = () => altered;
      const invalid = handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport;
      assert.notEqual(laneByName(invalid, 'behavior').state, 'awaiting-repair');
      assertAgentLaunchInstruction(laneByName(invalid, 'behavior').launchInstruction, 'behavior');
      assert.ok(invalid.executionPlan.launchableLanes.includes(behavior.lane), 'invalid finding authority restores behavior to the child-id barrier');
      assert.equal(invalid.gate.ready, false);
    }
    store.readFindings = readFindings;
    // Preserve suppression across a real metadata-only commit.
    const beforeMetadataHead = git(root, ['rev-parse', 'HEAD']);
    const originalStory = store.readStory(STORY_ID);
    store.writeStory(STORY_ID, { ...originalStory, description: 'Changed acceptance description after the signed observation.' });
    assert.notEqual(laneByName(handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport, 'behavior').state, 'awaiting-repair', 'Changed review context cannot retain suppression');
    store.writeStory(STORY_ID, originalStory);
    store.appendProcessEvent(STORY_ID, { type: 'run_metrics_recorded', note: 'Disposable telemetry-only review fixture observation' });
    git(root, ['add', store.storyDirPath(STORY_ID)]);
    git(root, ['commit', '-m', 'metadata-only review fixture note']);
    const boundRun = store.readReviewRuns(STORY_ID).runs.find(row => row.agent === 'proof-or-stop-review-behavior')!;
    assert.notEqual(git(root, ['rev-parse', 'HEAD']), boundRun.headHash, 'Metadata proof must advance HEAD');
    assert.deepEqual(git(root, ['diff', '--name-only', beforeMetadataHead, 'HEAD']).split('\n').filter(Boolean), [relative(root, store.storyFilePath(STORY_ID, 'process-events.jsonl'))]);
    // The material-hash fast path classifies unchanged bytes as CURRENT_MATERIAL.
    assert.equal(classifyEvidenceFreshness(checkEvidenceFreshnessForGit(root, boundRun.headHash, boundRun.materialHash, root, boundRun.storyFilesHash), boundRun.headHash), 'CURRENT_MATERIAL');
    const metadata = handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport;
    assert.equal(laneByName(metadata, 'behavior').state, 'awaiting-repair');
    assert.deepEqual(metadata.gate.blockedBy, before.gate.blockedBy);
    const beforeStoryHash = currentStoryFilesHash(root);
    assert.equal(laneByName(handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport, 'behavior').state, 'awaiting-repair', 'Story drift counterexample must start from suppression');
    write(root, 'src/story-owned.ts', 'export const storyOwned = 2;\n');
    git(root, ['add', 'src/story-owned.ts']);
    git(root, ['commit', '-m', 'repair changes Story material']);
    const repaired = handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport;
    assert.notEqual(laneByName(repaired, 'behavior').state, 'awaiting-repair');
    assertAgentLaunchInstruction(laneByName(repaired, 'behavior').launchInstruction, 'behavior');
    assert.ok(repaired.executionPlan.launchableLanes.includes(behavior.lane), 'Story material drift restores behavior to the child-id barrier');
    assert.equal(repaired.gate.ready, false, 'Changing code is not a new review PASS');
    console.log('FIRST_FINDING_STORY_DRIFT_REVIEW_REQUIRED');
    assert.notEqual(currentStoryFilesHash(root), beforeStoryHash, 'Changed Story source must change its actual input hash');
    // Restore fixture bytes with an ordinary commit, then independently test main drift.
    write(root, 'src/story-owned.ts', 'export const storyOwned = 1;\n');
    git(root, ['add', 'src/story-owned.ts']);
    git(root, ['commit', '-m', 'restore fixture input for independent main drift counterexample']);
    assert.equal(currentStoryFilesHash(root), beforeStoryHash);
    assert.equal(laneByName(handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport, 'behavior').state, 'awaiting-repair', 'Main drift counterexample must also start from suppression');
    const storyBranch = git(root, ['branch', '--show-current']);
    git(root, ['checkout', 'main']);
    write(root, 'src/quality.ts', 'export const quality = 3;\n');
    git(root, ['add', 'src/quality.ts']);
    git(root, ['commit', '-m', 'main material drift after blocking observation']);
    git(root, ['checkout', storyBranch]);
    git(root, ['merge', '--no-ff', 'main', '-m', 'merge later main material']);
    const after = handler({ storyId: STORY_ID, json: true }) as ReviewerBatchReport;
    const lane = laneByName(after, 'behavior');
    assert.deepEqual(lane.blockingFindings, [behaviorFindingId], 'The valid finding remains a blocker after unrelated main drift');
    assert.equal(lane.state, 'blocking', 'MAIN_DRIFT_MUST_NOT_SUPPRESS_REVIEW');
    assertAgentLaunchInstruction(lane.launchInstruction, 'behavior');
    assert.ok(after.executionPlan.launchableLanes.includes(behavior.lane), 'main material drift restores behavior to the child-id barrier');
    assert.deepEqual(after.gate.blockedBy, before.gate.blockedBy, 'Launch guidance must not change gate blockers');
    console.log('FIRST_FINDING_MAIN_DRIFT_REVIEW_REQUIRED');

  } finally { resetConfigCache(); rmSync(root, { recursive: true, force: true }); }
}

{
  const executionPlan = buildReviewerExecutionPlan([]);
  assert.deepEqual(executionPlan, {
    strategy: 'parallel-barrier',
    launchableLanes: [],
    launchAllBeforeWait: true,
    waitPolicy: 'no-wait',
    maxConcurrency: 0,
  }, 'an empty launch set must produce an explicit no-wait policy');
  const rendered = renderReviewerBatchReport({
    storyId: STORY_ID,
    reviewRound: null,
    lanes: [],
    executionPlan,
    gate: { blockedBy: [], ready: true },
    readinessReport: { target: 'TEST', storyId: STORY_ID, phase: 'REVIEW', readiness: [], artifacts: {} } as unknown as ReviewerBatchReport['readinessReport'],
    mode: { runCommands: false, writeEvidence: false },
    claims: { authorityDone: false, productionDone: false },
  });
  assert.match(rendered, /no launchable lanes: do not call a host wait operation/);
  assert.doesNotMatch(rendered, /complete child-id set/);
}

process.stdout.write('reviewer_batch smoke passed\n');
