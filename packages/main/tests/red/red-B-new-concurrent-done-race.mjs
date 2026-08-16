#!/usr/bin/env node
/**
 * RED (repro-first) for the concurrent-DONE-race bug in worktree-authority-smoke.ts's
 * assertConcurrentDoneSerializesWithoutPartialDone.
 *
 * Root cause (confirmed by source read): runStoryTransitionInner
 * (handlers/transition-orchestrator.ts) acquires the per-story transition lock via
 * `acquireStoryTransitionLock(ctx.root, args.storyId)`. For a `story_advance --phase=DONE`
 * invoked from inside the story's own worktree, `ctx.root` resolves to the WORKTREE path
 * itself (not the stable main repo root) -- unlike `acquireDoneMainMergeLock`, which already
 * correctly resolves to the main repo root via `resolveDoneLockMainRepoRoot` for exactly this
 * reason. When two `story_advance --phase=DONE` processes race from the same worktree, the
 * winner completes DONE and deletes the ENTIRE worktree (including the transition-lock
 * directory) as part of cleanup. The loser, which was blocked polling for that exact lock
 * directory, sees it "become available" the instant the winner deletes everything, re-creates
 * the (now-orphaned) lock directory, and then tries to read its own story index.json from a
 * directory tree that no longer exists -- producing a raw, unhelpful
 * "File not found: .../index.json" crash instead of a clean lock-contention or
 * already-advanced message.
 *
 * Before the fix: the losing racer's output does NOT match any of the three patterns
 * assertConcurrentDoneSerializesWithoutPartialDone accepts (/DONE main merge lock is held/,
 * /main write lock is held/, /DONE/), so that assertion throws
 * "the losing DONE racer must explain itself ... got: ... File not found: ... index.json".
 * After the fix (transitionLock resolved to the stable main repo root, same as the DONE
 * main-merge lock): the losing racer fails cleanly with a lock-contention message and this
 * specific assertion no longer throws.
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
while (!existsSync(join(repoRoot, 'lattice.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'lattice.config.json')), 'could not locate repo root (lattice.config.json)');

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
