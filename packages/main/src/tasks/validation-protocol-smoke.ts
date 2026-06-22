#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createCheckHandlers } from '../handlers/check.js';
import { createDoctorHandlers } from '../handlers/doctor.js';
import { managedAssetNextAction, renderManagedAssetCheck, runManagedAssetCheck } from '../core/managed-assets.js';
import { renderRuntimeFootprintSummary, runRuntimeEnvironmentChecks } from '../core/runtime-environment-checks.js';
import { StoryStore } from '../core/store.js';
import { getGuardFailureReason } from '../core/machine.js';
import { assertStoryTransitionReachedTarget, canSendStoryEvent } from '../handlers/transition-orchestrator.js';
import { renderLatticeBootstrapScript, renderLatticeCodexWrapperScript } from '../init-assets.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

const tmp = mkdtempSync(join(tmpdir(), 'lattice-validation-protocol-'));

function assertRuntimeModeShape(value: any): void {
  assert.ok(value, 'runtimeMode should be present');
  assert.ok(['global-cli', 'project-local-package', 'packaged-runtime', 'compatibility-launcher', 'diagnostic-only'].includes(value.mode), `runtimeMode.mode enum: ${value.mode}`);
  assert.ok(['repo-local-dist', 'project-node-modules', 'packaged-runtime', 'external-development-engine', 'global-cli', 'unknown'].includes(value.source), `runtimeMode.source enum: ${value.source}`);
  assert.equal(typeof value.requiresProjectJavaScriptRuntime, 'boolean');
  assert.equal(value.authority, 'local-runtime-diagnostic-only');
  assert.equal(typeof value.message, 'string');
  assert.ok(value.message.length > 0);
  assert.deepEqual(Object.keys(value).sort(), ['authority', 'message', 'mode', 'requiresProjectJavaScriptRuntime', 'source'].sort());
}

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
  const requiredFailureDetails = requiredFailure.details.join('\n');
  assert.doesNotMatch(requiredFailureDetails, /timeout diagnostic/i);
  assert.doesNotMatch(requiredFailureDetails, /timeoutMs|raise lattice\.config\.json validate\.commands\[\]\.timeoutMs/i);

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
  assert.match(timeout.details.join('\n'), /configured timeoutMs=100ms/);
  assert.match(timeout.details.join('\n'), /lattice\.config\.json validate\.commands\[\]\.timeoutMs/);

  writeFileSync(join(tmp, 'lattice.config.json'), JSON.stringify({
    validate: {
      commands: [
        {
          label: 'configured command',
          command: 'node',
          args: ['-e', 'process.stdout.write(process.env.LATTICE_SMOKE || "")'],
          cwd: 'sub',
          env: { LATTICE_SMOKE: 'yes' },
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
  assert.equal(discovered[0].env?.LATTICE_SMOKE, 'yes');
  assert.equal(discovered[0].timeoutMs, 1234);
  assert.equal(discovered[0].optional, true);

  writeFileSync(join(tmp, 'lattice.config.json'), JSON.stringify({
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

  const noEntryRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-no-entry-'));
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
    assert.equal(noEntryResult.provider, 'lattice-verifier-no-validation-entry');
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

  const configuredOnlyRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-configured-'));
  try {
    writeFileSync(join(configuredOnlyRoot, 'lattice.config.json'), JSON.stringify({
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
    assert.equal(configuredResult.provider, 'lattice-verifier-configured-commands');
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

  const configuredFailRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-configured-fail-'));
  try {
    writeFileSync(join(configuredFailRoot, 'lattice.config.json'), JSON.stringify({
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
    assert.equal(configuredFailResult.provider, 'lattice-verifier-configured-commands');
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

  const fallbackRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-fallback-'));
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
    assert.equal(fallbackResult.provider, 'lattice-verifier-fallback-commands');
    assert.equal(fallbackResult.status, 'pass');
    assert.equal(fallbackResult.allPass, true);
    assert.deepEqual(fallbackResult.warnings, []);
    assert.match(`${fallbackResult.summary}\n${fallbackResult.details.join('\n')}`, /advisory fallback command discovery/);
    assert.match(`${fallbackResult.summary}\n${fallbackResult.details.join('\n')}`, /no configured validate\.command/);
    assert.match(fallbackResult.commands[0].output, /fallback-ok/);
  } finally {
    rmSync(fallbackRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-001: Package.swift alone must NOT auto-fall back to swift test.
  // The Mac Native App / Swift product runtime has been demoted; explicit
  // validate.commands is the only opt-in path.
  const swiftOnlyRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-swift-only-'));
  try {
    writeFileSync(join(swiftOnlyRoot, 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\n');
    resetConfigCache();
    const swiftFallback = discoverFallbackValidationCommands(swiftOnlyRoot);
    assert.equal(swiftFallback.length, 0, 'Package.swift alone must NOT produce automatic swift test fallback');
    const logs: string[] = [];
    const swiftJson = await createVerifierHandlers({
      root: swiftOnlyRoot,
      scanRoot: swiftOnlyRoot,
      store: new StoryStore(swiftOnlyRoot),
      log: (line) => logs.push(line),
    }).validate({ json: true });
    const swiftResult = JSON.parse(swiftJson);
    assert.equal(swiftResult.provider, 'lattice-verifier-no-validation-entry', 'Package.swift alone must surface no-validation-entry warn/skip');
    assert.equal(swiftResult.status, 'warn');
    assert.equal(swiftResult.allPass, true, 'no-validation-entry skip is advisory, not a hard fail');
    assert.equal(swiftResult.commands.length, 0);
    const swiftRendered = `${swiftResult.summary}\n${swiftResult.details.join('\n')}\n${swiftResult.warnings.join('\n')}\n${logs.join('\n')}`;
    assert.doesNotMatch(swiftRendered, /swift test as a standard automatic fallback/i);
    // Swift may be mentioned ONLY in the negative form (demoted notice). It
    // must not advertise swift test as a fallback that is being executed.
    assert.match(swiftRendered, /Mac Native App|不在自动 fallback|demoted/i);
  } finally {
    rmSync(swiftOnlyRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-001: explicit validate.commands for swift test must STILL run.
  const swiftExplicitRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-swift-explicit-'));
  try {
    writeFileSync(join(swiftExplicitRoot, 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\n');
    writeFileSync(join(swiftExplicitRoot, 'lattice.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'explicit swift test', command: 'node', args: ['-e', 'process.stdout.write("swift-opt-in-ok")'] },
        ],
      },
    }));
    resetConfigCache();
    const swiftExplicit = configuredValidationCommands(swiftExplicitRoot);
    assert.equal(swiftExplicit.length, 1, 'explicit validate.commands entry should be honoured');
    assert.equal(swiftExplicit[0].label, 'explicit swift test');
    const swiftExplicitJson = await createVerifierHandlers({
      root: swiftExplicitRoot,
      scanRoot: swiftExplicitRoot,
      store: new StoryStore(swiftExplicitRoot),
      log: () => {},
    }).validate({ json: true });
    const swiftExplicitResult = JSON.parse(swiftExplicitJson);
    assert.equal(swiftExplicitResult.provider, 'lattice-verifier-configured-commands');
    assert.equal(swiftExplicitResult.status, 'pass');
    assert.match(swiftExplicitResult.commands[0].output, /swift-opt-in-ok/);
  } finally {
    rmSync(swiftExplicitRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-002: lattice.config.json is canonical; validate.commands there
  // must be loaded and used by lattice validate.
  const latticeCanonicalRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-canonical-'));
  try {
    writeFileSync(join(latticeCanonicalRoot, 'lattice.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'canonical lattice gate', command: 'node', args: ['-e', 'process.stdout.write("lattice-canonical-ok")'] },
        ],
      },
    }));
    resetConfigCache();
    const canonicalDiscovered = configuredValidationCommands(latticeCanonicalRoot);
    assert.equal(canonicalDiscovered.length, 1, 'lattice.config.json validate.commands must load');
    assert.equal(canonicalDiscovered[0].label, 'canonical lattice gate');
    const canonicalJson = await createVerifierHandlers({
      root: latticeCanonicalRoot,
      scanRoot: latticeCanonicalRoot,
      store: new StoryStore(latticeCanonicalRoot),
      log: () => {},
    }).validate({ json: true });
    const canonicalResult = JSON.parse(canonicalJson);
    assert.equal(canonicalResult.provider, 'lattice-verifier-configured-commands');
    assert.equal(canonicalResult.status, 'pass');
    assert.match(canonicalResult.commands[0].output, /lattice-canonical-ok/);
  } finally {
    rmSync(latticeCanonicalRoot, { recursive: true, force: true });
  }

  // Lattice-only config: koala.config.json is no longer an active fallback
  // when lattice.config.json is absent.
  const legacyOnlyRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-legacy-only-'));
  try {
    writeFileSync(join(legacyOnlyRoot, 'koala.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'legacy koala gate', command: 'node', args: ['-e', 'process.stdout.write("legacy-ok")'] },
        ],
      },
    }));
    resetConfigCache();
    const legacyDiscovered = configuredValidationCommands(legacyOnlyRoot);
    assert.equal(legacyDiscovered.length, 0, 'koala.config.json validate.commands must not load as an active config fallback');
  } finally {
    rmSync(legacyOnlyRoot, { recursive: true, force: true });
  }

  // B-38d6 CHK-002: lattice.config.json and koala.config.json both present →
  // lattice.config.json wins (canonical) and diagnostic identifies the winner.
  const conflictConfigRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-config-conflict-'));
  try {
    writeFileSync(join(conflictConfigRoot, 'lattice.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'lattice wins gate', command: 'node', args: ['-e', 'process.stdout.write("lattice-wins")'] },
        ],
      },
    }));
    writeFileSync(join(conflictConfigRoot, 'koala.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'koala loses gate', command: 'node', args: ['-e', 'process.stdout.write("koala-loses")'] },
        ],
      },
    }));
    resetConfigCache();
    const conflictDiscovered = configuredValidationCommands(conflictConfigRoot);
    assert.equal(conflictDiscovered.length, 1, 'only the canonical lattice.config.json entry must be loaded');
    assert.equal(conflictDiscovered[0].label, 'lattice wins gate', 'lattice.config.json must win over koala.config.json');
    const conflictJson = await createVerifierHandlers({
      root: conflictConfigRoot,
      scanRoot: conflictConfigRoot,
      store: new StoryStore(conflictConfigRoot),
      log: () => {},
    }).validate({ json: true });
    const conflictResult = JSON.parse(conflictJson);
    assert.match(conflictResult.commands[0].output, /lattice-wins/);
    assert.doesNotMatch(conflictResult.commands[0].output, /koala-loses/, 'koala.config.json gate must NOT be executed when lattice.config.json is present');
  } finally {
    rmSync(conflictConfigRoot, { recursive: true, force: true });
  }

  const dirtyFallbackRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-dirty-fallback-'));
  try {
    writeFileSync(join(dirtyFallbackRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "require(\\"fs\\").writeFileSync(\\"report.md\\", \\"changed\\\\n\\")"' },
    }));
    writeFileSync(join(dirtyFallbackRoot, 'report.md'), 'baseline\n');
    execFileSync('git', ['init'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Lattice Smoke'], { cwd: dirtyFallbackRoot, stdio: ['ignore', 'ignore', 'ignore'] });
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
    assert.match(dirtyResult.details.join('\n'), /unexpected_dirty_files=1/);
    assert.match(dirtyResult.details.join('\n'), /unexpected_dirty_files \(1\):/);
    assert.match(dirtyResult.details.join('\n'), /report\.md/);
    assert.match(dirtyResult.details.join('\n'), /side-effect-free/);
    assert.equal(dirtyResult.commands[0].worktreePollution.paths[0], 'report.md');
  } finally {
    rmSync(dirtyFallbackRoot, { recursive: true, force: true });
  }

  const categorizedPollutionRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-dirty-classified-'));
  try {
    writeFileSync(join(categorizedPollutionRoot, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    execFileSync('git', ['init'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Lattice Smoke'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed classified pollution smoke'], { cwd: categorizedPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const categorizedPollution = await executeValidationPlan({
      provider: 'smoke-dirty-classified',
      commands: [{
        label: 'classified pollution writer',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          "for (const dir of ['.lattice/story/actives/B-smoke', '.lattice', 'packages/main/src/core', 'packages/main/tests/fixtures', 'packages/main/tests/output/bl21_lacz_ecoli_minicell']) fs.mkdirSync(dir, { recursive: true });",
          "fs.writeFileSync('.lattice/story/actives/B-smoke/checklist.json', '{}\\n');",
          "fs.writeFileSync('.lattice/activity.jsonl', '{}\\n');",
          "fs.writeFileSync('packages/main/src/core/dirty-product.ts', 'export const dirty = true;\\n');",
          "fs.writeFileSync('packages/main/tests/fixtures/dirty-owner.json', '{}\\n');",
          "fs.writeFileSync('packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json', '{}\\n');",
        ].join(' ')],
      }],
    }, categorizedPollutionRoot);

    const details = categorizedPollution.details.join('\n');
    assert.equal(categorizedPollution.status, 'fail');
    assert.equal(categorizedPollution.allPass, false);
    assert.match(details, /lattice_metadata_changes=1/);
    assert.match(details, /runtime_artifact_changes=1/);
    assert.match(details, /material_source_changes=1/);
    assert.match(details, /fixture_changes=1/);
    assert.match(details, /unexpected_dirty_files=1/);
    assert.match(details, /packages\/main\/tests\/output\/bl21_lacz_ecoli_minicell\/prodenovo_viewer\.json/);
    // B-4b22: blocking pollution still surfaces "validation command dirtied
    // worktree" header; passing-only pollution (next block) gets the "policy-
    // allowed dirty paths" wording instead.
    assert.match(details, /validation command dirtied worktree/);
    assert.match(details, /fail: blocking=/);
  } finally {
    rmSync(categorizedPollutionRoot, { recursive: true, force: true });
  }

  // B-4b22: pollution that classifies entirely as passing categories
  // (lattice_metadata_changes + runtime_artifact_changes) must NOT trip
  // executeValidationPlan; status stays 'pass', allPass=true, details swap
  // to the policy-allowed wording and audit info appears.
  const passingPollutionRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-passing-pollution-'));
  try {
    writeFileSync(join(passingPollutionRoot, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    execFileSync('git', ['init'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Lattice Smoke'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    mkdirSync(join(passingPollutionRoot, '.lattice', 'story', 'actives', 'B-pass'), { recursive: true });
    writeFileSync(join(passingPollutionRoot, '.lattice', 'story', 'actives', 'B-pass', 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed passing pollution smoke'], { cwd: passingPollutionRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const passingPollution = await executeValidationPlan({
      provider: 'smoke-passing-pollution',
      commands: [{
        label: 'passing pollution writer',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          "fs.mkdirSync('.lattice/story/actives/B-pass', { recursive: true });",
          "fs.mkdirSync('.lattice', { recursive: true });",
          "fs.writeFileSync('.lattice/story/actives/B-pass/checklist.json', '{}\\n');",
          "fs.writeFileSync('.lattice/activity.jsonl', '{}\\n');",
        ].join(' ')],
      }],
    }, passingPollutionRoot, undefined, 'B-pass');

    const details = passingPollution.details.join('\n');
    assert.equal(passingPollution.status, 'pass', 'passing-only pollution must NOT trip allPass=false');
    assert.equal(passingPollution.allPass, true);
    assert.doesNotMatch(details, /✗ validation command dirtied worktree/, 'passing-only pollution must NOT emit the blocking failure header');
    assert.match(details, /policy-allowed dirty paths/);
    assert.match(details, /pass: blocking=0/);
    assert.match(details, /lattice_metadata_changes=1/);
    assert.match(details, /runtime_artifact_changes=1/);
    // Audit JSONL must be persisted in the per-story process-events file.
    const auditPath = join(passingPollutionRoot, '.lattice', 'story', 'actives', 'B-pass', 'process-events.jsonl');
    assert.ok(existsSync(auditPath), 'audit log must be appended to per-story process-events.jsonl');
    const auditLines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(auditLines.length, 2, 'one audit line per passing category (lattice_metadata + runtime_artifact)');
    for (const line of auditLines) {
      const ev = JSON.parse(line);
      assert.equal(ev.type, 'dirty_gate_audit');
      assert.equal(ev.gate, 'validate-side-effect');
      assert.equal(ev.storyId, 'B-pass');
    }
  } finally {
    rmSync(passingPollutionRoot, { recursive: true, force: true });
  }

  // B-cf60: when the BL21 lacZ viewer path is declared for the active story,
  // dirtyWorktreeClassifierOptionsForStory must group it under
  // declared_artifact_changes — the field-derived regression target stays
  // mechanically pinned even though validation-protocol-smoke is end-to-end.
  const declaredPathRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-declared-bl21-'));
  try {
    const BL21 = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
    writeFileSync(join(declaredPathRoot, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const declaredStore = new StoryStore(declaredPathRoot);
    const storyId = 'B-cftest';
    const now = '2026-05-15T18:30:00.000Z';
    declaredStore.writeStory(storyId, {
      storyId,
      name: 'declared-bl21-smoke',
      title: 'Declared BL21 smoke',
      description: 'Verify per-story declared artifact reclassification of BL21 viewer path.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    });
    declaredStore.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Item with verificationIntent slot',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationIntent: {
          happy: [{ desc: 'cli regenerates viewer', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });

    const { classifyGitStatusRows: classifyRows } = await import('../core/dirty-worktree.js');
    const { dirtyWorktreeClassifierOptionsForStory: optsForStory } = await import('../core/dirty-worktree.js');
    const { loadConfig: loadCfg } = await import('../core/config.js');
    const { createArtifactDeclareHandlers: makeHandlers } = await import('../handlers/artifact-declare.js');
    const { evaluateDeclaredArtifactReferences: refEval } = await import('../core/declared-artifact-gate.js');

    const handlers = makeHandlers({
      store: declaredStore,
      root: declaredPathRoot,
      scanRoot: join(declaredPathRoot, 'packages/main'),
    });
    handlers.artifact_declare({
      storyId,
      path: BL21,
      reason: 'BL21 lacZ minicell viewer regenerated for verification (validation-protocol smoke)',
      relatedIntent: 'CHK-001:happy:0',
    });

    const dirtyRows = [`?? ${BL21}`];
    const cfg = loadCfg(declaredPathRoot);
    const declared = classifyRows(dirtyRows, optsForStory(cfg, storyId, declaredStore));
    assert.equal(
      declared.groups.declared_artifact_changes.length,
      1,
      'BL21 lacZ viewer path must reclassify as declared_artifact_changes after artifact_declare',
    );
    assert.equal(declared.groups.declared_artifact_changes[0].path, BL21);
    assert.equal(
      declared.groups.unexpected_dirty_files.length,
      0,
      'declared BL21 path must NOT remain in unexpected_dirty_files',
    );

    // DONE gate reference check: matching intentRef → no unreferenced
    const checklistData = declaredStore.readChecklist(storyId);
    const declaredEntries = declaredStore.readDeclaredArtifacts(storyId);
    const passing = refEval(declaredEntries, checklistData, null);
    assert.equal(passing.total, 1);
    assert.equal(passing.unreferenced.length, 0, 'BL21 viewer with CHK-001:happy:0 must satisfy DONE reference check');

    // Bogus intentRef → unreferenced surfaces (preMortem #2 anchor)
    handlers.artifact_declare({
      storyId,
      path: 'packages/main/tests/output/bl21_lacz_ecoli_minicell/other_viewer.json',
      reason: 'second viewer with bogus ref for adversarial smoke',
      relatedIntent: 'CHK-999:happy:0',
    });
    const failing = refEval(declaredStore.readDeclaredArtifacts(storyId), checklistData, null);
    assert.equal(failing.total, 2);
    assert.equal(failing.unreferenced.length, 1, 'bogus intentRef must NOT pass DONE reference check');
    assert.equal(failing.unreferenced[0].relatedIntent, 'CHK-999:happy:0');
  } finally {
    rmSync(declaredPathRoot, { recursive: true, force: true });
  }

  // B-4b22 F-004 regression: executeValidationPlan with storyId must route
  // through dirtyWorktreeClassifierOptionsForStory so declared artifacts are
  // classified as declared_artifact_changes (not unexpected_dirty_files).
  const declaredE2eRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-declared-e2e-'));
  try {
    const BL21_E2E = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
    writeFileSync(join(declaredE2eRoot, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    execFileSync('git', ['init'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Lattice Smoke'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed declared e2e smoke'], { cwd: declaredE2eRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const e2eStore = new StoryStore(declaredE2eRoot);
    const e2eStoryId = 'B-e2etest';
    const e2eNow = '2026-05-15T19:00:00.000Z';
    e2eStore.writeStory(e2eStoryId, {
      storyId: e2eStoryId,
      name: 'declared-e2e-smoke',
      title: 'Declared E2E smoke',
      description: 'F-004 regression: executeValidationPlan must use story-aware classifier.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: e2eNow,
      startedAt: e2eNow,
      endedAt: null,
      currentReviewRound: e2eNow,
      events: [],
    });
    e2eStore.writeChecklist(e2eStoryId, {
      items: [{
        id: 'CHK-001',
        title: 'Regenerate BL21 viewer',
        status: 'done',
        startTime: e2eNow,
        endTime: e2eNow,
        verificationIntent: {
          happy: [{ desc: 'viewer regenerated', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });

    const { createArtifactDeclareHandlers: makeE2eHandlers } = await import('../handlers/artifact-declare.js');
    makeE2eHandlers({
      store: e2eStore,
      root: declaredE2eRoot,
      scanRoot: join(declaredE2eRoot, 'packages/main'),
    }).artifact_declare({
      storyId: e2eStoryId,
      path: BL21_E2E,
      reason: 'BL21 lacZ minicell viewer regenerated (F-004 regression)',
      relatedIntent: 'CHK-001:happy:0',
    });

    const declaredE2eResult = await executeValidationPlan({
      provider: 'smoke-declared-e2e',
      commands: [{
        label: 'write declared BL21 artifact',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          `const dir = '${dirname(BL21_E2E).replace(/'/g, "\\'")}';`,
          "fs.mkdirSync(dir, { recursive: true });",
          `fs.writeFileSync('${BL21_E2E.replace(/'/g, "\\'")}', '{}\\n');`,
        ].join(' ')],
      }],
    }, declaredE2eRoot, undefined, e2eStoryId);

    const e2eDetails = declaredE2eResult.details.join('\n');
    assert.equal(declaredE2eResult.status, 'pass', 'F-004: declared artifact pollution must NOT fail executeValidationPlan when storyId is supplied');
    assert.equal(declaredE2eResult.allPass, true, 'F-004: allPass must be true for declared artifact pollution');
    assert.match(e2eDetails, /policy-allowed dirty paths/, 'F-004: details must show policy-allowed wording');
    assert.match(e2eDetails, /declared_artifact_changes/, 'F-004: details must mention declared_artifact_changes');
    assert.doesNotMatch(e2eDetails, /unexpected_dirty_files/, 'F-004: declared BL21 must NOT appear as unexpected_dirty_files');
    // Audit trail must exist for the declared artifact pass.
    const e2eAuditPath = join(declaredE2eRoot, '.lattice', 'story', 'actives', e2eStoryId, 'process-events.jsonl');
    assert.ok(existsSync(e2eAuditPath), 'F-004: audit log must be written for declared artifact pass');
    const e2eAuditLines = readFileSync(e2eAuditPath, 'utf-8').trim().split('\n').filter(Boolean);
    const declaredAudit = e2eAuditLines.find(l => JSON.parse(l).category === 'declared_artifact_changes');
    assert.ok(declaredAudit, 'F-004: audit must include declared_artifact_changes entry');
  } finally {
    rmSync(declaredE2eRoot, { recursive: true, force: true });
  }

  // B-8db9 CHK-004: declared-artifact gate-bypass attack chain in the
  // side-effect-guard context. A hand-injected declared-artifacts.json entry
  // pointing at a material source path must NOT let executeValidationPlan
  // pass — the classifier reorder keeps a dirty source file as
  // material_source_changes (blocking) even when it is declared.
  const attackChainRoot = mkdtempSync(join(tmpdir(), 'lattice-validation-attack-chain-'));
  try {
    const ATTACK_SOURCE = 'packages/main/src/core/store.ts';
    writeFileSync(join(attackChainRoot, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    mkdirSync(join(attackChainRoot, 'packages/main/src/core'), { recursive: true });
    writeFileSync(join(attackChainRoot, ATTACK_SOURCE), 'export const seed = 1;\n');
    execFileSync('git', ['init'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Lattice Smoke'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['add', '.'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '-m', 'seed attack-chain smoke'], { cwd: attackChainRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    resetConfigCache();

    const attackStore = new StoryStore(attackChainRoot);
    const attackStoryId = 'B-attack';
    const attackNow = '2026-05-15T21:45:00.000Z';
    attackStore.writeStory(attackStoryId, {
      storyId: attackStoryId,
      name: 'declared-attack-chain-smoke',
      title: 'Declared attack chain smoke',
      description: 'Hand-injected source declaration must not bypass the dirty gate.',
      type: 'chore',
      phase: 'DEV',
      priority: 'high',
      createdAt: attackNow,
      startedAt: attackNow,
      endedAt: null,
      currentReviewRound: attackNow,
      events: [],
    });
    // Hand-inject the source path WITHOUT going through artifact_declare —
    // proving the classifier reorder is the hard gate independent of the
    // artifact_declare entry rejection.
    attackStore.writeDeclaredArtifacts(attackStoryId, {
      entries: [{
        path: ATTACK_SOURCE,
        reason: 'attacker hand-injects a source path to bypass the dirty gate',
        relatedIntent: 'CHK-001:happy:0',
        declaredAt: attackNow,
      }],
    });

    const attackResult = await executeValidationPlan({
      provider: 'smoke-attack-chain',
      commands: [{
        label: 'dirty the declared source file',
        command: 'node',
        args: ['-e', [
          "const fs = require('fs');",
          `fs.appendFileSync('${ATTACK_SOURCE.replace(/'/g, "\\'")}', '// polluted\\n');`,
        ].join(' ')],
      }],
    }, attackChainRoot, undefined, attackStoryId);

    const attackDetails = attackResult.details.join('\n');
    assert.notEqual(attackResult.status, 'pass', 'CHK-004: a declared dirty SOURCE file must NOT pass the side-effect guard');
    assert.equal(attackResult.allPass, false, 'CHK-004: declared source pollution must keep allPass false');
    assert.match(attackDetails, /material_source_changes/, 'CHK-004: dirty declared source must classify as material_source_changes');
    assert.doesNotMatch(attackDetails, /declared_artifact_changes=1/, 'CHK-004: the source path must NOT be downgraded to declared_artifact_changes');
  } finally {
    rmSync(attackChainRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  const invalidArgCwd = mkdtempSync(join(tmpdir(), 'lattice-validation-schema-'));
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
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
  assert.match(invalidVerificationIntent.stderr, /Argument validation failed/);
  assert.match(invalidVerificationIntent.stderr, /verificationIntent\.happy\.0\.type/);
  assert.match(invalidVerificationIntent.stderr, /integration_test/);
  assert.match(invalidVerificationIntent.stderr, /logic[\s\S]*cli[\s\S]*browser[\s\S]*manual[\s\S]*docs/);
  assert.equal(existsSync(join(invalidArgCwd, '.lattice')), false, 'schema failure should happen before metadata mutation');
  rmSync(invalidArgCwd, { recursive: true, force: true });

  const malformedJsonCwd = mkdtempSync(join(tmpdir(), 'lattice-validation-malformed-json-'));
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
  assert.match(malformedJson.stderr, /JSON parse failed|JSON parse|Unexpected end of JSON input|JSON 解析失败/);
  assert.match(malformedJson.stderr.trim().split('\n')[0], /JSON parse failed|JSON parse|JSON 解析失败/);
  assert.equal(existsSync(join(malformedJsonCwd, '.lattice')), false, 'malformed JSON should not create project metadata');
  rmSync(malformedJsonCwd, { recursive: true, force: true });

  const projectLocalRuntimeRoot = mkdtempSync(join(tmpdir(), 'lattice-runtime-mode-local-'));
  try {
    mkdirSync(join(projectLocalRuntimeRoot, 'node_modules', '.bin'), { recursive: true });
    const localBin = join(projectLocalRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'lattice.cmd' : 'lattice');
    writeFileSync(localBin, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(projectLocalRuntimeRoot, {
      commandResolver: () => localBin,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(projectLocalRuntimeRoot, 'node_modules', '@lattice-agent', 'core'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'project-local-package');
    assert.equal(report.runtimeMode.source, 'project-node-modules');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, true);
  } finally {
    rmSync(projectLocalRuntimeRoot, { recursive: true, force: true });
  }

  const externalRuntimeRoot = mkdtempSync(join(tmpdir(), 'lattice-runtime-mode-external-'));
  const externalEngineRoot = mkdtempSync(join(tmpdir(), 'lattice-runtime-mode-engine-'));
  try {
    mkdirSync(join(externalEngineRoot, 'dist'), { recursive: true });
    const engineCli = join(externalEngineRoot, 'dist', 'cli.js');
    writeFileSync(engineCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(externalRuntimeRoot, {
      commandResolver: () => engineCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: externalEngineRoot,
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'compatibility-launcher');
    assert.equal(report.runtimeMode.source, 'external-development-engine');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
  } finally {
    rmSync(externalRuntimeRoot, { recursive: true, force: true });
    rmSync(externalEngineRoot, { recursive: true, force: true });
  }

  const latticeConflictRuntimeRoot = mkdtempSync(join(tmpdir(), 'lattice-runtime-mode-lattice-conflict-'));
  try {
    mkdirSync(join(latticeConflictRuntimeRoot, 'node_modules', '.bin'), { recursive: true });
    const localBin = join(latticeConflictRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'lattice.cmd' : 'lattice');
    const otherCli = join(latticeConflictRuntimeRoot, 'other-lattice');
    writeFileSync(localBin, '#!/usr/bin/env node\n');
    writeFileSync(otherCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(latticeConflictRuntimeRoot, {
      commandResolver: () => otherCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(latticeConflictRuntimeRoot, 'node_modules', '@lattice-agent', 'core'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'diagnostic-only');
    assert.equal(report.runtimeMode.source, 'unknown');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
    assert.equal((report.projectLocalBin.actual as any).path, localBin, 'project-local-bin must report the lattice bin that shadows the active CLI');
    assert.equal((report.projectLocalBin.actual as any).shadowsEntrypoint, true);
    assert.match(report.projectLocalBin.warnings?.join('\n') ?? '', /node_modules\/\.bin\/lattice/);
    const runtimeSummary = renderRuntimeFootprintSummary(report.runtimeMode);
    assert.match(
      runtimeSummary,
      /Next action: project-local CLI bin .*node_modules\/\.bin\/lattice resolves to .* but the active CLI resolves to .*/,
    );
  } finally {
    rmSync(latticeConflictRuntimeRoot, { recursive: true, force: true });
  }

  const conflictRuntimeRoot = mkdtempSync(join(tmpdir(), 'lattice-runtime-mode-legacy-koala-local-'));
  try {
    mkdirSync(join(conflictRuntimeRoot, 'node_modules', '.bin'), { recursive: true });
    const legacyLocalBin = join(conflictRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'koala.cmd' : 'koala');
    const otherCli = join(conflictRuntimeRoot, 'other-koala');
    writeFileSync(legacyLocalBin, '#!/usr/bin/env node\n');
    writeFileSync(otherCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(conflictRuntimeRoot, {
      commandResolver: () => otherCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(conflictRuntimeRoot, 'runtime-core'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'diagnostic-only');
    assert.equal(report.runtimeMode.source, 'unknown');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
    assert.equal(
      (report.projectLocalBin.actual as any).path,
      join(conflictRuntimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'lattice.cmd' : 'lattice'),
      'project-local-bin must ignore stale koala local bins',
    );
    assert.equal((report.projectLocalBin.actual as any).present, false);
    const runtimeSummary = renderRuntimeFootprintSummary(report.runtimeMode);
    assert.ok(runtimeSummary.startsWith('Runtime footprint:\nRuntime mode: diagnostic-only'));
    assert.match(runtimeSummary, /Runtime source: unknown/);
    assert.match(runtimeSummary, /Project-local JavaScript runtime required: no/);
    assert.match(runtimeSummary, /Authority: local-runtime-diagnostic-only/);
    assert.doesNotMatch(runtimeSummary, /node_modules\/\.bin\/koala/);
  } finally {
    rmSync(conflictRuntimeRoot, { recursive: true, force: true });
  }

  const previousPackagedRuntime = process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME;
  process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME = '1';
  const packagedConflictRoot = mkdtempSync(join(tmpdir(), 'lattice-runtime-mode-packaged-conflict-'));
  try {
    mkdirSync(join(packagedConflictRoot, 'node_modules', '.bin'), { recursive: true });
    const legacyLocalBin = join(packagedConflictRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'koala.cmd' : 'koala');
    const packagedCli = join(packagedConflictRoot, 'packaged-koala');
    writeFileSync(legacyLocalBin, '#!/usr/bin/env node\n');
    writeFileSync(packagedCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(packagedConflictRoot, {
      commandResolver: () => packagedCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(packagedConflictRoot, 'packaged-runtime'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'packaged-runtime');
    assert.equal(report.runtimeMode.source, 'packaged-runtime');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
    assert.equal((report.projectLocalBin.actual as any).present, false, 'packaged mode should ignore stale koala local bins');
  } finally {
    rmSync(packagedConflictRoot, { recursive: true, force: true });
    if (previousPackagedRuntime === undefined) delete process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME;
    else process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME = previousPackagedRuntime;
  }

  const previousPackagedRuntimeClean = process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME;
  process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME = '1';
  const packagedCleanRoot = mkdtempSync(join(tmpdir(), 'lattice-runtime-mode-packaged-clean-'));
  try {
    const packagedCli = join(packagedCleanRoot, 'packaged-koala');
    writeFileSync(packagedCli, '#!/usr/bin/env node\n');
    const report = runRuntimeEnvironmentChecks(packagedCleanRoot, {
      commandResolver: () => packagedCli,
      globalNpmRootResolver: () => null,
      corePackageRoot: join(packagedCleanRoot, 'packaged-runtime'),
    });
    assertRuntimeModeShape(report.runtimeMode);
    assert.equal(report.runtimeMode.mode, 'packaged-runtime');
    assert.equal(report.runtimeMode.source, 'packaged-runtime');
    assert.equal(report.runtimeMode.requiresProjectJavaScriptRuntime, false);
  } finally {
    rmSync(packagedCleanRoot, { recursive: true, force: true });
    if (previousPackagedRuntimeClean === undefined) delete process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME;
    else process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME = previousPackagedRuntimeClean;
  }

  const checkRoot = mkdtempSync(join(tmpdir(), 'lattice-check-runtime-surface-'));
  try {
    resetConfigCache();
    const check = createCheckHandlers({
      root: checkRoot,
      scanRoot: checkRoot,
      store: new StoryStore(checkRoot),
      log: () => {},
    }).check;
    const checkJson = check({ json: true, profile: 'core' }) as any;
    assertRuntimeModeShape(checkJson.runtimeMode);
    assert.ok(Array.isArray(checkJson.items), 'check --json should preserve managed asset fields');
    let driftText = '';
    try {
      check({ profile: 'core' });
      assert.fail('plain check should throw on managed asset drift');
    } catch (error: any) {
      driftText = String(error.message || error);
    }
    assert.ok(driftText.startsWith('Runtime footprint:\nRuntime mode:'), 'plain check drift should render runtime footprint before drift details');
    assert.match(driftText, /Project-local JavaScript runtime required: (yes|no)/);
    assert.match(driftText, /Next action: run lattice check --apply to sync MISSING\/STALE_SAFE assets/);
    assert.match(driftText, /Lattice managed asset check: DRIFT/);

    runManagedAssetCheck(checkRoot, { apply: true, profile: 'core' });
    const cleanText = check({ profile: 'core' }) as string;
    assert.ok(cleanText.startsWith('Runtime footprint:\nRuntime mode:'), 'plain check OK should start with runtime footprint');
    assert.match(cleanText, /Next action: no managed asset drift/);
    assert.match(cleanText, /Lattice managed asset check: OK/);
  } finally {
    rmSync(checkRoot, { recursive: true, force: true });
  }

  const staleLocalAssetRoot = mkdtempSync(join(tmpdir(), 'lattice-managed-stale-local-'));
  try {
    writeFileSync(join(staleLocalAssetRoot, 'LATTICE.md'), '<!-- lattice:start -->\n# Local Lattice Notes\ncustom text\n<!-- lattice:end -->\n');
    const before = readFileSync(join(staleLocalAssetRoot, 'LATTICE.md'), 'utf-8');
    const plainCheck = createCheckHandlers({
      root: staleLocalAssetRoot,
      scanRoot: staleLocalAssetRoot,
      store: new StoryStore(staleLocalAssetRoot),
      log: () => {},
    }).check;
    let staleLocalCheckText = '';
    try {
      plainCheck({ profile: 'core', reviewLocalEdits: true });
      assert.fail('plain check should throw on stale local managed block edits');
    } catch (error: any) {
      staleLocalCheckText = String(error.message || error);
    }
    assert.ok(
      staleLocalCheckText.startsWith('Runtime footprint:\nRuntime mode:'),
      'plain check stale local edit should render runtime footprint before drift details',
    );
    assert.match(staleLocalCheckText, /Next action: review unsafe managed assets manually/);
    assert.match(staleLocalCheckText, /Lattice managed asset check: DRIFT/);
    assert.match(staleLocalCheckText, /STALE_LOCAL_EDIT LATTICE\.md|STALE_LOCAL_EDIT[\s\S]*LATTICE\.md/);
    const result = runManagedAssetCheck(staleLocalAssetRoot, { apply: true, reviewLocalEdits: true, profile: 'core' });
    const item = result.items.find(entry => entry.relPath === 'LATTICE.md');
    assert.equal(item?.status, 'STALE_LOCAL_EDIT');
    assert.equal(item?.applied, undefined);
    assert.equal(readFileSync(join(staleLocalAssetRoot, 'LATTICE.md'), 'utf-8'), before, 'STALE_LOCAL_EDIT must not be overwritten by apply');
    assert.equal(result.applied.includes('LATTICE.md'), false, 'STALE_LOCAL_EDIT must not be counted as applied');
    assert.equal(managedAssetNextAction(result), 'review unsafe managed assets manually');
    const rendered = renderManagedAssetCheck(result);
    assert.match(rendered, /STALE_LOCAL_EDIT LATTICE\.md/);
    assert.match(rendered, /action: review local edits before overwriting|action: review local doc edits before replacing the section/);
  } finally {
    rmSync(staleLocalAssetRoot, { recursive: true, force: true });
  }

  const caseMismatchAssetRoot = mkdtempSync(join(tmpdir(), 'lattice-managed-case-mismatch-'));
  try {
    writeFileSync(join(caseMismatchAssetRoot, 'lattice.md'), 'case mismatch\n');
    const result = runManagedAssetCheck(caseMismatchAssetRoot, { apply: true, profile: 'core' });
    const item = result.items.find(entry => entry.relPath === 'LATTICE.md');
    assert.equal(item?.status, 'CASE_MISMATCH');
    assert.equal(item?.applied, undefined);
    assert.equal(result.applied.includes('LATTICE.md'), false, 'CASE_MISMATCH must not be counted as applied');
    const rendered = renderManagedAssetCheck(result);
    assert.match(rendered, /CASE_MISMATCH LATTICE\.md/);
    assert.match(rendered, /action: rename the path with exact casing/);
  } finally {
    rmSync(caseMismatchAssetRoot, { recursive: true, force: true });
  }

  const incompatibleAssetRoot = mkdtempSync(join(tmpdir(), 'lattice-managed-incompatible-'));
  try {
    mkdirSync(join(incompatibleAssetRoot, 'bin', 'koala.js'), { recursive: true });
    const result = runManagedAssetCheck(incompatibleAssetRoot, { apply: true, profile: 'core' });
    const item = result.items.find(entry => entry.relPath === 'bin/koala.js');
    assert.equal(item?.status, 'INCOMPATIBLE');
    assert.equal(item?.applied, undefined);
    assert.equal(result.applied.includes('bin/koala.js'), false, 'INCOMPATIBLE must not be counted as applied');
    const rendered = renderManagedAssetCheck(result);
    assert.match(rendered, /INCOMPATIBLE bin\/koala\.js/);
    assert.match(rendered, /action: .*fix manually|action: .*manually/);
  } finally {
    rmSync(incompatibleAssetRoot, { recursive: true, force: true });
  }

  const wrapperRoot = mkdtempSync(join(tmpdir(), 'lattice-wrapper-cjs-'));
  try {
    mkdirSync(join(wrapperRoot, 'bin'), { recursive: true });
    const latticeWrapperPath = join(wrapperRoot, 'bin', 'lattice.js');
    const codexWrapperPath = join(wrapperRoot, 'bin', 'lattice-codex.js');
    writeFileSync(latticeWrapperPath, renderLatticeBootstrapScript(packageRoot));
    writeFileSync(codexWrapperPath, renderLatticeCodexWrapperScript());
    const latticeWrapper = readFileSync(latticeWrapperPath, 'utf-8');
    const codexWrapper = readFileSync(codexWrapperPath, 'utf-8');
    assert.match(latticeWrapper, /require\('node:fs'\)/, 'Lattice wrapper should be CommonJS so non-JS repos do not need package.json type=module');
    assert.match(codexWrapper, /import\('node:fs'\)/, 'Codex wrapper should use dynamic import so it runs in both CommonJS and type=module projects');
    assert.doesNotMatch(codexWrapper, /require\(/, 'Codex wrapper must not use require because type=module projects execute .js files as ESM');
    assert.doesNotMatch(latticeWrapper, /^import\s/m, 'Lattice wrapper must not use static ESM import syntax');
    assert.doesNotMatch(codexWrapper, /^import\s/m, 'Codex wrapper must not use static ESM import syntax');

    const latticeHelp = spawnSync(process.execPath, [latticeWrapperPath, 'help'], { cwd: wrapperRoot, encoding: 'utf8' });
    assert.equal(latticeHelp.status, 0, latticeHelp.stderr || latticeHelp.stdout);
    assert.doesNotMatch(latticeHelp.stderr, /MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module/, 'Lattice wrapper help must not emit Node module-type warnings');

    const codexHelp = spawnSync(process.execPath, [codexWrapperPath, 'help'], { cwd: wrapperRoot, encoding: 'utf8' });
    assert.equal(codexHelp.status, 0, codexHelp.stderr || codexHelp.stdout);
    assert.doesNotMatch(codexHelp.stderr, /MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module/, 'Codex wrapper help must not emit Node module-type warnings');
  } finally {
    rmSync(wrapperRoot, { recursive: true, force: true });
  }

  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.stdout.write(\\"fallback\\")"' },
  }));
  execFileSync('git', ['init'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['config', 'user.name', 'Lattice Smoke'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });
  mkdirSync(join(tmp, '.lattice', 'story', 'actives', 'B-demo'), { recursive: true });
  mkdirSync(join(tmp, '.lattice', 'runtime'), { recursive: true });
  writeFileSync(join(tmp, '.lattice', 'activity.jsonl'), '{}\n');
  const shellMetaArtifactPath = ".lattice/runtime/$USER $(echo hi) `uname` 'artifact'.json";
  writeFileSync(join(tmp, shellMetaArtifactPath), '{}\n');
  writeFileSync(join(tmp, '.lattice', 'story', 'actives', 'B-demo', 'index.json'), '{}\n');
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
  assertRuntimeModeShape(doctorJson.runtimeMode);
  assert.ok(doctorJson.runtime, 'doctor JSON should expose runtime section');
  assert.deepEqual(doctorJson.runtime.runtimeMode, doctorJson.runtimeMode, 'doctor should expose runtimeMode top-level and inside runtime scan');
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
  assert.ok(doctorJson.storyOwnerLeases, 'doctor JSON should expose story owner lease diagnostics');
  assert.ok(Array.isArray(doctorJson.storyOwnerLeases.leases), 'storyOwnerLeases.leases should be an array');
  assert.ok(Array.isArray(doctorJson.storyOwnerLeases.stale), 'storyOwnerLeases.stale should be an array');
  assert.ok(Array.isArray(doctorJson.storyOwnerLeases.terminalStale), 'storyOwnerLeases.terminalStale should be an array');
  assert.equal(doctorJson.storyOwnerLeases.hasTerminalStale, false, 'no terminal stale lease in the clean doctor fixture');
  const activityArtifact = doctorJson.runtimeArtifacts.tracked.find((artifact: any) => artifact.path === '.lattice/activity.jsonl');
  assert.ok(activityArtifact, 'doctor should include .lattice/activity.jsonl');
  assert.equal(activityArtifact.repairable, true);
  assert.equal(activityArtifact.repairCommand, "git rm --cached -- '.lattice/activity.jsonl'");
  const shellMetaArtifact = doctorJson.runtimeArtifacts.tracked.find((artifact: any) => artifact.path === shellMetaArtifactPath);
  assert.ok(shellMetaArtifact, 'doctor should include tracked runtime artifacts with shell metacharacters');
  assert.equal(shellMetaArtifact.repairable, true);
  assert.equal(
    shellMetaArtifact.repairCommand,
    "git rm --cached -- '.lattice/runtime/$USER $(echo hi) `uname` '\"'\"'artifact'\"'\"'.json'",
  );

  const doctorText = doctor() as string;
  assert.ok(doctorText.startsWith('Runtime footprint:\nRuntime mode:'), 'plain doctor should start with runtime footprint');
  assert.match(doctorText, /Project-local JavaScript runtime required: (yes|no)/);
  assert.match(doctorText, /Next action: /);
  assert.match(doctorText, /Runtime artifacts:/);
  assert.match(doctorText, /\.lattice\/activity\.jsonl/);
  assert.match(doctorText, /git rm --cached -- '\.lattice\/activity\.jsonl'/);
  assert.match(doctorText, /git rm --cached -- '\.lattice\/runtime\/\$USER \$\(echo hi\) `uname` '"'"'artifact'"'"'\.json'/);
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
    ['.lattice/activity.jsonl', shellMetaArtifactPath].sort(),
  );
  assert.notEqual(execFileSync('git', ['ls-files', '--', '.lattice/story/actives/B-demo/index.json'], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should not untrack story evidence');
  assert.equal(execFileSync('git', ['ls-files', '--', '.lattice/activity.jsonl'], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should untrack runtime artifacts');
  assert.equal(execFileSync('git', ['ls-files', '--', shellMetaArtifactPath], { cwd: tmp, encoding: 'utf8' }).trim(), '', 'doctor --repair should untrack metacharacter runtime artifacts');

  // B-50fb F-001: transition fallback must share the machine guard predicate,
  // not getGuardFailureReason's human-facing renderer. The renderer currently
  // falls through to null when PLAN→DEV config loading fails after parsing,
  // while the guard is fail-closed. Runtimes without snapshot.can must
  // therefore return false.
  const transitionFallbackRoot = mkdtempSync(join(tmpdir(), 'lattice-transition-fallback-'));
  try {
    resetConfigCache();
    const store = new StoryStore(transitionFallbackRoot);
    const storyId = 'B-transition-fallback';
    const now = '2026-06-12T22:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'transition-fallback',
      title: 'Transition fallback',
      description: 'Synthetic story for PLAN to DEV guard fallback.',
      type: 'chore',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
    });
    writeFileSync(join(transitionFallbackRoot, 'lattice.config.json'), JSON.stringify({
      storyDir: '.koala/story/actives',
    }));
    resetConfigCache();
    const actorWithoutSnapshotCan = {
      getSnapshot: () => ({ value: 'PLAN' }),
    } as any;
    assert.equal(
      getGuardFailureReason(storyId, store, 'DEV', transitionFallbackRoot),
      null,
      'legacy guard-failure renderer still falls through on config-load failure',
    );
    assert.equal(
      canSendStoryEvent(actorWithoutSnapshotCan, 'START', storyId, store, transitionFallbackRoot),
      false,
      'snapshot.can fallback must fail closed on PLAN→DEV config-load failure',
    );
    assert.throws(
      () => assertStoryTransitionReachedTarget(storyId, 'START', 'DEV', 'PLAN'),
      /did not reach requested phase DEV/,
      'orchestrator must verify actor.send reached the requested target before writing DEV effects',
    );
    assert.equal(store.readStory(storyId).phase, 'PLAN');
  } finally {
    rmSync(transitionFallbackRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // B-56d3 CHK-003: validate-gate fail-closed regression.
  // The DEV->TEST lattice validate gate was extracted into handlers/phase-gates.ts
  // (runValidateGate), and B-6974 moved actor lifecycle ownership up to
  // transition-orchestrator.ts. The gate must still fail-closed: a failing
  // validate run must throw "Cannot enter TEST" and persist a FAIL
  // test-evidence record — never silently advance. Direct gate calls must not
  // stop the actor themselves.
  const { runValidateGate } = await import('../handlers/phase-gates.js');

  const gateFailRoot = mkdtempSync(join(tmpdir(), 'lattice-validate-gate-fail-'));
  try {
    writeFileSync(join(gateFailRoot, 'lattice.config.json'), JSON.stringify({
      validate: {
        commands: [
          { label: 'failing gate', command: 'node', args: ['-e', 'process.exit(5)'] },
        ],
      },
    }));
    resetConfigCache();
    const store = new StoryStore(gateFailRoot);
    const storyId = 'B-vgate-fail';
    const now = '2026-05-16T03:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'validate-gate-fail', title: 'Validate gate fail',
      description: 'validate FAIL must block TEST', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    let stopped = false;
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runValidateGate({ store, root: gateFailRoot, scanRoot: gateFailRoot }, storyId, actor),
      /Cannot enter TEST: lattice validate did not pass/,
      'runValidateGate must block TEST when lattice validate fails',
    );
    assert.equal(stopped, false, 'runValidateGate must leave actor stop to transition-orchestrator');
    assert.equal(store.readTestEvidence(storyId)?.result, 'FAIL', 'validate FAIL must persist a FAIL test-evidence record');
  } finally {
    rmSync(gateFailRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // B-a30e CHK-001: validate storyId alias — conflict, evidence, read-only parity

  // 1. Conflicting story + storyId values must fail with an explicit error
  const conflictAliasRoot = mkdtempSync(join(tmpdir(), 'lattice-validate-alias-conflict-'));
  try {
    resetConfigCache();
    await assert.rejects(
      () => createVerifierHandlers({
        root: conflictAliasRoot,
        scanRoot: conflictAliasRoot,
        store: new StoryStore(conflictAliasRoot),
        log: () => {},
      }).validate({ story: 'B-x1', storyId: 'B-x2', json: true }),
      /conflicting story identifiers.*--story.*storyId.*differ/i,
      'validate with story != storyId must fail with an explicit error',
    );
  } finally {
    rmSync(conflictAliasRoot, { recursive: true, force: true });
  }

  // 2. storyId alias writes test evidence (same as --story)
  const storyIdAliasRoot = mkdtempSync(join(tmpdir(), 'lattice-validate-storyid-alias-'));
  try {
    resetConfigCache();
    const aliasStore = new StoryStore(storyIdAliasRoot);
    const aliasJson = await createVerifierHandlers({
      root: storyIdAliasRoot,
      scanRoot: storyIdAliasRoot,
      store: aliasStore,
      log: () => {},
    }).validate({ storyId: 'B-alias-smoke', json: true, noSync: true });
    const aliasResult = JSON.parse(aliasJson);
    assert.equal(aliasResult.provider, 'lattice-verifier-no-validation-entry', 'storyId alias: expected no-validation-entry provider');
    assert.equal(aliasResult.status, 'warn', 'storyId alias: expected warn status for no-validator');
    const aliasEvidence = aliasStore.readTestEvidence('B-alias-smoke');
    assert.ok(aliasEvidence !== null, 'storyId alias: test evidence must be written when storyId is supplied');
    assert.equal(aliasEvidence!.result, 'PASS', 'storyId alias: warn/skip evidence persists as PASS');
  } finally {
    rmSync(storyIdAliasRoot, { recursive: true, force: true });
  }

  // 3. --story still writes test evidence (unchanged behavior)
  const storyFlagRoot = mkdtempSync(join(tmpdir(), 'lattice-validate-story-flag-'));
  try {
    resetConfigCache();
    const storyFlagStore = new StoryStore(storyFlagRoot);
    const storyFlagJson = await createVerifierHandlers({
      root: storyFlagRoot,
      scanRoot: storyFlagRoot,
      store: storyFlagStore,
      log: () => {},
    }).validate({ story: 'B-story-flag-smoke', json: true, noSync: true });
    const storyFlagResult = JSON.parse(storyFlagJson);
    assert.equal(storyFlagResult.provider, 'lattice-verifier-no-validation-entry', '--story flag: expected no-validation-entry provider');
    const storyFlagEvidence = storyFlagStore.readTestEvidence('B-story-flag-smoke');
    assert.ok(storyFlagEvidence !== null, '--story flag: test evidence must be written (regression guard)');
  } finally {
    rmSync(storyFlagRoot, { recursive: true, force: true });
  }

  // 4. No-story validate is diagnostic/read-only: must not write any .lattice/ state
  const noStoryReadOnlyRoot = mkdtempSync(join(tmpdir(), 'lattice-validate-no-story-'));
  try {
    resetConfigCache();
    const noStoryJson = await createVerifierHandlers({
      root: noStoryReadOnlyRoot,
      scanRoot: noStoryReadOnlyRoot,
      store: new StoryStore(noStoryReadOnlyRoot),
      log: () => {},
    }).validate({ json: true });
    const noStoryResult = JSON.parse(noStoryJson);
    assert.equal(noStoryResult.provider, 'lattice-verifier-no-validation-entry', 'no-story: expected diagnostic provider');
    assert.equal(existsSync(join(noStoryReadOnlyRoot, '.lattice')), false, 'no-story validate must not create any .lattice/ state (read-only)');
  } finally {
    rmSync(noStoryReadOnlyRoot, { recursive: true, force: true });
  }

  console.log('✓ validation protocol smoke passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
