#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseCliJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`JSON payload not found in CLI output:\n${text}`);
  return JSON.parse(text.slice(start));
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-lab-foundation-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# temp project\n');
  mkdirSync(join(dir, '.proof-or-stop-codex', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.proof-or-stop-codex', 'agents', 'proof-or-stop-test-case-reviewer.md'), '# test-case-reviewer\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'ProofOrStop Lab Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'proof-or-stop-lab@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  return dir;
}

const temp = createTempProject();
execFileSync('npm', ['--prefix', 'packages/lab', 'run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
const { createLabHandlers } = await import(pathToFileURL(join(repoRoot, 'packages', 'lab', 'dist', 'handlers', 'lab.js')).href);
const lab = createLabHandlers({ root: temp });

try {
  const createOut = lab.lab_create({ target: 'test-case-reviewer', profile: 'reviewer-quality-v1' });
  assert(createOut.includes('Created experiment'), 'lab create should report the created experiment');

  const configPath = join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json');
  assert(existsSync(configPath), 'lab create should write experiment config');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert(config.$schema === 'proof-or-stop-lab/experiment.v1', 'new experiment configs should use the canonical proof-or-stop-lab schema');
  assert(config.target.entryFile === '.proof-or-stop-codex/agents/proof-or-stop-test-case-reviewer.md', 'test-case-reviewer should use the canonical proof-or-stop agent path first');
  assert(
    JSON.stringify(config.target.editableFiles) === JSON.stringify([
      '.proof-or-stop-codex/agents/proof-or-stop-test-case-reviewer.md',
      '.lattice-codex/agents/test-case-reviewer.md',
    ]),
    'test-case-reviewer should retain only its exact pre-migration .lattice-codex fallback',
  );
  assert(config.candidatePolicy.allowStoryMutation === false, 'lab config should keep allowStoryMutation=false');
  assert(config.candidatePolicy.allowFixtureMutation === false, 'lab config should keep allowFixtureMutation=false');

  lab.lab_create({ target: 'test-intent', profile: 'test-intent-quality-v1' });
  const intentConfig = JSON.parse(readFileSync(
    join(temp, 'experiments', 'configs', 'lab-intent-test-intent-quality-v1.json'),
    'utf8',
  ));
  assert(intentConfig.target.entryFile === '.proof-or-stop-codex/agents/proof-or-stop-test-intent.md', 'test-intent should use the canonical proof-or-stop agent path first');
  assert(
    JSON.stringify(intentConfig.target.editableFiles) === JSON.stringify([
      '.proof-or-stop-codex/agents/proof-or-stop-test-intent.md',
      '.lattice-codex/agents/test-intent.md',
    ]),
    'test-intent should retain only its exact pre-migration .lattice-codex fallback',
  );

  const dryRunOut = lab.lab_run({
    config: 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
    dryRun: true,
  });
  assert(dryRunOut.includes('[lab] sandbox ready at'), 'lab run --dry-run should print sandbox path');
  assert(dryRunOut.includes('No project files outside the sandbox were modified'), 'lab run --dry-run should confirm no mutation');

  const runOut = lab.lab_run({
    config: 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
    confirm: true,
  });
  const sandboxPath = runOut.match(/\[lab\] sandbox ready at (.+)/)?.[1]?.trim();
  assert(Boolean(sandboxPath), 'lab run --confirm should print sandbox path');
  assert(Boolean(sandboxPath && existsSync(sandboxPath)), 'lab run --confirm should create sandbox worktree');
  const resultPath = join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001', 'result.json');
  assert(existsSync(resultPath), 'lab run should write result.json placeholder');
  const snapshot = JSON.parse(readFileSync(
    join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001', 'config.snapshot.json'),
    'utf8',
  ));
  assert(snapshot.$schema === 'proof-or-stop-lab/experiment.v1', 'lab run snapshots should preserve the canonical proof-or-stop-lab schema');

  const allowedEval = run([
    'bin/proof-or-stop.js',
    '--root', temp,
    'lab',
    'eval',
    JSON.stringify({
      config: 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
      files: ['.proof-or-stop-codex/agents/test-case-reviewer.md'],
    }),
  ]);
  assert(parseCliJson(allowedEval).ok === true, 'lab eval should allow editableFiles');

  const blockedEval = lab.lab_eval({
    config: 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
    files: ['docs/story/actives/B-1234/index.json'],
  });
  const blocked = parseCliJson(blockedEval);
  assert(blocked.ok === false, 'lab eval should reject docs/story writes');
  assert(blocked.violations.some((line) => line.includes('blocked protected path')), 'lab eval should explain blocked protected path');

  console.log('lab foundation verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
