


import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { prepareOfflineDependencyOverrides, sourceManifests } from "../../../../scripts/verify-proof-or-stop-pack-boundary.mjs";
import ts from 'typescript';



import { state, fixtureRoots, classifyRuntimeEntrypointAuthority, packageRoot, repoRoot, StoryStore, COMMAND_POLICIES, enforceStoryRuntimeAdmission, resolveEffectiveOwnershipClass, commandRequiresAuthoritativeRuntime } from "./data.mjs";
import { initRepo, git, runCli, validBackground } from "./fixture-support.mjs";
import { check } from "./runner.mjs";
import { createRuntimeFixture, snapshotRuntimeState, assertRuntimeFixtureUnchanged } from "./public-fixtures.mjs";

export function ensureRuntimeTopologyFixture() {
  if (state.runtimeTopologyFixture) return state.runtimeTopologyFixture;
  const container = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-classifier-topology-'));
  fixtureRoots.push(container);
  const main = join(container, 'main');
  mkdirSync(main);
  initRepo(main, true);
  const linked = join(container, 'story-worktree');
  git(main, ['worktree', 'add', '-b', 'story/B-fixture', linked]);
  state.runtimeTopologyFixture = { main: realpathSync(main), linked: realpathSync(linked) };
  return state.runtimeTopologyFixture;
}

export function runtimeTopologyInput(command, projectRoot, runtimeRoot) {
  return {
    command,
    commandArgs: ['{"storyId":"B-fixture"}'],
    projectRoot,
    invokedEntrypoint: join(runtimeRoot, 'bin', 'proof-or-stop.js'),
    loadedCorePackageRoot: join(runtimeRoot, 'packages', 'main'),
    env: { PATH: process.env.PATH, DEVELOPER_DIR: process.env.DEVELOPER_DIR },
  };
}

export function assertForeignRuntimeTopology(command, topology) {
  const decision = classifyRuntimeEntrypointAuthority(runtimeTopologyInput(command, topology.main, topology.linked));
  assert.equal(decision.status, 'blocked', command);
  assert.equal(decision.reasonCode, 'foreign_self_project_runtime_for_story_write', command);
  assert.equal(decision.projectRoot, topology.main, command);
  assert.equal(decision.worktreeRoot, topology.main, command);
  assert.equal(decision.mainRoot, topology.main, command);
  assert.equal(decision.runtimeRoot, topology.linked, command);
  assert.equal(decision.gitCommonDir, realpathSync(join(topology.main, '.git')), command);
  assert.equal(decision.selfHostWorktree, false, command);
}

export async function runCases() {
await check(['runtime', 'runtime-topology'], 'CHK-003 matching main and linked Story runtimes resolve complete explicit topology', () => {
  const topology = ensureRuntimeTopologyFixture();
  for (const projectRoot of [topology.main, topology.linked]) {
    const decision = classifyRuntimeEntrypointAuthority(runtimeTopologyInput('story_update', projectRoot, projectRoot));
    assert.equal(decision.status, 'pass');
    assert.equal(decision.reasonCode, undefined);
    assert.equal(decision.projectRoot, projectRoot);
    assert.equal(decision.worktreeRoot, projectRoot);
    assert.equal(decision.runtimeRoot, projectRoot);
    assert.equal(decision.mainRoot, topology.main);
    assert.equal(decision.gitCommonDir, realpathSync(join(topology.main, '.git')));
    assert.equal(decision.selfHostWorktree, projectRoot === topology.linked);
  }
});

await check(['runtime'], 'CHK-003:happy:0 matching project-local runtime admits Story writers', () => {
  const fixture = createRuntimeFixture();
  cpSync(packageRoot, join(fixture.root, 'packages', 'main'), { recursive: true });
  cpSync(join(repoRoot, 'proof-or-stop.config.json'), join(fixture.root, 'proof-or-stop.config.json'));
  symlinkSync(join(repoRoot, 'node_modules'), join(fixture.root, 'node_modules'), 'dir');
  git(fixture.root, ['add', 'proof-or-stop.config.json']);
  git(fixture.root, ['commit', '-m', 'configure matching self-project runtime']);
  const result = runCli(
    fixture.root,
    'story_update',
    { storyId: fixture.storyId, title: 'Matching local handler admitted' },
    {},
    { entrypoint: join(fixture.root, 'packages', 'main', 'dist', 'cli.js') },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(new StoryStore(fixture.root).readStory(fixture.storyId).title, 'Matching local handler admitted');
});

await check(['runtime', 'runtime-topology'], 'F-004 reviewerWrite Story evidence commands share foreign-runtime admission', () => {
  const topology = ensureRuntimeTopologyFixture();
  const reviewerWriters = Object.entries(COMMAND_POLICIES)
    .filter(([, policy]) => policy.ownershipClass === 'reviewerWrite')
    .map(([command]) => command);
  assert.ok(reviewerWriters.length >= 5, 'expected the registered reviewer evidence writers');
  for (const command of reviewerWriters) {
    assertForeignRuntimeTopology(command, topology);
    assert.throws(
      () => enforceStoryRuntimeAdmission({
        ...runtimeTopologyInput(command, topology.main, topology.linked),
        effectiveOwnership: 'reviewerWrite',
      }),
      /Blocked \[foreign_self_project_runtime_for_story_write\] before dispatch\./,
      command,
    );
  }
  const ownerDelivery = resolveEffectiveOwnershipClass(
    'delivery_check_set',
    { storyId: 'B-fixture', agentId: 'proof-or-stop-implementer' },
    'B-fixture',
  );
  const reviewerDelivery = resolveEffectiveOwnershipClass(
    'delivery_check_set',
    { storyId: 'B-fixture', agentId: 'proof-or-stop-review-delivery' },
    'B-fixture',
  );
  assert.equal(ownerDelivery, 'storyScopedMutating');
  assert.equal(reviewerDelivery, 'reviewerWrite');
});

await check(['runtime'], 'F-010/F-011 registry-derived Story-write capability crosses ownership classes and preserves dynamic reads', () => {
  const requiredWriters = [
    'story_update',
    'init_check_set',
    'story_discard',
    'story_draft_discard',
    'done_recover',
    'story_create',
    'story_create_from_repro',
    'planner_create_story',
    'story_reconcile',
    'gap_log',
    'signature_backfill',
    'planner_run',
    'identity_state_migrate',
    'reviewer_list',
    'agent_prompt',
    'evaluate',
    'dispatch',
    'certification_window_status',
    'doctor',
  ];
  const mutatingArgs = {
    story_reconcile: { dryRun: false },
    signature_backfill: { apply: true },
    identity_state_migrate: { confirm: true },
    reviewer_list: { storyId: 'B-fixture', forceReviewer: 'quality' },
    agent_prompt: { storyId: 'B-fixture', role: 'proof-or-stop-review-quality', auditExperiment: true, format: 'json' },
    evaluate: { storyId: 'B-fixture' },
    dispatch: { storyId: 'B-fixture', agentType: 'proof-or-stop-review-story-init' },
    certification_window_status: { storyId: 'B-fixture', refresh: true },
    doctor: { repair: true },
  };
  const ownershipContexts = {
    evaluate: { config: { cli: { command: 'echo evaluator' }, promptEnvelope: { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proof-or-stop-evaluator': 'full-envelope' } } } },
  };
  for (const command of requiredWriters) {
    const args = mutatingArgs[command] ?? {};
    const effective = resolveEffectiveOwnershipClass(command, args, 'B-fixture', undefined, ownershipContexts[command]);
    assert.equal(commandRequiresAuthoritativeRuntime(command, effective), true, command);
  }
  for (const variant of [
    ['validate', {}],
    ['done_prepare', { storyId: 'B-fixture', dryRun: true }],
    ['plan_skeleton', { storyId: 'B-fixture' }],
    ['evidence_refresh', { storyId: 'B-fixture' }],
    ['live_smoke_transcript', { storyId: 'B-fixture' }],
    ['delivery_context_pack', { storyId: 'B-fixture' }],
    ['usage_sweep', {}],
    ['story_reconcile', {}],
    ['story_reconcile', { dryRun: true }],
    ['signature_backfill', {}],
    ['identity_state_migrate', { id: 'B-fixture' }],
    ['reviewer_list', { storyId: 'B-fixture' }],
    ['agent_prompt', { role: 'proof-or-stop-review-quality' }],
    ['certification_window_status', { storyId: 'B-fixture' }],
    ['finding_list', { storyId: 'B-fixture' }],
    ['doctor', {}],
  ]) {
    const storyId = variant[1].storyId ?? null;
    const effective = resolveEffectiveOwnershipClass(variant[0], variant[1], storyId);
    assert.equal(commandRequiresAuthoritativeRuntime(variant[0], effective), false, variant[0]);
  }
});

await check(['runtime'], 'F-010 dangerous Story writers reject a real foreign runtime with zero mutation', () => {
  for (const [command, payload] of [
    ['story_discard', { storyId: 'B-fixture' }],
    ['story_draft_discard', { name: 'missing-draft' }],
    ['done_recover', { storyId: 'B-fixture' }],
  ]) {
    const fixture = createRuntimeFixture();
    const before = snapshotRuntimeState(fixture);
    const result = runCli(fixture.root, command, payload);
    assert.notEqual(result.status, 0, command);
    assert.match(`${result.stdout}${result.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i, command);
    assertRuntimeFixtureUnchanged(fixture, before);
  }
});

await check(['runtime'], 'F-011 main-shared Story creators reject a real foreign runtime with zero mutation', () => {
  const variants = [
    {
      command: 'story_create',
      payload: {
        name: 'foreign-create-must-stop',
        title: 'Foreign create must stop',
        description: 'A mismatched self-project runtime cannot create a Story envelope.',
        type: 'chore',
        priority: 'high',
        background: validBackground(),
        forceNew: true,
        checklist: [{ title: 'Never persisted', context: 'Runtime authority must reject before Story creation.' }],
      },
    },
    { command: 'story_create_from_repro', payload: {} },
    { command: 'planner_create_story', payload: {} },
    { command: 'planner_run', payload: { request: 'Create one bounded test Story' } },
    { command: 'signature_backfill', payload: { map: 'does-not-exist.json', apply: true } },
    { command: 'identity_state_migrate', payload: { id: 'B-fixture', confirm: true } },
    { command: 'reviewer_list', payload: { storyId: 'B-fixture', forceReviewer: 'quality' } },
    { command: 'agent_prompt', payload: { storyId: 'B-fixture', role: 'proof-or-stop-review-quality', auditExperiment: true, format: 'json' } },
    { command: 'dispatch', payload: { storyId: 'B-fixture', agentType: 'proof-or-stop-review-story-init' } },
    { command: 'certification_window_status', payload: { storyId: 'B-fixture', refresh: true } },
    { command: 'doctor', payload: { repair: true, format: 'json' } },
    {
      command: 'evaluate',
      payload: { storyId: 'B-fixture' },
      prepare(fixture) {
        const configPath = join(fixture.root, 'proof-or-stop.config.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        config.cli = { command: 'echo evaluator' };
        config.promptEnvelope = {
          version: 'proof-or-stop.prompt-envelope-rollout.v1',
          roles: { 'proof-or-stop-evaluator': 'full-envelope' },
        };
        writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      },
    },
  ];
  for (const variant of variants) {
    const fixture = createRuntimeFixture();
    variant.prepare?.(fixture);
    const before = snapshotRuntimeState(fixture);
    const result = runCli(fixture.root, variant.command, variant.payload);
    assert.notEqual(result.status, 0, variant.command);
    assert.match(`${result.stdout}${result.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i, variant.command);
    assertRuntimeFixtureUnchanged(fixture, before);
  }
});

await check(['runtime', 'runtime-topology'], 'CHK-003 every registry-derived story writer rejects a foreign linked-worktree runtime at main root', () => {
  const topology = ensureRuntimeTopologyFixture();
  const storyWriters = Object.entries(COMMAND_POLICIES)
    .filter(([, policy]) => policy.ownershipClass === 'storyScopedMutating')
    .map(([command]) => command);
  assert.ok(storyWriters.length > 0, 'canonical command policy must enumerate Story writers');
  for (const command of storyWriters) assertForeignRuntimeTopology(command, topology);
});

await check(['runtime'], 'CHK-003:happy:1 process/runtime verifiers pin the registry-derived pre-hook choke point', () => {
  for (const script of ['scripts/verify-process-fact-contract.mjs', 'scripts/verify-runtime-fact-contract.mjs']) {
    const startedAt = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [join(repoRoot, script), ...(script.includes('process') ? ['--quiet'] : [])], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${script}\n${result.stdout}${result.stderr}`);
    console.log('CANONICAL_VERIFIER_EXECUTION ' + JSON.stringify({
      command: process.execPath,
      args: [join(repoRoot, script), ...(script.includes('process') ? ['--quiet'] : [])],
      status: result.status,
      elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      successSelectors: (result.stdout || '').split('\n').filter(line =>
        line === 'Process fact contract verified' || line === 'execution_assertion_reuse_contract=PASS'),
    }));
  }
});

await check(['runtime'], 'CHK-003 external installed-package consumers remain outside the self-host rejection', () => {
  const externalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-consumer-'));
  try {
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(join(externalRoot, 'package.json'), '{"name":"external-consumer"}\n');
    const decision = classifyRuntimeEntrypointAuthority({
      command: 'checklist_update',
      commandArgs: ['{"storyId":"X","itemId":"CHK-001","status":"done"}'],
      projectRoot: externalRoot,
      invokedEntrypoint: join(packageRoot, 'dist', 'cli.js'),
      loadedCorePackageRoot: packageRoot,
      env: {},
    });
    assert.equal(decision.status, 'pass');
    assert.equal(decision.selfHostWorktree, false);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

await check(['runtime'], 'CHK-003:edge:0 external consumer public CLI permits normal Story mutation (packed installed canonical package)', () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-packed-consumer-'));
  fixtureRoots.push(consumerRoot);
  initRepo(consumerRoot, false);
  const tarballs = [];
  const npmCache = join(consumerRoot, '.npm-cache');
  for (const productRoot of [packageRoot, join(repoRoot, 'packages', 'lab'), join(repoRoot, 'packages', 'utils')]) {
    const pack = spawnSync('npm', ['pack', '--silent', productRoot, '--pack-destination', consumerRoot], {
      cwd: consumerRoot, encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_cache: npmCache },
    });
    assert.equal(pack.status, 0, `${productRoot}: ${pack.stdout}${pack.stderr}`);
    tarballs.push(join(consumerRoot, pack.stdout.trim().split(/\r?\n/u).at(-1)));
  }
  const offlineDependencies = prepareOfflineDependencyOverrides(sourceManifests());
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'proof-or-stop-identity-packed-consumer', version: '1.0.0', private: true,
    overrides: offlineDependencies.overrides,
  }, null, 2)}\n`);
  const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', '--omit=optional', '--package-lock=false', '--install-strategy=nested', ...tarballs], {
    cwd: consumerRoot, encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_cache: npmCache },
  });
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  const installedCli = join(consumerRoot, 'node_modules', '@proof-or-stop', 'core', 'dist', 'cli.js');
  const created = runCli(consumerRoot, 'story_create', {
    name: 'packed-consumer-story', title: 'Packed consumer Story',
    description: 'The packed canonical CLI is allowed to write in an unrelated external project.',
    type: 'chore', priority: 'medium', background: validBackground(), forceNew: true,
    checklist: [{ title: 'Observe installed mutation', context: 'The external package must remain usable.' }],
  }, {}, { entrypoint: installedCli });
  assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
  assert.match(created.stdout, /Story B-/);
});
}
