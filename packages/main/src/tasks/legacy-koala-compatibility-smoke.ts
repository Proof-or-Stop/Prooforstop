#!/usr/bin/env node
/**
 * @task B-b95c
 * @checklist CHK-003
 * @title Legacy Koala asset compatibility smoke
 * @type feature
 * @priority high
 * @description
 * Proves existing Koala-named Codex adapter assets remain accepted while
 * Lattice-named assets are preferred when both generations are present.
 * @changes
 * - [CHK-003] Cover legacy Koala manifest/wrapper verification and primary Lattice manifest precedence.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_MD_TEMPLATE,
  KOALA_MD_TEMPLATE,
  renderCodexAdapterManifest,
  renderCodexReadmeTemplate,
  renderCodexWrapperScript,
  renderKoalaBootstrapScript,
} from '../init-assets.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { renderManagedAssetCheck, runManagedAssetCheck } from '../core/managed-assets.js';
import { listRuntimeArtifactIgnorePatterns } from '../core/runtime-artifact-registry.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `koala-${name}-`));
}

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function seedLegacyKoalaCodex(root: string, promptMode: 'legacy-mirror' | 'registry' = 'registry'): void {
  writeText(root, 'KOALA.md', KOALA_MD_TEMPLATE);
  writeText(root, 'AGENTS.md', AGENTS_MD_TEMPLATE);
  writeText(root, 'bin/koala.js', renderKoalaBootstrapScript(packageRoot));
  writeText(root, 'bin/koala-codex.js', renderCodexWrapperScript());
  writeText(root, '.Codex/README.md', renderCodexReadmeTemplate(promptMode === 'registry' ? 'thin' : 'full', 'koala'));
  writeText(root, '.Codex/koala.json', renderCodexAdapterManifest(promptMode === 'registry' ? { promptMode: 'registry' } : {}));
  writeText(root, '.gitignore', `${listRuntimeArtifactIgnorePatterns().join('\n')}\n`);
}

function checkById(result: ReturnType<typeof runCodexAdapterChecks>, id: string) {
  const check = result.checks.find(check => check.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

const legacyRoot = makeRoot('legacy-koala-compat');
try {
  seedLegacyKoalaCodex(legacyRoot, 'registry');
  const managed = runManagedAssetCheck(legacyRoot, { profile: 'codex', assetMode: 'thin' });
  assert.equal(managed.ok, true, renderManagedAssetCheck(managed));
  const verified = runCodexAdapterChecks(legacyRoot, { executeHeartbeats: false });
  assert.equal(verified.ok, true, renderCodexAdapterChecks(verified));
  assert.match(checkById(verified, 'manifest').detail, /\.Codex\/koala\.json/);
  assert.match(checkById(verified, 'local-wrapper').detail, /bin\/koala-codex\.js/);
} finally {
  rmSync(legacyRoot, { recursive: true, force: true });
}

const mixedRoot = makeRoot('legacy-koala-mixed');
try {
  seedLegacyKoalaCodex(mixedRoot, 'registry');
  writeText(mixedRoot, '.Codex/lattice.json', '{\"adapterOwner\":\"wrong\",\"adapterKind\":\"codex\",\"activitySource\":\"codex\"}\n');
  const mixed = runCodexAdapterChecks(mixedRoot, { executeHeartbeats: false });
  assert.equal(mixed.ok, false, 'primary Lattice manifest drift must fail even when legacy Koala manifest is valid');
  assert.equal(checkById(mixed, 'manifest').status, 'fail');
  assert.match(checkById(mixed, 'manifest').detail, /\.Codex\/lattice\.json/);
} finally {
  rmSync(mixedRoot, { recursive: true, force: true });
}

const missingRoot = makeRoot('missing-codex-manifest');
try {
  writeText(missingRoot, 'bin/lattice-codex.js', renderCodexWrapperScript());
  const missing = runCodexAdapterChecks(missingRoot, { executeHeartbeats: false });
  assert.equal(missing.ok, false, 'missing primary and legacy manifests must fail clearly');
  assert.match(checkById(missing, 'manifest').detail, /missing \.Codex\/lattice\.json/);
  assert.equal(checkById(missing, 'manifest').command, 'lattice init --verify-codex');
} finally {
  rmSync(missingRoot, { recursive: true, force: true });
}

console.log('✓ legacy koala compatibility smoke passed');
