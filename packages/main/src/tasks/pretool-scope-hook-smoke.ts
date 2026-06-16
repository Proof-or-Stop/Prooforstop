#!/usr/bin/env node
/**
 * @task B-6bfd
 * @checklist CHK-005
 * @title PreToolUse scope hook smoke tests
 * @type feature
 * @priority high
 * @description
 *   Exercises PreToolUse scope pre-write guard:
 *   1. getClaudeHooks() includes PreToolUse with write-tool matcher
 *   2. getCodexHooks() includes PreToolUse for apply_patch/Edit/Write
 *   3. mergeClaudeHooks generates settings.json containing PreToolUse
 *   4. Codex init generates lowercase .codex native hook assets
 *   5. extractPathsFromToolInput parses Edit/Write/MultiEdit/NotebookEdit/apply_patch correctly
 *   4. prewrite_guard_check CLI returns pass when no guard session
 *   5. prewrite_guard_check CLI blocks when guard session + enforce contract + out-of-scope path
 *   6. lattice-scope-pretool.cjs hook exits 0 (pass-through) when CLI produces no BLOCKED output
 * @changes
 *   - [CHK-005] Add PreToolUse scope hook integration smoke
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_PRETOOL_SCOPE_HOOK_MATCHER,
  getCodexHooks,
  getClaudeHooks,
  PRETOOL_SCOPE_HOOK_MATCHER,
} from '../init-assets.js';
import { extractPathsFromToolInput, normalizeToProjectRoot } from '../core/prewrite-guard.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const hookPath = resolve(packageRoot, '..', '..', '..', '.claude', 'hooks', 'lattice-scope-pretool.cjs');
const codexHookPath = resolve(packageRoot, '..', '..', '..', '.codex', 'hooks', 'lattice-scope-pretool.cjs');
const sessionEnv = { ...process.env, LATTICE_SESSION_ID: 'pretool-scope-smoke', LATTICE_AGENT: 'pretool-scope-smoke' };

function normalizeToRelativePaths(root: string, paths: readonly string[]): string[] {
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
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

// ─── Test 1: getClaudeHooks() includes PreToolUse ─────────────────────────────

const hooks = getClaudeHooks() as Record<string, unknown>;
assert.ok('PreToolUse' in hooks, 'getClaudeHooks() must include PreToolUse');
const preToolEntry = (hooks.PreToolUse as any[])[0];
assert.equal(preToolEntry.matcher, PRETOOL_SCOPE_HOOK_MATCHER, 'PreToolUse matcher must match write tools');
assert.match(
  preToolEntry.hooks[0].command,
  /lattice-scope-pretool\.cjs/,
  'PreToolUse hook must reference lattice-scope-pretool.cjs',
);
assert.ok('UserPromptSubmit' in hooks, 'getClaudeHooks() must still include UserPromptSubmit');
assert.ok('PostToolUse' in hooks, 'getClaudeHooks() must still include PostToolUse');
assert.ok('PostToolUseFailure' in hooks, 'getClaudeHooks() must still include PostToolUseFailure');

console.log('✓ Test 1: getClaudeHooks() includes PreToolUse');

// ─── Test 1b: getCodexHooks() includes PreToolUse ────────────────────────────

const codexHooks = getCodexHooks() as Record<string, unknown>;
assert.ok('PreToolUse' in codexHooks, 'getCodexHooks() must include PreToolUse');
const codexPreToolEntry = (codexHooks.PreToolUse as any[])[0];
assert.equal(codexPreToolEntry.matcher, CODEX_PRETOOL_SCOPE_HOOK_MATCHER, 'Codex PreToolUse matcher must match apply_patch/Edit/Write');
assert.match(
  codexPreToolEntry.hooks[0].command,
  /\.codex\/hooks\/lattice-scope-pretool\.cjs/,
  'Codex PreToolUse hook must reference lowercase .codex/hooks/lattice-scope-pretool.cjs',
);
assert.doesNotMatch(
  codexPreToolEntry.hooks[0].command,
  /\.lattice-codex\/hooks/,
  'Codex PreToolUse hook must not use uppercase .lattice-codex/hooks',
);

console.log('✓ Test 1b: getCodexHooks() includes PreToolUse');

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

  const settingsText = readFileSync(join(settingsRoot, '.claude', 'settings.json'), 'utf8');
  const settings = JSON.parse(settingsText);

  assert.ok(settings.hooks, 'settings.json must have hooks');
  assert.ok(Array.isArray(settings.hooks.PreToolUse), 'settings.json must have PreToolUse hooks array');
  const ptEntry = settings.hooks.PreToolUse[0];
  assert.ok(ptEntry, 'PreToolUse must have at least one entry');
  assert.equal(ptEntry.matcher, PRETOOL_SCOPE_HOOK_MATCHER, 'PreToolUse matcher must match write tools');
  assert.match(ptEntry.hooks[0].command, /lattice-scope-pretool\.cjs/, 'PreToolUse command must reference lattice-scope-pretool.cjs');

  // Existing hooks must still be present
  assert.ok(Array.isArray(settings.hooks.PostToolUse), 'PostToolUse must be present');
  assert.ok(Array.isArray(settings.hooks.UserPromptSubmit), 'UserPromptSubmit must be present');

  console.log('✓ Test 2: mergeClaudeHooks generates settings with PreToolUse');
} finally {
  rmSync(settingsRoot, { recursive: true, force: true });
}

// ─── Test 2b: codex profile generates lowercase Codex hooks ──────────────────

const codexInitRoot = mkdtempSync(join(tmpdir(), 'koala-pretool-codex-init-'));
try {
  git(codexInitRoot, ['init', '-b', 'main']);
  git(codexInitRoot, ['config', 'user.email', 'hook@test']);
  git(codexInitRoot, ['config', 'user.name', 'Hook Test']);

  execFileSync(process.execPath, [cliPath, 'init', '--profile=codex', codexInitRoot], {
    cwd: codexInitRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });

  const hooksJsonPath = join(codexInitRoot, '.codex', 'hooks.json');
  const scopeHookPath = join(codexInitRoot, '.codex', 'hooks', 'lattice-scope-pretool.cjs');
  assert.ok(existsSync(hooksJsonPath), 'codex profile must generate lowercase .codex/hooks.json');
  assert.ok(existsSync(scopeHookPath), 'codex profile must generate lowercase .codex/hooks/lattice-scope-pretool.cjs');
  const upperHooksPath = join(codexInitRoot, '.lattice-codex', 'hooks');
  if (existsSync(upperHooksPath)) {
    const lower = statSync(join(codexInitRoot, '.codex', 'hooks'));
    const upper = statSync(upperHooksPath);
    assert.equal(upper.ino, lower.ino, 'uppercase .lattice-codex/hooks path must only be the case-insensitive alias of lowercase .codex/hooks');
  }

  const generated = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
  assert.ok(Array.isArray(generated.hooks?.PreToolUse), 'generated .codex/hooks.json must include PreToolUse');
  assert.match(generated.hooks.PreToolUse[0].matcher, /apply_patch/, 'generated Codex matcher must include apply_patch');
  assert.match(readFileSync(scopeHookPath, 'utf8'), /provider: 'codex'/, 'generated Codex hook must call guard as provider=codex');

  console.log('✓ Test 2b: codex init generates lowercase native hook assets');
} finally {
  rmSync(codexInitRoot, { recursive: true, force: true });
}

// ─── Test 2c: managed asset apply migrates legacy scope-pretool names ─────────

const migrationRoot = mkdtempSync(join(tmpdir(), 'koala-pretool-migrate-'));
try {
  git(migrationRoot, ['init', '-b', 'main']);
  git(migrationRoot, ['config', 'user.email', 'hook@test']);
  git(migrationRoot, ['config', 'user.name', 'Hook Test']);

  execFileSync(process.execPath, [cliPath, 'init', '--profile=all', '--asset-mode=full', migrationRoot], {
    cwd: migrationRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });

  const legacyClaudeHooks = JSON.parse(JSON.stringify(getClaudeHooks()));
  legacyClaudeHooks.PreToolUse[0].hooks[0].command = legacyClaudeHooks.PreToolUse[0].hooks[0].command
    .replace('lattice-scope-pretool.cjs', 'scope-pretool.cjs');
  write(migrationRoot, '.claude/settings.json', JSON.stringify({ hooks: legacyClaudeHooks }, null, 2) + '\n');
  write(migrationRoot, '.claude/hooks/scope-pretool.cjs', readFileSync(hookPath, 'utf8'));

  const legacyCodexHooks = JSON.parse(JSON.stringify(getCodexHooks()));
  legacyCodexHooks.PreToolUse[0].hooks[0].command = legacyCodexHooks.PreToolUse[0].hooks[0].command
    .replace('lattice-scope-pretool.cjs', 'scope-pretool.cjs');
  write(migrationRoot, '.codex/hooks.json', JSON.stringify({ hooks: legacyCodexHooks }, null, 2) + '\n');
  write(migrationRoot, '.codex/hooks/scope-pretool.cjs', readFileSync(codexHookPath, 'utf8'));

  execFileSync(process.execPath, [cliPath, '--root', migrationRoot, 'check', '--apply', '--profile=all', '--assetMode=full'], {
    cwd: migrationRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });

  const migratedSettings = readFileSync(join(migrationRoot, '.claude', 'settings.json'), 'utf8');
  assert.match(migratedSettings, /lattice-scope-pretool\.cjs/, 'managed apply must migrate Claude settings to lattice-scope-pretool.cjs');
  assert.doesNotMatch(migratedSettings, /\/scope-pretool\.cjs/, 'managed apply must remove old Claude scope-pretool command');
  assert.ok(existsSync(join(migrationRoot, '.claude', 'hooks', 'lattice-scope-pretool.cjs')), 'managed apply must create new Claude hook script');
  assert.ok(!existsSync(join(migrationRoot, '.claude', 'hooks', 'scope-pretool.cjs')), 'managed apply must remove generated old Claude hook script');

  const migratedCodexHooks = readFileSync(join(migrationRoot, '.codex', 'hooks.json'), 'utf8');
  assert.match(migratedCodexHooks, /lattice-scope-pretool\.cjs/, 'managed apply must migrate Codex hooks.json to lattice-scope-pretool.cjs');
  assert.doesNotMatch(migratedCodexHooks, /\/scope-pretool\.cjs/, 'managed apply must remove old Codex scope-pretool command');
  assert.ok(existsSync(join(migrationRoot, '.codex', 'hooks', 'lattice-scope-pretool.cjs')), 'managed apply must create new Codex hook script');
  assert.ok(!existsSync(join(migrationRoot, '.codex', 'hooks', 'scope-pretool.cjs')), 'managed apply must remove generated old Codex hook script');

  console.log('✓ Test 2c: managed asset apply migrates legacy scope-pretool hook names');
} finally {
  rmSync(migrationRoot, { recursive: true, force: true });
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
  extractPathsFromToolInput('apply_patch', JSON.stringify({
    command: [
      '*** Begin Patch',
      '*** Update File: src/foo.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: src/new.ts',
      '+x',
      '*** Delete File: src/old.ts',
      '*** Move to: src/moved.ts',
      '*** End Patch',
    ].join('\n'),
  })),
  ['src/foo.ts', 'src/new.ts', 'src/old.ts', 'src/moved.ts'],
  'apply_patch: extracts file paths from patch and move headers',
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

  // Start guard session with a verified Claude Code PreToolUse hook.
  run(enforceRoot, 'guard_session_start', { storyId, provider: 'claude-code', nativeHookVerified: true });

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

  const missingHookStart = run(enforceRoot, 'guard_session_start', { storyId, provider: 'codex', nativeHookVerified: true }, true);
  assert.match(missingHookStart, /requires \.codex\/hooks\.json/, 'Codex nativeHookVerified=true must be rejected until .codex hook assets exist');

  execFileSync(process.execPath, [cliPath, 'init', '--profile=codex', enforceRoot], {
    cwd: enforceRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Restart as a verified Codex native PreToolUse session and block apply_patch before it lands.
  run(enforceRoot, 'guard_session_start', { storyId, provider: 'codex', nativeHookVerified: true });
  const codexPatchResult = run(enforceRoot, 'prewrite_guard_check', {
    provider: 'codex',
    toolName: 'apply_patch',
    toolInputJson: JSON.stringify({
      command: [
        '*** Begin Patch',
        '*** Update File: src/out-of-scope.ts',
        '@@',
        '+export const nope = true;',
        '*** End Patch',
      ].join('\n'),
    }),
    storyId,
  }, true);
  assert.match(codexPatchResult, /DENY/, 'Codex apply_patch out-of-scope path must produce DENY output');
  assert.match(codexPatchResult, /src\/out-of-scope\.ts/, 'Codex blocked output should mention patch target path');

  console.log('✓ Test 6: prewrite_guard_check blocks out-of-scope writes with active Claude/Codex guard sessions');
} finally {
  rmSync(enforceRoot, { recursive: true, force: true });
}

// ─── Test 7: lattice-scope-pretool.cjs hook — passes through when no BLOCKED output ───

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

  const codexPatchPayload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/out-of-scope.ts',
        '@@',
        '+x',
        '*** End Patch',
      ].join('\n'),
    },
    cwd: hookTestRoot,
  });

  const codexNoCliResult = spawnSync(process.execPath, [codexHookPath], {
    input: codexPatchPayload,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(codexNoCliResult.status, 0, 'Codex hook: apply_patch without CLI should pass through gracefully (exit 0)');
  assert.notEqual(codexNoCliResult.status, 2, 'Codex hook: should not block when CLI is not available');

  console.log('✓ Test 7: Claude/Codex lattice-scope-pretool hooks pass through gracefully when CLI unavailable');
} finally {
  rmSync(hookTestRoot, { recursive: true, force: true });
}

console.log('\n✓ All pretool-scope-hook smoke tests passed');
