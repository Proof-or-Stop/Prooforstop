#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const labHandlerPath = join(root, 'packages', 'lab', 'dist', 'handlers', 'lab.js');

function ensureLabHandlersBuilt() {
  if (existsSync(labHandlerPath)) return;

  const command = 'npm --prefix packages/lab run build';
  try {
    execFileSync('npm', ['--prefix', 'packages/lab', 'run', 'build'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `Unable to build lab handlers before running the prompt profile verifier. ` +
      `Command \`${command}\` failed.${output ? `\n${output}` : ''}`,
      { cause: error },
    );
  }

  if (!existsSync(labHandlerPath)) {
    throw new Error(
      `Lab build completed but did not produce ${labHandlerPath}. ` +
      `Run \`${command}\` and inspect the build output.`,
    );
  }
}

ensureLabHandlersBuilt();
const { createLabHandlers } = await import(pathToFileURL(labHandlerPath).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createConfirmedLabHandlers(rootDir) {
  const handlers = createLabHandlers({ root: rootDir });
  return {
    lab_create: handlers.lab_create,
    lab_run(args) {
      if (args?.confirm !== true) {
        throw new Error('Prompt profile verifier lab_run requires confirm=true.');
      }
      return handlers.lab_run({ ...args, confirm: true });
    },
  };
}

function assertConfirmGate(lab, dir) {
  let refused = false;
  try {
    lab.lab_run({ config: 'experiments/configs/lab-test-intent-prompt-quality-v1.json' });
  } catch (error) {
    refused = true;
    assert(String(error).includes('confirm=true'), 'missing confirm=true should be rejected clearly');
  }
  assert(refused, 'lab_run without confirm=true must be rejected');
  assert(
    !existsSync(join(dir, 'experiments', 'runs', 'lab-test-intent-prompt-quality-v1', 'run-001')),
    'rejected lab_run must not create run artifacts',
  );
  assert(
    !existsSync(join(dir, '.worktrees', 'lab-test-intent-prompt-quality-v1-run-001')),
    'rejected lab_run must not create a sandbox',
  );
}

function makeProject(baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-test-intent-prompt-profile-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, 'samples'), { recursive: true });
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot:'packages/main', rootDir:'src', outDir:'packages/main/dist', testsDir:'packages/main/tests', fixturesDir:'packages/main/tests/fixtures', storyDir:'docs/story/actives', requirementsDir:'docs/requirements', storyPrefix:'B' }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# prompt profile\n');
  writeFileSync(join(dir, 'samples', 'prompt.md'), baseline);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'ProofOrStop Lab'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'proofOrStop@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const lab = createConfirmedLabHandlers(dir);
  lab.lab_create({
    id: 'lab-test-intent-prompt-quality-v1',
    target: 'test-intent-prompt',
    profile: 'test-intent-prompt-quality-v1',
    editableFiles: ['samples/prompt.md'],
  });
  assertConfirmGate(lab, dir);
  return dir;
}

function evaluate(baseline, candidate) {
  const dir = makeProject(baseline);
  try {
    writeFileSync(join(dir, 'samples', 'prompt.md'), candidate);
    const lab = createConfirmedLabHandlers(dir);
    lab.lab_run({
      config: 'experiments/configs/lab-test-intent-prompt-quality-v1.json',
      confirm: true,
    });
    return JSON.parse(readFileSync(join(dir, 'experiments', 'runs', 'lab-test-intent-prompt-quality-v1', 'run-001', 'result.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const current = readFileSync('.claude/agents/proof-or-stop-test-intent.md', 'utf8');
const weak = current
  .replace(/### (?:Recommended Fields for fixture-heavy Items|fixture-heavy item 的推荐字段)[\s\S]*?## Quality Standards/, '## Quality Standards')
  .replace(/- fixture-heavy item 优先提供.*\n/, '');

const canonicalProfileSignals = [
  'has fixtureHeavyGuidance',
  'has supportedTypes',
  'has descGuidance',
  'has whyGuidance',
  'has unsupportedFieldsGuard',
  'has nonMandatory',
  'has adversarialDistinct',
];

const checks = {
  'prompt-high': () => {
    const result = evaluate(weak, current);
    assert(result.normalizedScore > 0.7, `expected high normalizedScore, got ${result.normalizedScore}`);
    for (const signal of canonicalProfileSignals) {
      assert(result.contentSummary.includes(signal), `should detect ${signal}`);
    }
  },
  'prompt-low': () => {
    const result = evaluate(current, weak);
    assert(result.contentSummary.includes('missing fixtureHeavyGuidance'), 'weak prompt should miss fixture-heavy guidance');
    assert(result.normalizedScore < 0.8, `weak prompt should score lower, got ${result.normalizedScore}`);
  },
  'registry': () => {
    const out = execFileSync('node', ['-e', "import('./packages/lab/dist/core/profile.js').then(m=>console.log(m.listProfiles().join('\\n')))"], { cwd: root, encoding: 'utf8' });
    assert(out.includes('test-intent-prompt-quality-v1'), 'profile registry should include prompt profile');
    assert(out.includes('test-intent-quality-v1'), 'original output sample profile should remain');
  },
};

if (mode !== 'all') {
  const check = checks[mode];
  if (!check) throw new Error(`unknown mode ${mode}`);
  check();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(checks)) {
  check();
  console.log(`ok ${name}`);
}
console.log('verificationIntent prompt profile verified');
