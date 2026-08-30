#!/usr/bin/env node
/**
 * Smoke tests for PLAN/DEV boundary scope-contract enforcement.
 *
 * Covers:
 *  1. checklistHasFileDeclarations: true when any item declares files; false otherwise.
 *  2. runScopeTransitionGate: new-scope story (checklist has file declarations) BLOCKS at
 *     REVIEW/TEST/DONE when no scope-contract.json is present [missing_scope_contract].
 *  3. runScopeTransitionGate: corrupt scope-contract.json BLOCKS (fail-closed) at
 *     REVIEW/TEST/DONE [scope_contract_unreadable].
 *  4. runScopeTransitionGate: legacy story (no file declarations) shows degradation warning
 *     at REVIEW only; silent at TEST/DONE — backward-compatible, never blocks.
 *  5. runPlanToDevScopeAdvice: emits advisory for new-scope story with no contract;
 *     silent for legacy or already-contracted stories.
 *  6. Integration: after scope_contract_init_from_plan the REVIEW gate passes for a
 *     new-scope story.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, StoryPhase } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import {
  checklistHasFileDeclarations,
  runScopeTransitionGate,
  runPlanToDevScopeAdvice,
} from '../handlers/phase-gates.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const sessionEnv = { ...process.env, PROOF_OR_STOP_SESSION_ID: 'scope-plan-scope-smoke', PROOF_OR_STOP_AGENT: 'scope-plan-scope-smoke' };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: sessionEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

function makeCtx(store: StoryStore, root: string): HandlerContext {
  return { store, root, scanRoot: join(root, 'packages/main') };
}

function makeStory(storyId: string, phase: StoryPhase): StoryInfo {
  const now = new Date().toISOString();
  return {
    storyId,
    name: 'scope-plan-scope-smoke',
    title: 'Scope plan scope smoke',
    description: 'Smoke for scope contract PLAN/DEV boundary enforcement.',
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  };
}

// ── 1. checklistHasFileDeclarations ─────────────────────────────────────────

{
  const nullChecklist: ChecklistData | null = null;
  assert.equal(checklistHasFileDeclarations(nullChecklist), false, 'null checklist → false');

  const noFiles: ChecklistData = {
    items: [
      { id: 'CHK-001', title: 'No files', status: 'pending', startTime: null, endTime: null },
    ],
  };
  assert.equal(checklistHasFileDeclarations(noFiles), false, 'checklist with no files field → false');

  const emptyFiles: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Empty files',
        status: 'pending',
        startTime: null,
        endTime: null,
        files: { modify: [], create: [], test: [] },
      },
    ],
  };
  assert.equal(checklistHasFileDeclarations(emptyFiles), false, 'all-empty files arrays → false');

  const hasModify: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Has modify',
        status: 'pending',
        startTime: null,
        endTime: null,
        files: { modify: ['src/foo.ts'], create: [], test: [] },
      },
    ],
  };
  assert.equal(checklistHasFileDeclarations(hasModify), true, 'item with modify files → true');

  const hasCreate: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Has create',
        status: 'pending',
        startTime: null,
        endTime: null,
        files: { modify: [], create: ['src/new.ts'], test: [] },
      },
    ],
  };
  assert.equal(checklistHasFileDeclarations(hasCreate), true, 'item with create files → true');

  const hasTest: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Has test',
        status: 'pending',
        startTime: null,
        endTime: null,
        files: { modify: [], create: [], test: ['tests/foo.ts'] },
      },
    ],
  };
  assert.equal(checklistHasFileDeclarations(hasTest), true, 'item with test files → true');

  const mixedItems: ChecklistData = {
    items: [
      { id: 'CHK-001', title: 'Legacy', status: 'pending', startTime: null, endTime: null },
      {
        id: 'CHK-002',
        title: 'New scope',
        status: 'pending',
        startTime: null,
        endTime: null,
        files: { modify: ['src/bar.ts'], create: [], test: [] },
      },
    ],
  };
  assert.equal(checklistHasFileDeclarations(mixedItems), true, 'mixed items: one with files → true');

  console.log('  ✓ checklistHasFileDeclarations');
}

// ── 2–6. Gate tests using a temp git repo ───────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-scope-plan-scope-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'scope-plan@example.test']);
  git(root, ['config', 'user.name', 'Scope Plan Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'src/main.ts', 'export const v = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  // ── 2. New-scope story blocks at REVIEW/TEST/DONE without contract ─────────
  {
    const store = new StoryStore(root);
    const storyId = 'B-newscope';
    store.writeStory(storyId, makeStory(storyId, 'DEV'));
    const checklistWithFiles: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Add feature',
        status: 'done',
        startTime: null,
        endTime: null,
        files: { modify: ['src/main.ts'], create: [], test: [] },
      }],
    };
    store.writeChecklist(storyId, checklistWithFiles);

    const ctx = makeCtx(store, root);

    // REVIEW must block
    assert.throws(
      () => runScopeTransitionGate(ctx, storyId, 'REVIEW'),
      /missing_scope_contract/,
      'new-scope story without contract must block REVIEW',
    );

    // TEST must block
    assert.throws(
      () => runScopeTransitionGate(ctx, storyId, 'TEST'),
      /missing_scope_contract/,
      'new-scope story without contract must block TEST',
    );

    // DONE must block
    assert.throws(
      () => runScopeTransitionGate(ctx, storyId, 'DONE'),
      /missing_scope_contract/,
      'new-scope story without contract must block DONE',
    );

    // Error message must name the corrective command
    let thrown: Error | undefined;
    try { runScopeTransitionGate(ctx, storyId, 'REVIEW'); } catch (e) { thrown = e as Error; }
    assert.ok(thrown?.message.includes('scope_contract_init_from_plan'), 'error message must name scope_contract_init_from_plan');
    assert.ok(thrown?.message.includes(storyId), 'error message must name the storyId');

    console.log('  ✓ new-scope story blocks at REVIEW/TEST/DONE without contract');
  }

  // ── 3. Corrupt scope-contract.json fails closed ───────────────────────────
  {
    const store = new StoryStore(root);
    const storyId = 'B-corrupt';
    store.writeStory(storyId, makeStory(storyId, 'DEV'));
    const checklistWithFiles: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Feature',
        status: 'done',
        startTime: null,
        endTime: null,
        files: { modify: ['src/main.ts'], create: [], test: [] },
      }],
    };
    store.writeChecklist(storyId, checklistWithFiles);

    // Write corrupt JSON to scope-contract.json
    const contractPath = join(root, '.proof-or-stop/story/actives', storyId, 'scope-contract.json');
    mkdirSync(dirname(contractPath), { recursive: true });
    writeFileSync(contractPath, '{ this is not valid json !!!', 'utf8');

    const ctx = makeCtx(store, root);

    // Must throw with unreadable/corrupt message for REVIEW
    assert.throws(
      () => runScopeTransitionGate(ctx, storyId, 'REVIEW'),
      /scope_contract_unreadable|corrupt|unreadable/,
      'corrupt scope-contract.json must fail closed at REVIEW',
    );

    // Must throw for TEST too
    assert.throws(
      () => runScopeTransitionGate(ctx, storyId, 'TEST'),
      /scope_contract_unreadable|corrupt|unreadable/,
      'corrupt scope-contract.json must fail closed at TEST',
    );

    // Must throw for DONE too
    assert.throws(
      () => runScopeTransitionGate(ctx, storyId, 'DONE'),
      /scope_contract_unreadable|corrupt|unreadable/,
      'corrupt scope-contract.json must fail closed at DONE',
    );

    console.log('  ✓ corrupt scope-contract.json fails closed at REVIEW/TEST/DONE');
  }

  // ── 4. Legacy story: degradation warning at REVIEW, silent at TEST/DONE ───
  {
    const store = new StoryStore(root);
    const storyId = 'B-legacy';
    store.writeStory(storyId, makeStory(storyId, 'DEV'));
    const legacyChecklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Legacy item (no files)',
        status: 'done',
        startTime: null,
        endTime: null,
        // no files field
      }],
    };
    store.writeChecklist(storyId, legacyChecklist);

    const ctx = makeCtx(store, root);

    // REVIEW must NOT throw; must return a non-empty degradation warning
    const reviewReport = runScopeTransitionGate(ctx, storyId, 'REVIEW');
    assert.ok(
      reviewReport.length > 0,
      'legacy story must show visible degradation warning at REVIEW',
    );
    assert.match(reviewReport, /Scope protection.*none|legacy/i, 'REVIEW warning must mention scope protection none');

    // TEST must NOT throw; must return '' (silent)
    const testReport = runScopeTransitionGate(ctx, storyId, 'TEST');
    assert.equal(testReport, '', 'legacy story must be silent at TEST');

    // DONE must NOT throw; must return '' (silent)
    const doneReport = runScopeTransitionGate(ctx, storyId, 'DONE');
    assert.equal(doneReport, '', 'legacy story must be silent at DONE');

    console.log('  ✓ legacy story: degradation warning at REVIEW, silent at TEST/DONE');
  }

  // ── 5. runPlanToDevScopeAdvice ────────────────────────────────────────────
  {
    const store = new StoryStore(root);

    // 5a. New-scope story without contract → advisory
    const nsId = 'B-advnew';
    store.writeStory(nsId, makeStory(nsId, 'PLAN'));
    store.writeChecklist(nsId, {
      items: [{
        id: 'CHK-001',
        title: 'Feature',
        status: 'pending',
        startTime: null,
        endTime: null,
        files: { modify: ['src/main.ts'], create: [], test: [] },
      }],
    });
    const ctx5 = makeCtx(store, root);
    const advice = runPlanToDevScopeAdvice(ctx5, nsId);
    assert.ok(advice.length > 0, 'new-scope story without contract must emit DEV advisory');
    assert.match(advice, /scope_contract_init_from_plan/, 'advisory must name scope_contract_init_from_plan');
    assert.match(advice, /REVIEW.*BLOCK|BLOCK.*REVIEW/i, 'advisory must warn that REVIEW will block');

    // 5b. Legacy story → no advisory
    const legId = 'B-advleg';
    store.writeStory(legId, makeStory(legId, 'PLAN'));
    store.writeChecklist(legId, {
      items: [{ id: 'CHK-001', title: 'Legacy', status: 'pending', startTime: null, endTime: null }],
    });
    assert.equal(runPlanToDevScopeAdvice(ctx5, legId), '', 'legacy story must have no DEV advisory');

    console.log('  ✓ runPlanToDevScopeAdvice: new-scope advisory, legacy silent');
  }

  // ── 6. Integration: scope_contract_init_from_plan unblocks REVIEW gate ────
  // Uses a fresh isolated subdirectory-repo so git diff is clean after the
  // initial commit — all other test story metadata lives in a different repo.
  {
    const iroot = mkdtempSync(join(tmpdir(), 'proof-or-stop-scope-integrate-'));
    try {
      git(iroot, ['init', '-b', 'main']);
      git(iroot, ['config', 'user.email', 'integrate@example.test']);
      git(iroot, ['config', 'user.name', 'Scope Integrate']);
      write(iroot, 'proof-or-stop.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.proof-or-stop/story/actives',
        requirementsDir: 'docs/requirements',
        storyPrefix: 'B',
      }, null, 2));
      write(iroot, 'src/main.ts', 'export const v = 1;\n');
      git(iroot, ['add', '.']);
      git(iroot, ['commit', '-m', 'init']);

      const storyId = 'B-integrate';
      const istore = new StoryStore(iroot);
      istore.writeStory(storyId, makeStory(storyId, 'DEV'));
      const checklistWithFiles: ChecklistData = {
        items: [{
          id: 'CHK-001',
          title: 'Integration feature',
          status: 'done',
          startTime: null,
          endTime: null,
          files: { modify: ['src/main.ts'], create: [], test: [] },
        }],
      };
      istore.writeChecklist(storyId, checklistWithFiles);
      // Commit the story metadata so git diff only shows actual code changes
      git(iroot, ['add', '.']);
      git(iroot, ['commit', '-m', 'story metadata']);
      git(iroot, ['checkout', '-b', `story/${storyId}`]);
      // Simulate a code change inside the allowed file
      write(iroot, 'src/main.ts', 'export const v = 2;\n');

      const ictx = makeCtx(istore, iroot);

      // Before contract: REVIEW gate blocks with missing_scope_contract
      assert.throws(
        () => runScopeTransitionGate(ictx, storyId, 'REVIEW'),
        /missing_scope_contract/,
        'before scope_contract_init_from_plan: REVIEW must block',
      );

      // Run scope_contract_init_from_plan via CLI
      const initOut = run(iroot, 'scope_contract_init_from_plan', { storyId });
      assert.match(initOut, /Scope contract initialized from PLAN files/, 'scope_contract_init_from_plan must confirm success');

      // After contract: REVIEW gate must pass (no throw) — src/main.ts is allowed
      let thrown: Error | undefined;
      try { runScopeTransitionGate(ictx, storyId, 'REVIEW'); } catch (e) { thrown = e as Error; }
      assert.equal(thrown, undefined, 'after scope_contract_init_from_plan: REVIEW gate must not throw');

      // Also verify DEV advisory is gone
      assert.equal(runPlanToDevScopeAdvice(ictx, storyId), '', 'after init: DEV advisory must be gone');
    } finally {
      rmSync(iroot, { recursive: true, force: true });
    }
    console.log('  ✓ scope_contract_init_from_plan unblocks REVIEW gate');
  }

  console.log('\nscope-contract-plan-scope smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
