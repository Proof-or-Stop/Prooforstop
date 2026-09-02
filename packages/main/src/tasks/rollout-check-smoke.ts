#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { isCommandAllowed } from '../core/config.js';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { buildRolloutCheck, type RolloutCheckResult } from '../core/rollout-check.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const repoRoot = join(here, '..', '..', '..', '..');

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PROOF_OR_STOP_ACTIVITY_RECORD_READONLY: '0' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runJson(args: string[]): RolloutCheckResult {
  return JSON.parse(runCli(args)) as RolloutCheckResult;
}

function runCliFailure(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PROOF_OR_STOP_ACTIVITY_RECORD_READONLY: '0' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.notEqual(result.status, 0, `${args.join(' ')} should fail`);
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function gitStatus(): string {
  try {
    return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function collectCommands(result: RolloutCheckResult): string[] {
  return result.projects.flatMap(project => project.probes.map(probe => probe.command));
}

function assertRolloutShape(result: RolloutCheckResult, label: string): void {
  assert.equal(result.schemaVersion, 'lattice.rollout_check.v1', `${label} schema`);
  assert.equal(result.readOnly, true, `${label} is read-only`);
  assert.equal(result.macAppRequired, false, `${label} does not require Mac App`);
  // B-cdf6 CHK-002: the canonical bin is now proof-or-stop; `proof-or-stop` survives
  // only as a deprecated invocation alias and is NOT re-exposed as a structured
  // `legacyAlias` product field.
  assert.equal(result.product.primaryBin, 'proof-or-stop', `${label} primary bin`);
  assert.equal('legacyAlias' in result.product, false, `${label} does not expose a legacy alias`);
  assert.equal(result.summary.total, result.projects.length, `${label} summary total matches projects`);
  assert.ok(result.projects.length >= 1, `${label} returns at least one project`);
  assert.ok(result.projects.every(project => project.nextAction.length > 0), `${label} has next actions`);
  const commands = collectCommands(result);
  assert.ok(commands.some(command => command.startsWith('proof-or-stop check')), `${label} records proof-or-stop check probe`);
  assert.ok(commands.some(command => command.startsWith('proof-or-stop doctor')), `${label} records proof-or-stop doctor probe`);
  assert.ok(commands.every(command => command.startsWith('proof-or-stop ') || command === 'filesystem stat'), `${label} commands prefer proof-or-stop`);
  assert.ok(!commands.some(command => command.startsWith('proofOrStop ')), `${label} records no probe under the deprecated bin name`);
  for (const forbidden of result.safety.forbiddenArgs) {
    assert.ok(!commands.some(command => command.includes(forbidden)), `${label} never records ${forbidden}`);
  }
}

const before = gitStatus();

// Command registration and lifecycle contracts.
assert.ok(MAIN_TOOLS.some(tool => tool.name === 'rollout_check'), 'MAIN_TOOLS exposes rollout_check');
assert.equal(isCommandAllowed('rollout_check', 'DEV'), true, 'rollout_check allowed during DEV');
assert.equal(getCommandLifecyclePolicy('rollout_check')?.ownershipClass, 'readOnly', 'rollout_check is read-only');
assert.equal(getCommandLifecyclePolicy('rollout_check')?.destructiveRisk, 'none', 'rollout_check has no destructive risk');
assert.equal(
  PROCESS_FACT_LEVELS.find(entry => entry.name === 'rollout_check')?.level,
  'L0',
  'rollout_check is an L0 process fact',
);
{
  const store = new StoryStore(repoRoot);
  const ctx: HandlerContext = { store, root: repoRoot, scanRoot: join(repoRoot, 'packages', 'main') };
  const registry = createMainRegistry(ctx);
  assert.equal(registry.has('rollout_check'), true, 'registry exposes rollout_check');
}

// CLI help and nested alias semantics.
const help = runCli(['help']);
assert.match(help, /rollout_check/, 'help exposes rollout_check');
// B-cdf6 CHK-002: help mirrors the invoked bin; this run invokes the compiled
// entry, so it falls back to the canonical name rather than printing `cli`.
assert.match(help, /Entrypoint:\s+proof-or-stop/, 'help names proof-or-stop as entrypoint');
assert.doesNotMatch(help, /Usage: proofOrStop /, 'help never teaches the deprecated bin as the usage form');
const storyCreateHelp = runCli(['story_create', '--help']);
// B-cdf6 CHK-002: this asserted `proof-or-stop story_create` before the rename. The
// help examples now render the canonical bin, so the old expectation inverted
// into a guard that pinned the PRE-rename brand — it failed precisely because
// the rename succeeded. Assert the canonical form, and assert the deprecated
// form is absent so the example text cannot silently regress.
assert.match(storyCreateHelp, /proof-or-stop story_create/, 'story_create help uses proof-or-stop examples');
assert.doesNotMatch(storyCreateHelp, /proof-or-stop story_create/, 'story_create help no longer teaches the deprecated bin');
assert.match(storyCreateHelp, /proof-or-stop session_brief/, 'story_create help next step uses proof-or-stop');
assert.doesNotMatch(storyCreateHelp, /proof-or-stop session_brief/, 'story_create help next-step hint no longer teaches the deprecated bin');

const flat = runJson(['rollout_check', `--projects=${repoRoot}`, '--format=json']);
assertRolloutShape(flat, 'flat command');
assert.equal(flat.projects[0]?.path, repoRoot, 'flat command scans requested project');

const trailingComma = runJson(['rollout_check', `--projects=${repoRoot},`, '--format=json']);
assertRolloutShape(trailingComma, 'trailing comma project list');
assert.equal(trailingComma.summary.total, 1, 'trailing comma does not add the scan root as an extra project');
assert.equal(trailingComma.projects[0]?.path, repoRoot, 'trailing comma still scans the explicit project');

const allEmptyProjects = runCliFailure(['rollout_check', '--projects=,, ,', '--format=json']);
assert.match(allEmptyProjects.stderr, /rollout_check --projects was provided but did not include any project paths/, 'all-empty explicit project list is a clear CLI failure');
assert.equal(allEmptyProjects.stdout, '', 'all-empty explicit project list does not emit a zero-project success payload');

const alias = runJson(['proof-or-stop', 'rollout', 'check', `--projects=${repoRoot}`, '--json']);
assertRolloutShape(alias, 'space alias');
assert.equal(alias.projects[0]?.path, repoRoot, 'space alias scans requested project');

// Core handles non-Proof-or-Stop/nonexistent projects as explicit project results.
const tempRoot = join(tmpdir(), `proof-or-stop-rollout-smoke-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
try {
  const plainProject = join(tempRoot, 'plain');
  mkdirSync(plainProject, { recursive: true });
  writeFileSync(join(plainProject, 'package.json'), JSON.stringify({ name: 'plain-rollout-target', version: '0.0.0' }, null, 2));
  const missingProject = join(tempRoot, 'missing');
  const coreResult = buildRolloutCheck({ root: tempRoot, projects: [plainProject, missingProject] });
  assertRolloutShape(coreResult, 'core builder');
  assert.equal(coreResult.summary.total, 2, 'core builder scans both explicit projects');
  assert.equal(coreResult.projects.find(project => project.path === missingProject)?.status, 'fail', 'missing project is explicit fail');
  assert.ok(
    ['warn', 'fail', 'pass'].includes(coreResult.projects.find(project => project.path === plainProject)?.status ?? ''),
    'plain external project is normalized into a stable status',
  );
  const commaResult = buildRolloutCheck({ root: tempRoot, projects: `${plainProject},,${missingProject},` });
  assert.equal(commaResult.summary.total, 2, 'trailing/empty comma entries do not add root');
  assert.deepEqual(commaResult.projects.map(project => project.path), [plainProject, missingProject], 'comma list preserves only non-empty explicit projects');
  assert.throws(
    () => buildRolloutCheck({ root: tempRoot, projects: ',, , ' }),
    /rollout_check --projects was provided but did not include any project paths/,
    'all-empty explicit comma list fails instead of falling back to discovery',
  );
  assert.throws(
    () => buildRolloutCheck({ root: tempRoot, projects: ['', '   '] }),
    /rollout_check --projects was provided but did not include any project paths/,
    'all-empty explicit array fails instead of falling back to discovery',
  );
  const externalMonorepo = join(tempRoot, 'external-monorepo');
  const externalMain = join(externalMonorepo, 'packages', 'main');
  mkdirSync(externalMain, { recursive: true });
  writeFileSync(join(externalMonorepo, 'package.json'), JSON.stringify({ name: 'external-monorepo', version: '1.0.0' }, null, 2));
  writeFileSync(join(externalMain, 'package.json'), JSON.stringify({ name: '@example/main', version: '1.0.0' }, null, 2));
  const externalResult = buildRolloutCheck({ root: tempRoot, projects: [externalMonorepo] });
  const configProbe = externalResult.projects[0]?.probes.find(probe => probe.id === 'proof_or_stop_config_doctor');
  assert.equal(configProbe?.status, 'pass', 'external packages/main layout is not treated as the Proof-or-Stop source tree');
  assert.match(configProbe?.detail ?? '', /external project/, 'external packages/main layout keeps external-project guidance');
  assert.ok(!configProbe?.nextAction?.includes('Refresh the local CLI package'), 'external packages/main layout avoids self-layout refresh guidance');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const after = gitStatus();
assert.equal(after, before, 'rollout_check smoke did not mutate git status');

console.log('rollout-check-smoke: PASS');
