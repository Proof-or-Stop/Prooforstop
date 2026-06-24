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
import type { StoryInfo } from '../core/types.js';

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

console.log('review-escalation freshness-root smoke passed');
