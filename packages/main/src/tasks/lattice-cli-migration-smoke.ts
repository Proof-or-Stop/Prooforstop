#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { isCommandAllowed } from '../core/config.js';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import { LATTICE_CLI_VERSION } from '../core/lattice-brand.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const repoRoot = join(here, '..', '..', '..', '..');

const COMMANDS = [
  'host_list',
  'host_probe',
  'host_status',
  'host_install',
  'lattice_config_doctor',
  'rollout_check',
  'conduit_status',
  'conduit_explain',
  'handoff_create',
  'handoff_receipt_submit',
  'handoff_worktree_create',
  'host_dispatch',
] as const;

function runCli(args: string[], env: Record<string, string | undefined> = {}): string {
  return execFileSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runJson<T>(args: string[], env: Record<string, string | undefined> = {}): T {
  return JSON.parse(runCli(args, env)) as T;
}

function assertNoProductionOverclaim(value: unknown, label: string): void {
  const seen: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        (key === 'productionDone' || key === 'receiptVerified' || key === 'canClaimProductionDone' || key === 'authorityChanged') &&
        child === true
      ) {
        seen.push(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(value, '');
  assert.deepEqual(seen, [], `${label} must not contain production/receipt/authority true overclaims`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function capabilityByCategory(profile: any, category: string): any {
  const capability = profile.capabilities.find((candidate: any) => candidate.category === category);
  assert.ok(capability, `${profile.id ?? 'host profile'} exposes ${category} capability`);
  return capability;
}

function degradationByCategory(degradations: any[], category: string): any {
  const degradation = degradations.find(candidate => candidate.capability === category);
  assert.ok(degradation, `${category} has visible degradation`);
  return degradation;
}

// Product identity and package entrypoints.
assert.match(runCli(['--version']), new RegExp(`Proofbound CLI ${LATTICE_CLI_VERSION}`));
assert.match(runCli(['version']), /Proofbound CLI/);
const rootPackage = readJson(join(repoRoot, 'package.json'));
const mainPackage = readJson(join(repoRoot, 'packages', 'main', 'package.json'));
assert.equal(rootPackage.version, LATTICE_CLI_VERSION, `root package version is ${LATTICE_CLI_VERSION}`);
assert.equal(mainPackage.version, LATTICE_CLI_VERSION, `packages/main version is ${LATTICE_CLI_VERSION}`);
assert.equal(mainPackage.bin.lattice, 'dist/cli.js', 'lattice package bin points at CLI');

// Help exposes first-class Proofbound identity and the new command set.
const help = runCli(['help']);
assert.match(help, new RegExp(`Proofbound CLI ${LATTICE_CLI_VERSION.replace(/\./g, '\\.')}`));
assert.match(help, /(?:^|\n)\s+Entrypoint:\s+lattice/);
for (const command of COMMANDS) {
  assert.match(help, new RegExp(command), `help exposes ${command}`);
  assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `MAIN_TOOLS exposes ${command}`);
  assert.equal(isCommandAllowed(command, 'DEV'), true, `${command} is allowed during active DEV`);
  assert.equal(getCommandLifecyclePolicy(command)?.ownershipClass, 'readOnly', `${command} is read-only`);
}
for (const alias of [
  'lattice host status',
  'lattice host dispatch',
  'lattice handoff create',
  'lattice handoff receipt submit',
  'lattice handoff worktree create',
] as const) {
  assert.match(help, new RegExp(alias.replace(/\s+/g, '\\s+')), `help exposes alias ${alias}`);
}

const storyCreateHelp = runCli(['story_create', '--help']);
assert.match(storyCreateHelp, /lattice story_create with checklist/);
assert.match(storyCreateHelp, /lattice story_advance phase=INIT_CHECK/);
assert.doesNotMatch(storyCreateHelp, /(?:^|\n)\s+\d+\.\s+(?:story_create|story_advance)\b/, 'story_create help step list uses lattice-prefixed commands');
assert.doesNotMatch(storyCreateHelp, /use checklist_add\b/, 'story_create help uses lattice checklist_add');

const storyAdvanceHelp = runCli(['story_advance', '--help']);
assert.match(storyAdvanceHelp, /lattice story_review/);
assert.match(storyAdvanceHelp, /lattice story_advance '\{"storyId":"B-a3f7","phase":"DEV"\}'/);
assert.match(storyAdvanceHelp, /Try lattice story_advance/);
assert.doesNotMatch(storyAdvanceHelp, /(?:^|\n)\s+\d+\.\s+(?:story_review|story_advance|understanding_set|decision_set)\b/, 'story_advance help step list uses lattice-prefixed commands');

const storyReconcileHelp = runCli(['story_reconcile', '--help']);
assert.match(storyReconcileHelp, /Dry-run: default-on via --dryRun=true\./);
assert.match(storyReconcileHelp, /true=report only; false=perform repair \(default true\)\./);

const testAutoHelp = runCli(['test_auto', '--help']);
assert.match(testAutoHelp, /Dry-run: optional via --dryRun\./);
assert.match(testAutoHelp, /Real execution may also require --confirm\./);

const hostInstallHelp = runCli(['host_install', '--help']);
assert.match(hostInstallHelp, /Dry-run: always-on\./);
assert.match(hostInstallHelp, /does not execute the side-effect path|no third-party installs are executed/i);

// Registry exposes handlers in-process.
{
  const store = new StoryStore(repoRoot);
  const ctx: HandlerContext = { store, root: repoRoot, scanRoot: join(repoRoot, 'packages', 'main') };
  const registry = createMainRegistry(ctx);
  for (const command of COMMANDS) {
    assert.equal(registry.has(command), true, `registry exposes ${command}`);
  }
}

// Flat commands and space aliases both return parseable JSON.
const hostList = runJson<any>(['host_list', '--format=json']);
assert.equal(hostList.schemaVersion, 'lattice.host_list.v1');
assert.equal(hostList.product.version, LATTICE_CLI_VERSION);
assert.equal(hostList.migration.macAppRequired, false);
assert.equal(hostList.authority.productionDone, false);
assert.equal(hostList.authority.receiptVerified, false);
assertNoProductionOverclaim(hostList, 'host_list');
const desktopFromList = hostList.hosts.find((host: any) => host.id === 'desktop-app');
assert.ok(desktopFromList, 'host_list includes desktop-app projection');
assert.match(desktopFromList.label, /dashboard\/archive/i);
assert.match(desktopFromList.summary, /dashboard\/archive/i);
for (const category of [
  'file-edit',
  'patch-apply',
  'shell/pty',
  'test-execution',
  'browser-automation',
  'evidence-submit',
  'receipt-verify',
  'multimodal-research',
] as const) {
  assert.equal(capabilityByCategory(desktopFromList, category).status, 'unavailable', `desktop-app ${category} is unavailable in Proofbound projection`);
  assert.equal(degradationByCategory(desktopFromList.degradations, category).visible, true, `desktop-app ${category} degradation is visible`);
}
assert.equal(capabilityByCategory(desktopFromList, 'approval').status, 'available', 'desktop-app keeps dashboard approval available');
assert.equal(capabilityByCategory(desktopFromList, 'artifact-display').status, 'available', 'desktop-app keeps artifact display available');
assert.equal(
  degradationByCategory(desktopFromList.degradations, 'evidence-submit').authorityImpact,
  'evidence-local-only',
  'desktop-app evidence submission remains local-only in Proofbound projection',
);
assert.equal(
  degradationByCategory(desktopFromList.degradations, 'receipt-verify').authorityImpact,
  'local-assurance-required',
  'desktop-app receipt verification blocks productionDone in Proofbound projection',
);

const hostListAlias = runJson<any>(['host', 'list', '--format=json']);
assert.equal(hostListAlias.schemaVersion, 'lattice.host_list.v1', 'host list alias works');

const hostProbeAlias = runJson<any>(['lattice', 'host', 'probe', '--host=codex', '--format=json']);
assert.equal(hostProbeAlias.schemaVersion, 'lattice.host_probe.v1');
assert.equal(hostProbeAlias.probe.host, 'codex');
assert.equal(hostProbeAlias.productionDone, false);
assert.equal(hostProbeAlias.receiptVerified, false);
for (const [category, authorityImpact] of [
  ['browser-automation', 'verification-evidence-limited'],
  ['evidence-submit', 'evidence-local-only'],
  ['receipt-verify', 'local-assurance-required'],
] as const) {
  assert.equal(capabilityByCategory(hostProbeAlias.probe.profile, category).status, 'conditional', `codex ${category} remains visible conditional`);
  const degradation = degradationByCategory(hostProbeAlias.probe.degradations, category);
  assert.equal(degradation.visible, true, `codex ${category} degradation is visible`);
  assert.equal(degradation.authorityImpact, authorityImpact, `codex ${category} authority impact is explicit`);
}
assertNoProductionOverclaim(hostProbeAlias, 'lattice host probe');

const hostStatusAlias = runJson<any>(['lattice', 'host', 'status', '--host=claude-code', '--json']);
assert.equal(hostStatusAlias.schemaVersion, 'lattice.host_status.v1');
assert.equal(hostStatusAlias.host, 'claude-code');
assert.equal(hostStatusAlias.overflowReady, true);
assertNoProductionOverclaim(hostStatusAlias, 'lattice host status');

const desktopProbe = runJson<any>(['host_probe', '--host=desktop-app', '--format=json']);
assert.equal(desktopProbe.schemaVersion, 'lattice.host_probe.v1');
assert.equal(desktopProbe.probe.host, 'desktop-app');
assert.match(desktopProbe.probe.profile.summary, /dashboard\/archive/i);
for (const category of ['file-edit', 'test-execution', 'evidence-submit', 'receipt-verify'] as const) {
  assert.equal(capabilityByCategory(desktopProbe.probe.profile, category).status, 'unavailable', `desktop-app probe ${category} is unavailable`);
  assert.equal(degradationByCategory(desktopProbe.probe.degradations, category).visible, true, `desktop-app probe ${category} degradation is visible`);
}
assert.equal(capabilityByCategory(desktopProbe.probe.profile, 'artifact-display').status, 'available', 'desktop-app probe keeps artifact display available');
assert.equal(degradationByCategory(desktopProbe.probe.degradations, 'receipt-verify').authorityImpact, 'local-assurance-required');
assertNoProductionOverclaim(desktopProbe, 'desktop-app host probe');

const install = runJson<any>(['host_install', '--host=desktop-app', '--format=json']);
assert.equal(install.schemaVersion, 'lattice.host_install.v1');
assert.equal(install.dryRun, true);
assert.equal(install.executed, false);
assert.equal(install.thirdPartyInstallsExecuted, false);
assert.match(install.summary, /optional dashboard\/archive/i);
assertNoProductionOverclaim(install, 'host_install');

const configDoctor = runJson<any>(['lattice', 'config', 'doctor', '--format=json']);
assert.equal(configDoctor.schemaVersion, 'lattice.config_doctor.v1');
assert.equal(configDoctor.migration.cliFirst, true);
assert.equal(configDoctor.migration.macAppRequired, false);
// config_doctor's package-bin-aliases check asserts the package exposes only the lattice bin.
assert.ok(
  configDoctor.checks.some((c: any) => c.id === 'package-bin-aliases' && c.ok === true),
  'package-bin-aliases check confirms the package exposes only the lattice bin',
);
assert.equal(configDoctor.versions.expected, LATTICE_CLI_VERSION);
assertNoProductionOverclaim(configDoctor, 'lattice config doctor');

const rollout = runJson<any>(['lattice', 'rollout', 'check', `--projects=${repoRoot}`, '--format=json']);
assert.equal(rollout.schemaVersion, 'lattice.rollout_check.v1');
assert.equal(rollout.readOnly, true);
assert.equal(rollout.macAppRequired, false);
assert.equal(rollout.summary.total, 1);
assert.equal(rollout.projects[0].path, repoRoot);
assert.ok(rollout.projects[0].nextAction.length > 0, 'rollout_check returns actionable nextAction');
for (const probe of rollout.projects[0].probes) {
  assert.equal(probe.readOnly, true, `${probe.id} is read-only`);
  assert.match(probe.command, /^(lattice|filesystem)/, `${probe.id} command uses lattice wording or filesystem stat`);
  for (const forbidden of rollout.safety.forbiddenArgs) {
    assert.ok(!probe.command.includes(forbidden), `rollout_check does not record ${forbidden}`);
  }
}
assert.equal(rollout.safety.forbiddenArgs.includes('--apply'), true);
assert.match(rollout.safety.note, /never runs apply, upgrade, repair, fix/i);
assertNoProductionOverclaim(rollout, 'lattice rollout check');

const conduit = runJson<any>(['conduit_status', '--format=json']);
assert.equal(conduit.schemaVersion, 'lattice.conduit_status.v1');
assert.equal(conduit.runnerProvisioned, false);
assert.equal(conduit.modelRunnerCreated, false);
assert.equal(conduit.productionDone, false);
assert.equal(conduit.receiptVerified, false);
assert.equal(conduit.authorityChanged, false);
assertNoProductionOverclaim(conduit, 'conduit_status');

const conduitExplain = runJson<any>(['lattice', 'conduit', 'explain', '--format=json']);
assert.equal(conduitExplain.schemaVersion, 'lattice.conduit_explain.v1');
assert.ok(conduitExplain.explanation.some((line: string) => /not a model runner/i.test(line)));
assertNoProductionOverclaim(conduitExplain, 'lattice conduit explain');

console.log('✓ lattice CLI migration smoke passed');
