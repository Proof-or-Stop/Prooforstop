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
 * Every lattice command from INIT_CHECK onward runs FROM INSIDE the worktree with a
 * stable LATTICE_SESSION_ID (one owner lease), so this is the first smoke exercising
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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-plan-init-reopen-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements', worktreeDir: '.worktrees',
  }, null, 2));
  write(root, '.gitignore', ['.worktrees/', '.lattice/*', '!.lattice/story/', '!.lattice/story/**', ''].join('\n'));
  write(root, 'README.md', 'plan-init-reopen round-trip smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  resetConfigCache();
  return root;
}
// Run the built CLI. `cwd` selects main-root vs inside-the-worktree; a fixed
// LATTICE_SESSION_ID keeps one owner lease across both (the owner token derived from
// other adapters is cwd-sensitive and would otherwise thrash on the reopen from the
// worktree). LATTICE_PROJECT_ROOT is intentionally NOT set, so the metadata root
// follows cwd exactly as a real operator experiences it.
function run(cwd: string, command: string, args: Record<string, unknown>): { code: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd, env: { ...process.env, LATTICE_SESSION_ID: SESSION }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e: any) {
    return { code: typeof e?.status === 'number' ? e.status : 1, out: `${e?.stdout ?? ''}\n${e?.stderr ?? e?.message ?? e}` };
  }
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

function main(): void {
  const root = initRepo();
  const worktree = join(root, '.worktrees');
  try {
    const ORIGINAL = 'Original frozen title that scope review will flag';
    const CORRECTED = 'Corrected title naming the real deliverable';
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
    git(root, ['add', '.lattice/story/actives']);
    git(root, ['commit', '-m', 'seed reopen smoke story']);

    const wt = join(worktree, storyId!);
    assert.equal(run(root, 'story_advance', { storyId, phase: 'INIT_CHECK' }).code, 0, 'INIT_CHECK advance should succeed');
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
    const reopen = run(wt, 'story_advance', { storyId, phase: 'INIT', reason: 'PLAN scope review flagged the frozen title; it must name the real deliverable.' });
    assert.equal(reopen.code, 0, `reopen to INIT should succeed: ${reopen.out}`);
    assert.match(reopen.out, /advanced to INIT\b/, 'reopen output should report advancement to INIT');
    assert.equal(phaseOf(wt, storyId!), 'INIT', 'story should be back at INIT after the reopen');

    // ── (F-005) the reopen reset the seeded done item back to pending ────────
    assert.equal(statusOf(wt, storyId!, 'CHK-001'), 'pending', 'reopen must reset a done checklist item to pending so a changed requirement is re-verified (no silent tampering)');

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
