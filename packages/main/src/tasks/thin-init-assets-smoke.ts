#!/usr/bin/env node
/**
 * @task B-4ee0
 * @checklist CHK-005
 * @title Global-thin init assets smoke
 * @type feature
 * @priority high
 * @description
 * Exercises the real init CLI with global-thin defaults (the new default) and
 * verifies legacy full/thin modes remain available as explicit opt-in.
 * @changes
 * - [CHK-002] Assert fresh default init creates .Lattice/ assets and not bin/lattice*.js or .Codex/.
 * - [CHK-003] Assert global codex verify/doctor passes in a global-thin project.
 * - [CHK-004] Assert legacy assets survive init (no deletion).
 * - [B-4ee0] Global-thin: .Lattice/Lattice.md, .Lattice/lattice.json, AGENTS.md are canonical defaults.
 * - [B-38d6] Fresh init writes lattice.config.json as canonical config; koala.config.json remains legacy fallback only.
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
  return mkdtempSync(join(tmpdir(), `koala-${name}-`));
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
// No --profile or --asset-mode flags: should produce .Lattice/ dir with minimal assets.
// Forbidden assets: bin/lattice.js, bin/lattice-codex.js, .Codex/README.md, .Codex/lattice.json, KOALA.md.
const globalThinRoot = makeRoot('global-thin-default');
try {
  const output = runInit(globalThinRoot, []);
  assert.match(output, /global-thin/i, 'init output should mention global-thin mode');
  assert.match(output, /\.Lattice\/Lattice\.md/i, 'init output should mention .Lattice/Lattice.md');

  // Required canonical assets
  assertExists(globalThinRoot, '.Lattice/Lattice.md');
  assertExists(globalThinRoot, '.Lattice/lattice.json');
  assertExists(globalThinRoot, 'AGENTS.md');
  assertExists(globalThinRoot, 'lattice.config.json');
  assertAbsent(globalThinRoot, 'koala.config.json');

  // AGENTS.md should reference global lattice, not node bin/lattice.js
  const agentsMd = readFileSync(join(globalThinRoot, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /\.Lattice\/Lattice\.md/, 'AGENTS.md should reference .Lattice/Lattice.md');
  assert.match(agentsMd, /lattice codex verify/, 'AGENTS.md should reference lattice codex verify');
  assert.doesNotMatch(agentsMd, /node bin\/lattice\.js/, 'AGENTS.md must not reference node bin/lattice.js in global-thin mode');

  // .Lattice/Lattice.md should reference global lattice CLI
  const latticeMd = readFileSync(join(globalThinRoot, '.Lattice/Lattice.md'), 'utf8');
  assert.match(latticeMd, /lattice session_brief/, '.Lattice/Lattice.md should reference lattice session_brief');
  assert.match(latticeMd, /lattice codex verify/, '.Lattice/Lattice.md should reference lattice codex verify');

  // .Lattice/lattice.json should declare global-thin mode
  const latticeConfig = JSON.parse(readFileSync(join(globalThinRoot, '.Lattice/lattice.json'), 'utf8'));
  assert.equal(latticeConfig.assetMode, 'global-thin');

  // Forbidden default assets must not exist
  assertAbsent(globalThinRoot, 'bin/lattice.js');
  assertAbsent(globalThinRoot, 'bin/lattice-codex.js');
  assertAbsent(globalThinRoot, 'bin/koala.js');
  assertAbsent(globalThinRoot, 'bin/koala-codex.js');
  assertAbsent(globalThinRoot, '.Codex/README.md');
  assertAbsent(globalThinRoot, '.Codex/lattice.json');
  assertAbsent(globalThinRoot, '.Codex/koala.json');
  assertAbsent(globalThinRoot, '.Codex/agents');
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
  // Still global-thin (default mode), so .Lattice/ should exist, no .Codex/ assets
  assertExists(globalThinCodexRoot, '.Lattice/Lattice.md');
  assertExists(globalThinCodexRoot, '.Lattice/lattice.json');
  assertExists(globalThinCodexRoot, 'AGENTS.md');
  assertAbsent(globalThinCodexRoot, 'bin/lattice.js');
  assertAbsent(globalThinCodexRoot, '.Codex/lattice.json');
  assertCodexOk(globalThinCodexRoot);
} finally {
  rmSync(globalThinCodexRoot, { recursive: true, force: true });
}

// ─── Test 3: Explicit full mode (opt-in legacy) ───────────────────────────────
// --asset-mode=full should create LATTICE.md, bin/lattice.js, .Codex/ as before.
const fullRoot = makeRoot('explicit-full');
try {
  const output = runInit(fullRoot, ['--profile=codex', '--asset-mode=full']);
  assert.match(output, /Codex asset mode: full/);
  for (const relPath of ['LATTICE.md', 'AGENTS.md', '.Codex/README.md', '.Codex/lattice.json', 'bin/lattice.js', 'bin/lattice-codex.js']) {
    assertExists(fullRoot, relPath);
  }
  for (const relPath of ['KOALA.md', '.Codex/koala.json', 'bin/koala.js', 'bin/koala-codex.js']) {
    assertAbsent(fullRoot, relPath);
  }
  assertAbsent(fullRoot, '.Lattice/lattice.json');
  assertManagedOk(fullRoot, 'full');
} finally {
  rmSync(fullRoot, { recursive: true, force: true });
}

// ─── Test 4: Explicit thin mode (opt-in) ─────────────────────────────────────
const thinRoot = makeRoot('explicit-thin');
try {
  const output = runInit(thinRoot, ['--profile=codex', '--asset-mode=thin']);
  assert.match(output, /Codex asset mode: thin/);
  for (const relPath of ['LATTICE.md', 'AGENTS.md', '.Codex/README.md', '.Codex/lattice.json', 'bin/lattice.js', 'bin/lattice-codex.js']) {
    assertExists(thinRoot, relPath);
  }
  assert.equal(existsSync(join(thinRoot, '.Codex', 'agents')), false, 'thin init should not create .Codex/agents');
  const manifest = JSON.parse(readFileSync(join(thinRoot, '.Codex', 'lattice.json'), 'utf8'));
  assert.equal(manifest.adapterOwner, 'lattice');
  assert.equal(manifest.promptMode, 'registry');
  assertAbsent(thinRoot, '.Lattice/lattice.json');
  assertManagedOk(thinRoot, 'thin');
} finally {
  rmSync(thinRoot, { recursive: true, force: true });
}

// ─── Test 5: Legacy assets survive global-thin init (non-destructive) ────────
// Running init on a dir that already has KOALA.md, bin/koala.js, .Codex/koala.json
// must not delete or overwrite those legacy files.
const preserveRoot = makeRoot('preserve-legacy');
try {
  const legacyFiles = new Map([
    ['KOALA.md', '# User legacy guide\n\nDo not delete.\n'],
    ['LATTICE.md', '# User old Lattice guide\n\nDo not delete.\n'],
    ['bin/koala.js', '#!/usr/bin/env node\nconsole.log("user legacy bootstrap");\n'],
    ['bin/koala-codex.js', '#!/usr/bin/env node\nconsole.log("user legacy codex wrapper");\n'],
    ['.Codex/koala.json', '{"userOwned":true}\n'],
  ]);
  for (const [relPath, content] of legacyFiles) writeText(preserveRoot, relPath, content);
  runInit(preserveRoot, []);
  for (const [relPath, content] of legacyFiles) {
    assert.equal(readFileSync(join(preserveRoot, relPath), 'utf-8'), content, `${relPath} must survive when user-owned`);
  }
  // New .Lattice/ assets should still be created
  assertExists(preserveRoot, '.Lattice/Lattice.md');
  assertExists(preserveRoot, '.Lattice/lattice.json');
  // Codex verify should pass (global-thin project)
  assertCodexOk(preserveRoot);
} finally {
  rmSync(preserveRoot, { recursive: true, force: true });
}

console.log('✓ global-thin init assets smoke passed');
