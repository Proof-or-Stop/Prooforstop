#!/usr/bin/env node
/**
 * done-oracle-wrapper-root-smoke (B-6666 CHK-001)
 *
 * Regression for the wrapper-root (metadataRoot != gitRoot) DONE false-block in
 * the DONE-oracle git-status path. buildDoneChecklist's `git-working-tree` row
 * reads `git status --porcelain` via readGitStatusLines. Before CHK-001 it ran
 * from the bare metadataRoot (the `root` argument). On a wrapper-root layout the
 * metadataRoot is NOT a git repo and the real repo is a configured gitRoot
 * subdir, so `git status` from the metadataRoot errors with
 * `fatal: not a git repository` -> the git-working-tree row reads
 * status=fail/blocking -> DONE is falsely blocked (ClawCreek-class projects can
 * never reach DONE).
 *
 * CHK-001 threads a resolved `gitCwd` (resolved ONCE at the
 * transition-orchestrator DONE boundary via resolveGitCwd) down to
 * buildDoneChecklist and on into readGitStatusLines. When gitCwd is absent it
 * falls back to `root`, so plain repos (projectRoot==gitCwd) stay byte-identical.
 *
 * Fixture (real disk, cleaned up):
 *   metadataRoot/                <- NON-git directory (the wrapper metadata root);
 *                                   `git status` from here errors.
 *     lattice.config.json        <- { gitRoot: "repo" } so resolveGitCwd resolves
 *                                   to the subdir via the configured-git-root branch
 *     .lattice/story/actives/... <- real StoryStore metadata (story + checklist)
 *     repo/                      <- the REAL inner `git init` repo (the gitRoot),
 *                                   branch main, one CLEAN commit
 *
 * Three proofs:
 *   (1) RED baseline: buildDoneChecklist with gitCwd absent (falls back to the
 *       bare, non-git metadataRoot) -> the git-working-tree row is fail/blocking
 *       (git status errors). This is exactly the wrapper-root false-block.
 *   (2) GREEN: buildDoneChecklist with the resolved gitCwd (the real, clean
 *       gitRoot) -> the git-working-tree row reads clean/pass.
 *   (3) PLAIN-REPO byte-identity: on a plain repo (metadataRoot==gitRoot), the
 *       FULL buildDoneChecklist row set is byte-identical whether gitCwd is
 *       absent or explicitly equals root.
 *
 * On success prints `done-oracle wrapper-root smoke passed`; any assert failure
 * throws -> exit 1.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-6666';

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

const CONFIG = (gitRoot: string | undefined) =>
  JSON.stringify(
    {
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      ...(gitRoot ? { gitRoot } : {}),
      workflow: { profile: 'light' },
    },
    null,
    2,
  );

/** A minimal TEST-phase story with NO worktree binding (so resolveGitCwd uses
 * the configured-git-root branch driven by lattice.config.json gitRoot). */
function writeStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-17T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'wrapper-root-fixture',
    title: 'Wrapper root fixture story',
    description: 'Drive the DONE-oracle git-status row over a wrapper-root layout.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    // NO worktree binding -> configured-git-root branch resolves to the subdir.
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

function gitWorkingTreeRow(rows: DoneCheckRow[]): DoneCheckRow {
  const row = rows.find((r) => r.id === 'git-working-tree');
  assert.ok(row, 'DONE checklist must include a git-working-tree row');
  return row!;
}

// ════════════════════════════════════════════════════════════════════════════
// Wrapper-root fixture: metadataRoot (NON-git) + gitRoot subdir (clean git repo).
// ════════════════════════════════════════════════════════════════════════════
function buildWrapperFixture(): { metadataRoot: string; gitRoot: string } {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'lattice-done-oracle-wrapper-'));
  // metadataRoot is deliberately NOT a git repo: `git status` from here errors.
  writeFileSync(join(metadataRoot, 'lattice.config.json'), CONFIG('repo'), 'utf-8');

  // gitRoot = a real INNER git repo in a subdir, branch main, one clean commit.
  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, ['init']);
  git(gitRoot, ['checkout', '-b', 'main']);
  writeFileSync(join(gitRoot, 'README.md'), '# wrapper root inner repo\n', 'utf-8');
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'base']);
  // Working tree is clean after the commit (README is committed, nothing else).
  return { metadataRoot, gitRoot };
}

// ════════════════════════════════════════════════════════════════════════════
// (1) RED baseline + (2) GREEN, same fixture.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const { metadataRoot, gitRoot } = buildWrapperFixture();
  try {
    const store = new StoryStore(metadataRoot);
    writeStory(store, STORY_ID);

    // (1) RED baseline: gitCwd absent -> falls back to the bare, non-git
    // metadataRoot. `git status` from there errors -> git-working-tree fails.
    const redRows = buildDoneChecklist(STORY_ID, store, metadataRoot, { auditWriter: null });
    const redRow = gitWorkingTreeRow(redRows);
    assert.equal(
      redRow.status,
      'fail',
      `RED: git-working-tree row must FAIL on the bare non-git metadataRoot ` +
        `(got status=${redRow.status}, detail=${JSON.stringify(redRow.detail)}). ` +
        `This is the wrapper-root DONE false-block CHK-001 fixes.`,
    );
    assert.equal(
      redRow.blocking,
      true,
      `RED: the failing git-working-tree row must be blocking (got blocking=${redRow.blocking})`,
    );
    assert.ok(
      (redRow.detail ?? '').includes('unable to read git status'),
      `RED: the failure must be the git-status read error (got detail=${JSON.stringify(redRow.detail)})`,
    );

    // Resolve the gitCwd ONCE via the production choke-point. Must resolve to the
    // real inner gitRoot subdir (proving the wrapper-root layout is wired).
    const resolvedGitCwd = resolveGitCwd({
      store,
      storyId: STORY_ID,
      metadataRoot,
      projectRoot: metadataRoot,
    });
    assert.notEqual(
      resolvedGitCwd,
      metadataRoot,
      `resolveGitCwd must resolve to the configured gitRoot subdir, not the metadataRoot ` +
        `(got ${resolvedGitCwd})`,
    );

    // (2) GREEN: buildDoneChecklist with the resolved gitCwd -> the row reads
    // clean/pass because git status runs in the real, clean gitRoot.
    const greenRows = buildDoneChecklist(STORY_ID, store, metadataRoot, {
      auditWriter: null,
      gitCwd: resolvedGitCwd,
    });
    const greenRow = gitWorkingTreeRow(greenRows);
    assert.equal(
      greenRow.status,
      'pass',
      `GREEN: git-working-tree row must PASS with the resolved gitCwd ` +
        `(got status=${greenRow.status}, detail=${JSON.stringify(greenRow.detail)})`,
    );
    assert.equal(
      greenRow.detail,
      'clean',
      `GREEN: git-working-tree detail must read 'clean' (got ${JSON.stringify(greenRow.detail)})`,
    );

    // RED vs GREEN MUST differ — that is the whole point: gitCwd selection is
    // load-bearing for the DONE-oracle git-status row.
    assert.notEqual(
      redRow.status,
      greenRow.status,
      'RED (bare metadataRoot) and GREEN (resolved gitCwd) must produce DIFFERENT git-working-tree outcomes',
    );

    void gitRoot;
  } finally {
    rmSync(metadataRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// (3) PLAIN-REPO byte-identity: metadataRoot==gitRoot. The FULL row set must be
//     byte-identical whether gitCwd is absent or explicitly equals root.
// ════════════════════════════════════════════════════════════════════════════
{
  resetConfigCache();
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-oracle-plain-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), CONFIG(undefined), 'utf-8');
    writeFileSync(join(root, 'README.md'), '# plain repo\n', 'utf-8');
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);

    const store = new StoryStore(root);
    writeStory(store, STORY_ID);
    // Commit the story metadata so the working tree is clean either way.
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story metadata']);

    // auditWriter:null keeps both runs read-only so neither appends process
    // events that would make the second run observe a different tree.
    const absentGitCwd = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null });
    const explicitGitCwd = buildDoneChecklist(STORY_ID, store, root, { auditWriter: null, gitCwd: root });

    assert.deepEqual(
      explicitGitCwd,
      absentGitCwd,
      'PLAIN: buildDoneChecklist output must be byte-identical when gitCwd is absent vs explicitly equals root',
    );

    // And specifically the git-working-tree row is clean/pass on both.
    const absentRow = gitWorkingTreeRow(absentGitCwd);
    const explicitRow = gitWorkingTreeRow(explicitGitCwd);
    assert.equal(absentRow.status, 'pass', `PLAIN: git-working-tree must pass (gitCwd absent), got ${absentRow.status}`);
    assert.equal(explicitRow.status, 'pass', `PLAIN: git-working-tree must pass (gitCwd=root), got ${explicitRow.status}`);
    assert.deepEqual(
      explicitRow,
      absentRow,
      'PLAIN: the git-working-tree row must be byte-identical with gitCwd absent vs gitCwd=root',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('done-oracle wrapper-root smoke passed');
