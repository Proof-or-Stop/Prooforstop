#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'bin', 'koala-codex.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, payload, projectRoot = root) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function extractJsonValue(text) {
  const lines = text.split('\n');
  let offset = 0;
  let start = -1;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const looksLikeJsonArray = trimmed.startsWith('[') && !/^\[\d+(?:\.\d+)?s\]/.test(trimmed);
    if (trimmed.startsWith('{') || looksLikeJsonArray) {
      start = offset + line.length - trimmed.length;
      break;
    }
    offset += line.length + 1;
  }
  if (start === -1) throw new Error(`no JSON payload found in output: ${text}`);
  return JSON.parse(text.slice(start));
}

const help = run('help');
assert(help.includes('Truth:'), 'koala help missing Truth group');
for (const command of ['truth_scan', 'truth_nav', 'truth_analyze', 'truth_to_story', 'truth_extract']) {
  assert(help.includes(command), `koala help missing ${command}`);
}

const temp = mkdtempSync(join(tmpdir(), 'koala-truth-cli-'));
try {
  mkdirSync(join(temp, 'docs', 'requirements', 'decisions'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'packages', 'main', 'src'), { recursive: true });
  writeFileSync(join(temp, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(temp, 'docs', 'requirements', 'decisions', 'sample.md'), [
    '# Sample Truth',
    '',
    '- 需求：系统必须支持 CLI 恢复真相源命令',
    '- 决定：选择复用现有 truth task',
    '- 约束：不能依赖额外 bootstrap',
    '- 待确认：是否需要更多输出裁剪？',
    '',
  ].join('\n'));
  writeFileSync(join(temp, 'packages', 'main', 'src', 'sample.ts'), [
    '/**',
    ' * @task B-000',
    ' * @checklist CHK-001',
    ' * @title sample truth extract target',
    ' * @type feature',
    ' * @priority high',
    ' * @description sample function for truth extraction',
    ' * @changes',
    ' *   - [CHK-001] sample extraction entry',
    ' */',
    'export function sampleTruthFeature() {',
    "  return 'ok';",
    '}',
    '',
  ].join('\n'));

  const truthSummary = extractJsonValue(run('truth_scan', { summary: true }, temp));
  assert(typeof truthSummary.filesScanned === 'number', 'truth_scan summary missing filesScanned');
  assert(Array.isArray(truthSummary.topics), 'truth_scan summary missing topics array');
  assert(typeof truthSummary._summary === 'string', 'truth_scan summary missing _summary');

  const truthAnalyze = extractJsonValue(run('truth_analyze', undefined, temp));
  assert(Array.isArray(truthAnalyze.issues), 'truth_analyze missing issues array');
  assert(typeof truthAnalyze.healthy === 'boolean', 'truth_analyze missing healthy boolean');

  const truthStories = extractJsonValue(run('truth_to_story', undefined, temp));
  assert(Array.isArray(truthStories), 'truth_to_story should return an array');

  const navOut = run('truth_nav', undefined, temp);
  assert(navOut.includes('# 真相源导航'), 'truth_nav missing navigation output');
  assert(existsSync(join(temp, 'docs', 'requirements', 'NAV.md')), 'truth_nav missing NAV.md');

  const extractOut = run('truth_extract', undefined, temp);
  assert(extractOut.includes('提取完成:'), 'truth_extract missing completion text');
  const extractedDir = join(temp, 'docs', 'requirements', 'extracted');
  assert(existsSync(join(extractedDir, 'architecture.md')), 'truth_extract missing architecture.md');
  assert(existsSync(join(extractedDir, 'features.md')), 'truth_extract missing features.md');
  assert(extractOut.includes('truth_nav'), 'truth_extract missing truth_nav follow-up hint');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('truth CLI commands verified');
