#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { MAIN_TOOLS } from '../packages/main/dist/cli-engine.js';
import {
  validateExternalCommandDeclarations,
  validateExternalCommandHandlers,
} from '../packages/main/dist/cli/extension-admission.js';
import { createLabToolDefs } from '../packages/lab/dist/index.js';
import { z } from 'zod';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const cli = join(root, 'bin', 'proof-or-stop.js');
const EXPECTED_CORE_VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const EXPECTED_EXTENSION_VERSION = '0.3.65';
const EXPECTED_CORE_PEER_RANGE = '^0.3.65';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    assert(pattern.test(String(error?.message || error)), `${message}: unexpected error ${error?.message || error}`);
    return;
  }
  throw new Error(`${message}: expected an exception`);
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

function createTempProject({ hooks = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-global-lab-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  const config = {
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  };
  if (hooks) {
    config.hooks = {
      preCommand: { '*': ['node -e "require(\'fs\').appendFileSync(\'lab-hooks.log\',\'pre\\n\')"'] },
      postCommand: { '*': ['node -e "require(\'fs\').appendFileSync(\'lab-hooks.log\',\'post\\n\')"'] },
    };
  }
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify(config, null, 2));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Lab Entrypoint Smoke'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'lab-entrypoint@example.test'], { cwd: dir });
  execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'fixture root'], { cwd: dir });
  return dir;
}

function createActiveStoryProject(phase, options = {}) {
  const dir = createTempProject(options);
  const created = run(['--root', dir, 'story_create', JSON.stringify({
    name: `lab-entrypoint-${phase.toLowerCase()}-${process.pid}-${Date.now()}`,
    title: `Lab entrypoint ${phase} fixture`,
    description: `Active Story fixture used to verify Lab command lifecycle admission in ${phase}.`,
    type: 'chore',
    priority: 'normal',
    phase,
    background: [
      '## Trigger Event',
      'B-022e Round 16 requires an executable active-Story fixture that exercises extension lifecycle admission rather than a no-story shortcut.',
      '## Key Insights',
      'Nested and flat spellings normalize to one handler, while lifecycle and audit classification must remain bound to the validated external declaration.',
      '## Solution Tradeoffs',
      'The fixture uses a disposable repository and canonical story_create input, accepting modest setup cost to avoid editing persistent story data directly.',
      '## Conversational Texture',
      'Reviewers requested adversarial coverage for missing metadata, core-name collision, read-only hooks, process events, and DEV versus REVIEW or TEST phases.',
    ].join('\n\n'),
  })], { cwd: dir });
  const storyId = created.match(/Story (B-[a-z0-9]+)/i)?.[1];
  assert(storyId, `story_create should report an ID for ${phase}: ${created}`);
  execFileSync('git', ['checkout', '-qb', `story/${storyId}`], { cwd: dir });
  return { dir, storyId };
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
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

    for (const command of ['create', 'run', 'eval', 'compare', 'promote', 'help']) {
      const nestedHelp = run(['lab', command, '--help']);
      assert(nestedHelp.includes(`proof-or-stop lab ${command} —`), `nested lab ${command} heading should retain canonical nested syntax`);
      assert(nestedHelp.includes(`Usage: proof-or-stop lab ${command}`), `nested lab ${command} Usage should retain canonical nested syntax`);
      assert(!nestedHelp.includes(`proof-or-stop lab_${command} —`), `nested lab ${command} heading must not fall back to flat compatibility syntax`);

      const flatHelp = run([`lab_${command}`, '--help']);
      assert(flatHelp.includes(`proof-or-stop lab_${command} —`), `flat lab_${command} compatibility help should retain flat syntax`);
      assert(flatHelp.includes(`Usage: proof-or-stop lab_${command}`), `flat lab_${command} compatibility Usage should retain flat syntax`);
    }
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
  'extension-admission': () => {
    const labTools = createLabToolDefs(z);
    const ownership = {
      lab_help: 'readOnly', lab_create: 'mainSharedMutating', lab_run: 'mainSharedMutating',
      lab_eval: 'readOnly', lab_compare: 'readOnly', lab_promote: 'readOnly',
    };
    const phases = {
      lab_help: 'all', lab_create: ['DEV'], lab_run: ['DEV'],
      lab_eval: ['DEV'], lab_compare: 'all', lab_promote: 'all',
    };
    const admitted = validateExternalCommandDeclarations({
      mainTools: MAIN_TOOLS,
      extraTools: labTools,
      extraOwnershipClasses: ownership,
      extraAllowedPhases: phases,
    });
    assert(admitted.commandNames.size === 6, 'all six Lab commands should be admitted as declared external commands');
    validateExternalCommandHandlers(admitted, labTools.map(tool => tool.name));

    const { lab_eval: _omittedEvalPhase, ...missingEvalPhase } = phases;
    assertThrows(() => validateExternalCommandDeclarations({
      mainTools: MAIN_TOOLS,
      extraTools: labTools,
      extraOwnershipClasses: ownership,
      extraAllowedPhases: missingEvalPhase,
    }), /ownership\/phase parity/, 'missing lifecycle row must fail closed');
    assertThrows(() => validateExternalCommandDeclarations({
      mainTools: MAIN_TOOLS,
      extraTools: labTools,
      extraOwnershipClasses: { ...ownership, lab_fake: 'readOnly' },
      extraAllowedPhases: { ...phases, lab_fake: 'all' },
    }), /extraTools\/ownership\/phase parity/, 'metadata for a non-tool command must fail closed');
    assertThrows(() => validateExternalCommandDeclarations({
      mainTools: MAIN_TOOLS,
      extraTools: [...labTools, { name: 'story_create', description: 'collision', schema: {} }],
      extraOwnershipClasses: { ...ownership, story_create: 'readOnly' },
      extraAllowedPhases: { ...phases, story_create: 'all' },
    }), /core command collision/, 'external metadata must never reclassify a core command');
    assertThrows(() => validateExternalCommandHandlers(admitted, labTools.slice(1).map(tool => tool.name)), /missing registered handlers: lab_help/, 'missing registered handler must fail closed');
  },
  'active-story-lifecycle': () => {
    const auditEnv = {
      ...process.env,
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      PROOF_OR_STOP_ACTIVITY_SESSION: 'global-lab-entrypoint-smoke',
    };
    delete auditEnv.PROOF_OR_STOP_ACTIVITY_RECORD_READONLY;
    delete auditEnv.PROOF_OR_STOP_REVIEWER_READONLY;

    const dev = createActiveStoryProject('DEV', { hooks: true });
    try {
      const hooksFile = join(dev.dir, 'lab-hooks.log');
      const eventsFile = join(dev.dir, 'docs', 'story', 'actives', dev.storyId, 'process-events.jsonl');
      const helpHooksBefore = readOptional(hooksFile);
      const helpEventsBefore = readOptional(eventsFile);
      run(['--root', dev.dir, 'lab', 'help'], { cwd: dev.dir, env: auditEnv });
      assert(readOptional(hooksFile) === helpHooksBefore, 'nested lab help must not run pre/post hooks in an active Story');
      assert(readOptional(eventsFile) === helpEventsBefore, 'nested lab help must leave process-events bytes unchanged');

      const config = 'experiments/configs/lab-reviewer-reviewer-quality-v1.json';
      run(['--root', dev.dir, 'lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1'], { cwd: dev.dir, env: auditEnv });
      const mutatingHooks = readOptional(hooksFile);
      const mutatingEvents = readOptional(eventsFile);
      assert(mutatingHooks && mutatingHooks !== helpHooksBefore && mutatingHooks.includes('pre\n') && mutatingHooks.includes('post\n'), 'nested lab create control must exercise both hook surfaces');
      assert(mutatingEvents && mutatingEvents !== helpEventsBefore && mutatingEvents.includes('"command":"lab_create"'), 'nested lab create control must append a Codex process event');

      for (const args of [
        ['lab', 'eval', JSON.stringify({ config, files: ['README.md'] })],
        ['lab_eval', JSON.stringify({ config, files: ['README.md'] })],
        ['lab', 'compare', `--config=${config}`],
        ['lab_compare', `--config=${config}`],
      ]) {
        run(['--root', dev.dir, ...args], { cwd: dev.dir, env: auditEnv });
        assert(readOptional(hooksFile) === mutatingHooks, `${args.join(' ')} must not run hooks`);
        assert(readOptional(eventsFile) === mutatingEvents, `${args.join(' ')} must leave process-events bytes unchanged`);
      }

      const harness = join(dev.dir, 'extension-admission-harness.mjs');
      const engineUrl = pathToFileURL(resolve(root, 'packages/main/dist/cli-engine.js')).href;
      writeFileSync(harness, [
        `import { runCli } from ${JSON.stringify(engineUrl)};`,
        `const mode = process.env.ADMISSION_MODE;`,
        `const external = { name: 'external_probe', description: 'probe', schema: {} };`,
        `const core = { name: 'story_create', description: 'collision', schema: {} };`,
        `const opts = mode === 'collision'`,
        `  ? { extraTools: [core], extraOwnershipClasses: { story_create: 'readOnly' }, extraAllowedPhases: { story_create: 'all' } }`,
        `  : mode === 'missing-phase'`,
        `    ? { extraTools: [external], extraOwnershipClasses: { external_probe: 'readOnly' }, extraAllowedPhases: {} }`,
        `    : { extraTools: [external], extraOwnershipClasses: { external_probe: 'readOnly' }, extraAllowedPhases: { external_probe: ['DEV'] }, extraRegister: () => {} };`,
        `runCli(opts).catch(error => { console.error(error.message); process.exit(1); });`,
      ].join('\n'));
      const runHarness = (mode) => {
        try {
          execFileSync('node', [harness, '--root', dev.dir, mode === 'collision' ? 'story_create' : 'external_probe'], {
            cwd: dev.dir,
            env: { ...auditEnv, ADMISSION_MODE: mode },
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { ok: true, text: '' };
        } catch (error) {
          return { ok: false, text: `${error.stdout || ''}${error.stderr || ''}` };
        }
      };
      const collision = runHarness('collision');
      assert(!collision.ok && collision.text.includes('core command collision: story_create'), 'active-Story core collision must fail before phase/hook/event classification');
      const missingPhase = runHarness('missing-phase');
      assert(!missingPhase.ok && missingPhase.text.includes('ownership/phase parity'), 'active-Story extension missing a lifecycle row must fail closed');
      const missingHandler = runHarness('missing-handler');
      assert(!missingHandler.ok && missingHandler.text.includes('missing registered handlers: external_probe'), 'active-Story extension missing its registered handler must fail closed');
    } finally {
      rmSync(dev.dir, { recursive: true, force: true });
    }

    for (const phase of ['REVIEW', 'TEST']) {
      const fixture = createActiveStoryProject(phase);
      try {
        const config = 'experiments/configs/lab-reviewer-reviewer-quality-v1.json';
        // Seed the read-only input on main before the story branch becomes active.
        execFileSync('git', ['checkout', '-q', 'main'], { cwd: fixture.dir });
        run(['--root', fixture.dir, 'lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1'], { cwd: fixture.dir });
        execFileSync('git', ['checkout', '-q', `story/${fixture.storyId}`], { cwd: fixture.dir });
        for (const args of [
          ['lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1'],
          ['lab_create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1'],
          ['lab', 'run', `--config=${config}`, '--dryRun'],
          ['lab_run', `--config=${config}`, '--dryRun'],
          ['lab', 'eval', JSON.stringify({ config, files: ['README.md'] })],
          ['lab_eval', JSON.stringify({ config, files: ['README.md'] })],
        ]) {
          const blocked = runAllowFailure(['--root', fixture.dir, ...args]);
          assert(!blocked.ok && blocked.text.includes(`not available in ${phase} phase`), `${args.join(' ')} must be blocked in ${phase}`);
        }
        const compared = run(['--root', fixture.dir, 'lab', 'compare', `--config=${config}`], { cwd: fixture.dir });
        assert(compared.includes('No runs recorded yet'), `read-only nested lab compare should remain available in ${phase}`);
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
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
