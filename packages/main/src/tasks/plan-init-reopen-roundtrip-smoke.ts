#!/usr/bin/env node
/**
 * plan-init-reopen-roundtrip-smoke — B-8b69
 *
 * Regression smoke for the gated PLAN->INIT reopen recovery. Proves the full
 * round-trip a maintainer needs when a PLAN scope review legitimately flags a
 * frozen checklist title on a worktree'd story:
 *
 *   story_create -> INIT_CHECK -> PLAN (inside the worktree)
 *     -> story_advance --phase=INIT --reason=... (REOPEN: PLAN-only, reason-gated)
 *     -> checklist_update title (editable only at INIT)
 *     -> re-freeze scope + re-run INIT review
 *     -> story_advance INIT_CHECK (dev_start REUSES the existing worktree)
 *     -> story_advance PLAN
 *
 * Every proof-or-stop command from INIT_CHECK onward runs FROM INSIDE the worktree with a
 * stable PROOF_OR_STOP_SESSION_ID (one owner lease), so this is the first smoke exercising
 * the from-inside-the-worktree path the two defects hid behind:
 *   (1) the missing PLAN->INIT machine edge, and
 *   (2) dev_start's worktree-reuse path bug (resolveWorktreePath/storyRel resolved
 *       against the wrong root when run from inside the worktree).
 *
 * RED before the fix: the reopen is refused (illegal transition), or the re-advance
 * false-fails with "Branch ... does not contain .worktrees/...". GREEN after.
 *
 * Invariants also asserted:
 *   - reopen refused when reason is missing (or too short);
 *   - a title edit at INIT_CHECK stays REJECTED and the refusal names reopen-to-INIT;
 *   - the edited title persists through the round-trip back to PLAN.
 *
 * Pattern mirrors init-check-atomicity-smoke.ts (mkdtemp git repo, real dist/cli.js,
 * StoryStore seeding, freeze + init_check_repair fallback).
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { PendingReopenAudit, ProcessEvent } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { runStoryTransition } from '../handlers/transition-orchestrator.js';
import { buildExecutionBoundary, buildScopeBoundary, evaluateScopeFreeze } from '../core/scope-anti-expansion.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const NOW = '2026-07-25T12:00:00.000Z';
const SESSION = 'plan-init-reopen-roundtrip-smoke-session';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-plan-init-reopen-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', worktreeDir: '.worktrees',
  }, null, 2));
  write(root, '.gitignore', ['.worktrees/', '.proof-or-stop/*', '!.proof-or-stop/story/', '!.proof-or-stop/story/**', ''].join('\n'));
  write(root, 'README.md', 'plan-init-reopen round-trip smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  resetConfigCache();
  return root;
}
// Run the built CLI. `cwd` selects main-root vs inside-the-worktree; a fixed
// PROOF_OR_STOP_SESSION_ID keeps one owner lease across both (the owner token derived from
// other adapters is cwd-sensitive and would otherwise thrash on the reopen from the
// worktree). PROOF_OR_STOP_PROJECT_ROOT is intentionally NOT set, so the metadata root
// follows cwd exactly as a real operator experiences it.
function run(cwd: string, command: string, args: Record<string, unknown>): { code: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd, env: { ...process.env, PROOF_OR_STOP_SESSION_ID: SESSION }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e: any) {
    return { code: typeof e?.status === 'number' ? e.status : 1, out: `${e?.stdout ?? ''}\n${e?.stderr ?? e?.message ?? e}` };
  }
}
// Same invocation as run(), but keeps BOTH streams on success too. ctx.log writes
// to stderr (cli-engine.ts), so operator-facing advisories are invisible to run().
function runBoth(cwd: string, command: string, args: Record<string, unknown>): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd, env: { ...process.env, PROOF_OR_STOP_SESSION_ID: SESSION }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: typeof r.status === 'number' ? r.status : 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function phaseOf(cwd: string, storyId: string): string {
  const r = run(cwd, 'story_get', { storyId, detail: true });
  try { return JSON.parse(r.out).index.phase; } catch { return `??(${r.code})`; }
}
function titleOf(cwd: string, storyId: string, itemId: string): string {
  const r = run(cwd, 'story_get', { storyId, detail: true });
  try { return JSON.parse(r.out).checklist.items.find((i: any) => i.id === itemId)?.title ?? ''; } catch { return ''; }
}
function statusOf(cwd: string, storyId: string, itemId: string): string {
  const r = run(cwd, 'story_get', { storyId, detail: true });
  try { return JSON.parse(r.out).checklist.items.find((i: any) => i.id === itemId)?.status ?? ''; } catch { return ''; }
}
// Make the scope-freeze gate pass for the story's CURRENT projected title/checklist.
function freezeStory(store: StoryStore, storyId: string): void {
  store.writeScopeBoundary(storyId, buildScopeBoundary({
    storyId, mode: 'correctness_fix', allowed: ['reopen recovery'], excluded: ['unrelated'],
    confirmedBy: 'smoke', confirmationNote: 'Synthetic boundary.', now: NOW,
  }));
  store.writeExecutionBoundary(storyId, buildExecutionBoundary({
    storyId, allowedCommands: ['npm --prefix packages/main run build'], allowedTools: ['shell'],
    excludedCommands: ['rm -rf'], excludedTools: [], confirmedBy: 'smoke', confirmationNote: 'Synthetic.', now: NOW,
  }));
  const result = evaluateScopeFreeze({
    storyId, scopeBoundary: store.readScopeBoundary(storyId), executionBoundary: store.readExecutionBoundary(storyId),
    story: { title: store.readStory(storyId).title, description: store.readStory(storyId).description, background: store.readStoryBackground(storyId) ?? undefined },
    checklist: store.readChecklist(storyId).items.map(i => ({ id: i.id, title: i.title ?? '', ...(i.context ? { context: i.context } : {}) })),
    discardDigest: store.readScopeDiscardDigest(storyId), now: NOW,
  });
  store.writeScopeFreezeCheck(storyId, result.check);
  assert.equal(result.check.status, 'pass', 'freeze setup must pass');
}
function repairInitCheck(root: string, storyId: string): void {
  const r = run(root, 'init_check_repair', {
    storyId, acknowledge: true,
    fallbackReason: 'No init reviewer subagent can be spawned in this smoke; manually attested background + checklist for the reopen round-trip.',
    evidenceRefs: ['plan-init-reopen-roundtrip-smoke'],
  });
  assert.equal(r.code, 0, `init_check_repair should succeed: ${r.out}`);
}

const SMOKE_BACKGROUND = [
  '## Trigger Event',
  '2026-07-25 B-0000 dev_start reuse smoke needs enough trigger detail to satisfy background validation.',
  '## Key Insights',
  'dev_start must reuse an existing worktree and re-bootstrap a deleted one, resolving worktree.path against the main repo root.',
  '## Solution Tradeoffs',
  'The smoke drives the init_check_repair fallback rather than spawning reviewer subagents to reach INIT_CHECK deterministically.',
  '## Conversation Texture',
  'A maintainer re-runs dev_start from the main root; it reports the existing worktree, and re-creates it if the directory was removed.',
].join('\n\n');

// Seed a fresh repo with a chore story advanced to INIT_CHECK (real worktree on disk).
function seedStoryAtInitCheck(): { root: string; storyId: string; wt: string } {
  const root = initRepo();
  const created = run(root, 'story_create', {
    name: 'devstart-reuse', title: 'dev_start reuse', description: 'Verify dev_start worktree reuse and deleted-worktree re-bootstrap.',
    type: 'chore', priority: 'medium', background: SMOKE_BACKGROUND,
    checklist: [{ title: 'dev_start reuse coverage', context: 'from-main reuse and deleted-worktree re-bootstrap.' }],
  });
  assert.equal(created.code, 0, `story_create should succeed: ${created.out}`);
  const storyId = created.out.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(storyId, 'story_create should return a story id');
  freezeStory(new StoryStore(root), storyId!);
  repairInitCheck(root, storyId!);
  git(root, ['add', '.proof-or-stop/story/actives']);
  git(root, ['commit', '-m', 'seed devstart reuse story']);
  // Surface the CLI output on failure like every other assertion in this file; a bare
  // "1 !== 0" here is undiagnosable when this seeding step fails.
  const seedAdvance = run(root, 'story_advance', { storyId, phase: 'INIT_CHECK' });
  assert.equal(seedAdvance.code, 0, `INIT_CHECK advance should succeed: ${seedAdvance.out}`);
  const wt = join(root, '.worktrees', storyId!);
  assert.equal(existsSync(wt), true, 'worktree should exist after INIT_CHECK');
  return { root, storyId: storyId!, wt };
}

// CHK-002 edge:0 (dev_start from the MAIN root reuses an existing worktree — exercises
// resolveWorktreePath's main-root resolution + the reuse early-return at worktree.ts
// ~818) and adversarial:0 (worktree dir deleted -> dev_start re-bootstraps). These are
// the from-the-MAIN-root paths, distinct from the round-trip's from-inside-the-worktree
// reuse (CHK-002:happy:0). They are the real evidence for the should-priority intents.
function assertDevStartReuseFromMainAndRebootstrap(): void {
  const { root, storyId, wt } = seedStoryAtInitCheck();
  try {
    // edge:0 — from the MAIN root, dev_start reuses the existing worktree.
    const reuse = run(root, 'dev_start', { storyId });
    assert.equal(reuse.code, 0, `dev_start from main should reuse the worktree: ${reuse.out}`);
    assert.match(reuse.out, /already exists|Path:/i, 'dev_start from main should report the existing worktree (reuse early-return)');
    assert.equal(existsSync(wt), true, 'the worktree is still present after reuse');

    // adversarial:0 — delete ONLY the worktree dir (leaving git's stale registration),
    // then dev_start must re-bootstrap it ITSELF. The test does NOT prune — dev_start
    // is responsible for dropping its own stale registration before `git worktree add`
    // (F-008). If it doesn't, `git worktree add` fails with "missing but already
    // registered" and this assertion catches the regression.
    rmSync(wt, { recursive: true, force: true });
    const rebootstrap = run(root, 'dev_start', { storyId });
    assert.equal(rebootstrap.code, 0, `dev_start must re-bootstrap a deleted worktree on its own (no external prune): ${rebootstrap.out}`);
    assert.equal(existsSync(wt), true, 'dev_start recreated the worktree after deletion');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── B-70a6 F-004: the crash window between the phase write and the audit append ──
//
// THE DEFECT. store.writeStory persists phase=INIT, the persist claim is released,
// and only THEN is the phase_transition audit event appended — with real git
// subprocess calls in between. A crash/throw in that window left a reopen that HAD
// happened with NO audit record, and because REOPEN only fires FROM PLAN the story
// had already left the only phase that could retry it: the event was UNRECOVERABLE,
// defeating the durable-audited-reopen guarantee this story exists to establish.
//
// WHAT THIS PROVES. The crash is injected into the REAL production path (the store
// handed to runStoryTransition throws exactly on the reopen audit append), not
// simulated by hand-editing files, and then:
//   (1) the crash leaves a RECOVERABLE state — the validated reason is already on
//       the story index, because it rode the SAME atomic writeStory rename as
//       phase=INIT — and NO audit event yet;
//   (2) the next real transition reconciles: EXACTLY ONE audit event with the
//       VERBATIM reason and the record's idempotency key, record cleared;
//   (3) re-injecting the record (a crash between the append and the clear) does
//       NOT produce a second event;
//   (4) an aborted reopen still leaves neither an event nor a record.
// RED before the fix at (1): no recovery record exists, so the reopen is
// unauditable and unrecoverable.
const SIMULATED_CRASH = 'simulated crash: process died before the reopen audit event was appended';
const CRASH_REOPEN_REASON = 'Crash-window drill: PLAN scope review flagged the frozen title, so this reopen must stay auditable.';

/** A store that dies exactly where the finding says the window is: on the reopen audit append. */
class CrashBeforeReopenAuditStore extends StoryStore {
  reopenAppendAttempts = 0;
  override appendProcessEvent(storyId: string, event: Omit<ProcessEvent, 'timestamp'>) {
    if (event.type === 'phase_transition' && (event as Record<string, unknown>).transitionType === 'reopen') {
      this.reopenAppendAttempts += 1;
      throw new Error(SIMULATED_CRASH);
    }
    return super.appendProcessEvent(storyId, event);
  }
}

function reopenEventsOf(cwd: string, storyId: string): ProcessEvent[] {
  return new StoryStore(cwd).readProcessEvents(storyId).filter(
    (e) => e.type === 'phase_transition' && e.fromPhase === 'PLAN' && e.toPhase === 'INIT',
  );
}

async function assertReopenAuditCrashRecovery(): Promise<void> {
  const { root, storyId, wt } = seedStoryAtInitCheck();
  try {
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'PLAN' }).code, 0, 'PLAN advance should succeed before the crash drill');
    assert.equal(phaseOf(wt, storyId), 'PLAN', 'story should be at PLAN before the crash-injected reopen');

    // ── (1) CRASH in the real path ───────────────────────────────────────────
    // B-70a6 F-010: this drill used to carry its OWN copy of the crash injection,
    // duplicating crashInjectReopen (which the F-005/F-006 drills use) — two
    // implementations of one mechanism that would silently drift apart. It now
    // calls the SHARED helper, which asserts everything the inline copy did about
    // the crash itself: the reopen audit append was reached and failed EXACTLY
    // ONCE, the injected crash (not some earlier failure) is what aborted the
    // transition, phase=INIT nevertheless COMMITTED, and the durable recovery
    // record exists carrying the VERBATIM validated reason.
    const pending = await crashInjectReopen(wt, storyId, CRASH_REOPEN_REASON);

    // Assertions specific to THIS drill, which is why they cannot move into the
    // shared helper: only here is the story guaranteed to have NO reopen event yet
    // (the F-006 drill deliberately runs its crash with one already on disk).
    assert.equal(reopenEventsOf(wt, storyId).length, 0, 'the injected crash must have prevented the audit event — that missing event IS the window under test');
    assert.equal(pending.fromPhase, 'PLAN', 'the recovery record must remember the phase the reopen left');
    assert.ok(pending.auditId.length > 0, 'the recovery record needs an idempotency key so recovery cannot double-emit');

    // ── (2) RECOVERY on the next real transition (via the real CLI) ──────────
    freezeStory(new StoryStore(wt), storyId);
    repairInitCheck(wt, storyId);
    const recover = runBoth(wt, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert.equal(recover.code, 0, `the recovering transition should succeed: ${recover.out}\n${recover.err}`);
    assert.match(`${recover.out}${recover.err}`, /recovered the audit event for an interrupted PLAN->INIT reopen/, 'the recovery must be visible to the operator, not silent');
    const recovered = reopenEventsOf(wt, storyId);
    assert.equal(recovered.length, 1, `reconciliation must produce EXACTLY ONE PLAN->INIT audit event for the one interrupted reopen (found ${recovered.length})`);
    assert.equal(recovered[0].transitionType, 'reopen', 'the recovered event must still be marked transitionType=reopen');
    assert.equal(recovered[0].reason, CRASH_REOPEN_REASON, 'the recovered event must carry the VERBATIM validated reason');
    assert.equal(recovered[0].reopenAuditId, pending.auditId, 'the recovered event must carry the record idempotency key so a repeat cannot double-emit');
    assert.equal(new StoryStore(wt).readStory(storyId).pendingReopenAudit, undefined, 'the recovery record must be cleared once its event is durably appended');

    // ── (3) a crash between the append and the CLEAR must not double-emit ────
    // Re-inject the SAME record while its event is already on disk: the exact
    // residue of dying after the append. Reconciliation must clear it and append
    // NOTHING.
    {
      const store = new StoryStore(wt);
      const story = store.readStory(storyId);
      story.pendingReopenAudit = pending;
      store.writeStory(storyId, story);
      const second = run(wt, 'story_advance', { storyId, phase: 'PLAN' });
      assert.equal(second.code, 0, `the follow-up transition should succeed: ${second.out}`);
      assert.equal(reopenEventsOf(wt, storyId).length, 1, 'a recovery record whose event is already on disk must be cleared WITHOUT appending a second audit event (exactly one reopen, exactly one event)');
      assert.equal(new StoryStore(wt).readStory(storyId).pendingReopenAudit, undefined, 'the stale recovery record must be cleared');
    }

    // ── (4) an aborted reopen leaves neither an event nor a record ───────────
    const refused = run(wt, 'story_advance', { storyId, phase: 'INIT' });
    assert.notEqual(refused.code, 0, 'a reopen with no reason must still be refused');
    assert.equal(reopenEventsOf(wt, storyId).length, 1, 'a refused reopen must not append an event claiming a transition that did not happen');
    assert.equal(new StoryStore(wt).readStory(storyId).pendingReopenAudit, undefined, 'a refused reopen must not leave a recovery record either (the record only rides a COMMITTED phase write)');
    assert.equal(phaseOf(wt, storyId), 'PLAN', 'a refused reopen must not move the phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ reopen audit crash-window recovery passed');
}

// ── B-70a6 F-005: OUT-OF-BAND phase mutations must not destroy the record ────
//
// THE DEFECT. F-004's reconciliation runs at the top of runStoryTransitionInner,
// which yields the invariant "no ORCHESTRATED phase change can follow an
// unaudited reopen" — i.e. only for phase changes that go through it. Two production sites
// mutate story.phase directly with store.writeStory and never reconcile:
// story_discard (handlers/worktree.ts) and the story_reconcile zombie DONE
// repair (handlers/story-query.ts). Both also DESTROY the copy that holds the
// record (the worktree + branch), and both land the story in a TERMINAL phase,
// so nothing can ever reconcile afterwards: the loss is PERMANENT, not deferred.
//
// EXTRA TWIST that a naive "just call reconcile at the top" fix does NOT handle:
// cli/runtime-root.ts redirects story_discard's runtime root from the worktree
// to the MAIN root, so the handler's own store CANNOT SEE the record — it lives
// in the doomed worktree copy. The event must be read from the doomed copy and
// appended to the SURVIVING log.
//
// WHAT THESE TWO DRILLS PROVE, EXACTLY (CONCURRENCY RESIDUAL (B-70a6 F-013)).
// They are SEQUENTIAL: the crash injection completes and the recovery record is
// asserted durable BEFORE story_discard / story_reconcile is invoked, so what is
// proven is "a record already on disk when the terminal operation starts is
// rescued into the surviving log". They do NOT prove — and the code does not
// claim — anything about a reopen RACING the terminal operation: the rescue
// holds no per-story transition lock, so a record written after its scan is
// still destroyed with the worktree. That race is a named residual and a
// follow-up story; see reconcileReopenAuditBeforeOutOfBandPhaseChange. Writing a
// drill for it here would be dishonest, because there is no serialization for it
// to observe.
const DISCARD_REOPEN_REASON = 'Discard drill: this reopen committed but crashed before its audit event, and story_discard must not erase it.';
const ZOMBIE_REOPEN_REASON = 'Zombie drill: this reopen committed but crashed before its audit event, and the zombie DONE repair must not erase it.';

/**
 * Drive a real reopen through the production path with the audit append crash-injected.
 *
 * THE ONLY crash-injection implementation in this file (B-70a6 F-010): the F-004
 * crash-window drill, both F-005 out-of-band drills and the F-006 same-reason drill
 * all go through here, so how the crash is injected — the store subclass, the
 * chdir/session dance, what "the crash really happened" means — has one definition
 * that cannot drift. In-process so the store (the ONLY thing swapped) can fail the
 * append the way a dead process would; everything else is production code: same
 * orchestrator, same locks, same gates, same worktree cwd requirement.
 *
 * Asserted here, for every caller: the reopen audit append was reached and failed
 * exactly once, the INJECTED crash is what aborted the transition, the phase write
 * nevertheless COMMITTED, and the durable recovery record exists carrying the
 * VERBATIM reason. Anything that varies per drill (how many audit events already
 * exist, what happens next) stays in the caller.
 */
async function crashInjectReopen(wt: string, storyId: string, reason: string): Promise<PendingReopenAudit> {
  const originalCwd = process.cwd();
  const crashStore = new CrashBeforeReopenAuditStore(wt);
  const ctx: HandlerContext = { root: wt, scanRoot: wt, store: crashStore };
  process.env.PROOF_OR_STOP_SESSION_ID = SESSION;
  process.chdir(wt);
  resetConfigCache();
  let crashError: unknown;
  try {
    await runStoryTransition(ctx, { storyId, phase: 'INIT', reason });
  } catch (e) {
    crashError = e;
  } finally {
    process.chdir(originalCwd);
    resetConfigCache();
  }
  assert.equal(crashStore.reopenAppendAttempts, 1, 'the drill must have reached (and failed) the reopen audit append exactly once');
  assert.match(String((crashError as Error | undefined)?.message ?? ''), new RegExp(SIMULATED_CRASH), `the injected crash must be what aborted the transition, not some earlier failure: ${String(crashError)}`);
  // The reopen COMMITTED — this is precisely why a missing audit event used to be
  // unrecoverable rather than merely late.
  const afterCrash = new StoryStore(wt).readStory(storyId);
  assert.equal(afterCrash.phase, 'INIT', 'the reopen phase write committed before the crash (the state the finding is about, and why the missing event matters)');
  // RED HERE before the F-004 fix: nothing durable carried the validated reason.
  const pending: PendingReopenAudit | undefined = afterCrash.pendingReopenAudit;
  assert.ok(pending, 'a crash between the phase write and the audit append must leave a durable recovery record on the story index (same atomic writeStory rename as phase=INIT) — without it the reopen is silently unaudited and unrecoverable');
  assert.equal(pending!.reason, reason, 'the recovery record must carry the validated reason VERBATIM (a truncated/normalized reason is not the audited one)');
  return pending!;
}

// (F-005a) story_discard — the reviewer's exact repro, from INSIDE the worktree.
async function assertReopenAuditSurvivesStoryDiscard(): Promise<void> {
  const { root, storyId, wt } = seedStoryAtInitCheck();
  try {
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'PLAN' }).code, 0, 'PLAN advance should succeed before the discard drill');
    const pending = await crashInjectReopen(wt, storyId, DISCARD_REOPEN_REASON);
    assert.equal(reopenEventsOf(wt, storyId).length, 0, 'the crash must have prevented the audit event in the worktree log');
    assert.equal(reopenEventsOf(root, storyId).length, 0, 'and the SURVIVING main-root log does not have it either — that is the loss this drill is about');

    // The reviewer's repro verbatim: force-discard from inside the worktree. This
    // deletes the worktree AND the branch — the only copy holding the record.
    const discard = runBoth(wt, 'story_discard', { storyId, force: true, reason: 'drill: discard a story whose reopen crashed' });
    assert.equal(discard.code, 0, `story_discard must still SUCCEED — discarding is legitimate and must never be BLOCKED by a pending audit record: ${discard.out}${discard.err}`);
    assert.equal(existsSync(wt), false, 'the drill must really destroy the copy that held the record, otherwise it proves nothing');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED', 'the discard must still reach its terminal phase');

    // RED HERE before the fix: zero events — the reopen genuinely happened and is
    // now unauditable forever (DISCARDED is terminal, so no later transition can heal it).
    const survived = reopenEventsOf(root, storyId);
    assert.equal(survived.length, 1, `the audit event for a reopen that COMMITTED must survive an out-of-band discard in the surviving story log (found ${survived.length})`);
    assert.equal(survived[0].transitionType, 'reopen', 'the surviving event must still be marked transitionType=reopen');
    assert.equal(survived[0].reason, DISCARD_REOPEN_REASON, 'the surviving event must carry the VERBATIM validated reason');
    assert.equal(survived[0].reopenAuditId, pending.auditId, 'the surviving event must carry the doomed record\'s idempotency key');
    assert.match(`${discard.out}${discard.err}`, /interrupted PLAN->INIT reopen/, 'the operator must SEE the rescue — a silent one is what the finding calls out');
    // B-70a6 F-009: the notice must name WHICH copy held the record. Here it is the
    // DOOMED worktree copy, the one whose own record is deliberately left uncleared,
    // so this pointer is what makes a later duplicate event traceable. Matched on the
    // `.worktrees/<id>` tail rather than the literal path because the handler resolves
    // it through realpath (/var vs /private/var on macOS).
    assert.match(`${discard.out}${discard.err}`, new RegExp(`\\[record read from [^\\]]*\\.worktrees[/\\\\]${storyId}\\]`), 'the discard notice must report that the rescued record came from the doomed worktree copy (an unattributed rescue leaves an operator unable to tell which copy still holds an uncleared record)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ reopen audit survives story_discard passed');
}

// (F-005b) story_reconcile's zombie DONE repair — the second out-of-band site.
// Fixture: the story branch is merged into main by hand (so the record now rides
// the MAIN copy) and its worktree is removed, which is exactly the zombie shape
// story_reconcile exists for. The repair then writes the TERMINAL phase DONE.
async function assertReopenAuditSurvivesZombieReconcile(): Promise<void> {
  const { root, storyId, wt } = seedStoryAtInitCheck();
  try {
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'PLAN' }).code, 0, 'PLAN advance should succeed before the zombie drill');
    const pending = await crashInjectReopen(wt, storyId, ZOMBIE_REOPEN_REASON);

    git(wt, ['add', '-A']);
    git(wt, ['commit', '-m', 'crashed reopen metadata']);
    git(root, ['merge', '--no-ff', `story/${storyId}`, '-m', 'manual merge of the story branch']);
    git(root, ['worktree', 'remove', '--force', wt]);
    const beforeRepair = new StoryStore(root).readStory(storyId);
    assert.equal(beforeRepair.phase, 'INIT', 'the merged main copy must carry the crashed reopen phase');
    assert.equal(beforeRepair.pendingReopenAudit?.auditId, pending.auditId, 'the merged main copy must carry the pending recovery record');
    assert.equal(reopenEventsOf(root, storyId).length, 0, 'no audit event exists yet — the crash prevented it');

    const reconcile = runBoth(root, 'story_reconcile', { dryRun: false });
    assert.equal(reconcile.code, 0, `story_reconcile must still SUCCEED (the repair must never be blocked): ${reconcile.out}${reconcile.err}`);
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE', 'the zombie repair must still reach its terminal phase');

    // RED HERE before the fix: the record is overwritten into a terminal phase and
    // no event is ever produced.
    const survived = reopenEventsOf(root, storyId);
    assert.equal(survived.length, 1, `the audit event must survive the out-of-band zombie DONE repair (found ${survived.length})`);
    assert.equal(survived[0].reason, ZOMBIE_REOPEN_REASON, 'the surviving event must carry the VERBATIM validated reason');
    assert.equal(survived[0].reopenAuditId, pending.auditId, 'the surviving event must carry the record idempotency key');
    assert.match(`${reconcile.out}${reconcile.err}`, /interrupted PLAN->INIT reopen/, 'the operator must SEE the rescue during the zombie repair');
    // B-70a6 F-009: the OTHER source branch — here the record rode the merged MAIN
    // copy, so the notice must attribute it to the surviving index, not to a doomed
    // root. Two drills, two branches: the field can no longer be write-only.
    assert.match(`${reconcile.out}${reconcile.err}`, /\[record read from the surviving story index\]/, 'the zombie-repair notice must report that the rescued record was found on the surviving story index');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ reopen audit survives zombie story_reconcile passed');
}

// ── B-70a6 F-006: idempotency is by auditId IDENTITY, never by reason text ───
//
// The code comment and the AST contract both say two reopens may legitimately
// share one reason, but nothing EXECUTABLE distinguished the two rules: mutating
// the already-audited match to `event.reason === pending.reason` left every smoke
// green. It only bites when a SECOND same-reason reopen crashes before its append
// — reason-matching then finds the FIRST reopen's event, declares the second one
// "already audited", drops its record and swallows its audit event forever.
const SHARED_REOPEN_REASON = 'Same-reason drill: both reopens carry this exact reason text, so only the auditId can tell their audit events apart.';

async function assertSameReasonReopensAreAuditedSeparately(): Promise<void> {
  const { root, storyId, wt } = seedStoryAtInitCheck();
  try {
    // ── reopen #1: completes normally, event on disk ────────────────────────
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'PLAN' }).code, 0, 'PLAN advance should succeed before the first reopen');
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'INIT', reason: SHARED_REOPEN_REASON }).code, 0, 'the first reopen should succeed');
    const first = reopenEventsOf(wt, storyId);
    assert.equal(first.length, 1, 'the first reopen must have produced exactly one audit event');

    // ── back to PLAN so a SECOND reopen is legal ────────────────────────────
    freezeStory(new StoryStore(wt), storyId);
    repairInitCheck(wt, storyId);
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'INIT_CHECK' }).code, 0, 'INIT_CHECK re-advance should succeed');
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'PLAN' }).code, 0, 'PLAN re-advance should succeed');

    // ── reopen #2: SAME reason text, crash-injected before its audit append ──
    const pending = await crashInjectReopen(wt, storyId, SHARED_REOPEN_REASON);
    assert.equal(pending.reason, first[0].reason, 'the drill is only meaningful if BOTH reopens carry the same reason text');
    assert.notEqual(pending.auditId, first[0].reopenAuditId, 'the two reopens must still have DISTINCT audit ids — that identity is the real idempotency key');
    assert.equal(reopenEventsOf(wt, storyId).length, 1, 'the second reopen crashed before its own audit event');

    // ── recovery must emit the SECOND event, not mistake #1 for it ──────────
    freezeStory(new StoryStore(wt), storyId);
    repairInitCheck(wt, storyId);
    const recover = runBoth(wt, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert.equal(recover.code, 0, `the recovering transition should succeed: ${recover.out}${recover.err}`);
    const events = reopenEventsOf(wt, storyId);
    assert.equal(events.length, 2, `two reopens sharing ONE reason text must yield TWO audit events (found ${events.length}) — matching "already audited" on reason text swallows the second reopen's event`);
    assert.equal(new Set(events.map(e => e.reopenAuditId)).size, 2, 'the two audit events must carry DISTINCT reopenAuditIds');
    assert.equal(events[1].reason, SHARED_REOPEN_REASON, 'the recovered second event must carry the shared reason verbatim');
    assert.equal(events[1].reopenAuditId, pending.auditId, 'the recovered second event must carry the SECOND record\'s auditId');
    assert.equal(new StoryStore(wt).readStory(storyId).pendingReopenAudit, undefined, 'the second recovery record must be cleared once its event is durable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ same-reason reopens are audited separately passed');
}

function main(): void {
  const root = initRepo();
  const worktree = join(root, '.worktrees');
  try {
    const ORIGINAL = 'Original frozen title that scope review will flag';
    const CORRECTED = 'Corrected title naming the real deliverable';
    // B-8b69 follow-up: ONE literal, used both to SEND the reopen and to assert what was
    // PERSISTED. Two separately-declared copies would only look like a verbatim round-trip;
    // this binds the assertion to the exact bytes the CLI was given.
    const REOPEN_REASON = 'PLAN scope review flagged the frozen title; it must name the real deliverable.';
    const background = [
      '## Trigger Event',
      '2026-07-25 B-0000 reopen round-trip smoke needs enough trigger detail to satisfy background validation.',
      '## Key Insights',
      'A PLAN scope review can flag a frozen checklist title, and the maintainer must be able to reopen to INIT to fix it.',
      '## Solution Tradeoffs',
      'The smoke drives the init_check_repair fallback rather than spawning reviewer subagents to reach INIT_CHECK deterministically.',
      '## Conversation Texture',
      'A maintainer at PLAN reopens to INIT, edits the title, re-runs INIT review, and re-advances back to PLAN with the corrected title.',
    ].join('\n\n');

    // ── reach PLAN with a real worktree ──────────────────────────────────────
    const created = run(root, 'story_create', {
      name: 'reopen-roundtrip', title: 'Reopen round-trip', description: 'Verify the gated PLAN->INIT reopen recovery round-trip.',
      type: 'chore', priority: 'medium', background,
      checklist: [{ title: ORIGINAL, context: 'A worktree PLAN story must reopen to INIT to fix this title.' }],
    });
    assert.equal(created.code, 0, `story_create should succeed: ${created.out}`);
    const storyId = created.out.match(/B-[a-f0-9]+/)?.[0];
    assert.ok(storyId, 'story_create should return a story id');

    const store = new StoryStore(root);
    freezeStory(store, storyId!);
    repairInitCheck(root, storyId!);
    git(root, ['add', '.proof-or-stop/story/actives']);
    git(root, ['commit', '-m', 'seed reopen smoke story']);

    const wt = join(worktree, storyId!);
    const firstInitCheck = run(root, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert.equal(firstInitCheck.code, 0, `INIT_CHECK advance should succeed: ${firstInitCheck.out}`);
    assert.equal(existsSync(wt), true, 'worktree should exist on disk');

    // ── (F-003) reopen is a PLAN-only backward edge: refused from a non-PLAN phase ──
    // From INIT_CHECK, phase=INIT maps to the plain INIT event (not REOPEN, which the
    // orchestrator only emits from PLAN), and INIT_CHECK has no INIT edge, so it is an
    // illegal transition. Proves canReopenToInit is genuinely PLAN-only.
    const reopenFromCheck = run(wt, 'story_advance', { storyId, phase: 'INIT', reason: 'attempting to reopen from a non-PLAN phase' });
    assert.notEqual(reopenFromCheck.code, 0, 'reopen to INIT from a non-PLAN phase (INIT_CHECK) must be refused');
    assert.match(reopenFromCheck.out, /Cannot transition|not available|illegal|no .*transition/i, 'the non-PLAN reopen refusal should be an illegal-transition style error');
    assert.equal(phaseOf(wt, storyId!), 'INIT_CHECK', 'a refused non-PLAN reopen must not move the phase');

    assert.equal(run(wt, 'story_advance', { storyId, phase: 'PLAN' }).code, 0, 'PLAN advance (inside worktree) should succeed');
    assert.equal(phaseOf(wt, storyId!), 'PLAN', 'story should be at PLAN before the reopen');

    // ── (RED target 1) reopen is refused without a reason ────────────────────
    const noReason = run(wt, 'story_advance', { storyId, phase: 'INIT' });
    assert.notEqual(noReason.code, 0, 'reopen to INIT without a reason must be refused');
    assert.match(noReason.out, /reason of at least \d+ characters is required/i, 'refusal must cite the reason requirement');
    assert.equal(phaseOf(wt, storyId!), 'PLAN', 'a rejected reopen must not move the phase');

    // ── (B-8b69 follow-up, adversarial) a REFUSED reopen must append NO event claiming a
    //    successful PLAN->INIT transition. phase_transition is append-only and written only
    //    AFTER a successful writeStory, so an audit reader must never see a reopen that did
    //    not happen. Checked here — after the two refusals above and BEFORE the real reopen
    //    — so any PLAN->INIT event found at this point is necessarily spurious.
    //
    //    NOTE (why there is no second "too short" refusal here): the convergence breaker
    //    counts REPEATED IDENTICAL gate failures per story and trips at 2 of the same
    //    digest. A second refusal citing the same "reason of at least N characters"
    //    message reuses that digest, trips the breaker, and hard-blocks the legitimate
    //    reopen below with "Convergence breaker FROZEN". So the missing-reason branch is
    //    the one this story drives; the too-short branch shares its code path and message
    //    (`!args.reason || args.reason.trim().length < REOPEN_REASON_MIN`). ─────────────
    {
      const eventsAfterRefusals = new StoryStore(wt).readProcessEvents(storyId!);
      const spurious = eventsAfterRefusals.filter(
        (e) => e.type === 'phase_transition' && e.fromPhase === 'PLAN' && e.toPhase === 'INIT',
      );
      assert.equal(spurious.length, 0, `a refused reopen must append no successful PLAN->INIT phase_transition event (found ${spurious.length})`);
      // B-70a6 F-004: same guarantee for the durable recovery record. It rides the
      // reopen's writeStory, so a refusal (which throws BEFORE that write) must
      // leave nothing for reconciliation to later turn into an audit event.
      assert.equal(new StoryStore(wt).readStory(storyId!).pendingReopenAudit, undefined, 'a refused reopen must leave no reopen recovery record (nothing may later be reconciled into an event for a transition that never happened)');
    }

    // ── (F-005) seed a DONE checklist item, mirroring a story that went
    //    DEV -> REPLAN -> PLAN. Reopening must reset it to pending so the changed
    //    requirement cannot stay "done" with a retitled, code-decoupled definition.
    {
      const seed = new StoryStore(wt);
      const cl = seed.readChecklist(storyId!);
      cl.items[0].status = 'done';
      seed.writeChecklist(storyId!, cl);
      assert.equal(statusOf(wt, storyId!, 'CHK-001'), 'done', 'CHK-001 should be seeded as done before the reopen');
    }

    // ── (RED target 2) the gated PLAN->INIT reopen from inside the worktree ───
    const reopen = run(wt, 'story_advance', { storyId, phase: 'INIT', reason: REOPEN_REASON });
    assert.equal(reopen.code, 0, `reopen to INIT should succeed: ${reopen.out}`);
    assert.match(reopen.out, /advanced to INIT\b/, 'reopen output should report advancement to INIT');
    assert.equal(phaseOf(wt, storyId!), 'INIT', 'story should be back at INIT after the reopen');

    // ── (F-005) the reopen reset the seeded done item back to pending ────────
    assert.equal(statusOf(wt, storyId!, 'CHK-001'), 'pending', 'reopen must reset a done checklist item to pending so a changed requirement is re-verified (no silent tampering)');

    // ── (B-8b69 follow-up) the reopen reason is PERSISTED into the append-only
    //    phase_transition audit event, not just validated then dropped — otherwise
    //    the "audited reopen" claim is not durably true. The event carries a
    //    transitionType marker so a reopen is distinguishable from a forward
    //    transition when auditing history. ─────────────────────────────────────
    {
      const events = new StoryStore(wt).readProcessEvents(storyId!);
      const reopenEvents = events.filter(
        (e) => e.type === 'phase_transition' && e.fromPhase === 'PLAN' && e.toPhase === 'INIT',
      );
      assert.equal(reopenEvents.length, 1, `exactly one PLAN->INIT phase_transition event must be appended by the one successful reopen (found ${reopenEvents.length})`);
      const reopenEvent = reopenEvents[0];
      assert.equal(reopenEvent.transitionType, 'reopen', 'the reopen phase_transition event must be marked transitionType=reopen');
      assert.equal(reopenEvent.reason, REOPEN_REASON, 'the reopen reason must be persisted verbatim in the phase_transition audit event (validated-but-dropped is not auditable)');

      // The mirror image, on a REAL persisted event rather than the builder: a NORMAL
      // transition must carry NEITHER key. The flow-stability deepEqual shape test proves
      // the builder omits them when not passed; only this proves the CALL SITE actually
      // gates on eventType === 'REOPEN'. Key PRESENCE is asserted (not just the value), so
      // an explicit `transitionType: undefined` would still fail. INIT_CHECK->PLAN is used
      // because that advance ran from inside the worktree, so its event is certain to be in
      // the worktree's own JSONL.
      const normalEvent = events.find(
        (e) => e.type === 'phase_transition' && e.fromPhase === 'INIT_CHECK' && e.toPhase === 'PLAN',
      );
      assert.ok(normalEvent, 'the INIT_CHECK->PLAN advance must have appended a phase_transition event');
      assert.equal(Object.prototype.hasOwnProperty.call(normalEvent, 'transitionType'), false, 'a normal transition event must not carry a transitionType key (the reopen fields are additive, set only on REOPEN)');
      assert.equal(Object.prototype.hasOwnProperty.call(normalEvent, 'reason'), false, 'a normal transition event must not carry a reason key (the reopen fields are additive, set only on REOPEN)');
    }

    // ── title is editable ONLY at INIT — edit it now ─────────────────────────
    const edit = run(wt, 'checklist_update', { storyId, itemId: 'CHK-001', title: CORRECTED });
    assert.equal(edit.code, 0, `title edit at INIT should succeed: ${edit.out}`);
    assert.equal(titleOf(wt, storyId!, 'CHK-001'), CORRECTED, 'the corrected title should persist at INIT');

    // ── re-freeze + re-run INIT review for the corrected title ───────────────
    freezeStory(new StoryStore(wt), storyId!);
    repairInitCheck(wt, storyId!);

    // ── (RED target 3) re-advance INIT->INIT_CHECK REUSES the existing worktree ─
    const reAdvance = run(wt, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert.equal(reAdvance.code, 0, `re-advance INIT_CHECK should succeed: ${reAdvance.out}`);
    assert.doesNotMatch(reAdvance.out, /does not contain .*\.worktrees/, 'the dev_start branch-content false-fail must NOT appear');
    assert.equal(phaseOf(wt, storyId!), 'INIT_CHECK', 'story should be at INIT_CHECK after re-advance');
    assert.equal(existsSync(wt), true, 'the existing worktree must be reused (still on disk)');

    // ── invariant: title stays frozen at INIT_CHECK (edit rejected, title unchanged) ─
    // At INIT_CHECK checklist_update is refused by the command-availability policy
    // (allowedPhases: INIT/PLAN/DEV), which sits in FRONT of the title-freeze message;
    // either way the corrected title must not change.
    const frozenAtCheck = run(wt, 'checklist_update', { storyId, itemId: 'CHK-001', title: 'must not be editable here' });
    assert.notEqual(frozenAtCheck.code, 0, 'title edit at INIT_CHECK must stay rejected (scope-freeze invariant)');
    assert.equal(titleOf(wt, storyId!, 'CHK-001'), CORRECTED, 'the corrected title must be unchanged by the rejected INIT_CHECK edit');

    // ── close the round-trip: INIT_CHECK -> PLAN with the corrected title ─────
    assert.equal(run(wt, 'story_advance', { storyId, phase: 'PLAN' }).code, 0, 'INIT_CHECK->PLAN should close the round-trip');
    assert.equal(phaseOf(wt, storyId!), 'PLAN', 'story should be back at PLAN');
    assert.equal(titleOf(wt, storyId!, 'CHK-001'), CORRECTED, 'the corrected title must survive the full round-trip with no git surgery or hand-edited checklist.json');

    // ── corrected guidance: a title edit at PLAN (where checklist_update IS available
    //    but title/context is frozen) is refused and NAMES the reopen-to-INIT path ──
    const frozenAtPlan = run(wt, 'checklist_update', { storyId, itemId: 'CHK-001', title: 'should not be editable at PLAN either' });
    assert.notEqual(frozenAtPlan.code, 0, 'title edit at PLAN must be rejected (title/context frozen from INIT_CHECK onward)');
    assert.match(frozenAtPlan.out, /reopen to INIT/i, 'the PLAN title-freeze refusal must point at reopen-to-INIT');
    assert.match(frozenAtPlan.out, /phase":"INIT"/, 'the refusal should show the concrete story_advance --phase=INIT reopen command');
    assert.doesNotMatch(frozenAtPlan.out, /back to INIT_CHECK/, 'the refusal must no longer tell the user to go back to INIT_CHECK');
    assert.equal(titleOf(wt, storyId!, 'CHK-001'), CORRECTED, 'the rejected PLAN edit must leave the corrected title unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ plan-init-reopen round-trip smoke passed');
}

main();
assertDevStartReuseFromMainAndRebootstrap();
console.log('✓ dev_start from-main reuse + deleted-worktree re-bootstrap passed');
await assertReopenAuditCrashRecovery();
await assertReopenAuditSurvivesStoryDiscard();
await assertReopenAuditSurvivesZombieReconcile();
await assertSameReasonReopensAreAuditedSeparately();
