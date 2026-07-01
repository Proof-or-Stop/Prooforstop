#!/usr/bin/env node

/**
 * @task B-3b99
 * @checklist CHK-002
 * @title Smoke local assurance authorityImpact degradation mapping
 * @type test
 * @priority high
 * @description
 *   Smoke-backed evidence that the retired authorityImpact:
 *   "none" | "localOnly" | "requiresAuthorityReceipt"; phrase maps to current
 *   local assurance semantics only. The assertions below require local-only
 *   proofAdmissibility, signed-offline-local receipt bundle verification,
 *   authorityImpact=local-assurance-required degradations, and no
 *   productionDone claim from capability discovery.
 * @changes
 *   - [CHK-002] Assert capability discovery cannot manufacture productionDone.
 *   - [CHK-002] Assert receipt-verify degradation uses local-assurance-required instead of requiresAuthorityReceipt.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_CATEGORIES,
  buildCapabilityList,
  buildCapabilityProbe,
  renderCapabilityListText,
  renderCapabilityProbeText,
  type AuthorityImpact,
  type DegradationSeverity,
} from '../core/capabilities.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createMainRegistry } from '../registry.js';

const EXPECTED_HOSTS = [
  'codex',
  'claude-code',
  'antigravity',
  'local-runner',
  'browser',
  'server',
  'desktop-app',
  'unknown/fallback',
] as const;

const AUTHORITY_IMPACTS: readonly AuthorityImpact[] = [
  'none',
  'evidence-local-only',
  'verification-evidence-limited',
  'local-assurance-required',
  'blocks-production-done',
];
const DEGRADATION_SEVERITIES: readonly DegradationSeverity[] = ['info', 'warn', 'block'];

const list = buildCapabilityList();

// Stable host profiles and category coverage.
assert.equal(list.schemaVersion, 'lattice.capability_list.v1');
assert.deepEqual(list.hosts.map(h => h.id), [...EXPECTED_HOSTS]);
assert.deepEqual(list.categories.map(c => c.id), [...CAPABILITY_CATEGORIES]);
for (const host of list.hosts) {
  assert.deepEqual(
    host.capabilities.map(c => c.category),
    [...CAPABILITY_CATEGORIES],
    `${host.id} covers every capability category in canonical order`,
  );
}

// Missing or conditional capabilities are visible degradations, not production claims.
for (const host of list.hosts) {
  const seenIds = new Set<string>();
  for (const degradation of host.degradations) {
    assert.equal(degradation.host, host.id, `${host.id} degradation host matches profile`);
    assert.equal(degradation.visible, true, `${host.id} ${degradation.capability} degradation is visible`);
    assert.ok(degradation.id.length > 0, `${host.id} ${degradation.capability} degradation has id`);
    assert.equal(seenIds.has(degradation.id), false, `${host.id} degradation id ${degradation.id} is unique`);
    seenIds.add(degradation.id);
    assert.ok(
      DEGRADATION_SEVERITIES.includes(degradation.severity),
      `${host.id} ${degradation.capability} degradation has known severity`,
    );
    assert.ok(
      AUTHORITY_IMPACTS.includes(degradation.authorityImpact),
      `${host.id} ${degradation.capability} degradation has known authorityImpact`,
    );
    assert.equal((degradation as unknown as Record<string, unknown>).category, undefined, `${host.id} degradation does not expose legacy category`);
    assert.equal((degradation as unknown as Record<string, unknown>).status, undefined, `${host.id} degradation does not expose legacy status`);
    assert.equal((degradation as unknown as Record<string, unknown>).fatal, undefined, `${host.id} degradation does not expose legacy fatal`);
  }

  for (const capability of host.capabilities) {
    if (capability.status === 'available') continue;
    const degradation = host.degradations.find(d => d.capability === capability.category);
    assert.ok(degradation, `${host.id} ${capability.category} has explicit degradation`);
  }
}

const fallback = list.hosts.find(h => h.id === 'unknown/fallback');
assert.ok(fallback, 'unknown/fallback profile exists');
assert.equal(
  fallback.capabilities.find(c => c.category === 'browser-automation')?.status,
  'unavailable',
  'unknown/fallback marks optional browser automation unavailable',
);

// Handoff / capability discovery cannot manufacture productionDone from local receipt bundles.
assert.equal(list.authorityRules.productionDoneRequiresReceipt, false);
assert.equal(list.authorityRules.receiptCapability, 'receipt-verify');
assert.equal(list.authorityRules.handoffCanManufactureProductionDone, false);
assert.equal(list.authorityRules.proofAdmissibility, 'local-only');
assert.equal(list.authorityRules.receiptBundleVerification, 'signed-offline-local');
assert.equal(list.authorityRules.reviewQuorum, 'local');
assert.equal((list as unknown as Record<string, unknown>).productionDone, undefined);
for (const host of list.hosts) {
  assert.equal((host as unknown as Record<string, unknown>).productionDone, undefined, `${host.id} has no productionDone field`);
  const receipt = host.capabilities.find(c => c.category === 'receipt-verify');
  assert.ok(receipt, `${host.id} has receipt-verify capability row`);
  if (receipt.status !== 'available') {
    const degradation = host.degradations.find(d => d.capability === 'receipt-verify');
    assert.equal(
      degradation?.authorityImpact,
      'local-assurance-required',
      `${host.id} cannot claim productionDone from local receipt-bundle verification`,
    );
    assert.equal(degradation?.severity, 'block', `${host.id} receipt-bundle verification degradation requires local assurance`);
  }
}

// prewrite-guard is included as a capability category.
assert.ok(list.categories.some(c => c.id === 'prewrite-guard'), 'prewrite-guard category exists in list');

// Human output is present and useful.
const text = renderCapabilityListText(list);
assert.match(text, /Proofbound capability profiles/);
assert.match(text, /unknown\/fallback/);
assert.match(text, /authorityImpact=local-assurance-required/);
assert.doesNotMatch(text, /fatal=/);

// Productized single-host probe is a diagnostic projection of the same registry.
const codexProbe = buildCapabilityProbe('codex');
assert.equal(codexProbe.schemaVersion, 'lattice.capability_probe.v1');
assert.equal(codexProbe.host, 'codex');
assert.equal(codexProbe.diagnosticOnly, true);
assert.equal(codexProbe.authorityRules.productionDoneRequiresReceipt, false);
assert.equal(codexProbe.degradations.every(d => d.visible === true), true);
assert.equal((codexProbe as unknown as Record<string, unknown>).productionDone, undefined);
const fallbackProbe = buildCapabilityProbe('not-a-real-host');
assert.equal(fallbackProbe.host, 'unknown/fallback');
assert.equal(fallbackProbe.matchedFallback, true);
assert.equal(fallbackProbe.profile.capabilities.find(c => c.category === 'receipt-verify')?.status, 'unavailable');
const antigravityProbe = buildCapabilityProbe('antigravity');
assert.equal(antigravityProbe.host, 'antigravity');
assert.equal(antigravityProbe.matchedFallback, false);
assert.equal(antigravityProbe.profile.capabilities.find(c => c.category === 'prewrite-guard')?.status, 'conditional');
const agyProbe = buildCapabilityProbe('agy');
assert.equal(agyProbe.host, 'antigravity');
assert.equal(agyProbe.requestedHost, 'agy');
assert.equal(agyProbe.matchedFallback, false, 'agy is a current Antigravity alias, not fallback');
const geminiProbe = buildCapabilityProbe('gemini');
assert.equal(geminiProbe.host, 'gemini');
assert.equal(geminiProbe.matchedFallback, false);
assert.equal(geminiProbe.profile.capabilities.find(c => c.category === 'receipt-verify')?.status, 'conditional');
assert.equal(list.hosts.some(h => h.id === 'gemini'), false, 'Gemini stays out of the current host list');
assert.match(geminiProbe.profile.summary, /deprecated legacy/i);
assert.match(renderCapabilityProbeText(codexProbe), /authorityImpact: diagnostic-only/);

// Registry and CLI schema expose the command.
assert.ok(MAIN_TOOLS.some(tool => tool.name === 'capability_list'), 'MAIN_TOOLS exposes capability_list');
assert.ok(MAIN_TOOLS.some(tool => tool.name === 'capability_probe'), 'MAIN_TOOLS exposes capability_probe');
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-capability-list-registry-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    resetConfigCache();
    const store = new StoryStore(root);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
    const registry = createMainRegistry(ctx);
    assert.equal(registry.has('capability_list'), true, 'registry exposes capability_list handler');
    assert.equal(registry.has('capability_probe'), true, 'registry exposes capability_probe handler');
    const result = registry.get('capability_list')!({ format: 'json' });
    assert.deepEqual((result as typeof list).hosts.map(h => h.id), [...EXPECTED_HOSTS]);
    const probe = registry.get('capability_probe')!({ host: 'claude-code', format: 'json' });
    assert.equal((probe as typeof codexProbe).host, 'claude-code');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Real CLI JSON path: --format=json must produce parseable JSON on stdout.
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-capability-list-cli-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    const here = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(here, '..', 'cli.js');
    const stdout = execFileSync(process.execPath, [cliPath, '--root', root, 'capability_list', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout) as typeof list;
    assert.deepEqual(parsed.hosts.map(h => h.id), [...EXPECTED_HOSTS]);
    assert.equal(parsed.authorityRules.handoffCanManufactureProductionDone, false);
    const probeStdout = execFileSync(process.execPath, [cliPath, '--root', root, 'capability_probe', '--host=browser', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsedProbe = JSON.parse(probeStdout) as typeof codexProbe;
    assert.equal(parsedProbe.host, 'browser');
    assert.equal(parsedProbe.profile.capabilities.find(c => c.category === 'shell/pty')?.status, 'unavailable');
    assert.equal(parsedProbe.degradations.find(d => d.capability === 'receipt-verify')?.authorityImpact, 'local-assurance-required');
    const agyProbeStdout = execFileSync(process.execPath, [cliPath, '--root', root, 'capability_probe', '--host=agy', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsedAgyProbe = JSON.parse(agyProbeStdout) as typeof codexProbe;
    assert.equal(parsedAgyProbe.host, 'antigravity');
    assert.equal(parsedAgyProbe.requestedHost, 'agy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Canonical story schema remains host-neutral: host-private capability details
// belong to capability_list, not story index.json / StoryInfo.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const sourcePath = join(here, '..', '..', 'src', 'core', 'types.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const storyInfo = source.match(/export interface StoryInfo \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(storyInfo, 'StoryInfo interface should be readable from source');
  for (const field of [
    'hostProfile',
    'hostCapabilities',
    'capabilityProfile',
    'capabilityDegradations',
    'codexHost',
    'claudeCodeHost',
    'localRunnerHost',
    'browserHost',
    'serverHost',
    'desktopAppHost',
  ]) {
    assert.doesNotMatch(storyInfo, new RegExp(`\\b${field}\\??:`), `StoryInfo must not include host-private field ${field}`);
  }
}

console.log('✓ capability list smoke passed');
