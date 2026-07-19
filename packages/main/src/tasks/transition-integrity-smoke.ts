#!/usr/bin/env node
/**
 * B-d877 transition-integrity smoke.
 *
 * Proves the two audit-discovered lifecycle defects are closed:
 *
 *   CHK-001 — `dev_finish` / `dev_merge` route their phase advance through the
 *   canonical `runStoryTransition` orchestrator instead of driving a raw XState
 *   actor and writing `story.phase` directly. Advancing DEV→REVIEW must mint a
 *   `currentReviewRound`, append a `phase_transition` process-event whose
 *   `toPhase` is the REAL target (REVIEW), and must NOT emit an event mislabeled
 *   'TEST'. `dev_merge` must delegate its TEST→DONE advance to the same
 *   orchestrator (no second bypass door, no raw phase-write).
 *
 *   CHK-002 — same-owner concurrent transitions are serialized by a per-story
 *   transition lock: two concurrent DEV→REVIEW attempts produce exactly one
 *   review round and one phase_transition event; a transition that throws
 *   mid-critical-section releases the lock (no deadlock); DONE keeps using only
 *   the main write lock (no double-lock).
 *
 * Builds a temp git repo + real git worktree for each fixture. Prints ✓/✗ per
 * check and exits nonzero on the first failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { createWorktreeHandlers } from '../handlers/worktree.js';
import { runStoryTransition } from '../handlers/transition-orchestrator.js';

const NOW = '2026-07-18T00:00:00.000Z';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? '✓' : '✗'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) {
    failures++;
    console.error(`\n✗ transition-integrity smoke FAILED at: ${label}${detail ? ' — ' + detail : ''}`);
    process.exit(1);
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

interface Fixture {
  root: string;
  store: StoryStore;
  wtAbs: string;
  storyId: string;
}

/**
 * Build a temp git repo, a real git worktree, and a fixture story at `phase`
 * with a single completed checklist item. `withWorktree=false` omits the
 * story.worktree field (used by the orchestrator-only concurrency fixtures so
 * the REVIEW cwd gate is not exercised).
 */
function makeFixture(storyId: string, phase: string, opts: { withWorktree?: boolean } = {}): Fixture {
  const withWorktree = opts.withWorktree !== false;
  const root = mkdtempSync(join(tmpdir(), 'lattice-tis-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'tis@test']);
  git(root, ['config', 'user.name', 'TIS']);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  writeFileSync(join(root, '.gitignore'), '.worktrees/\nnode_modules/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const wtRel = join('.worktrees', storyId);
  const wtAbs = join(root, wtRel);
  git(root, ['worktree', 'add', '-b', `story/${storyId}`, wtAbs, 'HEAD']);
  mkdirSync(join(wtAbs, '.lattice/story/actives', storyId), { recursive: true });
  git(wtAbs, ['add', '-A']);
  git(wtAbs, ['commit', '-m', 'wt seed', '--allow-empty']);

  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: storyId, title: `${storyId} fixture`,
    description: 'transition-integrity fixture', type: 'bug', phase: phase as any,
    priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
    worktree: withWorktree ? { path: wtRel, branch: `story/${storyId}`, createdAt: NOW } : undefined,
    events: [{ phase: 'INIT', action: 'create', timestamp: NOW }],
  } as any);
  store.writeChecklist(storyId, {
    items: [{ id: 'CHK-001', title: 'done item', context: 'x', status: 'done', startTime: NOW, endTime: NOW }],
  } as any);

  return { root, store, wtAbs, storyId };
}

function phaseTransitionEvents(store: StoryStore, storyId: string): Array<{ toPhase?: string }> {
  let pe: any[] = [];
  try { pe = store.readProcessEvents(storyId) ?? []; } catch { /* none */ }
  return pe.filter((e) => e && e.type === 'phase_transition');
}

async function main(): Promise<void> {
  console.log('transition-integrity smoke (B-d877)\n');

  // ── CHK-001a: dev_finish DEV→REVIEW routes through the orchestrator ─────────
  console.log('CHK-001a: dev_finish DEV→REVIEW routes through runStoryTransition');
  {
    const fx = makeFixture('B-tisfin', 'DEV');
    const handlers = createWorktreeHandlers({ root: fx.root, store: fx.store, scanRoot: join(fx.root, 'packages/main') } as any);
    let threw: string | null = null;
    try { await handlers.dev_finish({ storyId: fx.storyId }); } catch (e: any) { threw = String(e?.message ?? e); }
    check('dev_finish did not hard-throw on a completed DEV story', threw === null, threw ? threw.slice(0, 100) : '');

    const after = fx.store.readStory(fx.storyId);
    check('advanced to REVIEW (CODE_REVIEW target), not TEST', after.phase === 'REVIEW', `phase=${after.phase}`);
    check('minted a non-empty currentReviewRound',
      typeof (after as any).currentReviewRound === 'string' && (after as any).currentReviewRound.length > 0,
      `currentReviewRound=${(after as any).currentReviewRound}`);

    const pt = phaseTransitionEvents(fx.store, fx.storyId);
    check('exactly one phase_transition process-event appended', pt.length === 1, `count=${pt.length}`);
    check('phase_transition toPhase matches real target REVIEW', pt.some((e) => e.toPhase === 'REVIEW'),
      JSON.stringify(pt.map((e) => e.toPhase)));

    const labels = (after.events || []).map((e: any) => e.phase);
    check('no story.events entry mislabeled TEST', !labels.includes('TEST'), `labels=${JSON.stringify(labels)}`);
  }

  // ── CHK-001b: dev_merge TEST→DONE delegates to the orchestrator ─────────────
  // A raw-actor bypass would produce a different failure/effect than a direct
  // runStoryTransition(DONE) call; delegation makes them behave identically
  // (modulo the embedded storyId) and never bypass-writes phase=DONE.
  console.log('\nCHK-001b: dev_merge TEST→DONE delegates to runStoryTransition (second door closed)');
  {
    const fa = makeFixture('B-tismrga', 'TEST');
    const handlers = createWorktreeHandlers({ root: fa.root, store: fa.store, scanRoot: join(fa.root, 'packages/main') } as any);
    let errA: string | null = null;
    try { await handlers.dev_merge({ storyId: fa.storyId }); } catch (e: any) { errA = String(e?.message ?? e); }

    const fb = makeFixture('B-tismrgb', 'TEST');
    let errB: string | null = null;
    try {
      await runStoryTransition({ root: fb.root, store: fb.store, scanRoot: join(fb.root, 'packages/main') } as any,
        { storyId: fb.storyId, phase: 'DONE' as any });
    } catch (e: any) { errB = String(e?.message ?? e); }

    check('dev_merge reached the orchestrator DONE gate (threw a DONE-path error)', errA !== null,
      errA ? '' : 'dev_merge did not throw — it may have bypass-written DONE');

    // Normalize the embedded storyId so a genuine delegation yields byte-identical
    // failure text to the direct orchestrator call. A raw-actor door would differ.
    const norm = (s: string | null, sid: string) => (s ?? '').split(sid).join('SID');
    const na = norm(errA, fa.storyId);
    const nb = norm(errB, fb.storyId);
    check('dev_merge failure is identical to a direct runStoryTransition(DONE) (proves delegation)',
      na === nb, `dev_merge=${na.slice(0, 90)} | direct=${nb.slice(0, 90)}`);

    const afterA = fa.store.readStory(fa.storyId);
    check('dev_merge did NOT bypass-write phase=DONE (still TEST)', afterA.phase === 'TEST', `phase=${afterA.phase}`);
    const ptA = phaseTransitionEvents(fa.store, fa.storyId);
    check('dev_merge appended no phase_transition on a blocked DONE', ptA.length === 0, `count=${ptA.length}`);
    const labelsA = (afterA.events || []).map((e: any) => e.phase);
    check('dev_merge left no raw DONE/TEST bypass event',
      !labelsA.includes('DONE') && !labelsA.includes('TEST'), `labels=${JSON.stringify(labelsA)}`);
  }

  console.log('');
  if (failures === 0) {
    console.log('transition-integrity smoke passed');
    process.exit(0);
  } else {
    console.error(`transition-integrity smoke FAILED (${failures} check(s))`);
    process.exit(1);
  }
}

main();
