#!/usr/bin/env node
/**
 * B-0e53 — DONE pre-merge mainSha re-check smoke.
 *
 * Closes the one residual DONE race: an EXTERNAL git advance to main between the
 * DONE pre-check sync (autoSyncMain) and the in-lock merge. The fix
 * (transition-orchestrator.ts) captures main's sha right AFTER autoSyncMain and
 * re-reads it just BEFORE store.writeStory persists phase=DONE; if main advanced
 * externally in that window the transition ABORTS with a resync hint, leaving the
 * story at TEST (no partial DONE, no merge landed). Fail-open on an unreadable
 * sha.
 *
 * This smoke drives a REAL story_advance DONE end-to-end (black box: it shells
 * out to the built lattice CLI in an ISOLATED temp git repo with a linked story
 * worktree, exactly like done-preflight-smoke) and proves both paths:
 *
 *   ABORT PATH — an external advance to main happens between the pre-check sync
 *     and the in-lock merge. We inject it deterministically and realistically:
 *     a tiny `git` shim placed FIRST on PATH for the CLI child intercepts the
 *     pre-merge merge-tree dry-run (`git merge-tree --write-tree main HEAD`,
 *     the LAST step of runDonePreMergeGate — i.e. strictly AFTER the sync
 *     capture and strictly BEFORE the re-check) and, exactly ONCE, commits a new
 *     unrelated commit on `main` via the REAL git, advancing main's sha. The
 *     merge stays clean (the external commit touches an unrelated path), so the
 *     dry-run still succeeds; the re-check then observes main moved and aborts.
 *     Asserts: the CLI exits non-zero with the resync message; the persisted
 *     story phase is STILL TEST in BOTH stores; main's tip is the EXTERNAL
 *     commit (no DONE merge commit landed from this story); the story worktree
 *     and story branch survive (recoverable).
 *
 *   HAPPY PATH — main is unchanged inside the lock (no shim): story_advance DONE
 *     succeeds, reaches DONE, the normal merge lands, the worktree is removed and
 *     the story branch deleted. Proves the re-check does not regress the common
 *     DONE path.
 *
 * Isolated: temp git root + temp HOME + temp lattice locks, no global-lock
 * contention, no repo pollution. Exits non-zero on any failed assertion with a
 * clear message. Prints a final `✓ ... smoke passed (N checks)` line.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import type {
  ChecklistData,
  ClosingSelfCheck,
  DocsPromise,
  RealMachineTest,
  StoryInfo,
} from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

let checks = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    console.error(`✗ ${name}${detail ? `\n  ${detail}` : ''}`);
    process.exit(1);
  }
  checks++;
}

// ---------------------------------------------------------------------------
// Helpers (mirrors done-preflight-smoke's isolated linked-worktree harness)
// ---------------------------------------------------------------------------

const COMMIT_ENV = [
  '-c', 'user.email=smoke@example.test',
  '-c', 'user.name=Proofbound Smoke',
];

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

/** Run the built lattice CLI from `cwd`, returning stdout (throws on non-zero). */
function runLatticeFromCwd(
  cwd: string,
  command: string,
  args: Record<string, unknown>,
  envOverride: Record<string, string | undefined> = {},
): string {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
  const legacyAuthorityEnvPrefix = 'LATTICE_' + 'AUTHORITY_';
  for (const key of Object.keys(env)) {
    if (key.startsWith(legacyAuthorityEnvPrefix)) delete env[key];
  }
  for (const [key, value] of Object.entries(envOverride)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Run the CLI expecting a non-zero exit; returns the combined stdout+stderr+message. */
function runLatticeExpectFail(
  cwd: string,
  command: string,
  args: Record<string, unknown>,
  envOverride: Record<string, string | undefined> = {},
): string {
  try {
    runLatticeFromCwd(cwd, command, args, envOverride);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed but succeeded`);
}

function writeDoneGateEvidence(store: StoryStore, root: string, storyId: string): void {
  const now = '2026-06-18T10:00:00.000Z';
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  assert.ok(headHash, 'done premerge mainsha recheck fixture must have git HEAD for delivery-check freshness');
  assert.ok(materialHash, 'done premerge mainsha recheck fixture must have materialHash for delivery-check freshness');
  store.writeTestEvidence(storyId, {
    command: 'done-premerge-mainsha-recheck-smoke',
    output: JSON.stringify({ allPass: true, summary: 'done premerge mainsha recheck smoke passed' }),
    result: 'PASS',
    timestamp: now,
    headHash,
    materialHash,
    verificationCoverage: { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] },
  });

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'DONE pre-merge mainSha re-check smoke: external-advance abort + happy path verified.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'DONE pre-merge mainSha re-check verified (abort + happy path).',
  };
  store.writeDeliveryCheck(storyId, {
    storyId,
    checkedAt: now,
    headHash,
    materialHash,
    reviewRound: '',
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, '', materialHash),
  });
}

/**
 * Build a minimal TEST-phase story with a linked worktree and DONE-gate evidence
 * committed on the story branch. Main stays on branch main and clean throughout.
 * Returns the worktree path (the cwd that drives story_advance DONE) and root.
 */
function buildDoneReadyStoryWithLinkedWorktree(storyId: string): { root: string; worktreePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-premerge-recheck-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  }, null, 2));
  write(root, 'README.md', `done-premerge-mainsha-recheck-smoke ${storyId}\n`);
  write(root, '.gitignore', '.worktrees/\n.linked-worktrees/\n.lattice/activity.jsonl\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'base']);
  resetConfigCache();

  const now = '2026-06-18T10:00:00.000Z';
  const worktreePath = join(root, '.worktrees', storyId);
  const store = new StoryStore(root);

  const story: StoryInfo = {
    storyId,
    name: 'done-premerge-mainsha-recheck-smoke',
    title: `Done pre-merge mainSha re-check smoke ${storyId}`,
    description: 'Synthetic story for the DONE pre-merge mainSha re-check smoke.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    worktree: { path: `.worktrees/${storyId}`, branch: `story/${storyId}`, createdAt: now },
    events: [{ phase: 'TEST' as StoryInfo['phase'], action: 'advance', timestamp: now }],
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

  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story metadata']);
  git(root, ['branch', `story/${storyId}`]);
  git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

  resetConfigCache();
  const worktreeStore = new StoryStore(worktreePath);
  writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
  git(worktreePath, ['add', '.']);
  git(worktreePath, [...COMMIT_ENV, 'commit', '-m', 'done gate evidence']);

  return { root, worktreePath };
}

/**
 * Install a `git` shim FIRST on PATH for the CLI child process. The shim
 * intercepts the pre-merge merge-tree dry-run (the LAST git op in
 * runDonePreMergeGate, after the sync capture and before the re-check) and,
 * exactly ONCE (guarded by a marker file), uses the REAL git to commit a new
 * unrelated commit on `main` in the main repo — simulating an EXTERNAL advance
 * to main that lands between the pre-check sync and the in-lock merge. Every
 * other git invocation is forwarded unchanged to the real git.
 *
 * Returns { shimDir, realGit } so the caller can prepend shimDir to PATH.
 */
function installExternalAdvanceGitShim(mainRepoRoot: string): { shimDir: string; markerPath: string } {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
  assert.ok(realGit && existsSync(realGit), `smoke requires a resolvable real git (got "${realGit}")`);

  const shimDir = mkdtempSync(join(tmpdir(), 'lattice-premerge-gitshim-'));
  const markerPath = join(shimDir, 'advanced.marker');
  const shimPath = join(shimDir, 'git');

  // POSIX shell shim. On `merge-tree`, once, advance main externally via the
  // real git, then fall through to run the real git for the original command so
  // the dry-run itself still executes (and stays clean).
  const shim = [
    '#!/bin/sh',
    `REAL_GIT=${JSON.stringify(realGit)}`,
    `MARKER=${JSON.stringify(markerPath)}`,
    `MAIN_REPO=${JSON.stringify(mainRepoRoot)}`,
    'for a in "$@"; do',
    '  if [ "$a" = "merge-tree" ]; then',
    '    if [ ! -f "$MARKER" ]; then',
    '      : > "$MARKER"',
    '      # External actor advances main between the pre-check sync and the merge.',
    '      printf "external advance during DONE window\\n" > "$MAIN_REPO/external-advance.txt"',
    '      "$REAL_GIT" -C "$MAIN_REPO" add external-advance.txt >/dev/null 2>&1',
    '      "$REAL_GIT" -C "$MAIN_REPO" -c user.email=external@example.test -c user.name="External Actor" commit -m "external advance to main during DONE window" >/dev/null 2>&1',
    '    fi',
    '    break',
    '  fi',
    'done',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n');

  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { shimDir, markerPath };
}

// ---------------------------------------------------------------------------
// ABORT PATH: external advance to main during the pre-check→merge window.
// ---------------------------------------------------------------------------

function assertExternalAdvanceAbortsBeforePersist(): void {
  const storyId = 'B-premerge-abort';
  const { root, worktreePath } = buildDoneReadyStoryWithLinkedWorktree(storyId);
  let shimDir: string | undefined;
  try {
    const mainTipBeforeAdvance = git(root, ['rev-parse', 'main']);
    const mainHeadCommitsBefore = git(root, ['rev-list', '--count', 'main']);

    const shim = installExternalAdvanceGitShim(root);
    shimDir = shim.shimDir;

    // Prepend the shim so the CLL child resolves `git` to it first.
    const output = runLatticeExpectFail(
      worktreePath,
      'story_advance',
      { storyId, phase: 'DONE' },
      { PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` },
    );

    // Sanity: the shim actually fired (the external advance was injected).
    check(
      'abort: external-advance shim fired (marker written)',
      existsSync(shim.markerPath),
      'the merge-tree interception marker was never created — the injection did not run',
    );

    // The CLI must abort with the resync message naming the externally advanced main.
    check(
      'abort: CLI fails with the DONE-aborted resync message',
      /DONE aborted: main advanced/.test(output) && /stays at TEST/.test(output) && /Re-run story_advance DONE to resync/.test(output),
      `expected the pre-merge mainSha re-check abort message, got:\n${output}`,
    );

    // phase=DONE must NEVER have been persisted — story stays TEST in BOTH stores.
    check(
      'abort: story phase stays TEST in the worktree store (no partial DONE)',
      new StoryStore(worktreePath).readStory(storyId).phase === 'TEST',
      `worktree store phase=${new StoryStore(worktreePath).readStory(storyId).phase}`,
    );
    check(
      'abort: story phase stays TEST in the main store (no partial DONE)',
      new StoryStore(root).readStory(storyId).phase === 'TEST',
      `main store phase=${new StoryStore(root).readStory(storyId).phase}`,
    );

    // main's tip must be the EXTERNAL commit — exactly one commit ahead of the
    // pre-advance tip — and NO DONE merge commit from this story landed.
    const mainTipAfter = git(root, ['rev-parse', 'main']);
    const mainHeadCommitsAfter = git(root, ['rev-list', '--count', 'main']);
    check(
      'abort: main advanced by exactly the one external commit',
      mainTipAfter !== mainTipBeforeAdvance && Number(mainHeadCommitsAfter) === Number(mainHeadCommitsBefore) + 1,
      `main tip ${mainTipBeforeAdvance} -> ${mainTipAfter}; commit count ${mainHeadCommitsBefore} -> ${mainHeadCommitsAfter}`,
    );
    const mainTipSubject = git(root, ['log', '-1', '--format=%s', 'main']);
    check(
      'abort: main tip is the external commit, NOT a DONE merge of the story branch',
      mainTipSubject.includes('external advance to main during DONE window') && !/merge .*story\//i.test(mainTipSubject),
      `main tip subject was: ${mainTipSubject}`,
    );
    check(
      'abort: no merge commit from this story branch landed on main',
      git(root, ['log', '--oneline', `${mainTipBeforeAdvance}..main`]).split('\n').filter(Boolean).length === 1,
      `${mainTipBeforeAdvance}..main contained more than the single external commit`,
    );

    // The story worktree + branch survive so the operator can re-run DONE.
    check(
      'abort: story worktree survives (recoverable)',
      existsSync(worktreePath),
      'worktree directory was removed despite the abort',
    );
    check(
      'abort: story branch survives (recoverable)',
      git(root, ['branch', '--list', `story/${storyId}`]) !== '',
      'story branch was deleted despite the abort',
    );

    console.log('  ✓ ABORT: external main advance between sync and merge aborts before phase=DONE persists');
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (shimDir) rmSync(shimDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// HAPPY PATH: main unchanged inside the lock → DONE succeeds, normal merge.
// ---------------------------------------------------------------------------

function assertUnchangedMainStillCompletesDone(): void {
  const storyId = 'B-premerge-happy';
  const { root, worktreePath } = buildDoneReadyStoryWithLinkedWorktree(storyId);
  try {
    const output = runLatticeFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });

    check(
      'happy: CLI reports advanced to DONE',
      output.includes(`Story ${storyId} advanced to DONE`),
      `expected DONE success, got:\n${output}`,
    );
    check(
      'happy: story is DONE in the main store',
      new StoryStore(root).readStory(storyId).phase === 'DONE',
      `main store phase=${new StoryStore(root).readStory(storyId).phase}`,
    );
    check(
      'happy: the DONE merge landed (story branch merged into main)',
      git(root, ['log', '--oneline', 'main']).split('\n').some(l => /done gate evidence|story metadata/.test(l)),
      'main does not contain the story branch commits — the merge did not land',
    );
    check(
      'happy: story worktree removed on success',
      !existsSync(worktreePath),
      'worktree directory was not removed on the happy DONE path',
    );
    check(
      'happy: story branch deleted on success',
      git(root, ['branch', '--list', `story/${storyId}`]) === '',
      'story branch was not deleted on the happy DONE path',
    );

    console.log('  ✓ HAPPY: unchanged main inside the lock completes DONE with the normal merge');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

assertExternalAdvanceAbortsBeforePersist();
assertUnchangedMainStillCompletesDone();

console.log(`✓ done-premerge-mainsha-recheck-smoke passed (${checks} checks)`);
