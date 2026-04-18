#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const cli = join(root, 'packages', 'main', 'dist', 'cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, opts = {}) {
  return execFileSync('node', [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function runAllowFailure(args) {
  try {
    return { ok: true, text: run(args) };
  } catch (error) {
    return {
      ok: false,
      text: `${error.stdout || ''}${error.stderr || ''}`,
    };
  }
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'koala-global-lab-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  return dir;
}

function readPackage(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

const checks = {
  versions: () => {
    const core = readPackage('packages/main/package.json');
    const utils = readPackage('packages/utils/package.json');
    const lab = readPackage('packages/lab/package.json');
    assert(core.version === '0.2.2', `core version mismatch: ${core.version}`);
    assert(utils.version === '0.2.2', `utils version mismatch: ${utils.version}`);
    assert(lab.version === '0.2.2', `lab version mismatch: ${lab.version}`);
    assert(core.dependencies?.['@koala-agent/lab'] === '0.2.2', 'core should depend on @koala-agent/lab@0.2.2');
    assert(utils.dependencies?.['@koala-agent/core'] === '0.2.2', 'utils should depend on core@0.2.2');
    assert(lab.dependencies?.['@koala-agent/core'] === '0.2.2', 'lab should depend on core@0.2.2');
  },
  'lab-help': () => {
    const out = run(['lab', '--help']);
    assert(out.includes('koala lab'), 'global core bin should show lab namespace help');
    assert(out.includes('lab create'), 'global core bin should list lab create');
    assert(out.includes('lab promote'), 'global core bin should list lab promote');
  },
  'lab-create': () => {
    const temp = createTempProject();
    try {
      const out = run(['--root', temp, 'lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1']);
      assert(out.includes('Created experiment'), 'global core bin lab create should succeed');
      assert(existsSync(join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json')), 'lab create should write config');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'core-without-lab': () => {
    const temp = createTempProject();
    const dist = join(root, 'packages', 'lab', 'dist');
    const backup = join(root, 'packages', 'lab', 'dist.global-entrypoint-bak');
    try {
      renameSync(dist, backup);
      const out = run(['--root', temp, 'session_brief']);
      assert(out.includes('# koala session brief'), 'core command should still work when lab dist is absent');
      const failed = runAllowFailure(['--root', temp, 'lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1']);
      assert(!failed.ok, 'lab command should fail when lab extension is unavailable');
      assert(failed.text.includes('koala-lab 尚未构建') || failed.text.includes('Recovery'), 'lab failure should show recovery hint');
    } finally {
      if (existsSync(backup)) renameSync(backup, dist);
      rmSync(temp, { recursive: true, force: true });
    }
  },
};

if (mode !== 'all') {
  const check = checks[mode];
  if (!check) throw new Error(`unknown verify-global-lab-entrypoint mode: ${mode}`);
  check();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(checks)) {
  check();
  console.log(`ok ${name}`);
}

console.log('global lab entrypoint verified');
