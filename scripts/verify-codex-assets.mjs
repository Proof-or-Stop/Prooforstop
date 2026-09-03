#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_README_TEMPLATE,
  renderCodexReadmeTemplate,
  renderProofOrStopCodexAdapterManifest,
} from '../packages/main/dist/init-assets.js';
import {
  DEPRECATED_ADAPTER_DIR,
  DEPRECATED_MANIFEST_FILENAME,
  DEPRECATED_STATE_DIR,
  PROOF_OR_STOP_ADAPTER_DIR,
  PROOF_OR_STOP_CONFIG_FILENAME,
  PROOF_OR_STOP_MANIFEST_FILENAME,
  PROOF_OR_STOP_STATE_DIR,
} from '../packages/main/dist/core/brand-paths.js';
import {
  computeCodexAdapterMaterialSnapshot,
  DEFAULT_CODEX_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS,
  GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS,
  GLOBAL_CODEX_FALLBACK_COMMAND,
  LOCAL_CODEX_VERIFY_COMMAND,
  LOCAL_INIT_VERIFY_COMMAND,
  LOCAL_MAIN_VERIFY_COMMAND,
  renderCodexAdapterChecks,
  resolveCodexSessionBriefCommand,
  runCodexAdapterChecks,
  summarizeCodexEvidence,
} from '../packages/main/dist/core/codex-adapter-checks.js';
import {
  readPromptRegistry,
  renderPromptEntryForHost,
} from '../packages/main/dist/core/prompt-registry.js';
import { StoryStore } from '../packages/main/dist/core/store.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label} missing "${needle}"`);
}

function assertNotIncludes(haystack, needle, label) {
  assert(!haystack.includes(needle), `${label} should not include "${needle}"`);
}

const root = process.cwd();
const canonicalCodexDir = PROOF_OR_STOP_ADAPTER_DIR;
const legacyCodexDir = DEPRECATED_ADAPTER_DIR;
const canonicalCodexManifest = join(canonicalCodexDir, PROOF_OR_STOP_MANIFEST_FILENAME);
const legacyCodexManifest = join(legacyCodexDir, DEPRECATED_MANIFEST_FILENAME);
const result = runCodexAdapterChecks(root, { executeHeartbeats: false });
if (!result.ok) {
  console.error(renderCodexAdapterChecks(result));
  process.exit(1);
}

const mainPackage = JSON.parse(readFileSync(join(root, 'packages', 'main', 'package.json'), 'utf8'));
const mainLock = JSON.parse(readFileSync(join(root, 'packages', 'main', 'package-lock.json'), 'utf8'));
assert(mainPackage.bin?.['proof-or-stop'] === 'dist/cli.js', 'Codex verification requires the canonical proof-or-stop npm bin');
assert(mainLock.packages?.['']?.bin?.['proof-or-stop'] === 'dist/cli.js', 'Codex verification requires the lockfile proof-or-stop npm bin');
assert(!Object.prototype.hasOwnProperty.call(mainPackage.bin ?? {}, 'lattice'), 'Codex verification must reject a reintroduced lattice npm bin alias');
assert(!Object.prototype.hasOwnProperty.call(mainLock.packages?.['']?.bin ?? {}, 'lattice'), 'Codex verification must reject a reintroduced lockfile lattice npm bin alias');

assert(DEFAULT_CODEX_HEARTBEAT_TIMEOUT_MS === 10_000, 'local/default Codex heartbeat timeout should remain conservative');
assert(DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS === 30_000, 'global fallback heartbeat timeout should allow real session_brief on large repos');
assert(
  DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS > DEFAULT_CODEX_HEARTBEAT_TIMEOUT_MS,
  'global fallback heartbeat should have a larger default budget than local wrapper probes',
);
// B-cdf6 (B-META F-013): the override cap must stay above the default (otherwise it could
// never help) and bounded (otherwise an interactive diagnostic could hang indefinitely).
assert(
  GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS > DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS,
  'heartbeat timeout cap must exceed the default it raises above',
);
assert(GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS === 600_000, 'heartbeat timeout cap should stay bounded at 10 minutes');

// CODEX_README_TEMPLATE is the default export; check for the CANONICAL wrapper commands.
// B-cdf6: the generated guide must teach `bin/proof-or-stop-codex.js`, not the retained
// deprecated `bin/proof-or-stop-codex.js` alias — a fresh init that still printed the old name
// would teach the retired brand to every new project.
assert(CODEX_README_TEMPLATE.includes('node bin/proof-or-stop-codex.js session_brief'), 'template missing preferred wrapper command');
assert(CODEX_README_TEMPLATE.includes(`${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`), 'template missing fallback command');
assert(CODEX_README_TEMPLATE.includes(LOCAL_CODEX_VERIFY_COMMAND), 'template missing local verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_MAIN_VERIFY_COMMAND), 'template missing main wrapper verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_INIT_VERIFY_COMMAND), 'template missing init verification guidance');
assert(CODEX_README_TEMPLATE.includes('node bin/proof-or-stop-codex.js doctor'), 'template missing Codex doctor guidance');
assertNotIncludes(CODEX_README_TEMPLATE, 'node bin/koala-codex.js', 'template legacy Codex wrapper command');
assertNotIncludes(CODEX_README_TEMPLATE, '.proof-or-stop-codex/koala.json', 'template legacy Codex manifest');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala verify_codex`', 'template bare global verify guidance');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala init --verify-codex`', 'template bare global init guidance');
assert(renderProofOrStopCodexAdapterManifest().includes('"activitySource": "codex"'), 'manifest template missing codex source');
assert(renderProofOrStopCodexAdapterManifest().includes(LOCAL_CODEX_VERIFY_COMMAND), 'Proof-or-Stop manifest template missing local wrapper note');
assertNotIncludes(renderProofOrStopCodexAdapterManifest(), 'koala-codex', 'Proof-or-Stop manifest legacy wrapper note');
assertNotIncludes(renderProofOrStopCodexAdapterManifest(), '.lattice-codex/koala.json', 'Proof-or-Stop manifest legacy manifest note');

// Active verifier paths are canonical. Legacy adapter paths are exercised only
// by the explicit read-compatibility fixture below.
const codexReadme = readFileSync(join(root, canonicalCodexDir, 'README.md'), 'utf8');
const manifest = readFileSync(join(root, canonicalCodexManifest), 'utf8');
const rootReadme = readFileSync(join(root, 'README.md'), 'utf8');
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');

const verificationIntentEntry = readPromptRegistry().agents.find(
  (entry) => entry.agentId === 'proof-or-stop-verification-intent',
);
assert(verificationIntentEntry, 'prompt registry must expose the canonical verification-intent role');
const verificationIntentRender = renderPromptEntryForHost(verificationIntentEntry, 'claude');
assert(verificationIntentRender.includes('verificationIntent'), 'prompt render must describe verificationIntent');
assert(verificationIntentRender.includes('checklist_update'), 'prompt render must describe checklist_update');
assert(!/proof-or-stop-test-intent|proof-or-stop-test-case-reviewer|testIntent|testintent_/.test(verificationIntentRender), 'active prompt must not teach legacy role or field guidance');
assert(
  verificationIntentRender === readFileSync(join(root, '.claude', 'agents', verificationIntentEntry.file), 'utf8'),
  'canonical verification-intent prompt render must remain byte-identical to the Claude mirror',
);

assert(codexReadme === renderCodexReadmeTemplate('full', 'lattice'), `${canonicalCodexDir}/README.md drifted from canonical template`);
assert(manifest === renderProofOrStopCodexAdapterManifest(), `${canonicalCodexManifest} drifted from canonical template`);
assertIncludes(codexReadme, LOCAL_CODEX_VERIFY_COMMAND, `${canonicalCodexDir}/README.md`);
assertIncludes(codexReadme, 'node bin/proof-or-stop-codex.js doctor', `${canonicalCodexDir}/README.md`);
assertNotIncludes(codexReadme, 'node bin/koala-codex.js', `${canonicalCodexDir}/README.md`);
assertNotIncludes(codexReadme, '.lattice-codex/koala.json', `${canonicalCodexDir}/README.md`);
assertNotIncludes(codexReadme, '`koala verify_codex`', `${canonicalCodexDir}/README.md`);
assertNotIncludes(codexReadme, '`koala init --verify-codex`', `${canonicalCodexDir}/README.md`);
// README.md carries NO Codex-adapter command citations (verified: `grep -ci codex README.md`
// is 0, and has been since before B-cdf6 — the two `assertIncludes(rootReadme, ...)` checks
// that used to sit here asserted content the file never had, so this script was already red
// on baseline. It is not in the `npm test` chain, which is why nobody saw it.) Only the
// negative legacy-brand assertions are meaningful for README.md, so only those are kept:
// re-adding a positive assertion would require inventing README content this story does not own.
assertNotIncludes(rootReadme, '`koala verify_codex`', 'README.md');
assertNotIncludes(rootReadme, '`koala init --verify-codex`', 'README.md');
assertIncludes(agents, LOCAL_MAIN_VERIFY_COMMAND, 'AGENTS.md');
assertIncludes(agents, 'node bin/proof-or-stop.js doctor', 'AGENTS.md');
assertNotIncludes(agents, '`koala verify_codex`', 'AGENTS.md');
assertNotIncludes(agents, '`koala init --verify-codex`', 'AGENTS.md');

function writeTempConfig(dir) {
  writeFileSync(join(dir, PROOF_OR_STOP_CONFIG_FILENAME), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: `${PROOF_OR_STOP_STATE_DIR}/story/actives`,
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
}

function copyCodexAssetsToTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-codex-assets-'));
  writeTempConfig(dir);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const rel of [
    canonicalCodexDir,
    '.codex',
    '.claude',
    'bin/proof-or-stop-codex.js',
    'bin/proof-or-stop.js',
    'bin/bootstrap-runner.js',
    'README.md',
    'AGENTS.md',
  ]) {
    cpSync(join(root, rel), join(dir, rel), { recursive: true });
  }
  return dir;
}

function hardFailureIds(checkResult) {
  return checkResult.checks
    .filter(check => check.hard && check.status === 'fail')
    .map(check => check.id);
}

function assertCheckFails(mutator, expectedId, label) {
  const dir = copyCodexAssetsToTemp();
  try {
    mutator(dir);
    const checkResult = runCodexAdapterChecks(dir, { executeHeartbeats: false });
    const ids = hardFailureIds(checkResult);
    assert(!checkResult.ok, `${label} should fail Codex adapter checks`);
    assert(ids.includes(expectedId), `${label} should fail ${expectedId}, got ${ids.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

assertCheckFails(
  (dir) => writeFileSync(join(dir, canonicalCodexManifest), '{}\n'),
  'manifest',
  'manifest drift',
);

// Explicit read-compatibility fixture: a pre-migration checkout may still
// contain the deprecated adapter directory and manifest filename. The active
// repository remains canonical; this fixture proves the shared verifier does
// not silently drop that supported legacy layout.
{
  const dir = copyCodexAssetsToTemp();
  try {
    const canonicalDir = join(dir, canonicalCodexDir);
    const legacyDir = join(dir, legacyCodexDir);
    mkdirSync(legacyDir, { recursive: true });
    cpSync(join(canonicalDir, 'README.md'), join(legacyDir, 'README.md'));
    cpSync(join(canonicalDir, 'agents'), join(legacyDir, 'agents'), { recursive: true });
    cpSync(join(canonicalDir, PROOF_OR_STOP_MANIFEST_FILENAME), join(dir, legacyCodexManifest));
    rmSync(canonicalDir, { recursive: true, force: true });
    const checkResult = runCodexAdapterChecks(dir, { executeHeartbeats: false });
    assert(checkResult.ok, `legacy adapter directory/manifest read fallback should pass: ${hardFailureIds(checkResult).join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = copyCodexAssetsToTemp();
  try {
    const checkResult = runCodexAdapterChecks(dir, { executeHeartbeats: false });
    const exclusions = checkResult.checks.find(check => check.id === 'excluded-assets');
    const nativeHooks = checkResult.checks.find(check => check.id === 'codex-native-hooks');
    assert(
      checkResult.ok,
      `managed Codex native hooks should pass adapter checks: ${hardFailureIds(checkResult).join(', ')}\n${renderCodexAdapterChecks(checkResult)}`,
    );
    assert(exclusions?.status === 'pass', `managed Codex native hooks should not count as excluded assets: ${exclusions?.detail}`);
    assert(nativeHooks?.status === 'pass', `Codex native hook check should pass: ${nativeHooks?.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
assertCheckFails(
  (dir) => writeFileSync(join(dir, canonicalCodexDir, 'settings.json'), '{}\n'),
  'excluded-assets',
  `forbidden ${canonicalCodexDir}/settings.json`,
);
assertCheckFails(
  (dir) => {
    rmSync(join(dir, 'bin', 'proof-or-stop.js'), { force: true });
  },
  'local-wrapper',
  'missing canonical sibling local bootstrap',
);
// Positive counterpart: dropping ONLY the deprecated alias keeps the adapter healthy.
{
  const dir = copyCodexAssetsToTemp();
  try {
    rmSync(join(dir, 'bin', 'lattice.js'), { force: true });
    rmSync(join(dir, 'bin', 'lattice-codex.js'), { force: true });
    const checkResult = runCodexAdapterChecks(dir, { executeHeartbeats: false });
    assert(
      checkResult.ok,
      `canonical-only bin/ should pass adapter checks: ${hardFailureIds(checkResult).join(', ')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// B-cc10 CHK-007: a PRE-RENAME checkout with ONLY the removed executable surface must
// not be treated as a supported local-wrapper layout. The read-only legacy adapter
// directory/manifest is covered above; these deprecated bin wrappers are intentionally
// a hard failure so the verifier cannot silently endorse a command surface we no longer
// ship.
assertCheckFails(
  (dir) => {
    rmSync(join(dir, 'bin', 'proof-or-stop.js'), { force: true });
    rmSync(join(dir, 'bin', 'proof-or-stop-codex.js'), { force: true });
    writeFileSync(join(dir, 'bin', 'lattice-codex.js'), '// removed deprecated Codex wrapper\n');
    writeFileSync(join(dir, 'bin', 'lattice.js'), '// removed deprecated bootstrap\n');
  },
  'local-wrapper',
  'deprecated-only executable surface is rejected',
);

{
  const dir = copyCodexAssetsToTemp();
  const fakeBin = mkdtempSync(join(tmpdir(), 'lattice-codex-stale-global-bin-'));
  const fakeGlobalRoot = mkdtempSync(join(tmpdir(), 'lattice-codex-stale-global-root-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'lattice-codex-stale-global-home-'));
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  try {
    mkdirSync(join(dir, 'packages', 'main'), { recursive: true });
    const fakeCanonicalCore = join(fakeGlobalRoot, '@proof-or-stop', 'core');
    const fakeDeprecatedCore = join(fakeGlobalRoot, '@lattice', 'core');
    const fakeCanonicalBin = join(fakeCanonicalCore, 'bin');
    const fakeDeprecatedBin = join(fakeDeprecatedCore, 'bin');
    mkdirSync(fakeCanonicalBin, { recursive: true });
    mkdirSync(fakeDeprecatedBin, { recursive: true });
    writeFileSync(join(fakeCanonicalBin, 'proof-or-stop'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeCanonicalBin, 'proof-or-stop'), 0o755);
    writeFileSync(join(fakeDeprecatedBin, 'lattice'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeDeprecatedBin, 'lattice'), 0o755);
    writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n  printf '%s\\n' '${fakeGlobalRoot}'\n  exit 0\nfi\nexit 1\n`);
    chmodSync(join(fakeBin, 'npm'), 0o755);
    // resolveGlobalCliCommandPath uses a login shell on macOS. Give that shell a
    // hermetic profile, otherwise the host's real proof-or-stop command wins before
    // this fixture's fake global install and the stale-global branch is never tested.
    writeFileSync(
      join(fakeHome, '.profile'),
      `PATH='${fakeBin}:${fakeCanonicalBin}:${fakeDeprecatedBin}:/usr/bin:/bin'\nexport PATH\n`,
    );
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBin}:${fakeCanonicalBin}:${fakeDeprecatedBin}:/usr/bin:/bin`;

    function assertStaleGlobalFallbackWarn(label) {
      const checkResult = runCodexAdapterChecks(dir, {
        executeLocalHeartbeat: false,
        executeGlobalHeartbeat: true,
        timeoutMs: 5_000,
      });
      const globalCheck = checkResult.checks.find(check => check.id === 'global-fallback-heartbeat');
      assert(globalCheck, `${label}: stale global fallback check should be present`);
      assert(globalCheck.status === 'warn', `${label}: stale global fallback should warn, got ${globalCheck.status}`);
      assert(globalCheck.hard === false, `${label}: stale global fallback warning must remain advisory`);
      assert(
        globalCheck.detail.includes('not current worktree') && globalCheck.detail.includes('heartbeat-only'),
        `${label}: stale global fallback warning should explain current-worktree boundary: ${globalCheck.detail}`,
      );
      assert(
        hardFailureIds(checkResult).length === 0,
        `${label}: stale global fallback warning must not mask hard failures: ${hardFailureIds(checkResult).join(', ')}`,
      );
      assert(checkResult.ok, `${label}: stale global fallback warning should not be a hard failure`);
    }

    // The current canonical global install wins when both names are present.
    assertStaleGlobalFallbackWarn('canonical global fallback');

    // A pre-migration install exposing only the deprecated global CLI is still
    // read-compatible, but its stale heartbeat remains advisory rather than proof.
    rmSync(fakeCanonicalCore, { recursive: true, force: true });
    assertStaleGlobalFallbackWarn('deprecated global fallback');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(fakeGlobalRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = copyCodexAssetsToTemp();
  const previousPackaged = process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME;
  const previousPath = process.env.PATH;
  try {
    process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME = '1';
    process.env.PATH = '/definitely-no-global-koala';
    const checkResult = runCodexAdapterChecks(dir, {
      executeLocalHeartbeat: false,
      executeGlobalHeartbeat: true,
      timeoutMs: 1_000,
    });
    const globalCheck = checkResult.checks.find(check => check.id === 'global-fallback-heartbeat');
    assert(globalCheck, 'packaged global fallback check should be present');
    assert(globalCheck.status === 'warn', `packaged global fallback should warn, got ${globalCheck.status}`);
    assert(globalCheck.hard === false, 'packaged global fallback should not be hard');
    assertIncludes(globalCheck.detail || '', 'skipped in packaged desktop runtime', 'packaged global fallback detail');
    assert(checkResult.ok, 'packaged global fallback warning should not be a hard failure');
  } finally {
    if (previousPackaged === undefined) delete process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME;
    else process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME = previousPackaged;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertGlobalFallbackHeartbeatIgnoresParentCodexEntrypoint() {
  const fakeBin = mkdtempSync(join(tmpdir(), 'proof-or-stop-codex-fake-global-'));
  const previousPath = process.env.PATH;
  const previousEntrypoint = process.env.PROOF_OR_STOP_CODEX_ENTRYPOINT;
  try {
    const fakeCli = join(fakeBin, 'proof-or-stop');
    writeFileSync(
      fakeCli,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'packages/main/dist/cli.js'))} "$@"\n`,
    );
    chmodSync(fakeCli, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath || ''}`;
    process.env.PROOF_OR_STOP_CODEX_ENTRYPOINT = 'local-wrapper';

    // B-cdf6 (B-META F-013): this assertion runs the REAL `session_brief` against this
    // repository, whose cost scales with the number of active stories. Under the bare
    // 30s default it was already being KILLED here (the whole point of F-013), so the
    // check must be armed with the bounded, attributed override — otherwise this test
    // fails for repository scale rather than for the entrypoint behaviour it asserts.
    // The assertion itself is unchanged: the heartbeat must still genuinely pass.
    const checkResult = runCodexAdapterChecks(root, {
      executeHeartbeats: true,
      heartbeatTimeoutMs: Math.min(300_000, GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS),
      heartbeatTimeoutReason:
        'verify-codex-assets runs the real session_brief against this large self-host repo, whose aggregation cost exceeds the default heartbeat budget.',
    });
    if (!checkResult.ok) {
      console.error(renderCodexAdapterChecks(checkResult));
    }
    assert(checkResult.ok, 'global fallback heartbeat should override inherited local-wrapper entrypoint');
    const globalHeartbeat = checkResult.checks.find(check => check.id === 'global-fallback-heartbeat');
    assert(globalHeartbeat?.status === 'pass', 'global fallback heartbeat should pass');
    assertIncludes(globalHeartbeat.detail || '', 'entrypoint=global-fallback', 'global fallback heartbeat detail');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousEntrypoint === undefined) delete process.env.PROOF_OR_STOP_CODEX_ENTRYPOINT;
    else process.env.PROOF_OR_STOP_CODEX_ENTRYPOINT = previousEntrypoint;
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

assertGlobalFallbackHeartbeatIgnoresParentCodexEntrypoint();

// resolveCodexSessionBriefCommand: explicit wrapper candidate mapping tests
function assertSessionBriefCommand(setup, expectedCommand, label) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-session-brief-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    setup(dir);
    const cmd = resolveCodexSessionBriefCommand(dir);
    assert(cmd === expectedCommand, `${label}: expected "${expectedCommand}", got "${cmd}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Canonical wrapper names (B-cdf6) ---
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'proof-or-stop-codex.js'), '// codex wrapper'),
  'node bin/proof-or-stop-codex.js session_brief',
  'canonical codex wrapper resolves to proof-or-stop-codex session_brief',
);
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'proof-or-stop.js'), '// bootstrap'),
  'node bin/proof-or-stop.js session_brief',
  'canonical bootstrap-only fallback resolves to proof-or-stop session_brief',
);

// --- Legacy koala names are still ignored; the default is now the canonical wrapper. ---
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'koala-codex.js'), '// koala-codex wrapper'),
  'node bin/proof-or-stop-codex.js session_brief',
  'legacy koala-codex wrapper is ignored by session_brief resolver',
);
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'koala.js'), '// koala bootstrap'),
  'node bin/proof-or-stop-codex.js session_brief',
  'legacy koala.js is ignored by session_brief resolver',
);

function assertGlobalThinSessionBriefCommand(stateDir, manifestFilename, label) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-session-brief-global-thin-'));
  try {
    mkdirSync(join(dir, stateDir), { recursive: true });
    writeFileSync(join(dir, stateDir, manifestFilename), JSON.stringify({ assetMode: 'global-thin' }));
    const cmd = resolveCodexSessionBriefCommand(dir);
    const expected = `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`;
    assert(cmd === expected, `${label}: expected "${expected}", got "${cmd}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

assertGlobalThinSessionBriefCommand(
  PROOF_OR_STOP_STATE_DIR,
  PROOF_OR_STOP_MANIFEST_FILENAME,
  'canonical global-thin layout resolves to fallback command',
);
assertGlobalThinSessionBriefCommand(
  DEPRECATED_STATE_DIR,
  DEPRECATED_MANIFEST_FILENAME,
  'legacy global-thin layout remains a read-only fallback',
);

function seedCodexStory(dir) {
  mkdirSync(join(dir, PROOF_OR_STOP_STATE_DIR, 'story', 'actives'), { recursive: true });
  const store = new StoryStore(dir);
  const now = new Date().toISOString();
  store.writeStory('B-codex', {
    storyId: 'B-codex',
    name: 'codex',
    title: 'Codex adapter gate',
    description: 'Codex adapter verification story',
    type: 'bug',
    phase: 'REVIEW',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  });
  store.writeChecklist('B-codex', {
    items: [{
      id: 'CHK-001',
      title: 'Verify Codex adapter evidence',
      context: 'Codex adapter evidence must be fresh',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  });
  return store;
}

function assertGateStatus(setup, expectedStatus, label) {
  const dir = copyCodexAssetsToTemp();
  try {
    const store = seedCodexStory(dir);
    setup(dir, store);
    const gate = summarizeCodexEvidence(store, 'B-codex', dir);
    assert(gate.status === expectedStatus, `${label} expected ${expectedStatus}, got ${gate.status}: ${gate.detail}`);
    if (expectedStatus !== 'passing') {
      assert(gate.command === LOCAL_CODEX_VERIFY_COMMAND, `${label} should remediate with resolved proof-or-stop wrapper command, got: ${gate.command}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

assertGateStatus(() => {}, 'missing', 'missing Codex gate evidence');
assertGateStatus((_dir, store) => {
  store.appendProcessEvent('B-codex', {
    type: 'codex_adapter_verification',
    storyId: 'B-codex',
    command: LOCAL_CODEX_VERIFY_COMMAND,
    result: 'fail',
    summary: 'Codex adapter checks failed',
  });
}, 'failing', 'failing Codex gate evidence');
assertGateStatus((_dir, store) => {
  store.appendProcessEvent('B-codex', {
    type: 'codex_adapter_verification',
    storyId: 'B-codex',
    command: LOCAL_CODEX_VERIFY_COMMAND,
    result: 'pass',
    summary: 'legacy pass without material hash',
  });
}, 'stale', 'legacy Codex gate evidence without material hash');
assertGateStatus((dir, store) => {
  const snapshot = computeCodexAdapterMaterialSnapshot(dir);
  store.appendProcessEvent('B-codex', {
    type: 'codex_adapter_verification',
    storyId: 'B-codex',
    command: LOCAL_CODEX_VERIFY_COMMAND,
    result: 'pass',
    summary: 'fresh pass before later adapter edit',
    headHash: snapshot.headHash,
    materialHash: snapshot.materialHash,
  });
  writeFileSync(join(dir, canonicalCodexDir, 'README.md'), `${codexReadme}\npost verification drift\n`);
}, 'stale', 'post-verification Codex adapter edit');
assertGateStatus((dir, store) => {
  const snapshot = computeCodexAdapterMaterialSnapshot(dir);
  store.appendProcessEvent('B-codex', {
    type: 'codex_adapter_verification',
    storyId: 'B-codex',
    command: LOCAL_CODEX_VERIFY_COMMAND,
    result: 'pass',
    summary: 'fresh pass',
    headHash: snapshot.headHash,
    materialHash: snapshot.materialHash,
  });
}, 'passing', 'fresh Codex gate evidence');

console.log(renderCodexAdapterChecks(result));
console.log('codex assets verified');
