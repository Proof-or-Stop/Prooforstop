#!/usr/bin/env node

/**
 * B-198c CHK-001 smoke: id-dependent detection helper
 * `evaluateStoryDirInsideGitRoot` (core/story-signed-workspace-resolution.ts).
 *
 * The git-backed lifecycle must git-commit story metadata, which requires the
 * story metadata dir to resolve INSIDE the resolved git root. The two late
 * guards (worktree.ts:754 + cli-engine reconcile) detect this only at
 * INIT_CHECK bootstrap. This helper is the early detector; the id-independent
 * sibling `evaluateStoryDirConfigInsideGitRoot` is consumed by the doctor check
 * (CHK-002) and the early advisory (CHK-003).
 *
 * Coverage (mirrors the EXACT escape condition at worktree.ts:754):
 *  - ok        : storyDir inside gitRoot (metadataRoot == gitRoot)           → ok
 *  - violation : storyDir as a `..` sibling of gitRoot (the ClawCreek case)  → ok=false
 *  - symlink   : symlinked roots resolved via realpath                       → no false violation
 *  - no-gitRoot: no resolvable/configured gitRoot                            → ok=true, gitroot-unresolved
 *  - absent    : story metadata missing → THROWS (delegates to readStory);
 *                NOT a purity guarantee — id-less callers use the id-independent helper.
 *
 * Builds real temp git repos (deterministic; helper itself spawns no process —
 * the spawn happens inside resolveStorySignedWorkspace's git probe).
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { evaluateStoryDirInsideGitRoot } from '../core/story-signed-workspace-resolution.js';

const STORY_DIR_REL = '.proof-or-stop/story/actives';
const STORY_ID = 'B-test';

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git('init', dir);
  git('config user.email smoke@test.local', dir);
  git('config user.name smoke', dir);
}

/** Write proof-or-stop.config.json so StoryStore + resolution share storyDir / gitRoot. */
function writeConfig(metadataRoot: string, gitRoot?: string): void {
  const cfg: Record<string, unknown> = { storyDir: STORY_DIR_REL };
  if (gitRoot !== undefined) cfg.gitRoot = gitRoot;
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), JSON.stringify(cfg, null, 2));
}

/** Materialize a story index.json under metadataRoot's configured storyDir. */
function writeStoryIndex(metadataRoot: string): void {
  const storyDir = join(metadataRoot, STORY_DIR_REL, STORY_ID);
  mkdirSync(storyDir, { recursive: true });
  const story = {
    storyId: STORY_ID,
    name: 'smoke',
    title: 'smoke',
    description: 'smoke',
    phase: 'PLAN',
    type: 'feature',
    priority: 'low',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(storyDir, 'index.json'), JSON.stringify(story, null, 2));
}

const base = mkdtempSync(join(tmpdir(), 'proof-or-stop-storydir-gitroot-smoke-'));

try {
  // ── ok: storyDir inside gitRoot (metadataRoot == gitRoot) ───────────────────
  {
    const root = join(base, 'inside');
    initGitRepo(root);
    writeConfig(root); // no configured gitRoot; metadataRoot itself is git-backed
    writeStoryIndex(root);
    const store = new StoryStore(root);
    const result = evaluateStoryDirInsideGitRoot({
      store,
      storyId: STORY_ID,
      metadataRoot: root,
    });
    assert.equal(result.ok, true, 'storyDir inside gitRoot must be ok');
    assert.equal(result.reason, undefined, 'inside result carries no reason');
    assert.equal(result.gitRootAbs, realpathSync(root), 'gitRoot resolves to the repo root');
    assert.ok(result.rel && !result.rel.includes('..'), 'rel must not contain a .. segment');
    assert.match(result.storyDirAbs, /B-test$/, 'storyDirAbs ends with the story id');
  }

  // ── violation: storyDir as a `..` sibling of gitRoot (ClawCreek case) ───────
  // wrapper-root layout: metadataRoot = wrapper dir; configured gitRoot is a
  // subdir; story metadata lives at the wrapper root → OUTSIDE the gitRoot.
  {
    const wrapper = join(base, 'wrapper');
    mkdirSync(wrapper, { recursive: true });
    const innerGit = join(wrapper, 'clawcreek');
    initGitRepo(innerGit);
    writeConfig(wrapper, 'clawcreek'); // gitRoot = subdir; storyDir at wrapper root
    writeStoryIndex(wrapper);
    const store = new StoryStore(wrapper);
    const result = evaluateStoryDirInsideGitRoot({
      store,
      storyId: STORY_ID,
      metadataRoot: wrapper,
    });
    assert.equal(result.ok, false, 'storyDir outside the resolved gitRoot must be a violation');
    assert.equal(result.reason, 'outside-gitroot', 'violation reason must be outside-gitroot');
    assert.ok(result.gitRootAbs, 'gitRootAbs is populated for a resolved-but-outside gitRoot');
    assert.ok(result.rel && result.rel.split('/').includes('..'), 'rel must contain a .. segment');
  }

  // ── symlink: symlinked roots resolved via realpath → no false violation ─────
  // A symlink pointing at the real git root must NOT be mislabeled as outside.
  {
    const realRoot = join(base, 'sym-real');
    initGitRepo(realRoot);
    writeStoryIndex(realRoot);
    const linkRoot = join(base, 'sym-link');
    symlinkSync(realRoot, linkRoot, 'dir');
    writeConfig(linkRoot); // config read through the symlinked path
    const store = new StoryStore(linkRoot);
    const result = evaluateStoryDirInsideGitRoot({
      store,
      storyId: STORY_ID,
      metadataRoot: linkRoot, // metadataRoot reached via the symlink
    });
    assert.equal(result.ok, true, 'symlinked root resolved via realpath must not falsely violate');
    assert.equal(result.reason, undefined, 'symlink-resolved inside result carries no reason');
    assert.ok(result.rel !== null && !result.rel.includes('..'), 'realpath both sides → no spurious ..');
  }

  // ── no-gitRoot: no resolvable/configured gitRoot → non-violation ────────────
  // metadataRoot is NOT git-backed and no gitRoot configured → unresolved.
  {
    const root = join(base, 'no-git');
    mkdirSync(root, { recursive: true }); // plain dir, no git init
    writeConfig(root); // no gitRoot configured
    writeStoryIndex(root);
    const store = new StoryStore(root);
    const result = evaluateStoryDirInsideGitRoot({
      store,
      storyId: STORY_ID,
      metadataRoot: root,
    });
    assert.equal(result.ok, true, 'no resolvable gitRoot must be a non-violation (never a false outside)');
    assert.equal(result.reason, 'gitroot-unresolved', 'distinct reason for unresolved gitRoot');
    assert.equal(result.gitRootAbs, null, 'gitRootAbs is null when unresolved');
    assert.equal(result.rel, null, 'rel is null when gitRoot is unresolved');
  }

  // ── absent story: id-dependent helper THROWS (honest behavior) ──────────────
  // The id-dependent helper delegates to resolveStorySignedWorkspace →
  // store.readStory(), which raises StoryArtifactMissingError when the story
  // metadata does not exist. This is NOT a purity guarantee: project-level
  // callers with no story id must use the id-independent helper instead. Assert
  // the real throwing behavior so the doc comment and the test agree.
  {
    const root = join(base, 'absent-story');
    initGitRepo(root);
    writeConfig(root); // config present, but NO writeStoryIndex → story absent
    const store = new StoryStore(root);
    assert.throws(
      () => evaluateStoryDirInsideGitRoot({ store, storyId: 'B-missing', metadataRoot: root }),
      /not found|missing/i,
      'id-dependent helper must throw when the story metadata is absent',
    );
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log('✓ storyDir-inside-gitRoot smoke passed');
