#!/usr/bin/env node
/**
 * RED (repro-first) for the concurrent-DONE-race bug in worktree-authority-smoke.ts's
 * assertConcurrentDoneSerializesWithoutPartialDone.
 *
 * Root cause (confirmed by source read, corrected post-REVIEW F-001/F-002):
 * `acquireStoryTransitionLock(root, storyId)` -> `storyTransitionLockPath` already resolves
 * `root` through `resolveSharedLockRoot` (git-common-dir based, B-d877 R2 FIX B) BEFORE
 * touching disk, so the lock directory itself is always anchored at the stable shared root
 * regardless of whether `ctx.root` is a story worktree or the main repo root -- an earlier
 * revision of this fix rerouted the root ARGUMENT at the transition-orchestrator.ts call site
 * and turned out to be a no-op (F-001), since the lock never actually raced on a
 * worktree-relative directory in the first place.
 *
 * The REAL crash: `ctx.store` (used to read story metadata inside runStoryTransitionInner) is
 * bound to `ctx.root` at CLI bootstrap, well BEFORE the transition lock is even acquired. For a
 * `story_advance --phase=DONE` invoked from inside the story's own worktree, that root IS the
 * worktree path, fixed for the life of the process. When two `story_advance --phase=DONE`
 * processes race from the same worktree, the winner completes DONE and deletes the ENTIRE
 * worktree as part of cleanup. The loser -- which was correctly serialized behind the
 * (already-shared-rooted) transition lock -- wakes the moment the winner releases it, and its
 * OWN `store.readStory(args.storyId)` then runs against a root that no longer exists on disk,
 * throwing a raw, unhelpful StoryArtifactMissingError ("File not found: .../index.json")
 * instead of a clean lock-contention or already-advanced message.
 *
 * Before the fix: the losing racer's output does NOT match any of the three patterns
 * assertConcurrentDoneSerializesWithoutPartialDone accepts (/DONE main merge lock is held/,
 * /main write lock is held/, /DONE/), so that assertion throws
 * "the losing DONE racer must explain itself ... got: ... File not found: ... index.json".
 * After the fix (a narrow catch in transition-orchestrator.ts: when this specific
 * StoryArtifactMissingError is thrown AND ctx.root no longer exists on disk, translate it into
 * a clear "a concurrent DONE transition already completed and removed this worktree" message):
 * the losing racer fails cleanly and this specific assertion no longer throws.
 *
 * This directly runs the built worktree-authority-smoke.js and inspects its actual output
 * rather than re-implementing the race, so it exercises the exact same two-real-process race
 * the production fixture does. Uses spawnSync with a real file descriptor (not a pipe) for
 * stderr capture -- see red-B-74b9-chk001-acceptance-basis.mjs for why execFileSync's
 * pipe-based capture is unreliable for large synchronous crash dumps on macOS.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-B-new-concurrent-done-race.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const target = join(repoRoot, 'packages/main/dist/tasks/worktree-authority-smoke.js');
const captureDir = mkdtempSync(join(tmpdir(), 'red-concurrent-done-'));
const stderrPath = join(captureDir, 'stderr.txt');

try {
  const fd = openSync(stderrPath, 'w');
  const result = spawnSync(process.execPath, [target], { cwd: repoRoot, stdio: ['ignore', 'ignore', fd] });
  closeSync(fd);

  const stderr = readFileSync(stderrPath, 'utf8');

  assert.notEqual(result.status, 0, 'RED: worktree-authority-smoke.js is expected to fail (still exhibits the pre-fix concurrent-DONE-race defect)');
  assert.match(stderr, /the losing DONE racer must explain itself/, 'RED: expected assertConcurrentDoneSerializesWithoutPartialDone\'s own failure message');
  assert.match(stderr, /File not found:.*index\.json/, 'RED: expected the raw StoryArtifactMissingError signature (the actual pre-fix defect)');
  assert.doesNotMatch(stderr, /DONE main merge lock is held/, 'RED: the loser must NOT already show a clean lock-contention message (that would mean the bug is already fixed)');

  console.log('RED red-B-new-concurrent-done-race: confirmed pre-fix defect (losing DONE racer crashes with a raw index.json ENOENT instead of a clean lock-contention message)');
} finally {
  rmSync(captureDir, { recursive: true, force: true });
}
