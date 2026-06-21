#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const cli = join(root, 'bin', 'lattice.js');
const EXPECTED_CORE_VERSION = '0.3.36';
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
    assert(core.name === '@lattice/core', `core package name mismatch: ${core.name}`);
    assert(utils.name === '@lattice/utils', `utils package name mismatch: ${utils.name}`);
    assert(lab.name === '@lattice/lab', `lab package name mismatch: ${lab.name}`);
    assert(core.version === EXPECTED_CORE_VERSION, `core version mismatch: ${core.version}`);
    assert(utils.version === EXPECTED_EXTENSION_VERSION, `utils version mismatch: ${utils.version}`);
    assert(lab.version === EXPECTED_EXTENSION_VERSION, `lab version mismatch: ${lab.version}`);
    // main depends on @lattice/lab@0.3.1 (lab version matches, exact pin links in-workspace);
    // utils/lab depend on @lattice/core via the "*" workspace range because core (0.3.36)
    // no longer satisfies the legacy 0.3.1 pin and must resolve to the local workspace.
    assert(core.dependencies?.['@lattice/lab'] === EXPECTED_EXTENSION_VERSION, `core should depend on @lattice/lab@${EXPECTED_EXTENSION_VERSION}`);
    assert(utils.dependencies?.['@lattice/core'] === '*', 'utils should depend on the in-workspace @lattice/core ("*")');
    assert(lab.dependencies?.['@lattice/core'] === '*', 'lab should depend on the in-workspace @lattice/core ("*")');
    assert(!core.dependencies?.['@koala-agent/lab'], 'core should not depend on legacy @koala-agent/lab');
    assert(!utils.dependencies?.['@koala-agent/core'], 'utils should not depend on legacy @koala-agent/core');
    assert(!lab.dependencies?.['@koala-agent/core'], 'lab should not depend on legacy @koala-agent/core');
    assert(!core.dependencies?.['@lattice-agent/lab'], 'core should not depend on legacy @lattice-agent/lab scope');
    assert(!utils.dependencies?.['@lattice-agent/core'], 'utils should not depend on legacy @lattice-agent/core scope');
    assert(!lab.dependencies?.['@lattice-agent/core'], 'lab should not depend on legacy @lattice-agent/core scope');
  },
  'lab-help': () => {
    const out = run(['lab_create', '--help']);
    assert(out.includes('lattice lab_create'), 'global core bin should show lab_create help through the lattice bootstrap');
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
      const labResult = runAllowFailure(['--root', temp, 'lab_create', '--help']);
      // When the lab extension dist is absent, lab_create is not registered: the
      // core CLI reports it as an unknown command (English surface) or surfaces a
      // recovery hint. (Legacy builds used the Chinese "未知命令" string and a
      // non-zero exit; both forms are accepted.)
      assert(
        labResult.text.includes('Unknown command: lab_create')
          || labResult.text.includes('未知命令: lab_create')
          || labResult.text.includes('Recovery'),
        'lab failure should show unavailable lab command or recovery hint',
      );
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
