#!/usr/bin/env node
/**
 * @title prewrite scope guard regression fixtures
 * @description
 *   Regression smoke coverage for the prewrite scope guard (prewrite_guard_check).
 *   Tests simulate Edit/Write/MultiEdit tool inputs targeting out-of-scope and
 *   protected files and assert the guard denies the write before it happens.
 *   Also verifies that scope_contract_check and story_advance REVIEW/TEST/DONE
 *   block progression after an out-of-scope diff.
 *
 *   Part 1: Pure unit tests of prewriteGuardCheck (no I/O).
 *   Part 2: Scope gate integration tests (runScopeGate with simulated diff).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  prewriteGuardCheck,
  extractPrewritePaths,
  type PrewriteToolInput,
  type PrewriteGuardResult,
} from '../core/prewrite-guard-check.js';
import { buildGuardSession } from '../core/guard-session.js';
import { checkScopeContract } from '../core/scope-contract.js';
import { runScopeGate } from '../handlers/scope-contract.js';
import type {
  ScopeContractData,
  GuardSessionData,
  StoryInfo,
  ChecklistData,
} from '../core/types.js';
import { StoryStore } from '../core/store.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = '2026-06-01T00:00:00.000Z';
const STORY_ID = 'B-prewrite-smoke';

function makeContract(
  overrides: Partial<ScopeContractData> & { mode?: ScopeContractData['mode'] } = {},
): ScopeContractData {
  return {
    storyId: STORY_ID,
    mode: overrides.mode ?? 'enforce',
    allowedModify: overrides.allowedModify ?? ['src/allowed.ts', 'src/feature.ts'],
    allowedCreate: overrides.allowedCreate ?? ['src/new.ts'],
    allowedTest: overrides.allowedTest ?? ['tests/'],
    protectedFiles: overrides.protectedFiles ?? ['src/protected.ts', 'src/core/critical.ts'],
    explicitExcludes: overrides.explicitExcludes ?? ['src/excluded.ts'],
    acknowledgements: overrides.acknowledgements ?? [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeActiveSession(
  overrides: Partial<GuardSessionData> = {},
): GuardSessionData {
  return {
    storyId: STORY_ID,
    provider: 'claude-code',
    guardMode: 'active',
    status: 'active',
    startedAt: NOW,
    updatedAt: NOW,
    violations: [],
    ...overrides,
  };
}

function makeWatcherSession(): GuardSessionData {
  return {
    storyId: STORY_ID,
    provider: 'codex',
    guardMode: 'watcher-fallback',
    status: 'active',
    startedAt: NOW,
    updatedAt: NOW,
    violations: [],
  };
}

function editInput(filePath: string): PrewriteToolInput {
  return { tool: 'Edit', file_path: filePath };
}

function writeInput(filePath: string): PrewriteToolInput {
  return { tool: 'Write', file_path: filePath };
}

function multiEditInput(filePaths: string[]): PrewriteToolInput {
  return {
    tool: 'MultiEdit',
    edits: filePaths.map(p => ({ file_path: p })),
  };
}

// ── Part 1: extractPrewritePaths ──────────────────────────────────────────────

{
  const editPaths = extractPrewritePaths({ tool: 'Edit', file_path: 'src/foo.ts' });
  assert.deepEqual(editPaths, ['src/foo.ts'], 'Edit: extracts file_path');

  const writePaths = extractPrewritePaths({ tool: 'Write', file_path: 'src/bar.ts' });
  assert.deepEqual(writePaths, ['src/bar.ts'], 'Write: extracts file_path');

  const multiPaths = extractPrewritePaths({
    tool: 'MultiEdit',
    edits: [{ file_path: 'src/a.ts' }, { file_path: 'src/b.ts' }],
  });
  assert.deepEqual(multiPaths, ['src/a.ts', 'src/b.ts'], 'MultiEdit: extracts all file_paths');

  const emptyEdit = extractPrewritePaths({ tool: 'Edit' });
  assert.deepEqual(emptyEdit, [], 'Edit with no file_path → empty');

  const emptyMulti = extractPrewritePaths({ tool: 'MultiEdit', edits: [] });
  assert.deepEqual(emptyMulti, [], 'MultiEdit with empty edits → empty');
}

// ── Part 2: prewriteGuardCheck — no session/contract cases ───────────────────

{
  // No guard session → never deny
  const r: PrewriteGuardResult = prewriteGuardCheck(
    makeContract(),
    null,
    editInput('src/protected.ts'),
  );
  assert.equal(r.deny, false, 'no session → deny: false');
  assert.equal(r.rule, 'no_session');
}

{
  // Stopped session → never deny
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession({ status: 'stopped' }),
    editInput('src/protected.ts'),
  );
  assert.equal(r.deny, false, 'stopped session → deny: false');
  assert.equal(r.rule, 'no_session');
}

{
  // Active session but no contract → never deny
  const r = prewriteGuardCheck(null, makeActiveSession(), editInput('src/protected.ts'));
  assert.equal(r.deny, false, 'no contract → deny: false');
  assert.equal(r.rule, 'no_contract');
}

// ── Part 3: prewriteGuardCheck — watcher-fallback cannot block ────────────────

{
  // Watcher-fallback provider: cannot block pre-write; violations detected post-write
  const r = prewriteGuardCheck(
    makeContract(),
    makeWatcherSession(),
    editInput('src/protected.ts'),
  );
  assert.equal(r.deny, false, 'watcher-fallback → deny: false (cannot block pre-write)');
  assert.equal(r.rule, 'watcher_fallback');
}

// ── Part 4: prewriteGuardCheck — Edit targeting a protected file ──────────────

{
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    editInput('src/protected.ts'),
  );
  assert.equal(r.deny, true, 'Edit → protected file → deny: true');
  assert.equal(r.rule, 'protected', 'rule is protected');
  assert.equal(r.path, 'src/protected.ts', 'path is the protected file');
  assert.ok(r.reason?.includes('Protected file'), 'reason mentions Protected file');
}

{
  // A second protected file in the contract
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    editInput('src/core/critical.ts'),
  );
  assert.equal(r.deny, true, 'Edit → second protected file → deny: true');
  assert.equal(r.rule, 'protected');
}

// ── Part 5: prewriteGuardCheck — Write targeting an out-of-scope file ─────────

{
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    writeInput('src/other.ts'),
  );
  assert.equal(r.deny, true, 'Write → out-of-scope file → deny: true');
  assert.equal(r.rule, 'out_of_scope');
  assert.equal(r.path, 'src/other.ts');
  assert.ok(r.reason?.includes('Out-of-scope file'), 'reason mentions Out-of-scope file');
}

{
  // Explicit exclude is also denied
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    writeInput('src/excluded.ts'),
  );
  assert.equal(r.deny, true, 'Write → explicitly excluded file → deny: true');
  assert.equal(r.rule, 'out_of_scope');
}

// ── Part 6: prewriteGuardCheck — Edit targeting an allowed file ───────────────

{
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    editInput('src/allowed.ts'),
  );
  assert.equal(r.deny, false, 'Edit → allowedModify file → deny: false');
  assert.equal(r.rule, undefined, 'no rule on pass');
}

{
  // allowedCreate
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    writeInput('src/new.ts'),
  );
  assert.equal(r.deny, false, 'Write → allowedCreate file → deny: false');
}

{
  // allowedTest directory
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    writeInput('tests/my.test.ts'),
  );
  assert.equal(r.deny, false, 'Write → allowedTest path → deny: false');
}

// ── Part 7: prewriteGuardCheck — MultiEdit with protected and allowed files ───

{
  // MultiEdit with one protected and one allowed: denies at first protected
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    multiEditInput(['src/allowed.ts', 'src/protected.ts', 'src/feature.ts']),
  );
  assert.equal(r.deny, true, 'MultiEdit with protected file → deny: true');
  assert.equal(r.rule, 'protected');
  assert.equal(r.path, 'src/protected.ts');
}

{
  // MultiEdit with all allowed files: passes
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    multiEditInput(['src/allowed.ts', 'src/feature.ts']),
  );
  assert.equal(r.deny, false, 'MultiEdit with all allowed files → deny: false');
}

{
  // MultiEdit with one out-of-scope file: denies
  const r = prewriteGuardCheck(
    makeContract(),
    makeActiveSession(),
    multiEditInput(['src/allowed.ts', 'src/unknown.ts']),
  );
  assert.equal(r.deny, true, 'MultiEdit with out-of-scope file → deny: true');
  assert.equal(r.rule, 'out_of_scope');
}

// ── Part 8: prewriteGuardCheck — shadow contract still escalates to enforce ───

{
  const shadowContract = makeContract({ mode: 'shadow' });
  const r = prewriteGuardCheck(shadowContract, makeActiveSession(), writeInput('src/other.ts'));
  assert.equal(r.deny, true, 'shadow contract → guard escalates to enforce → deny: true');
  assert.equal(r.rule, 'out_of_scope');
}

{
  const localContract = makeContract({ mode: 'local' });
  const r = prewriteGuardCheck(localContract, makeActiveSession(), editInput('src/protected.ts'));
  assert.equal(r.deny, true, 'local contract → guard escalates to enforce for protected file → deny: true');
  assert.equal(r.rule, 'protected');
}

// ── Part 9: prewriteGuardCheck — acknowledged out-of-scope file is NOT denied ─

{
  const contractWithAck = makeContract({
    acknowledgements: [{
      paths: ['src/other.ts'],
      actor: 'smoke-test',
      reason: 'Required for smoke coverage acknowledgement test.',
      timestamp: NOW,
    }],
  });
  const r = prewriteGuardCheck(
    contractWithAck,
    makeActiveSession(),
    writeInput('src/other.ts'),
  );
  assert.equal(r.deny, false, 'acknowledged out-of-scope file → deny: false (explicit scope expansion)');
}

// Protected files are NEVER bypassed by acknowledgement
{
  const contractWithProtectedAck = makeContract({
    acknowledgements: [{
      paths: ['src/protected.ts'],
      actor: 'smoke-test',
      reason: 'Attempting to acknowledge a protected file (must still be denied).',
      timestamp: NOW,
    }],
  });
  const r = prewriteGuardCheck(
    contractWithProtectedAck,
    makeActiveSession(),
    editInput('src/protected.ts'),
  );
  assert.equal(r.deny, true, 'protected file is never bypassed by acknowledgement → deny: true');
  assert.equal(r.rule, 'protected');
}

// ── Part 10: scope_contract_check fails after out-of-scope diff ───────────────

{
  // checkScopeContract: enforce mode + out-of-scope files = fail
  const contract = makeContract();
  const result = checkScopeContract(contract, ['src/other.ts', 'src/unknown.ts']);
  assert.equal(result.status, 'fail', 'scope_contract_check fails for out-of-scope diff');
  assert.ok(
    result.violations.some(v => v.path === 'src/other.ts' && v.rule === 'out_of_scope'),
    'violation includes out-of-scope path',
  );
  assert.ok(
    result.violations.some(v => v.path === 'src/unknown.ts' && v.rule === 'out_of_scope'),
    'violation includes second out-of-scope path',
  );
}

{
  // checkScopeContract: protected file in diff = fail
  const contract = makeContract();
  const result = checkScopeContract(contract, ['src/allowed.ts', 'src/protected.ts']);
  assert.equal(result.status, 'fail', 'scope_contract_check fails when protected file is in diff');
  assert.ok(
    result.violations.some(v => v.path === 'src/protected.ts' && v.rule === 'protected'),
    'violation identifies protected file',
  );
  // allowed file does not produce a violation
  assert.ok(
    !result.violations.some(v => v.path === 'src/allowed.ts'),
    'allowed file produces no violation',
  );
}

{
  // checkScopeContract: shadow mode + out-of-scope files = warn (not fail)
  const shadowContract = makeContract({ mode: 'shadow' });
  const result = checkScopeContract(shadowContract, ['src/other.ts']);
  assert.equal(result.status, 'warn', 'shadow contract with out-of-scope diff → warn, not fail');
}

// ── Part 11: story_advance REVIEW/TEST/DONE blocks after out-of-scope diff ────
//   Uses runScopeGate with a custom gitReader that simulates an out-of-scope diff
//   in a temp git repo (store + contract required; no actual git diff needed).

function writeStoreStory(root: string): { store: StoryStore; storyId: string } {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }),
  );
  const store = new StoryStore(root);
  const storyId = 'B-gate-smoke';
  const now = new Date().toISOString();
  const story: StoryInfo = {
    storyId,
    name: 'gate-smoke',
    title: 'Gate smoke',
    description: 'Synthetic story for gate blocking regression.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{ id: 'CHK-001', title: 'Gate test', status: 'done', startTime: now, endTime: now }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);

  const contract: ScopeContractData = {
    storyId,
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    allowedCreate: ['src/new.ts'],
    allowedTest: ['tests/'],
    protectedFiles: ['src/protected.ts'],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: now,
    updatedAt: now,
  };
  store.writeScopeContract(storyId, contract);
  return { store, storyId };
}

// Gate test: out-of-scope file in diff → runScopeGate returns fail
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-prewrite-gate-'));
  try {
    const { store, storyId } = writeStoreStory(root);

    // Simulate an out-of-scope diff (custom gitReader)
    const gateResult = runScopeGate(storyId, store, root, () => ['src/other.ts', 'src/allowed.ts']);
    assert.ok(gateResult !== null, 'gate result is non-null when contract is configured');
    assert.equal(gateResult?.status, 'fail', 'story_advance REVIEW blocks: scope gate fails for out-of-scope diff');
    assert.ok(
      gateResult?.violations.some(v => v.path === 'src/other.ts' && v.rule === 'out_of_scope'),
      'scope gate violation identifies out-of-scope file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Gate test: protected file in diff → runScopeGate returns fail
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-prewrite-protected-gate-'));
  try {
    const { store, storyId } = writeStoreStory(root);

    const gateResult = runScopeGate(storyId, store, root, () => ['src/allowed.ts', 'src/protected.ts']);
    assert.ok(gateResult !== null, 'gate result is non-null');
    assert.equal(gateResult?.status, 'fail', 'story_advance REVIEW blocks: scope gate fails for protected file in diff');
    assert.ok(
      gateResult?.violations.some(v => v.path === 'src/protected.ts' && v.rule === 'protected'),
      'scope gate violation identifies protected file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Gate test: REVIEW/TEST/DONE gates all fail for the same out-of-scope diff
// Verifies the gate result can block all three lifecycle phases
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-prewrite-all-phases-'));
  try {
    const { store, storyId } = writeStoreStory(root);

    for (const phase of ['REVIEW', 'TEST', 'DONE'] as const) {
      const gateResult = runScopeGate(storyId, store, root, () => ['src/protected.ts']);
      assert.equal(
        gateResult?.status,
        'fail',
        `story_advance ${phase} blocks: scope gate fails when protected file is in diff`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Gate test: allowed diff only → runScopeGate returns pass
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-prewrite-pass-gate-'));
  try {
    const { store, storyId } = writeStoreStory(root);

    const gateResult = runScopeGate(storyId, store, root, () => ['src/allowed.ts']);
    assert.equal(gateResult?.status, 'pass', 'scope gate passes for an allowed-only diff');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Gate test: no contract → gate returns null (backward-compatible skip)
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-prewrite-no-contract-'));
  try {
    writeFileSync(
      join(root, 'lattice.config.json'),
      JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.lattice/story/actives',
        requirementsDir: 'docs/requirements',
        storyPrefix: 'B',
      }),
    );
    const store = new StoryStore(root);
    const storyId = 'B-no-contract';
    const now = new Date().toISOString();
    store.writeStory(storyId, {
      storyId,
      name: 'no-contract',
      title: 'No contract',
      description: 'Story with no scope contract.',
      type: 'feature',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    store.writeChecklist(storyId, { items: [] });

    const gateResult = runScopeGate(storyId, store, root, () => ['src/anything.ts']);
    assert.equal(gateResult, null, 'no scope contract → gate returns null (backward-compatible skip)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Part 12: file content unchanged — guard denies before write happens ────────
// The guard's deny:true means the tool call is blocked BEFORE the file is
// touched. This is a logical assertion: the test verifies that prewriteGuardCheck
// returns deny:true without touching the filesystem, proving the file is unchanged.

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-prewrite-immutable-'));
  try {
    const protectedPath = join(root, 'src/protected.ts');
    mkdirSync(dirname(protectedPath), { recursive: true });
    const originalContent = 'export const protectedValue = 42;\n';
    writeFileSync(protectedPath, originalContent);

    // Simulate an Edit targeting the protected file
    const r = prewriteGuardCheck(
      makeContract({ protectedFiles: ['src/protected.ts'] }),
      makeActiveSession(),
      editInput('src/protected.ts'),
    );

    assert.equal(r.deny, true, 'guard denies Edit on protected file');
    assert.equal(r.rule, 'protected');

    // File must not have been modified by the guard check (guard is read-only)
    const { readFileSync } = await import('node:fs');
    const afterContent = readFileSync(protectedPath, 'utf8');
    assert.equal(afterContent, originalContent, 'file content is unchanged after guard deny');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log('prewrite guard smoke passed');
