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
 *         - Round 2+ (roundCount>=2): passes with >=1 valid current-round receipt.
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
 * git-free synthetic stores: with currentReviewRound UNSET, evidence run-binding
 * validation short-circuits to valid (no git / freshness machinery), and with it
 * SET + an unknown reviewRunId the binding is invalid — both deterministic and
 * independent of the host git state.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviewIncrementalContext } from '../core/review-incremental-context.js';
import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';
import { resetConfigCache } from '../core/config.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import {
  currentGitHead,
} from '../core/evidence-freshness.js';
import type { StoryStore } from '../core/store.js';
import type {
  Finding,
  ReviewPass,
  ReviewRun,
  StoryEvent,
  StoryInfo,
} from '../core/types.js';

/** Marker line printed by the smoke so `lattice validate` output is greppable. */
const MARKER = 'review-incremental-context-smoke:';

const COMMIT_ENV = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke'];

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
      assert.equal(ctx.isFirstPass, false, '(a) returning reviewer must NOT be first pass');
      assert.equal(ctx.priorHeadHash, baseSha, '(a) priorHeadHash must resolve to the bound baseSha');
      assert.ok(ctx.priorVerdict && ctx.priorVerdict.includes('RP-001'), '(a) priorVerdict must reference the prior pass');
      assert.equal(ctx.scopeChanged, true, '(a) material change since last pass => scopeChanged=true');
      assert.ok(
        ctx.changedFiles.includes('src/feature.ts'),
        `(a) changedFiles must include the edited material file, got ${JSON.stringify(ctx.changedFiles)}`,
      );
      console.log(`${MARKER} (a) RETURNING REVIEWER: isFirstPass=false, priorVerdict=${ctx.priorVerdict}, scopeChanged=true, changedFiles=${JSON.stringify(ctx.changedFiles)}`);
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
      assert.equal(ctx.isFirstPass, false, '(c) returning reviewer with a rename is not first pass');
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
      assert.ok(
        ctx.priorVerdict && ctx.priorVerdict.includes('RP-003'),
        `(e) priorVerdict stays non-null/informational alongside isFirstPass=true, got ${JSON.stringify(ctx.priorVerdict)}`,
      );
      console.log(`${MARKER} (e) PRIOR VERDICT + UNRESOLVABLE headHash: isFirstPass=true, priorHeadHash=null, priorVerdict=${ctx.priorVerdict} (non-null, informational), full diff changedFiles=${JSON.stringify(ctx.changedFiles)}`);
    }

    void headSha; // headSha is HEAD; referenced for clarity in fixture wiring above.
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
 * content (currentReviewRound is unset / bound to an unknown run, so no freshness
 * machinery runs); the repo only lets reviewIncrementalContext run without
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

    // (d.1) Round 1 — ALL opt-in reviewers + quorum present => gate PASSES.
    // currentReviewRound UNSET so run-binding validation short-circuits to valid
    // (no git). Provide a signed pass for each baseline reviewer lane.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = BASELINE_REVIEWERS.map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(10 + i)),
      );
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.1) round-1 full opt-in + quorum');
      assert.equal(outcome, true, '(d.1) Round 1 with ALL opt-in reviewers + quorum must PASS the gate');
      console.log(`${MARKER} (d.1) ROUND 1 full opt-in + quorum -> gate PASS; identical with/without helper`);
    }

    // (d.2) Round 1 — MISSING one opt-in reviewer (test-coverage) => gate BLOCKS.
    {
      const story = reviewStory(storyId, 1, undefined);
      const passes = ['concept', 'quality'].map((short, i) =>
        signedPass(storyId, `RP-${i + 1}`, `lattice-review-${short}`, ts(10 + i)),
      );
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.2) round-1 missing opt-in reviewer');
      assert.equal(outcome, false, '(d.2) Round 1 missing an opt-in reviewer must BLOCK the gate');
      console.log(`${MARKER} (d.2) ROUND 1 missing opt-in reviewer (test-coverage) -> gate BLOCK; identical with/without helper`);
    }

    // (d.3) Round 2 — >=1 valid current-round receipt => gate PASSES.
    {
      const story = reviewStory(storyId, 2, undefined);
      const passes = [signedPass(storyId, 'RP-1', 'lattice-review-concept', ts(20))];
      const store = buildFixtureStore({ story, passes });
      const outcome = assertGateUnchangedByHelper(store, projectRoot, storyId, '(d.3) round-2 single valid receipt');
      assert.equal(outcome, true, '(d.3) Round 2+ with >=1 valid current-round receipt must PASS the gate');
      console.log(`${MARKER} (d.3) ROUND 2+ single valid receipt -> gate PASS; identical with/without helper`);
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

    // (d.5) VERIFIED OPEN BLOCKING FINDING blocks (after round decay).
    // currentReviewRound UNSET => the critical open finding is a valid evidence
    // record with no run binding required; isFindingBlocking(critical) is true in
    // every round, so blocking.length>0 => gate BLOCKS.
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
      assert.equal(outcome, false, '(d.5) a verified open critical finding must BLOCK the gate');
      console.log(`${MARKER} (d.5) VERIFIED OPEN BLOCKING FINDING (critical) -> gate BLOCK; identical with/without helper`);
    }
  } finally {
    resetConfigCache();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function run(): void {
  runIncrementalCases();
  runGateUnchangedCase();
  console.log(`\n${MARKER} PASS — incremental context is correct for returning/first-timer/rename (cases a–c), and canPassReviewGuard is behaviorally IDENTICAL with vs without the incremental helper across all gate branches (round-1 opt-in+quorum, round-2+ single receipt, invalid-binding-blocks-all-rounds, verified-open-blocking-finding), with the helper proven to write nothing to the store (case d).`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  run();
}
