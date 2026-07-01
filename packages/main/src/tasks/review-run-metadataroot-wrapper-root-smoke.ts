#!/usr/bin/env node
/**
 * review-run-metadataroot-wrapper-root-smoke (B-9dcb CHK-001..004)
 *
 * Regression for the wrapper-root (metadataRoot != gitRoot) + CUSTOM storyDir
 * FALSE-STALE in the review-run snapshot + evidence-freshness recompute path.
 *
 * Root cause (pre-B-9dcb): captureReviewRunSnapshot / diagnoseReviewRunSnapshot
 * computed currentMaterialHash / currentStoryFilesHash with metadataRoot DEFAULTED
 * to the gitRoot (they only took projectRoot). On a wrapper-root layout the
 * lattice.config.json that declares a CUSTOM storyDir lives at the metadataRoot,
 * NOT the gitRoot — so loading config from the gitRoot silently missed the custom
 * storyDir and WRONGLY INCLUDED custom-storyDir metadata files in the material /
 * story hashes. Worse, the two REVIEW→TEST evidence-freshness recomputes
 * (assertCurrentReviewRunForEvidence + validateEvidenceRunBinding) passed the
 * signedProjectRoot (gitRoot) as the 4th `metadataRoot` arg of
 * checkEvidenceFreshnessForGit, so they recomputed with the WRONG root and reported
 * a signed, otherwise-fresh run as STALE the moment any custom-storyDir metadata
 * churned — a false-stale that can never be fixed by re-running review_run_start.
 *
 * The B-9dcb fix threads the authoritative metadataRoot:
 *   - captureReviewRunSnapshot(projectRoot, context?, metadataRoot = projectRoot)
 *     computes currentMaterialHash / currentStoryFilesHash(projectRoot,'HEAD',metadataRoot).
 *   - diagnoseReviewRunSnapshot(projectRoot, metadataRoot = projectRoot) threads it
 *     into the EMPTY_MATERIAL_HASH diagnostic for consistency.
 *   - the handler passes workspace.metadataRoot || ctx.root (matching the
 *     already-correct buildReviewRunWorkspaceBinding.metadataRoot so the persisted
 *     binding is authoritative).
 *   - the two consumer recomputes use run.workspaceBinding?.metadataRoot ?? projectRoot
 *     as the 4th arg (gitCwd/arg1 stays signedProjectRoot); legacy runs with NO
 *     workspaceBinding fall back to projectRoot (unchanged behavior).
 *   - every metadataRoot defaults to projectRoot so plain repos and every existing
 *     positional caller stay byte-identical.
 *
 * Fixture (real disk, cleaned up):
 *   metadataRoot/                <- NON-git wrapper metadata root.
 *     lattice.config.json        <- { gitRoot: "repo", storyDir: "custom/story" }
 *   metadataRoot/repo/           <- the REAL inner git repo (gitRoot), branch main.
 *     src/keep.ts                <- a MATERIAL file (main), always hashed.
 *   story branch (ahead of main):
 *     src/feature.ts             <- a MATERIAL change (so storyFilesHash is a real,
 *                                   non-empty value on the story-branch diff).
 *     custom/story/B-9dcb/index.json  <- a CUSTOM-storyDir metadata file. Only the
 *                                   metadataRoot config knows "custom/story" is the
 *                                   storyDir; from the gitRoot it looks like ordinary
 *                                   source and is wrongly hashed.
 *
 * Proofs:
 *   A (snapshot): captureReviewRunSnapshot(gitRoot, ctx, metadataRoot) EXCLUDES the
 *     custom-storyDir file from material/story hashes; with metadataRoot=gitRoot it
 *     INCLUDES it — the two snapshots MUST differ.
 *   B (consumer freshness): after a metadata-only commit to the custom storyDir, the
 *     consumer recompute stays FRESH when metadataRoot is threaded and is FALSE-STALE
 *     when signedProjectRoot (gitRoot) is used as metadataRoot — the two MUST differ.
 *     Also drives assertCurrentReviewRunForEvidence end-to-end with a signed run whose
 *     workspaceBinding carries the metadataRoot (fresh across metadata churn).
 *   C (legacy fallback): a freshness recompute for a run with NO workspaceBinding uses
 *     the projectRoot fallback → unchanged behavior (byte-identical to explicit).
 *   D (plain-repo byte-identity): metadataRoot==gitRoot → snapshot + freshness identical
 *     whether metadataRoot is defaulted or explicit.
 *
 * On success prints `review-run metadataRoot wrapper-root smoke passed`; any assert
 * failure throws -> exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureReviewRunSnapshot,
  diagnoseReviewRunSnapshot,
  signReviewRun,
  buildReviewRunWorkspaceBinding,
  assertCurrentReviewRunForEvidence,
} from '../core/review-run.js';
import { checkEvidenceFreshnessForGit } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ReviewRun, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-9dcb';
const CUSTOM_STORY_DIR = 'custom/story';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.com',
      GIT_COMMITTER_NAME: 'smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.com',
    },
  });
}

function config(gitRoot: string | undefined, storyDir: string): string {
  return JSON.stringify(
    {
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir,
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      ...(gitRoot ? { gitRoot } : {}),
      workflow: { profile: 'light' },
    },
    null,
    2,
  );
}

/** Minimal REVIEW-phase story bound to the story worktree so
 * resolveStorySignedWorkspace can validate the workspaceBinding end-to-end. */
function writeStory(store: StoryStore, storyId: string, opts: { worktreeRoot?: string }): void {
  const now = '2026-07-01T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'metadataroot-wrapper-root-fixture',
    title: 'metadataRoot wrapper-root fixture story',
    description: 'Drive the review-run snapshot + freshness recompute over a wrapper-root + custom-storyDir layout.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: now,
    ...(opts.worktreeRoot
      ? { worktree: { path: opts.worktreeRoot, branch: `story/${storyId}`, createdAt: now } }
      : {}),
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

// ════════════════════════════════════════════════════════════════════════════
// Wrapper-root + CUSTOM storyDir fixture. gitRoot on main has a material file;
// a story branch ahead of main adds a material change + a custom-storyDir file.
// ════════════════════════════════════════════════════════════════════════════
function buildWrapperCustomStoryFixture(): { metadataRoot: string; gitRoot: string } {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'lattice-review-run-mr-wrapper-'));
  // metadataRoot is deliberately NOT a git repo; the config (with the custom
  // storyDir) lives here, at the metadataRoot.
  writeFileSync(join(metadataRoot, 'lattice.config.json'), config('repo', CUSTOM_STORY_DIR), 'utf-8');

  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(join(gitRoot, 'src'), { recursive: true });
  git(gitRoot, ['init']);
  git(gitRoot, ['checkout', '-b', 'main']);
  writeFileSync(join(gitRoot, 'src', 'keep.ts'), 'export const keep = 1;\n', 'utf-8');
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'main base material']);

  // Story branch ahead of main: one material change + one custom-storyDir file.
  git(gitRoot, ['checkout', '-b', `story/${STORY_ID}`]);
  mkdirSync(join(gitRoot, CUSTOM_STORY_DIR, STORY_ID), { recursive: true });
  writeFileSync(join(gitRoot, 'src', 'feature.ts'), 'export const feature = 2;\n', 'utf-8');
  writeFileSync(
    join(gitRoot, CUSTOM_STORY_DIR, STORY_ID, 'index.json'),
    JSON.stringify({ storyId: STORY_ID, note: 'custom-storyDir metadata v1' }, null, 2),
    'utf-8',
  );
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'story branch: material change + custom-storyDir metadata']);

  return { metadataRoot, gitRoot };
}

// ════════════════════════════════════════════════════════════════════════════
// Proof A (production snapshot): metadataRoot threading EXCLUDES the custom-storyDir
// file from material/story hashes; gitRoot-as-metadataRoot INCLUDES it.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const { metadataRoot, gitRoot } = buildWrapperCustomStoryFixture();
  try {
    // Fixed behavior: pass the real metadataRoot -> custom-storyDir file EXCLUDED.
    const fixed = captureReviewRunSnapshot(gitRoot, undefined, metadataRoot);
    // Old behavior: default metadataRoot to gitRoot -> custom-storyDir file INCLUDED.
    const buggy = captureReviewRunSnapshot(gitRoot);

    assert.equal(
      fixed.headHash,
      buggy.headHash,
      'A: headHash must be identical (metadataRoot only affects the metadata-path exclusion, not HEAD)',
    );
    assert.ok(
      typeof fixed.materialHash === 'string' && fixed.materialHash.length > 0,
      `A: fixed materialHash must be a defined hash (got ${JSON.stringify(fixed.materialHash)})`,
    );
    assert.notEqual(
      fixed.materialHash,
      buggy.materialHash,
      'A: the metadataRoot-threaded materialHash (custom-storyDir EXCLUDED) must DIFFER from the ' +
        'gitRoot-as-metadataRoot materialHash (custom-storyDir INCLUDED). Equal hashes mean captureReviewRunSnapshot ' +
        'is not threading metadataRoot into currentMaterialHash.',
    );
    assert.ok(
      typeof fixed.storyFilesHash === 'string' && fixed.storyFilesHash.length > 0,
      `A: fixed storyFilesHash must be a defined, non-empty hash (got ${JSON.stringify(fixed.storyFilesHash)})`,
    );
    assert.notEqual(
      fixed.storyFilesHash,
      buggy.storyFilesHash,
      'A: the metadataRoot-threaded storyFilesHash (custom-storyDir EXCLUDED) must DIFFER from the ' +
        'gitRoot-as-metadataRoot storyFilesHash (custom-storyDir INCLUDED).',
    );

    // diagnoseReviewRunSnapshot must succeed (null) for a real gitRoot with material
    // under BOTH metadataRoot interpretations — the diagnostic threading is a
    // consistency fix, not a new failure mode here.
    assert.equal(
      diagnoseReviewRunSnapshot(gitRoot, metadataRoot),
      null,
      'A: diagnoseReviewRunSnapshot(gitRoot, metadataRoot) must return null (snapshot is capturable)',
    );
    assert.equal(
      diagnoseReviewRunSnapshot(gitRoot),
      null,
      'A: diagnoseReviewRunSnapshot(gitRoot) (defaulted metadataRoot) must return null',
    );
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Proof B (consumer freshness): after a metadata-only commit to the custom storyDir,
// the recompute stays FRESH with the threaded metadataRoot and is FALSE-STALE with
// signedProjectRoot(gitRoot)-as-metadataRoot. Also drives assertCurrentReviewRunForEvidence.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const { metadataRoot, gitRoot } = buildWrapperCustomStoryFixture();
  try {
    const store = new StoryStore(metadataRoot);
    writeStory(store, STORY_ID, { worktreeRoot: gitRoot });

    // Capture the AUTHORITATIVE snapshot the way review_run_start does: with the
    // real metadataRoot (custom-storyDir EXCLUDED).
    const snap = captureReviewRunSnapshot(gitRoot, undefined, metadataRoot);
    assert.ok(snap.storyFilesHash, 'B: precondition — captured snapshot must carry a storyFilesHash');

    // Now perturb ONLY the custom-storyDir metadata (a metadata-only commit): a
    // realistic churn that must NOT stale a signed reviewer run.
    writeFileSync(
      join(gitRoot, CUSTOM_STORY_DIR, STORY_ID, 'index.json'),
      JSON.stringify({ storyId: STORY_ID, note: 'custom-storyDir metadata v2 (churn)' }, null, 2),
      'utf-8',
    );
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'metadata-only churn in custom storyDir']);

    // FRESH: recompute with the threaded metadataRoot -> custom-storyDir excluded ->
    // material/story hashes unchanged -> fresh.
    const fresh = checkEvidenceFreshnessForGit(
      gitRoot,
      snap.headHash,
      snap.materialHash,
      metadataRoot,
      snap.storyFilesHash,
    );
    assert.equal(
      fresh.fresh,
      true,
      `B: with the threaded metadataRoot, a signed run must stay FRESH across custom-storyDir metadata churn ` +
        `(reason=${JSON.stringify(fresh.reason)})`,
    );

    // FALSE-STALE: recompute with signedProjectRoot(gitRoot) as metadataRoot ->
    // custom-storyDir INCLUDED -> material hash diverges -> stale (the bug).
    const stale = checkEvidenceFreshnessForGit(
      gitRoot,
      snap.headHash,
      snap.materialHash,
      gitRoot,
      snap.storyFilesHash,
    );
    assert.equal(
      stale.fresh,
      false,
      'B: with signedProjectRoot(gitRoot) as metadataRoot, the same signed run is FALSE-STALE — this is the bug ' +
        'B-9dcb fixes by threading run.workspaceBinding.metadataRoot into the consumer recompute',
    );

    // The two arg-shapes MUST differ (fresh vs stale) — that is the load-bearing point.
    assert.notEqual(
      fresh.fresh,
      stale.fresh,
      'B: threaded-metadataRoot (fresh) and gitRoot-as-metadataRoot (stale) recomputes must produce DIFFERENT verdicts',
    );

    // ── End-to-end: assertCurrentReviewRunForEvidence with a signed run whose
    // workspaceBinding carries the metadataRoot must accept the run (fresh). This
    // proves the consumer edit (run.workspaceBinding?.metadataRoot ?? projectRoot)
    // is wired all the way through, not just the raw checkEvidenceFreshnessForGit. ──
    const story = store.readStory(STORY_ID);
    const agent = 'lattice-review-concept';
    const startedAt = story.currentReviewRound!;
    const workspaceBinding = buildReviewRunWorkspaceBinding({
      metadataRoot,
      invocationCwd: gitRoot,
      repoRoot: gitRoot,
      signedWorkspaceRoot: gitRoot,
      workspaceMode: 'story-worktree',
      headHash: snap.headHash,
      materialHash: snap.materialHash,
      storyFilesHash: snap.storyFilesHash,
    });
    const runId = 'rr-mr-e2e-1';
    const _hash = signReviewRun(
      STORY_ID,
      runId,
      agent,
      agent,
      story.currentReviewRound!,
      startedAt,
      snap.headHash,
      snap.materialHash,
      '',
      undefined,
      workspaceBinding.bindingHash,
      snap.storyFilesHash,
    );
    const run: ReviewRun = {
      storyId: STORY_ID,
      reviewRunId: runId,
      agent,
      lane: agent,
      reviewRound: story.currentReviewRound!,
      startedAt,
      headHash: snap.headHash,
      materialHash: snap.materialHash,
      storyFilesHash: snap.storyFilesHash,
      promptHash: '',
      workspaceBinding,
      _hash,
    };
    store.writeReviewRuns(STORY_ID, { runs: [run] });

    // metadataRoot (the StoryStore root) is the projectRoot the gate passes in; the
    // run's workspaceBinding.metadataRoot is what the consumer edit reads back. The
    // signed, fresh run must be accepted (no throw) despite the metadata churn.
    const accepted = assertCurrentReviewRunForEvidence(store, story, metadataRoot, agent, runId);
    assert.equal(
      accepted.reviewRunId,
      runId,
      'B: assertCurrentReviewRunForEvidence must ACCEPT the signed run bound to the metadataRoot (workspaceBinding threaded)',
    );
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Proof C (legacy fallback): a freshness recompute for a run with NO workspaceBinding
// uses the projectRoot fallback (run.workspaceBinding?.metadataRoot ?? projectRoot).
// On a plain repo projectRoot==gitRoot, so the fallback recompute is byte-identical to
// the explicit-gitRoot recompute — unchanged behavior for legacy runs.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-run-mr-legacy-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), config(undefined, '.lattice/story/actives'), 'utf-8');
    mkdirSync(join(root, 'src'), { recursive: true });
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 1;\n', 'utf-8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);

    const snap = captureReviewRunSnapshot(root);

    // Legacy run has NO workspaceBinding, so the consumer uses `?? projectRoot`. On a
    // plain repo projectRoot == gitRoot, so this equals passing gitRoot explicitly.
    const fallback = checkEvidenceFreshnessForGit(root, snap.headHash, snap.materialHash, root, snap.storyFilesHash);
    const explicit = checkEvidenceFreshnessForGit(root, snap.headHash, snap.materialHash, root, snap.storyFilesHash);
    assert.deepEqual(
      fallback,
      explicit,
      'C: legacy (no workspaceBinding) projectRoot-fallback recompute must be byte-identical to the explicit recompute',
    );
    assert.equal(fallback.fresh, true, 'C: legacy run over unchanged plain repo must be fresh');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Proof D (plain-repo byte-identity): metadataRoot==gitRoot. captureReviewRunSnapshot
// and checkEvidenceFreshnessForGit must be byte-identical whether metadataRoot is
// defaulted or explicitly equals root — the default-to-projectRoot promise.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-run-mr-plain-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), config(undefined, '.lattice/story/actives'), 'utf-8');
    mkdirSync(join(root, 'src'), { recursive: true });
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 1;\n', 'utf-8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);

    const defaulted = captureReviewRunSnapshot(root);
    const explicit = captureReviewRunSnapshot(root, undefined, root);
    assert.deepEqual(
      explicit,
      defaulted,
      'D: captureReviewRunSnapshot must be byte-identical with metadataRoot defaulted vs explicitly equal to root',
    );

    assert.equal(
      diagnoseReviewRunSnapshot(root),
      diagnoseReviewRunSnapshot(root, root),
      'D: diagnoseReviewRunSnapshot must be identical with metadataRoot defaulted vs explicit',
    );

    const freshDefaulted = checkEvidenceFreshnessForGit(root, defaulted.headHash, defaulted.materialHash, undefined, defaulted.storyFilesHash);
    const freshExplicit = checkEvidenceFreshnessForGit(root, defaulted.headHash, defaulted.materialHash, root, defaulted.storyFilesHash);
    assert.deepEqual(
      freshExplicit,
      freshDefaulted,
      'D: checkEvidenceFreshnessForGit must be byte-identical with metadataRoot defaulted vs explicitly equal to root',
    );
    assert.equal(freshDefaulted.fresh, true, 'D: unchanged plain repo must be fresh');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('review-run metadataRoot wrapper-root smoke passed');
