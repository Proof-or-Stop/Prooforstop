import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'packages/main/dist/cli.js');
const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-preflight-'));
const storyId = 'B-preflight';
const branch = `story/${storyId}`;
const wtPath = join(temp, '.worktrees', storyId);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function runProofOrStop(payload) {
  return execFileSync('node', [cli, '--root', wtPath, 'story_advance', JSON.stringify(payload)], {
    cwd: wtPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runProofOrStopExpectFail(payload) {
  try {
    runProofOrStop(payload);
    throw new Error('story_advance unexpectedly passed');
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}${error.message || ''}`;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(temp, 'packages', 'main', 'src'), { recursive: true });
  writeFileSync(join(temp, 'README.md'), '# temp\n');
  writeFileSync(join(temp, '.gitignore'), '.worktrees\nnode_modules\n');
  writeFileSync(join(temp, 'packages', 'main', 'src', 'index.ts'), 'export const ok = true;\n');
  writeFileSync(join(temp, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2) + '\n');
  git(temp, ['init', '-b', 'main']);
  git(temp, ['config', 'user.name', 'ProofOrStop Test']);
  git(temp, ['config', 'user.email', 'proofOrStop@example.com']);
  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'init']);
  git(temp, ['branch', branch]);
  mkdirSync(join(temp, '.worktrees'), { recursive: true });
  git(temp, ['worktree', 'add', wtPath, branch]);

  const { StoryStore } = await import(`${repoRoot}/packages/main/dist/core/store.js`);
  const store = new StoryStore(wtPath);
  const now = new Date().toISOString();
  store.writeStory(storyId, {
    storyId,
    name: storyId,
    title: 'DONE preflight',
    description: 'DONE preflight should stop before mutating branch when main has overlapping dirty files.',
    type: 'bug',
    phase: 'TEST',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    worktree: { path: `.worktrees/${storyId}`, branch, createdAt: now },
    events: [],
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'reviewed item',
      status: 'done',
      startTime: now,
      endTime: now,
      testIntent: null,
    }],
  });
  store.writeBugs(storyId, { bugs: [] });
  store.writeTestEvidence(storyId, { command: 'test_story', output: JSON.stringify({ allPassed: true, totalCases: 0, passedCases: 0, failedCases: 0 }), result: 'PASS', timestamp: now });
  const reviewTime = new Date().toISOString();
  const hash = createHash('sha256').update(`${storyId}:${reviewTime}:0:0:lattice-review-integrity-v1`).digest('hex');
  store.writeReview(storyId, { reviews: [{ timestamp: reviewTime, issueCount: 0, blockerCount: 0, issues: [], _hash: hash }] });
  store.writeImplementationReview(storyId, { storyId, verdict: 'pass', findings: [], summary: 'clean implementation review', createdAt: now, updatedAt: now });
  store.writeSummary(storyId, { storyId, timestamp: now, changes: 'preflight guard', usage: 'run DONE confirm', limitations: 'none', pitfalls: 'dirty main should fail before mutation' });
  git(wtPath, ['add', 'docs/story']);
  git(wtPath, ['commit', '-m', 'story ready for done']);

  const staleMainStoryDir = join(temp, 'docs', 'story', 'actives', storyId);
  mkdirSync(staleMainStoryDir, { recursive: true });
  writeFileSync(join(staleMainStoryDir, 'index.json'), '{"stale":true}\n');

  const before = JSON.parse(readFileSync(join(wtPath, 'docs', 'story', 'actives', storyId, 'index.json'), 'utf8'));
  const out = runProofOrStopExpectFail({ storyId, phase: 'DONE', confirm: true });
  const after = JSON.parse(readFileSync(join(wtPath, 'docs', 'story', 'actives', storyId, 'index.json'), 'utf8'));

  assert(out.includes('Cannot enter DONE: main 工作区有会被 story merge 覆盖'), `preflight error message missing:\n${out}`);
  assert(out.includes(`docs/story/actives/${storyId}/index.json`), 'overlapping dirty path not reported');
  assert(before.phase === 'TEST' && after.phase === 'TEST', 'story phase should remain TEST after preflight failure');
  assert(git(wtPath, ['log', '-1', '--pretty=%s']) === 'story ready for done', 'DONE commit should not be created before preflight passes');

  rmSync(staleMainStoryDir, { recursive: true, force: true });
  const lockDir = join(temp, '.git', 'koala');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'done-auto-git.lock'), JSON.stringify({ storyId: 'B-other', pid: 123, acquiredAt: now }) + '\n');
  const lockOut = runProofOrStopExpectFail({ storyId, phase: 'DONE', confirm: true });
  const afterLock = JSON.parse(readFileSync(join(wtPath, 'docs', 'story', 'actives', storyId, 'index.json'), 'utf8'));
  assert(lockOut.includes('another DONE auto-git operation is already running'), `lock error message missing:\n${lockOut}`);
  assert(lockOut.includes('不要并行执行多个 DONE confirm'), 'parallel DONE warning missing');
  assert(afterLock.phase === 'TEST', 'story phase should remain TEST when DONE lock is held');
  assert(git(wtPath, ['log', '-1', '--pretty=%s']) === 'story ready for done', 'DONE commit should not be created when DONE lock is held');

  console.log('done merge preflight verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
