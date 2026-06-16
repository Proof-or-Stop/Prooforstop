#!/usr/bin/env node
/**
 * @task B-4ee0
 * @checklist CHK-005
 * @title Global-thin init assets smoke
 * @type feature
 * @priority high
 * @description
 * Exercises the real init CLI with global-thin defaults (the new default) and
 * verifies full/thin local lattice asset modes remain available as explicit opt-in.
 * @changes
 * - [CHK-002] Assert fresh default init creates .lattice/ assets and not bin/lattice*.js or .lattice-codex/.
 * - [CHK-003] Assert global codex verify/doctor passes in a global-thin project.
 * - [CHK-004] Assert pre-existing user-owned legacy assets survive init (no deletion).
 * - [B-4ee0] Global-thin: .lattice/Lattice.md, .lattice/lattice.json, AGENTS.md are canonical defaults.
 * - [B-38d6] Fresh init writes lattice.config.json as canonical config; koala.config.json is no longer an active fallback.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { renderManagedAssetCheck, runManagedAssetCheck } from '../core/managed-assets.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');

function makeRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `lattice-${name}-`));
}

function runInit(root: string, args: string[]): string {
  return execFileSync(process.execPath, [cliPath, 'init', ...args, root], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function assertExists(root: string, relPath: string): void {
  assert.equal(existsSync(join(root, relPath)), true, `${relPath} should exist`);
}

function assertAbsent(root: string, relPath: string): void {
  assert.equal(existsSync(join(root, relPath)), false, `${relPath} should not exist`);
}

function assertManagedOk(root: string, assetMode: 'full' | 'thin' | 'global-thin', profile = 'codex'): void {
  const result = runManagedAssetCheck(root, { profile: profile as any, assetMode });
  assert.equal(result.ok, true, renderManagedAssetCheck(result));
}

function assertCodexOk(root: string): void {
  const result = runCodexAdapterChecks(root, { executeHeartbeats: false });
  assert.equal(result.ok, true, renderCodexAdapterChecks(result));
}

// ─── Test 1: Fresh default (global-thin) ─────────────────────────────────────
// No --profile or --asset-mode flags: should produce .lattice/ dir with minimal assets.
// Forbidden assets: bin/lattice.js, bin/lattice-codex.js, .lattice-codex/README.md, .lattice-codex/lattice.json, KOALA.md.
const globalThinRoot = makeRoot('global-thin-default');
try {
  const output = runInit(globalThinRoot, []);
  assert.match(output, /global-thin/i, 'init output should mention global-thin mode');
  assert.match(output, /\.lattice\/Lattice\.md/i, 'init output should mention .lattice/Lattice.md');

  // Required canonical assets
  assertExists(globalThinRoot, '.lattice/Lattice.md');
  assertExists(globalThinRoot, '.lattice/lattice.json');
  assertExists(globalThinRoot, 'AGENTS.md');
  assertExists(globalThinRoot, 'lattice.config.json');
  assertAbsent(globalThinRoot, 'koala.config.json');

  // AGENTS.md should reference global lattice, not node bin/lattice.js
  const agentsMd = readFileSync(join(globalThinRoot, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /\.lattice\/Lattice\.md/, 'AGENTS.md should reference .lattice/Lattice.md');
  assert.match(agentsMd, /lattice codex verify/, 'AGENTS.md should reference lattice codex verify');
  assert.doesNotMatch(agentsMd, /node bin\/lattice\.js/, 'AGENTS.md must not reference node bin/lattice.js in global-thin mode');

  // .lattice/Lattice.md should reference global lattice CLI
  const latticeMd = readFileSync(join(globalThinRoot, '.lattice/Lattice.md'), 'utf8');
  assert.match(latticeMd, /lattice session_brief/, '.lattice/Lattice.md should reference lattice session_brief');
  assert.match(latticeMd, /lattice codex verify/, '.lattice/Lattice.md should reference lattice codex verify');

  // .lattice/lattice.json should declare global-thin mode
  const latticeConfig = JSON.parse(readFileSync(join(globalThinRoot, '.lattice/lattice.json'), 'utf8'));
  assert.equal(latticeConfig.assetMode, 'global-thin');

  // Forbidden default assets must not exist
  assertAbsent(globalThinRoot, 'bin/lattice.js');
  assertAbsent(globalThinRoot, 'bin/lattice-codex.js');
  assertAbsent(globalThinRoot, 'bin/koala.js');
  assertAbsent(globalThinRoot, 'bin/koala-codex.js');
  assertAbsent(globalThinRoot, '.lattice-codex/README.md');
  assertAbsent(globalThinRoot, '.lattice-codex/lattice.json');
  assertAbsent(globalThinRoot, '.lattice-codex/koala.json');
  assertAbsent(globalThinRoot, '.lattice-codex/agents');
  assertAbsent(globalThinRoot, 'KOALA.md');
  assertAbsent(globalThinRoot, 'LATTICE.md');

  // Global codex verify should pass without local bin shims
  assertCodexOk(globalThinRoot);
  assertManagedOk(globalThinRoot, 'global-thin', 'core');
} finally {
  rmSync(globalThinRoot, { recursive: true, force: true });
}

// ─── Test 2: Global-thin with explicit codex profile ─────────────────────────
const globalThinCodexRoot = makeRoot('global-thin-codex');
try {
  runInit(globalThinCodexRoot, ['--profile=codex']);
  // Still global-thin (default mode), so .lattice/ should exist, no .lattice-codex/ assets
  assertExists(globalThinCodexRoot, '.lattice/Lattice.md');
  assertExists(globalThinCodexRoot, '.lattice/lattice.json');
  assertExists(globalThinCodexRoot, 'AGENTS.md');
  assertAbsent(globalThinCodexRoot, 'bin/lattice.js');
  assertAbsent(globalThinCodexRoot, '.lattice-codex/lattice.json');
  assertCodexOk(globalThinCodexRoot);
} finally {
  rmSync(globalThinCodexRoot, { recursive: true, force: true });
}

// ─── Test 3: Explicit full mode (opt-in local lattice assets) ────────────────
// --asset-mode=full should create LATTICE.md, bin/lattice.js, .lattice-codex/ as before.
const fullRoot = makeRoot('explicit-full');
try {
  const output = runInit(fullRoot, ['--profile=codex', '--asset-mode=full']);
  assert.match(output, /Codex asset mode: full/);
  for (const relPath of ['LATTICE.md', 'AGENTS.md', '.lattice-codex/README.md', '.lattice-codex/lattice.json', 'bin/lattice.js', 'bin/lattice-codex.js']) {
    assertExists(fullRoot, relPath);
  }
  for (const relPath of ['KOALA.md', '.lattice-codex/koala.json', 'bin/koala.js', 'bin/koala-codex.js']) {
    assertAbsent(fullRoot, relPath);
  }
  assertAbsent(fullRoot, '.lattice/lattice.json');
  assertManagedOk(fullRoot, 'full');
} finally {
  rmSync(fullRoot, { recursive: true, force: true });
}

// ─── Test 4: Explicit thin mode (opt-in) ─────────────────────────────────────
const thinRoot = makeRoot('explicit-thin');
try {
  const output = runInit(thinRoot, ['--profile=codex', '--asset-mode=thin']);
  assert.match(output, /Codex asset mode: thin/);
  for (const relPath of ['LATTICE.md', 'AGENTS.md', '.lattice-codex/README.md', '.lattice-codex/lattice.json', 'bin/lattice.js', 'bin/lattice-codex.js']) {
    assertExists(thinRoot, relPath);
  }
  assert.equal(existsSync(join(thinRoot, '.lattice-codex', 'agents')), false, 'thin init should not create .lattice-codex/agents');
  const manifest = JSON.parse(readFileSync(join(thinRoot, '.lattice-codex', 'lattice.json'), 'utf8'));
  assert.equal(manifest.adapterOwner, 'lattice');
  assert.equal(manifest.promptMode, 'registry');
  assertAbsent(thinRoot, '.lattice/lattice.json');
  assertManagedOk(thinRoot, 'thin');
} finally {
  rmSync(thinRoot, { recursive: true, force: true });
}

// ─── Test 5: User-owned legacy files survive global-thin init ────────────────
// Running init on a dir that already has KOALA.md, bin/koala.js, .lattice-codex/koala.json
// must not delete or overwrite those legacy files.
const preserveRoot = makeRoot('preserve-legacy');
try {
  const legacyFiles = new Map([
    ['KOALA.md', '# User legacy guide\n\nDo not delete.\n'],
    ['LATTICE.md', '# User old Lattice guide\n\nDo not delete.\n'],
    ['bin/koala.js', '#!/usr/bin/env node\nconsole.log("user legacy bootstrap");\n'],
    ['bin/koala-codex.js', '#!/usr/bin/env node\nconsole.log("user legacy codex wrapper");\n'],
    ['.lattice-codex/koala.json', '{"userOwned":true}\n'],
  ]);
  for (const [relPath, content] of legacyFiles) writeText(preserveRoot, relPath, content);
  runInit(preserveRoot, []);
  for (const [relPath, content] of legacyFiles) {
    assert.equal(readFileSync(join(preserveRoot, relPath), 'utf-8'), content, `${relPath} must survive when user-owned`);
  }
  // New .lattice/ assets should still be created
  assertExists(preserveRoot, '.lattice/Lattice.md');
  assertExists(preserveRoot, '.lattice/lattice.json');
  // Codex verify should pass (global-thin project)
  assertCodexOk(preserveRoot);
} finally {
  rmSync(preserveRoot, { recursive: true, force: true });
}

console.log('✓ global-thin init assets smoke passed');
