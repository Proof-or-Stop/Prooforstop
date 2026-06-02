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
  'host_install',
  'lattice_config_doctor',
  'authority_status',
  'conduit_status',
  'conduit_explain',
] as const;

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runJson<T>(args: string[]): T {
  return JSON.parse(runCli(args)) as T;
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

// Product identity and package entrypoints.
assert.match(runCli(['--version']), new RegExp(`Lattice CLI ${LATTICE_CLI_VERSION}`));
assert.match(runCli(['version']), /legacy alias: koala/);
const rootPackage = readJson(join(repoRoot, 'package.json'));
const mainPackage = readJson(join(repoRoot, 'packages', 'main', 'package.json'));
assert.equal(rootPackage.version, LATTICE_CLI_VERSION, 'root package version is 0.3.5');
assert.equal(mainPackage.version, LATTICE_CLI_VERSION, 'packages/main version is 0.3.5');
assert.equal(mainPackage.bin.lattice, 'dist/cli.js', 'lattice package bin points at CLI');
assert.equal(mainPackage.bin.koala, 'dist/cli.js', 'legacy koala package bin remains');

// Help exposes first-class Lattice identity and the new command set.
const help = runCli(['help']);
assert.match(help, /Lattice CLI 0\.3\.5/);
assert.match(help, /Primary entrypoint:\s+lattice/);
for (const command of COMMANDS) {
  assert.match(help, new RegExp(command), `help exposes ${command}`);
  assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `MAIN_TOOLS exposes ${command}`);
  assert.equal(isCommandAllowed(command, 'DEV'), true, `${command} is allowed during active DEV`);
  assert.equal(getCommandLifecyclePolicy(command)?.ownershipClass, 'readOnly', `${command} is read-only`);
}

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

const hostListAlias = runJson<any>(['host', 'list', '--format=json']);
assert.equal(hostListAlias.schemaVersion, 'lattice.host_list.v1', 'host list alias works');

const hostProbeAlias = runJson<any>(['lattice', 'host', 'probe', '--host=codex', '--format=json']);
assert.equal(hostProbeAlias.schemaVersion, 'lattice.host_probe.v1');
assert.equal(hostProbeAlias.probe.host, 'codex');
assert.equal(hostProbeAlias.productionDone, false);
assert.equal(hostProbeAlias.receiptVerified, false);
assertNoProductionOverclaim(hostProbeAlias, 'lattice host probe');

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
assert.equal(configDoctor.migration.legacyKoalaAliasPreserved, true);
assert.equal(configDoctor.versions.expected, LATTICE_CLI_VERSION);
assertNoProductionOverclaim(configDoctor, 'lattice config doctor');

const authority = runJson<any>(['lattice', 'authority', 'status', '--format=json']);
assert.equal(authority.schemaVersion, 'lattice.authority_status.v1');
assert.equal(authority.receiptVerified, false);
assert.equal(authority.productionDone, false);
assert.equal(authority.canClaimProductionDone, false);
assert.match(authority.note, /no receipt is verified/i);
assertNoProductionOverclaim(authority, 'lattice authority status');

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

