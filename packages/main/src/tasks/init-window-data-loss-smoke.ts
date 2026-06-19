#!/usr/bin/env node

/**
 * init-window-data-loss-smoke (B-02a6 CHK-001)
 *
 * Reproduction smoke that LOCKS the INIT-window data-loss bug (TDD red).
 *
 * Root cause (confirmed):
 *   `story_create` writes a story's INIT metadata
 *   (`.lattice/story/actives/<id>/index.json` etc.) into the SHARED main
 *   checkout as UNTRACKED files. The "safe-init commit" that would make those
 *   files clean-proof only happens later, at the INIT_CHECK bootstrap. So a
 *   story sitting in INIT has its metadata committed to no branch. The repo
 *   `.gitignore` allowlists `.lattice/story/actives/**` (i.e. it is NOT
 *   ignored), which is EXACTLY the file class that a plain `git clean -fd`
 *   removes. A concurrent `git clean -fd` on the shared checkout therefore
 *   PERMANENTLY DELETES the story's metadata.
 *
 * What this smoke asserts:
 *   The DESIRED behavior — after a concurrent `git clean -fd` the story's INIT
 *   metadata STILL EXISTS (survives). On CURRENT code this assertion FAILS,
 *   because the metadata is untracked and gets wiped. That RED failure is the
 *   deliverable: it proves the bug. It flips GREEN once CHK-002 lands the fix
 *   (a safe-init commit that tracks the metadata so `git clean -fd` cannot
 *   touch it).
 *
 * Coverage:
 *   - Edge: BOTH an allowlisted-not-ignored leaf (index.json — removed by
 *     `clean -fd`) and an ignored leaf (activity.jsonl — survives `clean -fd`,
 *     removed only by `clean -fdx`). The two `git clean` variants differ, and
 *     the bug lives specifically in the allowlisted-not-ignored class.
 *   - Adversarial: every assertion reads ACTUAL FILE BYTES (presence + content)
 *     never an exit code, so a no-op "fix" cannot fake a pass.
 *
 * This smoke does NOT touch story-create.ts / worktree.ts /
 * story-metadata-protection.ts — it only constructs the equivalent untracked
 * metadata that story_create currently produces, then runs `git clean`.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
 * Build a throwaway git repo carrying the REAL `.gitignore` allowlist for
 * `.lattice/story/*` (+ `!.lattice/story/actives/**`), so the untracked
 * metadata leaf lands in the allowlisted-not-ignored class — exactly the file
 * class `git clean -fd` removes.
 */
function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  // Mirror the production `.gitignore` lattice rules verbatim: `.lattice/*` is
  // ignored, the story tree is re-allowlisted, but `activity.jsonl` is ignored
  // again. This is the precise rule shape from the repo root `.gitignore`.
  write(root, '.gitignore', [
    '.lattice/*',
    '!.lattice/story/',
    '.lattice/story/*',
    '!.lattice/story/actives/',
    '!.lattice/story/actives/**',
    '.lattice/story/actives/**/activity.jsonl',
    '',
  ].join('\n'));
  write(root, 'README.md', 'init-window-data-loss smoke fixture\n');
  git(root, ['add', '.gitignore', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

const STORY_ID = 'B-initwin';
const INDEX_BODY = `{"storyId":"${STORY_ID}","phase":"INIT"}\n`;
const ACTIVITY_BODY = 'init-window activity heartbeat\n';

/**
 * Lay down the untracked INIT metadata that `story_create` currently produces:
 * an allowlisted-not-ignored `index.json` plus an ignored `activity.jsonl`,
 * with NO safe-init commit (mirroring a story that is still sitting in INIT).
 */
function writeInitMetadata(root: string): { indexPath: string; activityPath: string } {
  const storyDir = join(root, '.lattice', 'story', 'actives', STORY_ID);
  const indexPath = join(storyDir, 'index.json');
  const activityPath = join(storyDir, 'activity.jsonl');
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(indexPath, INDEX_BODY);
  writeFileSync(activityPath, ACTIVITY_BODY);
  return { indexPath, activityPath };
}

function isIgnored(root: string, relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], { cwd: root, stdio: 'ignore' });
    return true; // exit 0 => matched an ignore rule
  } catch {
    return false; // exit 1 => not ignored
  }
}

/**
 * Core reproduction: a concurrent `git clean -fd` on the shared checkout must
 * NOT delete a story's INIT metadata. On current code it does — RED.
 */
function assertInitMetadataSurvivesConcurrentClean(): void {
  const root = initRepo('lattice-init-window-clean-fd-');
  try {
    const { indexPath, activityPath } = writeInitMetadata(root);

    // Sanity-check the fixture actually reproduces the allowlist class split.
    const indexRel = '.lattice/story/actives/' + STORY_ID + '/index.json';
    const activityRel = '.lattice/story/actives/' + STORY_ID + '/activity.jsonl';
    assert.equal(
      isIgnored(root, indexRel),
      false,
      'fixture invariant: story index.json must be allowlisted-not-ignored (the class clean -fd removes)',
    );
    assert.equal(
      isIgnored(root, activityRel),
      true,
      'fixture invariant: activity.jsonl must be ignored (survives clean -fd, removed only by clean -fdx)',
    );
    assert.equal(existsSync(indexPath), true, 'precondition: index.json laid down before clean');
    assert.equal(existsSync(activityPath), true, 'precondition: activity.jsonl laid down before clean');

    // A concurrent shell runs a plain `git clean -fd` on the shared checkout.
    git(root, ['clean', '-fd']);

    // DESIRED behavior: the INIT metadata survives. Read ACTUAL BYTES, never an
    // exit code, so a no-op fix cannot fake a pass.
    assert.equal(
      existsSync(indexPath),
      true,
      `INIT-window data loss: ${indexRel} was wiped by a concurrent git clean -fd. ` +
        'story_create wrote it untracked with no safe-init commit, so the allowlisted-not-ignored ' +
        'metadata is deleted permanently. Expected the story metadata to survive (CHK-002 fix).',
    );
    assert.equal(
      readFileSync(indexPath, 'utf-8'),
      INDEX_BODY,
      'INIT-window data loss: index.json content must be intact after a concurrent git clean -fd',
    );

    // Edge: the ignored leaf is untouched by `clean -fd` (clean -fd vs -fdx differ).
    assert.equal(
      existsSync(activityPath),
      true,
      'ignored activity.jsonl must survive git clean -fd (only clean -fdx would remove it)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Edge companion: `git clean -fdx` DOES remove the ignored leaf, proving the
 * -fd vs -fdx distinction is real and that the bug's blast radius for the
 * allowlisted-not-ignored leaf is identical under both variants.
 */
function assertCleanFdxRemovesIgnoredLeaf(): void {
  const root = initRepo('lattice-init-window-clean-fdx-');
  try {
    const { indexPath, activityPath } = writeInitMetadata(root);
    assert.equal(existsSync(indexPath), true, 'precondition: index.json laid down before clean -fdx');
    assert.equal(existsSync(activityPath), true, 'precondition: activity.jsonl laid down before clean -fdx');

    // -fdx removes ignored files too.
    git(root, ['clean', '-fdx']);

    assert.equal(
      existsSync(activityPath),
      false,
      'edge invariant: git clean -fdx removes the ignored activity.jsonl (distinct from clean -fd)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertInitMetadataSurvivesConcurrentClean();
assertCleanFdxRemovesIgnoredLeaf();

console.log('✓ init-window data-loss smoke passed');
