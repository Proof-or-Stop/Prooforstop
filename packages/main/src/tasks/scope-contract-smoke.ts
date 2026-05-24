#!/usr/bin/env node
/**
 * @task B-be27
 * @checklist CHK-001,CHK-002,CHK-003,CHK-004,CHK-005
 * @title scope contract smoke coverage
 * @type feature
 * @priority high
 * @description
 *   Focused smoke coverage for story scope contracts and the changed-file gate:
 *   no-contract compatibility, set/show/check CLI output, enforce failures,
 *   shadow warnings, invalid contract rejection, and explicit acknowledgement.
 * @changes
 *   - [CHK-001] Verify ScopeContract persistence and validation
 *   - [CHK-002] Verify CLI set/show/check/acknowledge commands
 *   - [CHK-003] Verify enforce/shadow/no-contract gate behavior
 *   - [CHK-004] Verify acknowledgement remains reviewer-visible
 *   - [CHK-005] Package the regression as a smoke test
 *   - [B-6bfd F-003] Verify single-digest ack persists only hunkDigest and
 *     multi-digest ack persists only hunkDigests (no redundant field)
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { checkScopeContract, validatePaths } from '../core/scope-contract.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const sessionEnv = { ...process.env, KOALA_SESSION_ID: 'scope-contract-smoke', KOALA_AGENT: 'scope-contract-smoke' };

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

const root = mkdtempSync(join(tmpdir(), 'koala-scope-contract-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'scope@example.test']);
  git(root, ['config', 'user.name', 'Scope Smoke']);
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'src/allowed.ts', 'export const allowed = 1;\n');
  write(root, 'src/protected.ts', 'export const protectedValue = 1;\n');
  write(root, 'README.md', 'scope contract smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const store = new StoryStore(root);
  const storyId = 'B-scope';
  const story: StoryInfo = {
    storyId,
    name: 'scope-smoke',
    title: 'Scope smoke',
    description: 'Verify scope contract behavior.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  const checklist: ChecklistData = {
    items: [{ id: 'CHK-001', title: 'Scope contract', status: 'in_progress', startTime: null, endTime: null }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  git(root, ['add', '.koala']);
  git(root, ['commit', '-m', 'story metadata']);
  git(root, ['checkout', '-b', `story/${storyId}`]);

  const noContract = run(root, 'scope_contract_check', { storyId, json: true });
  assert.equal(JSON.parse(noContract).status, 'skip', 'no contract should be backward-compatible skip');
  assert.match(run(root, 'scope_contract_show', { storyId }), /Scope contract: not configured/, 'show should degrade without contract');

  const invalid = run(root, 'scope_contract_set', { storyId, mode: 'strict' }, true);
  assert.match(invalid, /Invalid option|mode|strict/, 'invalid mode should be rejected');
  assert.throws(() => validatePaths(['../secret'], 'allowedModify'), /unsafe relative path/, 'unsafe paths are rejected by core validation');

  const set = run(root, 'scope_contract_set', {
    storyId,
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    allowedCreate: ['src/new.ts'],
    allowedTest: ['tests'],
    protectedFiles: ['src/protected.ts'],
    explicitExcludes: ['src/excluded.ts'],
  });
  assert.match(set, /Scope contract: configured/, 'set should render configured transcript');
  assert.match(run(root, 'scope_contract_show', { storyId }), /allowedModify: \[src\/allowed.ts\]/, 'show should list allowedModify');
  run(root, 'scope_contract_set', {
    storyId,
    mode: 'enforce',
    allowedTest: ['tests', 'specs'],
  });
  const partialUpdate = run(root, 'scope_contract_show', { storyId });
  assert.match(partialUpdate, /allowedModify: \[src\/allowed.ts\]/, 'partial update should preserve omitted allowedModify');
  assert.match(partialUpdate, /allowedCreate: \[src\/new.ts\]/, 'partial update should preserve omitted allowedCreate');
  assert.match(partialUpdate, /allowedTest: \[tests, specs\]/, 'partial update should replace provided allowedTest');

  write(root, 'src/allowed.ts', 'export const allowed = 2;\n');
  let checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'pass', 'allowed changed file should pass enforce mode');

  write(root, 'src/other.ts', 'export const other = 1;\n');
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'fail', 'unacknowledged out-of-scope file should fail enforce mode');
  assert.ok(checked.violations.some((v: any) => v.path === 'src/other.ts' && v.rule === 'out_of_scope'), 'violation should identify out-of-scope file');

  const ack = run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/other.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Required for smoke coverage of explicit scope expansion.',
  });
  assert.match(ack, /Scope change acknowledged/, 'acknowledgement should render user-visible transcript');
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'warn', 'acknowledged out-of-scope file should warn, not pass silently');
  assert.ok(checked.acknowledgedPaths.includes('src/other.ts'), 'acknowledged path remains visible');

  write(root, 'src/protected.ts', 'export const protectedValue = 2;\n');
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'fail', 'protected files fail even when other paths are acknowledged');
  assert.ok(checked.violations.some((v: any) => v.path === 'src/protected.ts' && v.rule === 'protected'), 'protected rule should be visible');

  run(root, 'scope_contract_set', {
    storyId,
    mode: 'shadow',
    allowedModify: ['src/allowed.ts'],
  });
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'warn', 'shadow mode warns instead of blocking out-of-scope paths');
  assert.match(run(root, 'scope_contract_check', { storyId }), /Scope gate: warn/, 'text output should include warning transcript');

  // B-6bfd F-003 regression: a single-digest acknowledgement must persist only
  // the singular `hunkDigest` field (not the redundant plural `hunkDigests`),
  // while a multi-digest acknowledgement persists only the plural `hunkDigests`.
  run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/other.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Single hunk digest acknowledgement for F-003 regression coverage.',
    hunkDigest: 'abc12345',
  });
  const afterSingle = store.readScopeContract(storyId);
  assert.ok(afterSingle, 'contract should exist after single-digest acknowledgement');
  const singleAck = afterSingle!.acknowledgements[afterSingle!.acknowledgements.length - 1];
  assert.equal(singleAck.hunkDigest, 'abc12345', 'single digest persists singular hunkDigest');
  assert.ok(!('hunkDigests' in singleAck), 'single digest must NOT redundantly persist plural hunkDigests (F-003)');

  run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/other.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Multiple hunk digests acknowledgement for F-003 regression coverage.',
    hunkDigests: ['abc12345', 'def67890'],
  });
  const afterMulti = store.readScopeContract(storyId);
  assert.ok(afterMulti, 'contract should exist after multi-digest acknowledgement');
  const multiAck = afterMulti!.acknowledgements[afterMulti!.acknowledgements.length - 1];
  assert.deepEqual(multiAck.hunkDigests, ['abc12345', 'def67890'], 'multiple digests persist plural hunkDigests');
  assert.ok(!('hunkDigest' in multiAck), 'multiple digests must NOT persist singular hunkDigest (F-003)');

  const localResult = checkScopeContract({
    storyId,
    mode: 'local',
    allowedModify: ['src/allowed.ts'],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, ['src/allowed.ts']);
  assert.equal(localResult.status, 'pass', 'local mode with no violations should pass');

  console.log('scope contract smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
