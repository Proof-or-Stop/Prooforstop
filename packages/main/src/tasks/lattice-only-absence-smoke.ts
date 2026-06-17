#!/usr/bin/env node
/**
 * @task B-6351
 * @checklist CHK-003
 * @title Lattice-only runtime absence smoke
 * @type feature
 * @priority high
 * @description
 * Proves active runtime, Codex adapter, and generated bootstrap surfaces no
 * longer accept or advertise legacy CLI alias compatibility.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_README_TEMPLATE,
  renderCodexReadmeTemplate,
  renderLatticeBootstrapScript,
  renderLatticeCodexAdapterManifest,
  renderLatticeCodexWrapperScript,
} from '../init-assets.js';
import { formatLatticeProductLine, formatLatticeVersionLine } from '../core/lattice-brand.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { renderManagedAssetCheck, runManagedAssetCheck } from '../core/managed-assets.js';
import { loadConfig, resetConfigCache } from '../core/config.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function assertNotContains(haystack: string, needle: string, label: string): void {
  assert.equal(haystack.includes(needle), false, `${label} should not contain ${needle}`);
}

assert.equal(formatLatticeVersionLine(), formatLatticeProductLine(), 'version output should be exactly the product line');

const bootstrap = renderLatticeBootstrapScript(packageRoot);
assertNotContains(bootstrap, '@koala-agent/core', 'generated lattice bootstrap');
assertNotContains(bootstrap, 'bin/koala.js', 'generated lattice bootstrap');
assertNotContains(bootstrap, "spawnSync('koala'", 'generated lattice bootstrap');
assertNotContains(bootstrap, 'command -v koala', 'generated lattice bootstrap');

const codexWrapper = renderLatticeCodexWrapperScript();
assertNotContains(codexWrapper, 'bin/koala-codex.js', 'generated lattice Codex wrapper');
assertNotContains(codexWrapper, 'bin/koala.js', 'generated lattice Codex wrapper');

for (const template of [CODEX_README_TEMPLATE, renderCodexReadmeTemplate('full'), renderCodexReadmeTemplate('thin')]) {
  assertNotContains(template, 'node bin/koala-codex.js', 'Codex README template');
  assertNotContains(template, '.lattice-codex/koala.json', 'Codex README template');
}
const manifest = renderLatticeCodexAdapterManifest();
assertNotContains(manifest, 'koala-codex', 'Codex manifest template');
assertNotContains(manifest, '.lattice-codex/koala.json', 'Codex manifest template');

const legacyConfigRoot = mkdtempSync(join(tmpdir(), 'lattice-config-legacy-absent-'));
try {
  writeText(legacyConfigRoot, 'koala.config.json', JSON.stringify({
    scanRoot: 'legacy-only-src',
    validate: { command: 'node -e "process.stdout.write(\\"legacy\\")"' },
  }, null, 2) + '\n');
  resetConfigCache();
  const legacyOnlyConfig = loadConfig(legacyConfigRoot);
  assert.notEqual(legacyOnlyConfig.scanRoot, 'legacy-only-src', 'koala.config.json must not be loaded as active config');
  assert.equal(legacyOnlyConfig.validate, undefined, 'koala.config.json validate commands must not be loaded');

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

const legacyOnlyRoot = mkdtempSync(join(tmpdir(), 'lattice-legacy-absent-'));
try {
  writeText(legacyOnlyRoot, '.lattice-codex/koala.json', JSON.stringify({
    adapterOwner: 'koala',
    adapterKind: 'codex',
    activitySource: 'codex',
  }, null, 2) + '\n');
  writeText(legacyOnlyRoot, 'bin/koala-codex.js', '#!/usr/bin/env node\n');
  writeText(legacyOnlyRoot, 'bin/koala.js', '#!/usr/bin/env node\n');
  writeText(legacyOnlyRoot, '.codex/hooks.json', '{"hooks":{}}\n');
  writeText(legacyOnlyRoot, '.codex/hooks/lattice-scope-pretool.cjs', '#!/usr/bin/env node\n');

  const codex = runCodexAdapterChecks(legacyOnlyRoot, { executeHeartbeats: false });
  assert.equal(codex.ok, false, `legacy-only Codex assets must not pass:\n${renderCodexAdapterChecks(codex)}`);
  // B-097f host-neutral runtime-owned model: a canonical .lattice-codex/lattice.json is no
  // longer required; the prompt body resolves from the package registry. The legacy
  // .lattice-codex/koala.json is simply ignored (never loaded as an active manifest), so the
  // manifest check reports the runtime-owned default `pass` rather than the pre-B-097f `fail`.
  // The legacy-only rejection is still proven by codex.ok===false above plus the local-wrapper
  // fail and the INCOMPATIBLE managed-asset checks below — the legacy assets are NOT accepted.
  const manifestCheck = codex.checks.find(check => check.id === 'manifest');
  assert.equal(manifestCheck?.status, 'pass', 'absent canonical manifest resolves to runtime-owned default (legacy koala.json ignored)');
  assert.match(manifestCheck?.detail ?? '', /runtime-owned default/, 'manifest pass must be the runtime-owned default, not legacy acceptance');
  assert.equal(codex.checks.find(check => check.id === 'local-wrapper')?.status, 'fail', 'legacy-only wrapper should fail');

  const managed = runManagedAssetCheck(legacyOnlyRoot, { profile: 'codex', assetMode: 'full' });
  assert.equal(managed.ok, false, `legacy active assets must be incompatible:\n${renderManagedAssetCheck(managed)}`);
  for (const relPath of ['bin/koala.js', 'bin/koala-codex.js', '.lattice-codex/koala.json']) {
    const item = managed.items.find(candidate => candidate.relPath === relPath);
    assert.equal(item?.status, 'INCOMPATIBLE', `${relPath} should be an excluded active runtime asset`);
  }
} finally {
  rmSync(legacyOnlyRoot, { recursive: true, force: true });
}

console.log('lattice-only absence smoke passed');
