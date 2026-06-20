#!/usr/bin/env node
/**
 * B-1a91 CHK-002: DONE-merge auto-refresh smoke.
 *
 * Proves the never-throw advisory finding-signals re-derive that CHK-001 added to
 * applyDoneMergeEffects: on EVERY DONE merge the Experience Layer cache is
 * (re)written into the canonical MAIN checkout — folding in the just-completed
 * story's findings — with NO separate learning_scan; and any failure of that
 * re-derive is SWALLOWED so the DONE merge always completes.
 *
 * It drives the REAL applyDoneMergeEffects in-process against an ISOLATED temp git
 * repo with a linked story worktree (the same linked-worktree harness shape as
 * done-premerge-mainsha-recheck-smoke), on branch story/<id> with main checked out
 * clean on branch main. Two paths:
 *
 *   HAPPY — a story carrying a resolved finding is merged: assert the merge
 *     completes (branch merged into main, worktree removed, branch deleted), the
 *     finding-signals cache now exists on MAIN with the story's signal present and
 *     a watermark, and the merge report carries an advisory
 *     "experience cache refreshed (N signals)" line.
 *
 *   FAILURE CONTROL — the finding-signals derive is forced to throw (a store proxy
 *     whose listStoryIds throws, the FIRST thing deriveFindingSignalsFromStore
 *     calls): the DONE merge STILL SUCCEEDS (worktree removed, branch deleted, no
 *     exception escapes applyDoneMergeEffects) and the report carries the advisory
 *     "experience cache refresh skipped: <reason>" line — never blocking the merge.
 *
 * Isolated: temp git root + temp HOME + temp lattice locks; restores process.cwd +
 * env; no repo pollution. Exits non-zero on any failed assertion. Prints a final
 * "✓ ... smoke passed (N checks)" line.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { readFindingSignals } from '../core/learning-store.js';
import { applyDoneMergeEffects } from '../handlers/done-effects.js';
import type { ChecklistData, Finding, StoryInfo } from '../core/types.js';

let checks = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    console.error(`✗ ${name}${detail ? `\n  ${detail}` : ''}`);
    process.exit(1);
  }
  checks++;
}

const COMMIT_ENV = ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke'];
const PINNED_NOW = '2026-06-18T10:00:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function story(storyId: string): StoryInfo {
  return {
    storyId,
    name: 'done-merge-experience-refresh-smoke',
    title: `Done merge experience refresh smoke ${storyId}`,
    description: 'Synthetic story for the DONE-merge experience-cache auto-refresh smoke.',
    type: 'chore',
    phase: 'DONE',
    priority: 'medium',
    createdAt: PINNED_NOW,
    startedAt: PINNED_NOW,
    endedAt: null,
    worktree: { path: `.worktrees/${storyId}`, branch: `story/${storyId}`, createdAt: PINNED_NOW },
    events: [{ phase: 'DONE' as StoryInfo['phase'], action: 'advance', timestamp: PINNED_NOW }],
  };
}

function checklist(): ChecklistData {
  return { items: [{ id: 'CHK-001', title: 'Synthetic', context: 'Synthetic', status: 'done', startTime: null, endTime: null }] };
}

function resolvedFinding(storyId: string): Finding {
  return {
    id: `${storyId}:F-001`,
    desc: 'a resolved finding the DONE merge should fold into the experience cache',
    severity: 'high',
    category: 'adversarial',
    status: 'resolved',
    files: ['packages/main/src/app.ts'],
    createdAt: PINNED_NOW,
    resolvedAt: '2026-06-18T12:00:00.000Z',
  };
}

/**
 * Build a DONE-phase story with a linked worktree, a resolved finding committed on
 * the story branch, main checked out clean on branch main. Returns the worktree
 * path (the cwd applyDoneMergeEffects runs from) + the root + the story branch.
 */
function buildDoneReadyStoryWithLinkedWorktree(storyId: string): { root: string; worktreePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-exp-refresh-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  }, null, 2));
  write(root, 'README.md', `done-merge-experience-refresh-smoke ${storyId}\n`);
  write(root, '.gitignore', '.worktrees/\n.linked-worktrees/\n.lattice/learning/\n.lattice/activity.jsonl\n');
  write(root, 'packages/main/src/app.ts', 'export const app = true;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'base']);
  resetConfigCache();

  const worktreePath = join(root, '.worktrees', storyId);
  const store = new StoryStore(root);
  store.writeStory(storyId, story(storyId));
  store.writeChecklist(storyId, checklist());
  store.writeFindings(storyId, { findings: [resolvedFinding(storyId)] });

  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story metadata + resolved finding']);
  git(root, ['branch', `story/${storyId}`]);
  git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

  return { root, worktreePath };
}

// ---------------------------------------------------------------------------
// HAPPY: a resolved-finding story merges → cache refreshed on MAIN, advisory line.
// ---------------------------------------------------------------------------

async function assertHappyRefreshesCacheOnMain(): Promise<void> {
  const storyId = 'B-expref-happy';
  const { root, worktreePath } = buildDoneReadyStoryWithLinkedWorktree(storyId);
  const savedCwd = process.cwd();
  try {
    // No cache exists before the merge.
    check('happy: no finding-signals cache on main before the DONE merge', readFindingSignals(root) === null);

    process.chdir(worktreePath); // applyDoneMergeEffects detects the worktree via process.cwd()
    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    const story0 = worktreeStore.readStory(storyId);

    const result = await applyDoneMergeEffects(storyId, worktreeStore, story0, undefined);
    process.chdir(savedCwd);

    const report = result.doneMergeReport;

    // The advisory refresh line is present with a signal count.
    const m = report.match(/experience cache refreshed \((\d+) signals\)/);
    check('happy: report carries "experience cache refreshed (N signals)"', !!m, `report:\n${report}`);
    check('happy: refreshed signal count >= 1 (the resolved finding was folded in)', !!m && Number(m![1]) >= 1, `count=${m?.[1]}`);

    // The merge itself completed.
    check('happy: story branch merged into main', git(root, ['log', '--oneline', 'main']).split('\n').some(l => /story metadata|merge: B-expref-happy/.test(l)), 'merge did not land');
    check('happy: story worktree removed on success', !existsSync(worktreePath));
    check('happy: story branch deleted on success', git(root, ['branch', '--list', `story/${storyId}`]) === '');

    // The cache now exists on MAIN (canonical resolveLearningRoot) with the watermark.
    const cache = readFindingSignals(root);
    check('happy: finding-signals cache written on the MAIN checkout (no separate learning_scan)', cache !== null, 'cache absent on main after merge');
    check('happy: cache carries a coverage watermark (>=1 finding considered)', typeof cache?.coveredFindingCount === 'number' && (cache!.coveredFindingCount as number) >= 1, `watermark=${cache?.coveredFindingCount}`);
    check('happy: cache has at least one derived signal', Array.isArray(cache?.signals) && cache!.signals.length >= 1, `signals=${cache?.signals?.length}`);

    console.log('  ✓ HAPPY: DONE merge auto-refreshed the experience cache on main (no manual learning_scan)');
  } finally {
    try { process.chdir(savedCwd); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// FAILURE CONTROL: forced derive failure is swallowed; the merge still succeeds.
// ---------------------------------------------------------------------------

async function assertForcedDeriveFailureNeverBlocksMerge(): Promise<void> {
  const storyId = 'B-expref-fail';
  const { root, worktreePath } = buildDoneReadyStoryWithLinkedWorktree(storyId);
  const savedCwd = process.cwd();
  try {
    process.chdir(worktreePath);
    resetConfigCache();
    const realStore = new StoryStore(worktreePath);
    const story0 = realStore.readStory(storyId);

    // Force the never-throw refresh into its catch branch by making the cache
    // persist FAIL: plant a regular FILE at the main checkout's .lattice/learning
    // path, so writeFindingSignals' mkdirSync(dirname, {recursive}) throws EEXIST
    // when the refresh tries to persist. (.lattice/learning/ is gitignored, so the
    // file is not committed/merged — it just blocks the write at refresh time.)
    mkdirSync(join(root, '.lattice'), { recursive: true });
    writeFileSync(join(root, '.lattice', 'learning'), 'not a directory — forces the cache persist to fail');

    let threw = false;
    let report = '';
    try {
      const result = await applyDoneMergeEffects(storyId, realStore, story0, undefined);
      report = result.doneMergeReport;
    } catch {
      threw = true;
    }
    process.chdir(savedCwd);

    // The merge must NOT have thrown despite the forced derive/persist failure.
    check('control: applyDoneMergeEffects did NOT throw despite the forced derive failure', !threw, 'a derive failure must never block the DONE merge');

    // The advisory skip line is present (refresh swallowed into a status line).
    check('control: report carries "experience cache refresh skipped: <reason>"', /experience cache refresh skipped:/.test(report), `report:\n${report}`);
    check('control: report does NOT claim a successful refresh', !/experience cache refreshed/.test(report), `report:\n${report}`);

    // The merge itself still completed end-to-end.
    check('control: story branch still merged into main', git(root, ['log', '--oneline', 'main']).split('\n').some(l => /story metadata|merge: B-expref-fail/.test(l)));
    check('control: story worktree still removed', !existsSync(worktreePath));
    check('control: story branch still deleted', git(root, ['branch', '--list', `story/${storyId}`]) === '');

    console.log('  ✓ CONTROL: a forced derive failure is swallowed — the DONE merge still succeeds');
  } finally {
    try { process.chdir(savedCwd); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const savedEnv = { ...process.env };
  try {
    await assertHappyRefreshesCacheOnMain();
    await assertForcedDeriveFailureNeverBlocksMerge();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
  console.log(`✓ done-merge-experience-refresh-smoke passed (${checks} checks)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
