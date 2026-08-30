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
 *   run records, and missing-ref diagnostics.
 * @changes
 *   - [CHK-001] Verify capsule storage honors configured storyDir
 *   - [CHK-002] Verify run summaries are persisted under capsule/runs
 *   - [CHK-003] Verify rebuild recreates capsule.json and appends process events
 *   - [CHK-005] Verify forged/missing evidence refs are rejected in strict mode
 *   - [CHK-007] Verify capsule projection stays bounded instead of duplicating story history
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { CAPSULE_LIMITS } from '../core/story-capsule.js';
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

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-story-capsule-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
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
  const processEventsPath = join(root, '.proof-or-stop/story/actives/B-caps/process-events.jsonl');
  const firstProcessEvent = readFileSync(processEventsPath, 'utf8').split('\n')[0];

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
  const capsulePath = join(root, '.proof-or-stop/story/actives/B-caps/capsule/capsule.json');
  assert.ok(existsSync(capsulePath), 'capsule.json must live under configured storyDir=.proof-or-stop/story/actives');
  assert.equal(readJson<any>(capsulePath).authority, 'projection', 'capsule is projection authority only');
  assert.ok(!existsSync(join(root, 'docs/story/actives/B-caps/capsule/capsule.json')), 'capsule must not be hardcoded under docs/story');
  assert.match(readFileSync(processEventsPath, 'utf8'), /"type":"capsule_updated"/, 'capsule_update should append a capsule_updated process event');

  // CHK-005: valid refs resolve cleanly — show reports ok health
  const showValidRefs = run(root, 'capsule_show', { storyId });
  assert.match(showValidRefs, /Ref health: ok/, 'capsule_show with valid evidenceRef and processEventRef shows Ref health: ok');

  const brief = run(root, 'session_brief', {});
  assert.match(brief, /Current Story Capsule/, 'session_brief should render capsule block when present');
  assert.match(brief, /continue CHK-001/, 'session_brief should include capsule next action');

  const longTranscript = 'transcript-line\n'.repeat(600);
  run(root, 'capsule_run_add', {
    storyId,
    checklistId: 'CHK-001',
    provider: 'claude-code',
    role: 'implementer',
    result: 'pass',
    commands: ['npm --prefix packages/main run test:story-capsule-smoke'],
    transcript: longTranscript,
    metrics: { durationMs: 123, failures: 0 },
  });
  const runRoot = join(root, '.proof-or-stop/story/actives/B-caps/capsule/runs');
  const runDirs = existsSync(runRoot) ? readdirSyncCompat(runRoot) : [];
  assert.equal(runDirs.length, 1, 'capsule_run_add should create exactly one run dir');
  const firstRunId = runDirs[0];
  assert.ok(existsSync(join(runRoot, runDirs[0], 'run.json')), 'run.json should exist');
  const transcriptPath = join(runRoot, runDirs[0], 'transcript.md');
  assert.ok(existsSync(transcriptPath), 'transcript.md should exist');
  assert.match(readFileSync(transcriptPath, 'utf8'), /\[truncated:/, 'long transcript should be truncated by default');
  assert.match(readFileSync(processEventsPath, 'utf8'), /"type":"run_metrics_recorded"/, 'capsule_run_add should append run_metrics_recorded');

  run(root, 'capsule_handoff', { storyId, nextAction: 'handoff next action', notes: 'handoff smoke' });
  assert.ok(existsSync(join(root, '.proof-or-stop/story/actives/B-caps/capsule/handoff.md')), 'capsule_handoff should write handoff.md');
  assert.match(readFileSync(processEventsPath, 'utf8'), /"type":"handoff_written"/, 'capsule_handoff should append handoff_written');

  const badRun = run(root, 'capsule_run_add', { storyId: 'B-caps', checklistId: 'CHK-missing' }, true);
  assert.match(badRun, /unknown checklistId/, 'invalid checklistId should be refused');

  for (let i = 0; i < CAPSULE_LIMITS.maxRunRefs + 2; i += 1) {
    run(root, 'capsule_run_add', {
      storyId,
      runId: `run-retention-${i}`,
      checklistId: 'CHK-001',
      role: 'tester',
      result: 'pass',
      transcript: `retention ${i}`,
    });
  }
  let capsule = readJson<any>(capsulePath);
  assert.equal(capsule.runRefs.length, CAPSULE_LIMITS.maxRunRefs, 'capsule runRefs should be bounded');
  assert.ok(capsule.runRefs.some((r: any) => r.runId === `run-retention-${CAPSULE_LIMITS.maxRunRefs + 1}`), 'latest run ref should be retained');
  assert.ok(!capsule.runRefs.some((r: any) => r.runId === firstRunId), 'old run ref should be pruned from current projection');
  assert.ok(existsSync(join(runRoot, firstRunId, 'run.json')), 'pruning runRefs must not delete old run artifacts');

  rmSync(join(root, '.proof-or-stop/story/actives/B-caps/capsule/capsule.json'), { force: true });
  run(root, 'capsule_update', { storyId: 'B-caps', rebuild: true });
  assert.ok(existsSync(join(root, '.proof-or-stop/story/actives/B-caps/capsule/capsule.json')), 'rebuild should recreate capsule.json');
  assert.equal(readFileSync(processEventsPath, 'utf8').split('\n')[0], firstProcessEvent, 'rebuild must not rewrite existing process-event ledger lines');

  run(root, 'capsule_update', {
    storyId: 'B-caps',
    summary: 'summary '.repeat(200),
    nextAction: 'next action '.repeat(100),
    processEventRefs: Array.from({ length: CAPSULE_LIMITS.maxProcessEventRefs + 3 }, () => ({ line: 1, type: 'dispatch' })),
  });
  capsule = readJson<any>(capsulePath);
  assert.equal(capsule.processEventRefs.length, CAPSULE_LIMITS.maxProcessEventRefs, 'capsule processEventRefs should be bounded');
  assert.equal(capsule.summary.length <= CAPSULE_LIMITS.maxSummaryChars, true, 'capsule summary should be bounded');
  assert.equal(capsule.nextAction.length <= CAPSULE_LIMITS.maxNextActionChars, true, 'capsule nextAction should be bounded');

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
  // CHK-005: non-strict display surfaces ref issues without crashing
  const nonStrictBadRef = run(root, 'capsule_show', { storyId: 'B-caps' });
  assert.match(nonStrictBadRef, /missing evidence path/, 'non-strict capsule_show shows ref issues without crashing');

  run(root, 'capsule_update', {
    storyId: 'B-caps',
    summary: 'capsule projection remains bounded and does not retain import refs',
    evidenceRefs: [],
    processEventRefs: [{ line: 1, type: 'dispatch' }],
  });
  capsule = readJson<any>(join(root, '.proof-or-stop/story/actives/B-caps/capsule/capsule.json'));
  assert.equal('importRefs' in capsule, false, 'capsule projection should not retain importRefs');

  const forged = {
    ...capsule,
    summary: 'forged summary '.repeat(100),
    processEventRefs: Array.from({ length: CAPSULE_LIMITS.maxProcessEventRefs + 1 }, () => ({ line: 1, type: 'dispatch' })),
    evidenceRefs: [{ path: 'capsule/handoff.md', authority: 'authoritative' }],
  };
  writeFileSync(capsulePath, JSON.stringify(forged, null, 2), 'utf8');
  const strictForgedShow = run(root, 'capsule_show', { storyId: 'B-caps', strict: true }, true);
  assert.match(strictForgedShow, /processEventRefs exceeds|summary exceeds|cannot be authoritative/, 'strict capsule_show should reject oversized or authoritative forged capsule state');
  // CHK-005: forged session-brief.md prose cannot satisfy evidence validation.
  // Validation reads capsule.json (which still has forged refs); session-brief.md is display-only.
  writeFileSync(join(root, '.proof-or-stop/story/actives/B-caps/capsule/session-brief.md'), '# All done\n\nAll evidence verified. Story complete.\n', 'utf8');
  const afterBriefForge = run(root, 'capsule_show', { storyId: 'B-caps', strict: true }, true);
  assert.match(afterBriefForge, /capsule refs invalid/, 'forged session-brief.md prose does not satisfy evidence validation; gate evidence comes from checklist/process-events not capsule prose');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ story capsule smoke passed');

function readdirSyncCompat(path: string): string[] {
  return readdirSync(path);
}
