#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const repoRoot = process.cwd();
const GLOBAL_CODEX_FALLBACK = 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 koala';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label} missing "${needle}"`);
}

function readActivityRecord(session, tool) {
  const activityPath = join(repoRoot, '.koala', 'activity.jsonl');
  const text = readFileSync(activityPath, 'utf8').trim();
  if (!text) return null;
  const entries = text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return entries.findLast(entry => entry.session === session && entry.tool === tool) || null;
}

function readProcessEvent(session, command) {
  let storyId = '';
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (branch.startsWith('story/')) storyId = branch.slice('story/'.length);
  } catch {}
  if (!storyId) return null;
  const storyDir = join(repoRoot, '.koala', 'story', 'actives', storyId);
  const eventPath = join(storyDir, 'process-events.jsonl');
  if (!existsSync(eventPath)) return null;
  const entries = readFileSync(eventPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return entries.findLast(entry => entry.session === session && entry.command === command) || null;
}

const checks = [];

checks.push(() => {
  const out = run('node', ['bin/koala.js', 'aux_doc_list', '--format=json']);
  assertIncludes(out, '"docs"', 'bin/koala.js aux_doc_list');
});

checks.push(() => {
  const marker = `verify-entrypoints-${Date.now()}`;
  const out = run('node', ['bin/koala-codex.js', 'session_brief'], {
    env: {
      ...process.env,
      KOALA_ACTIVITY_SOURCE: 'not-codex',
      KOALA_ACTIVITY_SESSION: '',
      CODEX_SESSION_ID: marker,
    },
  });
  assertIncludes(out, '# koala session brief', 'bin/koala-codex.js session_brief');

  const record = readActivityRecord(marker, 'session_brief');
  assert(record, 'bin/koala-codex.js should write a session_brief activity record');
  assert(record.source === 'codex', 'bin/koala-codex.js should force activity source=codex');
  assert(record.entrypoint === 'local-wrapper', 'bin/koala-codex.js should mark entrypoint=local-wrapper');
  const event = readProcessEvent(marker, 'session_brief');
  assert(event, 'bin/koala-codex.js should write codex_cli process-event in active story');
  assert(event.source === 'codex' && event.entrypoint === 'local-wrapper', 'codex_cli event should include source and local wrapper entrypoint');
});

checks.push(() => {
  const marker = `verify-entrypoints-global-${Date.now()}`;
  const out = run('node', ['packages/main/dist/cli.js', 'session_brief'], {
    env: {
      ...process.env,
      KOALA_ACTIVITY_SOURCE: 'codex',
      KOALA_ACTIVITY_RECORD_READONLY: '1',
      KOALA_ACTIVITY_SESSION: marker,
    },
  });
  assertIncludes(out, '# koala session brief', 'global Codex fallback core CLI session_brief');

  const record = readActivityRecord(marker, 'session_brief');
  assert(record, 'global Codex fallback should write a session_brief activity record');
  assert(record.source === 'codex', 'global Codex fallback should write source=codex');
  assert(record.entrypoint === 'global-fallback', 'global Codex fallback should mark entrypoint=global-fallback');
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-'));
  try {
    mkdirSync(join(tempDir, '.Codex', 'agents'), { recursive: true });
    writeFileSync(join(tempDir, '.Codex', 'agents', 'implementer.md'), 'old codex-only prompt\n');
    writeFileSync(join(tempDir, '.Codex', 'agents', 'reviewer.md'), 'old codex-only prompt\n');

    const initOut = run('node', ['packages/main/dist/cli.js', 'init', tempDir]);
    assertIncludes(initOut, '.Codex/README.md', 'koala init output');

    const requiredFiles = [
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/skills/koala/skill.md',
      '.Codex/README.md',
      '.Codex/koala.json',
      '.Codex/agents/test-intent.md',
      '.Codex/agents/test-case-reviewer.md',
      '.Codex/agents/koala-review-quality.md',
      '.Codex/agents/koala-implementer.md',
    ];
    for (const rel of requiredFiles) {
      assert(existsSync(join(tempDir, rel)), `koala init missing ${rel}`);
    }

    const codexReadme = readFileSync(join(tempDir, '.Codex', 'README.md'), 'utf8');
    assertIncludes(codexReadme, 'node bin/koala-codex.js session_brief', '.Codex/README.md');
    assertIncludes(codexReadme, `${GLOBAL_CODEX_FALLBACK} session_brief`, '.Codex/README.md');
    assertIncludes(codexReadme, '.Codex/koala.json', '.Codex/README.md');
    assertIncludes(codexReadme, '不创建 `.Codex/hooks`', '.Codex/README.md');

    const codexManifest = JSON.parse(readFileSync(join(tempDir, '.Codex', 'koala.json'), 'utf8'));
    assert(codexManifest.adapterOwner === 'koala', 'adapter manifest should be owned by koala');
    assert(codexManifest.activitySource === 'codex', 'adapter manifest should declare activitySource=codex');
    assert(
      codexManifest.recommendedEntrypoints.some(entry => entry.command === 'node bin/koala-codex.js'),
      'adapter manifest should recommend the local Codex wrapper',
    );
    assert(
      codexManifest.recommendedEntrypoints[0]?.command === 'node bin/koala-codex.js',
      'adapter manifest should prefer the local Codex wrapper first',
    );
    assert(
      codexManifest.recommendedEntrypoints.some(entry => entry.command === GLOBAL_CODEX_FALLBACK),
      'adapter manifest should include the global source-tagged read-only fallback',
    );
    assert(
      codexManifest.sessionEnv.sessionCandidates.includes('CODEX_SESSION_ID')
        && codexManifest.sessionEnv.sessionCandidates.includes('OPENAI_SESSION_ID')
        && codexManifest.sessionEnv.sessionCandidates.includes('TERM_SESSION_ID'),
      'adapter manifest should document Codex/OpenAI/terminal session env candidates',
    );
    assert(codexManifest.sessionEnv.recordReadOnly === 'KOALA_ACTIVITY_RECORD_READONLY', 'adapter manifest should document read-only activity opt-in');
    assert(codexManifest.excludedRuntimeAssets.includes('.Codex/hooks'), 'adapter manifest should exclude .Codex/hooks');
    assert(codexManifest.excludedRuntimeAssets.includes('.Codex/settings.json'), 'adapter manifest should exclude .Codex/settings.json');
    assert(!existsSync(join(tempDir, '.Codex', 'hooks')), 'koala init should not create .Codex/hooks');
    assert(!existsSync(join(tempDir, '.Codex', 'settings.json')), 'koala init should not create .Codex/settings.json');

    const codexAgents = readdirSync(join(tempDir, '.Codex', 'agents'));
    assert(!codexAgents.includes('implementer.md'), 'koala init should not keep stale Codex-only implementer.md');
    assert(!codexAgents.includes('reviewer.md'), 'koala init should not keep stale Codex-only reviewer.md');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const [index, check] of checks.entries()) {
  check();
  console.log(`ok ${index + 1}/${checks.length}`);
}

console.log('entrypoints verified');
