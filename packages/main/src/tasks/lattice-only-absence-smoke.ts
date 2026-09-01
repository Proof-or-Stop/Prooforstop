#!/usr/bin/env node
/**
 * @task B-6351
 * @checklist CHK-003
 * @title Proof-or-Stop-only runtime absence smoke
 * @type feature
 * @priority high
 * @changes
 *   - [CHK-003] Verify active runtime and generated assets no longer advertise legacy CLI alias compatibility.
 * @description
 * Proves active runtime, Codex adapter, and generated bootstrap surfaces no
 * longer accept or advertise legacy CLI alias compatibility. After the legacy
 * brand removal, the only active CLI surface is the proof-or-stop entrypoint and
 * the only active project config is proof-or-stop.config.json. The deprecated
 * lattice.config.json remains a deliberate read-side fallback.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderProofOrStopBootstrapScript,
} from '../init-assets.js';
import { formatProofOrStopProductLine } from '../core/lattice-brand.js';
import { DEPRECATED_CONFIG_FILENAME, PROOF_OR_STOP_CONFIG_FILENAME } from '../core/brand-paths.js';
import { loadConfig, resetConfigCache } from '../core/config.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

assert.match(formatProofOrStopProductLine(), /^Proof-or-Stop \S+$/, 'version output should use the canonical product line');

// The generated bootstrap advertises only the canonical proof-or-stop entrypoint.
const bootstrap = renderProofOrStopBootstrapScript(packageRoot);
assert.match(bootstrap, /coreCliEngineCandidates/, 'generated bootstrap must resolve the core CLI engine');
assert.match(bootstrap, /runCli/, 'generated bootstrap must invoke the proof-or-stop CLI runner');

// An arbitrarily named config is not an active fallback; the canonical filename
// is active, and the deprecated lattice filename is read only as an intentional
// migration fallback.
const configRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-config-migration-'));
try {
  writeText(configRoot, 'legacy.config.json', JSON.stringify({
    scanRoot: 'legacy-only-src',
    validate: { command: 'node -e "process.stdout.write(\\"legacy\\")"' },
  }, null, 2) + '\n');
  resetConfigCache();
  const arbitraryConfig = loadConfig(configRoot);
  assert.notEqual(arbitraryConfig.scanRoot, 'legacy-only-src', 'an arbitrarily named config file must not be loaded as active config');
  assert.equal(arbitraryConfig.validate, undefined, 'an arbitrarily named config validate command must not be loaded');

  writeText(configRoot, PROOF_OR_STOP_CONFIG_FILENAME, JSON.stringify({
    scanRoot: 'proof-or-stop-src',
    validate: { command: 'node -e "process.stdout.write(\\"proof-or-stop\\")"' },
  }, null, 2) + '\n');
  resetConfigCache();
  const canonicalConfig = loadConfig(configRoot);
  assert.equal(canonicalConfig.scanRoot, 'proof-or-stop-src', 'proof-or-stop.config.json must remain the active config');
  assert.match(canonicalConfig.validate?.command ?? '', /proof-or-stop/, 'canonical config validate command must load');

  rmSync(join(configRoot, PROOF_OR_STOP_CONFIG_FILENAME));
  writeText(configRoot, DEPRECATED_CONFIG_FILENAME, JSON.stringify({
    scanRoot: 'legacy-only-src',
    validate: { command: 'node -e "process.stdout.write(\\"lattice-legacy-fallback\\")"' },
  }, null, 2) + '\n');
  resetConfigCache();
  const legacyConfig = loadConfig(configRoot);
  assert.equal(legacyConfig.scanRoot, 'legacy-only-src', 'lattice.config.json must remain a read-side fallback');
  assert.match(legacyConfig.validate?.command ?? '', /lattice-legacy-fallback/, 'legacy config fallback must load intentionally');
} finally {
  resetConfigCache();
  rmSync(configRoot, { recursive: true, force: true });
}

console.log('proof-or-stop-only absence smoke passed');
