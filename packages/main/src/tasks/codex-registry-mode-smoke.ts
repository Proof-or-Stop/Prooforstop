#!/usr/bin/env node
/**
 * @task B-9b76
 * @checklist CHK-003
 * @title Codex registry-mode adapter checks
 * @type feature
 * @priority high
 * @description
 * Verifies that verify_codex keeps lattice mirror mode strict while accepting
 * registry-backed thin prompt assets without .lattice-codex/agents, and rejects
 * legacy-only Koala adapter assets as an active runtime path.
 * @changes
 * - [CHK-003] Cover lattice mirror, registry thin, registry drift, tampered registry hash,
 *   and legacy-only adapter rejection.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderCodexAgentContent,
  renderLatticeBootstrapScript,
  renderLatticeCodexAdapterManifest,
  renderLatticeCodexWrapperScript,
} from '../init-assets.js';
import { runCodexAdapterChecks, renderCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { readPromptRegistry } from '../core/prompt-registry.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(packageRoot, '..', '..');

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `lattice-${name}-`));
  writeText(root, 'bin/lattice.js', renderLatticeBootstrapScript(packageRoot));
  writeText(root, 'bin/lattice-codex.js', renderLatticeCodexWrapperScript());
  seedCodexNativeHooks(root);
  return root;
}

function seedCodexNativeHooks(root: string): void {
  for (const relPath of ['.codex/hooks.json', '.codex/hooks/lattice-scope-pretool.cjs']) {
    writeText(root, relPath, readFileSync(join(repoRoot, relPath), 'utf8'));
  }
}

function seedLegacyPrompts(root: string): void {
  const registry = readPromptRegistry();
  for (const entry of registry.agents) {
    const source = readFileSync(entry.sourcePath, 'utf8');
    writeText(root, `.claude/agents/${entry.file}`, source);
    writeText(root, `.lattice-codex/agents/${entry.file}`, renderCodexAgentContent(source));
  }
}

function checkById(result: ReturnType<typeof runCodexAdapterChecks>, id: string) {
  const check = result.checks.find(check => check.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

function assertOk(result: ReturnType<typeof runCodexAdapterChecks>): void {
  assert.equal(result.ok, true, renderCodexAdapterChecks(result));
}

const mirrorRoot = makeRoot('codex-mirror');
try {
  writeText(mirrorRoot, '.lattice-codex/lattice.json', renderLatticeCodexAdapterManifest());
  seedLegacyPrompts(mirrorRoot);
  const mirror = runCodexAdapterChecks(mirrorRoot, { executeHeartbeats: false });
  assertOk(mirror);
  assert.equal(checkById(mirror, 'manifest').status, 'pass');
  assert.equal(checkById(mirror, 'agents-mirror').status, 'pass');
  assert.equal(mirror.checks.some(check => check.id === 'prompt-registry'), false);
} finally {
  rmSync(mirrorRoot, { recursive: true, force: true });
}

const legacyOnlyRoot = mkdtempSync(join(tmpdir(), 'lattice-codex-legacy-only-'));
try {
  writeText(legacyOnlyRoot, '.lattice-codex/koala.json', renderLatticeCodexAdapterManifest());
  writeText(legacyOnlyRoot, 'bin/koala.js', renderLatticeBootstrapScript(packageRoot));
  writeText(legacyOnlyRoot, 'bin/koala-codex.js', renderLatticeCodexWrapperScript());
  seedCodexNativeHooks(legacyOnlyRoot);
  seedLegacyPrompts(legacyOnlyRoot);
  const legacyOnly = runCodexAdapterChecks(legacyOnlyRoot, { executeHeartbeats: false });
  assert.equal(legacyOnly.ok, false, 'legacy-only koala adapter assets must not satisfy verify_codex');
  assert.equal(checkById(legacyOnly, 'manifest').status, 'fail');
  assert.equal(checkById(legacyOnly, 'local-wrapper').status, 'fail');
} finally {
  rmSync(legacyOnlyRoot, { recursive: true, force: true });
}

const thinRoot = makeRoot('codex-thin');
try {
  writeText(thinRoot, '.lattice-codex/lattice.json', renderLatticeCodexAdapterManifest({ promptMode: 'registry' }));
  const thin = runCodexAdapterChecks(thinRoot, { executeHeartbeats: false });
  assertOk(thin);
  assert.equal(checkById(thin, 'manifest').status, 'pass');
  assert.equal(checkById(thin, 'prompt-registry').status, 'pass');
  assert.equal(thin.checks.some(check => check.id === 'agents-mirror'), false);
} finally {
  rmSync(thinRoot, { recursive: true, force: true });
}

const driftRoot = makeRoot('codex-registry-drift');
try {
  const manifest = JSON.parse(renderLatticeCodexAdapterManifest({ promptMode: 'registry' }));
  manifest.recommendedEntrypoints[0].command = 'node bin/changed.js';
  writeText(driftRoot, '.lattice-codex/lattice.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const drift = runCodexAdapterChecks(driftRoot, { executeHeartbeats: false });
  assert.equal(drift.ok, false, 'registry manifest static drift must be a hard failure');
  assert.equal(checkById(drift, 'manifest').status, 'fail');
  assert.match(checkById(drift, 'manifest').detail, /registry template/);
  assert.equal(checkById(drift, 'prompt-registry').status, 'pass');
} finally {
  rmSync(driftRoot, { recursive: true, force: true });
}

const tamperedRoot = makeRoot('codex-tampered');
try {
  const manifest = JSON.parse(renderLatticeCodexAdapterManifest({ promptMode: 'registry' }));
  manifest.promptRegistry.materialHash = 'tampered';
  writeText(tamperedRoot, '.lattice-codex/lattice.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const tampered = runCodexAdapterChecks(tamperedRoot, { executeHeartbeats: false });
  assert.equal(tampered.ok, false, 'tampered registry manifest must be a hard failure');
  assert.equal(checkById(tampered, 'manifest').status, 'fail');
  assert.match(checkById(tampered, 'manifest').detail, /promptRegistry mismatch/);
  assert.equal(checkById(tampered, 'prompt-registry').status, 'pass');
} finally {
  rmSync(tamperedRoot, { recursive: true, force: true });
}

console.log('✓ codex registry mode smoke passed');
