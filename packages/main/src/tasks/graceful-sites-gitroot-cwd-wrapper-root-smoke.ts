#!/usr/bin/env node
/**
 * graceful-sites-gitroot-cwd-wrapper-root-smoke (B-75f0 CHK-002)
 *
 * Wrapper-root (metadataRoot != gitRoot) coverage for the storyId-bearing
 * graceful-degradation git-cwd sites threaded in CHK-002. Unlike CHK-001's three
 * HARD-FAILURE sites, these sites already degraded gracefully (returned
 * undefined / null / [] / 'unknown') when git ran from the bare non-git
 * metadataRoot — so the wrapper-root bug was SILENT: the site returned the
 * degraded fallback (no head hash, no docs touchpoints) instead of the REAL value
 * the inner gitRoot would have produced. The fix threads a resolved gitCwd so the
 * site surveys the actual repo, while PRESERVING the same graceful fallback when
 * no gitRoot resolves.
 *
 * Sites covered here (the three that have a real storyId at the caller, so they
 * use the id-keyed resolveGitCwd):
 *
 *   1. handlers/verifier.ts — currentHead(gitCwd) `git rev-parse HEAD`
 *      callers decorateStoryVerification / persistStoryValidationEvidence /
 *      evaluateValidationAuthorityGate / the validate handler resolve
 *      resolveGitCwd({store, storyId, ...}); the `undefined` fallback is preserved.
 *   2. core/touchpoints-fallback.ts — detectMdTouchpointsFromGit(root)
 *      `git diff main...HEAD --name-only` (drives docs-reviewer routing). It is a
 *      single shared helper called from many id-less contexts, so it resolves the
 *      gitCwd id-independently INSIDE the helper from `root`; the `undefined`
 *      fallback is preserved. This smoke exercises the exported helper directly.
 *   3. handlers/init-check.ts — init_check_repair audit block `git rev-parse HEAD`
 *      resolves resolveGitCwd({store, storyId: args.storyId, ...}); the
 *      omit-headHash-on-failure behavior is preserved.
 *
 * For (1) and (3) the git reader is module-private (currentHead / the inline
 * audit probe), so this smoke asserts the production wiring: resolveGitCwd
 * resolves to the inner gitRoot, the SAME `git rev-parse HEAD` the helper runs
 * SUCCEEDS from the resolved gitCwd (defined hash), and the bare metadataRoot
 * yields the preserved graceful fallback (undefined). For (2) the helper is
 * exported, so this smoke drives the REAL function end-to-end.
 *
 * Asserts on a real wrapper-root fixture (cleaned up):
 *   - resolveGitCwd → inner gitRoot subdir (≠ the non-git metadataRoot).
 *   - The site's git read returns the REAL value from the resolved gitCwd …
 *   - … and the preserved graceful fallback (undefined) from the bare metadataRoot.
 * And on a plain repo (projectRoot == gitRoot): the resolver returns the project
 * root verbatim, so every read is byte-identical to the old bare-root behavior.
 *
 * Prints ✓ per assertion; any failure throws → exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-75f0';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.com',
      GIT_COMMITTER_NAME: 'smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.com',
    },
  }).toString().trim();
}

/** Mirror handlers/verifier.ts currentHead + handlers/init-check.ts audit probe:
 *  `git rev-parse HEAD`, with the production `undefined`-on-failure graceful
 *  fallback. The production helpers are module-private; this is the exact git
 *  read they run from the resolved gitCwd. */
function gitRevParseHead(gitCwd: string): string | undefined {
  try {
    return git(gitCwd, ['rev-parse', 'HEAD']) || undefined;
  } catch {
    return undefined;
  }
}

const CONFIG = (gitRoot: string | undefined): string =>
  JSON.stringify(
    {
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      ...(gitRoot ? { gitRoot } : {}),
      workflow: { profile: 'light' },
    },
    null,
    2,
  );

/** Minimal TEST-phase story with NO worktree binding, so resolveGitCwd uses the
 *  configured-git-root branch driven by proof-or-stop.config.json gitRoot. */
function writeStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-17T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'wrapper-root-graceful-fixture',
    title: 'Wrapper root graceful-site fixture story',
    description: 'Drive the verifier/touchpoints/init-check git-cwd sites over a wrapper-root layout.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    // NO worktree binding → configured-git-root branch resolves to the subdir.
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

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

/** Build a wrapper-root fixture: metadataRoot (NON-git) + gitRoot subdir (git
 *  repo on main with a base commit + a docs/.md change on HEAD ahead of main) +
 *  proof-or-stop.config.json{gitRoot:"repo"}. The .md-ahead-of-main change makes
 *  `git diff main...HEAD --name-only` report a real .md file. */
function buildWrapperFixture(): { metadataRoot: string; gitRoot: string } {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-graceful-wrapper-'));
  // metadataRoot is deliberately NOT a git repo: any git command from here errors.
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), CONFIG('repo'), 'utf-8');

  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, ['init', '-b', 'main']);
  writeFileSync(join(gitRoot, 'README.md'), '# wrapper root inner repo\n', 'utf-8');
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'base on main']);
  // A feature branch with a docs .md change AHEAD of main, so the touchpoints
  // `git diff main...HEAD --name-only` reports docs/guide.md.
  git(gitRoot, ['checkout', '-b', 'feature']);
  mkdirSync(join(gitRoot, 'docs'), { recursive: true });
  writeFileSync(join(gitRoot, 'docs', 'guide.md'), '# guide\n', 'utf-8');
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'add docs guide']);
  return { metadataRoot, gitRoot };
}

// ════════════════════════════════════════════════════════════════════════════
// Wrapper-root scenario: each graceful site resolves/reads from the inner gitRoot
// and degrades to its preserved fallback from the bare metadataRoot.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const { metadataRoot, gitRoot } = buildWrapperFixture();
  try {
    const store = new StoryStore(metadataRoot);
    writeStory(store, STORY_ID);
    const gitRootReal = realpathSync(gitRoot);
    const metaReal = realpathSync(metadataRoot);

    // ── Site 1 & 3: verifier currentHead + init-check repair audit (resolveGitCwd) ──
    // Both resolve resolveGitCwd({store, storyId, ...}) then run `git rev-parse
    // HEAD`. The resolved cwd MUST be the inner gitRoot, not the metadataRoot.
    const headGitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot, projectRoot: metadataRoot });
    assert.equal(
      realpathSync(headGitCwd),
      gitRootReal,
      `verifier/init-check: resolveGitCwd must resolve to the inner gitRoot subdir (got ${headGitCwd})`,
    );
    assert.notEqual(
      realpathSync(headGitCwd),
      metaReal,
      'verifier/init-check: resolved gitCwd must NOT be the non-git metadataRoot (the silent-fallback bug)',
    );
    // GRACEFUL FALLBACK preserved: `git rev-parse HEAD` from the bare metadataRoot
    // yields undefined (the documented degraded value, NOT a crash).
    assert.equal(
      gitRevParseHead(metadataRoot),
      undefined,
      'verifier/init-check graceful fallback: `git rev-parse HEAD` from the bare metadataRoot is undefined (preserved)',
    );
    // REAL value: from the resolved gitCwd it is a defined 40-char hash (the value
    // the wrapper-root layout previously LOST to the silent fallback).
    const greenHead = gitRevParseHead(headGitCwd);
    assert.ok(
      typeof greenHead === 'string' && greenHead.length === 40,
      `verifier/init-check: head hash from the resolved gitCwd must be a defined 40-char sha (got ${JSON.stringify(greenHead)})`,
    );
    pass('verifier headSha + init-check repair audit: resolveGitCwd → inner gitRoot; head defined there, undefined (preserved) from bare metadataRoot');

    // ── Site 2: touchpoints routing (id-independent, resolved inside the helper) ──
    // detectMdTouchpointsFromGit(metadataRoot) resolves the gitCwd internally and
    // runs `git diff main...HEAD --name-only` from the inner gitRoot, so it
    // reports docs/guide.md. Pre-fix it ran from the bare metadataRoot → git
    // errored → the catch returned undefined (docs reviewer silently dropped).
    const touchpoints = detectMdTouchpointsFromGit(metadataRoot);
    assert.ok(
      Array.isArray(touchpoints) && touchpoints.includes('docs/guide.md'),
      `touchpoints: detectMdTouchpointsFromGit(metadataRoot) must report docs/guide.md from the inner gitRoot (got ${JSON.stringify(touchpoints)})`,
    );
    // GRACEFUL FALLBACK preserved: a bare non-git dir with no gitRoot config →
    // resolver yields no gitRoot → ?? projectRoot → git errors → undefined.
    const bareNoGit = mkdtempSync(join(tmpdir(), 'proof-or-stop-graceful-baregit-'));
    try {
      writeFileSync(join(bareNoGit, 'proof-or-stop.config.json'), CONFIG(undefined), 'utf-8');
      assert.equal(
        detectMdTouchpointsFromGit(bareNoGit),
        undefined,
        'touchpoints graceful fallback: detectMdTouchpointsFromGit on a non-git dir with no gitRoot is undefined (preserved)',
      );
    } finally {
      rmSync(bareNoGit, { recursive: true, force: true });
    }
    pass('touchpoints: detectMdTouchpointsFromGit resolves the inner gitRoot and reports docs/guide.md; undefined (preserved) on a non-git dir');
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Plain-repo byte-identity: projectRoot == gitRoot. The resolver returns the
// project root verbatim, so every read is byte-identical to the old bare-root
// behavior.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-graceful-plain-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), CONFIG(undefined), 'utf-8');
    writeFileSync(join(root, 'README.md'), '# plain repo\n', 'utf-8');
    git(root, ['init', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base on main']);

    const store = new StoryStore(root);
    writeStory(store, STORY_ID);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story metadata']);

    const rootReal = realpathSync(root);

    // verifier/init-check story-scoped resolver → project root verbatim.
    const headGitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot: root, projectRoot: root });
    assert.equal(
      realpathSync(headGitCwd),
      rootReal,
      'plain: resolveGitCwd resolves to the project root (byte-identical fallback)',
    );
    // `git rev-parse HEAD` is byte-identical whether called from the bare root or
    // the resolved gitCwd (which equals root).
    const bareHead = gitRevParseHead(root);
    const resolvedHead = gitRevParseHead(headGitCwd);
    assert.ok(typeof bareHead === 'string' && bareHead.length === 40, 'plain: `git rev-parse HEAD`(root) must be a defined sha');
    assert.equal(resolvedHead, bareHead, 'plain: head hash is byte-identical (bare root vs resolved gitCwd)');

    // touchpoints: a docs .md change ahead of main on the plain repo is reported,
    // and the helper resolves to the same root either way.
    git(root, ['checkout', '-b', 'feature']);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guide.md'), '# guide\n', 'utf-8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'add docs guide']);
    const touchpoints = detectMdTouchpointsFromGit(root);
    assert.ok(
      Array.isArray(touchpoints) && touchpoints.includes('docs/guide.md'),
      `plain: detectMdTouchpointsFromGit(root) must report docs/guide.md (got ${JSON.stringify(touchpoints)})`,
    );

    pass('plain-repo: verifier/init-check head + touchpoints all resolve to project root verbatim (byte-identical fallback)');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('\n✓ graceful-sites wrapper-root smoke passed');
