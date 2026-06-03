#!/usr/bin/env node
/**
 * @task B-6bfd
 * @checklist CHK-005
 * @title PreToolUse scope hook smoke tests
 * @type feature
 * @priority high
 * @description
 *   Exercises PreToolUse scope pre-write guard:
 *   1. getKoalaHooks() includes PreToolUse with write-tool matcher
 *   2. mergeClaudeHooks generates settings.json containing PreToolUse
 *   3. extractPathsFromToolInput parses Edit/Write/MultiEdit/NotebookEdit correctly
 *   4. prewrite_guard_check CLI returns pass when no guard session
 *   5. prewrite_guard_check CLI blocks when guard session + enforce contract + out-of-scope path
 *   6. scope-pretool.cjs hook exits 0 (pass-through) when CLI produces no BLOCKED output
 * @changes
 *   - [CHK-005] Add PreToolUse scope hook integration smoke
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKoalaHooks, PRETOOL_SCOPE_HOOK_MATCHER } from '../init-assets.js';
import { extractPathsFromToolInput, normalizeToProjectRoot } from '../core/prewrite-guard.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const hookPath = resolve(packageRoot, '..', '..', '..', '.claude', 'hooks', 'scope-pretool.cjs');
const sessionEnv = { ...process.env, KOALA_SESSION_ID: 'pretool-scope-smoke', KOALA_AGENT: 'pretool-scope-smoke' };

function normalizeToRelativePaths(root: string, paths: readonly string[]): string[] {
  return paths
    .map((p) => normalizeToProjectRoot(p, root, root))
    .filter((p): p is string => !!p);
}

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

// ─── Test 1: getKoalaHooks() includes PreToolUse ─────────────────────────────

const hooks = getKoalaHooks() as Record<string, unknown>;
assert.ok('PreToolUse' in hooks, 'getKoalaHooks() must include PreToolUse');
const preToolEntry = (hooks.PreToolUse as any[])[0];
assert.equal(preToolEntry.matcher, PRETOOL_SCOPE_HOOK_MATCHER, 'PreToolUse matcher must match write tools');
assert.match(
  preToolEntry.hooks[0].command,
  /scope-pretool\.cjs/,
  'PreToolUse hook must reference scope-pretool.cjs',
);
assert.ok('UserPromptSubmit' in hooks, 'getKoalaHooks() must still include UserPromptSubmit');
assert.ok('PostToolUse' in hooks, 'getKoalaHooks() must still include PostToolUse');
assert.ok('PostToolUseFailure' in hooks, 'getKoalaHooks() must still include PostToolUseFailure');

console.log('✓ Test 1: getKoalaHooks() includes PreToolUse');

// ─── Test 2: mergeClaudeHooks generates settings with PreToolUse ──────────────
// Indirect: run managed asset check in a claude-profile temp dir and verify settings

const settingsRoot = mkdtempSync(join(tmpdir(), 'koala-pretool-settings-'));
try {
  git(settingsRoot, ['init', '-b', 'main']);
  git(settingsRoot, ['config', 'user.email', 'hook@test']);
  git(settingsRoot, ['config', 'user.name', 'Hook Test']);

  // Build settings via the CLI init command (claude profile)
  execFileSync(process.execPath, [cliPath, 'init', '--profile=claude', settingsRoot], {
    cwd: settingsRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Read the generated settings.json
  const { readFileSync } = await import('node:fs');
  const settingsText = readFileSync(join(settingsRoot, '.claude', 'settings.json'), 'utf8');
  const settings = JSON.parse(settingsText);

  assert.ok(settings.hooks, 'settings.json must have hooks');
  assert.ok(Array.isArray(settings.hooks.PreToolUse), 'settings.json must have PreToolUse hooks array');
  const ptEntry = settings.hooks.PreToolUse[0];
  assert.ok(ptEntry, 'PreToolUse must have at least one entry');
  assert.equal(ptEntry.matcher, PRETOOL_SCOPE_HOOK_MATCHER, 'PreToolUse matcher must match write tools');
  assert.match(ptEntry.hooks[0].command, /scope-pretool\.cjs/, 'PreToolUse command must reference scope-pretool.cjs');

  // Existing hooks must still be present
  assert.ok(Array.isArray(settings.hooks.PostToolUse), 'PostToolUse must be present');
  assert.ok(Array.isArray(settings.hooks.UserPromptSubmit), 'UserPromptSubmit must be present');

  console.log('✓ Test 2: mergeClaudeHooks generates settings with PreToolUse');
} finally {
  rmSync(settingsRoot, { recursive: true, force: true });
}

// ─── Test 3: extractPathsFromToolInput ───────────────────────────────────────

assert.deepEqual(
  extractPathsFromToolInput('Edit', JSON.stringify({ file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' })),
  ['src/foo.ts'],
  'Edit: extracts file_path',
);
assert.deepEqual(
  extractPathsFromToolInput('Write', JSON.stringify({ file_path: '/abs/path/bar.ts', content: 'x' })),
  ['/abs/path/bar.ts'],
  'Write: extracts file_path',
);
assert.deepEqual(
  extractPathsFromToolInput('MultiEdit', JSON.stringify({ file_path: 'src/baz.ts', edits: [] })),
  ['src/baz.ts'],
  'MultiEdit: extracts file_path',
);
assert.deepEqual(
  extractPathsFromToolInput('NotebookEdit', JSON.stringify({ notebook_path: 'notebooks/demo.ipynb' })),
  ['notebooks/demo.ipynb'],
  'NotebookEdit: extracts notebook_path',
);
assert.deepEqual(
  extractPathsFromToolInput('Bash', JSON.stringify({ command: 'echo hello' })),
  [],
  'Bash: returns empty array (not a write tool)',
);
assert.deepEqual(
  extractPathsFromToolInput('Read', JSON.stringify({ file_path: 'src/foo.ts' })),
  [],
  'Read: returns empty array (not a write tool)',
);
assert.deepEqual(
  extractPathsFromToolInput('Edit', 'not valid json'),
  [],
  'malformed toolInputJson: returns empty array',
);

console.log('✓ Test 3: extractPathsFromToolInput handles all write tools');

// ─── Test 4: normalizeToRelativePaths ────────────────────────────────────────

const fakeRoot = '/project/root';
assert.deepEqual(
  normalizeToRelativePaths(fakeRoot, ['/project/root/src/foo.ts']),
  ['src/foo.ts'],
  'absolute path inside root → relative',
);
assert.deepEqual(
  normalizeToRelativePaths(fakeRoot, ['src/bar.ts']),
  ['src/bar.ts'],
  'relative path → unchanged',
);
assert.deepEqual(
  normalizeToRelativePaths(fakeRoot, ['/outside/root/file.ts']),
  [],
  'absolute path outside root → dropped',
);
assert.deepEqual(
  normalizeToRelativePaths(fakeRoot, ['', '  ']),
  [],
  'empty/whitespace paths → dropped',
);

console.log('✓ Test 4: normalizeToRelativePaths normalizes paths correctly');

// ─── Test 5: prewrite_guard_check CLI — pass when no guard session ────────────

const noGuardRoot = mkdtempSync(join(tmpdir(), 'koala-pretool-no-guard-'));
try {
  git(noGuardRoot, ['init', '-b', 'main']);
  git(noGuardRoot, ['config', 'user.email', 'pg@test']);
  git(noGuardRoot, ['config', 'user.name', 'PG Test']);
  write(noGuardRoot, 'koala.config.json', JSON.stringify({ scanRoot: 'src' }, null, 2));
  git(noGuardRoot, ['add', '.']);
  git(noGuardRoot, ['commit', '-m', 'init']);

  const store = new StoryStore(noGuardRoot);
  const storyId = 'B-guard-test';
  const story: StoryInfo = {
    storyId,
    name: 'guard-test',
    title: 'Guard test',
    description: 'Pre-write guard smoke',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  const checklist: ChecklistData = { items: [{ id: 'CHK-001', title: 'test', status: 'in_progress', startTime: null, endTime: null }] };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  git(noGuardRoot, ['add', '.']);
  git(noGuardRoot, ['commit', '-m', 'story meta']);
  git(noGuardRoot, ['checkout', '-b', `story/${storyId}`]);

  // No guard session → should pass
  const passResult = run(noGuardRoot, 'prewrite_guard_check', {
    provider: 'claude-code',
    toolName: 'Edit',
    toolInputJson: JSON.stringify({ file_path: 'src/out-of-scope.ts' }),
    storyId,
  });
  assert.match(passResult, /ALLOW/, 'without guard session: prewrite_guard_check should allow');
  assert.doesNotMatch(passResult, /DENY/, 'without guard session: must not deny');

  console.log('✓ Test 5: prewrite_guard_check passes when no guard session');
} finally {
  rmSync(noGuardRoot, { recursive: true, force: true });
}

// ─── Test 6: prewrite_guard_check CLI — blocked when guard+contract+out-of-scope

const enforceRoot = mkdtempSync(join(tmpdir(), 'koala-pretool-enforce-'));
try {
  git(enforceRoot, ['init', '-b', 'main']);
  git(enforceRoot, ['config', 'user.email', 'pg@test']);
  git(enforceRoot, ['config', 'user.name', 'PG Test']);
  write(enforceRoot, 'koala.config.json', JSON.stringify({ scanRoot: 'src' }, null, 2));
  write(enforceRoot, 'src/allowed.ts', 'export const x = 1;\n');
  git(enforceRoot, ['add', '.']);
  git(enforceRoot, ['commit', '-m', 'init']);

  const store = new StoryStore(enforceRoot);
  const storyId = 'B-enforce-test';
  const story: StoryInfo = {
    storyId,
    name: 'enforce-test',
    title: 'Enforce test',
    description: 'Pre-write guard smoke enforce',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  const checklist: ChecklistData = { items: [{ id: 'CHK-001', title: 'test', status: 'in_progress', startTime: null, endTime: null }] };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  git(enforceRoot, ['add', '.']);
  git(enforceRoot, ['commit', '-m', 'story meta']);
  git(enforceRoot, ['checkout', '-b', `story/${storyId}`]);

  // Set scope contract (enforce mode, only src/allowed.ts in scope)
  run(enforceRoot, 'scope_contract_set', {
    storyId,
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    allowedCreate: [],
  });

  // Start guard session with claude-code provider
  run(enforceRoot, 'guard_session_start', { storyId, provider: 'claude-code' });

  // In-scope write → pass
  const inScopeResult = run(enforceRoot, 'prewrite_guard_check', {
    provider: 'claude-code',
    toolName: 'Edit',
    toolInputJson: JSON.stringify({ file_path: join(enforceRoot, 'src/allowed.ts') }),
    storyId,
  });
  assert.match(inScopeResult, /ALLOW/, 'in-scope path should allow');
  assert.doesNotMatch(inScopeResult, /DENY/, 'in-scope path must not deny');

  // Out-of-scope write → blocked
  const blockedResult = run(enforceRoot, 'prewrite_guard_check', {
    provider: 'claude-code',
    toolName: 'Write',
    toolInputJson: JSON.stringify({ file_path: join(enforceRoot, 'src/out-of-scope.ts') }),
    storyId,
  }, true);
  assert.match(blockedResult, /DENY/, 'out-of-scope path must produce DENY output');
  assert.match(blockedResult, /out_of_scope|out-of-scope|OUT_OF_SCOPE/i, 'blocked output should mention out_of_scope rule');

  console.log('✓ Test 6: prewrite_guard_check blocks out-of-scope writes with active guard session');
} finally {
  rmSync(enforceRoot, { recursive: true, force: true });
}

// ─── Test 7: scope-pretool.cjs hook — passes through when no BLOCKED output ───

const hookTestRoot = mkdtempSync(join(tmpdir(), 'koala-pretool-hook-'));
try {
  // Simulate hook call for a non-write tool → should pass immediately (exit 0)
  const readPayload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'src/foo.ts' },
    cwd: hookTestRoot,
  });

  const nonWriteResult = spawnSync(process.execPath, [hookPath], {
    input: readPayload,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(nonWriteResult.status, 0, 'hook: Read tool should pass through (exit 0)');

  // Simulate hook call for a write tool with no CLI available in test dir → graceful pass-through
  const writePayload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/some/out-of-scope/path.ts' },
    cwd: hookTestRoot,
  });

  const noCliResult = spawnSync(process.execPath, [hookPath], {
    input: writePayload,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // No CLI found in hookTestRoot → should pass through without blocking
  assert.equal(noCliResult.status, 0, 'hook: Write tool without CLI should pass through gracefully (exit 0)');
  assert.notEqual(noCliResult.status, 2, 'hook: should not block when CLI is not available');

  console.log('✓ Test 7: scope-pretool.cjs hook passes through gracefully when CLI unavailable');
} finally {
  rmSync(hookTestRoot, { recursive: true, force: true });
}

console.log('\n✓ All pretool-scope-hook smoke tests passed');
