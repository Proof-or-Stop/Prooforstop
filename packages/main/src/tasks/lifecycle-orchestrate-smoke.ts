#!/usr/bin/env node
/**
 * Lifecycle Readiness P8 (CAPSTONE) — lifecycle_orchestrate smoke.
 *
 * Proves the read-only top-level lifecycle orchestration command
 * (handlers/lifecycle-orchestrate.ts), which COMPOSES the prior read-only layers
 * (V1 StoryReadinessReport + P2-P7) into ONE consolidated, PHASE-AWARE view by
 * calling each prior handler's READ-ONLY DEFAULT path ({ storyId, json:true }) and
 * emitting the next story_advance command as a PRINTED string (never executed).
 *
 * Asserts (mirroring the P3 evidence-plan smoke, pure read-only):
 *   (a) READ-ONLY — no story-metadata mutation, git status unchanged, no command
 *       run.
 *   (b) the readiness section deepEquals a direct buildStoryReadinessReport at the
 *       phase-appropriate target (composition, NOT re-derivation).
 *   (c) PHASE-AWARE — the REVIEW fixture's sections include reviewerBatch; the PLAN
 *       fixture's sections include planSkeleton (and neither dumps the other's).
 *   (d) handoff.command is a STRING and handoff.executed is false AND the story
 *       phase is UNCHANGED after running (story_advance NOT executed).
 *   (e) NO prior-layer opt-in writer is invoked and NO evidence/artifact/
 *       review-runs/delivery-check file is written — the story-dir snapshot is
 *       byte-identical, including that no delivery-context-pack.json /
 *       live-smoke-transcript.json appeared.
 *   (f) assertBoundary fail-closed on the side-effect flags (no store read).
 *   (g) byte-identical across two runs (idempotent).
 *   (h) a storyId path-traversal id is rejected (isCanonicalStoryId guard).
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
import { createPlanSkeletonHandlers } from '../handlers/plan-skeleton.js';
import { createEvidencePlanHandlers } from '../handlers/evidence-plan.js';
import { createEvidenceRefreshHandlers } from '../handlers/evidence-refresh.js';
import { createReviewerBatchHandlers } from '../handlers/reviewer-batch.js';
import { createLiveSmokeTranscriptHandlers } from '../handlers/live-smoke-transcript.js';
import { createDeliveryContextPackHandlers } from '../handlers/delivery-context-pack.js';
import { currentGitHead } from '../core/evidence-freshness.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import type { HandlerContext } from '../handlers/context.js';
import type { LifecycleOrchestrateReport } from '../handlers/lifecycle-orchestrate.js';
import type {
  ChecklistData,
  Finding,
  ReviewPass,
  ReviewRun,
  StoryEvent,
  StoryInfo,
  VerificationEvidence,
} from '../core/types.js';

const NOW = '2026-06-20T00:00:00.000Z';
const BASE_MS = Date.parse('2026-06-16T00:00:00.000Z');
function ts(n: number): string {
  return new Date(BASE_MS + n * 60_000).toISOString();
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'lifecycle-orchestrate-smoke',
      GIT_AUTHOR_EMAIL: 'lifecycle-orchestrate-smoke@example.com',
      GIT_COMMITTER_NAME: 'lifecycle-orchestrate-smoke',
      GIT_COMMITTER_EMAIL: 'lifecycle-orchestrate-smoke@example.com',
    },
  }).trim();
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

/**
 * Assert NO prior-layer opt-in writer produced any evidence/artifact/delivery-check
 * file that the fixture itself did not pre-seed. `seeded` lists artifacts the
 * fixture deliberately wrote as setup (e.g. a REVIEW fixture seeds
 * review-runs/review-passes/findings to activate lanes); those are excluded here.
 * The byte-identical story-dir snapshot assertion is the authoritative "nothing
 * written" proof — this is the targeted complement, focused on the P5/P6 opt-in
 * artifacts that ONLY appear if a write/capture path ran.
 */
function assertNoWriterArtifacts(store: StoryStore, storyId: string, seeded: string[] = []): void {
  const seededSet = new Set(seeded);
  for (const artifact of [
    'test-evidence.json',
    'review-runs.json',
    'review-passes.json',
    'findings.json',
    'delivery-check.json',
    'summary.json',
    'done-required-evidence.json',
    'authority-receipt-refs.json',
    'evidence/delivery-context-pack.json',
    'evidence/live-smoke-transcript.json',
  ]) {
    if (seededSet.has(artifact)) continue;
    assert.equal(
      existsSync(store.storyFilePath(storyId, artifact)),
      false,
      `${artifact} must not be written by lifecycle_orchestrate`,
    );
  }
}

/**
 * THE composition proof (F-001 / codex-3). For every composed section the
 * orchestrator emitted, INDEPENDENTLY invoke the SAME prior handler factory with
 * the SAME read-only args the orchestrator uses ({ storyId, json:true }) and
 * assert.deepEqual the orchestrator's section against that direct output. A
 * handler that RE-DERIVED a section from scratch (rather than composing the prior
 * layer verbatim) would FAIL this deepEqual. We only check sections that are
 * present (phase selection decides which), and we drive the same `ctx` so both
 * sides read identical fixture state in the same run — these reports are
 * deterministic (they consume readiness rows + fixture timestamps; no wall-clock
 * is embedded), so deepEqual holds exactly with no normalization needed.
 */
function assertSectionsComposeFromPriorLayers(
  ctx: HandlerContext,
  storyId: string,
  report: LifecycleOrchestrateReport,
): void {
  const { sections } = report;
  if (sections.planSkeleton !== undefined) {
    const direct = createPlanSkeletonHandlers(ctx).plan_skeleton({ storyId, json: true });
    assert.deepEqual(sections.planSkeleton, direct, 'planSkeleton section deepEquals plan_skeleton({ storyId, json:true })');
  }
  if (sections.evidence !== undefined) {
    const direct = createEvidencePlanHandlers(ctx).evidence_plan({ storyId, json: true });
    assert.deepEqual(sections.evidence, direct, 'evidence section deepEquals evidence_plan({ storyId, json:true })');
  }
  if (sections.evidenceRefresh !== undefined) {
    const direct = createEvidenceRefreshHandlers(ctx).evidence_refresh({ storyId, json: true });
    assert.deepEqual(sections.evidenceRefresh, direct, 'evidenceRefresh section deepEquals evidence_refresh({ storyId, json:true })');
  }
  if (sections.reviewerBatch !== undefined) {
    const direct = createReviewerBatchHandlers(ctx).reviewer_batch({ storyId, json: true });
    assert.deepEqual(sections.reviewerBatch, direct, 'reviewerBatch section deepEquals reviewer_batch({ storyId, json:true })');
  }
  if (sections.liveSmoke !== undefined) {
    const direct = createLiveSmokeTranscriptHandlers(ctx).live_smoke_transcript({ storyId, json: true });
    assert.deepEqual(sections.liveSmoke, direct, 'liveSmoke section deepEquals live_smoke_transcript({ storyId, json:true })');
  }
  if (sections.delivery !== undefined) {
    const direct = createDeliveryContextPackHandlers(ctx).delivery_context_pack({ storyId, json: true });
    assert.deepEqual(sections.delivery, direct, 'delivery section deepEquals delivery_context_pack({ storyId, json:true })');
  }
}

// ── Fixture builders ─────────────────────────────────────────────────────────

const PLAN_STORY_ID = 'B-lorch-plan';
const REVIEW_STORY_ID = 'B-lorch-review';
const TEST_STORY_ID = 'B-lorch-test';
const MINIMAL_STORY_ID = 'B-lorch-min';

function planStory(): StoryInfo {
  return {
    storyId: PLAN_STORY_ID,
    name: 'lifecycle-orchestrate-plan',
    title: 'Implement lifecycle_orchestrate',
    description: 'Read-only capstone composing the prior read-only lifecycle layers into one phase-aware view.',
    type: 'feature',
    phase: 'PLAN',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

/** A PLAN-phase story with one verification-intent item (so evidence sections appear too). */
function planChecklist(root: string): ChecklistData {
  const head = currentGitHead(root);
  assert.ok(head, 'fixture git head is readable');
  const freshEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:happy:0',
    kind: 'logic_test',
    result: 'pass',
    note: 'fresh',
    headHash: head!,
    materialHash: head!,
  };
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'plan item with intent',
        context: 'one covered + one uncovered intent',
        status: 'pending',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'covered intent', type: 'logic', priority: 'must' }],
          edge: [{ desc: 'uncovered intent', type: 'logic', priority: 'must' }],
          adversarial: [],
        },
        verificationEvidence: [freshEvidence],
      },
    ],
  };
}

function reviewStory(): StoryInfo {
  const events: StoryEvent[] = [
    { phase: 'REVIEW', action: 'advance', timestamp: ts(1) } as StoryEvent,
  ];
  return {
    storyId: REVIEW_STORY_ID,
    name: 'lifecycle-orchestrate-review',
    title: 'lifecycle_orchestrate review fixture',
    description: 'Read-only capstone REVIEW-phase fixture with an active reviewer lane.',
    type: 'feature',
    priority: 'high',
    phase: 'REVIEW',
    // StoryInfo.riskSignals is Array<{ category: string; matched: string }> — the
    // matched-token field, not a free-text `note`. Using the correct field lets the
    // fixture be typed directly as StoryInfo (no unsound double-cast).
    riskSignals: [{ category: 'gate', matched: 'gate' }],
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events,
  };
}

function reviewChecklist(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'review item',
        context: 'review-phase fixture',
        status: 'done',
        startTime: null,
        endTime: null,
      },
    ],
  };
}

function signedPass(storyId: string, id: string, agent: string, createdAt: string, reviewRunId: string): ReviewPass {
  const note = `no blocker from ${agent}`;
  const pass: ReviewPass = { id, agent, note, createdAt, reviewRunId };
  pass._hash = signReviewPass(storyId, id, agent, note, createdAt, '', reviewRunId);
  return pass;
}

function runFor(storyId: string, reviewRunId: string, agent: string, headHash: string): ReviewRun {
  return {
    reviewRunId,
    storyId,
    agent,
    lane: agent,
    reviewRound: ts(1),
    startedAt: ts(2),
    headHash,
    materialHash: 'unused-by-incremental-context',
    promptHash: '',
  };
}

function signedBlockingFinding(storyId: string, id: string, agent: string, createdAt: string): Finding {
  const desc = `critical blocker from ${agent}`;
  return {
    id,
    desc,
    severity: 'critical',
    category: 'missing',
    status: 'open',
    agent,
    createdAt,
    _hash: signFinding(storyId, id, desc, 'critical', createdAt, '', ''),
  };
}

/** A real git fixture with `main` plus a story branch ahead, then a story in `phase`. */
function createReviewFixture(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lorch-review-'));
  writeConfig(root);
  write(root, '.gitignore', '.proof-or-stop/activity.jsonl\n');
  write(root, 'src/concept.ts', 'export const concept = 1;\n');
  write(root, 'src/quality.ts', 'export const quality = 1;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base on main']);

  git(root, ['checkout', '-b', `story/${REVIEW_STORY_ID}`]);
  write(root, 'src/quality.ts', 'export const quality = 2; // edited\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'quality edit']);
  const headSha = currentGitHead(root)!;

  const store = new StoryStore(root);
  store.writeStory(REVIEW_STORY_ID, reviewStory());
  store.writeChecklist(REVIEW_STORY_ID, reviewChecklist());

  const conceptRun = runFor(REVIEW_STORY_ID, 'RR-concept', 'proof-or-stop-review-concept', headSha);
  store.writeReviewRuns(REVIEW_STORY_ID, { runs: [conceptRun] });
  store.writeReviewPasses(REVIEW_STORY_ID, {
    passes: [signedPass(REVIEW_STORY_ID, 'RP-concept', 'proof-or-stop-review-concept', ts(3), 'RR-concept')],
  });
  store.writeFindings(REVIEW_STORY_ID, {
    findings: [signedBlockingFinding(REVIEW_STORY_ID, `${REVIEW_STORY_ID}:F-1`, 'proof-or-stop-review-behavior', ts(5))],
  });

  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function createPlanFixture(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lorch-plan-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# lifecycle orchestrate plan smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(PLAN_STORY_ID, planStory());
  store.writeChecklist(PLAN_STORY_ID, planChecklist(root));
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function testStory(): StoryInfo {
  return {
    storyId: TEST_STORY_ID,
    name: 'lifecycle-orchestrate-test',
    title: 'lifecycle_orchestrate TEST fixture',
    description: 'Read-only capstone TEST-phase fixture (approaching delivery): live-smoke + delivery sections.',
    type: 'feature',
    priority: 'high',
    phase: 'TEST',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

/** A TEST-phase checklist with one verification-intent item (evidence sections appear too). */
function testChecklist(root: string): ChecklistData {
  const head = currentGitHead(root);
  assert.ok(head, 'TEST fixture git head is readable');
  const freshEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:happy:0',
    kind: 'logic_test',
    result: 'pass',
    note: 'fresh',
    headHash: head!,
    materialHash: head!,
  };
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'test item with intent',
        context: 'one covered intent',
        status: 'done',
        startTime: null,
        endTime: null,
        userSees: 'lifecycle_orchestrate smoke passed',
        verificationIntent: {
          happy: [{ desc: 'covered intent', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [freshEvidence],
      },
    ],
  };
}

/** A real git fixture (main + story branch ahead) with a story in TEST phase. */
function createTestFixture(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lorch-test-'));
  writeConfig(root);
  write(root, '.gitignore', '.proof-or-stop/activity.jsonl\n');
  write(root, 'src/concept.ts', 'export const concept = 1;\n');
  write(root, 'src/quality.ts', 'export const quality = 1;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base on main']);

  git(root, ['checkout', '-b', `story/${TEST_STORY_ID}`]);
  write(root, 'src/quality.ts', 'export const quality = 2; // edited\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'quality edit']);

  const store = new StoryStore(root);
  store.writeStory(TEST_STORY_ID, testStory());
  store.writeChecklist(TEST_STORY_ID, testChecklist(root));
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

/** A degenerate DEV-phase story with NO verification intents (sparse capstone view). */
function minimalStory(): StoryInfo {
  return {
    storyId: MINIMAL_STORY_ID,
    name: 'lifecycle-orchestrate-minimal',
    title: 'lifecycle_orchestrate minimal fixture',
    description: 'Degenerate no-verification-intent story: the capstone renders a coherent sparse view.',
    type: 'feature',
    priority: 'low',
    phase: 'DEV',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

/** A checklist with one item that has NO verificationIntent at all. */
function minimalChecklist(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'plain item, no verification intent',
        context: 'degenerate fixture',
        status: 'pending',
        startTime: null,
        endTime: null,
      },
    ],
  };
}

function createMinimalFixture(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lorch-min-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# lifecycle orchestrate minimal smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(MINIMAL_STORY_ID, minimalStory());
  store.writeChecklist(MINIMAL_STORY_ID, minimalChecklist());
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

// ── Policy / registration assertions ─────────────────────────────────────────

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'lifecycle_orchestrate'), 'MAIN_TOOLS exposes lifecycle_orchestrate');
const policy = getCommandPolicy('lifecycle_orchestrate');
assert.equal(policy?.ownershipClass, 'readOnly', 'lifecycle_orchestrate policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'lifecycle_orchestrate policy has no destructive risk');
assert.equal(isCommandAllowed('lifecycle_orchestrate', 'PLAN', DEFAULT_PHASE_TOOLS), true, 'available in PLAN');
assert.equal(isCommandAllowed('lifecycle_orchestrate', 'REVIEW', DEFAULT_PHASE_TOOLS), true, 'available in REVIEW');
assert.equal(isCommandAllowed('lifecycle_orchestrate', 'TEST', DEFAULT_PHASE_TOOLS), true, 'available in TEST');
assert.equal(isCommandAllowed('lifecycle_orchestrate', 'DONE', DEFAULT_PHASE_TOOLS), true, 'available in DONE');

// ── (f) + (h) Fail-closed boundary (no store read on side-effect flags / traversal)

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before lifecycle_orchestrate rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/lorch-no-read', scanRoot: '/tmp/lorch-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('lifecycle_orchestrate');
  assert.ok(handler, 'registry exposes lifecycle_orchestrate for rejection test');
  for (const flag of ['runCommands', 'writeEvidence', 'advancePhase', 'launchReviewers', 'write', 'apply', 'launch', 'run', 'execute', 'authorityDone', 'fullAuthorityDone', 'productionDone'] as const) {
    assert.throws(
      () => handler!({ storyId: REVIEW_STORY_ID, [flag]: true, json: true }),
      /read-only CAPSTONE|no story facts were read/,
      `${flag}=true fails closed before store reads`,
    );
  }
  // --capture is an opt-in command-capture flag on a composed layer; rejected as a string.
  assert.throws(
    () => handler!({ storyId: REVIEW_STORY_ID, capture: 'echo hi', json: true }),
    /read-only CAPSTONE|no story facts were read/,
    'capture=<command> fails closed before store reads',
  );
  // (h) Path-traversal id is rejected by isCanonicalStoryId (no filesystem path derived).
  assert.throws(
    () => handler!({ storyId: '../../etc/passwd', json: true }),
    /not a canonical, path-safe Proof-or-Stop story id/,
    'path-traversal storyId is rejected',
  );
}

// ── REVIEW fixture: phase-aware composition + read-only invariants ────────────

{
  const { root, store, ctx } = createReviewFixture();
  try {
    const handler = createMainRegistry(ctx).get('lifecycle_orchestrate');
    assert.ok(handler, 'registry exposes lifecycle_orchestrate');

    const storyDir = store.storyDirPath(REVIEW_STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: REVIEW_STORY_ID, json: true }) as LifecycleOrchestrateReport;

    // Top-level mode + claims are hardcoded read-only.
    assert.equal(report.storyId, REVIEW_STORY_ID);
    assert.equal(report.phase, 'REVIEW');
    assert.equal(report.mode.runCommands, false);
    assert.equal(report.mode.writeEvidence, false);
    assert.equal(report.claims.authorityDone, false);
    assert.equal(report.claims.productionDone, false);

    // (b) the readiness section deepEquals a direct buildStoryReadinessReport at
    // the phase-appropriate target (REVIEW phase → TEST target). Composition, not
    // re-derivation.
    const directReport = buildStoryReadinessReport({ storyId: REVIEW_STORY_ID, target: 'TEST', store, root });
    assert.equal(report.readiness.target, 'TEST', 'REVIEW phase reads readiness at the TEST target');
    assert.deepEqual(report.readiness, directReport, 'readiness section deepEquals a direct buildStoryReadinessReport');

    // (c) PHASE-AWARE: REVIEW sections include reviewerBatch, NOT planSkeleton.
    assert.ok(report.sections.reviewerBatch, 'REVIEW sections include the reviewer_batch section');
    assert.equal(report.sections.planSkeleton, undefined, 'REVIEW sections do NOT include plan_skeleton');
    // The composed reviewerBatch section is the prior layer's read-only output.
    assert.equal(report.sections.reviewerBatch!.storyId, REVIEW_STORY_ID, 'reviewerBatch section is for the story');
    assert.ok(
      report.sections.reviewerBatch!.lanes.some((lane) => lane.lane === 'proof-or-stop-review-behavior'),
      'reviewerBatch composes the active behavior lane',
    );

    // (F-001) COMPOSITION PROOF: every present section deepEquals the SAME prior
    // handler invoked directly with { storyId, json:true } (here: reviewerBatch).
    // A re-derived section would fail this.
    assertSectionsComposeFromPriorLayers(ctx, REVIEW_STORY_ID, report);

    // Consolidated blockers come from the V1 readiness rows (no new predicate).
    const directBlockers = directReport.readiness.filter((row) => row.blocking).map((row) => row.id);
    assert.deepEqual(report.blockers.map((b) => b.id), directBlockers, 'blockers are the V1 blocking rows');
    assert.deepEqual(report.nextActions, directReport.next, 'nextActions are the V1 readiness next actions');

    // (d) handoff.command is a STRING, executed=false, target is the next phase.
    assert.equal(typeof report.handoff.command, 'string', 'handoff.command is a printed string');
    assert.match(report.handoff.command!, /^proof-or-stop story_advance --storyId=B-lorch-review --phase=TEST$/);
    assert.equal(report.handoff.target, 'TEST', 'REVIEW → next phase is TEST');
    assert.equal(report.handoff.executed, false, 'handoff.executed is false (story_advance never executed)');

    // text render is coherent and read-only.
    const text = handler!({ storyId: REVIEW_STORY_ID, format: 'text' }) as string;
    assert.match(text, /Lifecycle orchestrate \(B-lorch-review\) — consolidated view \(phase: REVIEW\)/);
    assert.match(text, /mode: read-only \(composes prior layers;/);
    assert.match(text, /sections: .*reviewerBatch/);
    assert.match(text, /Next handoff \(printed, NOT executed\): proof-or-stop story_advance --storyId=B-lorch-review --phase=TEST/);

    // (a) + (d) + (e) read-only: no metadata / git mutation, no writer artifacts,
    // phase unchanged (story_advance NOT executed).
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'lifecycle_orchestrate must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'lifecycle_orchestrate must leave git status unchanged');
    assert.equal(store.readStory(REVIEW_STORY_ID).phase, 'REVIEW', 'lifecycle_orchestrate must NOT advance phase');
    // The REVIEW fixture pre-seeds review-runs/review-passes/findings to activate
    // lanes; those are fixture setup, not files lifecycle_orchestrate wrote. The
    // byte-identical snapshot above already proves the command added nothing — this
    // additionally asserts no P5/P6 opt-in artifact (delivery-context-pack /
    // live-smoke-transcript) or test/summary writer ran.
    assertNoWriterArtifacts(store, REVIEW_STORY_ID, ['review-runs.json', 'review-passes.json', 'findings.json']);

    // (g) byte-identical across two runs (idempotent).
    const run1 = JSON.stringify(handler!({ storyId: REVIEW_STORY_ID, json: true }));
    const run2 = JSON.stringify(handler!({ storyId: REVIEW_STORY_ID, json: true }));
    assert.equal(run1, run2, 'lifecycle_orchestrate is byte-identical across two runs');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'story dir still byte-identical after repeat runs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── PLAN fixture: phase-aware composition (plan_skeleton + evidence) ──────────

{
  const { root, store, ctx } = createPlanFixture();
  try {
    const handler = createMainRegistry(ctx).get('lifecycle_orchestrate');
    assert.ok(handler, 'registry exposes lifecycle_orchestrate for PLAN fixture');

    const storyDir = store.storyDirPath(PLAN_STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: PLAN_STORY_ID, json: true }) as LifecycleOrchestrateReport;

    assert.equal(report.phase, 'PLAN');
    // PLAN phase reads readiness toward REVIEW.
    const directReport = buildStoryReadinessReport({ storyId: PLAN_STORY_ID, target: 'REVIEW', store, root });
    assert.equal(report.readiness.target, 'REVIEW', 'PLAN phase reads readiness at the REVIEW target');
    assert.deepEqual(report.readiness, directReport, 'PLAN readiness section deepEquals a direct buildStoryReadinessReport');

    // (c) PHASE-AWARE: PLAN sections include planSkeleton, NOT reviewerBatch.
    assert.ok(report.sections.planSkeleton, 'PLAN sections include the plan_skeleton section');
    assert.equal(report.sections.reviewerBatch, undefined, 'PLAN sections do NOT include reviewer_batch');
    // PLAN sections also include the evidence layers (story has verification intents).
    assert.ok(report.sections.evidence, 'PLAN sections include evidence_plan (intents present)');
    assert.ok(report.sections.evidenceRefresh, 'PLAN sections include evidence_refresh DRY preview (intents present)');
    // The composed evidence_refresh DRY preview never ran an apply pass.
    assert.equal(report.sections.evidenceRefresh!.mode.writeEvidence, false, 'evidence_refresh DRY preview wrote no evidence');
    // TEST/delivery-only sections must be absent in PLAN.
    assert.equal(report.sections.liveSmoke, undefined, 'PLAN sections do NOT include live_smoke_transcript');
    assert.equal(report.sections.delivery, undefined, 'PLAN sections do NOT include delivery_context_pack');

    // (F-001) COMPOSITION PROOF: planSkeleton + evidence + evidenceRefresh each
    // deepEqual the SAME prior handler invoked directly with { storyId, json:true }.
    assertSectionsComposeFromPriorLayers(ctx, PLAN_STORY_ID, report);

    // (d) handoff for PLAN → DEV, printed string, not executed.
    assert.match(report.handoff.command!, /^proof-or-stop story_advance --storyId=B-lorch-plan --phase=DEV$/);
    assert.equal(report.handoff.target, 'DEV', 'PLAN → next phase is DEV');
    assert.equal(report.handoff.executed, false);

    // (a) + (e) read-only: no metadata / git mutation, no writer artifacts, phase unchanged.
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'PLAN: must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'PLAN: must leave git status unchanged');
    assert.equal(store.readStory(PLAN_STORY_ID).phase, 'PLAN', 'PLAN: must NOT advance phase');
    assertNoWriterArtifacts(store, PLAN_STORY_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── TEST fixture (F-002): liveSmoke + delivery sections positively exercised ──

{
  const { root, store, ctx } = createTestFixture();
  try {
    const handler = createMainRegistry(ctx).get('lifecycle_orchestrate');
    assert.ok(handler, 'registry exposes lifecycle_orchestrate for TEST fixture');

    const storyDir = store.storyDirPath(TEST_STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: TEST_STORY_ID, json: true }) as LifecycleOrchestrateReport;

    assert.equal(report.phase, 'TEST');
    // TEST phase reads readiness toward DONE.
    const directReport = buildStoryReadinessReport({ storyId: TEST_STORY_ID, target: 'DONE', store, root });
    assert.equal(report.readiness.target, 'DONE', 'TEST phase reads readiness at the DONE target');
    assert.deepEqual(report.readiness, directReport, 'TEST readiness section deepEquals a direct buildStoryReadinessReport');

    // (F-002) The delivery-approaching sections are PRESENT.
    assert.ok(report.sections.liveSmoke, 'TEST sections include live_smoke_transcript');
    assert.ok(report.sections.delivery, 'TEST sections include delivery_context_pack');
    // Phase-aware negatives: planSkeleton/reviewerBatch are NOT in a TEST view.
    assert.equal(report.sections.planSkeleton, undefined, 'TEST sections do NOT include plan_skeleton');
    assert.equal(report.sections.reviewerBatch, undefined, 'TEST sections do NOT include reviewer_batch');
    // The composed liveSmoke section is the prior layer's read-only STATUS default
    // (no command ran, nothing persisted).
    assert.equal(report.sections.liveSmoke!.mode.runCommands, false, 'liveSmoke composed in read-only STATUS mode (no capture)');
    assert.equal(report.sections.liveSmoke!.mode.writeEvidence, false, 'liveSmoke composed without --write');
    assert.equal(report.sections.delivery!.mode.writeEvidence, false, 'delivery composed without --write');
    assert.equal(report.sections.delivery!.isSigner, false, 'delivery section is a context producer, never a signer');

    // (F-002 / F-001) COMPOSITION PROOF: liveSmoke AND delivery (and the evidence
    // layers) each deepEqual the SAME prior handler invoked directly.
    assertSectionsComposeFromPriorLayers(ctx, TEST_STORY_ID, report);

    // (d) handoff for TEST → DONE, printed string, not executed.
    assert.match(report.handoff.command!, /^proof-or-stop story_advance --storyId=B-lorch-test --phase=DONE$/);
    assert.equal(report.handoff.target, 'DONE', 'TEST → next phase is DONE');
    assert.equal(report.handoff.executed, false);

    // text render shows the liveSmoke + delivery section detail blocks.
    const text = handler!({ storyId: TEST_STORY_ID, format: 'text' }) as string;
    assert.match(text, /phase: TEST/);
    assert.match(text, /Section: liveSmoke/);
    assert.match(text, /Section: delivery/);
    assert.match(text, /Live smoke transcript \(B-lorch-test\)/);
    assert.match(text, /Delivery context pack \(B-lorch-test\)/);

    // (a) + (e) read-only: no metadata / git mutation, no writer artifacts, phase unchanged.
    // In particular NO delivery-context-pack.json / live-smoke-transcript.json appeared
    // (those only exist if a write/capture opt-in ran).
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'TEST: must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'TEST: must leave git status unchanged');
    assert.equal(store.readStory(TEST_STORY_ID).phase, 'TEST', 'TEST: must NOT advance phase');
    assertNoWriterArtifacts(store, TEST_STORY_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Minimal/degenerate fixture (F-002): sparse, no-intent, no crash ──────────

{
  const { root, store, ctx } = createMinimalFixture();
  try {
    const handler = createMainRegistry(ctx).get('lifecycle_orchestrate');
    assert.ok(handler, 'registry exposes lifecycle_orchestrate for minimal fixture');

    const storyDir = store.storyDirPath(MINIMAL_STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    // A degenerate DEV-phase story with no verification intents renders coherently.
    const report = handler!({ storyId: MINIMAL_STORY_ID, json: true }) as LifecycleOrchestrateReport;
    assert.equal(report.phase, 'DEV');
    // DEV phase reads readiness toward REVIEW.
    const directReport = buildStoryReadinessReport({ storyId: MINIMAL_STORY_ID, target: 'REVIEW', store, root });
    assert.equal(report.readiness.target, 'REVIEW', 'minimal (DEV) reads readiness at the REVIEW target');
    assert.deepEqual(report.readiness, directReport, 'minimal readiness section deepEquals a direct buildStoryReadinessReport');

    // No verification intents → NO evidence section (and none of the phase-gated ones).
    assert.equal(report.sections.evidence, undefined, 'minimal: no evidence section without verification intents');
    assert.equal(report.sections.evidenceRefresh, undefined, 'minimal: no evidence_refresh section without verification intents');
    assert.equal(report.sections.planSkeleton, undefined, 'minimal (DEV): no plan_skeleton section');
    assert.equal(report.sections.reviewerBatch, undefined, 'minimal (DEV): no reviewer_batch section');
    assert.equal(report.sections.liveSmoke, undefined, 'minimal (DEV): no live_smoke_transcript section');
    assert.equal(report.sections.delivery, undefined, 'minimal (DEV): no delivery_context_pack section');
    assert.equal(Object.keys(report.sections).length, 0, 'minimal: a sparse view with zero composed sections');

    // The composition proof is vacuously satisfied (no sections), but assert it runs cleanly.
    assertSectionsComposeFromPriorLayers(ctx, MINIMAL_STORY_ID, report);

    // text render is coherent (no crash) and reports "sections: none".
    const text = handler!({ storyId: MINIMAL_STORY_ID, format: 'text' }) as string;
    assert.match(text, /Lifecycle orchestrate \(B-lorch-min\)/);
    assert.match(text, /phase: DEV/);
    assert.match(text, /sections: none/);
    assert.doesNotMatch(text, /Section: /, 'minimal: no per-section detail blocks rendered');

    // (d) handoff for DEV → REVIEW, printed string, not executed.
    assert.match(report.handoff.command!, /^proof-or-stop story_advance --storyId=B-lorch-min --phase=REVIEW$/);
    assert.equal(report.handoff.executed, false);

    // read-only invariants hold for the degenerate path too.
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'minimal: must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'minimal: must leave git status unchanged');
    assert.equal(store.readStory(MINIMAL_STORY_ID).phase, 'DEV', 'minimal: must NOT advance phase');
    assertNoWriterArtifacts(store, MINIMAL_STORY_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('lifecycle_orchestrate smoke passed\n');
