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
    if (
      existsSync(join(dir, 'proof-or-stop.config.json'))
      && existsSync(join(dir, 'packages', 'main', 'src'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find repo root from ${start}`);
    dir = parent;
  }
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function agentFiles(dir: string): string[] {
  // An optional managed-agent directory may be absent in registry-backed thin mode.
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter(file => file.endsWith('.md'))
    .map(file => join(dir, file));
}

const targetDocs = [
  'CLAUDE.md',
  'packages/main/src/cli-prompts.ts',
  ...agentFiles('packages/main/templates/agents'),
  ...agentFiles('.claude/agents'),
  ...agentFiles('.proof-or-stop-codex/agents'),
];

const staleFirstSessionPhrases = [
  'Run `proof-or-stop status` at the start of every new session',
  'Run `proof-or-stop status` before taking action',
  'proof-or-stop status — check for existing active story',
  'proof-or-stop status — see current phase',
  'Not sure what to do now? Run proof-or-stop status',
  'proof-or-stop status                # one-screen view of project status',
];

for (const file of targetDocs) {
  const content = read(file);
  for (const phrase of staleFirstSessionPhrases) {
    assert.equal(content.includes(phrase), false, `${file} should not contain stale first-session wording: ${phrase}`);
  }
}

// B-cdf6 CHK-002: the footer is now rendered from the invoked bin token rather
// than a hardcoded name, so pin the builder + its next-step command instead of
// the old `proof-or-stop session_brief` literal.
assert.match(read('packages/main/src/cli-prompts.ts'), /sessionBriefFooter[\s\S]*\$\{bin\} session_brief/);
assert.match(read('packages/main/src/cli-prompts.ts'), /SESSION_BRIEF_FOOTER = sessionBriefFooter\(\)/);

const readme = read('README.md');
const guide = read('docs/guide.md');
const projectVision = read('docs/requirements/decisions/project-vision.md');

for (const [label, content] of [['docs/guide.md', guide]] as const) {
  assert.match(content, /npm --prefix packages\/main run build/, `${label} documents local package build before refresh`);
  assert.match(content, /npm install -g \.\/packages\/main/, `${label} documents global package refresh`);
  assert.match(content, /\bproof-or-stop --version\b/, `${label} verifies canonical binary version`);
  assert.match(content, /\bproof-or-stop check\b/, `${label} documents canonical check`);
  assert.match(content, /\bproof-or-stop doctor --format=json\b/, `${label} documents canonical doctor json`);
  assert.match(content, /\bproof-or-stop rollout_check --projects "\$\(pwd\)" --json\b/, `${label} documents canonical rollout_check refresh proof`);
}

assert.match(readme, /`proof-or-stop` is the CLI command name/i, 'README states the canonical command entry');
assert.match(readme, /`proof-or-stop --version`/, 'README documents the canonical version command');
assert.match(readme, /proof-or-stop session_brief/, 'README documents the canonical context-recovery command');
assert.match(readme, /proof-or-stop validate/, 'README documents the canonical validation command');
assert.match(
  guide,
  /`proof-or-stop` is the current command entry point and the only active product command/i,
  'guide states the canonical active command entry',
);
assert.match(
  projectVision,
  /`proof-or-stop` is the active product entry[\s\S]{0,160}do not accept the retired pre-cutover command as a compatibility alias/i,
  'project vision states the canonical-only active product entry without pinning an obsolete release number',
);
assert.match(projectVision, /`proof-or-stop rollout_check`[\s\S]{0,80}read-only scan/, 'project vision keeps rollout_check read-only constraint');

for (const file of targetDocs) {
  const content = read(file);
  assert.equal(content.includes('**issues advisory**'), false, `${file} should not regress to issues advisory wording`);
  assert.equal(content.includes('gate does not read severity'), false, `${file} should not say INIT_CHECK ignores severity`);
  if (content.includes('INIT→INIT_CHECK hard gate')) {
    assert.match(content, /missing_init_check_agent/, `${file} should document required reviewer blocker`);
    assert.match(content, /init_check_blocking_issues/, `${file} should document high\/critical issue blocker`);
    assert.match(content, /critical\/high issues block INIT_CHECK; medium\/low are advisory/, `${file} should document high/critical vs medium/low behavior`);
  }
}

const hookPath = join(repoRoot, '.claude', 'hooks', 'session-brief-reminder.cjs');
const reminder = 'Suggest running proof-or-stop session_brief first to restore context';

function runHook(root: string, input: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [hookPath], {
    input,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_SESSION_BRIEF_FRESH_MINUTES: '60' },
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
  const root = tmpRoot('proof-or-stop-session-brief-stale-');
  try {
    mkdirSync(join(root, '.proof-or-stop'), { recursive: true });
    writeFileSync(join(root, '.proof-or-stop', 'activity.jsonl'), JSON.stringify({
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
  const root = tmpRoot('proof-or-stop-session-brief-fresh-');
  try {
    mkdirSync(join(root, '.proof-or-stop'), { recursive: true });
    writeFileSync(join(root, '.proof-or-stop', 'activity.jsonl'), JSON.stringify({
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
  const root = tmpRoot('proof-or-stop-session-brief-bash-');
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'docs', 'story'), { recursive: true });
    writeFileSync(join(root, 'docs', 'story', 'activity.jsonl'), JSON.stringify({
      tool: 'Bash',
      detail: 'proof-or-stop session_brief',
      args: { command: 'proof-or-stop session_brief' },
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
  const root = tmpRoot('proof-or-stop-session-brief-retired-command-');
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'docs', 'story'), { recursive: true });
    const retiredCommands = [
      [['lat', 'tice'].join(''), 'session_brief'].join(' '),
      ['node bin/', 'lat', 'tice.js session_brief'].join(''),
    ];
    for (const command of retiredCommands) {
      writeFileSync(join(root, 'docs', 'story', 'activity.jsonl'), JSON.stringify({
        tool: 'Bash',
        detail: command,
        args: { command },
        endTime: new Date().toISOString(),
      }) + '\n');
      const result = runHook(root, JSON.stringify({ cwd: root }));
      assert.equal(result.status, 0);
      assert.match(result.output, new RegExp(reminder), `${command} must not count as a fresh canonical heartbeat`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmpRoot('proof-or-stop-session-brief-story-bash-');
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'docs', 'story', 'actives', 'B-demo'), { recursive: true });
    writeFileSync(join(root, 'docs', 'story', 'actives', 'B-demo', 'activity.jsonl'), JSON.stringify({
      tool: 'Bash',
      detail: 'proof-or-stop session_brief',
      args: { command: 'proof-or-stop session_brief' },
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
  const root = tmpRoot('proof-or-stop-session-brief-malformed-');
  try {
    const result = runHook(root, '{bad json');
    assert.equal(result.status, 0);
    assert.equal(result.output, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tmpRoot('proof-or-stop-session-brief-missing-');
  try {
    const result = runHook(root, JSON.stringify({ cwd: root }));
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cliInit = read('packages/main/src/cli-init.ts');
assert.match(cliInit, /getClaudeHooks/);
assert.match(cliInit, /session-brief-reminder\.cjs/);

console.log('✓ session brief prompt sync smoke passed');
