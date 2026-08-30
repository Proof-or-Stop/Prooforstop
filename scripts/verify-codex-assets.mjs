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
  renderLatticeCodexAdapterManifest,
} from '../packages/main/dist/init-assets.js';
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
const result = runCodexAdapterChecks(root, { executeHeartbeats: false });
if (!result.ok) {
  console.error(renderCodexAdapterChecks(result));
  process.exit(1);
}

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
// deprecated `bin/lattice-codex.js` alias — a fresh init that still printed the old name
// would teach the retired brand to every new project.
assert(CODEX_README_TEMPLATE.includes('node bin/proof-or-stop-codex.js session_brief'), 'template missing preferred wrapper command');
assertNotIncludes(CODEX_README_TEMPLATE, 'node bin/lattice-codex.js session_brief', 'template deprecated wrapper invocation');
assert(CODEX_README_TEMPLATE.includes(`${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`), 'template missing fallback command');
assert(CODEX_README_TEMPLATE.includes(LOCAL_CODEX_VERIFY_COMMAND), 'template missing local verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_MAIN_VERIFY_COMMAND), 'template missing main wrapper verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_INIT_VERIFY_COMMAND), 'template missing init verification guidance');
assert(CODEX_README_TEMPLATE.includes('node bin/proof-or-stop-codex.js doctor'), 'template missing Codex doctor guidance');
assertNotIncludes(CODEX_README_TEMPLATE, 'node bin/koala-codex.js', 'template legacy Codex wrapper command');
assertNotIncludes(CODEX_README_TEMPLATE, '.lattice-codex/koala.json', 'template legacy Codex manifest');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala verify_codex`', 'template bare global verify guidance');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala init --verify-codex`', 'template bare global init guidance');
assert(renderLatticeCodexAdapterManifest().includes('"activitySource": "codex"'), 'manifest template missing codex source');
assert(renderLatticeCodexAdapterManifest().includes(LOCAL_CODEX_VERIFY_COMMAND), 'proof-or-stop manifest template missing local wrapper note');
assertNotIncludes(renderLatticeCodexAdapterManifest(), 'koala-codex', 'proof-or-stop manifest legacy wrapper note');
assertNotIncludes(renderLatticeCodexAdapterManifest(), '.lattice-codex/koala.json', 'proof-or-stop manifest legacy manifest note');

const codexReadme = readFileSync(join(root, '.lattice-codex', 'README.md'), 'utf8');
const manifest = readFileSync(join(root, '.lattice-codex', 'lattice.json'), 'utf8');
const rootReadme = readFileSync(join(root, 'README.md'), 'utf8');
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');

assert(codexReadme === renderCodexReadmeTemplate('full', 'lattice'), '.lattice-codex/README.md drifted from proof-or-stop template');
assert(manifest === renderLatticeCodexAdapterManifest(), '.lattice-codex/lattice.json drifted from template');
assertIncludes(codexReadme, LOCAL_CODEX_VERIFY_COMMAND, '.lattice-codex/README.md');
assertIncludes(codexReadme, 'node bin/proof-or-stop-codex.js doctor', '.lattice-codex/README.md');
assertNotIncludes(codexReadme, 'node bin/koala-codex.js', '.lattice-codex/README.md');
assertNotIncludes(codexReadme, '.lattice-codex/koala.json', '.lattice-codex/README.md');
assertNotIncludes(codexReadme, '`koala verify_codex`', '.lattice-codex/README.md');
assertNotIncludes(codexReadme, '`koala init --verify-codex`', '.lattice-codex/README.md');
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
  writeFileSync(join(dir, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
}

function copyCodexAssetsToTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-codex-assets-'));
  writeTempConfig(dir);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const rel of [
    '.lattice-codex',
    '.codex',
    '.claude',
    'bin/proof-or-stop-codex.js',
    'bin/proof-or-stop.js',
    // B-cc10 CHK-006: `bin/lattice-codex.js` / `bin/lattice.js` were deleted, so copying
    // them here would throw ENOENT before any assertion ran.
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
  (dir) => writeFileSync(join(dir, '.lattice-codex', 'lattice.json'), '{}\n'),
  'manifest',
  'manifest drift',
);
{
  const dir = copyCodexAssetsToTemp();
  try {
    const checkResult = runCodexAdapterChecks(dir, { executeHeartbeats: false });
    const exclusions = checkResult.checks.find(check => check.id === 'excluded-assets');
    const nativeHooks = checkResult.checks.find(check => check.id === 'codex-native-hooks');
    assert(checkResult.ok, 'managed Codex native hooks should pass adapter checks');
    assert(exclusions?.status === 'pass', `managed Codex native hooks should not count as excluded assets: ${exclusions?.detail}`);
    assert(nativeHooks?.status === 'pass', `Codex native hook check should pass: ${nativeHooks?.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
assertCheckFails(
  (dir) => writeFileSync(join(dir, '.lattice-codex', 'settings.json'), '{}\n'),
  'excluded-assets',
  'forbidden .lattice-codex/settings.json',
);
// B-cdf6: the bootstrap sibling may be named `proof-or-stop.js` (canonical) OR
// `lattice.js` (retained deprecated alias), so the adapter check only fails when NO
// bootstrap name is present. Removing just one must NOT fail — that is the additive
// compat property — so this negative test removes both.
assertCheckFails(
  (dir) => {
    rmSync(join(dir, 'bin', 'proof-or-stop.js'), { force: true });
    rmSync(join(dir, 'bin', 'lattice.js'), { force: true });
  },
  'local-wrapper',
  'missing sibling local bootstrap under every accepted name',
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
// Additive compat counterpart: a PRE-RENAME checkout has ONLY the deprecated wrapper
// names, and its `bin/lattice-codex.js` is SELF-CONTAINED (it carries the full env block
// rather than delegating, because the canonical file did not exist yet). That is the state
// a teammate branch merges in with, and it must still pass — otherwise the rename would
// surface as a build break in THEIR branch.
//
// Note this is deliberately not "delete the canonical files from this repo's bin/": that
// would leave this repo's thin delegating alias pointing at a missing target, which is a
// state no checkout is ever actually in.
{
  const dir = copyCodexAssetsToTemp();
  try {
    rmSync(join(dir, 'bin', 'proof-or-stop.js'), { force: true });
    rmSync(join(dir, 'bin', 'proof-or-stop-codex.js'), { force: true });
    writeFileSync(
      join(dir, 'bin', 'lattice-codex.js'),
      [
        "#!/usr/bin/env node",
        "process.env.LATTICE_ACTIVITY_SOURCE = 'codex';",
        "process.env.LATTICE_ACTIVITY_RECORD_READONLY = '1';",
        "process.env.LATTICE_CODEX_ENTRYPOINT = 'local-wrapper';",
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'bin', 'lattice.js'), '// pre-rename local bootstrap\n');
    const checkResult = runCodexAdapterChecks(dir, { executeHeartbeats: false });
    assert(
      checkResult.ok,
      `pre-rename deprecated-alias-only bin/ must still pass adapter checks: ${hardFailureIds(checkResult).join(', ')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = copyCodexAssetsToTemp();
  const fakeBin = mkdtempSync(join(tmpdir(), 'lattice-codex-stale-global-bin-'));
  const fakeGlobalRoot = mkdtempSync(join(tmpdir(), 'lattice-codex-stale-global-root-'));
  const previousPath = process.env.PATH;
  try {
    mkdirSync(join(dir, 'packages', 'main'), { recursive: true });
    const fakeGlobalCore = join(fakeGlobalRoot, '@lattice', 'core');
    mkdirSync(join(fakeGlobalCore, 'bin'), { recursive: true });
    writeFileSync(join(fakeGlobalCore, 'bin', 'lattice'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeGlobalCore, 'bin', 'lattice'), 0o755);
    writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n  printf '%s\\n' '${fakeGlobalRoot}'\n  exit 0\nfi\nexit 1\n`);
    chmodSync(join(fakeBin, 'npm'), 0o755);
    process.env.PATH = `${fakeBin}:${join(fakeGlobalCore, 'bin')}:${previousPath || ''}`;
    const checkResult = runCodexAdapterChecks(dir, {
      executeLocalHeartbeat: false,
      executeGlobalHeartbeat: true,
      timeoutMs: 5_000,
    });
    const globalCheck = checkResult.checks.find(check => check.id === 'global-fallback-heartbeat');
    assert(globalCheck, 'stale global fallback check should be present');
    assert(globalCheck.status === 'warn', `stale global fallback should warn, got ${globalCheck.status}`);
    assert(
      globalCheck.detail.includes('not current worktree') && globalCheck.detail.includes('heartbeat-only'),
      `stale global fallback warning should explain current-worktree boundary: ${globalCheck.detail}`,
    );
    assert(checkResult.ok, 'stale global fallback warning should not be a hard failure');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(fakeGlobalRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = copyCodexAssetsToTemp();
  const previousPackaged = process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME;
  const previousPath = process.env.PATH;
  try {
    process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME = '1';
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
    if (previousPackaged === undefined) delete process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME;
    else process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME = previousPackaged;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertGlobalFallbackHeartbeatIgnoresParentCodexEntrypoint() {
  const fakeBin = mkdtempSync(join(tmpdir(), 'lattice-codex-fake-global-'));
  const previousPath = process.env.PATH;
  const previousEntrypoint = process.env.LATTICE_CODEX_ENTRYPOINT;
  try {
    const fakeCli = join(fakeBin, 'lattice');
    writeFileSync(
      fakeCli,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'packages/main/dist/cli.js'))} "$@"\n`,
    );
    chmodSync(fakeCli, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath || ''}`;
    process.env.LATTICE_CODEX_ENTRYPOINT = 'local-wrapper';

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
    if (previousEntrypoint === undefined) delete process.env.LATTICE_CODEX_ENTRYPOINT;
    else process.env.LATTICE_CODEX_ENTRYPOINT = previousEntrypoint;
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

assertGlobalFallbackHeartbeatIgnoresParentCodexEntrypoint();

// resolveCodexSessionBriefCommand: explicit wrapper candidate mapping tests
function assertSessionBriefCommand(setup, expectedCommand, label) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-session-brief-'));
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

// --- B-cc10 CHK-006: the deprecated wrapper names are REMOVED from the resolver.
// B-cdf6 asserted the opposite (a checkout holding ONLY an old name was told to run that
// old name). Now that the aliases are deleted, a directory holding only a deprecated name
// is an unsupported layout, and the resolver must name the CANONICAL wrapper rather than
// endorsing a retired one — pointing an operator at `bin/lattice-codex.js` would be
// pointing them at a file this project no longer ships. ---
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'lattice-codex.js'), '// lattice-codex wrapper'),
  'node bin/proof-or-stop-codex.js session_brief',
  'deprecated lattice-codex wrapper no longer resolves to itself',
);
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'lattice.js'), '// proof-or-stop bootstrap'),
  'node bin/proof-or-stop-codex.js session_brief',
  'deprecated lattice.js-only layout no longer resolves to itself',
);

// --- Canonical wins when BOTH names are present. (This was the state of this repo until
// B-cc10 CHK-006 deleted the aliases; it remains a valid downstream-project layout.) ---
assertSessionBriefCommand(
  (dir) => {
    writeFileSync(join(dir, 'bin', 'proof-or-stop-codex.js'), '// codex wrapper');
    writeFileSync(join(dir, 'bin', 'lattice-codex.js'), '// deprecated alias');
  },
  'node bin/proof-or-stop-codex.js session_brief',
  'canonical wrapper wins over the retained deprecated alias',
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

{
  const dir = mkdtempSync(join(tmpdir(), 'lattice-session-brief-global-thin-'));
  try {
    mkdirSync(join(dir, '.lattice'), { recursive: true });
    writeFileSync(join(dir, '.lattice', 'lattice.json'), JSON.stringify({ assetMode: 'global-thin' }));
    const cmd = resolveCodexSessionBriefCommand(dir);
    const expected = `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`;
    assert(cmd === expected, `global-thin resolves to fallback command: expected "${expected}", got "${cmd}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedCodexStory(dir) {
  mkdirSync(join(dir, '.lattice', 'story', 'actives'), { recursive: true });
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
  writeFileSync(join(dir, '.lattice-codex', 'README.md'), `${codexReadme}\npost verification drift\n`);
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
