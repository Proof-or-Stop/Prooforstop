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
 * - [B-38d6] Fresh init writes lattice.config.json as the canonical and only active project config.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRuntimeActivityLogPath, readActivityLogTail } from '../core/activity-log.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { renderManagedAssetCheck, runManagedAssetCheck, runtimeIgnoreMissing } from '../core/managed-assets.js';
import { listRuntimeArtifactIgnorePatterns } from '../core/runtime-artifact-registry.js';

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

function runSessionBriefHeartbeat(root: string, session: string): void {
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
  execFileSync(process.execPath, [cliPath, 'session_brief'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...env,
      LATTICE_ACTIVITY_RECORD_READONLY: '1',
      LATTICE_ACTIVITY_SOURCE: 'codex',
      LATTICE_ACTIVITY_SESSION: session,
      LATTICE_CODEX_ENTRYPOINT: 'global-fallback',
    },
  });
}

function assertSessionBriefActivity(root: string, session: string): void {
  assert.equal(existsSync(getRuntimeActivityLogPath(root)), true, '.lattice/activity.jsonl should exist');
  const record = readActivityLogTail(root, 20).find(entry =>
    entry.session === session && entry.tool === 'session_brief');
  assert.ok(record, `session_brief heartbeat should be recorded for ${session}`);
  assert.equal(record.source, 'codex');
  assert.equal(record.status, 'ok');
}

// B-4fd3 regression guard: the .gitignore produced by init must cover the FULL
// runtime-artifact registry ignore set, not just whatever the copied template
// happened to contain. This mechanically catches any future registry→.gitignore
// drift (a new ignorePattern added to the registry but not synced into init's
// copy path / the repo .gitignore), which is exactly how .lattice/usage/ slipped
// through and made this smoke fail on clean main.
function assertGitignoreCoversRegistry(root: string): void {
  const giPath = join(root, '.gitignore');
  assert.equal(existsSync(giPath), true, '.gitignore should exist after init');
  const content = readFileSync(giPath, 'utf8');
  const missing = runtimeIgnoreMissing(content);
  assert.equal(
    missing.length,
    0,
    `init .gitignore is missing registry runtime ignore pattern(s): ${missing.join(', ')} (full set: ${listRuntimeArtifactIgnorePatterns().join(', ')})`,
  );
}

// ─── Activity Root Regressions ───────────────────────────────────────────────
const canonicalActivityRoot = makeRoot('activity-canonical');
try {
  writeText(canonicalActivityRoot, 'lattice.config.json', '{}\n');
  runSessionBriefHeartbeat(canonicalActivityRoot, 'smoke-canonical-activity');
  assertSessionBriefActivity(canonicalActivityRoot, 'smoke-canonical-activity');
} finally {
  rmSync(canonicalActivityRoot, { recursive: true, force: true });
}

const managedGlobalThinActivityRoot = makeRoot('activity-global-thin');
try {
  writeText(managedGlobalThinActivityRoot, '.lattice/lattice.json', JSON.stringify({ assetMode: 'global-thin' }, null, 2));
  runSessionBriefHeartbeat(managedGlobalThinActivityRoot, 'smoke-global-thin-activity');
  assertSessionBriefActivity(managedGlobalThinActivityRoot, 'smoke-global-thin-activity');
} finally {
  rmSync(managedGlobalThinActivityRoot, { recursive: true, force: true });
}

for (const [name, manifest] of [
  ['activity-malformed-global-thin', '{not valid json'],
  ['activity-wrong-asset-mode', JSON.stringify({ assetMode: 'thin' }, null, 2)],
] as const) {
  const root = makeRoot(name);
  try {
    writeText(root, '.lattice/lattice.json', manifest);
    runSessionBriefHeartbeat(root, `smoke-${name}`);
    assertAbsent(root, '.lattice/activity.jsonl');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const loadConfigGlobalThinOnlyRoot = makeRoot('loadconfig-global-thin-only');
try {
  writeText(loadConfigGlobalThinOnlyRoot, '.lattice/lattice.json', JSON.stringify({
    assetMode: 'global-thin',
    scanRoot: 'managed-manifest-must-not-win',
    storyPrefix: 'Z',
  }, null, 2));
  resetConfigCache();
  const config = loadConfig(loadConfigGlobalThinOnlyRoot);
  assert.equal(config.scanRoot, 'src');
  assert.equal(config.storyPrefix, 'B');
  assertAbsent(loadConfigGlobalThinOnlyRoot, 'lattice.config.json');
} finally {
  resetConfigCache();
  rmSync(loadConfigGlobalThinOnlyRoot, { recursive: true, force: true });
}

// ─── Test 1: Fresh default (global-thin) ─────────────────────────────────────
// No --profile or --asset-mode flags: should produce .lattice/ dir with minimal assets.
// Forbidden assets: bin/lattice.js, bin/lattice-codex.js, .lattice-codex/README.md, .lattice-codex/lattice.json, LATTICE.md.
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
  assertAbsent(globalThinRoot, '.lattice-codex/README.md');
  assertAbsent(globalThinRoot, '.lattice-codex/lattice.json');
  assertAbsent(globalThinRoot, '.lattice-codex/agents');
  assertAbsent(globalThinRoot, 'LATTICE.md');

  // Global codex verify should pass without local bin shims
  assertCodexOk(globalThinRoot);
  assertManagedOk(globalThinRoot, 'global-thin', 'core');
  // B-4fd3: init's .gitignore must cover the whole runtime ignore registry.
  assertGitignoreCoversRegistry(globalThinRoot);
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
// Running init on a dir that already has unmanaged user-owned files must not
// delete or overwrite those files.
const preserveRoot = makeRoot('preserve-legacy');
try {
  const legacyFiles = new Map([
    ['GUIDE.md', '# User legacy guide\n\nDo not delete.\n'],
    ['LATTICE.md', '# User old Proofbound guide\n\nDo not delete.\n'],
    ['bin/legacy-bootstrap.js', '#!/usr/bin/env node\nconsole.log("user legacy bootstrap");\n'],
    ['bin/legacy-codex.js', '#!/usr/bin/env node\nconsole.log("user legacy codex wrapper");\n'],
    ['.lattice-codex/legacy.json', '{"userOwned":true}\n'],
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
