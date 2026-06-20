#!/usr/bin/env node
/**
 * B-37b3 CHK-002: smoke proving the Experience Layer's derived finding-signals
 * cache is reachable from a LINKED GIT WORKTREE, not just the main checkout.
 *
 * Root cause this guards: `.lattice/learning/finding-signals.json` is gitignored
 * and lives ONLY in the main checkout, but story DEV/REVIEW runs in linked
 * worktrees. Before the fix, the learning-store resolved the learning dir relative
 * to the (worktree) root, so `loadExperienceHints` read `${worktree}/.lattice/...`
 * — which is absent — and the Experience Layer stayed dormant. The learning-store
 * now resolves the learning dir to the parent of `git rev-parse --git-common-dir`
 * (the main worktree root), with a never-throw fallback to the passed root.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `✓ experience-hint-worktree-cache smoke passed (N checks)` at the very end):
 *   1. Worktree resolves the MAIN cache: write the cache in the main checkout,
 *      `git worktree add` a linked worktree, then assert reading via the
 *      learning-store + loadExperienceHints/hasExperienceHints FROM THE WORKTREE
 *      returns the main-checkout signals.
 *   2. Non-git fallback: a plain (non-git) temp dir resolves to itself unchanged;
 *      reading with no cache returns empty WITHOUT throwing.
 *   3. Write-then-read parity: writing the cache via the learning-store FROM THE
 *      WORKTREE lands it under `main/.lattice/learning/`, and a subsequent worktree
 *      read hits it.
 *
 * Runs entirely in an OS temp dir (hermetic, no network); cleans up after itself.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadExperienceHints,
  hasExperienceHints,
} from '../core/experience-hint-loader.js';
import type { FindingSignalsCache } from '../core/experience-layer-types.js';
import {
  readFindingSignals,
  writeFindingSignals,
  resolveFindingSignalsPath,
} from '../core/learning-store.js';

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

const tmpRoots: string[] = [];
function mkTempRoot(): string {
  // realpathSync canonicalizes the OS tmp dir (on macOS `/var/...` is a symlink to
  // `/private/var/...`). `git rev-parse --git-common-dir` reports the canonical
  // path, so canonicalizing here lets path-prefix assertions compare like-for-like
  // (the resolver itself is symlink-correct either way — it points at the same
  // physical file — this only keeps the TEST's string comparisons honest).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b37b3-worktree-cache-')));
  tmpRoots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** A minimal valid FindingSignalsCache carrying one recurring signal. */
function recurringCache(signature: string, storyId: string): FindingSignalsCache {
  return {
    schemaVersion: 1,
    updatedAt: '2026-06-18T00:00:00.000Z',
    signals: [
      {
        localSignature: signature,
        category: 'edge',
        fileKinds: ['ts'],
        counts: {
          resolved: 3,
          dismissed: 0,
          falsePositive: 0,
          acceptedRisk: 0,
          unclear: 0,
          partiallyMitigated: 0,
        },
        // signalScore >= 0.65 (recurring threshold) with support >= 1 so it surfaces.
        signalScore: 0.75,
        support: 3,
        lastSeen: '2026-06-18T00:00:00.000Z',
        exampleStoryIds: [storyId],
        exampleFindingIds: [`${storyId}:F-001`],
        anchorFiles: ['src/widget.ts'],
      },
    ],
  };
}

/**
 * Build an isolated main git repo with one commit, then add a linked worktree.
 * Returns { mainRoot, worktreeRoot }. Sets a local identity so commits succeed in
 * a hermetic environment without relying on global git config.
 */
function initMainAndWorktree(): { mainRoot: string; worktreeRoot: string } {
  const base = mkTempRoot();
  const mainRoot = join(base, 'main');
  const worktreeRoot = join(base, 'wt');
  git(base, ['init', '-q', 'main']);
  git(mainRoot, ['config', 'user.email', 'smoke@example.com']);
  git(mainRoot, ['config', 'user.name', 'smoke']);
  git(mainRoot, ['config', 'commit.gpgsign', 'false']);
  // Commit something so a worktree can be created.
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: mainRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  git(mainRoot, ['worktree', 'add', '-q', '-b', 'wt-branch', worktreeRoot]);
  return { mainRoot, worktreeRoot };
}

// ─── 1. Worktree resolves the MAIN cache ──────────────────────────────────────

check('worktree read resolves the cache written in the MAIN checkout', () => {
  const { mainRoot, worktreeRoot } = initMainAndWorktree();
  const signature = 'edge||ts|review';

  // Cache exists ONLY in the main checkout.
  const writtenPath = writeFindingSignals(mainRoot, recurringCache(signature, 'B-main'));
  assert.ok(writtenPath.startsWith(mainRoot), 'cache writes under the main checkout root');
  assert.ok(existsSync(writtenPath), 'cache file exists in the main checkout');

  // The worktree's own .lattice/learning is absent on disk...
  assert.equal(
    existsSync(join(worktreeRoot, '.lattice', 'learning', 'finding-signals.json')),
    false,
    'no cache physically lives inside the worktree',
  );

  // ...yet resolveFindingSignalsPath from the worktree points at the main cache.
  const resolvedFromWorktree = resolveFindingSignalsPath(worktreeRoot);
  assert.equal(resolvedFromWorktree, writtenPath, 'worktree resolves the path to the main cache');

  // And the learning-store reads the main signals through the worktree root.
  const cache = readFindingSignals(worktreeRoot);
  assert.ok(cache, 'readFindingSignals(worktreeRoot) returns the main cache (non-null)');
  assert.equal(cache!.signals.length, 1, 'the one main signal is visible from the worktree');
  assert.equal(cache!.signals[0].localSignature, signature, 'the main signal content is intact');
});

check('loadExperienceHints/hasExperienceHints FIRE from the worktree on the main cache', () => {
  const { mainRoot, worktreeRoot } = initMainAndWorktree();
  const signature = 'edge||ts|review';
  writeFindingSignals(mainRoot, recurringCache(signature, 'B-main2'));

  const hints = loadExperienceHints(worktreeRoot);
  assert.ok(hasExperienceHints(hints), 'hints fire from the worktree against the main cache');
  assert.ok(hints.recurring.length >= 1, 'at least one recurring hint surfaces from the worktree');
  assert.equal(hints.recurring[0].localSignature, signature, 'surfaced hint matches the main signal');
});

// ─── 2. Non-git fallback ──────────────────────────────────────────────────────

check('non-git temp dir resolves to itself; empty read does NOT throw', () => {
  const plain = mkTempRoot(); // a plain dir, never `git init`-ed
  // resolveLearningRoot must fall back to the passed root (catch path), so the
  // resolved cache path stays inside the plain dir.
  const resolved = resolveFindingSignalsPath(plain);
  assert.ok(
    resolved.startsWith(plain),
    'non-git root resolves the cache path to itself (fallback), not some parent',
  );
  // No cache exists => read returns null without throwing.
  assert.doesNotThrow(() => readFindingSignals(plain), 'read on a non-git empty dir never throws');
  assert.equal(readFindingSignals(plain), null, 'empty non-git dir yields a null cache');
  assert.equal(hasExperienceHints(loadExperienceHints(plain)), false, 'no hints for an empty non-git dir');
});

// ─── 3. Write-then-read parity (write from the worktree lands in main) ─────────

check('write from the worktree lands in main/.lattice/learning and a worktree read hits it', () => {
  const { mainRoot, worktreeRoot } = initMainAndWorktree();
  const signature = 'adversarial||ts|review';

  // Write via the learning-store FROM THE WORKTREE.
  const writtenPath = writeFindingSignals(worktreeRoot, recurringCache(signature, 'B-wt'));
  // It must physically land under the MAIN checkout, not the worktree.
  assert.ok(writtenPath.startsWith(mainRoot), 'worktree write lands under the main checkout root');
  assert.ok(
    existsSync(join(mainRoot, '.lattice', 'learning', 'finding-signals.json')),
    'cache physically exists under main/.lattice/learning/',
  );
  assert.equal(
    existsSync(join(worktreeRoot, '.lattice', 'learning', 'finding-signals.json')),
    false,
    'no cache leaks into the worktree directory',
  );

  // A subsequent worktree read hits the just-written cache (read/write agree).
  const cache = readFindingSignals(worktreeRoot);
  assert.ok(cache, 'worktree read sees the cache it just wrote');
  assert.equal(cache!.signals[0].localSignature, signature, 'round-trip content matches');
});

// ─── summary ──────────────────────────────────────────────────────────────────

try {
  console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (passed !== total) {
    process.exitCode = 1;
  } else {
    console.log(`✓ experience-hint-worktree-cache smoke passed (${total} checks)`);
  }
} finally {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
