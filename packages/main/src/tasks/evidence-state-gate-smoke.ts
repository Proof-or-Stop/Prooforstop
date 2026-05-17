#!/usr/bin/env node
/**
 * B-3fad CHK-001: evidence-state gate smoke.
 *
 * Verifies the Finding `evidenceState` axis (suspected/verified/disproven) and the
 * REVIEW->TEST gate predicate that consumes it. The gate blocking predicate
 * (machine.ts canPassReview / getGuardFailureReason, guard-utils.ts) is:
 *
 *   status === 'open'
 *   && severity ∈ {critical, high}
 *   && (evidenceState === 'verified' || evidenceState == null)   // legacy compat
 *   && !isAdvisoryThisRound(severity, round)
 *
 * Test matrix (plan.md#CHK-001), each asserted below:
 *   1. legacy critical/high open finding missing evidenceState  -> still blocks
 *   2. reviewer new critical/high default verified              -> still blocks
 *   3. reviewer critical/high explicit suspected (+reason)       -> not blocking, advisory in summary
 *   4. verified critical/high but status resolved/dismissed      -> not blocking
 *   5. disproven critical/high open                              -> not blocking
 *   6. finding_list output renders evidenceState on every finding
 *   7. explicit suspected without uncertaintyReason              -> finding_add throws
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { getGuardFailureReason } from '../core/machine.js';
import { signFinding } from '../core/finding-verify.js';
import { signReviewRun } from '../core/review-run.js';
import { isFindingBlocking, isEvidenceStateBlocking } from '../core/advisory.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import type { ChecklistData, Finding, FindingEvidenceState, ReviewRun, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const REVIEW_ROUND = '2026-05-17T12:01:00.000Z';
const STORY_ID = 'B-evst';
const REVIEWERS = ['koala-review-concept', 'koala-review-quality', 'koala-review-test-coverage'];

/**
 * Build a tmp repo with a story already in REVIEW phase, checklist done,
 * understanding/decision present, and signed review runs for every opt-in reviewer.
 * Returns the store + worktree path; callers seed findings then run the TEST gate.
 */
function createReviewRepo(): { root: string; store: StoryStore; runIds: Map<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'koala-evst-'));
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }));
  write(root, 'README.md', 'evidence-state gate smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  const now = '2026-05-17T12:00:00.000Z';
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'evidence-state-gate-smoke',
    title: 'Evidence state gate smoke',
    description: 'Synthetic story exercising the evidenceState REVIEW gate dimension.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: REVIEW_ROUND,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: REVIEW_ROUND }],
  };
  const checklist: ChecklistData = {
    items: ['001', '002', '003'].map((suffix) => ({
      id: `CHK-${suffix}`,
      title: `Done item ${suffix}`,
      context: 'Synthetic checklist item.',
      status: 'done' as const,
      startTime: now,
      endTime: now,
    })),
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, checklist);
  store.writeUnderstanding(STORY_ID, {
    task: 'Check evidenceState gate',
    outcome: 'Gate only blocks verified critical/high open findings',
    facts: [],
    constraints: [],
    unknowns: [],
    touchpoints: ['packages/main/src/core/machine.ts'],
    timestamp: now,
  });
  store.writeDecision(STORY_ID, {
    principles: ['keep gate predicate explicit', 'reuse reviewer routing', 'avoid fixture leakage'],
    drivers: ['evidenceState gate smoke coverage'],
    options: [
      { name: 'A: shared predicate', pros: ['single source of truth'], cons: ['needs signed fixtures'] },
      { name: 'B: inline copy', pros: ['simple'], cons: ['drifts from gate'] },
    ],
    chosen: 'A: shared predicate',
    rationale: 'evidenceState gate must be tested against the real machine guard',
    timestamp: now,
  });

  const headHash = currentGitHead(root) || `head-${REVIEW_ROUND}`;
  const materialHash = currentMaterialHash(root) || `material-${REVIEW_ROUND}`;
  const runs: ReviewRun[] = REVIEWERS.map((agent, index) => {
    const reviewRunId = `${STORY_ID}:RR-${String(index + 1).padStart(3, '0')}`;
    const startedAt = `2026-05-17T11:${String(index).padStart(2, '0')}:00.000Z`;
    return {
      reviewRunId,
      storyId: STORY_ID,
      agent,
      lane: agent,
      reviewRound: REVIEW_ROUND,
      startedAt,
      headHash,
      materialHash,
      promptHash: '',
      _hash: signReviewRun(STORY_ID, reviewRunId, agent, agent, REVIEW_ROUND, startedAt, headHash, materialHash, ''),
    };
  });
  store.writeReviewRuns(STORY_ID, { runs });
  const runIds = new Map(runs.map((run) => [run.agent, run.reviewRunId]));
  return { root, store, runIds };
}

/** Make a signed reviewer finding with explicit severity/status/evidenceState. */
function makeFinding(opts: {
  idSuffix: string;
  agent: string;
  reviewRunId: string;
  severity: Finding['severity'];
  status: Finding['status'];
  evidenceState?: FindingEvidenceState;
  uncertaintyReason?: string;
}): Finding {
  const id = `${STORY_ID}:F-${opts.idSuffix}`;
  const createdAt = `2026-05-17T12:00:${opts.idSuffix}.000Z`;
  const desc = `${opts.agent} ${opts.severity} finding ${opts.idSuffix}`;
  return {
    id,
    desc,
    severity: opts.severity,
    category: 'happy',
    status: opts.status,
    ...(opts.evidenceState ? { evidenceState: opts.evidenceState } : {}),
    ...(opts.uncertaintyReason ? { uncertaintyReason: opts.uncertaintyReason } : {}),
    agent: opts.agent,
    createdAt,
    reviewRound: REVIEW_ROUND,
    reviewRunId: opts.reviewRunId,
    _hash: signFinding(STORY_ID, id, desc, opts.severity, createdAt, REVIEW_ROUND, opts.reviewRunId),
  };
}

/**
 * Seed three reviewers' findings so the Round-1 opt-in coverage gate is satisfied,
 * with the first reviewer carrying the `subject` finding under test.
 */
function seedWithSubject(store: StoryStore, runIds: Map<string, string>, subject: Finding): void {
  store.writeFindings(STORY_ID, {
    findings: [
      subject,
      makeFinding({ idSuffix: '101', agent: 'koala-review-quality', reviewRunId: runIds.get('koala-review-quality')!, severity: 'low', status: 'resolved' }),
      makeFinding({ idSuffix: '102', agent: 'koala-review-test-coverage', reviewRunId: runIds.get('koala-review-test-coverage')!, severity: 'low', status: 'resolved' }),
    ],
  });
}

// ── Matrix item 1: legacy critical/high open finding missing evidenceState -> still blocks ──
function assertLegacyMissingEvidenceStateStillBlocks(): void {
  const { root, store, runIds } = createReviewRepo();
  try {
    const legacy = makeFinding({
      idSuffix: '001', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
      severity: 'critical', status: 'open',
      // intentionally NO evidenceState field -> legacy finding
    });
    assert.equal(legacy.evidenceState, undefined, 'fixture must be a legacy finding without evidenceState');
    seedWithSubject(store, runIds, legacy);
    const reason = getGuardFailureReason(STORY_ID, store, 'TEST', root);
    assert.ok(reason, 'legacy critical open finding must still block REVIEW->TEST');
    assert.match(reason ?? '', /blocking finding/);
    assert.match(reason ?? '', new RegExp(legacy.id));
    // shared predicate cross-check
    assert.equal(isEvidenceStateBlocking(undefined), true, 'legacy missing field counts as verified');
    assert.equal(isFindingBlocking(legacy, ['critical', 'high'], 1), true);
    console.log('✓ matrix-1: legacy critical/high open finding missing evidenceState still blocks');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Matrix item 2: reviewer new critical/high default verified -> still blocks ──
function assertVerifiedOpenStillBlocks(): void {
  const { root, store, runIds } = createReviewRepo();
  try {
    const verified = makeFinding({
      idSuffix: '002', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
      severity: 'high', status: 'open', evidenceState: 'verified',
    });
    seedWithSubject(store, runIds, verified);
    const reason = getGuardFailureReason(STORY_ID, store, 'TEST', root);
    assert.ok(reason, 'verified high open finding must block REVIEW->TEST');
    assert.match(reason ?? '', new RegExp(verified.id));
    assert.equal(isFindingBlocking(verified, ['critical', 'high'], 1), true);
    console.log('✓ matrix-2: reviewer critical/high default verified still blocks');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Matrix item 3: reviewer critical/high explicit suspected (+reason) -> not blocking, advisory ──
function assertSuspectedDoesNotBlockAndIsAdvisory(): void {
  const { root, store, runIds } = createReviewRepo();
  try {
    const suspected = makeFinding({
      idSuffix: '003', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
      severity: 'critical', status: 'open', evidenceState: 'suspected',
      uncertaintyReason: 'no repro yet, only static reading of the code path',
    });
    seedWithSubject(store, runIds, suspected);
    const reason = getGuardFailureReason(STORY_ID, store, 'TEST', root);
    assert.equal(reason, null, 'suspected critical open finding must NOT block REVIEW->TEST');
    assert.equal(isFindingBlocking(suspected, ['critical', 'high'], 1), false);

    // suspected finding surfaces in finding_list advisory/attention area, not blocking.
    const out = execFileSync(process.execPath, [cliPath, 'finding_list', JSON.stringify({ storyId: STORY_ID })], {
      cwd: root, env: { ...process.env, KOALA_PROJECT_ROOT: root }, encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.attention?.suspected), 'finding_list must expose attention.suspected');
    assert.ok(parsed.attention.suspected.includes(suspected.id), 'suspected finding must appear in advisory/attention area');
    console.log('✓ matrix-3: reviewer critical/high explicit suspected does not block, shows as advisory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Matrix item 4: verified critical/high but status resolved/dismissed -> not blocking ──
function assertResolvedAndDismissedDoNotBlock(): void {
  for (const status of ['resolved', 'dismissed'] as const) {
    const { root, store, runIds } = createReviewRepo();
    try {
      const closed = makeFinding({
        idSuffix: '004', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
        severity: 'critical', status, evidenceState: 'verified',
      });
      seedWithSubject(store, runIds, closed);
      const reason = getGuardFailureReason(STORY_ID, store, 'TEST', root);
      assert.equal(reason, null, `verified critical finding with status=${status} must NOT block`);
      assert.equal(isFindingBlocking(closed, ['critical', 'high'], 1), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log('✓ matrix-4: verified critical/high resolved/dismissed do not block');
}

// ── Matrix item 5: disproven critical/high open -> not blocking ──
function assertDisprovenOpenDoesNotBlock(): void {
  const { root, store, runIds } = createReviewRepo();
  try {
    const disproven: Finding = {
      ...makeFinding({
        idSuffix: '005', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
        severity: 'critical', status: 'open',
      }),
      evidenceState: 'disproven',
      disprovenEvidence: {
        summary: 'the suspected race cannot occur because the lock is held across the whole path',
        sourceRefs: ['packages/main/src/handlers/finding.ts:27'],
        reproCommand: 'npm --prefix packages/main run test:evidence-state-gate-smoke',
      },
    };
    seedWithSubject(store, runIds, disproven);
    const reason = getGuardFailureReason(STORY_ID, store, 'TEST', root);
    assert.equal(reason, null, 'disproven critical open finding must NOT block REVIEW->TEST');
    assert.equal(isFindingBlocking(disproven, ['critical', 'high'], 1), false);

    const out = execFileSync(process.execPath, [cliPath, 'finding_list', JSON.stringify({ storyId: STORY_ID })], {
      cwd: root, env: { ...process.env, KOALA_PROJECT_ROOT: root }, encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    assert.ok(parsed.attention?.disproven?.includes(disproven.id), 'disproven finding must appear in attention area');
    console.log('✓ matrix-5: disproven critical/high open finding does not block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Matrix item 6: finding_list output renders evidenceState on every finding ──
function assertFindingListRendersEvidenceState(): void {
  const { root, store, runIds } = createReviewRepo();
  try {
    // mix: legacy (no field), explicit verified, explicit suspected.
    const legacy = makeFinding({
      idSuffix: '006', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
      severity: 'low', status: 'resolved',
    });
    const verified = makeFinding({
      idSuffix: '007', agent: 'koala-review-quality', reviewRunId: runIds.get('koala-review-quality')!,
      severity: 'medium', status: 'open', evidenceState: 'verified',
    });
    const suspected = makeFinding({
      idSuffix: '008', agent: 'koala-review-test-coverage', reviewRunId: runIds.get('koala-review-test-coverage')!,
      severity: 'high', status: 'open', evidenceState: 'suspected',
      uncertaintyReason: 'flagged by static read, repro still pending',
    });
    store.writeFindings(STORY_ID, { findings: [legacy, verified, suspected] });

    const out = execFileSync(process.execPath, [cliPath, 'finding_list', JSON.stringify({ storyId: STORY_ID })], {
      cwd: root, env: { ...process.env, KOALA_PROJECT_ROOT: root }, encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.findings.length, 3);
    for (const f of parsed.findings) {
      assert.ok(
        ['suspected', 'verified', 'disproven'].includes(f.evidenceState),
        `every finding must render an evidenceState, got: ${JSON.stringify(f.evidenceState)} for ${f.id}`,
      );
    }
    const byId = new Map(parsed.findings.map((f: Finding) => [f.id, f.evidenceState]));
    assert.equal(byId.get(legacy.id), 'verified', 'legacy finding renders as verified');
    assert.equal(byId.get(verified.id), 'verified');
    assert.equal(byId.get(suspected.id), 'suspected');
    console.log('✓ matrix-6: finding_list renders evidenceState on every finding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Matrix item 7: explicit suspected without uncertaintyReason -> finding_add throws ──
function assertSuspectedWithoutReasonRejected(): void {
  const { root, runIds } = createReviewRepo();
  try {
    // finding_add enforces cwd-in-worktree, so create a real story worktree to call through CLI.
    // review-runs.json (seeded by createReviewRepo) is committed so the worktree store can read it.
    const worktreePath = join(root, '.worktrees', STORY_ID);
    mkdirSync(dirname(worktreePath), { recursive: true });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', `story/${STORY_ID}`]);
    git(root, ['worktree', 'add', worktreePath, `story/${STORY_ID}`]);
    resetConfigCache();
    const wstore = new StoryStore(worktreePath);
    const story = wstore.readStory(STORY_ID);
    wstore.writeStory(STORY_ID, {
      ...story,
      worktree: { path: `.worktrees/${STORY_ID}`, branch: `story/${STORY_ID}`, createdAt: '2026-05-17T12:00:00.000Z' },
    });
    // Re-sign review runs against the worktree's current git state so the
    // finding_add freshness check passes (HEAD moved after the metadata commit).
    const wHead = currentGitHead(worktreePath) || `head-${REVIEW_ROUND}`;
    const wMaterial = currentMaterialHash(worktreePath) || `material-${REVIEW_ROUND}`;
    const freshRuns: ReviewRun[] = REVIEWERS.map((agent, index) => {
      const reviewRunId = `${STORY_ID}:RR-${String(index + 1).padStart(3, '0')}`;
      const startedAt = `2026-05-17T11:${String(index).padStart(2, '0')}:00.000Z`;
      return {
        reviewRunId, storyId: STORY_ID, agent, lane: agent, reviewRound: REVIEW_ROUND, startedAt,
        headHash: wHead, materialHash: wMaterial, promptHash: '',
        _hash: signReviewRun(STORY_ID, reviewRunId, agent, agent, REVIEW_ROUND, startedAt, wHead, wMaterial, ''),
      };
    });
    wstore.writeReviewRuns(STORY_ID, { runs: freshRuns });
    const reviewRunId = runIds.get('koala-review-concept')!;

    let threw = '';
    try {
      execFileSync(process.execPath, [cliPath, 'finding_add', JSON.stringify({
        storyId: STORY_ID,
        desc: 'suspected without a reason should be rejected',
        severity: 'high',
        category: 'edge',
        agent: 'koala-review-concept',
        reviewRunId,
        evidenceState: 'suspected',
      })], { cwd: worktreePath, env: { ...process.env }, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      threw = [e?.stdout?.toString?.() ?? '', e?.stderr?.toString?.() ?? '', e?.message ?? ''].join('\n');
    }
    assert.ok(threw, 'finding_add with suspected but no uncertaintyReason must fail');
    assert.match(threw, /evidenceState=suspected 必须带 uncertaintyReason/);
    // and the finding was not persisted
    assert.equal(wstore.readFindings(STORY_ID).findings.length, 0, 'rejected finding must not be written');

    // positive: same call with uncertaintyReason succeeds and is recorded as suspected
    const ok = execFileSync(process.execPath, [cliPath, 'finding_add', JSON.stringify({
      storyId: STORY_ID,
      desc: 'suspected with a clear reason is accepted',
      severity: 'high',
      category: 'edge',
      agent: 'koala-review-concept',
      reviewRunId,
      evidenceState: 'suspected',
      uncertaintyReason: 'no repro yet, suspicion comes from static reading only',
    })], { cwd: worktreePath, env: { ...process.env }, encoding: 'utf-8' });
    assert.match(ok, /evidenceState=suspected/);
    const persisted = wstore.readFindings(STORY_ID).findings;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].evidenceState, 'suspected');
    assert.ok((persisted[0].uncertaintyReason ?? '').length >= 10);
    console.log('✓ matrix-7: explicit suspected without uncertaintyReason is rejected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Extra hardening: handler rejection edge/adversarial cases (CHK-001 edge/adversarial intents) ──
function assertHandlerRejectionCases(): void {
  const { root, runIds } = createReviewRepo();
  try {
    const worktreePath = join(root, '.worktrees', STORY_ID);
    mkdirSync(dirname(worktreePath), { recursive: true });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', `story/${STORY_ID}`]);
    git(root, ['worktree', 'add', worktreePath, `story/${STORY_ID}`]);
    resetConfigCache();
    const wstore = new StoryStore(worktreePath);
    const story = wstore.readStory(STORY_ID);
    wstore.writeStory(STORY_ID, {
      ...story,
      worktree: { path: `.worktrees/${STORY_ID}`, branch: `story/${STORY_ID}`, createdAt: '2026-05-17T12:00:00.000Z' },
    });
    const wHead = currentGitHead(worktreePath) || `head-${REVIEW_ROUND}`;
    const wMaterial = currentMaterialHash(worktreePath) || `material-${REVIEW_ROUND}`;
    const freshRuns: ReviewRun[] = REVIEWERS.map((agent, index) => {
      const reviewRunId = `${STORY_ID}:RR-${String(index + 1).padStart(3, '0')}`;
      const startedAt = `2026-05-17T11:${String(index).padStart(2, '0')}:00.000Z`;
      return {
        reviewRunId, storyId: STORY_ID, agent, lane: agent, reviewRound: REVIEW_ROUND, startedAt,
        headHash: wHead, materialHash: wMaterial, promptHash: '',
        _hash: signReviewRun(STORY_ID, reviewRunId, agent, agent, REVIEW_ROUND, startedAt, wHead, wMaterial, ''),
      };
    });
    wstore.writeReviewRuns(STORY_ID, { runs: freshRuns });
    const reviewRunId = runIds.get('koala-review-concept')!;

    const callFindingAdd = (extra: Record<string, unknown>): string => {
      try {
        execFileSync(process.execPath, [cliPath, 'finding_add', JSON.stringify({
          storyId: STORY_ID, desc: 'rejection case', severity: 'high', category: 'edge',
          agent: 'koala-review-concept', reviewRunId, ...extra,
        })], { cwd: worktreePath, env: { ...process.env }, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        return [e?.stdout?.toString?.() ?? '', e?.stderr?.toString?.() ?? '', e?.message ?? ''].join('\n');
      }
      return '';
    };

    // CHK-001:edge:2 — disproven without disprovenEvidence summary -> rejected
    const noDisproof = callFindingAdd({ evidenceState: 'disproven' });
    assert.match(noDisproof, /evidenceState=disproven 必须带 disprovenEvidence\.summary/);
    assert.equal(wstore.readFindings(STORY_ID).findings.length, 0, 'disproven without evidence must not be written');

    // CHK-001:edge:4 — invalid evidenceState value -> rejected (Zod enum first line of defense)
    const invalid = callFindingAdd({ evidenceState: 'confirmed' });
    assert.ok(invalid.length > 0, 'invalid evidenceState value must be rejected');
    assert.equal(wstore.readFindings(STORY_ID).findings.length, 0, 'invalid evidenceState must not be written');

    // CHK-001:adversarial:0 — 1-char uncertaintyReason -> rejected (>=10 char guard)
    const trivialReason = callFindingAdd({ evidenceState: 'suspected', uncertaintyReason: 'x' });
    assert.match(trivialReason, /evidenceState=suspected 必须带 uncertaintyReason/);
    assert.equal(wstore.readFindings(STORY_ID).findings.length, 0, 'trivial uncertaintyReason must not be written');

    console.log('✓ extra: disproven-without-summary / invalid-value / 1-char-reason all rejected by handler');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── CHK-001:adversarial:3 — verified critical + suspected critical: gate blocks only the verified one ──
function assertPartialSuspectedDoesNotMaskRealBlocker(): void {
  const { root, store, runIds } = createReviewRepo();
  try {
    const verifiedBlocker = makeFinding({
      idSuffix: '201', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
      severity: 'critical', status: 'open', evidenceState: 'verified',
    });
    const suspectedSibling = makeFinding({
      idSuffix: '202', agent: 'koala-review-concept', reviewRunId: runIds.get('koala-review-concept')!,
      severity: 'critical', status: 'open', evidenceState: 'suspected',
      uncertaintyReason: 'sibling finding still unverified, only suspected at this point',
    });
    store.writeFindings(STORY_ID, {
      findings: [
        verifiedBlocker,
        suspectedSibling,
        makeFinding({ idSuffix: '203', agent: 'koala-review-quality', reviewRunId: runIds.get('koala-review-quality')!, severity: 'low', status: 'resolved' }),
        makeFinding({ idSuffix: '204', agent: 'koala-review-test-coverage', reviewRunId: runIds.get('koala-review-test-coverage')!, severity: 'low', status: 'resolved' }),
      ],
    });
    const reason = getGuardFailureReason(STORY_ID, store, 'TEST', root);
    assert.ok(reason, 'verified critical finding must still block even when a suspected critical sibling exists');
    assert.match(reason ?? '', new RegExp(verifiedBlocker.id), 'gate must name the verified blocker');
    assert.doesNotMatch(reason ?? '', new RegExp(suspectedSibling.id), 'suspected sibling must not be listed as a blocker');
    assert.equal(isFindingBlocking(verifiedBlocker, ['critical', 'high'], 1), true);
    assert.equal(isFindingBlocking(suspectedSibling, ['critical', 'high'], 1), false);
    console.log('✓ extra: partial suspected does not mask the real verified blocker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertLegacyMissingEvidenceStateStillBlocks();
assertVerifiedOpenStillBlocks();
assertSuspectedDoesNotBlockAndIsAdvisory();
assertResolvedAndDismissedDoNotBlock();
assertDisprovenOpenDoesNotBlock();
assertFindingListRendersEvidenceState();
assertSuspectedWithoutReasonRejected();
assertHandlerRejectionCases();
assertPartialSuspectedDoesNotMaskRealBlocker();

console.log('✓ evidence-state gate smoke passed');
