#!/usr/bin/env node
/**
 * B-72df — DONE merge clean-check must be scoped to the merge's affected paths.
 *
 * Background: B-e74e added `assertMainWorktreeReadyForMerge`, which ran
 * `git status --porcelain --untracked-files=no` at the main worktree and threw
 * on ANY dirty tracked file. That is over-broad: an unrelated uncommitted change
 * in the shared main worktree (parallel session work that the merge will never
 * touch) wrongly blocked the DONE merge, even though the merge could apply
 * cleanly and would not clobber that work.
 *
 * This smoke proves the SCOPED behavior:
 *   (a) unrelated dirty tracked path -> precondition PASSES + the file is
 *       byte-identical afterwards (no clobber, no side effect);
 *   (b) a dirty tracked path INSIDE the merge's affected set -> still THROWS
 *       (clobber protection preserved);
 *   (c) clean main worktree -> PASSES (B-e74e happy path unchanged);
 *   (d) main worktree unavailable (cannot read git HEAD) -> still THROWS
 *       (B-e74e availability handling preserved).
 *
 * The affected set is computed via `git diff main...story/<id> --name-status -M`
 * (the same change set the DONE merge of `story/<id>` into `main` applies,
 * including BOTH names of a rename). Only a dirty tracked path that intersects
 * that set blocks the merge.
 *
 * Function-level: calls `assertMainWorktreeReadyForMerge` directly against an
 * isolated temporary git repo. Does NOT shell out to the global lattice binary.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertMainWorktreeReadyForMerge } from '../handlers/done-effects.js';

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

const COMMIT_ENV = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke'];

/**
 * Build an isolated repo with:
 *   - branch main holding committed base files (incl. a "shared/" file that the
 *     story change set will NOT touch — the unrelated-dirty target),
 *   - branch story/<id> diverging from main by editing ONLY "src/feature.ts"
 *     and renaming "src/old-name.ts" -> "src/new-name.ts".
 * The repo is left checked out on main so the precondition's main-worktree
 * checks run against it.
 */
function buildScopedMergeRepo(storyId: string): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-merge-scope-'));

  write(root, '.gitignore', '.lattice/activity.jsonl\n');
  write(root, 'shared/unrelated.txt', 'unrelated baseline content\n');
  write(root, 'src/feature.ts', 'export const feature = 1;\n');
  write(root, 'src/old-name.ts', 'export const renamed = true;\n');
  // B-72df F-001: a NON-ASCII-named tracked file that the story ALSO edits.
  // git's default core.quotePath=true octal-escapes + quotes this path in
  // porcelain status output, but the affected-set diff (`-z`) carries raw UTF-8.
  // Both sides must use the same encoding or a dirty overlap on this file is
  // silently missed (clobber). The precondition now runs status with
  // `-c core.quotePath=false` so both sides emit raw UTF-8 and intersect.
  write(root, 'src/café.ts', 'export const accented = 1;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'base on main']);

  // Story branch: edit feature.ts + café.ts + rename old-name.ts -> new-name.ts.
  git(root, ['checkout', '-b', `story/${storyId}`]);
  write(root, 'src/feature.ts', 'export const feature = 2; // changed by story\n');
  write(root, 'src/café.ts', 'export const accented = 2; // changed by story\n');
  git(root, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story change set']);

  // Return to main — that is where the DONE merge target worktree sits.
  git(root, ['checkout', 'main']);
  return { root };
}

/**
 * (a) Unrelated dirty tracked path -> PASSES + byte-identical after.
 *
 * This is the fails-pre / passes-post repro. Before the scoped fix the
 * over-broad check threw on ANY dirty tracked file, so this assertion FAILED.
 * After the fix the unrelated dirty path is tolerated.
 */
function assertUnrelatedDirtyPathPasses(): void {
  const storyId = 'B-scope-unrelated';
  const { root } = buildScopedMergeRepo(storyId);
  try {
    // Dirty a tracked file that is NOT in the story change set.
    const unrelatedPath = join(root, 'shared/unrelated.txt');
    const dirtyContent = 'locally edited unrelated content — must NOT block DONE\n';
    writeFileSync(unrelatedPath, dirtyContent);

    // Pre-condition: main is genuinely dirty on a tracked file.
    assert.notEqual(
      git(root, ['status', '--porcelain', '--untracked-files=no']),
      '',
      'pre-condition: main worktree must be dirty on a tracked file',
    );

    // Must NOT throw — the dirty path does not intersect the merge's affected set.
    let returned = '';
    assert.doesNotThrow(() => {
      returned = assertMainWorktreeReadyForMerge(storyId, root);
    }, 'unrelated dirty tracked path must NOT block the DONE precondition');
    assert.equal(realpathSync(returned), realpathSync(root), 'precondition must return the resolved main merge root');

    // The unrelated file must be byte-identical (no clobber / no side effect).
    assert.equal(
      readFileSync(unrelatedPath, 'utf-8'),
      dirtyContent,
      'unrelated dirty file must be byte-identical after the precondition runs',
    );
    console.log('  ✓ unrelated dirty tracked path passes + file byte-identical after');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * (b) Dirty tracked path INSIDE the merge change set -> still THROWS.
 * Covers both an edited file and a rename endpoint (clobber protection).
 */
function assertOverlappingDirtyPathStillBlocks(): void {
  // b1: dirty the edited file (src/feature.ts is in the story change set).
  {
    const storyId = 'B-scope-overlap-edit';
    const { root } = buildScopedMergeRepo(storyId);
    try {
      writeFileSync(join(root, 'src/feature.ts'), 'export const feature = 999; // local uncommitted clash\n');
      assert.throws(
        () => assertMainWorktreeReadyForMerge(storyId, root),
        /Cannot enter DONE/,
        'dirty path inside the merge change set (edited file) must still block DONE',
      );
      console.log('  ✓ overlapping dirty path (edited file) still blocks DONE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // b2: dirty a rename endpoint. The story renames old-name.ts -> new-name.ts.
  //     A local uncommitted change to src/old-name.ts (the OLD name) overlaps
  //     the merge's affected set and must still block (both rename names count).
  {
    const storyId = 'B-scope-overlap-rename';
    const { root } = buildScopedMergeRepo(storyId);
    try {
      writeFileSync(join(root, 'src/old-name.ts'), 'export const renamed = "locally clobbered";\n');
      assert.throws(
        () => assertMainWorktreeReadyForMerge(storyId, root),
        /Cannot enter DONE/,
        'dirty rename-source path inside the merge change set must still block DONE',
      );
      console.log('  ✓ overlapping dirty path (rename source name) still blocks DONE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // b3 (B-72df F-001): dirty a NON-ASCII-named file that IS in the merge change
  //     set. With git's default core.quotePath=true, porcelain status quotes +
  //     octal-escapes "src/café.ts" while the affected-set diff (`-z`) carries
  //     raw UTF-8 — the two never match, so the overlap is silently missed and
  //     DONE wrongly proceeds (clobber). This case FAILS pre-fix (no throw) and
  //     PASSES post-fix (`-c core.quotePath=false` aligns both encodings).
  {
    const storyId = 'B-scope-overlap-nonascii';
    const { root } = buildScopedMergeRepo(storyId);
    try {
      writeFileSync(join(root, 'src/café.ts'), 'export const accented = 999; // local uncommitted clash\n');
      assert.throws(
        () => assertMainWorktreeReadyForMerge(storyId, root),
        /Cannot enter DONE/,
        'dirty non-ASCII path inside the merge change set must still block DONE (clobber protection holds for non-ASCII paths)',
      );
      console.log('  ✓ overlapping dirty path (non-ASCII filename) still blocks DONE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/**
 * (c) Clean main worktree -> PASSES (B-e74e happy path unchanged).
 */
function assertCleanMainPasses(): void {
  const storyId = 'B-scope-clean';
  const { root } = buildScopedMergeRepo(storyId);
  try {
    assert.equal(
      git(root, ['status', '--porcelain', '--untracked-files=no']),
      '',
      'pre-condition: main worktree must be clean',
    );
    let returned = '';
    assert.doesNotThrow(() => {
      returned = assertMainWorktreeReadyForMerge(storyId, root);
    }, 'clean main worktree must pass the DONE precondition');
    assert.equal(realpathSync(returned), realpathSync(root), 'precondition must return the resolved main merge root on clean path');
    console.log('  ✓ clean main worktree passes (B-e74e happy path unchanged)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * (d) Main worktree unavailable -> still THROWS (B-e74e availability preserved).
 * A non-git directory cannot read git HEAD, so the precondition must fail fast.
 */
function assertMainWorktreeUnavailableStillThrows(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-merge-scope-nogit-'));
  try {
    // No `git init` — this directory has no git metadata.
    write(root, 'placeholder.txt', 'not a git repo\n');
    assert.throws(
      () => assertMainWorktreeReadyForMerge('B-scope-nogit', root),
      /Cannot enter DONE: cannot read git HEAD/,
      'main worktree unavailable (no git HEAD) must still throw (B-e74e preserved)',
    );
    console.log('  ✓ main worktree unavailable still throws (B-e74e preserved)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertUnrelatedDirtyPathPasses();
assertOverlappingDirtyPathStillBlocks();
assertCleanMainPasses();
assertMainWorktreeUnavailableStillThrows();

console.log('✓ done-merge-scope-smoke passed');
