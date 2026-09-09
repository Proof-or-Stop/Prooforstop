import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'packages/main/dist/cli.js');
const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-baseline-risk-'));

function runProofOrStop(command, payload) {
  const args = [cli, '--root', temp, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: temp,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function git(args) {
  return execFileSync('git', args, {
    cwd: temp,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`${label}: expected output to include ${JSON.stringify(needle)}\n\n${text}`);
  }
}

function assertNotIncludes(text, needle, label) {
  if (text.includes(needle)) {
    throw new Error(`${label}: expected output not to include ${JSON.stringify(needle)}\n\n${text}`);
  }
}

const background = `## Trigger Event
2026-05-13 baseline-risk smoke references B-risk and CHK-001 so story_create accepts the synthetic story. The goal is to verify that volatile runtime residue stays hidden while real user edits remain visible before worktree creation in this temporary repository.

## Key Insights
The baseline warning should surface material files that a human would lose when relying on a fresh worktree, but it should hide volatile runtime noise such as files under .proof-or-stop/runtime/. This synthetic story needs only enough background structure to satisfy the current story_create gate without changing the verification intent.

## Solution Tradeoffs
Keeping the background inline here is simpler than introducing a fixture file for a one-off smoke. The content stays deterministic, meets the four-section minimum, and keeps the script focused on baseline-risk semantics instead of broader story lifecycle setup.

## Conversational Texture
This smoke mirrors how a maintainer would reason about a dirty main branch: one real config file should trigger the warning, one volatile runtime path should stay hidden, and the session brief should still notice that the story worktree no longer contains the updated main branch after the material change is committed.
`;

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(temp, 'README.md'), '# temp\n');
  writeFileSync(join(temp, '.gitignore'), '.worktrees\n');
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

  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'ProofOrStop Test']);
  git(['config', 'user.email', 'proofOrStop@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  const created = runProofOrStop('story_create', {
    name: 'baseline-risk',
    title: 'Baseline risk verification',
    description: 'Verify dirty main baseline is visible before story worktree use.',
    background,
    type: 'feature',
    priority: 'high',
    checklist: [{ title: 'create worktree', context: 'baseline risk regression' }],
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`story id not found in output:\n${created}`);
  runProofOrStop('init_check_set', { storyId, issues: [], agentId: 'proof-or-stop-review-story-init' });
  runProofOrStop('init_check_set', { storyId, issues: [], agentId: 'proof-or-stop-product-reviewer' });
  runProofOrStop('scope_boundary_set', {
    storyId,
    mode: 'feature',
    allowedScope: ['Create the story worktree for baseline-risk regression coverage'],
    excludedScope: ['Unrelated source changes'],
    userConfirmed: true,
    confirmation: 'worktree baseline-risk smoke fixture',
  });
  runProofOrStop('execution_boundary_set', {
    storyId,
    allowedPaths: ['docs/story'],
    notes: 'worktree baseline-risk smoke fixture',
  });
  runProofOrStop('scope_freeze_check', { storyId });

  mkdirSync(join(temp, 'experiments', 'configs'), { recursive: true });
  mkdirSync(join(temp, '.proof-or-stop', 'runtime'), { recursive: true });
  writeFileSync(join(temp, 'experiments', 'configs', 'new-chart.json'), '{"chartType":"replay-delta"}\n');
  writeFileSync(join(temp, '.proof-or-stop', 'runtime', 'turns.jsonl'), '{}\n');

  const createdWorktree = runProofOrStop('story_advance', { storyId, phase: 'INIT_CHECK', confirm: true });
  assertIncludes(createdWorktree, 'Baseline risk', 'confirm baseline warning');
  assertIncludes(createdWorktree, 'experiments/configs/new-chart.json', 'confirm material path');
  assertNotIncludes(createdWorktree, '.proof-or-stop/runtime/turns.jsonl', 'confirm volatile path hidden');

  git(['add', 'experiments/configs/new-chart.json']);
  git(['commit', '-m', 'baseline: add chart config']);

  const brief = runProofOrStop('session_brief');
  assertIncludes(brief, `${storyId} INIT_CHECK`, 'session brief active story listing');
  assertIncludes(brief, `.worktrees/${storyId}`, 'session brief worktree path');

  console.log('worktree baseline risk verification passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
