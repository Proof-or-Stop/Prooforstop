#!/usr/bin/env node
/**
 * @task B-42c0
 * @checklist CHK-006
 * @title story capsule smoke coverage
 * @type feature
 * @priority high
 * @description
 *   End-to-end smoke coverage for Story Capsule commands and the anti-forgery
 *   boundary: configured storyDir storage, graceful no-capsule reads, rebuild,
 *   run records, missing-ref diagnostics, and non-authoritative OMX imports.
 * @changes
 *   - [CHK-001] Verify capsule storage honors configured storyDir
 *   - [CHK-002] Verify run summaries are persisted under capsule/runs
 *   - [CHK-003] Verify rebuild recreates capsule.json and appends process events
 *   - [CHK-005] Verify forged/missing evidence refs are rejected in strict mode
 *   - [CHK-006] Verify OMX import is optional and non-authoritative
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const root = mkdtempSync(join(tmpdir(), 'koala-story-capsule-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'capsule smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const store = new StoryStore(root);
  const storyId = 'B-caps';
  git(root, ['checkout', '-b', `story/${storyId}`]);
  const story: StoryInfo = {
    storyId,
    name: 'capsule-smoke',
    title: 'Capsule smoke',
    description: 'Verify Story Capsule behavior.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  const checklist: ChecklistData = {
    items: [
      { id: 'CHK-001', title: 'Capsule contract', status: 'in_progress', startTime: null, endTime: null },
      {
        id: 'CHK-002',
        title: 'Evidence item',
        status: 'pending',
        startTime: null,
        endTime: null,
        verificationEvidence: [{ intentRef: 'CHK-002:happy:0', kind: 'logic_test', result: 'pass', note: 'fixture evidence' }],
      },
    ],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.appendProcessEvent(storyId, { type: 'dispatch', storyId, checklistId: 'CHK-001' });

  const noCapsule = run(root, 'capsule_show', { storyId });
  assert.match(noCapsule, /No story capsule yet/, 'no-capsule read should degrade gracefully');

  run(root, 'capsule_update', {
    storyId,
    rebuild: true,
    summary: 'capsule summary',
    nextAction: 'continue CHK-001',
    evidenceRefs: [{ intentRef: 'CHK-002:happy:0' }],
    processEventRefs: [{ line: 1, type: 'dispatch' }],
  });
  const capsulePath = join(root, '.koala/story/actives/B-caps/capsule/capsule.json');
  assert.ok(existsSync(capsulePath), 'capsule.json must live under configured storyDir=.koala/story/actives');
  assert.equal(readJson<any>(capsulePath).authority, 'projection', 'capsule is projection authority only');
  assert.ok(!existsSync(join(root, 'docs/story/actives/B-caps/capsule/capsule.json')), 'capsule must not be hardcoded under docs/story');

  const brief = run(root, 'session_brief', {});
  assert.match(brief, /Current Story Capsule/, 'session_brief should render capsule block when present');
  assert.match(brief, /continue CHK-001/, 'session_brief should include capsule next action');

  run(root, 'capsule_run_add', {
    storyId,
    checklistId: 'CHK-001',
    provider: 'claude-code',
    role: 'implementer',
    result: 'pass',
    commands: ['npm --prefix packages/main run test:story-capsule-smoke'],
    transcript: 'short transcript',
    metrics: { durationMs: 123, failures: 0 },
  });
  const runRoot = join(root, '.koala/story/actives/B-caps/capsule/runs');
  const runDirs = existsSync(runRoot) ? readdirSyncCompat(runRoot) : [];
  assert.equal(runDirs.length, 1, 'capsule_run_add should create exactly one run dir');
  assert.ok(existsSync(join(runRoot, runDirs[0], 'run.json')), 'run.json should exist');
  assert.ok(existsSync(join(runRoot, runDirs[0], 'transcript.md')), 'transcript.md should exist');

  const badRun = run(root, 'capsule_run_add', { storyId: 'B-caps', checklistId: 'CHK-missing' }, true);
  assert.match(badRun, /unknown checklistId/, 'invalid checklistId should be refused');

  rmSync(join(root, '.koala/story/actives/B-caps/capsule/capsule.json'), { force: true });
  run(root, 'capsule_update', { storyId: 'B-caps', rebuild: true });
  assert.ok(existsSync(join(root, '.koala/story/actives/B-caps/capsule/capsule.json')), 'rebuild should recreate capsule.json');

  run(root, 'capsule_update', {
    storyId: 'B-caps',
    processEventRefs: [{ line: 1, type: 'capsule_updated' }],
  });
  const strictEventShow = run(root, 'capsule_show', { storyId: 'B-caps', strict: true }, true);
  assert.match(strictEventShow, /type mismatch/, 'strict capsule_show should reject process-event line/type mismatch');

  run(root, 'capsule_update', {
    storyId: 'B-caps',
    evidenceRefs: [{ path: 'missing-evidence.md' }],
    processEventRefs: [{ line: 1, type: 'dispatch' }],
  });
  const strictShow = run(root, 'capsule_show', { storyId: 'B-caps', strict: true }, true);
  assert.match(strictShow, /capsule refs invalid/, 'strict capsule_show should reject missing evidence refs');

  const noOmx = run(root, 'capsule_import_omx', { storyId: 'B-caps', sourceDir: join(root, '.omx-missing') });
  assert.match(noOmx, /No OMX context found/, 'missing .omx import should be a clear no-op');
  write(root, '.omx/context.md', 'OMX context summary\n');
  write(root, '.omx/metrics.json', '{"tokens":10}\n');
  const imported = run(root, 'capsule_import_omx', { storyId: 'B-caps' });
  assert.match(imported, /non_authoritative/, 'OMX import must be non-authoritative');
  const capsule = readJson<any>(join(root, '.koala/story/actives/B-caps/capsule/capsule.json'));
  assert.equal(capsule.importRefs.at(-1).authority, 'non_authoritative', 'import ref must remain non-authoritative');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ story capsule smoke passed');

function readdirSyncCompat(path: string): string[] {
  return readdirSync(path);
}
