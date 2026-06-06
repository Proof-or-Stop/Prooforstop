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
  'Run `koala status` at the start of every new session',
  'Run `koala status` before taking action',
  'koala status — check for existing active story',
  'koala status — see current phase',
  'Not sure what to do now? Run koala status',
  'koala status                # one-screen view of project status',
];

for (const file of targetDocs) {
  const content = read(file);
  for (const phrase of staleFirstSessionPhrases) {
    assert.equal(content.includes(phrase), false, `${file} should not contain stale first-session wording: ${phrase}`);
  }
}

assert.match(read('packages/main/src/cli-prompts.ts'), /SESSION_BRIEF_FOOTER[\s\S]*lattice session_brief/);

const readme = read('README.md');
const guide = read('docs/guide.md');
const projectVision = read('docs/requirements/decisions/project-vision.md');

for (const [label, content] of [['README.md', readme], ['docs/guide.md', guide]] as const) {
  assert.match(content, /npm --prefix packages\/main run build/, `${label} documents local package build before refresh`);
  assert.match(content, /npm install -g \.\/packages\/main/, `${label} documents global package refresh`);
  assert.match(content, /\blattice --version\b/, `${label} verifies primary lattice binary version`);
  assert.match(content, /\bkoala --version\b/, `${label} verifies legacy koala alias version`);
  assert.match(content, /\blattice check\b/, `${label} documents lattice check`);
  assert.match(content, /\blattice doctor --format=json\b/, `${label} documents lattice doctor json`);
  assert.match(content, /\blattice rollout_check --projects "\$\(pwd\)" --json\b/, `${label} documents rollout_check refresh proof`);
}

assert.match(readme, /`lattice`\s+[\s\S]{0,80}primary entry[\s\S]{0,120}`koala`[\s\S]{0,80}legacy alias/, 'README states lattice primary and koala legacy alias');
assert.match(readme, /node bin\/lattice\.js tool_status/, 'README uses lattice local wrapper for generic tool_status');
assert.match(readme, /node bin\/lattice\.js verify_codex/, 'README uses lattice local wrapper for generic verify_codex fallback');
assert.match(readme, /node bin\/lattice\.js aux_doc_list/, 'README uses lattice local wrapper for generic aux_doc_list');
assert.doesNotMatch(readme, /node bin\/koala\.js (?:tool_status|verify_codex|aux_doc_list)\b/, 'README keeps bin/koala.js as legacy alias, not preferred generic command examples');
assert.match(guide, /`lattice` is the current primary command entry, `koala` is retained only as a legacy alias/, 'guide states lattice primary and koala legacy alias');
assert.match(projectVision, /`lattice` is the 0\.3\.5 primary product entry, `koala` is retained as a compatibility alias/, 'project vision states primary and legacy aliases');
assert.match(projectVision, /`lattice rollout_check` read-only scan/, 'project vision keeps rollout_check read-only constraint');
assert.match(projectVision, /`lattice --version`[\s\S]{0,80}`koala --version`/, 'project vision requires primary and alias version verification');

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
const reminder = 'Suggest running lattice session_brief first to restore context';

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
  const root = tmpRoot('koala-session-brief-legacy-bash-');
  try {
    mkdirSync(join(root, 'docs', 'story'), { recursive: true });
    writeFileSync(join(root, 'docs', 'story', 'activity.jsonl'), JSON.stringify({
      tool: 'Bash',
      detail: 'koala session_brief',
      args: { command: 'koala session_brief' },
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
  const root = tmpRoot('lattice-session-brief-bash-');
  try {
    mkdirSync(join(root, 'docs', 'story'), { recursive: true });
    writeFileSync(join(root, 'docs', 'story', 'activity.jsonl'), JSON.stringify({
      tool: 'Bash',
      detail: 'lattice session_brief',
      args: { command: 'lattice session_brief' },
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
  const root = tmpRoot('koala-session-brief-story-bash-');
  try {
    mkdirSync(join(root, 'docs', 'story', 'actives', 'B-demo'), { recursive: true });
    writeFileSync(join(root, 'docs', 'story', 'actives', 'B-demo', 'activity.jsonl'), JSON.stringify({
      tool: 'Bash',
      detail: 'koala session_brief',
      args: { command: 'koala session_brief' },
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
assert.match(cliInit, /getKoalaHooks/);
assert.match(cliInit, /session-brief-reminder\.cjs/);

console.log('✓ session brief prompt sync smoke passed');
