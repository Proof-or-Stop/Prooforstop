#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const cli = join(root, 'bin', 'lattice.js');
const EXPECTED_CORE_VERSION = '0.3.6';
const EXPECTED_EXTENSION_VERSION = '0.3.1';

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
  const dir = mkdtempSync(join(tmpdir(), 'lattice-global-lab-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'lattice.config.json'), JSON.stringify({
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
    assert(core.name === '@lattice-agent/core', `core package name mismatch: ${core.name}`);
    assert(utils.name === '@lattice-agent/utils', `utils package name mismatch: ${utils.name}`);
    assert(lab.name === '@lattice-agent/lab', `lab package name mismatch: ${lab.name}`);
    assert(core.version === EXPECTED_CORE_VERSION, `core version mismatch: ${core.version}`);
    assert(utils.version === EXPECTED_EXTENSION_VERSION, `utils version mismatch: ${utils.version}`);
    assert(lab.version === EXPECTED_EXTENSION_VERSION, `lab version mismatch: ${lab.version}`);
    assert(core.dependencies?.['@lattice-agent/lab'] === EXPECTED_EXTENSION_VERSION, `core should depend on @lattice-agent/lab@${EXPECTED_EXTENSION_VERSION}`);
    assert(utils.dependencies?.['@lattice-agent/core'] === EXPECTED_EXTENSION_VERSION, `utils should depend on @lattice-agent/core@${EXPECTED_EXTENSION_VERSION}`);
    assert(lab.dependencies?.['@lattice-agent/core'] === EXPECTED_EXTENSION_VERSION, `lab should depend on @lattice-agent/core@${EXPECTED_EXTENSION_VERSION}`);
    assert(!core.dependencies?.['@koala-agent/lab'], 'core should not depend on legacy @koala-agent/lab');
    assert(!utils.dependencies?.['@koala-agent/core'], 'utils should not depend on legacy @koala-agent/core');
    assert(!lab.dependencies?.['@koala-agent/core'], 'lab should not depend on legacy @koala-agent/core');
  },
  'lab-help': () => {
    const out = run(['lab_create', '--help']);
    assert(out.includes('lattice lab_create'), 'global core bin should show lab_create help through the lattice bootstrap');
    assert(out.includes('兼容: koala lab_create'), 'global core bin should preserve koala lab_create alias help');
  },
  'lab-create-policy-gate': () => {
    const temp = createTempProject();
    try {
      const failed = runAllowFailure(['--root', temp, 'lab_create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1']);
      assert(!failed.ok, 'lab_create execution should remain fail-closed until lab commands are classified');
      assert(failed.text.includes('no valid ownershipClass'), 'lab_create should reach the ownership policy gate');
      assert(!existsSync(join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json')), 'policy-gated lab_create should not write config');
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
      assert(out.includes('# lattice session brief'), 'core command should still work when lab dist is absent');
      const failed = runAllowFailure(['--root', temp, 'lab_create', '--help']);
      assert(!failed.ok, 'lab command should fail when lab extension is unavailable');
      assert(failed.text.includes('未知命令: lab_create') || failed.text.includes('Recovery'), 'lab failure should show unavailable lab command or recovery hint');
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
