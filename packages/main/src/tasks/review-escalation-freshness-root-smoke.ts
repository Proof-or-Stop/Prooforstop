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
 * B-36ba REVIEW F-001 adds a third case:
 *   WRAPPER-ROOT (real StoryStore: handlers):
 *     The first two cases drive the evaluator with synthetic story/findings args.
 *     Finding F-001 requires DIRECT wrapper-root RUNTIME invocation of the three
 *     review_escalation_* handlers (CHK-003:happy:0/1/2), proving the resolveGitCwd
 *     -> evaluator path computes the REAL gitRoot hashes — not the bare non-git
 *     metadataRoot — through the exact production wiring.
 *       - resolveGitCwd(store, storyId, metaRoot, metaRoot) === gitRoot (!= metaRoot).
 *         This is the single resolution all three handlers share.
 *       - HANDLERS (F-001): review_escalation_status / _policy_set / _fallback_set
 *         each report report.materialHash === the floor materialHash.
 *       - RED control: the evaluator with NO gitCwd (defaults to the non-git
 *         metaRoot) yields a null materialHash that differs from the floor.
 *
 * B-36ba REVIEW F-003 (Codex host-2) adds a fourth, GENUINE-guard case:
 *   WRAPPER-ROOT DONE-ready (DONE gate genuinely depends on escalation gitCwd):
 *     F-003 observed that the old third case's machine coverage was NOT a real
 *     regression guard — canFinishGuard / getGuardFailureReason returned EARLY (the
 *     test-evidence / delivery-check / escalation-policy gates failed before the
 *     evaluateReviewEscalation call sites at machine.ts:639/1145), and the
 *     `escViaMachineExpr` block tested a COPY of the gitCwd expression. Reverting
 *     machine.ts:639/1145 would NOT have failed the smoke.
 *
 *     This case builds a FULLY DONE-ready wrapper-root fixture (test-evidence PASS,
 *     no bugs, signed delivery-check, an explicit valid high-risk policy that makes
 *     escalation REQUIRED, and 3 rounds x 2 independent host PASS verdicts bound to
 *     the resolved-gitCwd materialHash/storyFilesHash). With every preceding gate
 *     satisfied, the DONE verdict GENUINELY DEPENDS on the escalation call sites
 *     reading the correct gitCwd:
 *       - GREEN (gitCwd = inner gitRoot): evaluateReviewEscalation required && ok;
 *         canFinishGuard === true (machine.ts:639); getGuardFailureReason === null
 *         (machine.ts:1145); the done-oracle review-escalation row === 'pass'
 *         (done-oracle.ts:751).
 *       - RED (gitCwd = the non-git metaRoot, i.e. the pre-fix behavior): escalation
 *         computes its freshness from the non-git root -> null materialHash ->
 *         required-but-not-ok -> the done-oracle review-escalation row === 'fail'.
 *     Reverting any of machine.ts:639 / machine.ts:1145 / done-oracle.ts:751 to drop
 *     the gitCwd plumbing makes escalation compute from the non-git metadataRoot at
 *     that call site, flipping the corresponding GREEN assertion to a failure — so
 *     these assertions are a TRUE regression guard for the three production call sites.
 *
 * On success prints `review-escalation freshness-root smoke passed`; any assert
 * failure throws -> exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  evaluateReviewEscalation,
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
} from '../core/review-escalation.js';
import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createReviewEscalationHandlers } from '../handlers/review-escalation.js';
import type { HandlerContext } from '../handlers/context.js';
import { canFinishGuard, getGuardFailureReason } from '../core/machine.js';
import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { realpathSync } from 'node:fs';
import type {
  ChecklistData,
  ClosingSelfCheck,
  DocsPromise,
  ProcessEvent,
  RealMachineTest,
  StoryInfo,
} from '../core/types.js';

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
// WRAPPER-ROOT (real StoryStore: handlers) — B-36ba F-001.
//
// DIRECT wrapper-root RUNTIME coverage: drive the three review_escalation_*
// handlers over a real StoryStore on a wrapper-root layout (non-git metadataRoot
// + inner gitRoot subdir), proving the resolveGitCwd -> evaluator path computes
// the REAL gitRoot hashes through the exact production wiring (not a synthetic
// evaluator call). The machine.ts:639/1145 + done-oracle.ts:751 escalation call
// sites are exercised as GENUINE regression guards by the DONE-ready case below
// (F-003), where the DONE gate's verdict depends on escalation reading gitCwd.
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
      eligibility: 'explicit-human-approval',
      reason: 'explicit human approval smoke fixture exercising the gitCwd-aware fallback freshness probe',
      evidenceRefs: ['smoke-evidence'],
      approvalRef: 'smoke-approval:wrapper-root',
      json: true,
    }) as { report: { materialHash: string | null } };
    assert.equal(
      fallbackResult.report.materialHash,
      floorMaterial,
      'STORE F-001 (CHK-003:happy:2): review_escalation_fallback_set report.materialHash must equal the floor materialHash',
    );

    // ── (4) MACHINE call sites: covered by the DONE-ready case below ──
    // B-36ba REVIEW F-003 (Codex host-2): the previous weak machine coverage here
    // (canFinishGuard/getGuardFailureReason no-throw checks + an `escViaMachineExpr`
    // COPY of the machine.ts gitCwd expression) was NOT a genuine regression guard.
    // canFinishGuard/getGuardFailureReason returned EARLY (this fixture lacks the
    // test-evidence/delivery-check/escalation-policy gates that precede the
    // evaluateReviewEscalation call sites), so reverting machine.ts:639/1145 would
    // NOT have failed those no-throw assertions; and `escViaMachineExpr` re-derived
    // the gitCwd expression in the test rather than exercising the production call.
    // The genuine machine.ts:639/1145 + done-oracle.ts:751 guard is the
    // DONE-ready wrapper-root case at the bottom of this file, where the DONE gate
    // GENUINELY DEPENDS on escalation reading the resolved gitCwd.

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

// ════════════════════════════════════════════════════════════════════════════
// WRAPPER-ROOT DONE-ready: DONE gate genuinely depends on escalation gitCwd
// — B-36ba REVIEW F-003 (Codex host-2).
//
// WHY THIS IS A GENUINE GUARD (and the old machine coverage was not):
//   The three production escalation call sites — machine.ts:639 (canFinishGuard),
//   machine.ts:1145 (getGuardFailureReason DONE branch), and done-oracle.ts:751
//   (the `review-escalation` DONE-checklist row) — each call
//   evaluateReviewEscalation with `gitCwd: context.gitCwd ?? resolveGitCwd(...)`.
//   On a wrapper-root layout (projectRoot/metadataRoot is a bare NON-git wrapper;
//   the real repo lives in a configured gitRoot subdir), evaluateReviewEscalation
//   recomputes its freshness materialHash from that gitCwd. If the gitCwd plumbing
//   is reverted, escalation reads from the non-git metadataRoot -> currentMaterialHash
//   returns null -> the escalation is `required` (via the explicit high-risk policy)
//   but NOT `ok` (current material hash unavailable). That makes:
//     - canFinishGuard -> false,
//     - getGuardFailureReason('DONE') -> non-null,
//     - the done-oracle `review-escalation` row -> status 'fail'.
//   This fixture pre-satisfies EVERY gate that precedes those escalation calls
//   (test-evidence PASS, no open bugs, signed+fresh delivery-check, empty/verified
//   docsPromises, and the review-assurance-floor via the same 3x2 verdicts) so the
//   ONLY thing standing between the fixture and a passing DONE verdict is the
//   escalation call reading the correct gitCwd. Reverting machine.ts:639/1145 or
//   done-oracle.ts:751 therefore FLIPS the matching GREEN assertion to a failure.
//   The RED control (calling buildDoneChecklist with gitCwd = the non-git metaRoot)
//   reproduces the pre-fix behavior and asserts SPECIFICALLY on the review-escalation
//   row, isolating the escalation gitCwd dependency from every other DONE row.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const metaRoot = mkdtempSync(join(tmpdir(), 'review-escalation-freshness-done-'));
  const DONE_STORY_ID = 'B-36ba-done';
  try {
    // metaRoot is deliberately NOT a git repo. gitRoot:'repo' drives resolveGitCwd's
    // configured-git-root branch (the story has NO worktree binding).
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

    // Inner git repo on a NON-story/* branch ('work') so handler autoCommit is a
    // silent no-op — mirrors the third case and reuses buildInnerRepo's shape.
    const gitRoot = join(metaRoot, 'repo');
    mkdirSync(gitRoot, { recursive: true });
    git(gitRoot, ['init']);
    git(gitRoot, ['config', 'user.email', 'smoke@example.invalid']);
    git(gitRoot, ['config', 'user.name', 'Freshness Root DONE Smoke']);
    git(gitRoot, ['checkout', '-B', 'main']);
    write(gitRoot, 'README.md', '# freshness root done smoke inner repo\n');
    write(gitRoot, 'packages/main/src/seed.ts', 'export const seed = 1;\n');
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'seed']);
    git(gitRoot, ['checkout', '-B', 'work']);
    // A material (non-metadata) source file diffed against main -> storyFilesHash is
    // non-empty and materialHash is defined (so escalation/floor are both "required").
    write(gitRoot, 'packages/main/src/foo.ts', 'export const foo = 1;\n');
    git(gitRoot, ['add', '.']);
    git(gitRoot, ['commit', '-m', 'material code file']);

    const store = new StoryStore(metaRoot);
    const now = '2026-06-24T00:00:00.000Z';

    // Freshness anchors computed from the RESOLVED gitCwd (the inner gitRoot) with
    // metaRoot as the metadata root — the SAME shape the DONE gates use.
    const materialHash = currentMaterialHash(gitRoot, 'HEAD', metaRoot)!;
    const storyFilesHash = currentStoryFilesHash(gitRoot, 'HEAD', metaRoot)!;
    const headHash = currentGitHead(gitRoot)!;
    assert.ok(materialHash, 'DONE: currentMaterialHash(gitRoot, HEAD, metaRoot) must be defined');
    assert.ok(storyFilesHash, 'DONE: currentStoryFilesHash(gitRoot, HEAD, metaRoot) must be defined');
    assert.ok(headHash, 'DONE: currentGitHead(gitRoot) must be defined');

    // ── TEST-phase story with NO worktree binding -> resolveGitCwd uses the
    //    configured-git-root branch (the inner gitRoot subdir). ──
    const doneStory: StoryInfo = {
      storyId: DONE_STORY_ID,
      name: 'wrapper-root-done-fixture',
      title: 'Wrapper root DONE-ready fixture story',
      description: 'DONE-ready wrapper-root fixture: the DONE gate depends on escalation gitCwd.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      // NO worktree binding -> configured-git-root branch resolves to the subdir.
    };
    store.writeStory(DONE_STORY_ID, doneStory);
    store.writeChecklist(DONE_STORY_ID, {
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
          note: 'synthetic proof for review-escalation freshness-root DONE smoke',
        }],
      }],
    } as ChecklistData);

    // ── test-evidence + delivery-check seeding modeled on lifecycle-check-smoke ──
    store.writeTestEvidence(DONE_STORY_ID, {
      command: 'review-escalation-freshness-root-done-smoke',
      output: JSON.stringify({ allPass: true, summary: 'done-ready wrapper-root fixture' }),
      result: 'PASS',
      timestamp: now,
      headHash,
      materialHash,
      storyFilesHash,
      verificationCoverage: {
        total: 1,
        required: 1,
        covered: 1,
        missingRequired: 0,
        entries: [],
      },
    });
    store.writeBugs(DONE_STORY_ID, { bugs: [] });

    const docsPromises: DocsPromise[] = [];
    const realMachineTests: RealMachineTest[] = [{
      featureId: 'CHK-001',
      transcript: 'done-ready wrapper-root fixture has synthetic real-machine coverage.',
    }];
    const closingSelfCheck: ClosingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'done-ready wrapper-root fixture closure evidence is complete.',
    };
    store.writeDeliveryCheck(DONE_STORY_ID, {
      storyId: DONE_STORY_ID,
      checkedAt: now,
      headHash,
      materialHash,
      reviewRound: '',
      agentId: 'lattice-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(DONE_STORY_ID, docsPromises, realMachineTests, closingSelfCheck, '', materialHash),
    });

    // ── Make escalation REQUIRED via an explicit valid high-risk policy event.
    //    All fields below are required by policyRecordFromEvent for validity:
    //    requires3x2=true, the exact predicate, policyVersion, riskClass (or
    //    milestoneId), sourcePolicyRef, rolloutStage, boolean degradedFallbackAllowed,
    //    issuer, issuedAt, and a materialHash bound to the current (gitCwd) hash. ──
    const policyEvent: Omit<ProcessEvent, 'timestamp'> = {
      type: 'review_escalation_policy',
      storyId: DONE_STORY_ID,
      command: 'review_escalation_policy_set',
      policyId: `${DONE_STORY_ID}:POL-1`,
      predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
      requires3x2: true,
      policyVersion: 'v1',
      riskClass: 'high',
      sourcePolicyRef: 'docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md',
      rolloutStage: 'ga',
      degradedFallbackAllowed: false,
      issuer: 'smoke',
      issuedAt: now,
      headHash,
      materialHash,
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
    };
    store.appendProcessEvent(DONE_STORY_ID, policyEvent);

    // ── Seed 3 rounds x 2 INDEPENDENT host PASS verdicts bound to the SAME
    //    materialHash + storyFilesHash (the resolved-gitCwd hashes). Each round needs
    //    two hosts with distinct host/session/key identities; materialDigest must
    //    equal materialHash exactly or the round fails closed. ──
    for (const runId of ['round-1', 'round-2', 'round-3']) {
      const hosts = [
        { hostId: `claude-${runId}`, provider: 'claude', sessionId: `claude-${runId}-session`, keyId: `claude-${runId}-key` },
        { hostId: `codex-${runId}`, provider: 'codex', sessionId: `codex-${runId}-session`, keyId: `codex-${runId}-key` },
      ];
      for (const host of hosts) {
        const verdictEvent: Omit<ProcessEvent, 'timestamp'> = {
          type: 'host_verdict',
          verdictId: `${runId}-${host.hostId}`,
          runId,
          hostId: host.hostId,
          provider: host.provider,
          sessionId: host.sessionId,
          keyId: host.keyId,
          decision: 'pass',
          materialDigest: materialHash,
          storyFilesHash,
          validationDigest: `validation-${runId}`,
          promptDigest: `prompt-${runId}`,
        };
        store.appendProcessEvent(DONE_STORY_ID, verdictEvent);
      }
    }

    // ── GREEN: escalation required && ok under the RESOLVED gitCwd. ──
    const escReq = evaluateReviewEscalation({
      projectRoot: metaRoot,
      gitCwd: gitRoot,
      store,
      storyId: DONE_STORY_ID,
    });
    assert.equal(
      escReq.required,
      true,
      'DONE: escalation must be required via the explicit high-risk policy',
    );
    assert.equal(
      escReq.ok,
      true,
      'DONE: escalation must be satisfied by the 3x2 verdicts under the correct gitCwd',
    );

    // ── GREEN machine.ts:639 — canFinishGuard PASSES under wrapper-root with the
    //    resolved gitCwd. Reverting the escalation gitCwd plumbing makes escalation
    //    read the non-git metaRoot -> null materialHash -> required-but-not-ok ->
    //    this flips to false. ──
    const greenCtx = { storyId: DONE_STORY_ID, store, projectRoot: metaRoot, gitCwd: gitRoot };
    const greenCanFinish = canFinishGuard(greenCtx);
    if (!greenCanFinish) {
      // DEBUG aid (F-003 guidance): surface which DONE gate actually fails so a
      // fixture-seeding gap is distinguishable from a genuine regression.
      console.error(
        'DONE GREEN DEBUG: getGuardFailureReason =',
        getGuardFailureReason(DONE_STORY_ID, store, 'DONE', metaRoot, gitRoot),
      );
    }
    assert.equal(
      greenCanFinish,
      true,
      'machine.ts:639 — canFinishGuard must PASS under wrapper-root with resolved gitCwd; ' +
        'reverting the escalation gitCwd plumbing makes escalation read the non-git metaRoot -> null materialHash -> this fails',
    );

    // ── GREEN machine.ts:1145 — getGuardFailureReason('DONE') is null with the
    //    resolved gitCwd. ──
    assert.equal(
      getGuardFailureReason(DONE_STORY_ID, store, 'DONE', metaRoot, gitRoot),
      null,
      'machine.ts:1145 — getGuardFailureReason must be null with resolved gitCwd',
    );

    // ── GREEN done-oracle.ts:751 — the review-escalation DONE row PASSES with the
    //    resolved gitCwd. ──
    const greenRows: DoneCheckRow[] = buildDoneChecklist(DONE_STORY_ID, store, metaRoot, {
      auditWriter: null,
      gitCwd: gitRoot,
    });
    const greenEsc = greenRows.find(r => r.id === 'review-escalation');
    assert.ok(greenEsc, 'DONE: done-oracle must produce a review-escalation row');
    assert.equal(
      greenEsc.status,
      'pass',
      'done-oracle.ts:751 — review-escalation row must PASS with resolved gitCwd',
    );

    // ── RED done-oracle.ts:751 — passing the WRONG (non-git metaRoot) gitCwd
    //    simulates the pre-fix behavior: escalation computes its freshness from the
    //    non-git metadataRoot -> null materialHash -> required-but-not-ok -> the
    //    review-escalation row FAILS. Asserting specifically on this row ISOLATES the
    //    escalation gitCwd dependency (only this row depends on the materialHash being
    //    computable). ──
    const redRows: DoneCheckRow[] = buildDoneChecklist(DONE_STORY_ID, store, metaRoot, {
      auditWriter: null,
      gitCwd: metaRoot,
    });
    const redEsc = redRows.find(r => r.id === 'review-escalation');
    assert.ok(redEsc, 'DONE RED: done-oracle must produce a review-escalation row');
    assert.equal(
      redEsc.status,
      'fail',
      'DONE RED: review-escalation row must FAIL when escalation reads the wrong (non-git) root ' +
        '— isolates the escalation gitCwd dependency',
    );
  } finally {
    rmSync(metaRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('review-escalation freshness-root smoke passed');
