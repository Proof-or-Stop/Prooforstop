#!/usr/bin/env node

/**
 * B-231d smoke: worktree/host portability of story-scoped validation coordination.
 *
 * Proves the three deliverables against a REAL temp repository with a REAL linked
 * git worktree (so `git rev-parse --git-common-dir` genuinely resolves the shared
 * root for both roots), plus a non-git temp dir for the fallback path:
 *
 *   CHK-001  validationExecutionLockPath roots the lock at the shared git-common-dir
 *            repo root, so two worktrees of the same story mint ONE lock; different
 *            storyIds still differ; a non-git dir falls back without throwing.
 *   CHK-002  buildDoneRequiredCommandSpecEnvelope digests a repo-relative logical
 *            cwd, so the same logical command digests identically under two roots;
 *            genuinely different commands differ; a legacy absolute-cwd (v1) receipt
 *            still verifies under the migration.
 *   CHK-003  resolvedCwd records the absolute physical path but is EXCLUDED from the
 *            digest — changing only provenance leaves the digest equal.
 *
 * Prints ✓/✗ per check; exits non-zero on the first failure; final line
 * "worktree-portability smoke passed".
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validationExecutionLockPath } from '../core/validation-execution-lock.js';
import {
  buildDoneRequiredCommandSpecEnvelope,
  buildLegacyAbsoluteCwdCommandSpecEnvelope,
  validateCommandSpecDigestCoverage,
} from '../core/done-required-validation.js';
import type { DoneRequiredCommandReceipt, ValidationCommand } from '../core/validation-types.js';

const cleanups: Array<() => void> = [];
function cleanupAll(): void {
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch { /* best-effort */ }
  }
}

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`✓ ${label}`);
    return;
  }
  console.error(`✗ ${label}${detail ? ' — ' + detail : ''}`);
  cleanupAll();
  process.exit(1);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  // ── Real repo + real linked worktree (shared git-common-dir) ────────────────
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-portability-smoke-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));

  const mainRoot = join(base, 'repo');
  mkdirSync(mainRoot, { recursive: true });
  git(['init', '-b', 'main'], mainRoot);
  git(['config', 'user.email', 'smoke@test.local'], mainRoot);
  git(['config', 'user.name', 'smoke'], mainRoot);
  git(['config', 'commit.gpgsign', 'false'], mainRoot);
  writeFileSync(join(mainRoot, 'seed.txt'), 'seed\n');
  git(['add', 'seed.txt'], mainRoot);
  git(['commit', '-m', 'seed'], mainRoot);

  // A linked worktree of the SAME repo/story, at a different physical root.
  const worktreeRoot = join(mainRoot, '.worktrees', 'B-port');
  git(['worktree', 'add', '-b', 'story/B-port', worktreeRoot], mainRoot);

  const STORY = 'B-port';

  // ── CHK-001: shared validation lock root ────────────────────────────────────
  const lockMain = validationExecutionLockPath(mainRoot, STORY);
  const lockWorktree = validationExecutionLockPath(worktreeRoot, STORY);
  check(
    'CHK-001 lock identity is shared across two worktree roots of the same story',
    lockMain === lockWorktree,
    `${lockMain} vs ${lockWorktree}`,
  );
  check(
    'CHK-001 different storyIds still get different locks',
    validationExecutionLockPath(mainRoot, 'B-aaaa') !== validationExecutionLockPath(mainRoot, 'B-bbbb'),
  );

  // Non-git temp dir: resolveSharedLockRoot must fall back to root verbatim
  // without throwing (plain-repo behavior unchanged).
  const nonGit = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-portability-nogit-')));
  cleanups.push(() => rmSync(nonGit, { recursive: true, force: true }));
  let nonGitThrew = false;
  let nonGitLock = '';
  try {
    nonGitLock = validationExecutionLockPath(nonGit, STORY);
  } catch {
    nonGitThrew = true;
  }
  check(
    'CHK-001 non-git dir falls back to root without throwing',
    !nonGitThrew && nonGitLock.startsWith(nonGit),
    nonGitThrew ? 'threw' : nonGitLock,
  );

  // ── CHK-002: repo-relative logical cwd in the digest ────────────────────────
  const cmd: ValidationCommand = { label: 'suite', command: 'npm', args: ['test'], cwd: '.', shell: false, env: {} };
  const envMain = buildDoneRequiredCommandSpecEnvelope(mainRoot, cmd);
  const envWorktree = buildDoneRequiredCommandSpecEnvelope(worktreeRoot, cmd);
  check(
    'CHK-002 digest identical for the same logical command under two worktree roots',
    envMain.digest === envWorktree.digest,
    `${envMain.digest} vs ${envWorktree.digest}`,
  );
  check(
    'CHK-002 envelope is schema v2 with a repo-relative logical cwd',
    envMain.schema === 'lattice.command-spec.v2' && envMain.cwd === '.' && envWorktree.cwd === '.',
    `${envMain.schema} cwd=${envMain.cwd}/${envWorktree.cwd}`,
  );

  const differentCmd: ValidationCommand = { label: 'build', command: 'npm', args: ['run', 'build'], cwd: 'packages/main', shell: false, env: {} };
  check(
    'CHK-002 genuinely different commands digest differently',
    buildDoneRequiredCommandSpecEnvelope(mainRoot, differentCmd).digest !== envMain.digest,
  );

  // Legacy absolute-cwd (v1) receipt, produced by the migration builder, must
  // still verify under validateCommandSpecDigestCoverage.
  const legacyEnv = buildLegacyAbsoluteCwdCommandSpecEnvelope(worktreeRoot, cmd, {
    command: 'npm',
    args: ['test'],
    cwd: worktreeRoot,
  });
  check(
    'CHK-002 legacy envelope is schema v1 with an absolute cwd',
    legacyEnv.schema === 'lattice.command-spec.v1' && legacyEnv.cwd.startsWith(worktreeRoot),
    `${legacyEnv.schema} cwd=${legacyEnv.cwd}`,
  );
  const legacyReceipt: DoneRequiredCommandReceipt = {
    label: 'suite',
    command: 'npm',
    args: ['test'],
    cwd: worktreeRoot,
    commandSpec: legacyEnv,
    shell: false,
    status: 'PASS',
    exitCode: 0,
    durationMs: 1,
    outputDigest: 'x',
    outputTail: '',
    startedAt: '1970-01-01T00:00:00.000Z',
    endedAt: '1970-01-01T00:00:00.001Z',
  };
  const legacyCoverage = validateCommandSpecDigestCoverage({ receipts: [legacyReceipt] }, worktreeRoot, [cmd]);
  check(
    'CHK-002 legacy absolute-cwd receipt still verifies under the migration',
    legacyCoverage.valid === true,
    JSON.stringify(legacyCoverage.reasons),
  );

  // ── CHK-003: physical cwd is non-digested provenance ────────────────────────
  check(
    'CHK-003 resolvedCwd records the absolute physical workspace path',
    envMain.resolvedCwd === mainRoot && envWorktree.resolvedCwd === worktreeRoot,
    `${envMain.resolvedCwd} / ${envWorktree.resolvedCwd}`,
  );
  check(
    'CHK-003 resolvedCwd is excluded from the digest (differs while digest stays equal)',
    envMain.resolvedCwd !== envWorktree.resolvedCwd && envMain.digest === envWorktree.digest,
    `${envMain.resolvedCwd} vs ${envWorktree.resolvedCwd}`,
  );

  cleanupAll();
  console.log('worktree-portability smoke passed');
} catch (err) {
  console.error('✗ worktree-portability smoke FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  cleanupAll();
  process.exit(1);
}
