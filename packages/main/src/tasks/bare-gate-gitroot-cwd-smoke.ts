#!/usr/bin/env node

/**
 * B-3990 smoke: no-`--story` CLI-gate gitCwd resolution on wrapper-root projects.
 *
 * BUG: verifier.ts resolved the shared gitCwd that feeds the BARE channel /
 * concept / lint gates (`proof-or-stop validate --concept` etc. with NO `--story`) to
 * `projectRoot` unconditionally. In a WRAPPER-ROOT layout the projectRoot
 * (metadataRoot) is NOT a git repo and the real repo is a configured gitRoot
 * subdir, so the bare concept gate's `git diff main...HEAD` ran in the non-git
 * wrapper and printed `warning: Not a git repository` / `git diff failed`.
 *
 * FIX (CHK-001): the no-`--story` branch now resolves
 *   evaluateStoryDirConfigInsideGitRoot({ metadataRoot: projectRoot }).gitRootAbs ?? projectRoot
 * (the id-independent project-level resolver), mirroring B-2856's `--story`
 * `resolveGitCwd()` reroute. cwd-only; byte-identical for plain repos.
 *
 * This smoke asserts the EXACT value the no-`--story` branch now computes, for
 * the three scenarios in the plan:
 *   1. WRAPPER-ROOT (metadataRoot NOT git; configured gitRoot subdir IS git):
 *        gitRootAbs ?? projectRoot  →  the gitRoot subdir (≠ metadataRoot).
 *   2. PLAIN-REPO (metadataRoot == gitRoot; no configured gitRoot subdir):
 *        gitRootAbs ?? projectRoot  →  projectRoot (byte-identical fallback).
 *   3. NULL gitRootAbs (non-git metadataRoot, no configured gitRoot):
 *        gitRootAbs is null  →  ?? falls back to the passed projectRoot verbatim.
 *
 * It exercises the resolver's TOTAL guarantee (never throws) on the same fixture
 * shapes the real verifier handler feeds it. Prints ✓/✗; exits non-zero on first
 * failure.
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateStoryDirConfigInsideGitRoot } from '../core/story-signed-workspace-resolution.js';

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

/**
 * Mirror the EXACT expression the verifier.ts no-`--story` branch now uses:
 *   evaluateStoryDirConfigInsideGitRoot({ metadataRoot: projectRoot }).gitRootAbs ?? projectRoot
 * Keeping it in one place so the smoke asserts the production branch verbatim.
 */
function bareGateGitCwd(projectRoot: string): string {
  return evaluateStoryDirConfigInsideGitRoot({ metadataRoot: projectRoot }).gitRootAbs ?? projectRoot;
}

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

const base = mkdtempSync(join(tmpdir(), 'bare-gate-gitroot-cwd-smoke-'));

try {
  // ── Scenario 1: WRAPPER-ROOT ────────────────────────────────────────────────
  // metadataRoot (wrapper) is NOT a git repo; configured gitRoot subdir IS git.
  // The bare-gate gitCwd must resolve to the gitRoot subdir, not the metadataRoot.
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

    const resolved = realpathSync(bareGateGitCwd(wrapper));
    assert.equal(
      resolved,
      wrapperGitRoot,
      'wrapper-root: bare-gate gitCwd must resolve to the configured gitRoot subdir',
    );
    assert.notEqual(
      resolved,
      wrapperMeta,
      'wrapper-root: bare-gate gitCwd must NOT be the non-git metadataRoot (the bug)',
    );

    // Confirm the resolved cwd is actually a git repo (the symptom was running
    // git in the non-git wrapper); `git rev-parse` succeeds in the gitRoot.
    assert.equal(
      git('rev-parse --is-inside-work-tree', resolved),
      'true',
      'wrapper-root: resolved bare-gate gitCwd is a real git work tree (no "Not a git repository")',
    );
  }
  pass('wrapper-root: bare-gate gitCwd → configured gitRoot subdir (≠ non-git metadataRoot), is a git repo');

  // ── Scenario 2: PLAIN-REPO ──────────────────────────────────────────────────
  // metadataRoot == gitRoot, no configured gitRoot subdir. The project-level
  // resolver resolves gitRootAbs to the metadata git root, which canonically
  // equals projectRoot → byte-identical to the old `: projectRoot` fallback.
  {
    const plain = join(base, 'plain');
    initGitRepo(plain);
    writeFileSync(join(plain, 'seed.txt'), 'seed\n');
    git('add seed.txt', plain);
    git('commit -m initial', plain);
    writeConfig(plain); // no configured gitRoot; metadataRoot itself is git-backed

    const plainRoot = realpathSync(plain);
    const resolved = realpathSync(bareGateGitCwd(plain));
    assert.equal(
      resolved,
      plainRoot,
      'plain-repo: bare-gate gitCwd resolves to projectRoot (byte-identical fallback)',
    );
  }
  pass('plain-repo: bare-gate gitCwd → projectRoot (byte-identical to old fallback)');

  // ── Scenario 3: NULL gitRootAbs → ?? projectRoot ────────────────────────────
  // Non-git metadataRoot, NO configured gitRoot → the resolver returns
  // gitRootAbs === null; the `?? projectRoot` falls back to the passed
  // projectRoot verbatim (no crash, never throws).
  {
    const noGit = join(base, 'no-git');
    mkdirSync(noGit, { recursive: true });
    writeConfig(noGit); // no gitRoot, metadataRoot not git-backed

    // First prove the resolver yields a null gitRootAbs for this shape …
    const evaluated = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: noGit });
    assert.equal(
      evaluated.gitRootAbs,
      null,
      'no-git/no-config: resolver gitRootAbs must be null (unresolved gitRoot)',
    );
    // … then prove the production `?? projectRoot` falls back verbatim.
    assert.equal(
      bareGateGitCwd(noGit),
      noGit,
      'null gitRootAbs: bare-gate gitCwd falls back to projectRoot verbatim',
    );
  }
  pass('null gitRootAbs: resolver returns null → ?? projectRoot falls back to projectRoot verbatim');

  console.log('\n✓ bare-gate-gitroot-cwd smoke passed (wrapper-root + plain-repo + null-gitRoot)');
} catch (err) {
  console.error('\n✗ bare-gate-gitroot-cwd smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  rmSync(base, { recursive: true, force: true });
  process.exit(1);
}

rmSync(base, { recursive: true, force: true });
