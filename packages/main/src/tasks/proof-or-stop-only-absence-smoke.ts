#!/usr/bin/env node
/**
 * @task B-6351
 * @checklist CHK-003
 * @title Lattice-only runtime absence smoke
 * @type feature
 * @priority high
 * @changes
 *   - [CHK-003] Verify active runtime and generated assets no longer advertise legacy CLI alias compatibility.
 * @description
 * Proves active runtime, Codex adapter, and generated bootstrap surfaces no
 * longer accept or advertise legacy CLI alias compatibility. After the legacy
 * brand removal, the only active CLI surface is the proof-or-stop entrypoint and the
 * only active project config is lattice.config.json.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderProofOrStopBootstrapScript,
} from '../init-assets.js';
import { formatProofOrStopProductLine, formatLatticeVersionLine } from '../core/lattice-brand.js';
import { loadConfig, resetConfigCache } from '../core/config.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

assert.equal(formatLatticeVersionLine(), formatProofOrStopProductLine(), 'version output should be exactly the product line');

// The generated bootstrap advertises only the canonical proof-or-stop entrypoint.
const bootstrap = renderProofOrStopBootstrapScript(packageRoot);
assert.match(bootstrap, /coreCliEngineCandidates/, 'generated bootstrap must resolve the core CLI engine');
assert.match(bootstrap, /runCli/, 'generated bootstrap must invoke the lattice CLI runner');

// Non-proof-or-stop project config is not an active fallback; only lattice.config.json
// is loaded. (No-compat: an arbitrarily-named legacy config is never read.)
const legacyConfigRoot = mkdtempSync(join(tmpdir(), 'lattice-config-legacy-absent-'));
try {
  writeText(legacyConfigRoot, 'legacy.config.json', JSON.stringify({
    scanRoot: 'legacy-only-src',
    validate: { command: 'node -e "process.stdout.write(\\"legacy\\")"' },
  }, null, 2) + '\n');
  resetConfigCache();
  const legacyOnlyConfig = loadConfig(legacyConfigRoot);
  assert.notEqual(legacyOnlyConfig.scanRoot, 'legacy-only-src', 'a non-proof-or-stop config file must not be loaded as active config');
  assert.equal(legacyOnlyConfig.validate, undefined, 'a non-proof-or-stop config file validate commands must not be loaded');

  writeText(legacyConfigRoot, 'lattice.config.json', JSON.stringify({
    scanRoot: 'lattice-src',
    validate: { command: 'node -e "process.stdout.write(\\"lattice\\")"' },
  }, null, 2) + '\n');
  resetConfigCache();
  const latticeConfig = loadConfig(legacyConfigRoot);
  assert.equal(latticeConfig.scanRoot, 'lattice-src', 'lattice.config.json must remain active');
  assert.match(latticeConfig.validate?.command ?? '', /lattice/, 'lattice.config.json validate command must load');
} finally {
  resetConfigCache();
  rmSync(legacyConfigRoot, { recursive: true, force: true });
}

console.log('lattice-only absence smoke passed');
