#!/usr/bin/env node

/**
 * init-window-data-loss-smoke (B-02a6 CHK-001, rewired by CHK-003)
 *
 * Regression test that LOCKS the INIT-window data-loss fix (B-02a6 CHK-002).
 *
 * Root cause this guards (confirmed):
 *   `story_create` used to write a story's INIT metadata
 *   (`<storyDir>/<storyId>/index.json` etc.) into the SHARED main checkout as
 *   UNTRACKED files. The repo `.gitignore` allowlists `.proof-or-stop/story/actives/**`
 *   (i.e. it is NOT ignored), which is EXACTLY the file class a plain
 *   `git clean -fd` removes. A story sitting in INIT therefore had its metadata
 *   committed to no branch, so a concurrent `git clean -fd` (or a wrong-branch
 *   checkout) on the shared checkout PERMANENTLY DELETED it.
 *
 * The fix (CHK-002, packages/main/src/core/safe-init-commit.ts):
 *   At the end of `story_create` the CURRENT branch HEAD is advanced by a scoped
 *   `proof-or-stop: story <id> init` commit that tracks ONLY the new story's metadata
 *   dir. A tracked git object is immune to `git clean -fd` / `-fdx`.
 *
 * Why this smoke is a GENUINE regression test (and the prior one was not):
 *   The previous version hand-wrote UNTRACKED metadata with Node `fs` and
 *   asserted it survived `git clean -fd`. That only ever tested a git tautology
 *   ("clean -fd removes untracked files") and NEVER called `story_create`, so no
 *   change to our code could flip it. This version drives the REAL `story_create`
 *   CLI in a throwaway git repo carrying the real `.gitignore` allowlist, then
 *   simulates a concurrent `git clean -fd` and asserts the metadata SURVIVES by
 *   reading actual file bytes.
 *
 *   - WITH the CHK-002 fix present (current code): GREEN — `story_create`
 *     committed the metadata, so `git clean -fd`/`-fdx` cannot touch it.
 *   - WITHOUT the fix (metadata left untracked): RED — the allowlisted-not-ignored
 *     leaf is wiped by `git clean -fd`. That is the regression-locking property.
 *
 * Coverage:
 *   - Happy/edge: the tracked metadata survives BOTH `git clean -fd` AND
 *     `git clean -fdx` (tracked objects are never removed by clean), AND a truly
 *     ignored runtime leaf NOT under the actives allowlist IS removed by
 *     `git clean -fdx`. The latter proves it is the allowlist + TRACKING that
 *     saves the metadata, not that clean is a no-op.
 *   - Adversarial: every survival assertion reads ACTUAL FILE BYTES (presence +
 *     content), never an exit code, so a no-op "fix" cannot fake a pass.
 *
 * This smoke does NOT touch story-create.ts / worktree.ts / safe-init-commit.ts /
 * story-metadata-protection.ts / `.gitignore` — it only constructs a temp repo
 * fixture and drives the real `story_create` CLI through it.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

const STORY_DIR_REL = '.proof-or-stop/story/actives';

/**
 * A valid `story_create` background that clears the handler's section / length
 * validation thresholds. Mirrors the shape used by story-create-concurrency-smoke.
 */
const VALID_BACKGROUND = [
  '## Trigger Event',
  '2026-06-19 init-window data-loss smoke needs a trigger section long enough to clear background validation thresholds.',
  '## Key Insights',
  'story_create must commit the INIT metadata onto the current branch HEAD so a concurrent git clean -fd cannot wipe the allowlisted-not-ignored leaf.',
  '## Option Tradeoffs',
  'The smoke drives the REAL story_create code path instead of hand-writing untracked files, so it is a genuine regression test for the safe-init commit.',
  '## Conversation Texture',
  'A maintainer running two agents on the same shared checkout sees the story metadata survive a concurrent git clean -fd, never silently deleted.',
].join('\n\n');

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
 * `.proof-or-stop/story/*` (+ `!.proof-or-stop/story/actives/**`), plus a `proof-or-stop.config.json`
 * pointing storyDir at the allowlisted actives tree. This puts the story metadata
 * leaf in the allowlisted-not-ignored class — exactly the file class a plain
 * `git clean -fd` removes when it is untracked.
 */
function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-init-window-data-loss-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  // Mirror the production `.gitignore` proof-or-stop rules verbatim: `.proof-or-stop/*` is
  // ignored, the story tree is re-allowlisted, but `activity.jsonl` is ignored
  // again. This is the precise rule shape from the repo root `.gitignore`.
  write(root, '.gitignore', [
    '.proof-or-stop/*',
    '!.proof-or-stop/story/',
    '.proof-or-stop/story/*',
    '!.proof-or-stop/story/actives/',
    '!.proof-or-stop/story/actives/**',
    '.proof-or-stop/story/actives/**/activity.jsonl',
    '',
  ].join('\n'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: STORY_DIR_REL,
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'init-window-data-loss smoke fixture\n');
  git(root, ['add', '.gitignore', 'proof-or-stop.config.json', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

/** Drive the REAL `story_create` CLI in `root`; returns the created story id. */
function createStory(root: string): string {
  const args = JSON.stringify({
    name: 'init-window-probe',
    title: 'Init-window data-loss probe story',
    description: 'Init-window data-loss probe story for the regression smoke.',
    type: 'chore',
    priority: 'medium',
    background: VALID_BACKGROUND,
    checklist: [{ title: 'probe item', context: 'probe context for init-window data-loss smoke' }],
  });
  const res = spawnSync(
    process.execPath,
    [cliPath, '--root', root, 'story_create', args],
    { cwd: root, encoding: 'utf-8' },
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.equal(res.status, 0, `story_create must succeed\n${output}`);
  const storyId = output.match(/Story (B-[a-f0-9]+) created/)?.[1];
  assert.ok(storyId, `story_create must report a created story id\n${output}`);
  return storyId!;
}

function isIgnored(root: string, relPath: string): boolean {
  const res = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: root, stdio: 'ignore' });
  return res.status === 0; // exit 0 => matched an ignore rule
}

/**
 * Core regression: a concurrent `git clean -fd` (and even `-fdx`) on the shared
 * checkout must NOT delete a story's INIT metadata, because `story_create` now
 * commits it onto the current branch HEAD (CHK-002). Read ACTUAL FILE BYTES.
 *
 * Edge dimension: a truly ignored runtime leaf NOT under the actives allowlist
 * IS removed by `git clean -fdx`, proving it is the allowlist + TRACKING that
 * saves the metadata, not that clean is a no-op.
 */
function assertInitMetadataSurvivesConcurrentClean(): void {
  const root = initRepo();
  try {
    const storyId = createStory(root);

    const storyDirAbs = join(root, STORY_DIR_REL, storyId);
    const indexPath = join(storyDirAbs, 'index.json');
    const indexRel = `${STORY_DIR_REL}/${storyId}/index.json`;

    // Precondition: the real story_create laid the metadata down on disk.
    assert.equal(existsSync(indexPath), true, 'precondition: story_create wrote index.json on disk');
    const indexBefore = readFileSync(indexPath, 'utf-8');
    assert.ok(indexBefore.length > 0, 'precondition: index.json has content');

    // Fixture invariant: the story index.json is allowlisted-NOT-ignored — the
    // exact class `git clean -fd` removes when a file is untracked.
    assert.equal(
      isIgnored(root, indexRel),
      false,
      'fixture invariant: story index.json must be allowlisted-not-ignored (the class clean -fd removes when untracked)',
    );

    // Regression-locking precondition: the CHK-002 safe-init commit tracked the
    // metadata into HEAD's tree. WITHOUT the fix this object would be absent and
    // the file untracked, so `git clean -fd` below would wipe it (RED).
    let trackedInHead = true;
    try {
      git(root, ['cat-file', '-e', `HEAD:${indexRel}`]);
    } catch {
      trackedInHead = false;
    }
    assert.equal(
      trackedInHead,
      true,
      `INIT-window data loss: ${indexRel} is NOT tracked in HEAD. story_create must commit a ` +
        '"proof-or-stop: story <id> init" safe-init commit so the allowlisted-not-ignored metadata is ' +
        'a tracked (clean-proof) object. Without that commit a concurrent git clean -fd wipes it.',
    );

    // Lay down an ignored runtime leaf that is NOT under the actives allowlist
    // (the `.proof-or-stop/*` ignore catches it). It must be removable by `clean -fdx`.
    const runtimeLeafAbs = join(root, '.proof-or-stop', 'runtime', 'init-window-scratch.tmp');
    mkdirSync(dirname(runtimeLeafAbs), { recursive: true });
    writeFileSync(runtimeLeafAbs, 'ephemeral runtime leaf\n');
    assert.equal(
      isIgnored(root, '.proof-or-stop/runtime/init-window-scratch.tmp'),
      true,
      'fixture invariant: a runtime leaf outside the actives allowlist must be ignored',
    );

    // A concurrent shell runs a plain `git clean -fd` on the shared checkout.
    git(root, ['clean', '-fd']);

    // DESIRED behavior: the tracked INIT metadata survives. Read ACTUAL BYTES,
    // never an exit code, so a no-op fix cannot fake a pass.
    assert.equal(
      existsSync(indexPath),
      true,
      `INIT-window data loss: ${indexRel} was wiped by a concurrent git clean -fd. ` +
        'Expected story_create to have committed the metadata (CHK-002 safe-init commit) so the ' +
        'allowlisted-not-ignored leaf is tracked and clean-proof.',
    );
    assert.equal(
      readFileSync(indexPath, 'utf-8'),
      indexBefore,
      'INIT-window data loss: index.json content must be byte-identical after a concurrent git clean -fd',
    );

    // Even `git clean -fdx` (which also removes ignored files) must NOT touch a
    // TRACKED file — proving the survival is due to tracking, not the -fd vs -fdx
    // distinction.
    git(root, ['clean', '-fdx']);
    assert.equal(
      existsSync(indexPath),
      true,
      `INIT-window data loss: ${indexRel} must survive git clean -fdx because it is TRACKED`,
    );
    assert.equal(
      readFileSync(indexPath, 'utf-8'),
      indexBefore,
      'INIT-window data loss: index.json content must be byte-identical after git clean -fdx (tracked)',
    );

    // Edge: the truly-ignored runtime leaf (outside the actives allowlist) IS
    // removed by `git clean -fdx`. This proves the allowlist + tracking is what
    // saves the metadata — clean is NOT a no-op on ignored, untracked files.
    assert.equal(
      existsSync(runtimeLeafAbs),
      false,
      'edge invariant: an ignored runtime leaf outside the actives allowlist must be removed by git clean -fdx',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertInitMetadataSurvivesConcurrentClean();

console.log('✓ init-window data-loss smoke passed: INIT metadata survives concurrent git clean -fd on the shared checkout');
