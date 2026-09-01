#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const cli = join(root, 'bin', 'proof-or-stop.js');
const EXPECTED_CORE_VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const EXPECTED_EXTENSION_VERSION = '0.3.65';
const EXPECTED_CORE_PEER_RANGE = '^0.3.65';

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
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-global-lab-'));
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
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
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
    assert(core.name === '@proof-or-stop/core', `core package name mismatch: ${core.name}`);
    assert(utils.name === '@proof-or-stop/utils', `utils package name mismatch: ${utils.name}`);
    assert(lab.name === '@proof-or-stop/lab', `lab package name mismatch: ${lab.name}`);
    assert(core.version === EXPECTED_CORE_VERSION, `core version mismatch: ${core.version}`);
    assert(utils.version === EXPECTED_EXTENSION_VERSION, `utils version mismatch: ${utils.version}`);
    assert(lab.version === EXPECTED_EXTENSION_VERSION, `lab version mismatch: ${lab.version}`);
    assert(core.dependencies?.['@proof-or-stop/lab'] === EXPECTED_EXTENSION_VERSION, `core should depend on @proof-or-stop/lab@${EXPECTED_EXTENSION_VERSION}`);
    assert(utils.peerDependencies?.['@proof-or-stop/core'] === EXPECTED_CORE_PEER_RANGE, `utils should accept independently-versioned core releases through peer range ${EXPECTED_CORE_PEER_RANGE}`);
    assert(lab.peerDependencies?.['@proof-or-stop/core'] === EXPECTED_CORE_PEER_RANGE, `lab should accept independently-versioned core releases through peer range ${EXPECTED_CORE_PEER_RANGE}`);
    assert(!utils.dependencies?.['@proof-or-stop/core'], 'utils should not pin core as an exact runtime dependency');
    assert(!lab.dependencies?.['@proof-or-stop/core'], 'lab should not pin core as an exact runtime dependency');
    assert(!core.dependencies?.['@proof-or-stop-agent/lab'], 'core should not depend on retired @proof-or-stop-agent/lab');
    assert(!utils.dependencies?.['@proof-or-stop-agent/core'], 'utils should not depend on retired @proof-or-stop-agent/core');
    assert(!lab.dependencies?.['@proof-or-stop-agent/core'], 'lab should not depend on retired @proof-or-stop-agent/core');
    assert(!core.dependencies?.['@koala-agent/lab'], 'core should not depend on legacy @koala-agent/lab');
    assert(!utils.dependencies?.['@koala-agent/core'], 'utils should not depend on legacy @koala-agent/core');
    assert(!lab.dependencies?.['@koala-agent/core'], 'lab should not depend on legacy @koala-agent/core');
  },
  'lab-help': () => {
    const out = run(['lab', 'help']);
    assert(out.includes('Proof-or-Stop Lab commands:'), 'global core bin should run the real nested lab help command');
    for (const command of ['create', 'run', 'eval', 'compare', 'promote', 'help']) {
      assert(out.includes(`proof-or-stop lab ${command}`), `nested Lab help should advertise lab ${command}`);
    }
    assert(out.includes('flat compatibility: lab_create'), 'nested Lab help should preserve the flat compatibility surface');
    assert(!out.includes('koala'), 'nested Lab help should not advertise a retired product command');

    const flatOut = run(['lab_help']);
    assert(flatOut === out, 'flat lab_help compatibility command should match nested lab help');
  },
  'lab-create': () => {
    const temp = createTempProject();
    try {
      const config = 'experiments/configs/lab-reviewer-reviewer-quality-v1.json';
      const created = run(['--root', temp, 'lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1']);
      assert(created.includes(`Config: ${config}`), 'nested lab create should report its canonical config path');
      assert(existsSync(join(temp, config)), 'nested lab create should write the canonical experiment config');
      const dryRun = run(['--root', temp, 'lab', 'run', `--config=${config}`, '--dryRun']);
      assert(dryRun.includes('Dry run complete'), 'nested lab run --dryRun should complete through the global bootstrap');
      const evaluated = run(['--root', temp, 'lab', 'eval', JSON.stringify({
        config,
        files: ['.proof-or-stop-codex/agents/test-case-reviewer.md'],
      })]);
      assert(evaluated.includes('"ok": true'), 'nested lab eval should execute the Lab patch-policy handler');

      const flatDryRun = run(['--root', temp, 'lab_run', `--config=${config}`, '--dryRun']);
      assert(flatDryRun.includes('Dry run complete'), 'flat lab_run compatibility command should remain available');

      for (const badArgs of [['lab', 'unknown'], ['lab', 'createx']]) {
        const failed = runAllowFailure(['--root', temp, ...badArgs]);
        assert(!failed.ok, `${badArgs.join(' ')} should fail rather than prefix-match a nested command`);
        assert(failed.text.includes('Unknown command') || failed.text.includes('未知命令'), `${badArgs.join(' ')} should fail as an unknown command`);
      }
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
      assert(out.includes('# proof-or-stop session brief'), 'core command should still work when lab dist is absent');
      const failed = runAllowFailure(['--root', temp, 'lab', 'help']);
      assert(!failed.ok, 'nested lab command should fail when lab extension is unavailable');
      assert(
        failed.text.includes('Unknown command: lab_help') || failed.text.includes('未知命令: lab_help') || failed.text.includes('Recovery'),
        'nested Lab failure should show unavailable canonical command or recovery hint',
      );
      const flatFailed = runAllowFailure(['--root', temp, 'lab_create', '--help']);
      assert(!flatFailed.ok, 'flat Lab compatibility command should also fail when the extension is unavailable');
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
