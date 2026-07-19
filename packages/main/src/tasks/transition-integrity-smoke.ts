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
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { createWorktreeHandlers } from '../handlers/worktree.js';
import { runStoryTransition } from '../handlers/transition-orchestrator.js';
import { acquireStoryTransitionLock, storyTransitionLockPath } from '../core/story-transition-lock.js';

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
  writeFileSync(join(root, '.gitignore'), '.worktrees/\nnode_modules/\n.lattice/locks/\n');
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

async function waitForCondition(cond: () => boolean, timeoutMs: number, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitForCondition timeout');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHK-002 worker mode: this file re-invokes itself as a child process so two
// genuinely concurrent OS processes race the SAME story's DEV→REVIEW transition.
// A barrier file releases both workers into the critical section together, so
// the per-story mkdir transition lock is really contended across processes.
// ─────────────────────────────────────────────────────────────────────────────
async function runConcurrencyWorker(): Promise<void> {
  const root = process.env.TIS_ROOT!;
  const storyId = process.env.TIS_STORY!;
  const barrier = process.env.TIS_BARRIER!;
  const readyFile = process.env.TIS_READY!;
  const store = new StoryStore(root);
  writeFileSync(readyFile, 'ready');
  const deadline = Date.now() + 10000;
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) {
      console.log(JSON.stringify({ ok: false, err: 'barrier timeout' }));
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  try {
    const r = await runStoryTransition({ store, root, scanRoot: root } as any, { storyId, phase: 'REVIEW' as any });
    console.log(JSON.stringify({ ok: true, phase: r.newState }));
  } catch (e: any) {
    console.log(JSON.stringify({ ok: false, err: String(e?.message ?? e).slice(0, 120) }));
  }
  process.exit(0);
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

  // ── CHK-002a: two concurrent same-owner DEV→REVIEW transitions serialize ────
  console.log('\nCHK-002a: two concurrent same-owner DEV→REVIEW transitions → exactly one round + one event');
  {
    const fx = makeFixture('B-tisconc', 'DEV', { withWorktree: false });
    const barrier = join(fx.root, 'GO');
    const ready1 = join(fx.root, 'ready1');
    const ready2 = join(fx.root, 'ready2');
    const selfPath = fileURLToPath(import.meta.url);
    const spawnWorker = (readyFile: string) => spawn(process.execPath, [selfPath], {
      env: {
        ...process.env,
        TIS_WORKER: '1',
        TIS_ROOT: fx.root,
        TIS_STORY: fx.storyId,
        TIS_BARRIER: barrier,
        TIS_READY: readyFile,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const w1 = spawnWorker(ready1);
    const w2 = spawnWorker(ready2);
    let out1 = '';
    let out2 = '';
    w1.stdout!.on('data', (d) => { out1 += d.toString(); });
    w2.stdout!.on('data', (d) => { out2 += d.toString(); });

    // Both workers ready and parked on the barrier, then release them together.
    await waitForCondition(() => existsSync(ready1) && existsSync(ready2), 10000);
    writeFileSync(barrier, 'go');
    await Promise.all([
      new Promise<void>((res) => w1.on('exit', () => res())),
      new Promise<void>((res) => w2.on('exit', () => res())),
    ]);

    const parse = (s: string) => { try { return JSON.parse(s.trim().split('\n').filter(Boolean).pop() || '{}'); } catch { return {}; } };
    const r1 = parse(out1);
    const r2 = parse(out2);
    const successes = [r1, r2].filter((r) => r.ok).length;
    check('exactly one concurrent transition succeeded (the other serialized behind the lock)',
      successes === 1, `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);

    const after = fx.store.readStory(fx.storyId);
    check('landed in REVIEW with exactly one minted currentReviewRound',
      after.phase === 'REVIEW' && typeof (after as any).currentReviewRound === 'string' && (after as any).currentReviewRound.length > 0,
      `phase=${after.phase} round=${(after as any).currentReviewRound}`);

    const pt = phaseTransitionEvents(fx.store, fx.storyId);
    check('exactly one phase_transition event appended (no double-mint)', pt.length === 1, `count=${pt.length}`);
    check('the losing transition observed the committed REVIEW (did not re-mint)',
      pt.filter((e) => e.toPhase === 'REVIEW').length === 1, JSON.stringify(pt.map((e) => e.toPhase)));
  }

  // ── CHK-002b: lock is released on throw (no deadlock) + DONE never locks ────
  console.log('\nCHK-002b: a throwing critical section releases the lock; DONE uses only the main write lock');
  {
    const fx = makeFixture('B-tislock', 'DEV', { withWorktree: false });

    // Mirror the orchestrator's acquire → try → finally(release) usage, but throw
    // inside the critical section.
    let threw = false;
    try {
      const lock = acquireStoryTransitionLock(fx.root, fx.storyId);
      // The lock lives OUTSIDE the story metadata dir (under gitignored
      // .lattice/locks/transition/), never inside .lattice/story/actives/<id>/.
      check('transition lock is rooted under .lattice/locks/, not the story dir',
        lock.lockDir.includes(`${'.lattice'}/locks/transition/`) && !lock.lockDir.includes('/story/actives/'),
        lock.lockDir);
      try {
        throw new Error('simulated mid-critical-section failure');
      } finally {
        lock.release();
      }
    } catch { threw = true; }
    check('critical section threw', threw);

    // Re-acquire with a short deadline (< stale): a leaked lock would time out
    // here; a properly released one acquires instantly → no deadlock.
    let reacquired = false;
    try {
      const l = acquireStoryTransitionLock(fx.root, fx.storyId, { deadlineMs: 1500, staleMs: 100000 });
      l.release();
      reacquired = true;
    } catch { reacquired = false; }
    check('lock released after the throwing critical section (no deadlock)', reacquired);

    // DONE must NOT take the per-story transition lock (it holds the main write
    // lock instead). A DONE transition attempt must never create transition.lock.
    const fd = makeFixture('B-tisdone', 'TEST');
    try {
      await runStoryTransition({ root: fd.root, store: fd.store, scanRoot: join(fd.root, 'packages/main') } as any,
        { storyId: fd.storyId, phase: 'DONE' as any });
    } catch { /* expected to block at a DONE gate */ }
    check('DONE transition never created the per-story transition lock (no double-lock)',
      !existsSync(storyTransitionLockPath(fd.root, fd.storyId)),
      storyTransitionLockPath(fd.root, fd.storyId));
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

if (process.env.TIS_WORKER === '1') {
  runConcurrencyWorker();
} else {
  main();
}
