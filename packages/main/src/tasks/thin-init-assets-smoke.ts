#!/usr/bin/env node
/**
 * @task B-4ee0
 * @checklist CHK-005
 * @title Global-thin init assets smoke
 * @type feature
 * @priority high
 * @description
 * Exercises the real init CLI with global-thin defaults (the new default) and
 * verifies full/thin local proof-or-stop asset modes remain available as explicit opt-in.
 * @changes
 * - [CHK-002] Assert fresh default init creates .proof-or-stop/ assets and not bin/proofOrStop*.js or .proof-or-stop-codex/.
 * - [CHK-003] Assert global codex verify/doctor passes in a global-thin project.
 * - [CHK-004] Assert pre-existing user-owned legacy assets survive init (no deletion).
 * - [B-4ee0] Global-thin: .proof-or-stop/Proof-or-Stop.md, .proof-or-stop/proof-or-stop.json, AGENTS.md are canonical defaults.
 * - [B-38d6] Fresh init writes proof-or-stop.config.json as the canonical and only active project config.
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
import {
  PROOF_OR_STOP_ADAPTER_DIR,
  PROOF_OR_STOP_CONFIG_FILENAME,
  PROOF_OR_STOP_MANIFEST_FILENAME,
  PROOF_OR_STOP_STATE_DIR,
} from '../core/brand-paths.js';

// B-cc10 CHK-004: this smoke asserts what `init` WRITES, so its fixture paths are
// built from the same resolver constants the writers use rather than a second set
// of hardcoded literals. Both the assertExists (mode that writes it) and the
// assertAbsent (mode that must not) refer to the SAME artifact, so both track the
// canonical name together.
//
// B-cc10 CHK-006 (B-cc10:F-001): the DIRECTORY halves of these two paths were still
// hardcoded `.proof-or-stop/` / `.proof-or-stop-codex/` while only the FILENAME half came from the
// resolver. Once CHK-003 moved the state dir, that half-derived path pointed at a
// directory `init` no longer writes, so this smoke asserted a file that could never
// appear. Both halves now come from the resolver, so a future dir rename cannot
// desynchronize the fixture from the writer again.
const PROOF_OR_STOP_MANIFEST_REL = `${PROOF_OR_STOP_STATE_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;
// B-cc10 CHK-007 (B-cc10:F-004): NOW DERIVED. CHK-006 deliberately pinned this to the
// literal `.proof-or-stop/Proof-or-Stop.md` because cli-init.ts wrote the guide to a hardcoded
// deprecated directory while the MANIFEST already used the resolver — init straddled two
// state dirs and created a stray legacy directory on every fresh init. CHK-007 unified the
// writer (cli-init.ts + core/managed-assets.ts + the generated guide templates all derive
// the state dir now), so the condition that comment said to wait for is satisfied and this
// fixture tracks the writer again.
const PROOF_OR_STOP_MD_REL = `${PROOF_OR_STOP_STATE_DIR}/Proof-or-Stop.md`;
const CODEX_MANIFEST_REL = `${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');

/**
 * Escape a derived path for literal use inside a RegExp.
 *
 * B-cc10 CHK-007: the previous inline `PROOF_OR_STOP_MD_REL.replace('.', '\\.')` escaped
 * only the FIRST dot (String.replace with a string pattern is not global), so the
 * `.md` dot stayed a wildcard. Harmless for this fixture but a latent
 * false-positive; escaping properly keeps the assertion exact.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `proof-or-stop-${name}-`));
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
  delete env.PROOF_OR_STOP_PROJECT_ROOT;
  execFileSync(process.execPath, [cliPath, 'session_brief'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...env,
      PROOF_OR_STOP_ACTIVITY_RECORD_READONLY: '1',
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      PROOF_OR_STOP_ACTIVITY_SESSION: session,
      CODEX_THREAD_ID: session,
      PROOF_OR_STOP_AGENT: 'main',
      PROOF_OR_STOP_CODEX_ENTRYPOINT: 'global-fallback',
    },
  });
}

function assertSessionBriefActivity(root: string, session: string): void {
  assert.equal(existsSync(getRuntimeActivityLogPath(root)), true, '.proof-or-stop/activity.jsonl should exist');
  const records = readActivityLogTail(root, 20);
  const record = [...records].reverse().find(entry => entry.tool === 'session_brief');
  assert.ok(record, 'session_brief heartbeat should be recorded');
  assert.match(String(record.session), /^sess-[a-f0-9]+$/, 'heartbeat session should be opaque');
  assert.notEqual(record.session, session, 'heartbeat must not persist the raw host task/session token');
  assert.equal(JSON.stringify(records).includes(session), false, 'raw host task/session token is absent from activity events');
  assert.equal(record.source, 'codex');
  assert.equal(record.status, 'ok');
}

// B-4fd3 regression guard: the .gitignore produced by init must cover the FULL
// runtime-artifact registry ignore set, not just whatever the copied template
// happened to contain. This mechanically catches any future registry→.gitignore
// drift (a new ignorePattern added to the registry but not synced into init's
// copy path / the repo .gitignore), which is exactly how .proof-or-stop/usage/ slipped
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
  writeText(canonicalActivityRoot, PROOF_OR_STOP_CONFIG_FILENAME, '{}\n');
  runSessionBriefHeartbeat(canonicalActivityRoot, 'smoke-canonical-activity');
  assertSessionBriefActivity(canonicalActivityRoot, 'smoke-canonical-activity');
} finally {
  rmSync(canonicalActivityRoot, { recursive: true, force: true });
}

const managedGlobalThinActivityRoot = makeRoot('activity-global-thin');
try {
  writeText(managedGlobalThinActivityRoot, PROOF_OR_STOP_MANIFEST_REL, JSON.stringify({ assetMode: 'global-thin' }, null, 2));
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
    writeText(root, PROOF_OR_STOP_MANIFEST_REL, manifest);
    runSessionBriefHeartbeat(root, `smoke-${name}`);
    assertAbsent(root, `${PROOF_OR_STOP_STATE_DIR}/activity.jsonl`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const loadConfigGlobalThinOnlyRoot = makeRoot('loadconfig-global-thin-only');
try {
  writeText(loadConfigGlobalThinOnlyRoot, PROOF_OR_STOP_MANIFEST_REL, JSON.stringify({
    assetMode: 'global-thin',
    scanRoot: 'managed-manifest-must-not-win',
    storyPrefix: 'Z',
  }, null, 2));
  resetConfigCache();
  const config = loadConfig(loadConfigGlobalThinOnlyRoot);
  assert.equal(config.scanRoot, 'src');
  assert.equal(config.storyPrefix, 'B');
  assertAbsent(loadConfigGlobalThinOnlyRoot, PROOF_OR_STOP_CONFIG_FILENAME);
} finally {
  resetConfigCache();
  rmSync(loadConfigGlobalThinOnlyRoot, { recursive: true, force: true });
}

// ─── Test 1: Fresh default (global-thin) ─────────────────────────────────────
// No --profile or --asset-mode flags: should produce the state dir with minimal assets.
// Forbidden assets: bin/proofOrStop.js, bin/proof-or-stop-codex.js, adapter-dir README/manifest, PROOF_OR_STOP.md.
const globalThinRoot = makeRoot('global-thin-default');
try {
  const output = runInit(globalThinRoot, []);
  assert.match(output, /global-thin/i, 'init output should mention global-thin mode');
  // B-cc10 CHK-007: derived from PROOF_OR_STOP_MD_REL rather than a hardcoded `.proof-or-stop/`
  // regex. A literal here would fail closed against the CANONICAL spelling the
  // writer now emits — the same one-spelling-pinned-guard defect this story exists
  // to remove (it is what broke brand-path-resolver-smoke on CHK-003's rename).
  assert.match(
    output,
    new RegExp(escapeRegExp(PROOF_OR_STOP_MD_REL), 'i'),
    `init output should mention ${PROOF_OR_STOP_MD_REL}`,
  );

  // Required canonical assets
  assertExists(globalThinRoot, PROOF_OR_STOP_MD_REL);
  assertExists(globalThinRoot, PROOF_OR_STOP_MANIFEST_REL);
  assertExists(globalThinRoot, 'AGENTS.md');
  assertExists(globalThinRoot, PROOF_OR_STOP_CONFIG_FILENAME);

  // AGENTS.md should reference the global CLI, not a local bin wrapper.
  //
  // B-cc10 CHK-006 (B-cc10:F-002): the two `codex verify` assertions below matched
  // /proof-or-stop codex verify/ while their own failure messages said "proof-or-stop codex
  // verify" — and the templates emit `proof-or-stop codex verify`, which does NOT
  // contain the substring "proof-or-stop codex verify". The regex and its message disagreed,
  // so these lines could only ever have passed for the wrong reason. Same class as
  // B-cdf6:F-047. They now pin the canonical command the template actually writes.
  const agentsMd = readFileSync(join(globalThinRoot, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, new RegExp(escapeRegExp(PROOF_OR_STOP_MD_REL)), `AGENTS.md should reference ${PROOF_OR_STOP_MD_REL}`);
  assert.match(agentsMd, /proof-or-stop codex verify/, 'AGENTS.md should reference proof-or-stop codex verify');
  assert.doesNotMatch(agentsMd, /node bin\/proofOrStop\.js/, 'AGENTS.md must not reference node bin/proofOrStop.js in global-thin mode');

  // Proof-or-Stop.md should reference the global CLI.
  const proofOrStopMd = readFileSync(join(globalThinRoot, PROOF_OR_STOP_MD_REL), 'utf8');
  assert.match(proofOrStopMd, /proof-or-stop session_brief/, `${PROOF_OR_STOP_MD_REL} should reference proof-or-stop session_brief`);
  assert.match(proofOrStopMd, /proof-or-stop codex verify/, `${PROOF_OR_STOP_MD_REL} should reference proof-or-stop codex verify`);

  // .lattice/lattice.json should declare global-thin mode
  const latticeConfig = JSON.parse(readFileSync(join(globalThinRoot, PROOF_OR_STOP_MANIFEST_REL), 'utf8'));
  assert.equal(latticeConfig.assetMode, 'global-thin');
  assert.equal(latticeConfig.proofOrStopVersion, 1, 'global-thin config should write the canonical proof-or-stop version field');
  assert.equal(Object.hasOwn(latticeConfig, 'latticeVersion'), false, 'global-thin config should not write the legacy version field');

  // Forbidden default assets must not exist
  assertAbsent(globalThinRoot, 'bin/proofOrStop.js');
  assertAbsent(globalThinRoot, 'bin/proof-or-stop-codex.js');
  assertAbsent(globalThinRoot, `${PROOF_OR_STOP_ADAPTER_DIR}/README.md`);
  assertAbsent(globalThinRoot, CODEX_MANIFEST_REL);
  assertAbsent(globalThinRoot, `${PROOF_OR_STOP_ADAPTER_DIR}/agents`);
  assertAbsent(globalThinRoot, 'PROOF_OR_STOP.md');

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
  // Still global-thin (default mode), so .proof-or-stop/ should exist, no .proof-or-stop-codex/ assets
  assertExists(globalThinCodexRoot, PROOF_OR_STOP_MD_REL);
  assertExists(globalThinCodexRoot, PROOF_OR_STOP_MANIFEST_REL);
  assertExists(globalThinCodexRoot, 'AGENTS.md');
  assertAbsent(globalThinCodexRoot, 'bin/proofOrStop.js');
  assertAbsent(globalThinCodexRoot, CODEX_MANIFEST_REL);
  assertCodexOk(globalThinCodexRoot);
} finally {
  rmSync(globalThinCodexRoot, { recursive: true, force: true });
}

// ─── Test 3: Explicit full mode (opt-in local proof-or-stop assets) ────────────────
// --asset-mode=full should create PROOF_OR_STOP.md, the local bin wrappers and the adapter dir.
// B-cc10 CHK-006: these lists asserted `bin/proofOrStop.js` / `bin/proof-or-stop-codex.js`, but
// B-cdf6 already made `init` generate ONLY the canonical names (it never writes the
// deprecated ones). They now pin the wrappers init actually produces.
const fullRoot = makeRoot('explicit-full');
try {
  const output = runInit(fullRoot, ['--profile=codex', '--asset-mode=full']);
  assert.match(output, /Codex asset mode: full/);
  for (const relPath of ['PROOF_OR_STOP.md', 'AGENTS.md', `${PROOF_OR_STOP_ADAPTER_DIR}/README.md`, CODEX_MANIFEST_REL, 'bin/proof-or-stop.js', 'bin/proof-or-stop-codex.js']) {
    assertExists(fullRoot, relPath);
  }
  assertAbsent(fullRoot, PROOF_OR_STOP_MANIFEST_REL);
  assertManagedOk(fullRoot, 'full');
} finally {
  rmSync(fullRoot, { recursive: true, force: true });
}

// ─── Test 4: Explicit thin mode (opt-in) ─────────────────────────────────────
const thinRoot = makeRoot('explicit-thin');
try {
  const output = runInit(thinRoot, ['--profile=codex', '--asset-mode=thin']);
  assert.match(output, /Codex asset mode: thin/);
  for (const relPath of ['PROOF_OR_STOP.md', 'AGENTS.md', `${PROOF_OR_STOP_ADAPTER_DIR}/README.md`, CODEX_MANIFEST_REL, 'bin/proof-or-stop.js', 'bin/proof-or-stop-codex.js']) {
    assertExists(thinRoot, relPath);
  }
  assert.equal(existsSync(join(thinRoot, PROOF_OR_STOP_ADAPTER_DIR, 'agents')), false, 'thin init should not create .proof-or-stop-codex/agents');
  const manifest = JSON.parse(readFileSync(join(thinRoot, CODEX_MANIFEST_REL), 'utf8'));
  assert.equal(manifest.adapterOwner, 'proof-or-stop');
  assert.equal(manifest.sessionEnv.source, 'PROOF_OR_STOP_ACTIVITY_SOURCE');
  assert.equal(manifest.sessionEnv.session, 'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK');
  assert.equal(manifest.sessionEnv.recordReadOnly, 'PROOF_OR_STOP_ACTIVITY_RECORD_READONLY');
  assert.equal(JSON.stringify(manifest).includes('LATTICE_'), false, 'new Codex adapter manifest should not emit legacy environment names');
  assert.equal(manifest.promptMode, 'registry');
  assertAbsent(thinRoot, PROOF_OR_STOP_MANIFEST_REL);
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
    ['PROOF_OR_STOP.md', '# User old Proof-or-Stop guide\n\nDo not delete.\n'],
    ['bin/legacy-bootstrap.js', '#!/usr/bin/env node\nconsole.log("user legacy bootstrap");\n'],
    ['bin/legacy-codex.js', '#!/usr/bin/env node\nconsole.log("user legacy codex wrapper");\n'],
    ['.proof-or-stop-codex/legacy.json', '{"userOwned":true}\n'],
  ]);
  for (const [relPath, content] of legacyFiles) writeText(preserveRoot, relPath, content);
  runInit(preserveRoot, []);
  for (const [relPath, content] of legacyFiles) {
    assert.equal(readFileSync(join(preserveRoot, relPath), 'utf-8'), content, `${relPath} must survive when user-owned`);
  }
  // New .proof-or-stop/ assets should still be created
  assertExists(preserveRoot, PROOF_OR_STOP_MD_REL);
  assertExists(preserveRoot, PROOF_OR_STOP_MANIFEST_REL);
  // Codex verify should pass (global-thin project)
  assertCodexOk(preserveRoot);
} finally {
  rmSync(preserveRoot, { recursive: true, force: true });
}

console.log('✓ global-thin init assets smoke passed');
