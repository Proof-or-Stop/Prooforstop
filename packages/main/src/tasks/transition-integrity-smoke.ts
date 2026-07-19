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
 *   mid-critical-section releases the lock (no deadlock). B-d877 Finding 2: DONE
 *   now UNIFORMLY takes the per-story transition lock too (acquired BEFORE the
 *   main merge lock; fixed ordering), so a DONE and a concurrent same-story
 *   rollback mutually exclude and DONE must not self-deadlock or leak the lock.
 *
 *   B-d877 Finding 1 — the mkdir lock is safe held across a transition: a LIVE
 *   same-host holder is never stale-reclaimed by a waiter even past staleMs
 *   (pid-liveness classifier), and release() is OWNERSHIP-CHECKED so a
 *   stale-reclaimed holder's late release cannot delete a successor's lock dir.
 *
 * Builds a temp git repo + real git worktree for each fixture. Prints ✓/✗ per
 * check and exits nonzero on the first failure.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { createWorktreeHandlers } from '../handlers/worktree.js';
import { runStoryTransition } from '../handlers/transition-orchestrator.js';
import {
  acquireStoryTransitionLock,
  classifyTransitionLockHolder,
  storyTransitionLockPath,
} from '../core/story-transition-lock.js';
import { acquireMkdirLock, readMkdirLockHolder } from '../core/mkdir-lock.js';
import type { ExistingMkdirLockSnapshot } from '../core/mkdir-lock.js';

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

/**
 * B-d877 Finding 4 (F-001): run `fn` with process.cwd() pinned to `dir`, then
 * restore the previous cwd. The DONE path calls detectDoneStoryWorktreeContext()
 * / acquireDoneMainMergeLock() with the default `invocationCwd = process.cwd()`;
 * pinning it to the fixture's own root makes the dev_merge-delegation comparison
 * deterministic (it no longer leaks the smoke's invoking cwd/branch).
 */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
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
    // B-d877 Finding 4 (F-001): pin process.cwd() to each fixture's own root so
    // the DONE path's detectDoneStoryWorktreeContext()/acquireDoneMainMergeLock()
    // resolve against the fixture — not the (variable) directory the smoke was
    // launched from. Both fixtures are structurally identical, so the failure
    // text is deterministic and no longer leaks the invoking cwd/branch.
    const fa = makeFixture('B-tismrga', 'TEST');
    const handlers = createWorktreeHandlers({ root: fa.root, store: fa.store, scanRoot: join(fa.root, 'packages/main') } as any);
    let errA: string | null = null;
    await withCwd(fa.root, async () => {
      try { await handlers.dev_merge({ storyId: fa.storyId }); } catch (e: any) { errA = String(e?.message ?? e); }
    });

    const fb = makeFixture('B-tismrgb', 'TEST');
    let errB: string | null = null;
    await withCwd(fb.root, async () => {
      try {
        await runStoryTransition({ root: fb.root, store: fb.store, scanRoot: join(fb.root, 'packages/main') } as any,
          { storyId: fb.storyId, phase: 'DONE' as any });
      } catch (e: any) { errB = String(e?.message ?? e); }
    });

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

    // B-d877 Finding 5: register the exit-promise listeners BEFORE releasing the
    // barrier. A worker can win the lock and exit almost immediately after `go`;
    // if the exit listener were attached only AFTER writeFileSync(barrier), that
    // early exit event would be missed and Promise.all would hang until timeout.
    // `child_process` exit is emitted asynchronously, but attaching the listener
    // up-front guarantees it is observed regardless of how fast the child exits.
    const exited = Promise.all([
      new Promise<void>((res) => w1.on('exit', () => res())),
      new Promise<void>((res) => w2.on('exit', () => res())),
    ]);

    // Both workers ready and parked on the barrier, then release them together.
    await waitForCondition(() => existsSync(ready1) && existsSync(ready2), 10000);
    writeFileSync(barrier, 'go');
    await exited;

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

  // ── CHK-002b: lock released on throw (no deadlock); DONE uniformly locks ─────
  console.log('\nCHK-002b: a throwing critical section releases the lock; DONE uniformly takes + releases the transition lock (Finding 2)');
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

    // B-d877 Finding 2: DONE now UNIFORMLY acquires the per-story transition lock
    // (BEFORE acquireDoneMainMergeLock; fixed lock ordering). The DONE attempt
    // must NOT self-deadlock on the two locks, and must release the transition
    // lock on every exit path (the finally). A pinned cwd keeps the DONE path
    // deterministic. We time the attempt to prove it returns promptly rather than
    // hanging on a lock-ordering deadlock.
    const fd = makeFixture('B-tisdone', 'TEST');
    const doneStart = Date.now();
    await withCwd(fd.root, async () => {
      try {
        await runStoryTransition({ root: fd.root, store: fd.store, scanRoot: join(fd.root, 'packages/main') } as any,
          { storyId: fd.storyId, phase: 'DONE' as any });
      } catch { /* expected to block at a DONE gate */ }
    });
    const doneElapsed = Date.now() - doneStart;
    check('DONE transition did not self-deadlock on the two locks (returned promptly)',
      doneElapsed < 60000, `elapsed=${doneElapsed}ms`);
    check('DONE released the per-story transition lock after uniform acquisition (not leaked)',
      !existsSync(storyTransitionLockPath(fd.root, fd.storyId)),
      storyTransitionLockPath(fd.root, fd.storyId));
    // The lock is acquirable again immediately after DONE finishes/aborts, which
    // also proves DONE did not leave the transition lock held.
    let postDoneAcq = false;
    try {
      const l = acquireStoryTransitionLock(fd.root, fd.storyId, { deadlineMs: 1500, staleMs: 100000 });
      l.release();
      postDoneAcq = true;
    } catch { postDoneAcq = false; }
    check('transition lock is free after a DONE attempt (uniform acquire released it)', postDoneAcq);
  }

  // ── CHK-002c: liveness classifier — live holder kept, dead / reused pid / other ─
  // B-d877 R2 FIX C + FIX E: a same-process second acquire now FAILS FAST (in-process
  // deadlock guard, exercised in CHK-002f), so the "live holder not reclaimed" and
  // "reused pid reclaimed" behaviors are proven at the classifier level here — the
  // exact unit a cross-process waiter consults before reclaiming.
  console.log('\nCHK-002c: liveness classifier keeps a live holder, reclaims a dead/reused pid, defers on other host/errno (Finding 1b + FIX C)');
  {
    const snap = (holder: Record<string, unknown> | null, ageMs = 999_999): ExistingMkdirLockSnapshot => ({
      lockDir: '/tmp/does-not-matter.lock',
      holder: holder as any,
      ageMs,
      staleMs: 100,
      nowMs: Date.now(),
    });
    const start = Math.floor(Date.now() - (process.uptime() * 1000));

    // Live same-host holder (THIS pid) — 'active' even with ageMs far past staleMs.
    check('a LIVE same-host holder (this pid) classifies active regardless of mtime age',
      classifyTransitionLockHolder(snap({
        pid: process.pid, hostname: hostname(), command: 'story transition', acquiredAt: NOW,
        lockId: 'x', processStartTimeMs: start,
      })) === 'active');

    // Live pid but MISMATCHED processStartTimeMs → reused pid → 'stale'/reclaimable.
    check('a live pid with a MISMATCHED processStartTimeMs classifies stale (pid reuse)',
      classifyTransitionLockHolder(snap({
        pid: process.pid, hostname: hostname(), command: 'story transition', acquiredAt: NOW,
        lockId: 'x', processStartTimeMs: start - 3_600_000,
      })) === 'stale');

    // Dead same-host pid (kill → ESRCH) → 'stale'.
    check('a dead same-host pid classifies stale (ESRCH)',
      classifyTransitionLockHolder(snap({
        pid: 2_147_480_000, hostname: hostname(), command: 'story transition', acquiredAt: NOW, lockId: 'x',
      })) === 'stale');

    // Different host → 'unknown' (defer to mtime).
    check('a different-host holder classifies unknown (defer to mtime)',
      classifyTransitionLockHolder(snap({
        pid: process.pid, hostname: `${hostname()}-elsewhere`, command: 'story transition', acquiredAt: NOW, lockId: 'x',
      })) === 'unknown');

    // No holder metadata → 'unknown'.
    check('a missing holder classifies unknown (defer to mtime)', classifyTransitionLockHolder(snap(null)) === 'unknown');
  }

  // ── CHK-002c2: canonical shared lock root — worktree root === main root ──────
  // B-d877 R2 FIX B: the lock is anchored at the git-common-dir-based shared root,
  // so it survives DONE worktree removal and is identical from every worktree.
  console.log('\nCHK-002c2: the transition lock path is identical from the worktree root and the main/common root (FIX B)');
  {
    const fx = makeFixture('B-tiscanon', 'DEV');
    const fromMain = storyTransitionLockPath(fx.root, fx.storyId);
    const fromWorktree = storyTransitionLockPath(fx.wtAbs, fx.storyId);
    check('lock path resolved from the worktree root === from the main root (git-common-dir anchored)',
      fromMain === fromWorktree, `main=${fromMain} worktree=${fromWorktree}`);
    check('the canonical lock path lives under .lattice/locks/transition/, not any worktree/story dir',
      fromMain.includes(`${'.lattice'}/locks/transition/`) &&
      !fromMain.includes('/.worktrees/') && !fromMain.includes('/story/actives/'),
      fromMain);
  }

  // ── CHK-002c3: in-process fail-fast guard (FIX E) ───────────────────────────
  console.log('\nCHK-002c3: a second same-process acquire of the same story\'s lock fails FAST — no ~180s event-loop deadlock (FIX E)');
  {
    const fx = makeFixture('B-tisinproc', 'DEV', { withWorktree: false });
    const held = acquireStoryTransitionLock(fx.root, fx.storyId);
    const t0 = Date.now();
    let fastErr: string | null = null;
    try {
      const w = acquireStoryTransitionLock(fx.root, fx.storyId);
      w.release();
    } catch (e: any) { fastErr = String(e?.message ?? e); }
    const elapsed = Date.now() - t0;
    check('second same-process acquire threw FAST (no blocking poll)', fastErr !== null && elapsed < 2000, `elapsed=${elapsed}ms`);
    check('the in-process guard error names the deadlock hazard',
      !!fastErr && /in-process concurrent transition/.test(fastErr), fastErr ?? 'no throw');
    held.release();
    // After release the in-process guard is cleared → re-acquire succeeds.
    let reacq = false;
    try {
      const l = acquireStoryTransitionLock(fx.root, fx.storyId, { deadlineMs: 1500, staleMs: 100000 });
      l.release();
      reacq = true;
    } catch { reacq = false; }
    check('after the holder releases, the same-process guard is cleared (re-acquirable)', reacq);
  }

  // ── CHK-002c4: CAS-at-persist is the correctness fence, not the lock (FIX A) ─
  // Prove that even with the lock NOT serializing anything, a transition whose
  // pre-persist re-read observes an already-advanced phase ABORTS instead of
  // double-minting. A probe run discovers the exact CAS re-read index so every
  // gate/guard read still sees the true DEV pre-state.
  console.log('\nCHK-002c4: CAS-at-persist aborts a stale second persist even with the lock bypassed (FIX A — correctness fence)');
  {
    // Probe: a normal DEV→REVIEW commit on an identical fixture; capture the index
    // of the readStory(storyId) immediately before the FIRST writeStory(storyId).
    const probe = makeFixture('B-tiscasp', 'DEV', { withWorktree: false });
    let probeReads = 0;
    let casReadIndex = -1;
    const probeStore = new Proxy(probe.store, {
      get(target, prop) {
        if (prop === 'readStory') {
          return (id: string) => {
            if (id === probe.storyId) probeReads += 1;
            return (target as any).readStory(id);
          };
        }
        if (prop === 'writeStory') {
          return (id: string, data: unknown) => {
            if (id === probe.storyId && casReadIndex === -1) casReadIndex = probeReads;
            return (target as any).writeStory(id, data);
          };
        }
        const v = Reflect.get(target as any, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as unknown as StoryStore;
    await runStoryTransition({ store: probeStore, root: probe.root, scanRoot: probe.root } as any,
      { storyId: probe.storyId, phase: 'REVIEW' as any });
    check('probe transition committed REVIEW (the winner persists)',
      probe.store.readStory(probe.storyId).phase === 'REVIEW');
    check('probe discovered the pre-persist CAS re-read index', casReadIndex > 0, `casReadIndex=${casReadIndex}`);

    // Victim: identical fresh fixture at DEV. Inject the "concurrent winner already
    // advanced" ONLY at the CAS re-read (index === casReadIndex): the initial read
    // and all gate/guard reads see DEV (so the FSM guard passes), but the pre-persist
    // re-read observes REVIEW. The transition lock is acquired yet serializes nothing
    // here (single transition), so the CAS ALONE — not the lock, not the guard —
    // rejects the stale persist.
    const victim = makeFixture('B-tiscasv', 'DEV', { withWorktree: false });
    let victimReads = 0;
    const victimStore = new Proxy(victim.store, {
      get(target, prop) {
        if (prop === 'readStory') {
          return (id: string) => {
            const s = (target as any).readStory(id);
            if (id === victim.storyId) {
              victimReads += 1;
              if (victimReads === casReadIndex) return { ...s, phase: 'REVIEW' };
            }
            return s;
          };
        }
        const v = Reflect.get(target as any, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as unknown as StoryStore;
    let casErr: string | null = null;
    try {
      await runStoryTransition({ store: victimStore, root: victim.root, scanRoot: victim.root } as any,
        { storyId: victim.storyId, phase: 'REVIEW' as any });
    } catch (e: any) { casErr = String(e?.message ?? e); }
    check('victim transition threw the CAS abort (not a lock/guard error)',
      !!casErr && /concurrent transition already advanced/.test(casErr), casErr ?? 'no throw');
    const afterVictim = victim.store.readStory(victim.storyId);
    check('victim did NOT persist — exactly one of the two transitions committed', afterVictim.phase === 'DEV', `phase=${afterVictim.phase}`);
    const victimPt = phaseTransitionEvents(victim.store, victim.storyId);
    check('victim appended no phase_transition (no double-mint)', victimPt.length === 0, `count=${victimPt.length}`);
  }

  // ── CHK-002c5: universal ownership-checked release for a NO-holderInfo caller ─
  console.log('\nCHK-002c5: a caller passing NO holderInfo still gets a lockId + ownership-checked release (FIX D — universal release)');
  {
    const fx = makeFixture('B-tisnoinfo', 'DEV', { withWorktree: false });
    const lockDir = join(fx.root, '.lattice', 'locks', 'transition', 'noinfo.lock');

    // Acquire with NO holderInfo — pre-fix this wrote no holder.json and released
    // unconditionally; post-fix it mints a lockId and writes a minimal holder.json.
    const a = acquireMkdirLock(lockDir, {});
    const holderA = readMkdirLockHolder(lockDir);
    check('no-holderInfo acquire still minted a lockId in holder.json', !!holderA?.lockId, JSON.stringify(holderA));

    // Simulate a stale-reclaim + successor: remove A's dir, B acquires (still no holderInfo).
    rmSync(lockDir, { recursive: true, force: true });
    const b = acquireMkdirLock(lockDir, {});
    const holderB = readMkdirLockHolder(lockDir);
    check('successor B (no holderInfo) minted a DIFFERENT lockId',
      !!holderB?.lockId && holderB!.lockId !== holderA!.lockId, JSON.stringify(holderB));

    // A (unaware it was reclaimed) releases — ownership-checked → must be a NO-OP.
    a.release();
    check("no-holderInfo holder A's release did NOT delete the successor's lock", existsSync(lockDir));
    b.release();
    check('successor B released its own lock after the ownership-checked no-op', !existsSync(lockDir));
  }

  // ── CHK-002d: ownership-checked release never deletes a successor's lock ─────
  console.log('\nCHK-002d: ownership-checked release does not delete a successor\'s lock after a stale-reclaim (Finding 1a)');
  {
    const fx = makeFixture('B-tisown', 'DEV', { withWorktree: false });
    const lockDir = join(fx.root, '.lattice', 'locks', 'transition', 'ownership.lock');

    // Holder A acquires (mints unique lockId_A in holder.json).
    const a = acquireMkdirLock(lockDir, {
      holderInfo: { pid: 111111, hostname: 'hostA', command: 'holder A', acquiredAt: NOW },
    });
    const holderA = readMkdirLockHolder(lockDir);
    check('holder A wrote a unique lockId to holder.json', !!holderA?.lockId, JSON.stringify(holderA));

    // Simulate a stale-reclaim: a waiter removes A's dir, then a NEW holder B
    // acquires the SAME dir with a fresh lockId_B.
    rmSync(lockDir, { recursive: true, force: true });
    const b = acquireMkdirLock(lockDir, {
      holderInfo: { pid: 222222, hostname: 'hostB', command: 'holder B', acquiredAt: NOW },
    });
    const holderB = readMkdirLockHolder(lockDir);
    check('successor B holds the lock with a DIFFERENT lockId',
      !!holderB?.lockId && holderB!.lockId !== holderA!.lockId, JSON.stringify(holderB));

    // A (unaware it was reclaimed) now releases. Ownership-checked release must be
    // a NO-OP: it must not delete B's dir.
    a.release();
    check("original holder A's release() did NOT delete the successor's lock dir", existsSync(lockDir));
    const stillB = readMkdirLockHolder(lockDir);
    check("successor B's holder.json survived A's release()",
      stillB?.lockId === holderB!.lockId, JSON.stringify(stillB));

    // B can still release its own lock (ownership matches → dir removed).
    b.release();
    check('successor B can release its own lock after the ownership-checked no-op', !existsSync(lockDir));
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
