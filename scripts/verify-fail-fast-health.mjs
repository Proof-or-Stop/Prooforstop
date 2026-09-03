#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args, options = {}) {
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON object in output: ${text}`);
  return JSON.parse(text.slice(start));
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-fail-fast-'));
  mkdirSync(join(dir, 'packages', 'main', 'src'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'metadata'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  return dir;
}

const tempProject = createTempProject();
const tempHealthDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-health-'));
const tempHealthPath = join(tempHealthDir, 'health.jsonl');

try {
  writeFileSync(join(tempProject, 'packages', 'main', 'src', 'sample.ts'), `/**
 * @task B-ffff
 * @checklist CHK-001
 * @title fail-fast source annotation
 * @type feature
 * @priority high
 * @description
 *   让 aux_sync extract 从源码读取 fail-fast / silent catch 相关注释，而不是被旧 metadata 绑死。
 * @changes
 *   - [CHK-001] source annotation should replace stale metadata during extract
 */
export function sample() {
  return 'ok';
}
`);

  writeFileSync(join(tempProject, 'docs', 'metadata', 'task.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: [{
      key: 'src/old.ts',
      task: 'STALE-001',
      title: 'stale metadata entry',
      sourceFile: 'src/old.ts',
      sourceLine: 1,
    }],
  }, null, 2));
  writeFileSync(join(tempProject, 'docs', 'metadata', 'flow.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    flows: [],
  }, null, 2));

  const extractOutput = runNode([
    join(root, 'bin', 'proof-or-stop-codex.js'),
    '--root',
    tempProject,
    'aux_sync',
    '--direction=extract',
  ]);
  assert(extractOutput.includes('extract 完成'), 'aux_sync extract did not run');

  const taskStore = JSON.parse(readFileSync(join(tempProject, 'docs', 'metadata', 'task.json'), 'utf8'));
  assert(taskStore.tasks.length === 1, `expected 1 task after extract, got ${taskStore.tasks.length}`);
  assert(taskStore.tasks[0].task === 'B-ffff', 'aux_sync extract kept stale metadata instead of source annotation');

  writeFileSync(tempHealthPath, JSON.stringify({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    category: 'persist:testEvidence',
    error: 'disk full',
    context: { storyId: 'B-9dae', command: 'test_story' },
  }) + '\n');

  const doctorRaw = runNode([
    join(root, 'packages', 'main', 'dist', 'cli.js'),
    '--root',
    root,
    'doctor',
    JSON.stringify({ format: 'json', limit: 20 }),
  ], {
    env: { ...process.env, PROOF_OR_STOP_HEALTH_PATH: tempHealthPath },
  });
  const doctor = extractJsonObject(doctorRaw);
  assert(doctor.total >= 1, 'doctor did not read any health issues');
  assert(doctor.byCategory?.['persist:testEvidence'] >= 1, 'doctor missing persist:testEvidence category');
  assert(Array.isArray(doctor.recent) && doctor.recent.some((entry) => entry.category === 'persist:testEvidence'), 'doctor recent issues missing expected health entry');

  console.log('fail-fast health verified');
} finally {
  if (existsSync(tempProject)) rmSync(tempProject, { recursive: true, force: true });
  if (existsSync(tempHealthDir)) rmSync(tempHealthDir, { recursive: true, force: true });
}
