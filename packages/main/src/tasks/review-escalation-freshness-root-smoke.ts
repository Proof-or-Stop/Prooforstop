#!/usr/bin/env node
/**
 * review-escalation-freshness-root-smoke (B-36ba CHK-004)
 *
 * Proves that evaluateReviewEscalation's evidence-freshness root is the resolved
 * gitCwd (not the metadata/project root), so the review-escalation gate and the
 * review-assurance-floor compute the SAME materialHash / storyFilesHash under a
 * wrapper-root layout (git root != metadata/project root).
 *
 * Before B-36ba, evaluateReviewEscalation recomputed its freshness hashes from
 * args.projectRoot:
 *   currentMaterialHash(args.projectRoot)
 *   currentStoryFilesHash(args.projectRoot)
 * On a wrapper-root layout (projectRoot == bare non-git metadataRoot, real repo
 * in a configured gitRoot subdir) those probes run git from the non-git
 * metadataRoot, error, and return null — while review-assurance-floor (which
 * already threads gitCwd) returns the REAL hashes. The two DONE gates then
 * disagreed about the current material/story-files hash.
 *
 * B-36ba threads an optional gitCwd into evaluateReviewEscalation (defaulting to
 * projectRoot when absent, so plain repos stay byte-identical) and recomputes:
 *   currentMaterialHash(gitCwd, 'HEAD', args.projectRoot)
 *   currentStoryFilesHash(gitCwd, 'HEAD', args.projectRoot)
 * mirroring review-assurance-floor exactly.
 *
 * Cases:
 *   PLAIN (root == gitCwd == projectRoot):
 *     - floor.materialHash === escalation.materialHash (both non-null).
 *     - escalation.materialHash === currentMaterialHash(root, 'HEAD', root).
 *     - escalation.storyFilesHash === currentStoryFilesHash(root, 'HEAD', root).
 *     - no-change regression: omitting gitCwd yields the SAME hashes (gitCwd
 *       defaults to projectRoot).
 *   WRAPPER-ROOT (non-git metadataRoot + inner gitRoot):
 *     - floor.materialHash === escalation.materialHash (both defined/non-null).
 *     - escalation.materialHash === currentMaterialHash(repoDir, 'HEAD', metaRoot).
 *     - escalation.storyFilesHash === currentStoryFilesHash(repoDir, 'HEAD', metaRoot).
 *     - RED-documenting: omitting gitCwd (defaults to the non-git metaRoot) makes
 *       escalation.materialHash null and !== floor.materialHash. This is exactly
 *       the floor<->escalation disagreement the gitCwd plumbing fixes.
 *
 * B-36ba REVIEW F-001/F-002 add a third case:
 *   WRAPPER-ROOT (real StoryStore: handlers + machine guards):
 *     The first two cases drive the evaluator with synthetic story/findings args.
 *     Findings F-001/F-002 require DIRECT wrapper-root RUNTIME invocation of the
 *     three review_escalation_* handlers (CHK-003:happy:0/1/2) and the two
 *     machine.ts escalation call sites (CHK-002:happy:1/2), proving the
 *     resolveGitCwd -> evaluator path computes the REAL gitRoot hashes — not the
 *     bare non-git metadataRoot — through the exact production wiring.
 *       - resolveGitCwd(store, storyId, metaRoot, metaRoot) === gitRoot (!= metaRoot).
 *         This is the single resolution all three handlers AND both machine call
 *         sites share.
 *       - HANDLERS (F-001): review_escalation_status / _policy_set / _fallback_set
 *         each report report.materialHash === the floor materialHash.
 *       - MACHINE (F-002): canFinishGuard + getGuardFailureReason run without
 *         throwing under wrapper-root; evaluateReviewEscalation called with the
 *         EXACT machine.ts gitCwd expression (`context.gitCwd ?? resolveGitCwd(...)`)
 *         yields the floor material/story-files hashes.
 *       - RED control: the evaluator with NO gitCwd (defaults to the non-git
 *         metaRoot) yields a null materialHash that differs from the floor.
 *
 * On success prints `review-escalation freshness-root smoke passed`; any assert
 * failure throws -> exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { evaluateReviewEscalation } from '../core/review-escalation.js';
import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createReviewEscalationHandlers } from '../handlers/review-escalation.js';
import type { HandlerContext } from '../handlers/context.js';
import { canFinishGuard, getGuardFailureReason } from '../core/machine.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { realpathSync } from 'node:fs';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-36ba-smoke';
const BRANCH = 'story/B-36ba-smoke';

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

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

/**
 * Build an inner git repo with main + a story branch that introduces a material
 * code file. After this runs, `git diff main...HEAD` shows a material code path
 * (so storyFilesHash is non-empty and materialHash is defined).
 */
function buildInnerRepo(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'smoke@example.invalid']);
  git(repoDir, ['config', 'user.name', 'Freshness Root Smoke']);
  git(repoDir, ['checkout', '-B', 'main']);
  write(repoDir, 'README.md', '# freshness root smoke inner repo\n');
  write(repoDir, 'packages/main/src/seed.ts', 'export const seed = 1;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'seed']);
  git(repoDir, ['checkout', '-B', BRANCH]);
  // A material (non-metadata) source file diffed against main.
  write(repoDir, 'packages/main/src/foo.ts', 'export const foo = 1;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'material code file']);
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: STORY_ID,
    title: 'Review escalation freshness-root smoke',
    description: 'Drive the review escalation evaluator over plain and wrapper-root layouts.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: '2026-06-24T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    events: [],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PLAIN layout: root == gitCwd == projectRoot.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = mkdtempSync(join(tmpdir(), 'review-escalation-freshness-plain-'));
  try {
    buildInnerRepo(root);

    const floor = evaluateReviewAssuranceFloor({
      projectRoot: root,
      gitCwd: root,
      story: story(),
      findings: [],
      processEvents: [],
    });
    const escalation = evaluateReviewEscalation({
      projectRoot: root,
      gitCwd: root,
      story: story(),
      findings: [],
      processEvents: [],
    });

    assert.ok(
      floor.materialHash,
      `PLAIN: floor.materialHash must be non-null (got ${JSON.stringify(floor.materialHash)})`,
    );
    assert.ok(
      escalation.materialHash,
      `PLAIN: escalation.materialHash must be non-null (got ${JSON.stringify(escalation.materialHash)})`,
    );
    assert.equal(
      escalation.materialHash,
      floor.materialHash,
      'PLAIN: floor and escalation must compute the SAME materialHash',
    );
    assert.equal(
      escalation.materialHash,
      currentMaterialHash(root, 'HEAD', root),
      'PLAIN: escalation.materialHash must equal currentMaterialHash(root, HEAD, root)',
    );
    assert.equal(
      escalation.storyFilesHash,
      currentStoryFilesHash(root, 'HEAD', root),
      'PLAIN: escalation.storyFilesHash must equal currentStoryFilesHash(root, HEAD, root)',
    );

    // No-change regression: omitting gitCwd defaults it to projectRoot (== root
    // here), so the recomputed hashes must be byte-identical.
    const escalationNoGit = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [],
      processEvents: [],
    });
    assert.equal(
      escalationNoGit.materialHash,
      escalation.materialHash,
      'PLAIN: omitting gitCwd must yield the SAME materialHash (gitCwd defaults to projectRoot)',
    );
    assert.equal(
      escalationNoGit.storyFilesHash,
      escalation.storyFilesHash,
      'PLAIN: omitting gitCwd must yield the SAME storyFilesHash (gitCwd defaults to projectRoot)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// WRAPPER-ROOT layout: non-git metadataRoot + inner gitRoot subdir.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const metaRoot = mkdtempSync(join(tmpdir(), 'review-escalation-freshness-wrapper-'));
  try {
    // metaRoot is deliberately NOT a git repo. The real repo is the 'repo' subdir.
    writeFileSync(
      join(metaRoot, 'lattice.config.json'),
      JSON.stringify(
        {
          scanRoot: 'packages/main',
          rootDir: 'src',
          storyDir: '.lattice/story/actives',
          requirementsDir: 'docs/requirements',
          gitRoot: 'repo',
        },
        null,
        2,
      ),
      'utf-8',
    );
    resetConfigCache();

    const repoDir = join(metaRoot, 'repo');
    buildInnerRepo(repoDir);

    const floor = evaluateReviewAssuranceFloor({
      projectRoot: metaRoot,
      gitCwd: repoDir,
      story: story(),
      findings: [],
      processEvents: [],
    });
    const escalation = evaluateReviewEscalation({
      projectRoot: metaRoot,
      gitCwd: repoDir,
      story: story(),
      findings: [],
      processEvents: [],
    });

    assert.ok(
      floor.materialHash,
      `WRAPPER: floor.materialHash must be defined (got ${JSON.stringify(floor.materialHash)})`,
    );
    assert.ok(
      escalation.materialHash,
      `WRAPPER: escalation.materialHash must be defined (got ${JSON.stringify(escalation.materialHash)})`,
    );
    assert.equal(
      escalation.materialHash,
      floor.materialHash,
      'WRAPPER: floor and escalation must compute the SAME materialHash with gitCwd threaded',
    );
    assert.equal(
      escalation.materialHash,
      currentMaterialHash(repoDir, 'HEAD', metaRoot),
      'WRAPPER: escalation.materialHash must equal currentMaterialHash(repoDir, HEAD, metaRoot)',
    );
    assert.equal(
      escalation.storyFilesHash,
      currentStoryFilesHash(repoDir, 'HEAD', metaRoot),
      'WRAPPER: escalation.storyFilesHash must equal currentStoryFilesHash(repoDir, HEAD, metaRoot)',
    );

    // RED-documenting: omitting gitCwd defaults it to the non-git metaRoot, so the
    // freshness probes error and materialHash is null — disagreeing with the floor.
    // This is precisely the floor<->escalation drift the gitCwd plumbing fixes.
    const escalationNoGit = evaluateReviewEscalation({
      projectRoot: metaRoot,
      story: story(),
      findings: [],
      processEvents: [],
    });
    assert.equal(
      escalationNoGit.materialHash,
      null,
      `WRAPPER RED: omitting gitCwd (defaults to non-git metaRoot) must yield materialHash null ` +
        `(got ${JSON.stringify(escalationNoGit.materialHash)})`,
    );
    assert.notEqual(
      escalationNoGit.materialHash,
      floor.materialHash,
      'WRAPPER RED: the no-gitCwd escalation hash must DIFFER from the floor hash (the disagreement this story fixes)',
    );
  } finally {
    rmSync(metaRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// WRAPPER-ROOT (real StoryStore: handlers + machine guards) — B-36ba F-001/F-002.
//
// DIRECT wrapper-root RUNTIME coverage: drive the three review_escalation_*
// handlers and the two machine.ts escalation guards over a real StoryStore on a
// wrapper-root layout (non-git metadataRoot + inner gitRoot subdir), proving the
// resolveGitCwd -> evaluator path computes the REAL gitRoot hashes through the
// exact production wiring (not a synthetic evaluator call).
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const metaRoot = mkdtempSync(join(tmpdir(), 'review-escalation-freshness-store-'));
  const STORE_STORY_ID = 'B-36ba-store';
  try {
    // metaRoot is deliberately NOT a git repo. The real repo is the 'repo' subdir.
    // gitRoot:'repo' drives resolveGitCwd's configured-git-root branch (the story
    // has NO worktree binding, so the resolver routes to the configured subdir).
    writeFileSync(
      join(metaRoot, 'lattice.config.json'),
      JSON.stringify(
        {
          scanRoot: 'packages/main',
          rootDir: 'src',
          storyDir: '.lattice/story/actives',
          requirementsDir: 'docs/requirements',
          worktreeDir: '.worktrees',
          gitRoot: 'repo',
        },
        null,
        2,
      ),
      'utf-8',
    );
    resetConfigCache();

    // Build the inner git repo on a NON-story/* branch ('work') on purpose: the
    // handlers' autoCommitStoryMetadata is then a silent no-op (auto-commit-metadata.ts
    // returns '' when the branch does not start with 'story/'), so the handler calls
    // never mutate the inner repo's working tree or HEAD mid-smoke.
    const gitRoot = join(metaRoot, 'repo');
    mkdirSync(gitRoot, { recursive: true });
    git(gitRoot, ['init']);
    git(gitRoot, ['config', 'user.email', 'smoke@example.invalid']);
    git(gitRoot, ['config', 'user.name', 'Freshness Root Store Smoke']);
    git(gitRoot, ['checkout', '-B', 'main']);
    write(gitRoot, 'README.md', '# freshness root store smoke inner repo\n');
    write(gitRoot, 'packages/main/src/seed.ts', 'export const seed = 1;\n');
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'seed']);
    // NON-story/* branch on purpose (see above).
    git(gitRoot, ['checkout', '-B', 'work']);
    // A material (non-metadata) source file diffed against main -> storyFilesHash
    // is non-empty and materialHash is defined.
    write(gitRoot, 'packages/main/src/foo.ts', 'export const foo = 1;\n');
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'material code file']);

    // Minimal TEST-phase story with NO worktree binding -> resolveGitCwd uses the
    // configured-git-root branch driven by lattice.config.json gitRoot.
    const store = new StoryStore(metaRoot);
    const now = '2026-06-24T00:00:00.000Z';
    const storeStory: StoryInfo = {
      storyId: STORE_STORY_ID,
      name: 'wrapper-root-store-fixture',
      title: 'Wrapper root store fixture story',
      description: 'Drive the review-escalation handlers + machine guards over a wrapper-root layout.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      // NO worktree binding -> configured-git-root branch resolves to the subdir.
    };
    const storeChecklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Synthetic item',
        context: 'Synthetic context',
        status: 'done',
        startTime: null,
        endTime: null,
      }],
    };
    store.writeStory(STORE_STORY_ID, storeStory);
    store.writeChecklist(STORE_STORY_ID, storeChecklist);

    // realpath-tolerant compare (mkdtemp under macOS /var symlinks to /private/var,
    // and resolveGitCwd canonicalizes via realpath — mirror done-oracle-wrapper-root-smoke).
    const real = (p: string): string => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };

    // ── (1) resolveGitCwd: the SHARED resolution all handlers + machine sites use ──
    const resolvedGitCwd = resolveGitCwd({
      store,
      storyId: STORE_STORY_ID,
      metadataRoot: metaRoot,
      projectRoot: metaRoot,
    });
    assert.equal(
      real(resolvedGitCwd),
      real(gitRoot),
      `STORE: resolveGitCwd must resolve to the configured inner gitRoot ` +
        `(got ${resolvedGitCwd}, expected ${gitRoot})`,
    );
    assert.notEqual(
      real(resolvedGitCwd),
      real(metaRoot),
      `STORE: resolveGitCwd must NOT resolve to the bare non-git metaRoot (got ${resolvedGitCwd})`,
    );

    // ── (2) floor hashes (the source of truth the handlers + guards must match) ──
    const floorMaterial = currentMaterialHash(gitRoot, 'HEAD', metaRoot);
    const floorStory = currentStoryFilesHash(gitRoot, 'HEAD', metaRoot);
    assert.ok(
      floorMaterial,
      `STORE: currentMaterialHash(gitRoot, HEAD, metaRoot) must be non-null (got ${JSON.stringify(floorMaterial)})`,
    );
    assert.ok(
      floorStory,
      `STORE: currentStoryFilesHash(gitRoot, HEAD, metaRoot) must be non-null (got ${JSON.stringify(floorStory)})`,
    );
    const floor = evaluateReviewAssuranceFloor({
      projectRoot: metaRoot,
      gitCwd: gitRoot,
      store,
      storyId: STORE_STORY_ID,
    });
    assert.equal(
      floor.materialHash,
      floorMaterial,
      'STORE: evaluateReviewAssuranceFloor.materialHash must equal currentMaterialHash(gitRoot, HEAD, metaRoot)',
    );

    // ── (3) HANDLERS (F-001): DIRECT wrapper-root runtime invocation ──
    const ctx = { store, root: metaRoot, scanRoot: 'packages/main' } as HandlerContext;
    const handlers = createReviewEscalationHandlers(ctx);

    // CHK-003:happy:0 — review_escalation_status reports the floor hashes DIRECTLY.
    const statusReport = handlers.review_escalation_status({ storyId: STORE_STORY_ID, json: true }) as {
      materialHash: string | null;
      storyFilesHash: string | null;
    };
    assert.equal(
      statusReport.materialHash,
      floorMaterial,
      'STORE F-001 (CHK-003:happy:0): review_escalation_status.materialHash must equal the floor materialHash',
    );
    assert.equal(
      statusReport.storyFilesHash,
      floorStory,
      'STORE F-001 (CHK-003:happy:0): review_escalation_status.storyFilesHash must equal the floor storyFilesHash',
    );

    // CHK-003:happy:1 — review_escalation_policy_set binds the floor materialHash DIRECTLY.
    const policyResult = handlers.review_escalation_policy_set({
      storyId: STORE_STORY_ID,
      policyVersion: 'v1',
      sourcePolicyRef: 'docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md',
      rolloutStage: 'ga',
      riskClass: 'high',
      degradedFallbackAllowed: true,
      json: true,
    }) as { report: { materialHash: string | null } };
    assert.equal(
      policyResult.report.materialHash,
      floorMaterial,
      'STORE F-001 (CHK-003:happy:1): review_escalation_policy_set report.materialHash must equal the floor materialHash',
    );

    // CHK-003:happy:2 — review_escalation_fallback_set binds the floor materialHash DIRECTLY.
    const fallbackResult = handlers.review_escalation_fallback_set({
      storyId: STORE_STORY_ID,
      eligibility: 'single-host-environment',
      reason: 'single-host smoke fixture exercising the gitCwd-aware fallback freshness probe',
      evidenceRefs: ['smoke-evidence'],
      json: true,
    }) as { report: { materialHash: string | null } };
    assert.equal(
      fallbackResult.report.materialHash,
      floorMaterial,
      'STORE F-001 (CHK-003:happy:2): review_escalation_fallback_set report.materialHash must equal the floor materialHash',
    );

    // ── (4) MACHINE GUARDS (F-002): DIRECT wrapper-root runtime invocation ──
    const context = { storyId: STORE_STORY_ID, store, projectRoot: metaRoot, gitCwd: gitRoot };

    // (a) canFinishGuard escalation call site (~639) under wrapper-root: no throw.
    const canFinish = canFinishGuard(context);
    assert.equal(
      typeof canFinish,
      'boolean',
      `STORE F-002: canFinishGuard must return a boolean under wrapper-root (got ${typeof canFinish})`,
    );

    // (b) getGuardFailureReason escalation call site (~1145) under wrapper-root: no throw.
    const reason = getGuardFailureReason(STORE_STORY_ID, store, 'DONE', metaRoot, gitRoot);
    assert.ok(
      reason === null || typeof reason === 'string',
      `STORE F-002: getGuardFailureReason must return null or a string under wrapper-root (got ${typeof reason})`,
    );

    // (c) CHK-002:happy:1/2 — the EXACT machine.ts gitCwd expression feeds the floor
    //     material/story-files hashes into the evaluator.
    const machineGitCwd = context.gitCwd ?? resolveGitCwd({
      store,
      storyId: STORE_STORY_ID,
      metadataRoot: metaRoot,
      projectRoot: metaRoot,
    });
    const escViaMachineExpr = evaluateReviewEscalation({
      projectRoot: metaRoot,
      gitCwd: machineGitCwd,
      store,
      storyId: STORE_STORY_ID,
    });
    assert.equal(
      escViaMachineExpr.materialHash,
      floorMaterial,
      'STORE F-002 (CHK-002:happy:1): evaluateReviewEscalation via the machine.ts gitCwd expression must yield the floor materialHash',
    );
    assert.equal(
      escViaMachineExpr.storyFilesHash,
      floorStory,
      'STORE F-002 (CHK-002:happy:2): evaluateReviewEscalation via the machine.ts gitCwd expression must yield the floor storyFilesHash',
    );

    // ── (5) RED control for the store fixture: no gitCwd defaults to the non-git
    //        metaRoot -> null materialHash, disagreeing with the floor. ──
    const escNoGit = evaluateReviewEscalation({
      projectRoot: metaRoot,
      store,
      storyId: STORE_STORY_ID,
    });
    assert.equal(
      escNoGit.materialHash,
      null,
      `STORE RED: omitting gitCwd (defaults to non-git metaRoot) must yield materialHash null ` +
        `(got ${JSON.stringify(escNoGit.materialHash)})`,
    );
    assert.notEqual(
      escNoGit.materialHash,
      floorMaterial,
      'STORE RED: the no-gitCwd escalation hash must DIFFER from the floor hash',
    );
  } finally {
    rmSync(metaRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('review-escalation freshness-root smoke passed');
