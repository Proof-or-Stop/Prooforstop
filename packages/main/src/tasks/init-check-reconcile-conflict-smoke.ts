#!/usr/bin/env node

/**
 * B-7365: regression smoke proving the INIT_CHECK metadata reconcile
 * (`commitInitCheckMetadataAndMergeMain`) NEVER commits or leaves unresolved
 * merge-conflict markers in machine-generated story metadata.
 *
 * The reconcile commits the post-advance story metadata on the base branch
 * (main) and then `git merge`s that base branch into the story worktree so the
 * story branch contains all of main before the DONE merge. When a concurrent
 * session has already advanced main's copy of the same story `index.json`
 * (e.g. the story branch still records phase INIT while main now records
 * INIT_CHECK), that `git merge` collides on `index.json`. The pre-fix code ran
 * a bare `git merge` with no conflict handling: on a real conflict git either
 * left `<<<<<<< ======= >>>>>>>` markers in the working tree or aborted,
 * corrupting the machine-owned metadata (invalid JSON) — a CRITICAL framework
 * fault because every downstream reader (`store.readStory`, gates, signatures)
 * then fails on unparseable JSON.
 *
 * This smoke drives the REAL exported reconcile function (no copy) against a
 * deterministic 3-way conflict on `index.json`:
 *   - common ancestor (C0): index.json phase = "PLAN"
 *   - story branch:         phase = "INIT"        (changed from base)
 *   - main (reconcile):     phase = "INIT_CHECK"  (changed from base, same line)
 * Both sides change the SAME line differently from the base, so the 3-way merge
 * is guaranteed to conflict — no flaky timing.
 *
 * Assertions (the load-bearing properties of the fix):
 *   1. the reconcile does NOT throw a raw "Automatic merge failed" / abort;
 *   2. the story worktree is NOT left mid-merge (no MERGE_HEAD);
 *   3. the committed + working `index.json` parses as valid JSON;
 *   4. neither the committed nor the working `index.json` contains any
 *      `<<<<<<< / ======= / >>>>>>>` conflict marker;
 *   5. the resolved metadata equals the post-advance (main-committed) state
 *      (phase = "INIT_CHECK"), i.e. conflicts resolve deterministically to main.
 * It also covers the multi-file case: a SECOND conflicted metadata file under
 * the story dir (checklist.json) must be resolved the same way.
 *
 * Pattern mirrors init-check-atomicity-smoke.ts (self-contained node script,
 * mkdtemp git repo, lattice.config.json + .gitignore, StoryStore seeding).
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { commitInitCheckMetadataAndMergeMain } from '../cli-engine.js';
import type { StoryInfo, StoryPhase } from '../core/types.js';

const NOW = '2026-06-15T12:00:00.000Z';
const CONFLICT_MARKERS = ['<<<<<<<', '=======', '>>>>>>>'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  // Make local merges deterministic regardless of the host git config.
  git(root, ['config', 'commit.gpgsign', 'false']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '.lattice/*',
    '!.lattice/story/',
    '!.lattice/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'init-check reconcile conflict smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  resetConfigCache();
  return root;
}

function story(storyId: string, phase: StoryPhase): StoryInfo {
  return {
    storyId,
    name: `${storyId.toLowerCase()}-reconcile-conflict-smoke`,
    title: `${storyId} reconcile conflict smoke`,
    description: 'Synthetic story for the B-7365 INIT_CHECK reconcile conflict smoke.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase, action: 'create', timestamp: NOW }],
    worktree: { path: `.worktrees/${storyId}`, branch: `story/${storyId}`, createdAt: NOW },
  };
}

/**
 * Build a deterministic 3-way conflict on the story's machine-generated
 * metadata, then run the REAL reconcile and assert it never leaves/commits
 * conflict markers and resolves to the post-advance (main) state.
 */
function assertReconcileNeverCommitsConflictMarkers(): void {
  const root = initRepo('lattice-initcheck-reconcile-conflict-');
  const storyId = 'B-conflict';
  const storyRel = `.lattice/story/actives/${storyId}`;
  const indexRel = `${storyRel}/index.json`;
  const checklistRel = `${storyRel}/checklist.json`;
  const worktreeAbs = join(root, '.worktrees', storyId);
  try {
    const store = new StoryStore(root);

    // ── common ancestor C0 on main: phase = PLAN (the divergence base) ──
    // checklist.json carries a second machine field that both sides will edit
    // differently, exercising the multi-file resolution path.
    store.writeStory(storyId, story(storyId, 'PLAN'));
    write(root, checklistRel, `${JSON.stringify({ items: [], note: 'base' }, null, 2)}\n`);
    git(root, ['add', '-f', '--', storyRel]);
    git(root, ['commit', '-m', 'C0: seed story metadata at PLAN']);

    // ── story branch: change index.json phase PLAN→INIT + checklist note ──
    // Create the story worktree on a new story/<id> branch off C0, then commit
    // the story-branch-side divergence there. This is what dev_start's scoped
    // bootstrap leaves on the story branch in the real flow.
    git(root, ['worktree', 'add', '-b', `story/${storyId}`, worktreeAbs, 'HEAD']);
    git(worktreeAbs, ['config', 'commit.gpgsign', 'false']);
    const wtStore = new StoryStore(worktreeAbs);
    wtStore.writeStory(storyId, story(storyId, 'INIT'));
    write(worktreeAbs, checklistRel, `${JSON.stringify({ items: [], note: 'story-branch' }, null, 2)}\n`);
    git(worktreeAbs, ['add', '-f', '--', storyRel]);
    git(worktreeAbs, ['commit', '-m', 'story branch: index.json at INIT']);

    // ── main side: change the SAME lines PLAN→INIT_CHECK (the post-advance,
    //    machine-generated state the reconcile is supposed to commit on main) ──
    // Leave it uncommitted in main's working tree: the reconcile stages + commits
    // the bounded story path itself, then merges main into the story worktree.
    store.writeStory(storyId, story(storyId, 'INIT_CHECK'));
    write(root, checklistRel, `${JSON.stringify({ items: [], note: 'main-advanced' }, null, 2)}\n`);

    // ── drive the REAL reconcile ──
    let threw: Error | null = null;
    try {
      commitInitCheckMetadataAndMergeMain(root, store, storyId);
    } catch (e: any) {
      threw = e instanceof Error ? e : new Error(String(e));
    }

    // 1. The reconcile must not surface a raw merge-conflict / abort failure.
    if (threw) {
      assert.fail(
        `reconcile threw instead of resolving the metadata conflict deterministically: ${threw.message}`,
      );
    }

    // 2. The story worktree must not be left mid-merge.
    assert.equal(
      existsSync(join(worktreeAbs, '.git')),
      true,
      'story worktree dir must have a .git file (linked-worktree sanity)',
    );
    const mergeHead = join(root, '.git', 'worktrees', storyId, 'MERGE_HEAD');
    // A linked worktree stores MERGE_HEAD under .git/worktrees/<name>/; also
    // check the conventional location as a fallback.
    assert.equal(existsSync(mergeHead), false, 'story worktree must not be left mid-merge (MERGE_HEAD present)');
    const status = git(worktreeAbs, ['status', '--porcelain']);
    assert.doesNotMatch(status, /^(UU|AA|DD|AU|UA|DU|UD) /m, `worktree must have no unmerged paths:\n${status}`);

    // 3 + 4. The WORKING-TREE metadata parses and is marker-free.
    for (const rel of [indexRel, checklistRel]) {
      const workingPath = join(worktreeAbs, rel);
      assert.equal(existsSync(workingPath), true, `${rel} must exist in the worktree after the reconcile`);
      const working = readFileSync(workingPath, 'utf-8');
      for (const marker of CONFLICT_MARKERS) {
        assert.equal(working.includes(marker), false, `working ${rel} must not contain a "${marker}" conflict marker`);
      }
      assert.doesNotThrow(() => JSON.parse(working), `working ${rel} must parse as valid JSON`);
    }

    // 3 + 4 (committed). The story branch's COMMITTED metadata must also be
    // marker-free + parseable — markers must never reach a commit object.
    for (const rel of [indexRel, checklistRel]) {
      const committed = git(worktreeAbs, ['show', `HEAD:${rel}`]);
      for (const marker of CONFLICT_MARKERS) {
        assert.equal(committed.includes(marker), false, `committed ${rel} must not contain a "${marker}" conflict marker`);
      }
      assert.doesNotThrow(() => JSON.parse(committed), `committed ${rel} must parse as valid JSON`);
    }

    // 5. Deterministic resolution: the merged metadata equals the post-advance
    //    (main-committed) state — phase INIT_CHECK, checklist note main-advanced.
    const resolvedStory = wtStore.readStory(storyId);
    assert.equal(resolvedStory.phase, 'INIT_CHECK', 'conflict must resolve to the post-advance (main) phase');
    const resolvedChecklist = JSON.parse(readFileSync(join(worktreeAbs, checklistRel), 'utf-8'));
    assert.equal(resolvedChecklist.note, 'main-advanced', 'conflict must resolve the second metadata file to the main version too');

    console.log('✓ reconcile resolved a 3-way metadata conflict to the post-advance state with no markers');
  } finally {
    try { git(root, ['worktree', 'remove', '--force', worktreeAbs]); } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
}

assertReconcileNeverCommitsConflictMarkers();

console.log('✓ init-check reconcile conflict smoke passed');
