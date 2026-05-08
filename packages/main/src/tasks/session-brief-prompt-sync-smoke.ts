#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, 'koala.config.json')) && existsSync(join(dir, 'packages', 'main'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find repo root from ${start}`);
    dir = parent;
  }
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function agentFiles(dir: string): string[] {
  return readdirSync(join(repoRoot, dir))
    .filter(file => file.endsWith('.md'))
    .map(file => join(dir, file));
}

const targetDocs = [
  'CLAUDE.md',
  'packages/main/src/cli-prompts.ts',
  ...agentFiles('packages/main/templates/agents'),
  ...agentFiles('.claude/agents'),
  ...agentFiles('.Codex/agents'),
];

const staleFirstSessionPhrases = [
  '每次新 session 先 `koala status`',
  '行动前先 `koala status`',
  'koala status — check for existing active story',
  'koala status — see current phase',
  '不知道现在该做什么？跑 koala status',
  'koala status                # 项目状态一屏看',
];

for (const file of targetDocs) {
  const content = read(file);
  for (const phrase of staleFirstSessionPhrases) {
    assert.equal(content.includes(phrase), false, `${file} should not contain stale first-session wording: ${phrase}`);
  }
}

assert.match(read('packages/main/src/cli-prompts.ts'), /SESSION_BRIEF_FOOTER[\s\S]*koala session_brief/);

for (const file of targetDocs) {
  const content = read(file);
  assert.equal(content.includes('**issues advisory**'), false, `${file} should not regress to issues advisory wording`);
  assert.equal(content.includes('gate 不读 severity'), false, `${file} should not say INIT_CHECK ignores severity`);
  if (content.includes('INIT→INIT_CHECK 硬门槛')) {
    assert.match(content, /missing_init_check_agent/, `${file} should document required reviewer blocker`);
    assert.match(content, /init_check_blocking_issues/, `${file} should document high\/critical issue blocker`);
    assert.match(content, /critical\/high issues 会阻塞 INIT_CHECK；medium\/low 为 advisory/, `${file} should document high/critical vs medium/low behavior`);
  }
}

const hookPath = join(repoRoot, '.claude', 'hooks', 'session-brief-reminder.cjs');
const reminder = '建议先运行 koala session_brief 恢复现场';

function runHook(root: string, input: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [hookPath], {
    input,
    encoding: 'utf8',
    env: { ...process.env, KOALA_SESSION_BRIEF_FRESH_MINUTES: '60' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

{
  const root = tmpRoot('koala-session-brief-stale-');
  try {
    mkdirSync(join(root, '.koala'), { recursive: true });
    writeFileSync(join(root, '.koala', 'activity.jsonl'), JSON.stringify({
      tool: 'session_brief',
      endTime: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
    }) + '\n');
    const result = runHook(root, JSON.stringify({ cwd: root }));
    assert.equal(result.status, 0);
    assert.match(result.output, new RegExp(reminder));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmpRoot('koala-session-brief-fresh-');
  try {
    mkdirSync(join(root, '.koala'), { recursive: true });
    writeFileSync(join(root, '.koala', 'activity.jsonl'), JSON.stringify({
      tool: 'session_brief',
      endTime: new Date().toISOString(),
    }) + '\n');
    const result = runHook(root, JSON.stringify({ cwd: root }));
    assert.equal(result.status, 0);
    assert.equal(result.output, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmpRoot('koala-session-brief-malformed-');
  try {
    const result = runHook(root, '{bad json');
    assert.equal(result.status, 0);
    assert.equal(result.output, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmpRoot('koala-session-brief-missing-');
  try {
    const result = runHook(root, JSON.stringify({ cwd: root }));
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cliInit = read('packages/main/src/cli-init.ts');
assert.match(cliInit, /UserPromptSubmit/);
assert.match(cliInit, /session-brief-reminder\.cjs/);

console.log('✓ session brief prompt sync smoke passed');
