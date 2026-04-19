import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'packages/main/dist/cli.js');
const temp = mkdtempSync(join(tmpdir(), 'koala-baseline-risk-'));

function runKoala(command, payload) {
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

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(temp, 'README.md'), '# temp\n');
  writeFileSync(join(temp, '.gitignore'), '.worktrees\n');
  writeFileSync(join(temp, 'koala.config.json'), JSON.stringify({
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
  git(['config', 'user.name', 'Koala Test']);
  git(['config', 'user.email', 'koala@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  const created = runKoala('story_create', {
    name: 'baseline-risk',
    title: 'Baseline risk verification',
    description: 'Verify dirty main baseline is visible before story worktree use.',
    type: 'feature',
    priority: 'high',
    checklist: [{ title: 'create worktree', context: 'baseline risk regression' }],
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`story id not found in output:\n${created}`);

  mkdirSync(join(temp, 'experiments', 'configs'), { recursive: true });
  mkdirSync(join(temp, '.omx', 'logs'), { recursive: true });
  writeFileSync(join(temp, 'experiments', 'configs', 'new-chart.json'), '{"chartType":"replay-delta"}\n');
  writeFileSync(join(temp, '.omx', 'logs', 'turns.jsonl'), '{}\n');

  const dryRun = runKoala('story_advance', { storyId, phase: 'INIT_CHECK', dryRun: true });
  assertIncludes(dryRun, 'Baseline risk', 'dry-run baseline warning');
  assertIncludes(dryRun, 'experiments/configs/new-chart.json', 'dry-run material path');
  assertNotIncludes(dryRun, '.omx/logs/turns.jsonl', 'dry-run volatile path hidden');

  const createdWorktree = runKoala('story_advance', { storyId, phase: 'INIT_CHECK', confirm: true });
  assertIncludes(createdWorktree, 'Baseline risk', 'confirm baseline warning');
  assertIncludes(createdWorktree, 'experiments/configs/new-chart.json', 'confirm material path');

  git(['add', 'experiments/configs/new-chart.json']);
  git(['commit', '-m', 'baseline: add chart config']);

  const brief = runKoala('session_brief');
  assertIncludes(brief, `branch story/${storyId} does not contain current main`, 'session brief branch freshness warning');

  console.log('worktree baseline risk verification passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
