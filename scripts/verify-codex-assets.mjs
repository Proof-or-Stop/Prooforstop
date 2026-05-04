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
import { CODEX_README_TEMPLATE, renderCodexAdapterManifest } from '../packages/main/dist/init-assets.js';
import {
  computeCodexAdapterMaterialSnapshot,
  GLOBAL_CODEX_FALLBACK_COMMAND,
  LOCAL_CODEX_VERIFY_COMMAND,
  LOCAL_INIT_VERIFY_COMMAND,
  LOCAL_MAIN_VERIFY_COMMAND,
  renderCodexAdapterChecks,
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

assert(CODEX_README_TEMPLATE.includes('node bin/koala-codex.js session_brief'), 'template missing preferred wrapper command');
assert(CODEX_README_TEMPLATE.includes(`${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`), 'template missing fallback command');
assert(CODEX_README_TEMPLATE.includes(LOCAL_CODEX_VERIFY_COMMAND), 'template missing local verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_MAIN_VERIFY_COMMAND), 'template missing main wrapper verify_codex guidance');
assert(CODEX_README_TEMPLATE.includes(LOCAL_INIT_VERIFY_COMMAND), 'template missing init verification guidance');
assert(CODEX_README_TEMPLATE.includes('node bin/koala-codex.js doctor'), 'template missing Codex doctor guidance');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala verify_codex`', 'template bare global verify guidance');
assertNotIncludes(CODEX_README_TEMPLATE, '`koala init --verify-codex`', 'template bare global init guidance');
assert(renderCodexAdapterManifest().includes('"activitySource": "codex"'), 'manifest template missing codex source');
assert(renderCodexAdapterManifest().includes(LOCAL_CODEX_VERIFY_COMMAND), 'manifest template missing local verify note');

const codexReadme = readFileSync(join(root, '.Codex', 'README.md'), 'utf8');
const manifest = readFileSync(join(root, '.Codex', 'koala.json'), 'utf8');
const rootReadme = readFileSync(join(root, 'README.md'), 'utf8');
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');

assert(codexReadme === CODEX_README_TEMPLATE, '.Codex/README.md drifted from template');
assert(manifest === renderCodexAdapterManifest(), '.Codex/koala.json drifted from template');
for (const [label, text] of [
  ['.Codex/README.md', codexReadme],
  ['README.md', rootReadme],
  ['AGENTS.md', agents],
]) {
  assertIncludes(text, LOCAL_CODEX_VERIFY_COMMAND, label);
  assertIncludes(text, 'node bin/koala-codex.js doctor', label);
  assertNotIncludes(text, '`koala verify_codex`', label);
  assertNotIncludes(text, '`koala init --verify-codex`', label);
}

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

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertGlobalFallbackHeartbeatIgnoresParentCodexEntrypoint() {
  const fakeBin = mkdtempSync(join(tmpdir(), 'koala-codex-fake-global-'));
  const fakeKoala = join(fakeBin, 'koala');
  const previousPath = process.env.PATH;
  const previousEntrypoint = process.env.KOALA_CODEX_ENTRYPOINT;
  try {
    writeFileSync(
      fakeKoala,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'packages/main/dist/cli.js'))} "$@"\n`,
    );
    chmodSync(fakeKoala, 0o755);
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
      assert(gate.command === LOCAL_CODEX_VERIFY_COMMAND, `${label} should remediate with local wrapper command`);
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

console.log(renderCodexAdapterChecks(result));
console.log('codex assets verified');
