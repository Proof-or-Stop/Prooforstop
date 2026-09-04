#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { isCommandAllowed } from '../core/config.js';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import { PROOF_OR_STOP_CLI_VERSION, PROOF_OR_STOP_PRODUCT_NAME } from '../core/proof-or-stop-brand.js';
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
  'proof_or_stop_config_doctor',
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
// B-cdf6 CHK-002 / B-cc10 CHK-006: the product name is Proof-or-Stop and the
// published package exposes only the canonical proof-or-stop bin.
assert.match(runCli(['--version']), new RegExp(`${PROOF_OR_STOP_PRODUCT_NAME} ${PROOF_OR_STOP_CLI_VERSION}`));
assert.match(runCli(['version']), new RegExp(PROOF_OR_STOP_PRODUCT_NAME));
const rootPackage = readJson(join(repoRoot, 'package.json'));
const mainPackage = readJson(join(repoRoot, 'packages', 'main', 'package.json'));
assert.equal(rootPackage.version, PROOF_OR_STOP_CLI_VERSION, `root package version is ${PROOF_OR_STOP_CLI_VERSION}`);
assert.equal(mainPackage.version, PROOF_OR_STOP_CLI_VERSION, `packages/main version is ${PROOF_OR_STOP_CLI_VERSION}`);
assert.equal(mainPackage.bin['proof-or-stop'], 'dist/cli.js', 'canonical proof-or-stop bin points at CLI');
assert.deepEqual(Object.keys(mainPackage.bin), ['proof-or-stop'], 'package bin map is canonical-only');

// Help exposes first-class Proof-or-Stop identity and the new command set.
const help = runCli(['help']);
assert.match(help, new RegExp(`${PROOF_OR_STOP_PRODUCT_NAME} ${PROOF_OR_STOP_CLI_VERSION.replace(/\./g, '\\.')}`));
assert.match(help, /(?:^|\n)\s+Entrypoint:\s+proof-or-stop/);
for (const command of COMMANDS) {
  assert.match(help, new RegExp(command), `help exposes ${command}`);
  assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `MAIN_TOOLS exposes ${command}`);
  assert.equal(isCommandAllowed(command, 'DEV'), true, `${command} is allowed during active DEV`);
  assert.equal(getCommandLifecyclePolicy(command)?.ownershipClass, 'readOnly', `${command} is read-only`);
}
assert.doesNotMatch(help, /(?:^|\s)(?:lattice|lattice-codex)\s+\S+/, 'help does not teach retired bin invocations');

const storyCreateHelp = runCli(['story_create', '--help']);
// B-cdf6 (F-030): help examples must teach the canonical bin and must not
// regress to the deprecated bin.
assert.match(storyCreateHelp, /proof-or-stop story_create with checklist/);
assert.doesNotMatch(storyCreateHelp, /proof-or-stop story_create with checklist/);
assert.match(storyCreateHelp, /proof-or-stop story_advance phase=INIT_CHECK/);
assert.doesNotMatch(storyCreateHelp, /proof-or-stop story_advance phase=INIT_CHECK/);
assert.doesNotMatch(storyCreateHelp, /(?:^|\n)\s+\d+\.\s+(?:story_create|story_advance)\b/, 'story_create help step list uses proof-or-stop-prefixed commands');
assert.doesNotMatch(storyCreateHelp, /use checklist_add\b/, 'story_create help uses proof-or-stop checklist_add');

const storyAdvanceHelp = runCli(['story_advance', '--help']);
assert.match(storyAdvanceHelp, /proof-or-stop story_review/);
assert.doesNotMatch(storyAdvanceHelp, /proof-or-stop story_review/);
assert.match(storyAdvanceHelp, /proof-or-stop story_advance '\{"storyId":"B-a3f7","phase":"DEV"\}'/);
assert.doesNotMatch(storyAdvanceHelp, /proof-or-stop story_advance '\{"storyId":"B-a3f7","phase":"DEV"\}'/);
assert.match(storyAdvanceHelp, /Try proof-or-stop story_advance/);
assert.doesNotMatch(storyAdvanceHelp, /(?:^|\n)\s+\d+\.\s+(?:story_review|story_advance|understanding_set|decision_set)\b/, 'story_advance help step list uses proof-or-stop-prefixed commands');

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

// Flat commands and supported command aliases both return parseable JSON.
const hostList = runJson<any>(['host_list', '--format=json']);
assert.equal(hostList.schemaVersion, 'lattice.host_list.v1');
assert.equal(hostList.product.version, PROOF_OR_STOP_CLI_VERSION);
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
  assert.equal(capabilityByCategory(desktopFromList, category).status, 'unavailable', `desktop-app ${category} is unavailable in Proof-or-Stop projection`);
  assert.equal(degradationByCategory(desktopFromList.degradations, category).visible, true, `desktop-app ${category} degradation is visible`);
}
assert.equal(capabilityByCategory(desktopFromList, 'approval').status, 'available', 'desktop-app keeps dashboard approval available');
assert.equal(capabilityByCategory(desktopFromList, 'artifact-display').status, 'available', 'desktop-app keeps artifact display available');
assert.equal(
  degradationByCategory(desktopFromList.degradations, 'evidence-submit').authorityImpact,
  'evidence-local-only',
  'desktop-app evidence submission remains local-only in Proof-or-Stop projection',
);
assert.equal(
  degradationByCategory(desktopFromList.degradations, 'receipt-verify').authorityImpact,
  'local-assurance-required',
  'desktop-app receipt verification blocks productionDone in Proof-or-Stop projection',
);

const hostListAlias = runJson<any>(['host', 'list', '--format=json']);
assert.equal(hostListAlias.schemaVersion, 'lattice.host_list.v1', 'host list alias works');

const hostProbe = runJson<any>(['host_probe', '--host=codex', '--format=json']);
assert.equal(hostProbe.schemaVersion, 'lattice.host_probe.v1');
assert.equal(hostProbe.probe.host, 'codex');
assert.equal(hostProbe.productionDone, false);
assert.equal(hostProbe.receiptVerified, false);
for (const [category, authorityImpact] of [
  ['browser-automation', 'verification-evidence-limited'],
  ['evidence-submit', 'evidence-local-only'],
  ['receipt-verify', 'local-assurance-required'],
] as const) {
  assert.equal(capabilityByCategory(hostProbe.probe.profile, category).status, 'conditional', `codex ${category} remains visible conditional`);
  const degradation = degradationByCategory(hostProbe.probe.degradations, category);
  assert.equal(degradation.visible, true, `codex ${category} degradation is visible`);
  assert.equal(degradation.authorityImpact, authorityImpact, `codex ${category} authority impact is explicit`);
}
assertNoProductionOverclaim(hostProbe, 'host_probe');

const hostStatus = runJson<any>(['host_status', '--host=claude-code', '--json']);
assert.equal(hostStatus.schemaVersion, 'lattice.host_status.v1');
assert.equal(hostStatus.host, 'claude-code');
assert.equal(hostStatus.overflowReady, true);
assertNoProductionOverclaim(hostStatus, 'host_status');

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

const configDoctor = runJson<any>(['lattice_config_doctor', '--format=json']);
assert.equal(configDoctor.schemaVersion, 'lattice.config_doctor.v1');
assert.equal(configDoctor.migration.cliFirst, true);
assert.equal(configDoctor.migration.macAppRequired, false);
// B-cdf6:F-046 / B-cc10:F-196 — the package-bin check must protect the
// canonical-only package map after the retired alias removal.
assert.ok(
  configDoctor.checks.some((c: any) => c.id === 'package-bin-aliases' && c.ok === true),
  'package-bin-aliases check confirms the package exposes only proof-or-stop',
);
assert.equal(configDoctor.versions.expected, PROOF_OR_STOP_CLI_VERSION);
assertNoProductionOverclaim(configDoctor, 'lattice_config_doctor');

const rollout = runJson<any>(['rollout_check', `--projects=${repoRoot}`, '--format=json']);
assert.equal(rollout.schemaVersion, 'lattice.rollout_check.v1');
assert.equal(rollout.readOnly, true);
assert.equal(rollout.macAppRequired, false);
assert.equal(rollout.summary.total, 1);
assert.equal(rollout.projects[0].path, repoRoot);
assert.ok(rollout.projects[0].nextAction.length > 0, 'rollout_check returns actionable nextAction');
for (const probe of rollout.projects[0].probes) {
  assert.equal(probe.readOnly, true, `${probe.id} is read-only`);
  assert.match(probe.command, /^(proof-or-stop|filesystem)/, `${probe.id} command uses canonical wording or filesystem stat`);
  for (const forbidden of rollout.safety.forbiddenArgs) {
    assert.ok(!probe.command.includes(forbidden), `rollout_check does not record ${forbidden}`);
  }
}
assert.equal(rollout.safety.forbiddenArgs.includes('--apply'), true);
assert.match(rollout.safety.note, /never runs apply, upgrade, repair, fix/i);
assertNoProductionOverclaim(rollout, 'rollout_check');

const conduit = runJson<any>(['conduit_status', '--format=json']);
assert.equal(conduit.schemaVersion, 'lattice.conduit_status.v1');
assert.equal(conduit.runnerProvisioned, false);
assert.equal(conduit.modelRunnerCreated, false);
assert.equal(conduit.productionDone, false);
assert.equal(conduit.receiptVerified, false);
assert.equal(conduit.authorityChanged, false);
assertNoProductionOverclaim(conduit, 'conduit_status');

const conduitExplain = runJson<any>(['conduit_explain', '--format=json']);
assert.equal(conduitExplain.schemaVersion, 'lattice.conduit_explain.v1');
assert.ok(conduitExplain.explanation.some((line: string) => /not a model runner/i.test(line)));
assertNoProductionOverclaim(conduitExplain, 'conduit_explain');

console.log('✓ proof-or-stop CLI cutover smoke passed');
