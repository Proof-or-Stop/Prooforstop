#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localDistCli = join(repoRoot, 'packages/main/dist', 'cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, needle, message) {
  assert(text.includes(needle), `${message}\n--- output ---\n${text}`);
}

function run(cwd, args) {
  return execFileSync('node', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function execTrim(command, args, cwd = repoRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function unique(values) {
  return [...new Set(values)];
}

function cliCandidates() {
  const candidates = [localDistCli];
  try {
    const commonGitDir = execTrim('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    candidates.push(join(dirname(commonGitDir), 'packages/main/dist', 'cli.js'));
  } catch {
    // PROBE: non-git checkout; local dist assertion below explains the missing CLI.
  }
  return unique(candidates);
}

function isRunnableCli(candidate) {
  if (!existsSync(candidate)) return false;
  try {
    execFileSync('node', [candidate, 'help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    // PROBE: keep scanning candidates; the final assertion reports all paths.
    return false;
  }
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

const candidateCliPaths = cliCandidates();
const cli = candidateCliPaths.find(isRunnableCli) || candidateCliPaths.find((candidate) => existsSync(candidate)) || candidateCliPaths[0];
const staleStorySegment = `${sep}.worktrees${sep}B-8f6a${sep}`;

assert(existsSync(localDistCli), `Missing built Koala CLI at ${localDistCli}. Run npm run build first.`);
assert(isRunnableCli(cli), `Expected runnable built Koala CLI. Checked: ${candidateCliPaths.join(', ')}. Run npm run build first.`);
assert(!cli.includes(staleStorySegment), `Main branch runtime health must not use stale story worktree CLI path: ${cli}`);

const temp = mkdtempSync(join(tmpdir(), 'koala-main-runtime-'));

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  writeJson(join(temp, 'koala.config.json'), {
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
  git(temp, ['config', 'user.name', 'Koala Test']);
  git(temp, ['config', 'user.email', 'koala@example.com']);
  writeFileSync(join(temp, '.gitignore'), 'node_modules\n');
  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'init']);

  const storyId = 'B-main';
  const branch = `story/${storyId}`;
  const stalePath = '.worktrees/B-main-stale';
  const livePath = '.worktrees/B-main-live';
  const absLivePath = join(temp, livePath);
  const storyDir = join(temp, 'docs', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });

  writeJson(join(storyDir, 'index.json'), {
    storyId,
    name: 'main-branch-runtime-health',
    title: 'Main branch runtime health',
    description: 'tmp',
    type: 'feature',
    phase: 'TEST_CASE_REVIEW',
    priority: 'high',
    lane: 'mainline',
    parallelSafe: 'no',
    sharedHotspots: ['packages/main/src/handlers/session.ts'],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    worktree: {
      path: stalePath,
      branch,
      createdAt: new Date().toISOString(),
    },
  });

  writeJson(join(storyDir, 'checklist.json'), {
    items: [
      {
        id: 'CHK-001',
        title: 'tmp',
        status: 'done',
        startTime: null,
        endTime: null,
        testIntent: {
          happy: [{ desc: 'happy', type: 'cli_blackbox', results: [{ time: new Date().toISOString(), pass: true, note: 'fixture:1 WHY ok severity=info', role: 'reviewer' }] }],
          edge: [{ desc: 'edge', type: 'cli_blackbox', results: [{ time: new Date().toISOString(), pass: true, note: 'fixture:2 WHY ok severity=info', role: 'reviewer' }] }],
          adversarial: [{ desc: 'adv', type: 'cli_blackbox', results: [{ time: new Date().toISOString(), pass: true, note: 'fixture:3 WHY ok severity=info', role: 'reviewer' }] }],
        },
      },
    ],
  });

  const reviewTimestamp = new Date().toISOString();
  const hashInput = `${storyId}:${reviewTimestamp}:0:0:koala-review-integrity-v1`;
  writeJson(join(storyDir, 'review.json'), {
    reviews: [
      {
        timestamp: reviewTimestamp,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
        _hash: createHash('sha256').update(hashInput).digest('hex'),
      },
    ],
  });

  writeJson(join(storyDir, 'implementation-review.json'), {
    storyId,
    verdict: 'fail',
    findings: [
      {
        file: 'packages/main/src/handlers/session.ts',
        line: 1,
        why: 'main-branch briefing should surface reviewer/runtime risk',
        severity: 'high',
      },
    ],
    summary: 'implementation reviewer found a blocking issue',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'story']);
  git(temp, ['worktree', 'add', '-b', branch, absLivePath]);

  const brief = run(temp, [cli, '--root', temp, 'session_brief']);
  assertIncludes(brief, '## Active stories', 'main-branch session_brief missing active stories');
  assertIncludes(brief, 'B-main REVIEW (authority:worktree)', 'main-branch session_brief missing worktree-authoritative story state');
  assertIncludes(brief, '.worktrees/B-main-live', 'main-branch session_brief missing live worktree path');
  assertIncludes(brief, 'Resume: cd', 'main-branch session_brief missing recovery/next-step hint');
  assert(!brief.includes(stalePath), `main-branch session_brief should not point to stale story record path\n--- output ---\n${brief}`);
  assert(!brief.includes('B-8f6a'), `main-branch session_brief should not leak stale hardcoded worktree path\n--- output ---\n${brief}`);

  console.log('main branch runtime health verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
