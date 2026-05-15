#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeValidationPlan } from '../core/validation-executor.js';
import { resetConfigCache } from '../core/config.js';
import {
  configuredValidationCommands,
  createVerifierHandlers,
  discoverFallbackValidationCommands,
} from '../handlers/verifier.js';
import { createDoctorHandlers } from '../handlers/doctor.js';
import { StoryStore } from '../core/store.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

const tmp = mkdtempSync(join(tmpdir(), 'koala-validation-protocol-'));

try {
  const subdir = join(tmp, 'sub');
  mkdirSync(subdir);

  const serial = await executeValidationPlan({
    provider: 'smoke-serial',
    commands: [
      {
        label: 'write marker',
        command: 'node',
        args: ['-e', "require('fs').writeFileSync('marker.txt', 'ok')"],
      },
      {
        label: 'read marker',
        command: 'node',
        args: ['-e', "process.stdout.write(require('fs').readFileSync('marker.txt', 'utf8'))"],
      },
    ],
  }, tmp, 'HEAD-A');
  assert.equal(serial.status, 'pass');
  assert.equal(serial.allPass, true);
  assert.equal(serial.headSha, 'HEAD-A');
  assert.equal(serial.commands.length, 2);
  assert.match(serial.commands[1].output, /ok/);

  const requiredFailure = await executeValidationPlan({
    provider: 'smoke-required-fail',
    commands: [
      { label: 'required failure', command: 'node', args: ['-e', 'process.exit(7)'] },
    ],
  }, tmp);
  assert.equal(requiredFailure.status, 'fail');
  assert.equal(requiredFailure.allPass, false);
  assert.equal(requiredFailure.commands[0].code, 7);

  const optionalFailure = await executeValidationPlan({
    provider: 'smoke-optional-fail',
    commands: [
      { label: 'optional failure', command: 'node', args: ['-e', 'process.exit(3)'], optional: true },
    ],
  }, tmp);
  assert.equal(optionalFailure.status, 'warn');
  assert.equal(optionalFailure.allPass, true);
  assert.match(optionalFailure.warnings.join('\n'), /optional validation failed/);

  const shellCommand = await executeValidationPlan({
    provider: 'smoke-shell',
    commands: [
      { label: 'shell command', command: 'cd sub && node -e "process.stdout.write(process.cwd())"', args: [], shell: true },
    ],
  }, tmp);
  assert.equal(shellCommand.status, 'pass');
  assert.match(shellCommand.details[0], /cd sub && node -e/);
  assert.equal(shellCommand.commands[0].shell, true);
  assert.equal(shellCommand.commands[0].command, 'cd sub && node -e "process.stdout.write(process.cwd())"');
  assert.equal(shellCommand.commands[0].code, 0);
  assert.equal(typeof shellCommand.commands[0].durationMs, 'number');
  assert.ok(shellCommand.commands[0].durationMs >= 0);
  assert.match(shellCommand.commands[0].output, /sub$/);

  const timeout = await executeValidationPlan({
    provider: 'smoke-timeout',
    commands: [
      { label: 'timeout', command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 100 },
    ],
  }, tmp);
  assert.equal(timeout.status, 'fail');
  assert.equal(timeout.commands[0].timedOut, true);

  writeFileSync(join(tmp, 'koala.config.json'), JSON.stringify({
    validate: {
      commands: [
        {
          label: 'configured command',
          command: 'node',
          args: ['-e', 'process.stdout.write(process.env.KOALA_SMOKE || "")'],
          cwd: 'sub',
          env: { KOALA_SMOKE: 'yes' },
          timeoutMs: 1234,
          optional: true,
        },
      ],
    },
  }));
  resetConfigCache();
  const discovered = configuredValidationCommands(tmp);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].label, 'configured command');
  assert.equal(discovered[0].cwd, 'sub');
  assert.equal(discovered[0].env?.KOALA_SMOKE, 'yes');
  assert.equal(discovered[0].timeoutMs, 1234);
  assert.equal(discovered[0].optional, true);

  writeFileSync(join(tmp, 'koala.config.json'), JSON.stringify({
    validate: {
      command: 'cd sub && node -e "process.stdout.write(process.cwd())"',
    },
  }));
  resetConfigCache();
  const shellDiscovered = configuredValidationCommands(tmp);
  assert.equal(shellDiscovered.length, 1);
  assert.equal(shellDiscovered[0].shell, true);
  assert.equal(shellDiscovered[0].command, 'cd sub && node -e "process.stdout.write(process.cwd())"');
  assert.deepEqual(shellDiscovered[0].args, []);

  const noEntryRoot = mkdtempSync(join(tmpdir(), 'koala-validation-no-entry-'));
  try {
    resetConfigCache();
    const logs: string[] = [];
    const noEntryJson = await createVerifierHandlers({
      root: noEntryRoot,
      scanRoot: noEntryRoot,
      store: new StoryStore(noEntryRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const noEntryResult = JSON.parse(noEntryJson);
    assert.equal(noEntryResult.provider, 'koala-verifier-no-validation-entry');
    assert.equal(noEntryResult.status, 'warn');
    assert.equal(noEntryResult.allPass, true);
    assert.equal(noEntryResult.commands.length, 0);
    const noEntryRendered = `${noEntryResult.summary}\n${noEntryResult.details.join('\n')}\n${noEntryResult.warnings.join('\n')}\n${logs.join('\n')}`;
    assert.match(noEntryRendered, /No project validator configured|skipped project-specific validation/);
    assert.match(noEntryRendered, /validate\.ts\/js\/mts/);
    assert.match(noEntryRendered, /fallback/);
    assert.match(noEntryRendered, /skip\/warn/);
    assert.match(noEntryRendered, /validate\.command/);
  } finally {
    rmSync(noEntryRoot, { recursive: true, force: true });
  }

  const configuredOnlyRoot = mkdtempSync(join(tmpdir(), 'koala-validation-configured-'));
  try {
    writeFileSync(join(configuredOnlyRoot, 'koala.config.json'), JSON.stringify({
      validate: {
        commands: [
          {
            label: 'configured validate smoke',
            command: 'node',
            args: ['-e', 'process.stdout.write("configured-ok")'],
          },
        ],
      },
    }));
    resetConfigCache();
    const logs: string[] = [];
    const validateJson = await createVerifierHandlers({
      root: configuredOnlyRoot,
      scanRoot: configuredOnlyRoot,
      store: new StoryStore(configuredOnlyRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const configuredResult = JSON.parse(validateJson);
    assert.equal(configuredResult.provider, 'koala-verifier-configured-commands');
    assert.equal(configuredResult.status, 'pass');
    assert.equal(configuredResult.allPass, true);
    assert.deepEqual(configuredResult.warnings, []);
    assert.match(configuredResult.commands[0].output, /configured-ok/);
    assert.equal(configuredResult.commands[0].command, 'node');
    assert.equal(configuredResult.commands[0].code, 0);
    assert.equal(typeof configuredResult.commands[0].durationMs, 'number');
    assert.ok(configuredResult.commands[0].durationMs >= 0);
    assert.doesNotMatch(`${configuredResult.summary}\n${configuredResult.details.join('\n')}\n${configuredResult.warnings.join('\n')}\n${logs.join('\n')}`, /discover|fallback|advisory|validate\.ts not found/i);
  } finally {
    rmSync(configuredOnlyRoot, { recursive: true, force: true });
  }

  const configuredFailRoot = mkdtempSync(join(tmpdir(), 'koala-validation-configured-fail-'));
  try {
    writeFileSync(join(configuredFailRoot, 'koala.config.json'), JSON.stringify({
      validate: {
        commands: [
          {
            label: 'configured failing gate',
            command: 'node',
            args: ['-e', 'process.exit(9)'],
          },
        ],
      },
    }));
    writeFileSync(join(configuredFailRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.stdout.write(\\"fallback-should-not-run\\")"' },
    }));
    resetConfigCache();
    const logs: string[] = [];
    const configuredFailJson = await createVerifierHandlers({
      root: configuredFailRoot,
      scanRoot: configuredFailRoot,
      store: new StoryStore(configuredFailRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const configuredFailResult = JSON.parse(configuredFailJson);
    assert.equal(configuredFailResult.provider, 'koala-verifier-configured-commands');
    assert.equal(configuredFailResult.status, 'fail');
    assert.equal(configuredFailResult.allPass, false);
    assert.equal(configuredFailResult.commands.length, 1);
    assert.equal(configuredFailResult.commands[0].label, 'configured failing gate');
    assert.equal(configuredFailResult.commands[0].command, 'node');
    assert.equal(configuredFailResult.commands[0].code, 9);
    const configuredFailRendered = `${configuredFailResult.summary}\n${configuredFailResult.details.join('\n')}\n${configuredFailResult.warnings.join('\n')}\n${logs.join('\n')}\n${configuredFailResult.commands[0].output || ''}`;
    assert.doesNotMatch(configuredFailRendered, /fallback-should-not-run/);
    assert.doesNotMatch(configuredFailRendered, /advisory fallback command discovery|running .* advisory fallback/i);
    assert.match(configuredFailRendered, /configured validate\.command/);
  } finally {
    rmSync(configuredFailRoot, { recursive: true, force: true });
  }

  const fallbackRoot = mkdtempSync(join(tmpdir(), 'koala-validation-fallback-'));
  try {
    writeFileSync(join(fallbackRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.stdout.write(\\"fallback-ok\\")"' },
    }));
    resetConfigCache();
    const fallbackCommands = discoverFallbackValidationCommands(fallbackRoot);
    assert.equal(fallbackCommands.length, 1);
    assert.equal(fallbackCommands[0].label, 'package.json test script');
    const fallbackJson = await createVerifierHandlers({
      root: fallbackRoot,
      scanRoot: fallbackRoot,
      store: new StoryStore(fallbackRoot),
      log: () => {},
    }).validate({ json: true });
    const fallbackResult = JSON.parse(fallbackJson);
    assert.equal(fallbackResult.provider, 'koala-verifier-fallback-commands');
    assert.equal(fallbackResult.status, 'pass');
    assert.equal(fallbackResult.allPass, true);
    assert.deepEqual(fallbackResult.warnings, []);
    assert.match(`${fallbackResult.summary}\n${fallbackResult.details.join('\n')}`, /advisory fallback command discovery/);
    assert.match(`${fallbackResult.summary}\n${fallbackResult.details.join('\n')}`, /no configured validate\.command/);
    assert.match(fallbackResult.commands[0].output, /fallback-ok/);
  } finally {
    rmSync(fallbackRoot, { recursive: true, force: true });
  }

  const dirtyFallbackRoot = mkdtempSync(join(tmpdir(), 'koala-validation-dirty-fallback-'));
  try {
    writeFileSync(join(dirtyFallbackRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "require(\\"fs\\").writeFileSync(\\"report.md\\", \\"changed\\\\n\\")"' },
    }));
    writeFileSync(join(dirtyFallbackRoot, 'report.md'), 'baseline\n');
    execFileSync('git', ['init'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Koala Smoke'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed dirty fallback smoke'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();
    const dirtyJson = await createVerifierHandlers({
      root: dirtyFallbackRoot,
      scanRoot: dirtyFallbackRoot,
      store: new StoryStore(dirtyFallbackRoot),
      log: () => {},
    }).validate({ json: true });
    const dirtyResult = JSON.parse(dirtyJson);
    assert.equal(dirtyResult.status, 'fail');
    assert.equal(dirtyResult.allPass, false);
    assert.match(dirtyResult.summary, /dirtied the worktree/);
    assert.match(dirtyResult.details.join('\n'), /validation command dirtied worktree/);
    assert.match(dirtyResult.details.join('\n'), /package\.json test script/);
    assert.match(dirtyResult.details.join('\n'), /report\.md/);
    assert.match(dirtyResult.details.join('\n'), /side-effect-free/);
    assert.equal(dirtyResult.commands[0].worktreePollution.paths[0], 'report.md');
  } finally {
    rmSync(dirtyFallbackRoot, { recursive: true, force: true });
  }

  const invalidArgCwd = mkdtempSync(join(tmpdir(), 'koala-validation-schema-'));
  const env = { ...process.env };
  delete env.KOALA_PROJECT_ROOT;
  const invalidVerificationIntent = spawnSync(process.execPath, [
    cliPath,
    'checklist_update',
    JSON.stringify({
      storyId: 'B-smoke',
      itemId: 'CHK-001',
      verificationIntent: {
        happy: [{ desc: 'bad enum', type: 'integration_test', priority: 'must' }],
      },
    }),
  ], {
    cwd: invalidArgCwd,
    env,
    encoding: 'utf-8',
  });
  assert.notEqual(invalidVerificationIntent.status, 0, 'invalid nested verificationIntent enum should fail');
  assert.match(invalidVerificationIntent.stderr, /参数校验失败/);
  assert.match(invalidVerificationIntent.stderr, /verificationIntent\.happy\.0\.type/);
  assert.match(invalidVerificationIntent.stderr, /integration_test/);
  assert.match(invalidVerificationIntent.stderr, /logic[\s\S]*cli[\s\S]*browser[\s\S]*manual[\s\S]*docs/);
  assert.equal(existsSync(join(invalidArgCwd, '.koala')), false, 'schema failure should happen before metadata mutation');
  rmSync(invalidArgCwd, { recursive: true, force: true });

  const malformedJsonCwd = mkdtempSync(join(tmpdir(), 'koala-validation-malformed-json-'));
  const malformedJson = spawnSync(process.execPath, [
    cliPath,
    'story_create',
    '{"name":"broken",',
  ], {
    cwd: malformedJsonCwd,
    env,
    encoding: 'utf-8',
  });
  assert.notEqual(malformedJson.status, 0, 'malformed JSON body should fail');
  assert.match(malformedJson.stderr, /JSON 解析失败|JSON parse|Unexpected end of JSON input/);
  assert.match(malformedJson.stderr.trim().split('\n')[0], /JSON 解析失败|JSON parse/);
  assert.equal(existsSync(join(malformedJsonCwd, '.koala')), false, 'malformed JSON should not create project metadata');
  rmSync(malformedJsonCwd, { recursive: true, force: true });

  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.stdout.write(\\"fallback\\")"' },
  }));
  execFileSync('git', ['init'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['config', 'user.name', 'Koala Smoke'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  mkdirSync(join(tmp, '.koala', 'story', 'actives', 'B-demo'), { recursive: true });
  mkdirSync(join(tmp, '.koala', 'runtime'), { recursive: true });
  writeFileSync(join(tmp, '.koala', 'activity.jsonl'), '{}\n');
  const shellMetaArtifactPath = ".koala/runtime/$USER $(echo hi) `uname` 'artifact'.json";
  writeFileSync(join(tmp, shellMetaArtifactPath), '{}\n');
  writeFileSync(join(tmp, '.koala', 'story', 'actives', 'B-demo', 'index.json'), '{}\n');
  execFileSync('git', ['add', '.'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['commit', '-m', 'seed doctor runtime artifact smoke'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  resetConfigCache();
  const doctor = createDoctorHandlers({
    root: tmp,
    scanRoot: tmp,
    store: new StoryStore(tmp),
    log: () => {},
    getAllToolNames: () => new Set<string>(),
  }).doctor;
  const doctorJson = doctor({ format: 'json' }) as any;
  assert.ok(doctorJson.runtime, 'doctor JSON should expose runtime section');
  assert.equal(doctorJson.runtime.cliEntrypoint.id, 'cli-entrypoint');
  assert.equal(doctorJson.runtime.globalCoreRealpath.id, 'global-core-realpath');
  assert.equal(doctorJson.runtime.projectLocalBin.id, 'project-local-bin');
  assert.equal(doctorJson.runtime.nodeVersion.id, 'node-version');
  assert.equal(doctorJson.runtime.packageVersion.id, 'package-version');
  assert.equal(doctorJson.runtime.validateSource.id, 'validate-source');
  assert.equal(doctorJson.runtime.externalReferencePolicy.id, 'external-reference-policy');
  assert.equal(doctorJson.runtime.externalReferencePolicy.connectivityChecked, false);
  assert.equal(doctorJson.runtime.externalReferencePolicy.actual.policy, 'reference-only');
  assert.equal(doctorJson.validation.validateFile, null);
  assert.equal(doctorJson.validation.configuredCommands.length, 1);
  assert.equal(doctorJson.validation.configuredCommands[0].shell, true);
  assert.equal(doctorJson.validation.configuredShellReceiptsIntentional, true);
  assert.deepEqual(doctorJson.validation.discoveredFallbackLabels, ['package.json test script']);
  assert.equal(doctorJson.validation.noValidatorWarning, false);
  assert.equal(doctorJson.runtimeArtifacts.tracked.length, 2, 'doctor should report tracked runtime artifacts');
  const activityArtifact = doctorJson.runtimeArtifacts.tracked.find((artifact: any) => artifact.path === '.koala/activity.jsonl');
  assert.ok(activityArtifact, 'doctor should include .koala/activity.jsonl');
  assert.equal(activityArtifact.repairable, true);
  assert.equal(activityArtifact.repairCommand, "git rm --cached -- '.koala/activity.jsonl'");
  const shellMetaArtifact = doctorJson.runtimeArtifacts.tracked.find((artifact: any) => artifact.path === shellMetaArtifactPath);
  assert.ok(shellMetaArtifact, 'doctor should include tracked runtime artifacts with shell metacharacters');
  assert.equal(shellMetaArtifact.repairable, true);
  assert.equal(
    shellMetaArtifact.repairCommand,
    "git rm --cached -- '.koala/runtime/$USER $(echo hi) `uname` '\"'\"'artifact'\"'\"'.json'",
  );

  const doctorText = doctor() as string;
  assert.match(doctorText, /Runtime artifacts:/);
  assert.match(doctorText, /\.koala\/activity\.jsonl/);
  assert.match(doctorText, /git rm --cached -- '\.koala\/activity\.jsonl'/);
  assert.match(doctorText, /git rm --cached -- '\.koala\/runtime\/\$USER \$\(echo hi\) `uname` '"'"'artifact'"'"'\.json'/);
  assert.doesNotMatch(doctorText, /git rm --cached -- ".*activity\.jsonl"/);
  assert.match(doctorText, /Runtime scan:/);
  assert.match(doctorText, /cli-entrypoint/);
  assert.match(doctorText, /external-reference-policy/);
  assert.match(doctorText, /Validation scan:/);
  assert.match(doctorText, /configured validate\.command/);
  assert.match(doctorText, /shell=true/);
  assert.match(doctorText, /discovered fallback labels: package\.json test script/);
  assert.match(doctorText, /fallback command discovery is advisory/);
  assert.doesNotMatch(doctorText, /PVSC|B-2065|\b\d+\s+passed\b/);

  const repairedDoctorJson = doctor({ format: 'json', repair: true }) as any;
  assert.equal(repairedDoctorJson.runtimeArtifacts.tracked.length, 0, 'doctor --repair should untrack repairable runtime artifacts');
  assert.deepEqual(
    [...repairedDoctorJson.runtimeArtifacts.repaired].sort(),
    ['.koala/activity.jsonl', shellMetaArtifactPath].sort(),
  );
  assert.notEqual(execFileSync('git', ['ls-files', '--', '.koala/story/actives/B-demo/index.json'], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should not untrack story evidence');
  assert.equal(execFileSync('git', ['ls-files', '--', '.koala/activity.jsonl'], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should untrack runtime artifacts');
  assert.equal(execFileSync('git', ['ls-files', '--', shellMetaArtifactPath], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should untrack metacharacter runtime artifacts');

  console.log('✓ validation protocol smoke passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
