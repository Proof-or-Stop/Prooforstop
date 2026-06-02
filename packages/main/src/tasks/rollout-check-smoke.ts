#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    env: { ...process.env, KOALA_ACTIVITY_RECORD_READONLY: '0' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runJson(args: string[]): RolloutCheckResult {
  return JSON.parse(runCli(args)) as RolloutCheckResult;
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
  assert.equal(result.product.primaryBin, 'lattice', `${label} primary bin`);
  assert.equal(result.product.legacyAlias, 'koala', `${label} legacy alias preserved`);
  assert.equal(result.summary.total, result.projects.length, `${label} summary total matches projects`);
  assert.ok(result.projects.length >= 1, `${label} returns at least one project`);
  assert.ok(result.projects.every(project => project.nextAction.length > 0), `${label} has next actions`);
  const commands = collectCommands(result);
  assert.ok(commands.some(command => command.startsWith('lattice check')), `${label} records lattice check probe`);
  assert.ok(commands.some(command => command.startsWith('lattice doctor')), `${label} records lattice doctor probe`);
  assert.ok(commands.every(command => command.startsWith('lattice ') || command === 'filesystem stat'), `${label} commands prefer lattice`);
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
assert.match(help, /Primary entrypoint:\s+lattice/, 'help names lattice as primary entrypoint');
assert.match(help, /Legacy alias:\s+koala/, 'help preserves koala as legacy alias');
const storyCreateHelp = runCli(['story_create', '--help']);
assert.match(storyCreateHelp, /lattice story_create/, 'story_create help uses lattice examples');
assert.match(storyCreateHelp, /lattice session_brief/, 'story_create help next step uses lattice');
assert.match(storyCreateHelp, /legacy alias: koala/, 'tool help still documents legacy alias');

const flat = runJson(['rollout_check', `--projects=${repoRoot}`, '--format=json']);
assertRolloutShape(flat, 'flat command');
assert.equal(flat.projects[0]?.path, repoRoot, 'flat command scans requested project');

const alias = runJson(['lattice', 'rollout', 'check', `--projects=${repoRoot}`, '--json']);
assertRolloutShape(alias, 'space alias');
assert.equal(alias.projects[0]?.path, repoRoot, 'space alias scans requested project');

// Core handles non-Lattice/nonexistent projects as explicit project results.
const tempRoot = join(tmpdir(), `lattice-rollout-smoke-${process.pid}-${Date.now()}`);
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
  const externalMonorepo = join(tempRoot, 'external-monorepo');
  const externalMain = join(externalMonorepo, 'packages', 'main');
  mkdirSync(externalMain, { recursive: true });
  writeFileSync(join(externalMonorepo, 'package.json'), JSON.stringify({ name: 'external-monorepo', version: '1.0.0' }, null, 2));
  writeFileSync(join(externalMain, 'package.json'), JSON.stringify({ name: '@example/main', version: '1.0.0' }, null, 2));
  const externalResult = buildRolloutCheck({ root: tempRoot, projects: [externalMonorepo] });
  const configProbe = externalResult.projects[0]?.probes.find(probe => probe.id === 'lattice_config_doctor');
  assert.equal(configProbe?.status, 'pass', 'external packages/main layout is not treated as the Lattice source tree');
  assert.match(configProbe?.detail ?? '', /external project/, 'external packages/main layout keeps external-project guidance');
  assert.ok(!configProbe?.nextAction?.includes('Refresh the local CLI package'), 'external packages/main layout avoids self-layout refresh guidance');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const after = gitStatus();
assert.equal(after, before, 'rollout_check smoke did not mutate git status');

console.log('rollout-check-smoke: PASS');
