#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_CATEGORIES,
  buildCapabilityList,
  renderCapabilityListText,
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
  'blocks-production-done',
];
const DEGRADATION_SEVERITIES: readonly DegradationSeverity[] = ['info', 'warn', 'block'];

const list = buildCapabilityList();

// Stable host profiles and category coverage.
assert.equal(list.schemaVersion, 'koala.capability_list.v1');
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

// Handoff / capability discovery cannot manufacture productionDone without a receipt.
assert.equal(list.authorityRules.productionDoneRequiresReceipt, true);
assert.equal(list.authorityRules.receiptCapability, 'receipt-verify');
assert.equal(list.authorityRules.handoffCanManufactureProductionDone, false);
assert.equal((list as unknown as Record<string, unknown>).productionDone, undefined);
for (const host of list.hosts) {
  assert.equal((host as unknown as Record<string, unknown>).productionDone, undefined, `${host.id} has no productionDone field`);
  const receipt = host.capabilities.find(c => c.category === 'receipt-verify');
  assert.ok(receipt, `${host.id} has receipt-verify capability row`);
  if (receipt.status !== 'available') {
    const degradation = host.degradations.find(d => d.capability === 'receipt-verify');
    assert.equal(
      degradation?.authorityImpact,
      'blocks-production-done',
      `${host.id} cannot claim productionDone without receipt verification`,
    );
    assert.equal(degradation?.severity, 'block', `${host.id} receipt verification degradation blocks productionDone`);
  }
}

// Human output is present and useful.
const text = renderCapabilityListText(list);
assert.match(text, /Koala capability profiles/);
assert.match(text, /unknown\/fallback/);
assert.match(text, /authorityImpact=blocks-production-done/);
assert.doesNotMatch(text, /fatal=/);

// Registry and CLI schema expose the command.
assert.ok(MAIN_TOOLS.some(tool => tool.name === 'capability_list'), 'MAIN_TOOLS exposes capability_list');
{
  const root = mkdtempSync(join(tmpdir(), 'koala-capability-list-registry-'));
  try {
    writeFileSync(join(root, 'koala.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    resetConfigCache();
    const store = new StoryStore(root);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
    const registry = createMainRegistry(ctx);
    assert.equal(registry.has('capability_list'), true, 'registry exposes capability_list handler');
    const result = registry.get('capability_list')!({ format: 'json' });
    assert.deepEqual((result as typeof list).hosts.map(h => h.id), [...EXPECTED_HOSTS]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Real CLI JSON path: --format=json must produce parseable JSON on stdout.
{
  const root = mkdtempSync(join(tmpdir(), 'koala-capability-list-cli-'));
  try {
    writeFileSync(join(root, 'koala.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
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
