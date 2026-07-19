#!/usr/bin/env node
/**
 * B-f675 CHK-003 — proves the read-only incremental review context
 * (core/review-incremental-context.ts, CHK-001) reports the right shape for a
 * returning reviewer, a first-timer, and a rename, AND proves the LOAD-BEARING
 * invariant of this whole story: calling reviewIncrementalContext (and having the
 * lattice review_incremental_context CLI registered) changes NOTHING about the
 * REVIEW→TEST gate canPassReviewGuard.
 *
 * HARD INVARIANT this guard defends: the incremental helper is a pure read-only
 * advisory. It must not write to the store and must not alter any gate input
 * (findings / review-passes / review-runs / currentReviewRound). The framework
 * still skips no reviewer; round-2+ targeted re-review is an operator judgement.
 *
 * Cases:
 *   (a) RETURNING REVIEWER — a reviewer 'quality' with a prior PASS bound to an
 *       earlier headHash, and a material file changed since that headHash:
 *       isFirstPass=false, scopeChanged=true, changedFiles includes that file,
 *       priorVerdict present.
 *   (b) FIRST-TIMER — a reviewer with no prior pass: isFirstPass=true,
 *       scopeChanged=true, changedFiles = the full main...HEAD material diff.
 *   (c) RENAME CASE — a file renamed since the reviewer's last pass is counted as
 *       changed (rename-aware `git diff --name-status -M`): both old + new paths
 *       surface, scopeChanged=true.
 *   (e) PRIOR VERDICT W/ UNRESOLVABLE headHash — a reviewer that DID pass before,
 *       but whose bound run has an unresolvable headHash: the helper falls back to
 *       isFirstPass=true, priorHeadHash=null, full main...HEAD diff, while
 *       priorVerdict stays NON-null. Pins the documented contract that consumers
 *       must key off isFirstPass (not priorVerdict) for "no incremental baseline".
 *   (d) GATE-UNCHANGED ASSERTION (the load-bearing one) — exercises the REAL
 *       canPassReviewGuard (imported from core/machine.ts) over deterministic
 *       fixture stories and asserts the actual gate semantics:
 *         - Round 1 (roundCount<=1): blocks unless ALL opt-in reviewers have a
 *           valid current-round verdict + quorum.
 *         - Missing currentReviewRound: pass-shaped legacy evidence fails closed.
 *         - A current-round INVALID (stale/unknown-run) binding blocks — in ALL
 *           rounds, before the round split.
 *         - A verified open blocking finding (after round decay) blocks.
 *       For every fixture, the gate outcome is asserted IDENTICAL whether or not
 *       reviewIncrementalContext is called in between, AND the gate inputs are
 *       proven byte-identical before/after the helper runs (no store writes, no
 *       gate-input mutation). That is the proof the helper does not alter the gate.
 *
 * Determinism: cases (a)–(c) drive a synthetic StoryStore over a real temp git
 * repo (so the rename-aware diff is exercised against actual git). Case (d) uses
 * git-free synthetic stores: with currentReviewRound UNSET, the lifecycle verdict
 * fails closed before legacy evidence compatibility can activate; with it SET + an
 * unknown reviewRunId the binding is invalid. Both are deterministic and independent
 * of the host git state.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyIncrementalBindingReasons,
  fixtureCaseClosure,
  reviewIncrementalContext,
} from '../core/review-incremental-context.js';
import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';
import { resetConfigCache } from '../core/config.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import {
  classifyEvidenceFreshness,
  currentGitHead,
} from '../core/evidence-freshness.js';
import {
  collectReviewerEvidenceState,
  verifyReviewRun,
  verifyReviewRunPromptEnvelope,
} from '../core/review-run.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { materialDiffPackDigest } from '../core/review-scope-binding.js';
import {
  classifyImpact,
  IMPACT_CLASSIFICATION_POLICY_VERSION,
} from '../core/impact-classification-policy.js';
import { StoryStore } from '../core/store.js';
import type {
  Finding,
  ReviewPass,
  ReviewRun,
  StoryEvent,
  StoryInfo,
} from '../core/types.js';

/** Marker line printed by the smoke so `lattice validate` output is greppable. */
const MARKER = 'review-incremental-context-smoke:';
const DIST_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

const COMMIT_ENV = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke'];

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

function directoryBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string, relativePath: string): void => {
    if (!statSync(path).isDirectory()) {
      result[relativePath] = readFileSync(path).toString('base64');
      return;
    }
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
    }
  };
  try {
    visit(root, '');
  } catch {
    return {};
  }
  return result;
}

/**
 * A synthetic StoryStore returning ONLY the methods the helper / gate read for a
 * single fixed story. Anything else throws so an accidental extra read is loud.
 */
interface FixtureStoreInput {
  story: StoryInfo;
  findings?: Finding[];
  passes?: ReviewPass[];
  runs?: ReviewRun[];
  scopeContract?: unknown | null;
  reviewLoopRecords?: unknown[];
  checklistItems?: unknown[];
}

function buildFixtureStore(input: FixtureStoreInput): StoryStore {
  const id = input.story.storyId;
  const findings = input.findings ?? [];
  const passes = input.passes ?? [];
  const runs = input.runs ?? [];
  const guard = (storyId: string) => {
    if (storyId !== id) throw new Error(`unexpected storyId ${storyId}`);
  };
  return {
    readStory: (storyId: string) => { guard(storyId); return input.story; },
    readFindings: (storyId: string) => { guard(storyId); return { findings }; },
    readReviewPasses: (storyId: string) => { guard(storyId); return { passes }; },
    readReviewRuns: (storyId: string) => { guard(storyId); return { runs }; },
    readScopeContract: (storyId: string) => { guard(storyId); return (input.scopeContract ?? null) as never; },
    readReviewLoopRecords: (storyId: string) => { guard(storyId); return (input.reviewLoopRecords ?? []) as never; },
    readChecklist: (storyId: string) => { guard(storyId); return { items: input.checklistItems ?? [] } as never; },
    readDecision: (storyId: string) => { guard(storyId); return null as never; },
    readUnderstanding: (storyId: string) => { guard(storyId); return null as never; },
  } as unknown as StoryStore;
}

// ── Signed reviewer evidence helpers (use the production sign functions) ──

const BASE_MS = Date.parse('2026-06-16T00:00:00.000Z');
function ts(n: number): string {
  return new Date(BASE_MS + n * 60_000).toISOString();
}

function signedPass(
  storyId: string,
  id: string,
  agent: string,
  createdAt: string,
  reviewRound?: string,
): ReviewPass {
  const note = `no blocker from ${agent}`;
  return {
    id,
    agent,
    note,
    createdAt,
    reviewRound,
    _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound || ''),
  };
}

function signedFinding(
  storyId: string,
  id: string,
  agent: string,
  severity: Finding['severity'],
  createdAt: string,
  status: Finding['status'],
  reviewRound?: string,
  reviewRunId?: string,
): Finding {
  const desc = `${severity} finding ${id} from ${agent}`;
  return {
    id,
    desc,
    severity,
    category: 'missing',
    status,
    agent,
    createdAt,
    reviewRound,
    reviewRunId,
    _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound || '', reviewRunId || ''),
  };
}

/** Snapshot of every gate input, used to prove the helper mutates nothing. */
function gateInputSnapshot(store: StoryStore, storyId: string): string {
  return JSON.stringify({
    story: store.readStory(storyId),
    findings: store.readFindings(storyId),
    passes: store.readReviewPasses(storyId),
    runs: store.readReviewRuns(storyId),
    currentReviewRound: store.readStory(storyId).currentReviewRound ?? null,
  });
}

/**
 * Run the gate twice over the SAME store: once "without the helper", once with
 * reviewIncrementalContext called in between for every reviewer role. Assert the
 * gate outcome is identical and the gate inputs are byte-identical afterwards.
 * Returns the (shared) gate outcome for the caller's semantic assertion.
 */
function assertGateUnchangedByHelper(
  store: StoryStore,
  projectRoot: string,
  storyId: string,
  label: string,
): boolean {
  const ctx: StoryMachineContext = { storyId, store, projectRoot };

  const before = gateInputSnapshot(store, storyId);
  const gateWithoutHelper = canPassReviewGuard(ctx);
  const afterGateOnly = gateInputSnapshot(store, storyId);
  assert.equal(afterGateOnly, before, `${label}: canPassReviewGuard itself must not mutate gate inputs`);

  // Call the incremental helper for every reviewer role — this is the action
  // whose neutrality we are proving. It must not write to the store.
  const roles = ['concept', 'quality', 'test-coverage', 'behavior', 'docs'];
  for (const role of roles) {
    const incremental = reviewIncrementalContext(store, projectRoot, storyId, role);
    // Smoke-level shape sanity (the helper always returns these fields).
    assert.equal(incremental.role, role, `${label}: helper echoes the requested role`);
    assert.equal(typeof incremental.scopeChanged, 'boolean', `${label}: helper returns a boolean scopeChanged`);
    const repeated = Array.from({ length: 8 }, () =>
      reviewIncrementalContext(store, projectRoot, storyId, role));
    for (const candidate of repeated) {
      assert.deepEqual(candidate, incremental, `${label}: repeated advisory calls are deterministic for ${role}`);
    }
  }
  const afterHelper = gateInputSnapshot(store, storyId);
  assert.equal(afterHelper, before, `${label}: reviewIncrementalContext must perform no store writes / leave gate inputs byte-identical`);

  const gateWithHelper = canPassReviewGuard(ctx);
  assert.equal(
    gateWithHelper,
    gateWithoutHelper,
    `${label}: canPassReviewGuard outcome must be IDENTICAL with vs without the incremental helper`,
  );
  return gateWithoutHelper;
}

/** A story that has entered REVIEW `rounds` times (round count derives from events). */
function reviewStory(storyId: string, rounds: number, currentReviewRound?: string): StoryInfo {
  const events: StoryEvent[] = [];
  for (let r = 1; r <= rounds; r++) {
    events.push({ phase: 'REVIEW', action: 'advance', timestamp: ts(r) } as StoryEvent);
  }
  return {
    storyId,
    name: 'synthetic-incremental-story',
    title: 'synthetic incremental story',
    type: 'feature',
    priority: 'high',
    phase: 'REVIEW',
    riskSignals: [],
    currentReviewRound,
    events,
  } as unknown as StoryInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases (a)–(c): incremental context over a real temp git repo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a repo whose `main` holds a base commit, then diverge onto a story branch
 * with a SECOND commit that edits a material file (src/feature.ts) and renames
 * src/old-name.ts -> src/new-name.ts. HEAD is left on the story branch so the
 * first-timer full diff `main...HEAD` is non-empty (main is an ancestor of HEAD,
 * mirroring the real worktree shape where the story branch is ahead of main).
 * Returns the repo root + both commit SHAs so fixtures can bind a prior pass to
 * the earlier (main) headHash.
 */
function buildIncrementalRepo(): { root: string; baseSha: string; headSha: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-incremental-ctx-'));
  write(root, '.gitignore', '.lattice/activity.jsonl\n');
  write(root, 'src/feature.ts', 'export const feature = 1;\n');
  write(root, 'src/old-name.ts', 'export const renamed = true;\n');
  write(root, 'src/untouched.ts', 'export const untouched = 1;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'base on main']);
  const baseSha = currentGitHead(root)!;

  // Story branch ahead of main: material edit + rename.
  git(root, ['checkout', '-b', 'story/B-f675']);
  write(root, 'src/feature.ts', 'export const feature = 2; // edited\n');
  git(root, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'feature edit + rename']);
  const headSha = currentGitHead(root)!;

  return { root, baseSha, headSha };
}

function assertLargeDiffReviewMetadataStability(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-large-review-diff-'));
  try {
    write(root, 'lattice.config.json', `${JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2)}\n`);
    write(root, '.gitignore', '.lattice/activity.jsonl\n');
    write(root, 'src/large.ts', 'export const seed = 0;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'large diff base']);
    git(root, ['checkout', '-b', 'story/B-large-diff']);
    write(root, 'src/large.ts', `export const payload = ${JSON.stringify('x'.repeat(900_000))};\n`);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'large business diff']);

    resetConfigCache();
    const beforePack = buildScopeDiffPack(root);
    const before = materialDiffPackDigest(beforePack, root);
    assert.ok(beforePack.hunks.some(hunk => hunk.path === 'src/large.ts'), 'large business hunk is read above Node default output sizes');

    write(
      root,
      '.lattice/story/actives/B-large-diff/prompt-envelopes.json',
      `${JSON.stringify({ envelopes: [], padding: 'm'.repeat(350_000) })}\n`,
    );
    git(root, ['add', '.lattice/story/actives/B-large-diff/prompt-envelopes.json']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'review metadata write']);

    resetConfigCache();
    const afterPack = buildScopeDiffPack(root);
    const after = materialDiffPackDigest(afterPack, root);
    assert.ok(afterPack.hunks.some(hunk => hunk.path === 'src/large.ts'), 'review metadata cannot make large business hunks disappear');
    assert.deepEqual(after, before, 'review_run/prompt-envelope metadata leaves the material scope diff binding byte-stable');
    console.log(`${MARKER} large diff + review metadata scope binding remains stable`);
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function runIncrementalCases(): void {
  const { root, baseSha, headSha } = buildIncrementalRepo();
  try {
    const storyId = 'B-f675';

    // ---- (a) RETURNING REVIEWER ----
    // 'quality' has a prior PASS bound (via reviewRunId) to baseSha. Material
    // files changed between baseSha and HEAD => scopeChanged=true, isFirstPass=false.
    {
      const runId = 'RR-quality-1';
      const story = reviewStory(storyId, 1, ts(1));
      const pass: ReviewPass = signedPass(storyId, 'RP-001', 'lattice-review-quality', ts(2), ts(1));
      pass.reviewRunId = runId;
      // Re-sign now that reviewRunId is set (signature domain includes it).
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'lattice-review-quality',
        lane: 'lattice-review-quality',
        reviewRound: ts(1),
        startedAt: ts(2),
        headHash: baseSha,
        materialHash: 'unused-by-incremental-context',
        promptHash: '',
      };
      const store = buildFixtureStore({ story, passes: [pass], runs: [run] });

      const ctx = reviewIncrementalContext(store, root, storyId, 'quality');
      assert.equal(ctx.isFirstPass, true, '(a) unsigned legacy run must not establish an incremental baseline');
      assert.equal(ctx.priorHeadHash, null, '(a) untrusted baseline has no priorHeadHash authority');
      assert.equal(ctx.priorVerdict, null, '(a) untrusted pass is not surfaced as a trusted prior verdict');
      assert.equal(ctx.contextMode, 'full', '(a) untrusted prior evidence fails closed to full');
      assert.ok(ctx.eligibilityReasonCodes.includes('FULL_MISSING_TRUSTED_PRIOR_PASS'));
      assert.equal(ctx.scopeChanged, true, '(a) material change since last pass => scopeChanged=true');
      assert.ok(
        ctx.changedFiles.includes('src/feature.ts'),
        `(a) changedFiles must include the edited material file, got ${JSON.stringify(ctx.changedFiles)}`,
      );
      console.log(`${MARKER} (a) UNTRUSTED LEGACY PASS: contextMode=full, changedFiles=${JSON.stringify(ctx.changedFiles)}`);
    }

    // ---- (b) FIRST-TIMER ----
    // 'concept' has no prior pass/finding => isFirstPass=true, full main...HEAD diff.
    {
      const story = reviewStory(storyId, 1, ts(1));
      const store = buildFixtureStore({ story });
      const ctx = reviewIncrementalContext(store, root, storyId, 'concept');
      assert.equal(ctx.isFirstPass, true, '(b) first-timer must be isFirstPass=true');
      assert.equal(ctx.priorHeadHash, null, '(b) first-timer has no priorHeadHash');
      assert.equal(ctx.priorVerdict, null, '(b) first-timer has no priorVerdict');
      assert.equal(ctx.scopeChanged, true, '(b) first-timer scopeChanged=true (show everything)');
      assert.ok(ctx.changedFiles.includes('src/feature.ts'), '(b) full diff must include the edited file');
      console.log(`${MARKER} (b) FIRST-TIMER: isFirstPass=true, full diff changedFiles=${JSON.stringify(ctx.changedFiles)}`);
    }

    // ---- (c) RENAME CASE ----
    // 'docs' passed at baseSha; between baseSha and HEAD src/old-name.ts was
    // renamed to src/new-name.ts. Rename-aware diff must surface BOTH paths.
    {
      const runId = 'RR-docs-1';
      const story = reviewStory(storyId, 1, ts(1));
      const pass: ReviewPass = signedPass(storyId, 'RP-002', 'lattice-review-docs', ts(2), ts(1));
      pass.reviewRunId = runId;
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'lattice-review-docs',
        lane: 'lattice-review-docs',
        reviewRound: ts(1),
        startedAt: ts(2),
        headHash: baseSha,
        materialHash: 'unused-by-incremental-context',
        promptHash: '',
      };
      const store = buildFixtureStore({ story, passes: [pass], runs: [run] });
      const ctx = reviewIncrementalContext(store, root, storyId, 'docs');
      assert.equal(ctx.isFirstPass, true, '(c) unsigned legacy run cannot establish a baseline');
      assert.equal(ctx.contextMode, 'full', '(c) rename remains full');
      assert.equal(ctx.scopeChanged, true, '(c) a rename since last pass => scopeChanged=true');
      assert.ok(
        ctx.changedFiles.includes('src/old-name.ts') && ctx.changedFiles.includes('src/new-name.ts'),
        `(c) rename-aware diff must surface BOTH old + new paths, got ${JSON.stringify(ctx.changedFiles)}`,
      );
      console.log(`${MARKER} (c) RENAME CASE: scopeChanged=true, changedFiles=${JSON.stringify(ctx.changedFiles)} (both rename sides counted)`);
    }

    // ---- (e) PRIOR VERDICT WITH UNRESOLVABLE BOUND headHash (sub-case b of the
    //          isFirstPass contract) ----
    // 'behavior' DID pass before (priorVerdict non-null), but the run it was bound
    // to has an empty/unresolvable headHash. The helper conservatively treats this
    // as a first pass: isFirstPass=true, priorHeadHash=null, full main...HEAD diff,
    // while priorVerdict stays NON-null (informational). This pins the documented
    // invariant that consumers must key off isFirstPass, not priorVerdict.
    {
      const runId = 'RR-behavior-unresolvable';
      const story = reviewStory(storyId, 1, ts(1));
      const pass: ReviewPass = signedPass(storyId, 'RP-003', 'lattice-review-behavior', ts(2), ts(1));
      pass.reviewRunId = runId;
      pass._hash = signReviewPass(storyId, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound || '', runId);
      const run: ReviewRun = {
        reviewRunId: runId,
        storyId,
        agent: 'lattice-review-behavior',
        lane: 'lattice-review-behavior',
        reviewRound: ts(1),
        startedAt: ts(2),
        // Unresolvable bound headHash: headHashForRun returns null for a falsy hash.
        headHash: '',
        materialHash: 'unused-by-incremental-context',
        promptHash: '',
      };
      const store = buildFixtureStore({ story, passes: [pass], runs: [run] });
      const ctx = reviewIncrementalContext(store, root, storyId, 'behavior');
      // Documented invariant: when isFirstPass=true, priorHeadHash is null and
      // changedFiles is the full diff — REGARDLESS of priorVerdict.
      assert.equal(ctx.isFirstPass, true, '(e) unresolvable bound headHash must fall back to isFirstPass=true');
      assert.equal(ctx.priorHeadHash, null, '(e) isFirstPass=true must always carry priorHeadHash=null');
      assert.equal(ctx.scopeChanged, true, '(e) first-pass fallback => scopeChanged=true');
      assert.ok(
        ctx.changedFiles.includes('src/feature.ts'),
        `(e) isFirstPass=true must return the full main...HEAD diff, got ${JSON.stringify(ctx.changedFiles)}`,
      );
      // priorVerdict MAY be non-null here (the reviewer did pass before); the point
      // is that it is NOT the authoritative baseline signal — isFirstPass is.
      assert.equal(ctx.priorVerdict, null, '(e) an invalid run cannot supply trusted prior-pass information');
      assert.equal(ctx.contextMode, 'full', '(e) unresolved evidence fails closed');
      console.log(`${MARKER} (e) INVALID BOUND RUN: isFirstPass=true, priorHeadHash=null, contextMode=full, full diff changedFiles=${JSON.stringify(ctx.changedFiles)}`);
    }

    void headSha; // headSha is HEAD; referenced for clarity in fixture wiring above.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runPolicyCases(): void {
  const none = classifyImpact({
    changedFiles: [],
    declaredTestFiles: [],
    testIntentRefsByFile: {},
  });
  assert.equal(none.policyVersion, IMPACT_CLASSIFICATION_POLICY_VERSION);
  assert.equal(none.eligible, true);
  assert.deepEqual(none.reasonCodes, ['ELIGIBLE_NO_MATERIAL_CHANGE']);

  const fixture = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
    fixtureCaseClosureByFile: { 'tests/case.fixture.json': true },
  });
  assert.equal(fixture.eligible, true);
  assert.deepEqual(fixture.reasonCodes, ['ELIGIBLE_PURE_STORY_FIXTURE']);

  const fixtureWithoutIntent = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: {},
  });
  assert.equal(fixtureWithoutIntent.eligible, false);
  assert.deepEqual(fixtureWithoutIntent.reasonCodes, ['FULL_FIXTURE_BINDING_INCOMPLETE']);

  const fixtureWithUnboundChangedCase = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
    fixtureCaseClosureByFile: { 'tests/case.fixture.json': false },
  });
  assert.equal(fixtureWithUnboundChangedCase.eligible, false);
  assert.deepEqual(fixtureWithUnboundChangedCase.reasonCodes, ['FULL_FIXTURE_BINDING_INCOMPLETE']);

  for (const status of ['D', 'R100', 'C100']) {
    const unsupportedFixtureStatus = classifyImpact({
      changedFiles: ['tests/case.fixture.json'],
      declaredTestFiles: ['tests/case.fixture.json'],
      testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
      fixtureCaseClosureByFile: { 'tests/case.fixture.json': true },
      changedFileStatus: { 'tests/case.fixture.json': status },
    });
    assert.equal(unsupportedFixtureStatus.eligible, false, `declared fixture status ${status} must fail closed`);
    assert.deepEqual(unsupportedFixtureStatus.reasonCodes, ['FULL_UNSUPPORTED_RENAME']);
  }

  const unavailable = classifyImpact({
    changedFiles: ['tests/case.fixture.json'],
    declaredTestFiles: ['tests/case.fixture.json'],
    testIntentRefsByFile: { 'tests/case.fixture.json': ['CHK-001:happy:0'] },
    fixtureCaseClosureByFile: { 'tests/case.fixture.json': true },
    classificationUnavailable: true,
  });
  assert.equal(unavailable.eligible, false);
  assert.deepEqual(unavailable.reasonCodes, ['FULL_DYNAMIC_OR_PARSE_FAILURE']);

  const trustedBinding = {
    priorEnvelopePresent: true,
    runtimeContractMatches: true,
    roleContractMatches: true,
    executionEnvironmentMatches: true,
    assemblerMatches: true,
    dispatchProtocolMatches: true,
    scopePolicyMatches: true,
    taskSemanticDigestMatches: true,
    freshnessClassification: 'CURRENT_MATERIAL' as const,
    pureFixtureDrift: false,
  };
  for (const [field, expected] of [
    ['priorEnvelopePresent', 'FULL_MISSING_PRIOR_ENVELOPE'],
    ['runtimeContractMatches', 'FULL_RUNTIME_CONTRACT_CHANGED'],
    ['roleContractMatches', 'FULL_ROLE_CONTRACT_CHANGED'],
    ['executionEnvironmentMatches', 'FULL_EXECUTION_ENVIRONMENT_CHANGED'],
    ['assemblerMatches', 'FULL_ASSEMBLER_CHANGED'],
    ['dispatchProtocolMatches', 'FULL_DISPATCH_PROTOCOL_CHANGED'],
    ['scopePolicyMatches', 'FULL_SCOPE_OR_POLICY_CHANGED'],
    ['taskSemanticDigestMatches', 'FULL_MODEL_RELEVANT_TASK_CONTEXT_CHANGED'],
  ] as const) {
    const reasons = classifyIncrementalBindingReasons({ ...trustedBinding, [field]: false });
    assert.ok(reasons.includes(expected), `${field} drift forces stable full reason ${expected}`);
  }
  for (const freshnessClassification of [
    'RELATED_STORY_MATERIAL_DRIFT',
    'KNOWN_UNRELATED_MATERIAL_DRIFT',
    'LEGACY_UNBOUND',
    'RUNTIME_UNAVAILABLE',
    'UNCOMPARABLE',
  ] as const) {
    const reasons = classifyIncrementalBindingReasons({
      ...trustedBinding,
      freshnessClassification,
      pureFixtureDrift: false,
    });
    assert.ok(reasons.includes(`FULL_FRESHNESS_${freshnessClassification}`));
  }
  assert.ok(classifyIncrementalBindingReasons({
    ...trustedBinding,
    freshnessClassification: 'RELATED_STORY_MATERIAL_DRIFT',
    pureFixtureDrift: true,
  }).includes('ELIGIBLE_RELATED_PURE_STORY_FIXTURE_DRIFT'));
  const callerOverride = classifyImpact({
    changedFiles: ['src/private.ts'],
    declaredTestFiles: [],
    testIntentRefsByFile: {},
    contextMode: 'incremental',
    forceIncremental: true,
    eligibilityReasonCodes: ['ELIGIBLE_ATTACKER_OVERRIDE'],
  } as Parameters<typeof classifyImpact>[0] & Record<string, unknown>);
  assert.equal(callerOverride.eligible, false);
  assert.deepEqual(callerOverride.reasonCodes, ['FULL_PRIVATE_IMPLEMENTATION_V1']);

  for (const [path, expected] of [
    ['docs/decision.md', 'FULL_DOCS_V1'],
    ['src/api/schema.proto', 'FULL_PUBLIC_CONTRACT'],
    ['src/authority/check.ts', 'FULL_AUTHORITY_OR_PERMISSION'],
    ['src/core/command-policy.ts', 'FULL_COMMAND_OR_GATE_POLICY'],
    ['package.json', 'FULL_DEPENDENCY_OR_BUILD'],
    ['src/private.ts', 'FULL_PRIVATE_IMPLEMENTATION_V1'],
    ['asset.bin', 'FULL_UNKNOWN_IMPACT'],
  ] as const) {
    const result = classifyImpact({
      changedFiles: [path],
      declaredTestFiles: [],
      testIntentRefsByFile: {},
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reasonCodes.includes(expected), `${path} must classify ${expected}`);
  }
  const renamed = classifyImpact({
    changedFiles: ['src/old.ts', 'src/new.ts'],
    declaredTestFiles: [],
    testIntentRefsByFile: {},
    changedFileStatus: { 'src/old.ts': 'R100', 'src/new.ts': 'R100' },
  });
  assert.deepEqual(renamed.reasonCodes, ['FULL_UNSUPPORTED_RENAME']);

  assert.equal(classifyEvidenceFreshness({
    fresh: true,
    reason: 'evidence followed by 1 metadata-only changes, not invalidated',
    changedFiles: ['.lattice/x'],
    materialFiles: [],
  }, 'a'.repeat(40)), 'KNOWN_METADATA_ONLY_HEAD_DRIFT');
  assert.equal(classifyEvidenceFreshness({
    fresh: false,
    reason: 'evidence storyFilesHash does not match current story-owned file state',
    changedFiles: [],
    materialFiles: ['<story-files-changed>'],
  }, 'a'.repeat(40)), 'RELATED_STORY_MATERIAL_DRIFT');
  console.log(`${MARKER} POLICY: stable v1 bounded categories and canonical freshness classifications PASS`);
}

function runFixtureDuplicateIdentityCases(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-fixture-duplicate-identity-'));
  const storyId = 'B-duplicate';
  const fixturePath = 'cases.json';
  const intentRef = `${storyId}:CHK-001:happy:0`;
  const original = {
    _id: 'base-case',
    name: 'base case',
    intentRef,
    expect: true,
  };
  try {
    write(root, fixturePath, JSON.stringify({ cases: [original] }, null, 2) + '\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', fixturePath]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed fixture']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const duplicateVariants: Array<[string, Array<Record<string, unknown>>]> = [
      ['prepend duplicate _id', [{ _id: 'base-case', expect: false }, original]],
      ['append duplicate _id', [original, { _id: 'base-case', expect: false }]],
      ['reordered duplicate _id', [{ _id: 'other', intentRef }, original, { _id: 'base-case', expect: false }]],
      ['cross-field id alias', [original, { id: 'base-case', expect: false }]],
      ['cross-field name alias', [original, { name: 'base case', expect: false }]],
    ];
    for (const [label, cases] of duplicateVariants) {
      write(root, fixturePath, JSON.stringify({ cases }, null, 2) + '\n');
      git(root, ['add', fixturePath]);
      git(root, [...COMMIT_ENV, 'commit', '-m', label]);
      assert.equal(
        fixtureCaseClosure(root, 'main', storyId, fixturePath, new Set([intentRef])),
        false,
        `${label} must fail closed before Map/digest comparison`,
      );
    }

    git(root, ['checkout', 'main']);
    write(root, fixturePath, JSON.stringify({
      cases: [original, { id: 'base-case', expect: false }],
    }, null, 2) + '\n');
    git(root, ['add', fixturePath]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'duplicate identity in prior snapshot']);
    git(root, ['checkout', '-B', 'story/duplicate-prior']);
    write(root, fixturePath, JSON.stringify({ cases: [original] }, null, 2) + '\n');
    git(root, ['add', fixturePath]);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'remove duplicate from current snapshot']);
    assert.equal(
      fixtureCaseClosure(root, 'main', storyId, fixturePath, new Set([intentRef])),
      false,
      'duplicate identity in the prior canonical set must fail closed',
    );
    console.log(`${MARKER} FIXTURE DUPLICATES: before/after canonical sets reject prepend/append/order and _id/id/name alias ambiguity`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Case (d): GATE-UNCHANGED ASSERTION over deterministic git-free fixtures.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A balanced-profile project root (requireReviewer + requireReviewerFinding =
 * true, blockingSeverities = critical+high). We materialize a lattice.json so
 * loadConfig resolves balanced deterministically regardless of the host repo.
 *
 * It is a real (single-commit) git repo on `main` so the incremental helper's
 * git calls succeed — the gate semantics under test here do NOT depend on git
 * content (currentReviewRound is unset / bound to an unknown run, so no successful
 * freshness path runs); the repo only lets reviewIncrementalContext run without
 * throwing while we prove it writes nothing and never changes the gate outcome.
 */
function buildBalancedProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-incremental-gate-'));
  writeFileSync(join(root, 'lattice.json'), JSON.stringify({ workflow: { profile: 'balanced' } }));
  write(root, '.gitignore', '.lattice/activity.jsonl\n');
  write(root, 'src/seed.ts', 'export const seed = 1;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'seed commit on main']);
  resetConfigCache();
  return root;
}

function runGateUnchangedCase(): void {
  const projectRoot = buildBalancedProjectRoot();
  try {
    const storyId = 'B-f675';
    const BASELINE_REVIEWERS = ['concept', 'quality', 'test-coverage'];

    // (d.1) Round 1 — pass-shaped evidence without currentReviewRound fails closed,
    // even when every opt-in lane is represented.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = BASELINE_REVIEWERS.map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(10 + i)),
      );
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.1) round-1 full opt-in + quorum');
      assert.equal(outcome, false, '(d.1) missing currentReviewRound must block pass-shaped reviewer evidence');
      console.log(`${MARKER} (d.1) ROUND 1 missing currentReviewRound -> gate BLOCK; identical with/without helper`);
    }

    // (d.2) Round 1 — missing round plus incomplete lane-shaped evidence also blocks.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = ['concept', 'quality'].map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(10 + i)),
      );
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.2) round-1 missing opt-in reviewer');
      assert.equal(outcome, false, '(d.2) Round 1 missing currentReviewRound must BLOCK incomplete lane-shaped evidence');
      console.log(`${MARKER} (d.2) ROUND 1 missing currentReviewRound + incomplete lanes -> gate BLOCK; identical with/without helper`);
    }

    // (d.3) Round 2 — a pass-shaped receipt still cannot compensate for a missing
    // currentReviewRound.
    {
      const story = reviewStory(storyId, 2, undefined);
      const passes = [signedPass(storyId, 'RP-1', 'lattice-review-concept', ts(20))];
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.3) round-2 single valid receipt');
      assert.equal(outcome, false, '(d.3) Round 2+ missing currentReviewRound must BLOCK the gate');
      console.log(`${MARKER} (d.3) ROUND 2+ missing currentReviewRound -> gate BLOCK; identical with/without helper`);
    }

    // (d.4) INVALID (unknown-run) current-round binding BLOCKS — in BOTH rounds.
    // currentReviewRound is SET, and a reviewer finding carries a reviewRunId that
    // references no review-run => collectReviewerEvidenceState marks it invalid
    // (unknown_run) => gate returns false before the round split, in every round.
    for (const rounds of [1, 2]) {
      const round = ts(1);
      const story = reviewStory(storyId, rounds, round);
      // One valid pass so the precondition (findings or passes non-empty) holds,
      // plus a finding bound to a missing run => the INVALID input that must block.
      const passes = [signedPass(storyId, 'RP-1', 'lattice-review-concept', ts(30), round)];
      const finding = signedFinding(
        storyId, 'B-f675:F-1', 'lattice-review-quality', 'high', ts(31), 'open', round, 'RR-does-not-exist',
      );
      const store = buildFixtureStore({ story, passes, findings: [finding] });
      const outcome = assertGateUnchangedByHelper(
        store, projectRoot, storyId, `(d.4) invalid current-round binding (round ${rounds})`,
      );
      assert.equal(
        outcome, false,
        `(d.4) an INVALID current-round binding must BLOCK the gate in round ${rounds} (before the round split)`,
      );
      console.log(`${MARKER} (d.4) INVALID current-round binding (round ${rounds}) -> gate BLOCK; identical with/without helper`);
    }

    // (d.5) A critical finding-shaped record also cannot exploit missing-round
    // legacy compatibility; the lifecycle verdict blocks before trusting it.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = BASELINE_REVIEWERS.map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(40 + i)),
      );
      const finding = signedFinding(
        storyId, 'B-f675:F-2', 'lattice-review-concept', 'critical', ts(45), 'open',
      );
      const store = buildFixtureStore({ story, passes, findings: [finding] });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.5) verified open blocking finding');
      assert.equal(outcome, false, '(d.5) missing currentReviewRound must block critical finding-shaped evidence');
      console.log(`${MARKER} (d.5) CRITICAL FINDING with missing currentReviewRound -> gate BLOCK; identical with/without helper`);
    }
  } finally {
    resetConfigCache();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function runConcurrentCliReadOnlyCase(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-incremental-cli-readonly-'));
  const storyId = 'B-readonly';
  try {
    write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/locks/\n');
    write(root, 'lattice.config.json', JSON.stringify({
      storyDir: '.lattice/story/actives',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n');
    write(root, 'src/seed.ts', 'export const seed = true;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed read-only CLI fixture']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'src/seed.ts', 'export const seed = false;\n');
    git(root, ['add', 'src/seed.ts']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'story material']);
    const store = new StoryStore(root);
    store.writeStory(storyId, reviewStory(storyId, 1, ts(1)));
    store.writeChecklist(storyId, { items: [] });
    git(root, ['add', '.lattice/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'story metadata']);

    const storyDir = store.storyDirPath(storyId);
    const beforeStoryBytes = directoryBytes(storyDir);
    const beforeVerdictBytes = directoryBytes(join(root, '.lattice/autopilot-verdicts'));
    const beforeStatus = git(root, ['status', '--porcelain=v1']);
    const beforeStory = JSON.stringify(store.readStory(storyId));
    const command = [
      JSON.stringify(process.execPath),
      JSON.stringify(DIST_CLI_PATH),
      '--root',
      JSON.stringify(root),
      'review_incremental_context',
      JSON.stringify(JSON.stringify({ storyId, role: 'quality', json: true })),
    ].join(' ');
    const script = [
      'set -eu',
      ...Array.from({ length: 8 }, () => `${command} >/dev/null &`),
      'wait',
    ].join('\n');
    execFileSync('/bin/sh', ['-c', script], {
      cwd: root,
      env: {
        ...process.env,
        LATTICE_PROJECT_ROOT: root,
        LATTICE_ACTIVITY_SOURCE: 'codex',
        LATTICE_SESSION_ID: 'incremental-readonly-concurrent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(directoryBytes(storyDir), beforeStoryBytes, 'concurrent CLI calls preserve every Story artifact byte');
    assert.deepEqual(
      directoryBytes(join(root, '.lattice/autopilot-verdicts')),
      beforeVerdictBytes,
      'concurrent CLI calls create no receipts, host verdicts, floor, or quorum artifacts',
    );
    assert.equal(git(root, ['status', '--porcelain=v1']), beforeStatus, 'concurrent CLI calls preserve project filesystem status');
    assert.equal(JSON.stringify(store.readStory(storyId)), beforeStory, 'concurrent CLI calls preserve phase and DONE outcome');
    console.log(`${MARKER} CLI READ-ONLY: 8 concurrent built-CLI calls preserved Story/gate/verdict bytes and lifecycle state`);
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForPath(path: string, label: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${path}`);
    sleepSync(10);
  }
}

function runDeterministicTicketReclaimAbaCase(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-lock-aba-'));
  const storyId = 'B-mixed-writer-aba';
  const round = '2026-07-19T00:00:00.000Z';
  const barrierRoot = join(root, 'barriers');
  const lockDir = join(root, '.lattice/story/actives', storyId, 'review-metadata-transaction.lock');
  const deadTicket = join(lockDir, '0000000000000000-dead-a.ticket');
  const children: ReturnType<typeof spawn>[] = [];
  try {
    write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/locks/\nbarriers/\n');
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proofbound.prompt-envelope-rollout.v1',
        roles: {
          'lattice-review-quality': 'full-envelope',
          'lattice-review-docs': 'full-envelope',
        },
      },
    }, null, 2) + '\n');
    write(root, 'src/seed.ts', 'export const seed = true;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed mixed writer base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      ...reviewStory(storyId, 1, round),
      title: 'Mixed Prompt Envelope writers',
      description: 'Prove review_run_start and Story-aware agent_prompt serialize one envelope transaction.',
      priority: 'high',
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Preserve both Prompt Envelopes',
        context: 'Mixed producers must not overwrite each other.',
        status: 'done',
        startTime: null,
        endTime: round,
        files: { modify: ['src/seed.ts'], create: [], test: [] },
        verificationIntent: {
          happy: [{ id: 'CHK-001:happy:0', desc: 'Both producer records survive.', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    git(root, ['add', '.lattice/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed mixed writer review metadata']);
    execFileSync(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'dispatch',
      JSON.stringify({ storyId, agentType: 'lattice-review-quality' }),
    ], {
      cwd: root,
      env: {
        ...process.env,
        LATTICE_PROJECT_ROOT: root,
        LATTICE_ACTIVITY_SOURCE: 'codex',
        LATTICE_AGENT: 'main',
        LATTICE_SESSION_ID: 'mixed-owner',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(barrierRoot, { recursive: true });
    writeFileSync(deadTicket, JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      command: 'dead A',
      acquiredAt: '2026-07-19T00:00:00.000Z',
      lockId: 'dead-a',
    }) + '\n');
    const childEnv = (id: 'w1' | 'w2', agent: string, sessionId: string) => ({
      ...process.env,
      NODE_ENV: 'test',
      LATTICE_PROJECT_ROOT: root,
      LATTICE_ACTIVITY_SOURCE: 'codex',
      LATTICE_AGENT: agent,
      LATTICE_SESSION_ID: sessionId,
      LATTICE_TEST_REVIEW_METADATA_BARRIER_ROOT: barrierRoot,
      LATTICE_TEST_REVIEW_METADATA_BARRIER_ID: id,
    });
    children.push(spawn(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'review_run_start',
      JSON.stringify({ storyId, agent: 'lattice-review-quality' }),
    ], {
      cwd: root,
      env: childEnv('w2', 'lattice-review-quality', 'concurrent-lattice-review-quality'),
      stdio: 'ignore',
    }));
    waitForPath(join(barrierRoot, 'observed-w2'), 'W2 observing dead A');
    children.push(spawn(process.execPath, [
      DIST_CLI_PATH, '--root', root, 'agent_prompt',
      JSON.stringify({ storyId, role: 'lattice-review-docs', format: 'json' }),
    ], {
      cwd: root,
      env: childEnv('w1', 'main', 'mixed-owner'),
      stdio: 'ignore',
    }));
    waitForPath(join(barrierRoot, 'observed-w1'), 'W1 observing dead A');
    writeFileSync(join(barrierRoot, 'allow-remove-w2'), 'go');
    waitForPath(join(barrierRoot, 'acquired-w2'), 'replacement B/W2 acquiring after reclaim');
    const replacementTicket = readFileSync(join(barrierRoot, 'acquired-w2'), 'utf8');
    assert.equal(existsSync(replacementTicket), true, 'replacement B ticket exists before delayed W1 reclaim resumes');

    writeFileSync(join(barrierRoot, 'allow-remove-w1'), 'go');
    sleepSync(100);
    assert.equal(
      existsSync(replacementTicket),
      true,
      'delayed stale reclaimer removes only dead A identity and cannot delete replacement B',
    );
    assert.equal(existsSync(join(barrierRoot, 'acquired-w1')), false, 'agent_prompt cannot overlap review_run_start critical section');

    writeFileSync(join(barrierRoot, 'release-w2'), 'go');
    waitForPath(join(barrierRoot, 'completed-w2'), 'actual review_run_start completion');
    waitForPath(join(barrierRoot, 'acquired-w1'), 'actual agent_prompt acquiring after review_run_start release');
    writeFileSync(join(barrierRoot, 'release-w1'), 'go');
    waitForPath(join(barrierRoot, 'completed-w1'), 'actual agent_prompt completion');
    const envelopes = store.readPromptEnvelopes(storyId).envelopes;
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(envelopes.length, 2, 'actual mixed producers preserve both Prompt Envelope records');
    assert.deepEqual(
      [...new Set(envelopes.map(envelope => envelope.dispatchKind))].sort(),
      ['review-run', 'story-dispatch'],
      'persisted envelopes identify both actual producer paths',
    );
    assert.equal(runs.length, 1, 'actual review_run_start durably persists exactly one ReviewRun');
    assert.equal(verifyReviewRun(runs[0]), true, 'actual mixed-writer ReviewRun remains signed');
    assert.deepEqual(
      verifyReviewRunPromptEnvelope(store, runs[0]),
      { ok: true },
      'gate verifier accepts the review-run envelope after agent_prompt appends its record',
    );
    console.log(`${MARKER} MIXED WRITER LOCK ABA: actual review_run_start + agent_prompt preserve two envelopes and valid signed ReviewRun`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function runConcurrentReviewerWriteCase(mask: number, iteration = 1): void {
  const root = mkdtempSync(join(tmpdir(), `lattice-reviewer-rollout-mixed-${mask}-${iteration}-`));
  const storyId = 'B-concurrent-reviewers';
  const roles = [
    'lattice-review-behavior',
    'lattice-review-concept',
    'lattice-review-docs',
    'lattice-review-quality',
    'lattice-review-test-coverage',
  ];
  const rolloutModes = Object.fromEntries(roles.map((role, index) => [
    role,
    (mask & (1 << index)) === 0 ? 'legacy-full-context' : 'full-envelope',
  ]));
  const round = '2026-07-19T00:00:00.000Z';
  const shellCommand = (command: string, payload: Record<string, unknown>, role: string) => [
    `LATTICE_AGENT=${JSON.stringify(role)}`,
    `LATTICE_SESSION_ID=${JSON.stringify(`concurrent-${role}`)}`,
    JSON.stringify(process.execPath),
    JSON.stringify(DIST_CLI_PATH),
    '--root',
    JSON.stringify(root),
    command,
    JSON.stringify(JSON.stringify(payload)),
    '>/dev/null',
  ].join(' ');
  try {
    write(root, '.gitignore', '.lattice/activity.jsonl\n.lattice/locks/\n');
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
      promptEnvelope: {
        version: 'proofbound.prompt-envelope-rollout.v1',
        roles: rolloutModes,
      },
    }, null, 2) + '\n');
    write(root, 'src/seed.ts', 'export const seed = true;\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed concurrent reviewer fixture']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      ...reviewStory(storyId, 1, round),
      title: 'Concurrent reviewer rollout',
      description: 'Exercise real concurrent reviewer evidence writers.',
      priority: 'high',
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Preserve every reviewer result',
        context: 'Concurrent writes must serialize without overwrite.',
        status: 'done',
        startTime: null,
        endTime: round,
        files: { modify: ['src/seed.ts'], create: [], test: [] },
        verificationIntent: {
          happy: [{ id: 'CHK-001:happy:0', desc: 'All reviewer evidence is retained.', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    git(root, ['add', '.lattice/story']);
    git(root, [...COMMIT_ENV, 'commit', '-m', 'seed review metadata']);

    for (const role of roles) {
      execFileSync(process.execPath, [
        DIST_CLI_PATH, '--root', root, 'dispatch', JSON.stringify({ storyId, agentType: role }),
      ], {
        cwd: root,
        env: {
          ...process.env,
          LATTICE_PROJECT_ROOT: root,
          LATTICE_ACTIVITY_SOURCE: 'codex',
          LATTICE_AGENT: 'main',
          LATTICE_SESSION_ID: 'concurrent-owner',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const startScript = ['set -eu', ...roles.map(role =>
      `${shellCommand('review_run_start', { storyId, agent: role }, role)} &`,
    ), 'wait'].join('\n');
    execFileSync('/bin/sh', ['-c', startScript], {
      cwd: root,
      env: { ...process.env, LATTICE_PROJECT_ROOT: root, LATTICE_ACTIVITY_SOURCE: 'codex' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(runs.length, roles.length, 'concurrent review_run_start preserves every lane');
    assert.equal(new Set(runs.map(run => run.reviewRunId)).size, roles.length, 'concurrent runs mint unique IDs');
    const fullRoles = roles.filter(role => rolloutModes[role] === 'full-envelope');
    assert.equal(
      store.readPromptEnvelopes(storyId).envelopes.length,
      fullRoles.length,
      `mixed mask ${mask} iteration ${iteration} persists one envelope for each full-envelope lane only`,
    );
    for (const run of runs) {
      const full = rolloutModes[run.lane] === 'full-envelope';
      assert.equal(Boolean(run.envelopeId), full, `mixed mask ${mask} iteration ${iteration} ${run.lane} binds its selected rollout representation`);
      assert.equal(Boolean(run.assembledPrompt), full, `mixed mask ${mask} iteration ${iteration} ${run.lane} stores assembled prompt only in full mode`);
    }

    const evidenceCommands = roles.map((role, index) => {
      const reviewRunId = runs.find(run => run.lane === role)!.reviewRunId;
      return index % 2 === 0
        ? shellCommand('review_pass_set', {
          storyId,
          agent: role,
          reviewRunId,
          note: `${role} found no blocker after inspecting the bounded fixture.`,
          readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
        }, role)
        : shellCommand('finding_add', {
          storyId,
          agent: role,
          reviewRunId,
          desc: `${role} recorded a nonblocking concurrent evidence finding.`,
          severity: 'low',
          category: 'edge',
        }, role);
    });
    execFileSync('/bin/sh', ['-c', ['set -eu', ...evidenceCommands.map(command => `${command} &`), 'wait'].join('\n')], {
      cwd: root,
      env: { ...process.env, LATTICE_PROJECT_ROOT: root, LATTICE_ACTIVITY_SOURCE: 'codex' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(store.readReviewPasses(storyId).passes.length, 3, 'concurrent passes are retained exactly once');
    assert.equal(store.readFindings(storyId).findings.length, 2, 'concurrent findings are retained exactly once');
    const evidence = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(evidence.invalid.length, 0, `collector accepts every current signed result under mixed mask ${mask} iteration ${iteration}`);
    assert.deepEqual(
      [...new Set(evidence.valid.map(item => item.agent))].sort(),
      [...roles].sort(),
      `collector counts every reviewer lane once without overwrite under mixed mask ${mask} iteration ${iteration}`,
    );
    assert.equal(canPassReviewGuard({ storyId, store, projectRoot: root }), true, `real REVIEW gate accepts complete evidence under mixed mask ${mask} iteration ${iteration}`);
    console.log(`${MARKER} MIXED MASK ${mask} iteration ${iteration}: five concurrent legacy/full runs + pass/finding writers preserved gate evidence`);
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function run(): void {
  runPolicyCases();
  runFixtureDuplicateIdentityCases();
  assertLargeDiffReviewMetadataStability();
  runIncrementalCases();
  runGateUnchangedCase();
  runConcurrentCliReadOnlyCase();
  runDeterministicTicketReclaimAbaCase();
  runConcurrentReviewerWriteCase(0b11111);
  runConcurrentReviewerWriteCase(0b01010);
  for (let iteration = 1; iteration <= 20; iteration += 1) {
    runConcurrentReviewerWriteCase(0b10101, iteration);
  }
  console.log(`\n${MARKER} PASS — incremental context is correct for returning/first-timer/rename (cases a–c), and canPassReviewGuard is behaviorally IDENTICAL with vs without the incremental helper across missing-round and invalid-binding fail-closed branches, with the helper proven to write nothing to the store (case d).`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  if (process.argv.includes('--aba-only')) {
    runDeterministicTicketReclaimAbaCase();
  } else {
    run();
  }
}
