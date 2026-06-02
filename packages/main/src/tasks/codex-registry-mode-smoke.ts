#!/usr/bin/env node
/**
 * @task B-9b76
 * @checklist CHK-003
 * @title Codex registry-mode adapter checks
 * @type feature
 * @priority high
 * @description
 * Verifies that verify_codex keeps legacy mirror mode strict while accepting
 * registry-backed thin prompt assets without .Codex/agents.
 * @changes
 * - [CHK-003] Cover legacy mirror, registry thin, registry drift, and tampered registry hash.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderCodexAdapterManifest,
  renderCodexAgentContent,
  renderCodexWrapperScript,
  renderKoalaBootstrapScript,
} from '../init-assets.js';
import { runCodexAdapterChecks, renderCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { readPromptRegistry } from '../core/prompt-registry.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `koala-${name}-`));
  writeText(root, 'bin/koala.js', renderKoalaBootstrapScript(packageRoot));
  writeText(root, 'bin/koala-codex.js', renderCodexWrapperScript());
  return root;
}

function seedLegacyPrompts(root: string): void {
  const registry = readPromptRegistry();
  for (const entry of registry.agents) {
    const source = readFileSync(entry.sourcePath, 'utf8');
    writeText(root, `.claude/agents/${entry.file}`, source);
    writeText(root, `.Codex/agents/${entry.file}`, renderCodexAgentContent(source));
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

const legacyRoot = makeRoot('codex-legacy');
try {
  writeText(legacyRoot, '.Codex/koala.json', renderCodexAdapterManifest());
  seedLegacyPrompts(legacyRoot);
  const legacy = runCodexAdapterChecks(legacyRoot, { executeHeartbeats: false });
  assertOk(legacy);
  assert.equal(checkById(legacy, 'manifest').status, 'pass');
  assert.equal(checkById(legacy, 'agents-mirror').status, 'pass');
  assert.equal(legacy.checks.some(check => check.id === 'prompt-registry'), false);
} finally {
  rmSync(legacyRoot, { recursive: true, force: true });
}

const thinRoot = makeRoot('codex-thin');
try {
  writeText(thinRoot, '.Codex/koala.json', renderCodexAdapterManifest({ promptMode: 'registry' }));
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
  const manifest = JSON.parse(renderCodexAdapterManifest({ promptMode: 'registry' }));
  manifest.recommendedEntrypoints[0].command = 'node bin/changed.js';
  writeText(driftRoot, '.Codex/koala.json', `${JSON.stringify(manifest, null, 2)}\n`);
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
  const manifest = JSON.parse(renderCodexAdapterManifest({ promptMode: 'registry' }));
  manifest.promptRegistry.materialHash = 'tampered';
  writeText(tamperedRoot, '.Codex/koala.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const tampered = runCodexAdapterChecks(tamperedRoot, { executeHeartbeats: false });
  assert.equal(tampered.ok, false, 'tampered registry manifest must be a hard failure');
  assert.equal(checkById(tampered, 'manifest').status, 'fail');
  assert.match(checkById(tampered, 'manifest').detail, /promptRegistry mismatch/);
  assert.equal(checkById(tampered, 'prompt-registry').status, 'pass');
} finally {
  rmSync(tamperedRoot, { recursive: true, force: true });
}

console.log('✓ codex registry mode smoke passed');
