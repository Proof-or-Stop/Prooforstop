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
 *   - behavior      — a blocking verified finding open for the lane → blocking
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { StoryStore } from '../core/store.js';
import { createMainRegistry } from '../registry.js';
import { buildStoryReadinessReport } from '../core/lifecycle-readiness.js';
import { currentGitHead } from '../core/evidence-freshness.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { signReviewRun } from '../core/review-run.js';
import { assembleFullPromptEnvelope } from '../core/prompt-envelope.js';
import { promptRoleContract, resolvePromptRoleBody, reviewerHostRenderIdentity } from '../core/prompt-role-contract-registry.js';
import { reviewerDispatchBindingDigest, reviewerDispatchPromptDigest } from '../core/prompt-contracts.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import type { HandlerContext } from '../handlers/context.js';
import type { ReviewerBatchReport } from '../handlers/reviewer-batch.js';
import type {
  ChecklistData,
  Finding,
  ReviewPass,
  ReviewRun,
  StoryEvent,
  StoryInfo,
} from '../core/types.js';

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
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

const BASE_MS = Date.parse('2026-06-16T00:00:00.000Z');
function ts(n: number): string {
  return new Date(BASE_MS + n * 60_000).toISOString();
}

/**
 * A story that has entered REVIEW once. currentReviewRound is deliberately UNSET
 * so reviewer evidence run-binding validation short-circuits to valid (no git /
 * freshness machinery): record validity then depends only on the production
 * signature, and the per-lane scopeChanged is driven purely by the bound run
 * headHash via review_incremental_context. riskSignal 'gate' activates behavior.
 */
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

function signedPass(id: string, agent: string, createdAt: string, reviewRunId: string, envelopeId: string): ReviewPass {
  const note = `no blocker from ${agent}`;
  const provenance = { writerSessionId: 'reviewer-batch-isolated-fixture', sessionSource: 'explicit' };
  const pass: ReviewPass = { id, agent, note, createdAt, reviewRunId, envelopeId, ...provenance };
  // reviewRound left empty (currentReviewRound unset); signature domain includes reviewRunId.
  pass._hash = signReviewPass(STORY_ID, id, agent, note, createdAt, '', reviewRunId, undefined, undefined, undefined, provenance, envelopeId);
  return pass;
}

function runFor(store: StoryStore, reviewRunId: string, agent: string, headHash: string): ReviewRun {
  const host = reviewerHostRenderIdentity(process.cwd(), agent, 'codex', 'full-envelope');
  const dispatchPrompt = `Inspect ${STORY_ID} as ${agent}.`;
  const dispatchBindingDigest = reviewerDispatchBindingDigest({ storyId: STORY_ID, lane: agent, reviewRound: ts(1),
    dispatchPromptDigest: reviewerDispatchPromptDigest(dispatchPrompt), hostRenderIdentityDigest: host.identityDigest });
  const envelope = assembleFullPromptEnvelope({ roleContract: promptRoleContract(agent), runtimeContract: BASELINE_RUNTIME_CONTRACT,
    rolePrompt: resolvePromptRoleBody(agent, { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { [agent]: 'full-envelope' } }).body,
    taskContext: { schemaVersion: 'proof-or-stop.full-task-context.v1', storyId: STORY_ID, title: 'Reviewer batch fixture',
      description: 'Exercise current and stale prior-head lane classification with real envelope signatures.', phase: 'REVIEW', priority: 'high',
      checklist: [], headHash, materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64) },
    dispatchKind: 'review-run', reviewRunId, reviewRound: ts(1), lane: agent, dispatchPrompt,
    hostRenderIdentityDigest: host.identityDigest, reviewerDispatchBindingDigest: dispatchBindingDigest,
    launcherSpec: { reviewedIntentRefs: [], dispatchBindingDigest, hostRenderHost: 'codex' }, createdAt: ts(2) });
  const run: ReviewRun = {
    reviewRunId,
    storyId: STORY_ID,
    agent,
    lane: agent,
    reviewRound: ts(1),
    startedAt: ts(2),
    headHash,
    materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64),
    promptHash: envelope.envelope.assembledPromptDigest, envelopeId: envelope.envelope.envelopeId, assembledPrompt: envelope.prompt,
  };
  run._hash = signReviewRun(STORY_ID, reviewRunId, agent, agent, run.reviewRound, run.startedAt, headHash,
    run.materialHash, run.promptHash, undefined, undefined, run.storyFilesHash, run.envelopeId);
  store.writePromptEnvelopes(STORY_ID, { envelopes: [...store.readPromptEnvelopes(STORY_ID).envelopes, envelope.envelope] });
  store.writeReviewPromptBody(STORY_ID, envelope.prompt, run.promptHash);
  return run;
}

function signedBlockingFinding(id: string, agent: string, createdAt: string): Finding {
  const desc = `critical blocker from ${agent}`;
  // critical + open + no reviewRunId (binding skipped while currentReviewRound is
  // unset) → verifyFinding passes on the round-only signature; isFindingBlocking
  // (critical) blocks in every round.
  return {
    id,
    desc,
    severity: 'critical',
    category: 'missing',
    status: 'open',
    agent,
    createdAt,
    _hash: signFinding(STORY_ID, id, desc, 'critical', createdAt, '', ''),
  };
}

/**
 * Build a real git fixture: `main` holds the base commit (story branch will be
 * ahead so the no-receipt lane's first-pass full diff is non-empty), then a story
 * branch edits src/quality.ts. Returns the repo root + base/head SHAs so the
 * current-pass lane binds to HEAD and the scope-changed lane binds to baseSha.
 */
function createFixture(): {
  root: string;
  store: StoryStore;
  ctx: HandlerContext;
} {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-reviewer-batch-'));
  writeConfig(root);
  write(root, '.gitignore', '.proof-or-stop/activity.jsonl\n');
  write(root, 'src/concept.ts', 'export const concept = 1;\n');
  write(root, 'src/quality.ts', 'export const quality = 1;\n');
  write(root, 'src/testcov.ts', 'export const testcov = 1;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'base on main']);
  const baseSha = currentGitHead(root)!;

  // Story branch ahead of main: a material edit to src/quality.ts.
  git(root, ['checkout', '-b', `story/${STORY_ID}`]);
  write(root, 'src/quality.ts', 'export const quality = 2; // edited\n');
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'quality edit']);
  const headSha = currentGitHead(root)!;

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, reviewStory());
  store.writeChecklist(STORY_ID, checklist());

  // concept: current-round pass bound to HEAD → nothing changed since → current.
  // quality: prior pass bound to baseSha → src/quality.ts changed since → scope-changed.
  // test-coverage: no pass → no-receipt.
  // behavior: critical open finding → blocking (no pass needed; blocking wins).
  const conceptRun = runFor(store, 'RR-concept', 'proof-or-stop-review-concept', headSha);
  const qualityRun = runFor(store, 'RR-quality', 'proof-or-stop-review-quality', baseSha);
  store.writeReviewRuns(STORY_ID, { runs: [conceptRun, qualityRun] });
  store.writeReviewPasses(STORY_ID, {
    passes: [
      signedPass('RP-concept', 'proof-or-stop-review-concept', ts(3), 'RR-concept', conceptRun.envelopeId!),
      signedPass('RP-quality', 'proof-or-stop-review-quality', ts(4), 'RR-quality', qualityRun.envelopeId!),
    ],
  });
  store.writeFindings(STORY_ID, {
    findings: [signedBlockingFinding(`${STORY_ID}:F-1`, 'proof-or-stop-review-behavior', ts(5))],
  });

  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
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
 * Assert a needs-run lane's launchInstruction is the canonical Agent subagent-spawn
 * form — NOT a runnable dispatch CLI command. Asserts the SHAPE (prefix, storyId,
 * absence of "dispatch") so the old broken dispatch template would FAIL the smoke.
 */
function assertAgentLaunchInstruction(instruction: string | null, lane: string): void {
  assert.ok(instruction, `${lane}: needs-run lane carries a launch instruction`);
  const value = instruction!;
  assert.match(
    value,
    new RegExp(`^Agent\\(\\{ subagent_type: "proof-or-stop-review-${lane}"`),
    `${lane}: launch instruction is the canonical Agent-spawn form`,
  );
  assert.ok(value.includes(STORY_ID), `${lane}: launch instruction names the storyId`);
  assert.ok(!value.includes('dispatch'), `${lane}: launch instruction is NOT a dispatch CLI command`);
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
  const { root, store, ctx } = createFixture();
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
    assert.ok(concept.priorVerdict && concept.priorVerdict.includes('RP-concept'), 'concept priorVerdict references its pass');

    assert.equal(quality.state, 'scope-changed', 'quality: prior pass at baseSha, material changed since');
    assert.equal(quality.scopeChanged, true, 'quality: src/quality.ts changed since its last pass');
    assert.ok(quality.changedFilesSinceLastPass.includes('src/quality.ts'), 'quality changedFiles includes the edited material file');
    assert.ok(quality.priorVerdict && quality.priorVerdict.includes('RP-quality'), 'quality priorVerdict references its pass');

    assert.equal(testcov.state, 'no-receipt', 'test-coverage: no pass → no-receipt');
    assert.equal(testcov.scopeChanged, true, 'test-coverage: first-pass full diff → scopeChanged=true');

    assert.equal(behavior.state, 'blocking', 'behavior: blocking verified finding → blocking');
    assert.deepEqual(behavior.blockingFindings, [`${STORY_ID}:F-1`], 'behavior lane lists the blocking finding id');

    // (c) launch instructions: each needs-run lane carries the canonical Agent-spawn
    //     form (asserted by SHAPE, so the old dispatch CLI template would fail);
    //     the current-pass lane carries launchInstruction=null.
    assert.equal(concept.launchInstruction, null, 'current-pass lane has no launch instruction');
    assertAgentLaunchInstruction(quality.launchInstruction, 'quality');
    assertAgentLaunchInstruction(testcov.launchInstruction, 'test-coverage');
    assertAgentLaunchInstruction(behavior.launchInstruction, 'behavior');

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
    assert.match(text, /behavior \[blocking\]/);
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
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('reviewer_batch smoke passed\n');
