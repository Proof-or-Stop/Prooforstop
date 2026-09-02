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
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync, readdirSync, renameSync, utimesSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-tis-'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'tis@test']);
  git(root, ['config', 'user.name', 'TIS']);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  writeFileSync(join(root, '.gitignore'), '.worktrees/\nnode_modules/\n.proof-or-stop/locks/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const wtRel = join('.worktrees', storyId);
  const wtAbs = join(root, wtRel);
  git(root, ['worktree', 'add', '-b', `story/${storyId}`, wtAbs, 'HEAD']);
  mkdirSync(join(wtAbs, '.proof-or-stop/story/actives', storyId), { recursive: true });
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
  // TIS_PHASE / TIS_CHECKLIST let a worker drive IDEA→PLAN (with a per-worker
  // checklist payload) as well as the default DEV→REVIEW. TIS_CHECKLIST is a JSON
  // array of {id,title}; the worker echoes its own checklist id back so the parent
  // can prove the persisted checklist matches the WINNER's payload (F-012).
  const phase = (process.env.TIS_PHASE ?? 'REVIEW') as any;
  let checklist: Array<{ id: string; title: string }> | undefined;
  if (process.env.TIS_CHECKLIST) {
    try { checklist = JSON.parse(process.env.TIS_CHECKLIST); } catch { checklist = undefined; }
  }
  const checklistId = checklist?.[0]?.id ?? null;
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
    const r = await runStoryTransition(
      { store, root, scanRoot: root } as any,
      { storyId, phase, ...(checklist ? { checklist } : {}) },
    );
    console.log(JSON.stringify({ ok: true, phase: r.newState, checklistId }));
  } catch (e: any) {
    console.log(JSON.stringify({ ok: false, err: String(e?.message ?? e).slice(0, 120), checklistId }));
  }
  process.exit(0);
}

/**
 * Spawn TWO genuinely-concurrent OS processes that both drive the SAME story
 * through the REAL `runStoryTransition`, released together by a barrier so they
 * race the persist boundary. `extraEnv` is merged into BOTH children (e.g.
 * PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK=1 to bypass the advisory lock and
 * prove the atomic persist claim alone serializes them; TIS_PHASE to pick the
 * target phase). `perWorkerEnv` supplies env that DIFFERS per worker (e.g. a
 * distinct TIS_CHECKLIST payload each) — worker 1 gets [0], worker 2 gets [1].
 * Returns each worker's parsed JSON result ({ ok, phase, checklistId } | { ok:false, err }).
 */
async function raceTwoTransitionWorkers(
  fx: Fixture,
  extraEnv: Record<string, string> = {},
  perWorkerEnv: [Record<string, string>, Record<string, string>] = [{}, {}],
): Promise<{ r1: any; r2: any }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const barrier = join(fx.root, `GO-${tag}`);
  const ready1 = join(fx.root, `ready1-${tag}`);
  const ready2 = join(fx.root, `ready2-${tag}`);
  const selfPath = fileURLToPath(import.meta.url);
  const spawnWorker = (readyFile: string, own: Record<string, string>) => spawn(process.execPath, [selfPath], {
    env: {
      ...process.env,
      TIS_WORKER: '1',
      TIS_ROOT: fx.root,
      TIS_STORY: fx.storyId,
      TIS_BARRIER: barrier,
      TIS_READY: readyFile,
      ...extraEnv,
      ...own,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const w1 = spawnWorker(ready1, perWorkerEnv[0]);
  const w2 = spawnWorker(ready2, perWorkerEnv[1]);
  let out1 = '';
  let out2 = '';
  w1.stdout!.on('data', (d) => { out1 += d.toString(); });
  w2.stdout!.on('data', (d) => { out2 += d.toString(); });
  // Attach exit listeners BEFORE releasing the barrier (Finding 5): a worker can
  // win and exit almost immediately, so the listener must already be registered.
  const exited = Promise.all([
    new Promise<void>((res) => w1.on('exit', () => res())),
    new Promise<void>((res) => w2.on('exit', () => res())),
  ]);
  await waitForCondition(() => existsSync(ready1) && existsSync(ready2), 10000);
  writeFileSync(barrier, 'go');
  await exited;
  const parse = (s: string) => { try { return JSON.parse(s.trim().split('\n').filter(Boolean).pop() || '{}'); } catch { return {}; } };
  return { r1: parse(out1), r2: parse(out2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// B-d877 R4 (codex #3): static guard — every PRODUCTION call to the process-event
// APPEND HELPERS (appendRawProcessEventBytes / appendProcessEventRecord) must pass
// a RELOCATED lockDir. The quorum-submit smoke already flags a writer that bypasses
// the primitive with a DIRECT `appendFileSync`; THIS complements it by catching the
// exact codex #3 regression class — a writer that DOES call the primitive but OMITS
// the relocated lockDir, so the append lock defaults into the git-tracked story dir
// (`appendHostVerdictEvents` in cross-host-review.ts did this). A call is a
// violation if it passes fewer than 3 args (no lockDir) or its file never sources a
// relocated-lock resolver (runtimeLockDirPath / storyRuntimeLockPath), i.e. it could
// only be fabricating an in-story path.
// ─────────────────────────────────────────────────────────────────────────────
// B-d877 R5 FIX 5 (F-015): `appendProcessEvent` — the third exported append helper
// that forwards to `appendProcessEventRecord` with a MANDATORY relocated lockDir —
// is included so a future DIRECT (bare-identifier) call omitting the relocated
// lockDir is caught too. Note: `store.appendProcessEvent(...)` method calls are
// PropertyAccessExpressions (not bare Identifiers) and the interface signature in
// planner.ts is not a CallExpression, so neither is (correctly) flagged.
const APPEND_HELPERS = new Set([
  'appendRawProcessEventBytes',
  'appendProcessEventRecord',
  'appendProcessEvent',
]);

function productionTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tasks' ? [] : productionTsFiles(p);
    return entry.isFile() && entry.name.endsWith('.ts') ? [p] : [];
  });
}

function appendHelperMissingRelocatedLock(repoRoot: string): string[] {
  const srcRoot = join(repoRoot, 'packages/main/src');
  const primitive = join(srcRoot, 'core/process-events.ts');
  const violations: string[] = [];
  for (const path of productionTsFiles(srcRoot)) {
    if (path === primitive) continue; // the helpers are DEFINED here; the internal forward is fine.
    const text = readFileSync(path, 'utf8');
    if (![...APPEND_HELPERS].some((h) => text.includes(h))) continue;
    const referencesRelocatedResolver =
      text.includes('runtimeLockDirPath') || text.includes('storyRuntimeLockPath');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && APPEND_HELPERS.has(node.expression.text)
      ) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        const where = `${relative(repoRoot, path)}:${pos.line + 1}`;
        if (node.arguments.length < 3) {
          violations.push(`${where} (no relocated lockDir argument)`);
        } else if (!referencesRelocatedResolver) {
          violations.push(`${where} (file does not source runtimeLockDirPath/storyRuntimeLockPath)`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
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
    const { r1, r2 } = await raceTwoTransitionWorkers(fx);
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
      // .proof-or-stop/locks/transition/), never inside .proof-or-stop/story/actives/<id>/.
      check('transition lock is rooted under .proof-or-stop/locks/, not the story dir',
        lock.lockDir.includes(`${'.proof-or-stop'}/locks/transition/`) && !lock.lockDir.includes('/story/actives/'),
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
    check('the canonical lock path lives under .proof-or-stop/locks/transition/, not any worktree/story dir',
      fromMain.includes(`${'.proof-or-stop'}/locks/transition/`) &&
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
    const lockDir = join(fx.root, '.proof-or-stop', 'locks', 'transition', 'noinfo.lock');

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

  // ── CHK-002c6: the ATOMIC PERSIST CLAIM alone prevents a double-mint (FIX A) ─
  // Round-3 reviewers flagged that the CHK-002c4 CAS proof was a single-process
  // Proxy mock. This is the load-bearing correctness proof: TWO REAL node
  // processes race the SAME DEV→REVIEW persist with the advisory transition lock
  // BYPASSED (PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK=1). Nothing serializes
  // them EXCEPT the atomic mkdir persist claim — so if that claim were not atomic,
  // both would persist (double review round / double phase_transition). Exactly
  // one must commit; the other must abort with the concurrent-transition error.
  console.log('\nCHK-002c6: two REAL concurrent processes, advisory lock BYPASSED → the atomic persist claim alone yields exactly one commit (FIX A)');
  {
    const fx = makeFixture('B-tisatomic', 'DEV', { withWorktree: false });
    const { r1, r2 } = await raceTwoTransitionWorkers(fx, { PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK: '1' });
    const results = [r1, r2];
    const successes = results.filter((r) => r.ok).length;
    check('with the advisory lock bypassed, exactly one concurrent transition committed (atomic claim serialized the persist)',
      successes === 1, `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
    // With the advisory lock BYPASSED, the winner still prevents a double-mint via
    // one of THREE valid interleavings — all of which yield exactly one commit
    // (already proven by successes===1 / one-review-round / count===1 below):
    //   (a) the loser hits the atomic claim while the winner holds it → failFast:
    //       "concurrent transition already advancing … double-mint";
    //   (b) the loser acquires the claim AFTER the winner committed and its
    //       under-claim re-read sees REVIEW: "concurrent transition already
    //       advanced … found REVIEW … double-mint";
    //   (c) the winner COMMITS before the loser even reads the story, so the loser's
    //       whole transition is REVIEW→REVIEW and it aborts at the FSM guard:
    //       "Cannot transition from REVIEW to REVIEW" (no "advanc"/"double-mint").
    // Accept ANY of the three — the load-bearing correctness proof is the
    // single-commit / single-round / single-event assertions, not the exact text.
    const loser = results.find((r) => !r.ok);
    const loserErr = String(loser?.err ?? '');
    check('the losing transition aborted via a double-mint-prevention path (atomic claim or FSM guard)',
      !!loser && (/concurrent transition already advanc/.test(loserErr) || /Cannot transition from REVIEW to REVIEW/.test(loserErr)),
      JSON.stringify(loser));

    const after = fx.store.readStory(fx.storyId);
    check('landed in REVIEW with exactly one minted currentReviewRound (no double-mint under the atomic claim)',
      after.phase === 'REVIEW' && typeof (after as any).currentReviewRound === 'string' && (after as any).currentReviewRound.length > 0,
      `phase=${after.phase} round=${(after as any).currentReviewRound}`);
    const pt = phaseTransitionEvents(fx.store, fx.storyId);
    check('exactly one phase_transition event appended by the atomic-claim winner (no double-mint)', pt.length === 1, `count=${pt.length}`);
    check('the single event\'s toPhase is REVIEW', pt.filter((e) => e.toPhase === 'REVIEW').length === 1, JSON.stringify(pt.map((e) => e.toPhase)));
  }

  // ── CHK-002c9 (F-012): concurrent IDEA→PLAN — only the WINNER's checklist lands ─
  // Round-4 quality flagged that the IDEA→PLAN checklist write ran BEFORE the
  // atomic persist claim, so a LOSING concurrent PLAN transition's checklist still
  // landed on disk. The fix co-locates the checklist write INSIDE the claim's
  // critical section (after the oldPhase re-read guard, alongside the phase write),
  // so the loser aborts before writing EITHER file. Two REAL processes race
  // IDEA→PLAN with the advisory lock BYPASSED and DISTINCT checklist payloads:
  // exactly one commits, and the persisted checklist must match the WINNER — never
  // the loser.
  console.log('\nCHK-002c9 (F-012): two concurrent IDEA→PLAN transitions with distinct checklists → exactly one commit + the WINNER\'s checklist persists');
  {
    const fx = makeFixture('B-tisplan', 'IDEA', { withWorktree: false });
    const checklistA = [{ id: 'CHK-WINA', title: 'plan payload A' }];
    const checklistB = [{ id: 'CHK-WINB', title: 'plan payload B' }];
    const { r1, r2 } = await raceTwoTransitionWorkers(
      fx,
      { TIS_PHASE: 'PLAN', PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK: '1' },
      [{ TIS_CHECKLIST: JSON.stringify(checklistA) }, { TIS_CHECKLIST: JSON.stringify(checklistB) }],
    );
    const results = [r1, r2];
    const winners = results.filter((r) => r.ok);
    check('exactly one concurrent IDEA→PLAN transition committed (atomic claim serialized the persist)',
      winners.length === 1, `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);

    const after = fx.store.readStory(fx.storyId);
    check('landed in PLAN (the winner persisted)', after.phase === 'PLAN', `phase=${after.phase}`);

    const winner = winners[0];
    const loser = results.find((r) => !r.ok);
    const persisted = fx.store.readChecklist(fx.storyId);
    const persistedIds = (persisted.items ?? []).map((i: any) => i.id);
    check('the persisted checklist is EXACTLY the winner\'s payload (loser\'s checklist did NOT land)',
      !!winner && persistedIds.length === 1 && persistedIds[0] === winner.checklistId,
      `persisted=${JSON.stringify(persistedIds)} winner=${winner?.checklistId} loser=${loser?.checklistId}`);
    check('the LOSER\'s checklist id is ABSENT from the persisted checklist (F-012 fix)',
      !!loser && loser.checklistId != null && !persistedIds.includes(loser.checklistId),
      `persisted=${JSON.stringify(persistedIds)} loser=${loser?.checklistId}`);
  }

  // ── CHK-002c7: relocated per-story runtime locks live under .proof-or-stop/locks/ ──
  // B-d877 R3 FIX B: the checklist / finding / review-run / init-check /
  // prompt-envelope / process-event locks moved OUT of the git-tracked story dir
  // (`.proof-or-stop/story/actives/<id>/…lock`, whose transient holder.json failed
  // quorum-submit-smoke's clean-tree gate) INTO the gitignored shared
  // `.proof-or-stop/locks/<category>/` prefix. Assert every relocated lock resolves
  // under `.proof-or-stop/locks/` and NEVER under `.proof-or-stop/story/actives/`.
  console.log('\nCHK-002c7: relocated runtime locks resolve under .proof-or-stop/locks/, not under .proof-or-stop/story/actives/<id>/ (FIX B)');
  {
    const fx = makeFixture('B-tisreloc', 'DEV');
    const relocations: Array<[string, string]> = [
      ['checklist', 'checklist'],
      ['finding', 'review-passes'],
      ['review-run', 'review-runs'],
      ['init-check', 'init-check'],
      ['prompt-envelopes', 'prompt-envelopes'],
      ['process-events', 'process-events-append'],
    ];
    for (const [category, name] of relocations) {
      const p = fx.store.runtimeLockDirPath(fx.storyId, category, name);
      check(`${category}/${name} lock is under .proof-or-stop/locks/, not the story dir`,
        p.includes(`${'.proof-or-stop'}/locks/${category}/`) &&
        p.endsWith(`.lock`) &&
        !p.includes('/story/actives/'),
        p);
    }
    // The relocated path is anchored at the shared root, so it is identical from
    // the worktree root and the main root (survives worktree removal, one mutex).
    const fromMain = fx.store.runtimeLockDirPath(fx.storyId, 'finding', 'review-passes');
    const wtStore = new StoryStore(fx.wtAbs);
    const fromWt = wtStore.runtimeLockDirPath(fx.storyId, 'finding', 'review-passes');
    check('a relocated lock path is identical from the worktree root and the main root (shared, git-common-dir anchored)',
      fromMain === fromWt, `main=${fromMain} worktree=${fromWt}`);
  }

  // ── CHK-002c8: every production append-primitive call passes a RELOCATED lock ─
  // B-d877 R4 (codex #3): guards the exact missed-relocation class — a production
  // writer that CALLS appendRawProcessEventBytes / appendProcessEventRecord but
  // omits the relocated lockDir (so the append lock lands in the git-tracked story
  // dir). Complements quorum-submit-smoke's direct-appendFileSync scan.
  console.log('\nCHK-002c8: every production process-event append-primitive call passes a relocated lockDir (codex #3 regression guard)');
  {
    const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
    const violations = appendHelperMissingRelocatedLock(repoRoot);
    check('no production process-event append-primitive call omits the relocated lockDir',
      violations.length === 0, violations.join(', ') || 'none');
  }

  // ── CHK-002d: ownership-checked release never deletes a successor's lock ─────
  console.log('\nCHK-002d: ownership-checked release does not delete a successor\'s lock after a stale-reclaim (Finding 1a)');
  {
    const fx = makeFixture('B-tisown', 'DEV', { withWorktree: false });
    const lockDir = join(fx.root, '.proof-or-stop', 'locks', 'transition', 'ownership.lock');

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

  // ── CHK-002d2 (F-016): ownedAuxFiles let a verified-owner release remove a ────
  // HOLDER-owned aux file INSIDE the lock dir so the dir does not leak. Mirrors the
  // validation lock's heartbeat.json: pre-fix, release removed only holder.json,
  // rmdirSync failed (dir not empty), and the leaked dir blocked the next acquire
  // with a false "already running".
  console.log('\nCHK-002d2 (F-016): a lock acquired with ownedAuxFiles + a holder-written aux file inside → clean release leaves NO leftover dir');
  {
    const fx = makeFixture('B-tisaux', 'DEV', { withWorktree: false });
    const lockDir = join(fx.root, '.proof-or-stop', 'locks', 'validation', 'aux.lock');
    const parent = join(fx.root, '.proof-or-stop', 'locks', 'validation');
    const auxName = 'heartbeat.json';
    const lock = acquireMkdirLock(lockDir, {
      holderInfo: { pid: process.pid, hostname: hostname(), command: 'aux holder', acquiredAt: NOW },
      ownedAuxFiles: [auxName],
    });
    // The holder itself writes an aux file INSIDE the lock dir (mirrors heartbeat.json).
    writeFileSync(join(lockDir, auxName), JSON.stringify({ beat: 1 }) + '\n', 'utf8');
    check('aux file exists inside the held lock dir before release', existsSync(join(lockDir, auxName)));
    lock.release();
    check('verified-owner release removed the holder-owned aux file AND the lock dir (no leak)',
      !existsSync(lockDir), lockDir);
    const strays = existsSync(parent) ? readdirSync(parent).filter((n) => n.endsWith('.release-candidate')) : [];
    check('no *.release-candidate stray left after a clean owned-aux release', strays.length === 0, JSON.stringify(strays));
    // The freed dir is immediately re-acquirable — no false "already running".
    let reacq = false;
    try { const l = acquireMkdirLock(lockDir, {}); l.release(); reacq = true; } catch { reacq = false; }
    check('the freed lock dir is immediately re-acquirable (F-016: no leaked-dir false-busy)', reacq);
  }

  // ── CHK-002d3 (codex R5 HIGH): release TOKEN-ISOLATION — a dir REPLACED by a ───
  // successor between A's acquire and A's release is left FULLY intact. FIX 1 moves
  // holder.json out via an atomic rename before validating/removing; on a token
  // mismatch A restores the successor's token and no-ops. Deterministic (no sleeps):
  // A → simulate stale-reclaim (rm A's dir) → B acquires a BRAND-NEW dir → A.release().
  console.log('\nCHK-002d3 (codex R5 HIGH): A stale-reclaimed, B re-acquires a FRESH dir → A\'s release no-ops via the rename-mismatch restore (B\'s dir + holder.json survive byte-identical)');
  {
    const fx = makeFixture('B-tisiso', 'DEV', { withWorktree: false });
    const lockDir = join(fx.root, '.proof-or-stop', 'locks', 'transition', 'isolation.lock');
    const parent = join(fx.root, '.proof-or-stop', 'locks', 'transition');

    const a = acquireMkdirLock(lockDir, {
      holderInfo: { pid: 111111, hostname: 'hostA', command: 'holder A', acquiredAt: NOW },
    });
    const holderA = readMkdirLockHolder(lockDir);
    check('holder A minted a lockId', !!holderA?.lockId, JSON.stringify(holderA));

    // Full stale-reclaim: A's dir removed, then successor B acquires a BRAND-NEW dir
    // (fresh mkdir + B's own holder.json) — the "dir REPLACED under A's release" case.
    rmSync(lockDir, { recursive: true, force: true });
    const b = acquireMkdirLock(lockDir, {
      holderInfo: { pid: 222222, hostname: 'hostB', command: 'holder B', acquiredAt: NOW },
    });
    const bBytesBefore = readFileSync(join(lockDir, 'holder.json'), 'utf8');
    const holderB = readMkdirLockHolder(lockDir);
    check('successor B holds a fresh dir with a DIFFERENT lockId',
      !!holderB?.lockId && holderB!.lockId !== holderA!.lockId, JSON.stringify(holderB));

    // A (unaware) releases → rename isolates B's holder.json → token mismatch →
    // A restores it and no-ops. B's dir + holder.json must be byte-identical.
    a.release();
    check("A's release did NOT delete successor B's fresh dir", existsSync(lockDir));
    const bBytesAfter = existsSync(join(lockDir, 'holder.json')) ? readFileSync(join(lockDir, 'holder.json'), 'utf8') : '';
    check("successor B's holder.json is byte-identical after A's release (rename-mismatch restore)",
      bBytesAfter === bBytesBefore, `before=${bBytesBefore.length}B after=${bBytesAfter.length}B`);
    const strays = existsSync(parent) ? readdirSync(parent).filter((n) => n.endsWith('.release-candidate')) : [];
    check("A's no-op release left no *.release-candidate stray", strays.length === 0, JSON.stringify(strays));

    b.release();
    check("successor B released its own lock after A's no-op", !existsSync(lockDir));
  }

  // ── CHK-002d4 (F-017, quality MED): the mismatch-restore leak is BOUNDED and ───
  // SELF-HEALING. F-017's doubly-degenerate race: a stale-reclaimed-but-still-alive
  // holder A's release() interleaves with the LIVE successor B's OWN release() in the
  // token-less window. No real thread can pause mid-release, so we SCRIPT the two
  // rename halves of A's release around a REAL b.release():
  //   (1) A isolates the token (rename holder.json OUT) — A.release() step 1.
  //   (2) B.release() runs HERE on the now-token-less dir → its rename hits ENOENT →
  //       no-op (B believes it released and will not clean up again).
  //   (3) A's mismatch-restore renames the candidate BACK → re-populates the dir with
  //       B's now-ORPHANED token (the documented bounded leak; false "already running").
  // Then prove SELF-HEALING: the orphaned dir's mtime ages past a tiny staleMs and the
  // ordinary stale-reclaim path collects it — a fresh acquire succeeds. No correctness
  // loss (the atomic mkdir+holder.json persist is the double-mint fence).
  console.log('\nCHK-002d4 (F-017): mismatch-restore leak is BOUNDED — the orphaned dir is stale-reclaimable (self-healing), no correctness loss');
  {
    const fx = makeFixture('B-tisf017', 'DEV', { withWorktree: false });
    const lockDir = join(fx.root, '.proof-or-stop', 'locks', 'transition', 'f017.lock');
    const parent = join(fx.root, '.proof-or-stop', 'locks', 'transition');

    // A acquires, is stale-reclaimed, then LIVE successor B re-acquires a fresh dir.
    acquireMkdirLock(lockDir, {
      holderInfo: { pid: 111111, hostname: 'hostA', command: 'holder A', acquiredAt: NOW },
    });
    const holderA = readMkdirLockHolder(lockDir);
    rmSync(lockDir, { recursive: true, force: true });
    const b = acquireMkdirLock(lockDir, {
      holderInfo: { pid: 222222, hostname: 'hostB', command: 'holder B', acquiredAt: NOW },
    });
    const holderB = readMkdirLockHolder(lockDir);
    check('F-017 precondition: successor B holds a fresh token != A',
      !!holderB?.lockId && holderB!.lockId !== holderA!.lockId, JSON.stringify(holderB));

    // (1) A isolates the token: rename B's holder.json OUT (mirrors A.release() step 1,
    // using A's own release-candidate path so the scripting is faithful).
    const candidateA = join(parent, `${holderA!.lockId}.${process.pid}.release-candidate`);
    renameSync(join(lockDir, 'holder.json'), candidateA);
    check('interleave (1): A isolated the token → lock dir is now token-less',
      existsSync(lockDir) && !existsSync(join(lockDir, 'holder.json')));

    // (2) B's OWN release() runs in the token-less window → rename ENOENT → no-op.
    b.release();
    check('interleave (2): B.release() no-oped on the token-less dir (ENOENT window); dir + candidate untouched',
      existsSync(lockDir) && !existsSync(join(lockDir, 'holder.json')) && existsSync(candidateA));

    // (3) A's mismatch-restore re-populates the dir with B's now-orphaned token.
    renameSync(candidateA, join(lockDir, 'holder.json'));

    // (a) The documented BOUNDED LEAK: dir left populated with B's ORPHANED token, and
    //     B will not clean up again → a false "already running" until staleMs.
    const orphan = readMkdirLockHolder(lockDir);
    check("(a) bounded leak: dir left populated with B's ORPHANED token (documented false-busy)",
      existsSync(lockDir) && orphan?.lockId === holderB!.lockId, JSON.stringify(orphan));
    const straysF017 = existsSync(parent) ? readdirSync(parent).filter((n) => n.endsWith('.release-candidate')) : [];
    check('no *.release-candidate stray left after the restore', straysF017.length === 0, JSON.stringify(straysF017));

    // (b) SELF-HEALING: backdate the orphaned dir's mtime past a tiny staleMs override,
    //     then a normal acquire reclaims it via the ORDINARY stale-reclaim path.
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockDir, past, past);
    const c = acquireMkdirLock(lockDir, {
      staleMs: 50,
      holderInfo: { pid: 333333, hostname: 'hostC', command: 'holder C', acquiredAt: NOW },
    });
    const holderC = readMkdirLockHolder(lockDir);
    check('(b) self-healing: orphaned dir was STALE-RECLAIMED — a fresh acquire (staleMs=50) succeeded with a new token',
      !!holderC?.lockId && holderC!.lockId !== holderB!.lockId, JSON.stringify(holderC));
    c.release();
    check('the reclaimer released its own lock cleanly (no residual leak)', !existsSync(lockDir));
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
