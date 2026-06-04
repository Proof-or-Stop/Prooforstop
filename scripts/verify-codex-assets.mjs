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
  renderCodexAdapterManifest,
  renderCodexReadmeTemplate,
  renderLatticeCodexAdapterManifest,
} from '../packages/main/dist/init-assets.js';
import {
  computeCodexAdapterMaterialSnapshot,
  GLOBAL_CODEX_FALLBACK_COMMAND,
  LEGACY_LOCAL_CODEX_VERIFY_COMMAND,
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

// CODEX_README_TEMPLATE is lattice-branded (default export); check for lattice wrapper commands
assert(CODEX_README_TEMPLATE.includes('node bin/lattice-codex.js session_brief'), 'template missing preferred wrapper command');
assert(CODEX_README_TEMPLATE.includes(`${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`), 'template missing fallback command');
assert(CODEX_README_TEMPLATE.includes(LOCAL_CODEX_VERIFY_COMMAND), 'template missing local verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_MAIN_VERIFY_COMMAND), 'template missing main wrapper verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_INIT_VERIFY_COMMAND), 'template missing init verification guidance');
assert(CODEX_README_TEMPLATE.includes('node bin/lattice-codex.js doctor'), 'template missing Codex doctor guidance');
// Legacy koala-branded template also contains the koala-codex wrapper commands
const koalaTemplate = renderCodexReadmeTemplate('full', 'koala');
assert(koalaTemplate.includes('node bin/koala-codex.js session_brief'), 'koala template missing preferred wrapper command');
assert(koalaTemplate.includes('node bin/koala-codex.js doctor'), 'koala template missing Codex doctor guidance');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala verify_codex`', 'template bare global verify guidance');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala init --verify-codex`', 'template bare global init guidance');
assert(renderCodexAdapterManifest().includes('"activitySource": "codex"'), 'manifest template missing codex source');
assert(renderCodexAdapterManifest().includes(LEGACY_LOCAL_CODEX_VERIFY_COMMAND), 'koala manifest template missing legacy local wrapper note');
assert(renderLatticeCodexAdapterManifest().includes(LOCAL_CODEX_VERIFY_COMMAND), 'lattice manifest template missing local wrapper note');

const codexReadme = readFileSync(join(root, '.Codex', 'README.md'), 'utf8');
const manifest = readFileSync(join(root, '.Codex', 'koala.json'), 'utf8');
const rootReadme = readFileSync(join(root, 'README.md'), 'utf8');
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');

// Self-repo uses koala-branded template (bin/koala-codex.js present, not bin/lattice-codex.js)
assert(codexReadme === renderCodexReadmeTemplate('full', 'koala'), '.Codex/README.md drifted from koala template');
assert(manifest === renderCodexAdapterManifest(), '.Codex/koala.json drifted from template');
// Per-file checks: .Codex/README.md and AGENTS.md use legacy koala branding; README.md uses lattice branding
assertIncludes(codexReadme, LEGACY_LOCAL_CODEX_VERIFY_COMMAND, '.Codex/README.md');
assertIncludes(codexReadme, 'node bin/koala-codex.js doctor', '.Codex/README.md');
assertNotIncludes(codexReadme, '`koala verify_codex`', '.Codex/README.md');
assertNotIncludes(codexReadme, '`koala init --verify-codex`', '.Codex/README.md');
assertIncludes(rootReadme, LOCAL_CODEX_VERIFY_COMMAND, 'README.md');
assertIncludes(rootReadme, 'node bin/lattice-codex.js doctor', 'README.md');
assertNotIncludes(rootReadme, '`koala verify_codex`', 'README.md');
assertNotIncludes(rootReadme, '`koala init --verify-codex`', 'README.md');
assertIncludes(agents, LEGACY_LOCAL_CODEX_VERIFY_COMMAND, 'AGENTS.md');
assertIncludes(agents, 'node bin/koala-codex.js doctor', 'AGENTS.md');
assertNotIncludes(agents, '`koala verify_codex`', 'AGENTS.md');
assertNotIncludes(agents, '`koala init --verify-codex`', 'AGENTS.md');

function writeTempConfig(dir) {
  writeFileSync(join(dir, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
}

function copyCodexAssetsToTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'koala-codex-assets-'));
  writeTempConfig(dir);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const rel of [
    '.Codex',
    '.claude',
    'bin/koala-codex.js',
    'bin/koala.js',
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
  (dir) => writeFileSync(join(dir, '.Codex', 'koala.json'), `${renderCodexAdapterManifest()}\n`),
  'manifest',
  'manifest drift',
);
assertCheckFails(
  (dir) => {
    mkdirSync(join(dir, '.Codex', 'hooks'), { recursive: true });
  },
  'excluded-assets',
  'forbidden .Codex/hooks',
);
assertCheckFails(
  (dir) => writeFileSync(join(dir, '.Codex', 'settings.json'), '{}\n'),
  'excluded-assets',
  'forbidden .Codex/settings.json',
);
assertCheckFails(
  (dir) => rmSync(join(dir, 'bin', 'koala.js'), { force: true }),
  'local-wrapper',
  'missing sibling local bootstrap',
);

{
  const dir = copyCodexAssetsToTemp();
  try {
    mkdirSync(join(dir, 'packages', 'main'), { recursive: true });
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
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = copyCodexAssetsToTemp();
  const previousPackaged = process.env.KOALA_DESKTOP_PACKAGED_RUNTIME;
  const previousPath = process.env.PATH;
  try {
    process.env.KOALA_DESKTOP_PACKAGED_RUNTIME = '1';
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
    if (previousPackaged === undefined) delete process.env.KOALA_DESKTOP_PACKAGED_RUNTIME;
    else process.env.KOALA_DESKTOP_PACKAGED_RUNTIME = previousPackaged;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertGlobalFallbackHeartbeatIgnoresParentCodexEntrypoint() {
  const fakeBin = mkdtempSync(join(tmpdir(), 'koala-codex-fake-global-'));
  const previousPath = process.env.PATH;
  const previousEntrypoint = process.env.KOALA_CODEX_ENTRYPOINT;
  try {
    for (const name of ['lattice', 'koala']) {
      const fakeCli = join(fakeBin, name);
      writeFileSync(
        fakeCli,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'packages/main/dist/cli.js'))} "$@"\n`,
      );
      chmodSync(fakeCli, 0o755);
    }
    process.env.PATH = `${fakeBin}:${previousPath || ''}`;
    process.env.KOALA_CODEX_ENTRYPOINT = 'local-wrapper';

    const checkResult = runCodexAdapterChecks(root, { executeHeartbeats: true });
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
    if (previousEntrypoint === undefined) delete process.env.KOALA_CODEX_ENTRYPOINT;
    else process.env.KOALA_CODEX_ENTRYPOINT = previousEntrypoint;
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

assertGlobalFallbackHeartbeatIgnoresParentCodexEntrypoint();

// resolveCodexSessionBriefCommand: explicit wrapper candidate mapping tests
function assertSessionBriefCommand(setup, expectedCommand, label) {
  const dir = mkdtempSync(join(tmpdir(), 'koala-session-brief-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    setup(dir);
    const cmd = resolveCodexSessionBriefCommand(dir);
    assert(cmd === expectedCommand, `${label}: expected "${expectedCommand}", got "${cmd}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'lattice-codex.js'), '// lattice-codex wrapper'),
  'node bin/lattice-codex.js session_brief',
  'lattice wrapper resolves to lattice-codex session_brief',
);
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'koala-codex.js'), '// koala-codex wrapper'),
  'node bin/koala-codex.js session_brief',
  'legacy koala-codex wrapper resolves to koala-codex session_brief',
);
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'lattice.js'), '// lattice bootstrap'),
  'node bin/lattice.js session_brief',
  'lattice.js-only fallback resolves to lattice session_brief',
);
assertSessionBriefCommand(
  (dir) => writeFileSync(join(dir, 'bin', 'koala.js'), '// koala bootstrap'),
  'node bin/koala.js session_brief',
  'koala.js-only fallback resolves to koala session_brief',
);

{
  const dir = mkdtempSync(join(tmpdir(), 'koala-session-brief-global-thin-'));
  try {
    mkdirSync(join(dir, '.Lattice'), { recursive: true });
    writeFileSync(join(dir, '.Lattice', 'lattice.json'), JSON.stringify({ assetMode: 'global-thin' }));
    const cmd = resolveCodexSessionBriefCommand(dir);
    const expected = `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`;
    assert(cmd === expected, `global-thin resolves to fallback command: expected "${expected}", got "${cmd}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedCodexStory(dir) {
  mkdirSync(join(dir, '.koala', 'story', 'actives'), { recursive: true });
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
      // temp dir has bin/koala-codex.js (legacy); resolver returns the legacy command
      assert(gate.command === LEGACY_LOCAL_CODEX_VERIFY_COMMAND, `${label} should remediate with resolved legacy wrapper command, got: ${gate.command}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertGateStatusLattice(setup, expectedStatus, label) {
  const dir = copyCodexAssetsToTemp();
  try {
    // Add bin/lattice-codex.js so resolver prefers the lattice wrapper
    writeFileSync(join(dir, 'bin', 'lattice-codex.js'), readFileSync(join(root, 'bin', 'koala-codex.js'), 'utf8'));
    const store = seedCodexStory(dir);
    setup(dir, store);
    const gate = summarizeCodexEvidence(store, 'B-codex', dir);
    assert(gate.status === expectedStatus, `${label} expected ${expectedStatus}, got ${gate.status}: ${gate.detail}`);
    if (expectedStatus !== 'passing') {
      // Lattice wrapper present; resolver returns LOCAL_CODEX_VERIFY_COMMAND
      assert(gate.command === LOCAL_CODEX_VERIFY_COMMAND, `${label} should remediate with resolved lattice wrapper command, got: ${gate.command}`);
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
  writeFileSync(join(dir, '.Codex', 'README.md'), `${codexReadme}\npost verification drift\n`);
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

// Resolver regression: lattice wrapper repo should use LOCAL_CODEX_VERIFY_COMMAND (node bin/lattice-codex.js verify_codex)
assertGateStatusLattice(() => {}, 'missing', 'lattice repo missing Codex gate evidence');
assertGateStatusLattice((dir, store) => {
  const snapshot = computeCodexAdapterMaterialSnapshot(dir);
  store.appendProcessEvent('B-codex', {
    type: 'codex_adapter_verification',
    storyId: 'B-codex',
    command: LOCAL_CODEX_VERIFY_COMMAND,
    result: 'pass',
    summary: 'fresh pass lattice repo',
    headHash: snapshot.headHash,
    materialHash: snapshot.materialHash,
  });
}, 'passing', 'lattice repo fresh Codex gate evidence');

console.log(renderCodexAdapterChecks(result));
console.log('codex assets verified');
