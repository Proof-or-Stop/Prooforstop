#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const cli = join(repoRoot, 'packages/main/dist/cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(cwd, args) {
  return execFileSync('node', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

const temp = mkdtempSync(join(tmpdir(), 'lattice-bug-summary-'));

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  writeJson(join(temp, 'lattice.config.json'), {
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  });

  git(temp, ['init']);
  git(temp, ['config', 'user.name', 'Lattice Test']);
  git(temp, ['config', 'user.email', 'lattice@example.com']);
  writeFileSync(join(temp, '.gitignore'), 'node_modules\n');
  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'init']);

  const writeStory = (storyId, phase, type = 'bug') => {
    const storyDir = join(temp, 'docs', 'story', 'actives', storyId);
    mkdirSync(storyDir, { recursive: true });
    writeJson(join(storyDir, 'index.json'), {
      storyId,
      name: storyId,
      title: storyId,
      description: 'tmp',
      type,
      phase,
      priority: 'medium',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: phase === 'DONE' || phase === 'DISCARDED' ? new Date().toISOString() : null,
    });
    writeJson(join(storyDir, 'checklist.json'), { items: [] });
  };

  writeStory('B-discarded', 'DISCARDED');
  writeStory('B-done', 'DONE');
  writeStory('B-live', 'DEV');

  const output = run(temp, [cli, '--root', temp, 'story_list']);
  const parsed = JSON.parse(output.slice(output.indexOf('{')));
  const summary = parsed._bugSummary || '';

  assert(summary.includes('B-live'), 'live bug story should still be reported');
  assert(!summary.includes('B-discarded'), 'discarded bug story should not be reported as unresolved');
  assert(!summary.includes('B-done'), 'done bug story should not be reported as unresolved');

  console.log('story list bug summary verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
