#!/usr/bin/env node

/**
 * B-75f0 CHK-003 smoke: id-independent project-level git cwd resolution for
 * scans that have NO storyId at the call site.
 *
 * BUG CLASS: three project-level git scans defaulted their cwd to the bare
 * projectRoot / root / metadataRoot:
 *   - tasks/gap-analyze.ts        readLinkedStoryWorktreeIds  `git worktree list --porcelain`
 *   - handlers/story-query.ts     scanTerminalStoryResidues   `git status --porcelain -uall`
 *   - dashboard.ts                collectProject              `git worktree list` + `git status`
 * On a WRAPPER-ROOT layout (story-metadata root != real git root) the
 * metadataRoot is NOT a git repo and the real repo is a configured gitRoot
 * subdir, so those scans ran git from the non-git wrapper (worktree list empty /
 * dirty status blank → wrong project survey). None has a storyId in scope, so
 * the fix routes through the id-independent `resolveProjectGitCwd(metadataRoot,
 * projectRoot, config)` wrapper (over the now-exported `resolveProjectGitRoot`),
 * which bakes in the `?? projectRoot` plain-repo fallback.
 *
 * This smoke asserts the EXACT contract the three scans now rely on, on the same
 * wrapper / plain / null fixture shapes as bare-gate-gitroot-cwd-smoke:
 *   1. WRAPPER-ROOT (metadataRoot NOT git; configured gitRoot subdir IS git):
 *        resolveProjectGitRoot → the gitRoot subdir (≠ metadataRoot);
 *        resolveProjectGitCwd  → same gitRoot subdir.
 *   2. PLAIN-REPO (metadataRoot == gitRoot; no configured gitRoot subdir):
 *        resolveProjectGitCwd  → projectRoot VERBATIM (byte-identical fallback).
 *   3. NULL gitRoot (non-git metadataRoot, no configured gitRoot):
 *        resolveProjectGitRoot → null; resolveProjectGitCwd → projectRoot verbatim.
 *
 * Prints ✓/✗; exits non-zero on first failure.
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveProjectGitCwd,
  resolveProjectGitRoot,
} from '../core/story-signed-workspace-resolution.js';
import { loadConfig } from '../core/config.js';

const STORY_DIR_REL = '.proof-or-stop/story/actives';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git('init -b main', dir);
  git('config user.email smoke@test.local', dir);
  git('config user.name smoke', dir);
  git('config commit.gpgsign false', dir);
}

/** proof-or-stop.config.json so the project-level resolver shares storyDir / gitRoot. */
function writeConfig(metadataRoot: string, gitRoot?: string): void {
  const cfg: Record<string, unknown> = { storyDir: STORY_DIR_REL };
  if (gitRoot !== undefined) cfg.gitRoot = gitRoot;
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), JSON.stringify(cfg, null, 2));
}

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

const base = mkdtempSync(join(tmpdir(), 'project-gitroot-cwd-smoke-'));

try {
  // ── Scenario 1: WRAPPER-ROOT ────────────────────────────────────────────────
  // metadataRoot (wrapper) is NOT a git repo; configured gitRoot subdir IS git.
  // The project-level scans must survey the gitRoot subdir, not the metadataRoot.
  {
    const wrapper = join(base, 'wrapper');
    mkdirSync(wrapper, { recursive: true });
    const gitRootDir = join(wrapper, 'repo');
    initGitRepo(gitRootDir);
    writeFileSync(join(gitRootDir, 'seed.txt'), 'seed\n');
    git('add seed.txt', gitRootDir);
    git('commit -m initial', gitRootDir);
    writeConfig(wrapper, 'repo'); // gitRoot = subdir; storyDir at wrapper root

    const wrapperGitRoot = realpathSync(gitRootDir);
    const wrapperMeta = realpathSync(wrapper);
    const cfg = loadConfig(wrapper);

    // resolveProjectGitRoot (id-independent) → the configured gitRoot subdir.
    const rawRoot = resolveProjectGitRoot(wrapper, cfg.gitRoot);
    assert.notEqual(rawRoot, null, 'wrapper-root: resolveProjectGitRoot must resolve a gitRoot');
    assert.equal(
      realpathSync(rawRoot as string),
      wrapperGitRoot,
      'wrapper-root: resolveProjectGitRoot must return the configured gitRoot subdir',
    );

    // resolveProjectGitCwd (the call-site wrapper) → same gitRoot subdir, ≠ meta.
    const resolved = realpathSync(resolveProjectGitCwd(wrapper, wrapper, cfg));
    assert.equal(
      resolved,
      wrapperGitRoot,
      'wrapper-root: resolveProjectGitCwd must resolve to the configured gitRoot subdir',
    );
    assert.notEqual(
      resolved,
      wrapperMeta,
      'wrapper-root: resolveProjectGitCwd must NOT be the non-git metadataRoot (the bug)',
    );

    // Confirm the resolved cwd is actually a git repo (the symptom was running
    // git in the non-git wrapper); `git rev-parse` succeeds in the gitRoot.
    assert.equal(
      git('rev-parse --is-inside-work-tree', resolved),
      'true',
      'wrapper-root: resolved project gitCwd is a real git work tree (no "Not a git repository")',
    );
  }
  pass('wrapper-root: resolveProjectGitRoot/Cwd → configured gitRoot subdir (≠ non-git metadataRoot), is a git repo');

  // ── Scenario 2: PLAIN-REPO ──────────────────────────────────────────────────
  // metadataRoot == gitRoot, no configured gitRoot subdir. resolveProjectGitCwd
  // must return projectRoot byte-identically (the project-level resolver yields
  // the metadata git root, which canonically equals projectRoot).
  {
    const plain = join(base, 'plain');
    initGitRepo(plain);
    writeFileSync(join(plain, 'seed.txt'), 'seed\n');
    git('add seed.txt', plain);
    git('commit -m initial', plain);
    writeConfig(plain); // no configured gitRoot; metadataRoot itself is git-backed

    const plainRoot = realpathSync(plain);
    const cfg = loadConfig(plain);
    const resolved = realpathSync(resolveProjectGitCwd(plain, plain, cfg));
    assert.equal(
      resolved,
      plainRoot,
      'plain-repo: resolveProjectGitCwd resolves to projectRoot (byte-identical fallback)',
    );
  }
  pass('plain-repo: resolveProjectGitCwd → projectRoot (byte-identical to old bare-projectRoot fallback)');

  // ── Scenario 3: NULL gitRoot → ?? projectRoot ───────────────────────────────
  // Non-git metadataRoot, NO configured gitRoot → resolveProjectGitRoot returns
  // null; resolveProjectGitCwd's `?? projectRoot` falls back verbatim (no crash).
  {
    const noGit = join(base, 'no-git');
    mkdirSync(noGit, { recursive: true });
    writeConfig(noGit); // no gitRoot, metadataRoot not git-backed
    const cfg = loadConfig(noGit);

    assert.equal(
      resolveProjectGitRoot(noGit, cfg.gitRoot),
      null,
      'no-git/no-config: resolveProjectGitRoot must be null (unresolved gitRoot)',
    );
    assert.equal(
      resolveProjectGitCwd(noGit, noGit, cfg),
      noGit,
      'null gitRoot: resolveProjectGitCwd falls back to projectRoot verbatim',
    );
  }
  pass('null gitRoot: resolveProjectGitRoot returns null → resolveProjectGitCwd falls back to projectRoot verbatim');

  console.log('\n✓ project-gitroot-cwd smoke passed (wrapper-root + plain-repo + null-gitRoot)');
} catch (err) {
  console.error('\n✗ project-gitroot-cwd smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
}

rmSync(base, { recursive: true, force: true });
