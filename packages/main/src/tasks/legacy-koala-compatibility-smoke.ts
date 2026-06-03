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
import { execFileSync } from 'node:child_process';
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
const cliPath = join(packageRoot, 'dist', 'cli.js');

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

// ─── Global-thin project: local-wrapper not required ─────────────────────────
// A project with only .Lattice/lattice.json (global-thin) should pass codex verify
// without any bin/ shim or .Codex/ manifest.
const globalThinRoot = makeRoot('global-thin-compat');
try {
  writeText(globalThinRoot, '.Lattice/lattice.json', JSON.stringify({
    latticeVersion: 1,
    assetMode: 'global-thin',
    description: 'test global-thin project',
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  writeText(globalThinRoot, '.gitignore', '# minimal\n');
  const gtResult = runCodexAdapterChecks(globalThinRoot, { executeHeartbeats: false });
  assert.equal(gtResult.ok, true, `global-thin project should pass codex checks: ${JSON.stringify(gtResult.checks.filter(c => c.status === 'fail'), null, 2)}`);
  assert.equal(checkById(gtResult, 'manifest').status, 'pass');
  assert.match(checkById(gtResult, 'manifest').detail, /global-thin/);
  assert.equal(checkById(gtResult, 'local-wrapper').status, 'pass');
  assert.match(checkById(gtResult, 'local-wrapper').detail, /global-thin/);
} finally {
  rmSync(globalThinRoot, { recursive: true, force: true });
}

// ─── Mixed project: .Lattice/ present alongside .Codex/koala.json AND .Codex/lattice.json ────
// When .Lattice/lattice.json exists alongside legacy .Codex/koala.json and .Codex/lattice.json,
// the resolver must select .Lattice/ (global-thin) and not fail on the .Codex/ entries.
const mixedGlobalRoot = makeRoot('mixed-global-thin');
try {
  writeText(mixedGlobalRoot, '.Lattice/lattice.json', JSON.stringify({
    latticeVersion: 1,
    assetMode: 'global-thin',
    description: 'test mixed project',
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  // Also seed legacy .Codex/ manifests to prove .Lattice/ takes priority
  writeText(mixedGlobalRoot, '.Codex/koala.json', renderCodexAdapterManifest({ promptMode: 'registry' }));
  writeText(mixedGlobalRoot, '.Codex/lattice.json', renderCodexAdapterManifest({ promptMode: 'registry' }));
  writeText(mixedGlobalRoot, 'KOALA.md', KOALA_MD_TEMPLATE);
  writeText(mixedGlobalRoot, 'AGENTS.md', AGENTS_MD_TEMPLATE);
  writeText(mixedGlobalRoot, '.gitignore', listRuntimeArtifactIgnorePatterns().join('\n') + '\n');
  const mixedResult = runCodexAdapterChecks(mixedGlobalRoot, { executeHeartbeats: false });
  assert.equal(mixedResult.ok, true, `mixed global-thin project should pass: ${JSON.stringify(mixedResult.checks.filter(c => c.status === 'fail'), null, 2)}`);
  // The manifest detail must reflect global-thin selection, not .Codex/ selection
  assert.match(checkById(mixedResult, 'manifest').detail, /global-thin/, '.Lattice/ global-thin must be selected over .Codex/ manifests');
  assert.doesNotMatch(checkById(mixedResult, 'manifest').detail, /\.Codex\/lattice\.json.*fail|fail.*\.Codex\/lattice\.json/, '.Codex/lattice.json must not cause failure when .Lattice/ is present');
} finally {
  rmSync(mixedGlobalRoot, { recursive: true, force: true });
}

// ─── codex doctor CLI smoke: global-thin project ─────────────────────────────
// `lattice codex doctor` must output Codex adapter diagnostics for a global-thin
// project and must not emit a missing-local-wrapper hard failure.
const codexDoctorRoot = makeRoot('codex-doctor-global-thin');
try {
  writeFileSync(join(codexDoctorRoot, '.gitignore'), '');
  mkdirSync(join(codexDoctorRoot, '.Lattice'), { recursive: true });
  writeFileSync(join(codexDoctorRoot, '.Lattice', 'lattice.json'), JSON.stringify({
    latticeVersion: 1,
    assetMode: 'global-thin',
    description: 'codex doctor smoke',
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  let doctorOutput = '';
  try {
    doctorOutput = execFileSync(process.execPath, [cliPath, '--root', codexDoctorRoot, 'codex', 'doctor'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    // codex doctor may exit non-zero for advisory issues; capture stdout
    doctorOutput = (e.stdout ?? '') + (e.stderr ?? '');
  }
  // Must contain Codex adapter check output or global-thin mention
  assert.ok(
    /global-thin|Codex adapter|codex adapter|manifest|lattice\.json/i.test(doctorOutput),
    `codex doctor output should contain Codex adapter checks, got: ${doctorOutput.slice(0, 500)}`,
  );
  // Must NOT mention missing local wrapper as a hard failure
  assert.doesNotMatch(
    doctorOutput,
    /missing bin\/lattice-codex\.js.*FAIL|FAIL.*missing bin\/lattice-codex\.js/,
    'codex doctor must not hard-fail on missing bin/lattice-codex.js for a global-thin project',
  );
} finally {
  rmSync(codexDoctorRoot, { recursive: true, force: true });
}

console.log('✓ legacy koala compatibility smoke passed');
