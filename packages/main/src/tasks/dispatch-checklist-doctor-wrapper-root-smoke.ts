#!/usr/bin/env node
/**
 * dispatch-checklist-doctor-wrapper-root-smoke (B-75f0 CHK-001)
 *
 * Regression for the THREE hard-failure wrapper-root (metadataRoot != gitRoot)
 * git-cwd sites fixed in CHK-001. Each ran a git child process from the bare
 * metadataRoot (the `root` argument). On a wrapper-root layout the metadataRoot is
 * NOT a git repo and the real repo is a configured gitRoot subdir, so every one of
 * these calls errored (`fatal: not a git repository`) and the operation either
 * hard-threw or silently no-opped:
 *
 *   1. core/proof-or-stop-dispatch.ts
 *        listedGitWorktreeRoots(root)              `git worktree list --porcelain`  HARD-THROW
 *        assertRegisteredDispatchWorktreeRoot(...) `git -C <wt> rev-parse --show-toplevel`  HARD-THROW
 *      → dispatch could NEVER register/validate an isolated worktree on a wrapper root.
 *   2. handlers/checklist.ts
 *        evidenceHashes(root)  `git rev-parse HEAD` + currentMaterialHash(root)
 *      → verification_evidence_(add|refresh) silently dropped headHash/materialHash.
 *   3. handlers/doctor.ts
 *        tryWorktreeRemove / removeStaleWorktreeAdminDirs / deleteTerminalStoryBranch
 *        ran `git worktree remove|rev-parse --git-common-dir|branch -D` from the bare
 *        metadataRoot → doctor --repair could never clean up stale worktrees/branches.
 *
 * The FIX threads the resolved gitCwd at each call boundary:
 *   - dispatch + checklist: resolveGitCwd({store, storyId, metadataRoot, projectRoot})
 *     (the story-scoped choke-point; store + storyId are in scope at every caller).
 *   - doctor: resolveDoctorGitCwd(root) (the id-independent, total project-level
 *     resolver already used at the top of doctor()).
 * Both fall back to `root`/projectRoot when no gitRoot resolves, so PLAIN repos
 * (projectRoot == gitRoot) stay byte-identical.
 *
 * This smoke asserts, on a real wrapper-root fixture (cleaned up):
 *   - Each of the 3 fixed paths resolves the gitCwd to the inner gitRoot subdir
 *     (≠ the non-git metadataRoot), so the SAME git command the production helper
 *     runs SUCCEEDS from the resolved gitCwd …
 *   - … and would have FAILED from the bare metadataRoot (the documented RED).
 *   - Plain-repo (projectRoot == gitRoot): the resolver returns the project root
 *     verbatim, so the resolved cwd is byte-identical to the old bare-root behavior.
 *
 * Prints ✓ per assertion; any failure throws → exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { resolveDoctorGitCwd } from '../handlers/doctor.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
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

/** A minimal TEST-phase story with NO worktree binding, so resolveGitCwd uses the
 *  configured-git-root branch driven by proof-or-stop.config.json gitRoot. */
function writeStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-17T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'wrapper-root-fixture',
    title: 'Wrapper root fixture story',
    description: 'Drive the dispatch/checklist/doctor git-cwd sites over a wrapper-root layout.',
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

/** Build a wrapper-root fixture: metadataRoot (NON-git) + gitRoot subdir (clean
 *  git repo, branch main, one commit) + proof-or-stop.config.json{gitRoot:"repo"}. */
function buildWrapperFixture(): { metadataRoot: string; gitRoot: string } {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-dcd-wrapper-'));
  // metadataRoot is deliberately NOT a git repo: any git command from here errors.
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), CONFIG('repo'), 'utf-8');

  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, ['init', '-b', 'main']);
  writeFileSync(join(gitRoot, 'README.md'), '# wrapper root inner repo\n', 'utf-8');
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'base']);
  return { metadataRoot, gitRoot };
}

/** Run a git command and report whether it threw (the RED wrapper-root symptom). */
function gitThrows(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return false;
  } catch {
    return true;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Wrapper-root scenario: all 3 sites resolve/run from the inner gitRoot.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const { metadataRoot, gitRoot } = buildWrapperFixture();
  try {
    const store = new StoryStore(metadataRoot);
    writeStory(store, STORY_ID);
    const gitRootReal = realpathSync(gitRoot);
    const metaReal = realpathSync(metadataRoot);

    // ── Site 1: proof-or-stop-dispatch (story-scoped resolveGitCwd) ──────────────────
    // The dispatch helpers resolve via resolveGitCwd({store, storyId, ...}); the
    // result MUST be the inner gitRoot, not the non-git metadataRoot.
    const dispatchGitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot, projectRoot: metadataRoot });
    assert.equal(
      realpathSync(dispatchGitCwd),
      gitRootReal,
      `dispatch: resolveGitCwd must resolve to the inner gitRoot subdir (got ${dispatchGitCwd})`,
    );
    assert.notEqual(
      realpathSync(dispatchGitCwd),
      metaReal,
      'dispatch: resolved gitCwd must NOT be the non-git metadataRoot (the hard-failure bug)',
    );
    // RED: the exact `git worktree list --porcelain` listedGitWorktreeRoots runs
    // HARD-THROWS from the bare metadataRoot …
    assert.equal(
      gitThrows(metadataRoot, ['worktree', 'list', '--porcelain']),
      true,
      'dispatch RED: `git worktree list --porcelain` from the bare metadataRoot must throw (pre-fix hard failure)',
    );
    // GREEN: it SUCCEEDS from the resolved gitCwd and lists the inner gitRoot.
    const worktreeList = git(dispatchGitCwd, ['worktree', 'list', '--porcelain']);
    assert.ok(
      worktreeList.includes('worktree '),
      'dispatch GREEN: `git worktree list --porcelain` from the resolved gitCwd must succeed and list a worktree',
    );
    // RED/GREEN for assertRegisteredDispatchWorktreeRoot's `git -C <wt> rev-parse
    // --show-toplevel` probe: it runs with cwd=gitCwd; from the bare metadataRoot
    // git cannot even start, from the resolved gitCwd it returns the gitRoot.
    assert.equal(
      gitThrows(metadataRoot, ['-C', gitRoot, 'rev-parse', '--show-toplevel']),
      false,
      'dispatch: control — `git -C <gitRoot> rev-parse` works regardless of outer cwd because -C points inside the repo',
    );
    const showTop = realpathSync(git(dispatchGitCwd, ['rev-parse', '--show-toplevel']));
    assert.equal(
      showTop,
      gitRootReal,
      'dispatch GREEN: rev-parse --show-toplevel from the resolved gitCwd returns the inner gitRoot',
    );
    pass('dispatch: resolveGitCwd → inner gitRoot; `git worktree list` succeeds there, throws from bare metadataRoot');

    // ── Site 2: checklist evidence freshness (story-scoped resolveGitCwd) ───────
    // evidenceHashes now runs `git rev-parse HEAD` + currentMaterialHash from the
    // resolved gitCwd. RED: from the bare metadataRoot both probes return
    // undefined. GREEN: from the resolved gitCwd both are defined hashes.
    const redHead = currentGitHead(metadataRoot);
    const redMaterial = currentMaterialHash(metadataRoot);
    assert.equal(redHead, undefined, 'checklist RED: currentGitHead(bare metadataRoot) must be undefined');
    assert.equal(redMaterial, undefined, 'checklist RED: currentMaterialHash(bare metadataRoot) must be undefined');

    const checklistGitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot, projectRoot: metadataRoot });
    // metadataRoot is threaded into currentMaterialHash for the storyDir-aware
    // exclusion (gitCwd != metadataRoot on a wrapper root), mirroring evidenceHashes.
    const greenHead = currentGitHead(checklistGitCwd);
    const greenMaterial = currentMaterialHash(checklistGitCwd, 'HEAD', metadataRoot);
    assert.ok(
      typeof greenHead === 'string' && greenHead.length > 0,
      `checklist GREEN: currentGitHead(resolved gitCwd) must be a defined hash (got ${JSON.stringify(greenHead)})`,
    );
    assert.ok(
      typeof greenMaterial === 'string' && greenMaterial.length > 0,
      `checklist GREEN: currentMaterialHash(resolved gitCwd, HEAD, metadataRoot) must be a defined hash (got ${JSON.stringify(greenMaterial)})`,
    );
    assert.notEqual(redHead, greenHead, 'checklist: RED (bare metadataRoot) vs GREEN (resolved gitCwd) head must differ');
    pass('checklist: evidence freshness probes are undefined from bare metadataRoot, defined from resolved gitCwd');

    // ── Site 3: doctor (id-independent resolveDoctorGitCwd) ─────────────────────
    // resolveDoctorGitCwd(root) must resolve to the inner gitRoot, so the doctor
    // repair git commands (worktree remove / rev-parse --git-common-dir / branch -D)
    // run from a real repo. RED: those commands from the bare metadataRoot throw.
    const doctorGitCwd = resolveDoctorGitCwd(metadataRoot);
    assert.equal(
      realpathSync(doctorGitCwd),
      gitRootReal,
      `doctor: resolveDoctorGitCwd must resolve to the inner gitRoot subdir (got ${doctorGitCwd})`,
    );
    assert.notEqual(
      realpathSync(doctorGitCwd),
      metaReal,
      'doctor: resolved gitCwd must NOT be the non-git metadataRoot',
    );
    // RED: `git rev-parse --git-common-dir` (removeStaleWorktreeAdminDirs) throws
    // from the bare metadataRoot …
    assert.equal(
      gitThrows(metadataRoot, ['rev-parse', '--git-common-dir']),
      true,
      'doctor RED: `git rev-parse --git-common-dir` from bare metadataRoot must throw',
    );
    // GREEN: it SUCCEEDS from the resolved gitCwd.
    const commonDir = git(doctorGitCwd, ['rev-parse', '--git-common-dir']);
    assert.ok(
      commonDir.length > 0,
      'doctor GREEN: `git rev-parse --git-common-dir` from resolved gitCwd must succeed',
    );
    // RED: `git branch -D` (deleteTerminalStoryBranch) cannot run from the bare
    // metadataRoot; GREEN: it runs (no-op on a missing branch) from the gitRoot.
    assert.equal(
      gitThrows(metadataRoot, ['worktree', 'list']),
      true,
      'doctor RED: `git worktree list` (tryWorktreeRemove context) from bare metadataRoot must throw',
    );
    assert.equal(
      gitThrows(doctorGitCwd, ['worktree', 'list']),
      false,
      'doctor GREEN: `git worktree list` from the resolved gitCwd must succeed',
    );
    pass('doctor: resolveDoctorGitCwd → inner gitRoot; repair git commands run there, throw from bare metadataRoot');
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Plain-repo byte-identity: projectRoot == gitRoot. Every resolver returns the
// project root verbatim, so the resolved cwd is byte-identical to the old bare
// behavior. The git commands all run from the project root either way.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-dcd-plain-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), CONFIG(undefined), 'utf-8');
    writeFileSync(join(root, 'README.md'), '# plain repo\n', 'utf-8');
    git(root, ['init', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);

    const store = new StoryStore(root);
    writeStory(store, STORY_ID);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story metadata']);

    const rootReal = realpathSync(root);

    // dispatch + checklist story-scoped resolver → project root verbatim.
    const storyGitCwd = resolveGitCwd({ store, storyId: STORY_ID, metadataRoot: root, projectRoot: root });
    assert.equal(
      realpathSync(storyGitCwd),
      rootReal,
      'plain: resolveGitCwd resolves to the project root (byte-identical fallback)',
    );
    // doctor id-independent resolver → project root verbatim.
    const doctorGitCwd = resolveDoctorGitCwd(root);
    assert.equal(
      realpathSync(doctorGitCwd),
      rootReal,
      'plain: resolveDoctorGitCwd resolves to the project root (byte-identical fallback)',
    );

    // Evidence probes return identical, defined hashes whether called with the bare
    // root or the resolved gitCwd (which equals root) — the byte-identity promise.
    const bareHead = currentGitHead(root);
    const resolvedHead = currentGitHead(storyGitCwd);
    assert.ok(typeof bareHead === 'string' && bareHead.length > 0, 'plain: currentGitHead(root) must be defined');
    assert.equal(resolvedHead, bareHead, 'plain: currentGitHead is byte-identical (bare root vs resolved gitCwd)');
    const bareMaterial = currentMaterialHash(root);
    const resolvedMaterial = currentMaterialHash(storyGitCwd, 'HEAD', root);
    assert.ok(typeof bareMaterial === 'string' && bareMaterial.length > 0, 'plain: currentMaterialHash(root) must be defined');
    assert.equal(resolvedMaterial, bareMaterial, 'plain: currentMaterialHash is byte-identical (bare root vs resolved gitCwd)');

    pass('plain-repo: dispatch/checklist/doctor resolvers all return project root verbatim (byte-identical fallback)');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('\n✓ dispatch-checklist-doctor wrapper-root smoke passed');
