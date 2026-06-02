#!/usr/bin/env node
/**
 * @task B-9b76
 * @checklist CHK-004
 * @title Thin init asset mode smoke
 * @type feature
 * @priority high
 * @description
 * Exercises the real init CLI with --asset-mode=thin and proves full mode
 * remains the default compatibility path.
 * @changes
 * - [CHK-004] Cover thin Codex init, full default init, and no-delete behavior.
 * - [B-b95c] Assert new init writes Lattice primary asset names and preserves user-owned legacy Koala files.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { renderManagedAssetCheck, runManagedAssetCheck } from '../core/managed-assets.js';
import { readPromptRegistry } from '../core/prompt-registry.js';

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

function assertManagedOk(root: string, assetMode: 'full' | 'thin'): void {
  const result = runManagedAssetCheck(root, { profile: 'codex', assetMode });
  assert.equal(result.ok, true, renderManagedAssetCheck(result));
}

function assertCodexOk(root: string): void {
  const result = runCodexAdapterChecks(root, { executeHeartbeats: false });
  assert.equal(result.ok, true, renderCodexAdapterChecks(result));
}

const thinRoot = makeRoot('thin-init');
try {
  const output = runInit(thinRoot, ['--profile=codex', '--asset-mode=thin']);
  assert.match(output, /Codex asset mode: thin/);
  assert.match(output, /\.Codex\/agents \(thin asset mode; prompts resolve from registry\)/);
  for (const relPath of ['LATTICE.md', 'AGENTS.md', '.Codex/README.md', '.Codex/lattice.json', 'bin/lattice.js', 'bin/lattice-codex.js']) {
    assertExists(thinRoot, relPath);
  }
  for (const relPath of ['KOALA.md', '.Codex/koala.json', 'bin/koala.js', 'bin/koala-codex.js']) {
    assertAbsent(thinRoot, relPath);
  }
  assert.equal(existsSync(join(thinRoot, '.Codex', 'agents')), false, 'thin init should not create .Codex/agents');
  const manifest = JSON.parse(readFileSync(join(thinRoot, '.Codex', 'lattice.json'), 'utf8'));
  assert.equal(manifest.adapterOwner, 'lattice');
  assert.equal(manifest.recommendedEntrypoints[0]?.command, 'node bin/lattice-codex.js');
  assert.equal(manifest.promptMode, 'registry');
  assert.equal(typeof manifest.promptRegistry?.materialHash, 'string');
  assert.match(readFileSync(join(thinRoot, '.Codex', 'README.md'), 'utf8'), /Thin Asset Mode/);
  assertManagedOk(thinRoot, 'thin');
  assertCodexOk(thinRoot);
} finally {
  rmSync(thinRoot, { recursive: true, force: true });
}

const fullRoot = makeRoot('full-init');
try {
  const output = runInit(fullRoot, ['--profile=codex']);
  assert.match(output, /Codex asset mode: full/);
  for (const relPath of ['LATTICE.md', 'AGENTS.md', '.Codex/README.md', '.Codex/lattice.json', 'bin/lattice.js', 'bin/lattice-codex.js']) {
    assertExists(fullRoot, relPath);
  }
  for (const relPath of ['KOALA.md', '.Codex/koala.json', 'bin/koala.js', 'bin/koala-codex.js']) {
    assertAbsent(fullRoot, relPath);
  }
  const codexAgentDir = join(fullRoot, '.Codex', 'agents');
  assert.equal(existsSync(codexAgentDir), true, 'full init should create .Codex/agents');
  assert.equal(readdirSync(codexAgentDir).filter(file => file.endsWith('.md')).length, readPromptRegistry().agentCount);
  const manifest = JSON.parse(readFileSync(join(fullRoot, '.Codex', 'lattice.json'), 'utf8'));
  assert.equal(manifest.adapterOwner, 'lattice');
  assert.equal(manifest.promptMode, undefined);
  assertManagedOk(fullRoot, 'full');
} finally {
  rmSync(fullRoot, { recursive: true, force: true });
}

const preservedRoot = makeRoot('thin-preserve');
try {
  const userPrompt = join(preservedRoot, '.Codex', 'agents', 'user-owned.md');
  mkdirSync(dirname(userPrompt), { recursive: true });
  writeFileSync(userPrompt, '# User prompt\n\nThis file must survive thin init.\n');
  const legacyFiles = new Map([
    ['KOALA.md', '# User legacy guide\n\nDo not delete.\n'],
    ['bin/koala.js', '#!/usr/bin/env node\nconsole.log("user legacy bootstrap");\n'],
    ['bin/koala-codex.js', '#!/usr/bin/env node\nconsole.log("user legacy codex wrapper");\n'],
    ['.Codex/koala.json', '{\"userOwned\":true}\n'],
  ]);
  for (const [relPath, content] of legacyFiles) writeText(preservedRoot, relPath, content);
  runInit(preservedRoot, ['--profile=codex', '--asset-mode', 'thin']);
  assert.equal(existsSync(userPrompt), true, 'thin init must not delete existing user-owned .Codex/agents files');
  for (const [relPath, content] of legacyFiles) {
    assert.equal(readFileSync(join(preservedRoot, relPath), 'utf-8'), content, `${relPath} must survive when user-owned`);
  }
  for (const relPath of ['LATTICE.md', '.Codex/lattice.json', 'bin/lattice.js', 'bin/lattice-codex.js']) {
    assertExists(preservedRoot, relPath);
  }
  assertManagedOk(preservedRoot, 'thin');
  assertCodexOk(preservedRoot);
} finally {
  rmSync(preservedRoot, { recursive: true, force: true });
}

console.log('✓ lattice branded init smoke passed');
