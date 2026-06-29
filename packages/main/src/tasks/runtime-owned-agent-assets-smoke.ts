#!/usr/bin/env node

/**
 * @task B-5155
 * @checklist CHK-002
 * @title Map runtime-owned prompt asset resolution to existing config/asset coverage
 * @type chore
 * @priority high
 * @description
 *   The runtime-owned agent asset path verifies local prompt registry
 *   resolution across absent, matching, stale, full-asset, and debug-override
 *   cases.
 *   This smoke only covers prompt asset resolution and the local
 *   Local-assurance boundary; it does not claim release completion.
 * @changes
 *   - Keep the anchor on prompt asset resolution only and remove the false
 *     `requirementsDir` coverage claim.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentAssetResolution } from '../core/agent-asset-resolution.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { buildRolloutCheck } from '../core/rollout-check.js';
import { readPromptRegistry, renderPromptEntryForHost } from '../core/prompt-registry.js';
import { renderLatticeCodexAdapterManifest } from '../init-assets.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `lattice-${name}-`));
}

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function seedMatchingPrompts(root: string): void {
  const registry = readPromptRegistry();
  for (const entry of registry.agents) {
    writeText(root, `.claude/agents/${entry.file}`, renderPromptEntryForHost(entry, 'claude'));
    writeText(root, `.lattice-codex/agents/${entry.file}`, renderPromptEntryForHost(entry, 'codex'));
  }
}

function countApproximateTokens(): number {
  const registry = readPromptRegistry();
  let bytes = 0;
  for (const entry of registry.agents) {
    bytes += Buffer.byteLength(renderPromptEntryForHost(entry, 'claude'), 'utf8');
    bytes += Buffer.byteLength(renderPromptEntryForHost(entry, 'codex'), 'utf8');
  }
  return Math.ceil(bytes / 4);
}

function assertNoAuthorityCompletionFields(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of ['receiptVerified', 'productionDone', 'authorityDone', 'fullAuthorityDone']) {
    assert.equal(serialized.includes(forbidden), false, `agent asset resolution must not report ${forbidden}`);
  }
}

const registry = readPromptRegistry();

const absentRoot = makeRoot('runtime-owned-absent');
try {
  const resolution = resolveAgentAssetResolution(absentRoot);
  assert.equal(resolution.mode, 'runtime-owned');
  assert.equal(resolution.promptRegistryHash, registry.materialHash);
  assert.deepEqual(resolution.projectPromptAssets.map(asset => asset.status), ['absent', 'absent']);
  assert.equal(resolution.authorityBoundary.kind, 'localNonAuthorityAudit');
  assertNoAuthorityCompletionFields(resolution);

  const codex = runCodexAdapterChecks(absentRoot, { executeHeartbeats: false });
  assert.equal(codex.checks.find(check => check.id === 'agent-asset-resolution')?.status, 'pass');
  assert.equal(codex.checks.find(check => check.id === 'manifest')?.status, 'pass');
  assert.match(codex.checks.find(check => check.id === 'manifest')?.detail ?? '', /runtime-owned default/);

  const rollout = buildRolloutCheck({ root: absentRoot, projects: [absentRoot] });
  const rolloutProbe = rollout.projects[0]?.probes.find(probe => probe.id === 'agent_asset_resolution');
  assert.equal(rolloutProbe?.status, 'pass');
  assert.match(rolloutProbe?.detail ?? '', /mode=runtime-owned/);
} finally {
  rmSync(absentRoot, { recursive: true, force: true });
}

const matchingRoot = makeRoot('runtime-owned-matching');
try {
  seedMatchingPrompts(matchingRoot);
  const resolution = resolveAgentAssetResolution(matchingRoot);
  assert.equal(resolution.mode, 'full-asset');
  assert.equal(resolution.projectPromptAssets.some(asset => asset.status === 'matches-runtime'), true);
  assert.equal(resolution.projectPromptAssets.some(asset => asset.status === 'stale' || asset.status === 'override'), false);
  assertNoAuthorityCompletionFields(resolution);
} finally {
  rmSync(matchingRoot, { recursive: true, force: true });
}

const staleRoot = makeRoot('runtime-owned-stale');
try {
  seedMatchingPrompts(staleRoot);
  const staleRelPath = `.claude/agents/${registry.agents[0]?.file}`;
  const staleContent = `${readFileSync(join(staleRoot, staleRelPath), 'utf8')}\n# local stale edit\n`;
  writeText(staleRoot, staleRelPath, staleContent);

  const before = readFileSync(join(staleRoot, staleRelPath), 'utf8');
  const resolution = resolveAgentAssetResolution(staleRoot);
  const afterResolution = readFileSync(join(staleRoot, staleRelPath), 'utf8');
  const rollout = buildRolloutCheck({ root: staleRoot, projects: [staleRoot] });
  const afterRollout = readFileSync(join(staleRoot, staleRelPath), 'utf8');

  assert.equal(resolution.projectPromptAssets.some(asset => asset.path === staleRelPath && asset.status === 'stale'), true);
  assert.equal(afterResolution, before, 'resolution must not rewrite stale prompt assets');
  assert.equal(afterRollout, before, 'rollout diagnostic must not rewrite stale prompt assets');
  assert.equal(rollout.projects[0]?.probes.find(probe => probe.id === 'agent_asset_resolution')?.status, 'warn');
  assertNoAuthorityCompletionFields(resolution);
} finally {
  rmSync(staleRoot, { recursive: true, force: true });
}

const explicitFullRoot = makeRoot('runtime-owned-explicit-full');
try {
  writeText(explicitFullRoot, '.lattice-codex/lattice.json', renderLatticeCodexAdapterManifest());
  seedMatchingPrompts(explicitFullRoot);
  const resolution = resolveAgentAssetResolution(explicitFullRoot);
  assert.equal(resolution.mode, 'full-asset');
  assert.equal(resolution.warnings.some(warning => warning.includes('explicit full-asset')), true);
  assertNoAuthorityCompletionFields(resolution);
} finally {
  rmSync(explicitFullRoot, { recursive: true, force: true });
}

const debugOverrideRoot = makeRoot('runtime-owned-debug-override');
try {
  writeText(debugOverrideRoot, '.lattice/lattice.json', JSON.stringify({ agentAssetMode: 'debug-override' }, null, 2));
  writeText(debugOverrideRoot, '.claude/agents/local.md', '# local debug prompt\n');
  const resolution = resolveAgentAssetResolution(debugOverrideRoot);
  assert.equal(resolution.mode, 'debug-override');
  assert.equal(resolution.projectPromptAssets.some(asset => asset.status === 'override'), true);
  assertNoAuthorityCompletionFields(resolution);
} finally {
  rmSync(debugOverrideRoot, { recursive: true, force: true });
}

console.log(
  `PASS runtime-owned-agent-assets-smoke promptRegistryHash=${registry.materialHash} ` +
  `approximateTokens=${countApproximateTokens()} providerBillingTokens=unavailable packageRoot=${packageRoot}`,
);
