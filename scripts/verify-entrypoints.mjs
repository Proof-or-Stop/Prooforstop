#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { runManagedAssetCheck } from '../packages/main/dist/core/managed-assets.js';
import { readPromptRegistry, renderPromptEntryForHost } from '../packages/main/dist/core/prompt-registry.js';
import {
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END,
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from '../packages/main/dist/core/runtime-artifact-registry.js';
// B-cc10 CHK-004: this verifier asserts what `init` WRITES, so it must name the
// same canonical spellings the writers derive from `core/brand-paths.ts`. A second
// hardcoded literal here is exactly the drift this story removes — it would let the
// writers move while the verifier kept asserting (and thus pinning) the old name.
import {
  PROOF_OR_STOP_ADAPTER_DIR,
  PROOF_OR_STOP_CONFIG_FILENAME,
  PROOF_OR_STOP_MANIFEST_FILENAME,
  PROOF_OR_STOP_STATE_DIR,
} from '../packages/main/dist/core/brand-paths.js';

// B-cc10 CHK-007: the state/adapter DIRECTORY halves of the asserted paths now come
// from the resolver too. They were hardcoded to the deprecated spellings, so once the
// writers were unified onto the canonical state dir these assertions pinned a path
// `init` no longer produces ("repo-local core CLI init --help missing
// \".proof-or-stop/Proof-or-Stop.md\""). Deriving keeps the witness tracking the writer.
const DOT_DIR_GUIDE_REL = `${PROOF_OR_STOP_STATE_DIR}/Proof-or-Stop.md`;
const DOT_DIR_MANIFEST_REL = `${PROOF_OR_STOP_STATE_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;
/** Short alias so the many adapter-dir assertions below stay readable. */
const AD = PROOF_OR_STOP_ADAPTER_DIR;
const CODEX_README_REL = `${AD}/README.md`;
const CODEX_MANIFEST_REL = `${AD}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;

const repoRoot = process.cwd();
// B-cdf6: the global-fallback advice names the CANONICAL bin. The PROOF_OR_STOP_* env vars in it
// are FROZEN (Pass B owns them); only the bin token moved.
const GLOBAL_CODEX_FALLBACK = 'PROOF_OR_STOP_ACTIVITY_SOURCE=codex PROOF_OR_STOP_ACTIVITY_RECORD_READONLY=1 PROOF_OR_STOP_CODEX_ENTRYPOINT=global-fallback proof-or-stop';
const INIT_ENTRYPOINT = 'packages/main/dist/cli-init.js';
const CORE_ENTRYPOINT = 'packages/main/dist/cli.js';
const RETIRED_BIN = ['lat', 'tice'].join('');
const NON_CANONICAL_STATE_CASE = '.Proof-or-Stop';
const MANAGED_GITIGNORE_BLOCK_START = PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START;
const MANAGED_GITIGNORE_BLOCK_END = PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END;
const REQUIRED_RUNTIME_IGNORE_LINES = listRuntimeArtifactIgnorePatterns();

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function runBounded(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
    killSignal: 'SIGTERM',
    ...opts,
  });
}

function assertExpectedBoundedExit(result, label) {
  // `serve` is intentionally long-lived, so the harness may terminate it after
  // it has emitted its startup markers. Keep that timeout/termination contract
  // explicit while rejecting every other spawn failure and every non-zero exit.
  if (result.error) {
    assert(result.error.code === 'ETIMEDOUT', `${label} failed unexpectedly: ${result.error.code || result.error.message}`);
    return;
  }
  if (result.signal === 'SIGTERM' && result.status === null) return;
  assert(result.signal === null, `${label} terminated unexpectedly by ${result.signal}`);
  assert(result.status === 0, `${label} exited with status ${result.status}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label} missing "${needle}"`);
}

function assertNotIncludes(haystack, needle, label) {
  assert(!haystack.includes(needle), `${label} should not include "${needle}"`);
}

function readJson(root, relPath) {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
}

function assertCanonicalMainPackageBin(root) {
  const packageJson = readJson(root, 'packages/main/package.json');
  const packageLock = readJson(root, 'packages/main/package-lock.json');
  const packageBin = packageJson.bin || {};
  const lockBin = packageLock.packages?.['']?.bin || {};
  assert(packageBin['proof-or-stop'] === 'dist/cli.js', 'packages/main package.json must publish proof-or-stop -> dist/cli.js');
  assert(lockBin['proof-or-stop'] === 'dist/cli.js', 'packages/main package-lock.json must pin proof-or-stop -> dist/cli.js');
  assert(!Object.prototype.hasOwnProperty.call(packageBin, 'lattice'), 'packages/main package.json must not reintroduce the lattice npm bin alias');
  assert(!Object.prototype.hasOwnProperty.call(lockBin, 'lattice'), 'packages/main package-lock.json must not reintroduce the lattice npm bin alias');
}

assertCanonicalMainPackageBin(repoRoot);

function assertPathExists(root, relPath, label = relPath) {
  assert(existsSync(join(root, relPath)), `${label} should exist`);
}

function pathExistsWithExactCase(root, relPath) {
  let current = root;
  for (const part of relPath.split('/').filter(Boolean)) {
    if (!existsSync(current)) return false;
    const entries = readdirSync(current);
    if (!entries.includes(part)) return false;
    current = join(current, part);
  }
  return true;
}

function assertPathMissing(root, relPath, label = relPath) {
  assert(!pathExistsWithExactCase(root, relPath), `${label} should not exist`);
}

// B-cdf6: seed the mirror with HOST-RENDERED shims, not raw registry templates.
// `verify_codex`'s agents-mirror check compares each `.claude/agents/<file>` against
// `renderPromptEntryForHost(entry, 'claude')`. Copying the raw template bytes made
// every file report `package/Claude drift`, so `verify_codex` exited non-zero and
// `run()` (execFileSync) THREW — which is why the assertion message showed an empty
// `output ()` rather than a diff. Rendering through the same function the checker
// uses makes the fixture agree with the contract instead of accidentally violating it.
function seedClaudeAgentMirror(tempDir) {
  const mirrorDir = join(tempDir, '.claude', 'agents');
  mkdirSync(mirrorDir, { recursive: true });
  const registry = readPromptRegistry();
  for (const entry of registry.agents) {
    writeFileSync(join(mirrorDir, entry.file), renderPromptEntryForHost(entry, 'claude'));
  }
  return () => rmSync(mirrorDir, { recursive: true, force: true });
}

function installGlobalFallbackShim(tempDir) {
  const shimDir = join(tempDir, '.test-global-bin');
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, 'proof-or-stop');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repoRoot, 'bin', 'proof-or-stop.js'))} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return shimDir;
}

function sectionBetween(text, startNeedle, endNeedle, label) {
  const start = text.indexOf(startNeedle);
  assert(start >= 0, `${label} missing section "${startNeedle}"`);
  const from = start + startNeedle.length;
  const end = text.indexOf(endNeedle, from);
  assert(end >= 0, `${label} missing section terminator "${endNeedle}"`);
  return text.slice(from, end);
}

function assertInitHelpDocumentsStarterAsOptional(help, label) {
  assertIncludes(help, '--profile <profile>', label);
  assertIncludes(help, 'codex | claude | all | core', label);
  assertIncludes(help, DOT_DIR_GUIDE_REL, label);
  assertIncludes(help, 'global-thin', label);
  assertIncludes(help, '--starter', label);
  assertIncludes(help, '--with-template', label);
  assertIncludes(help, '可选 starter 内容（仅 --starter / --with-template）', label);

  const defaultInitSection = sectionBetween(help, '默认初始化（global-thin mode）:', 'full/thin asset mode', label);
  assertNotIncludes(defaultInitSection, 'src/core/app.ts', `${label} default init section`);
  assertNotIncludes(defaultInitSection, 'src/shells/cli/main.ts', `${label} default init section`);
  assertNotIncludes(defaultInitSection, 'tests/', `${label} default init section`);

  const optionalStarterSection = sectionBetween(help, '可选 starter 内容', '初始化后（global-thin）:', label);
  assertIncludes(optionalStarterSection, 'src/core/app.ts', `${label} optional starter section`);
  assertIncludes(optionalStarterSection, 'src/shells/cli/main.ts', `${label} optional starter section`);
  assertIncludes(optionalStarterSection, 'tests/', `${label} optional starter section`);
}

function assertManagedMarkerSync(content, expectedNeedle, staleNeedle, label) {
  const managedMarkerPairs = [
    ['<!-- proof-or-stop:start -->', '<!-- proof-or-stop:end -->'],
  ];
  const hasManagedMarkerPair = managedMarkerPairs.some(([start, end]) =>
    content.includes(start) && content.includes(end),
  );
  assert(
    hasManagedMarkerPair,
    `${label} missing a complete managed marker pair (canonical proof-or-stop)`,
  );
  assertIncludes(content, expectedNeedle, label);
  if (staleNeedle) assertNotIncludes(content, staleNeedle, label);
}

function assertGitignoreBlock(content, lines, label) {
  assertIncludes(content, MANAGED_GITIGNORE_BLOCK_START, label);
  assertIncludes(content, MANAGED_GITIGNORE_BLOCK_END, label);
  for (const line of lines) {
    assertIncludes(content, line, `${label} missing managed ignore line`);
  }
}

function missingRuntimeIgnoreLines(existingLines) {
  const present = new Set(existingLines.map(line => line.trim()).filter(Boolean));
  return REQUIRED_RUNTIME_IGNORE_LINES.filter(line => !present.has(line));
}

function assertProfileAssets(tempDir, profile, opts = {}) {
  const present = ['PROOF_OR_STOP.md', 'bin/proof-or-stop.js', PROOF_OR_STOP_CONFIG_FILENAME];
  const absent = [];

  if (profile === 'codex' || profile === 'all') {
    present.push(
      'AGENTS.md',
      'bin/proof-or-stop-codex.js',
      CODEX_README_REL,
      CODEX_MANIFEST_REL,
      `${AD}/agents/proof-or-stop-test-intent.md`,
      `${AD}/agents/proof-or-stop-test-case-reviewer.md`,
      `${AD}/agents/proof-or-stop-review-quality.md`,
      `${AD}/agents/proof-or-stop-implementer.md`,
    );
  } else if (!opts.allowExistingCodex) {
    absent.push('AGENTS.md', 'bin/proof-or-stop-codex.js', AD);
  }

  if (profile === 'claude' || profile === 'all') {
    present.push(
      'CLAUDE.md',
      '.claude/hooks/log-tools.cjs',
      '.claude/hooks/session-brief-reminder.cjs',
      '.claude/settings.json',
    );
    absent.push('.claude/skills/koala');
  } else if (!opts.allowExistingClaude) {
    absent.push('CLAUDE.md', '.claude');
  }

  absent.push('.claude/agents');

  for (const rel of present) {
    assertPathExists(tempDir, rel, `${profile} init ${rel}`);
  }
  for (const rel of absent) {
    assertPathMissing(tempDir, rel, `${profile} init ${rel}`);
  }
}

function assertGlobalThinAssets(tempDir, profile, opts = {}) {
  const present = [DOT_DIR_GUIDE_REL, DOT_DIR_MANIFEST_REL, PROOF_OR_STOP_CONFIG_FILENAME];
  const absent = ['PROOF_OR_STOP.md', 'bin/proof-or-stop.js', 'bin/proof-or-stop-codex.js', PROOF_OR_STOP_ADAPTER_DIR];

  if (profile === 'codex' || profile === 'all' || profile === 'core') {
    present.push('AGENTS.md');
  } else if (!opts.allowExistingCodex) {
    absent.push('AGENTS.md');
  }

  if (profile === 'claude' || profile === 'all') {
    present.push(
      'CLAUDE.md',
      '.claude/hooks/log-tools.cjs',
      '.claude/hooks/session-brief-reminder.cjs',
      '.claude/settings.json',
    );
    absent.push('.claude/skills/koala');
  } else if (!opts.allowExistingClaude) {
    absent.push('CLAUDE.md', '.claude');
  }

  for (const rel of present) {
    assertPathExists(tempDir, rel, `${profile} global-thin init ${rel}`);
  }
  for (const rel of absent) {
    assertPathMissing(tempDir, rel, `${profile} global-thin init ${rel}`);
  }
}

function readActivityRecord(session, tool) {
  const activityPath = stateDirPath('activity.jsonl');
  if (!existsSync(activityPath)) return null;
  const text = readFileSync(activityPath, 'utf8').trim();
  if (!text) return null;
  const entries = text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return entries.findLast(entry => entry.session === session && entry.tool === tool) || null;
}

// B-cc10 CHK-006: single read-both state-dir resolver for this verifier. CHK-003 moved the
// runtime's state dir to `.proof-or-stop/`, so readers pinned to `.proof-or-stop/` silently saw
// no data and reported "the wrapper never ran". Canonical first, deprecated retained so a
// pre-migration checkout still verifies. One helper, so a future move updates one place.
const STATE_DIR_CANDIDATES = ['.proof-or-stop', '.proof-or-stop', '.koala'];

function stateDirPath(...parts) {
  const found = STATE_DIR_CANDIDATES
    .map(dir => join(repoRoot, dir, ...parts))
    .find(existsSync);
  return found ?? join(repoRoot, STATE_DIR_CANDIDATES[0], ...parts);
}

function readLatestActivityRecord(tool, entrypoint = 'local-wrapper') {
  const activityPath = stateDirPath('activity.jsonl');
  if (!existsSync(activityPath)) return null;
  const text = readFileSync(activityPath, 'utf8').trim();
  if (!text) return null;
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .findLast(entry => entry.tool === tool && entry.source === 'codex' && entry.entrypoint === entrypoint) || null;
}

function currentStoryId() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (branch.startsWith('story/')) return branch.slice('story/'.length);
  } catch {}
  return '';
}

function readProcessEvent(session, command) {
  const storyId = currentStoryId();
  if (!storyId) return null;
  const storyDir = stateDirPath('story', 'actives', storyId);
  if (!existsSync(storyDir)) return null;
  const eventPath = join(storyDir, 'process-events.jsonl');
  if (!existsSync(eventPath)) return null;
  const entries = readFileSync(eventPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return entries.findLast(entry => entry.session === session && entry.command === command) || null;
}

function assertCodexWrapperSessionFrom(envName) {
  const marker = `verify-entrypoints-${envName.toLowerCase()}-${Date.now()}`;
  const env = {
    ...process.env,
    PROOF_OR_STOP_ACTIVITY_SOURCE: 'not-codex',
    PROOF_OR_STOP_ACTIVITY_SESSION: marker,
    CODEX_THREAD_ID: '',
    CODEX_SESSION_ID: '',
    OPENAI_SESSION_ID: '',
    TERM_SESSION_ID: '',
    [envName]: marker,
  };
  const out = run('node', ['bin/proof-or-stop-codex.js', 'session_brief'], { env });
  assert(
    /# proof-or-stop session brief/.test(out),
    `bin/proof-or-stop-codex.js ${envName} session_brief missing session_brief heading`,
  );
  assertNotIncludes(out, marker, `bin/proof-or-stop-codex.js ${envName} stdout`);

  const record = readLatestActivityRecord('session_brief');
  assert(record, `bin/proof-or-stop-codex.js should derive an opaque session from ${envName}`);
  assert(/^sess-[a-f0-9]+$/.test(record.session), 'bin/proof-or-stop-codex.js should persist an opaque canonical session id');
  assert(record.session !== marker, `bin/proof-or-stop-codex.js must not persist raw ${envName}`);
  assert(record.source === 'codex', 'bin/proof-or-stop-codex.js should force activity source=codex');
  assert(record.entrypoint === 'local-wrapper', 'bin/proof-or-stop-codex.js should mark entrypoint=local-wrapper');
  const activityText = readFileSync(stateDirPath('activity.jsonl'), 'utf8');
  assertNotIncludes(activityText, marker, `activity log raw ${envName}`);
  const storyId = currentStoryId();
  if (storyId) {
    const processEventPath = stateDirPath('story', 'actives', storyId, 'process-events.jsonl');
    if (existsSync(processEventPath)) {
      assertNotIncludes(readFileSync(processEventPath, 'utf8'), marker, `story process events raw ${envName}`);
    }
  }
  return record.session;
}

function installTemporaryXstateStub() {
  const stubDir = join(repoRoot, 'node_modules', 'xstate');
  if (existsSync(stubDir)) return () => {};
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'package.json'), JSON.stringify({
    name: 'xstate',
    version: '0.0.0-test-stub',
    type: 'module',
    exports: './index.js',
  }, null, 2) + '\n');
  writeFileSync(join(stubDir, 'index.js'), `export function setup() {
  return {
    createMachine(config) {
      return {
        ...config,
        resolveState(snapshot) {
          return snapshot;
        },
      };
    },
  };
}

export function createActor(_machine, options = {}) {
  const snapshot = options.snapshot || { value: undefined, context: options.input ?? {} };
  return {
    start() { return this; },
    stop() {},
    send() {},
    can() { return true; },
    getSnapshot() { return snapshot; },
  };
}
`);
  return () => {
    rmSync(stubDir, { recursive: true, force: true });
  };
}

const checks = [];

checks.push(() => {
  const out = run('node', ['bin/proof-or-stop.js', 'aux_doc_list', '--format=json']);
  assertIncludes(out, '"docs"', 'bin/proof-or-stop.js aux_doc_list');
  assertPathMissing(repoRoot, 'bin/koala.js', 'legacy local koala wrapper');
  assertPathMissing(repoRoot, 'bin/koala-codex.js', 'legacy local koala Codex wrapper');
  assertPathMissing(repoRoot, `${AD}/koala.json`, 'legacy Codex manifest');
});

checks.push(() => {
  const coreHelp = run('node', [CORE_ENTRYPOINT, 'init', '--help']);
  assertInitHelpDocumentsStarterAsOptional(coreHelp, 'repo-local core CLI init --help');

  const localWrapperHelp = run('node', ['bin/proof-or-stop.js', 'init', '--help']);
  assertInitHelpDocumentsStarterAsOptional(localWrapperHelp, 'repo-local bin/proof-or-stop.js init --help');
});

checks.push(() => {
  assertCodexWrapperSessionFrom('CODEX_THREAD_ID');
  assertCodexWrapperSessionFrom('CODEX_SESSION_ID');
});

checks.push(() => {
  assertCodexWrapperSessionFrom('OPENAI_SESSION_ID');
});

checks.push(() => {
  assertCodexWrapperSessionFrom('TERM_SESSION_ID');
});

checks.push(() => {
  const marker = `verify-entrypoints-global-${Date.now()}`;
  const out = run('node', [CORE_ENTRYPOINT, 'session_brief'], {
    env: {
      ...process.env,
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
      PROOF_OR_STOP_ACTIVITY_RECORD_READONLY: '1',
      PROOF_OR_STOP_ACTIVITY_SESSION: marker,
    },
  });
  assert(
    /# proof-or-stop session brief/.test(out),
    'global Codex fallback core CLI session_brief missing session_brief heading',
  );

  const record = readLatestActivityRecord('session_brief', 'global-fallback');
  assert(record, 'global Codex fallback should write an opaque session_brief activity record');
  assert(record.session !== marker && /^sess-[a-f0-9]+$/.test(record.session), 'global fallback must hash raw PROOF_OR_STOP_ACTIVITY_SESSION');
  assert(record.source === 'codex', 'global Codex fallback should write source=codex');
  assert(record.entrypoint === 'global-fallback', 'global Codex fallback should mark entrypoint=global-fallback');
  assertNotIncludes(
    readFileSync(stateDirPath('activity.jsonl'), 'utf8'),
    marker,
    'global fallback activity log raw session',
  );
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-default-fallback-'));
  try {
    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, 'Selected init profile: core', 'proof-or-stop init default fallback profile selection');
    assertIncludes(initOut, 'global-thin default', 'proof-or-stop init default fallback reason');
    assertGlobalThinAssets(tempDir, 'core');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-'));
  try {
    mkdirSync(join(tempDir, AD, 'agents'), { recursive: true });
    writeFileSync(join(tempDir, AD, 'agents', 'implementer.md'), 'old codex-only prompt\n');
    writeFileSync(join(tempDir, AD, 'agents', 'reviewer.md'), 'old codex-only prompt\n');

    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: all', 'proof-or-stop init explicit all profile selection');
    assertIncludes(initOut, 'explicit --profile=all', 'proof-or-stop init explicit all reason');
    assertIncludes(initOut, 'no per-project files', 'proof-or-stop init should advertise global thin-shim agent mode');
    assertIncludes(initOut, CODEX_README_REL, 'proof-or-stop init output');
    assertProfileAssets(tempDir, 'all');

    const defaultConfig = readJson(tempDir, PROOF_OR_STOP_CONFIG_FILENAME);
    assert(defaultConfig.scanRoot === '.', 'default proof-or-stop init without preexisting src should set scanRoot=.');
    assertPathMissing(tempDir, 'src/core', 'default proof-or-stop init src/core');
    assertPathMissing(tempDir, 'src/shells', 'default proof-or-stop init src/shells');
    assertPathMissing(tempDir, 'tests', 'default proof-or-stop init tests');
    assertManagedMarkerSync(readFileSync(join(tempDir, 'PROOF_OR_STOP.md'), 'utf8'), 'host-neutral', null, 'PROOF_OR_STOP.md');
    const generatedClaude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    assertIncludes(generatedClaude, 'PROOF_OR_STOP.md', 'all profile CLAUDE.md should point to PROOF_OR_STOP.md');
    assertNotIncludes(generatedClaude, '正常通道：', 'all profile CLAUDE.md should not copy root lifecycle table');

    const codexReadme = readFileSync(join(tempDir, AD, 'README.md'), 'utf8');
    // B-cdf6: fresh init must teach the CANONICAL wrapper name, not the retained
    // deprecated bin/proof-or-stop-codex.js alias.
    assertIncludes(codexReadme, 'node bin/proof-or-stop-codex.js session_brief', CODEX_README_REL);
    assertIncludes(codexReadme, `${GLOBAL_CODEX_FALLBACK} session_brief`, CODEX_README_REL);
    assertIncludes(codexReadme, '不要把 fallback 的 `status` / `next` / `validate` 输出当作 gate 证据', CODEX_README_REL);
    assertIncludes(codexReadme, CODEX_MANIFEST_REL, CODEX_README_REL);
    assertIncludes(codexReadme, 'Codex 官方 PreToolUse hook 使用小写 `.codex/hooks.json`', CODEX_README_REL);

    const codexManifest = readJson(tempDir, CODEX_MANIFEST_REL);
    assert(codexManifest.adapterOwner === 'proof-or-stop', 'adapter manifest should be owned by proof-or-stop');
    assert(codexManifest.activitySource === 'codex', 'adapter manifest should declare activitySource=codex');
    assert(
      codexManifest.recommendedEntrypoints.some(entry => entry.command === 'node bin/proof-or-stop-codex.js'),
      'adapter manifest should recommend the local Codex wrapper',
    );
    assert(
      codexManifest.recommendedEntrypoints[0]?.command === 'node bin/proof-or-stop-codex.js',
      'adapter manifest should prefer the local Codex wrapper first',
    );
    assert(
      codexManifest.recommendedEntrypoints.some(entry => entry.command === GLOBAL_CODEX_FALLBACK),
      'adapter manifest should include the global source-tagged read-only fallback',
    );
    assert(
      codexManifest.recommendedEntrypoints.some(entry => String(entry.useWhen || '').includes('current-worktree gate/status evidence')),
      'adapter manifest should warn that global fallback is not current-worktree gate/status evidence',
    );
    assert(
      codexManifest.sessionEnv.sessionCandidates.includes('CODEX_THREAD_ID')
        && codexManifest.sessionEnv.sessionCandidates.includes('CODEX_SESSION_ID')
        && codexManifest.sessionEnv.sessionCandidates.includes('OPENAI_SESSION_ID')
        && codexManifest.sessionEnv.sessionCandidates.includes('TERM_SESSION_ID'),
      'adapter manifest should document Codex thread/session/OpenAI/terminal task env candidates',
    );
    assert(codexManifest.sessionEnv.session === 'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK', 'adapter manifest should name the non-logging task bridge');
    assert(codexManifest.sessionEnv.recordReadOnly === 'PROOF_OR_STOP_ACTIVITY_RECORD_READONLY', 'adapter manifest should document read-only activity opt-in');
    assert(!JSON.stringify(codexManifest).includes('LATTICE_'), 'new Codex adapter manifest must not emit legacy environment names');
    assert(!codexManifest.excludedRuntimeAssets.includes(`${AD}/hooks`), 'adapter manifest should allow managed Codex native hooks');
    assert(codexManifest.excludedRuntimeAssets.includes(`${AD}/settings.json`), 'adapter manifest should exclude .proof-or-stop-codex/settings.json');
    assertPathExists(tempDir, '.codex/hooks', 'proof-or-stop init .codex/hooks');
    assertPathExists(tempDir, '.codex/hooks.json', 'proof-or-stop init .codex/hooks.json');
    assertPathMissing(tempDir, `${AD}/settings.json`, 'proof-or-stop init .proof-or-stop-codex/settings.json');

    const codexAgents = readdirSync(join(tempDir, AD, 'agents'));
    assert(!codexAgents.includes('implementer.md'), 'proof-or-stop init should not keep stale Codex-only implementer.md');
    assert(!codexAgents.includes('reviewer.md'), 'proof-or-stop init should not keep stale Codex-only reviewer.md');

    // B-cdf6: init generates the CANONICAL wrapper names; the deprecated ones are
    // accepted-if-present but never newly written.
    const generatedWrapper = readFileSync(join(tempDir, 'bin', 'proof-or-stop-codex.js'), 'utf8');
    const generatedBootstrap = readFileSync(join(tempDir, 'bin', 'proof-or-stop.js'), 'utf8');
    assert(existsSync(join(tempDir, 'bin', 'proof-or-stop.js')), 'init should generate sibling bin/proof-or-stop.js');
    assertPathMissing(tempDir, `bin/${RETIRED_BIN}-codex.js`, 'init should not newly generate the retired Codex wrapper name');
    assertPathMissing(tempDir, 'bin/proofOrStop.js', 'init should not newly generate the deprecated bootstrap name');
    assertIncludes(generatedWrapper, "'proof-or-stop.js'", 'generated Codex wrapper canonical bootstrap candidate');
    assertNotIncludes(generatedWrapper, "'proofOrStop.js'", 'generated Codex wrapper has no deprecated bootstrap fallback');
    assertNotIncludes(generatedWrapper, "spawnSync('koala'", 'generated Codex wrapper should not delegate directly to global koala');
    assertIncludes(generatedWrapper, 'proof-or-stop init --verify-codex', 'generated Codex wrapper recovery hint');
    assertIncludes(generatedBootstrap, 'coreCliEngineCandidates', 'generated local bootstrap candidate list');
    assertIncludes(generatedBootstrap, "node_modules', '@proof-or-stop', 'core'", 'generated local bootstrap should search local @proof-or-stop/core first');
    assertNotIncludes(generatedBootstrap, "node_modules', '@proofOrStop', 'core'", 'generated local bootstrap should not retain deprecated @proof-or-stop/core fallback');
    assertNotIncludes(generatedBootstrap, "@koala-agent", 'generated local bootstrap should not search @koala-agent/core fallback');
    assertNotIncludes(generatedBootstrap, 'bin/koala.js', 'generated local bootstrap should not mention bin/koala.js');
    assertNotIncludes(generatedBootstrap, "spawnSync('koala'", 'generated local bootstrap should not delegate to global koala');
    assertIncludes(generatedBootstrap, "typeof mod.runCli", 'generated local bootstrap should execute a local CLI engine');
    // The staleness rejection is expressed as a positive capability predicate
    // (`isCapable`) rather than the earlier negated inline form. Same guarantee:
    // a core-only global install that exits 0 from `help` but lacks these two
    // commands must not be selected. Pinning the OLD negated spelling here made
    // this check assert a code shape the generator no longer emits.
    assertIncludes(generatedBootstrap, "out.includes('aux_doc_list') && out.includes('verify_codex')", 'generated local bootstrap should reject stale global fallback by capability');
    assertPathMissing(tempDir, 'bin/koala.js', 'full init should not generate bin/koala.js');
    assertPathMissing(tempDir, 'bin/koala-codex.js', 'full init should not generate bin/koala-codex.js');
    assertPathMissing(tempDir, `${AD}/koala.json`, 'full init should not generate .proof-or-stop-codex/koala.json');

    const cleanupClaudeMirror = seedClaudeAgentMirror(tempDir);
    const globalShimDir = installGlobalFallbackShim(tempDir);
    const verifyInitOut = run(process.execPath, [join(tempDir, 'bin', 'proof-or-stop.js'), 'verify_codex'], {
      cwd: tempDir,
      env: { ...process.env, PATH: `${globalShimDir}:${process.env.PATH || ''}` },
    });
    assertIncludes(verifyInitOut, 'Codex adapter checks passed', `proof-or-stop verify_codex output (${verifyInitOut.trim()})`);
    // B-cdf6: derive the expected count from the registry instead of hardcoding it.
    // The literal `16` had gone stale against a 17-role registry, so this assertion
    // would have failed even once the drift issue above was fixed. Deriving it means
    // adding or removing a role can never silently rot this check again.
    const expectedMirrorCount = readPromptRegistry().agents.length;
    assertIncludes(
      verifyInitOut,
      `Codex agents mirror: ${expectedMirrorCount} prompt(s) mirrored`,
      'proof-or-stop verify_codex mirror check',
    );
    assertPathMissing(tempDir, 'src/core', 'proof-or-stop verify_codex src/core');
    assertPathMissing(tempDir, 'src/shells', 'proof-or-stop verify_codex src/shells');
    assertPathMissing(tempDir, 'tests', 'proof-or-stop verify_codex tests');

    const staleBin = join(tempDir, 'stale-bin');
    mkdirSync(staleBin);
    const staleProofOrStop = join(staleBin, 'proof-or-stop');
    writeFileSync(staleProofOrStop, '#!/bin/sh\necho "stale proof-or-stop without Codex adapter commands"\nexit 0\n');
    chmodSync(staleProofOrStop, 0o755);
    const minimalEnv = {
      ...process.env,
      PATH: `${staleBin}:/usr/bin:/bin`,
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'not-codex',
      PROOF_OR_STOP_ACTIVITY_SESSION: `fresh-init-wrapper-${Date.now()}`,
    };
    const freshWrapperOut = run(process.execPath, [join(tempDir, 'bin', 'proof-or-stop-codex.js'), 'session_brief'], { cwd: tempDir, env: minimalEnv });
    assertIncludes(freshWrapperOut, '# proof-or-stop session brief', 'fresh generated wrapper should ignore a retired global executable on PATH');

    const checkOk = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    assert(checkOk.ok === true, 'proof-or-stop check should pass immediately after init');
    assert(checkOk.profile === 'all', 'proof-or-stop check should detect all profile after all init');

    writeFileSync(join(tempDir, AD, PROOF_OR_STOP_MANIFEST_FILENAME), '{}\n');
    const checkDrift = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    assert(checkDrift.ok === false, 'proof-or-stop check should report drift after managed manifest edit');
    assert(
      checkDrift.items.some(item => item.relPath === CODEX_MANIFEST_REL && item.status === 'STALE_SAFE'),
      'proof-or-stop check should classify generated Codex manifest drift as STALE_SAFE',
    );

    const checkApply = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--apply', '--json'], { cwd: tempDir }));
    assert(checkApply.ok === true, 'proof-or-stop check --apply should repair safe managed drift');
    assert(checkApply.applied.includes(CODEX_MANIFEST_REL), 'proof-or-stop check --apply should report applied managed manifest');
    assert(readJson(tempDir, CODEX_MANIFEST_REL).adapterOwner === 'proof-or-stop', 'proof-or-stop check --apply should restore Codex manifest');
    // B-cc10 F-044: MANIFEST_REL_PATH now writes only the canonical path, so asserting the
    // deprecated one could never pass — the assertion was checking for a file init stopped
    // creating.
    assertPathExists(tempDir, '.proof-or-stop/managed-assets.json', 'proof-or-stop check --apply manifest');

    run('git', ['init'], { cwd: tempDir });
    writeFileSync(join(tempDir, 'proof-or-stop-user-note.txt'), 'uncommitted local work\n');
    writeFileSync(join(tempDir, AD, PROOF_OR_STOP_MANIFEST_FILENAME), '{}\n');
    const checkUpgrade = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--upgrade', '--json'], { cwd: tempDir }));
    assert(checkUpgrade.ok === true, 'proof-or-stop check --upgrade should repair safe managed drift');
    assert(checkUpgrade.mode === 'upgrade', 'proof-or-stop check --upgrade should report upgrade mode');
    assert(checkUpgrade.applied.includes(CODEX_MANIFEST_REL), 'proof-or-stop check --upgrade should report applied managed manifest');
    assert(
      checkUpgrade.warnings.some(warning => warning.includes('working tree already has')),
      'proof-or-stop check --upgrade should warn before syncing into a dirty worktree',
    );

    const originalClaude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(tempDir, 'CLAUDE.md'), [
      '# CLAUDE.md',
      '',
      '<!-- proof-or-stop:start -->',
      '## Local Project Rule',
      '',
      'Preserve this locally edited Claude instruction.',
      '<!-- proof-or-stop:end -->',
      '',
    ].join('\n'));
    const checkLocalReview = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--review-local-edits', '--json'], { cwd: tempDir }));
    const claudeReview = checkLocalReview.localEditReviews.find(review => review.relPath === 'CLAUDE.md');
    assert(checkLocalReview.ok === false, 'proof-or-stop check --review-local-edits should preserve STALE_LOCAL_EDIT status');
    assert(claudeReview, 'proof-or-stop check --review-local-edits should report CLAUDE.md review data');
    assert(
      claudeReview.localOnlyHeadings.includes('Local Project Rule'),
      'proof-or-stop check --review-local-edits should surface local-only headings',
    );
    writeFileSync(join(tempDir, 'CLAUDE.md'), originalClaude);

    mkdirSync(join(tempDir, AD, 'settings.json'), { recursive: true });
    const checkExcludedDirectory = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    const excludedDirectoryItem = checkExcludedDirectory.items.find(item => item.relPath === `${AD}/settings.json`);
    assert(checkExcludedDirectory.ok === false, 'proof-or-stop check should report excluded directory drift');
    assert(
      excludedDirectoryItem?.status === 'INCOMPATIBLE' && excludedDirectoryItem.reason.includes('directory'),
      'proof-or-stop check should classify directory at excluded asset path without throwing EISDIR',
    );
    rmSync(join(tempDir, AD, 'settings.json'), { recursive: true, force: true });

    rmSync(join(tempDir, AD, 'README.md'), { force: true });
    mkdirSync(join(tempDir, AD, 'README.md'));
    const checkManagedFileDirectory = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    const managedFileDirectoryItem = checkManagedFileDirectory.items.find(item => item.relPath === CODEX_README_REL);
    assert(
      managedFileDirectoryItem?.status === 'INCOMPATIBLE' && managedFileDirectoryItem.reason.includes('expected a file'),
      'proof-or-stop check should classify directory at managed file path without throwing EISDIR',
    );

    cleanupClaudeMirror();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-case-mismatch-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    rmSync(join(tempDir, 'PROOF_OR_STOP.md'), { force: true });
    writeFileSync(join(tempDir, 'Proof_or_stop.md'), '# Proof_or_stop.md\n\nmixed-case Proof-or-Stop guide\n');
    const result = runManagedAssetCheck(tempDir, { profile: 'all' });
    const item = result.items.find(asset => asset.relPath === 'PROOF_OR_STOP.md');
    assert(item?.status === 'CASE_MISMATCH', 'proof-or-stop check should classify PROOF_OR_STOP.md casing drift as CASE_MISMATCH');
    assert(item.actualRelPath === 'Proof_or_stop.md', 'proof-or-stop check should report the mixed-case actual path');
    assert(item.reason.includes('different case'), 'proof-or-stop check should explain path casing drift');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tracked = new Set(run('git', ['ls-files']).trim().split(/\r?\n/).filter(Boolean));
  const required = [
    DOT_DIR_GUIDE_REL,
    DOT_DIR_MANIFEST_REL,
    '.codex/hooks.json',
    '.codex/hooks/proof-or-stop-scope-pretool.cjs',
  ];
  const forbidden = [
    `${NON_CANONICAL_STATE_CASE}/Proof-or-Stop.md`,
    `${NON_CANONICAL_STATE_CASE}/${PROOF_OR_STOP_MANIFEST_FILENAME}`,
    `${AD}/hooks.json`,
    `${AD}/hooks/proof-or-stop-scope-pretool.cjs`,
  ];

  for (const rel of required) {
    assert(tracked.has(rel), `repository must track canonical adapter path ${rel}`);
  }
  for (const rel of forbidden) {
    assert(!tracked.has(rel), `repository must not track non-canonical adapter path ${rel}`);
  }
});

checks.push(() => {
  const devCliSource = readFileSync(join(repoRoot, 'packages/main/src/verifier/dev-cli.ts'), 'utf8');
  assertNotIncludes(devCliSource, '--web', 'packages/main/src/verifier/dev-cli.ts');
  assertNotIncludes(devCliSource, '--cli', 'packages/main/src/verifier/dev-cli.ts');
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-serve-flags-'));
  try {
    let rejectedNonZeroExit = false;
    try {
      assertExpectedBoundedExit({ status: 17, signal: null }, 'serve exit contract synthetic non-zero case');
    } catch (error) {
      rejectedNonZeroExit = true;
      assertIncludes(String(error?.message || error), 'exited with status 17', 'serve exit contract non-zero rejection');
    }
    assert(rejectedNonZeroExit, 'serve exit contract must reject a non-zero child exit');

    const localBinDir = join(tempDir, 'node_modules', '.bin');
    mkdirSync(localBinDir, { recursive: true });
    const tsxShim = join(localBinDir, 'tsx');
    writeFileSync(tsxShim, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(tsxShim, 0o755);
    const cliPath = join(repoRoot, 'packages/main/dist/cli.js');
    for (const flag of ['--web', '--cli']) {
      const result = runBounded(process.execPath, [cliPath, '--root', tempDir, 'serve', flag], {
        cwd: tempDir,
        env: process.env,
      });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assertIncludes(output, '🐨 proof-or-stop serve', `proof-or-stop serve ${flag} should still start the normal launcher`);
      assertIncludes(output, 'Waiting for project core to start (.proof-or-stop-serve.json)...', `proof-or-stop serve ${flag} should still boot the normal serve path`);
      assertNotIncludes(output, 'Unknown option', `proof-or-stop serve ${flag} should not be rejected as an unknown option`);
      assertNotIncludes(output, '--web', `proof-or-stop serve ${flag} runtime output`);
      assertNotIncludes(output, '--cli', `proof-or-stop serve ${flag} runtime output`);
      assertExpectedBoundedExit(result, `proof-or-stop serve ${flag}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  // B-cc10 CHK-006: this asserted `bin/proofOrStop.js` was a registered managed asset. That
  // file is now DELETED, and its registration in managed-assets.ts is conditional on the
  // file existing — so the lookup returned undefined and the check failed on `item?.status`.
  // The canonical wrapper is registered unconditionally, which is the invariant that
  // actually matters: the self-repo local wrapper must be recognized as ProofOrStop-owned.
  const result = runManagedAssetCheck(repoRoot, { profile: 'all', assetMode: 'full' });
  const item = result.items.find(asset => asset.relPath === 'bin/proof-or-stop.js');
  assert(item?.status === 'OK', 'self-repo local wrapper should be accepted as ProofOrStop-owned asset');
  // The deprecated alias must NOT be registered any more, since the file is gone.
  const deprecated = result.items.find(asset => asset.relPath === 'bin/proofOrStop.js');
  assert(deprecated === undefined, 'removed bin/proofOrStop.js must no longer register as a managed asset');
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-existing-src-'));
  try {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const alreadyHere = true;\n');

    run('node', [INIT_ENTRYPOINT, tempDir]);
    assertGlobalThinAssets(tempDir, 'core');

    const config = readJson(tempDir, PROOF_OR_STOP_CONFIG_FILENAME);
    assert(config.scanRoot === 'src', 'default proof-or-stop init with preexisting src should keep scanRoot=src');
    assertPathExists(tempDir, 'src/index.ts', 'preexisting src/index.ts');
    assertPathMissing(tempDir, 'src/core/app.ts', 'default proof-or-stop init with preexisting src src/core/app.ts');
    assertPathMissing(tempDir, 'src/shells/cli/main.ts', 'default proof-or-stop init with preexisting src cli shell');
    assertPathMissing(tempDir, 'tests', 'default proof-or-stop init with preexisting src tests');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-gitignore-merge-'));
  try {
    const existingGitignoreLines = [
      'node_modules/',
      'custom-cache/',
      '**/activity.jsonl',
      '',
    ];
    writeFileSync(join(tempDir, '.gitignore'), existingGitignoreLines.join('\n'));

    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, '.gitignore (merged Proof-or-Stop runtime ignores)', 'proof-or-stop init existing .gitignore merge output');

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf8');
    assertIncludes(gitignore, 'custom-cache/', 'existing .gitignore merge should preserve user content');
    assertGitignoreBlock(gitignore, missingRuntimeIgnoreLines(existingGitignoreLines), 'merged .gitignore');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-gitignore-no-churn-'));
  try {
    const gitignoreBefore = `${REQUIRED_RUNTIME_IGNORE_LINES.join('\n')}\n`;
    writeFileSync(join(tempDir, '.gitignore'), gitignoreBefore);

    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, '.gitignore (runtime ignores already present)', 'proof-or-stop init existing .gitignore no-churn output');
    const gitignoreAfter = readFileSync(join(tempDir, '.gitignore'), 'utf8');
    assert(gitignoreAfter === gitignoreBefore, 'proof-or-stop init should not churn .gitignore when runtime ignores are already present');
    assertNotIncludes(gitignoreAfter, MANAGED_GITIGNORE_BLOCK_START, 'no-churn .gitignore should not add a managed block');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  for (const flag of ['--starter', '--with-template']) {
    const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-starter-'));
    try {
      const initOut = run('node', [INIT_ENTRYPOINT, flag, tempDir]);
      assertIncludes(initOut, 'src/core/app.ts', `proof-or-stop init ${flag} output`);
      assertGlobalThinAssets(tempDir, 'core');

      const config = readJson(tempDir, PROOF_OR_STOP_CONFIG_FILENAME);
      assert(config.scanRoot === 'src', `proof-or-stop init ${flag} should set scanRoot=src`);
      assertPathExists(tempDir, 'src/core/app.ts', `proof-or-stop init ${flag} src/core/app.ts`);
      assertPathExists(tempDir, 'src/core/debug.ts', `proof-or-stop init ${flag} src/core/debug.ts`);
      assertPathExists(tempDir, 'src/core/machines/game/bridge.ts', `proof-or-stop init ${flag} bridge.ts`);
      assertPathExists(tempDir, 'src/shells/cli/main.ts', `proof-or-stop init ${flag} cli shell`);
      assertPathExists(tempDir, 'src/shells/web', `proof-or-stop init ${flag} web shell dir`);
      assertPathExists(tempDir, 'tests', `proof-or-stop init ${flag} tests dir`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

checks.push(() => {
  for (const profile of ['codex', 'claude', 'core']) {
    const tempDir = mkdtempSync(join(tmpdir(), `proof-or-stop-entrypoints-profile-${profile}-`));
    try {
      const initOut = run('node', [INIT_ENTRYPOINT, `--profile=${profile}`, '--asset-mode=full', tempDir]);
      assertIncludes(initOut, `Selected init profile: ${profile}`, `${profile} init profile selection`);
      assertIncludes(initOut, `explicit --profile=${profile}`, `${profile} init explicit reason`);
      assertProfileAssets(tempDir, profile);
      if (profile === 'codex') {
        const agents = readFileSync(join(tempDir, 'AGENTS.md'), 'utf8');
        assertIncludes(agents, 'PROOF_OR_STOP.md', 'codex AGENTS should point to PROOF_OR_STOP.md');
        assertNotIncludes(agents, '.claude/agents', 'codex AGENTS should not claim .claude/agents exists');
      }
      if (profile === 'claude') {
        const claude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
        assertIncludes(claude, 'PROOF_OR_STOP.md', 'claude CLAUDE.md should point to PROOF_OR_STOP.md');
        assertIncludes(claude, '.claude/agents', 'claude CLAUDE.md should describe .claude/agents');
        assertIncludes(claude, '.claude/hooks', 'claude CLAUDE.md should describe hooks');
        assertNotIncludes(claude, '正常通道：', 'claude CLAUDE.md should not copy lifecycle flow table');
        assertNotIncludes(claude, '流程事实双层契约', 'claude CLAUDE.md should not copy root long-form truth source');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-explicit-override-'));
  try {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# AGENTS.md\n\nexisting codex marker\n');
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile', 'claude', '--asset-mode=full', '--verify-codex', tempDir]);
    assertIncludes(initOut, 'Selected init profile: claude', 'explicit profile override should select claude');
    assertIncludes(initOut, 'explicit --profile=claude', 'explicit profile override reason');
    assertIncludes(initOut, 'Codex verification skipped: init profile claude does not generate Codex adapter assets', 'explicit claude verify-codex skip');
    assertProfileAssets(tempDir, 'claude', { allowExistingCodex: true });
    assertPathMissing(tempDir, 'bin/proof-or-stop-codex.js', 'explicit claude profile should not create codex wrapper');
    assertPathMissing(tempDir, AD, 'explicit claude profile should not create .proof-or-stop-codex');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-transition-all-codex-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=codex', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: codex', 'all -> codex profile selection');
    assertPathExists(tempDir, 'AGENTS.md', 'all -> codex AGENTS.md');
    assertPathExists(tempDir, CODEX_README_REL, 'all -> codex .proof-or-stop-codex/README.md');
    assertPathMissing(tempDir, 'CLAUDE.md', 'all -> codex should remove managed CLAUDE.md');
    assertPathMissing(tempDir, '.claude/agents', 'all -> codex should remove .claude/agents');
    assertPathMissing(tempDir, '.claude/hooks', 'all -> codex should remove .claude/hooks');
    assertPathMissing(tempDir, '.claude/skills/koala', 'all -> codex should remove .claude/skills/koala');
    assertPathMissing(tempDir, '.claude/settings.json', 'all -> codex should remove managed settings');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-transition-codex-claude-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=codex', '--asset-mode=full', tempDir]);
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=claude', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: claude', 'codex -> claude profile selection');
    assertPathExists(tempDir, 'CLAUDE.md', 'codex -> claude CLAUDE.md');
    assertPathMissing(tempDir, '.claude/agents', 'codex -> claude should keep project-local .claude/agents uncreated');
    assertPathMissing(tempDir, 'AGENTS.md', 'codex -> claude should remove managed AGENTS.md');
    assertPathMissing(tempDir, AD, 'codex -> claude should remove .proof-or-stop-codex');
    assertPathMissing(tempDir, 'bin/proof-or-stop-codex.js', 'codex -> claude should remove generated codex wrapper');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-transition-all-core-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=core', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: core', 'all -> core profile selection');
    assertPathExists(tempDir, 'PROOF_OR_STOP.md', 'all -> core PROOF_OR_STOP.md');
    assertPathExists(tempDir, 'bin/proof-or-stop.js', 'all -> core bin/proof-or-stop.js');
    assertPathMissing(tempDir, 'AGENTS.md', 'all -> core should remove managed AGENTS.md');
    assertPathMissing(tempDir, 'CLAUDE.md', 'all -> core should remove managed CLAUDE.md');
    assertPathMissing(tempDir, AD, 'all -> core should remove .proof-or-stop-codex');
    assertPathMissing(tempDir, '.claude/agents', 'all -> core should remove .claude/agents');
    assertPathMissing(tempDir, '.claude/hooks', 'all -> core should remove .claude/hooks');
    assertPathMissing(tempDir, '.claude/skills/koala', 'all -> core should remove .claude/skills/koala');
    assertPathMissing(tempDir, '.claude/settings.json', 'all -> core should remove managed settings');
    assertPathMissing(tempDir, 'bin/proof-or-stop-codex.js', 'all -> core should remove generated codex wrapper');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-cleanup-preserve-unmarked-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    const agentsOriginal = '# AGENTS.md\n\nuser-owned agents doc\n';
    const claudeOriginal = '# CLAUDE.md\n\nuser-owned claude doc\n';
    writeFileSync(join(tempDir, 'AGENTS.md'), agentsOriginal);
    writeFileSync(join(tempDir, 'CLAUDE.md'), claudeOriginal);

    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=core', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'AGENTS.md (profile skip)', 'core cleanup should not rewrite AGENTS.md');
    assertIncludes(initOut, 'CLAUDE.md (profile skip)', 'core cleanup should not rewrite CLAUDE.md');
    assert(readFileSync(join(tempDir, 'AGENTS.md'), 'utf8') === agentsOriginal, 'core cleanup should preserve unmarked AGENTS.md');
    assert(readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8') === claudeOriginal, 'core cleanup should preserve unmarked CLAUDE.md');
    assertPathMissing(tempDir, AD, 'core cleanup should still remove managed .proof-or-stop-codex');
    assertPathMissing(tempDir, '.claude/agents', 'core cleanup should still remove managed .claude/agents');
    assertPathMissing(tempDir, '.claude/hooks', 'core cleanup should still remove managed .claude/hooks');
    assertPathMissing(tempDir, '.claude/skills/koala', 'core cleanup should still remove managed .claude/skills/koala');
    assertPathMissing(tempDir, '.claude/settings.json', 'core cleanup should still remove managed settings');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-managed-sync-'));
  try {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# AGENTS.md\n\nbefore-agents\n<!-- proof-or-stop:start -->\nold agents section\n<!-- proof-or-stop:end -->\nafter-agents\n');
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# CLAUDE.md\n\nbefore-claude\n<!-- proof-or-stop:start -->\nold claude section\n<!-- proof-or-stop:end -->\nafter-claude\n');
    writeFileSync(join(tempDir, 'PROOF_OR_STOP.md'), '# PROOF_OR_STOP.md\n\nbefore-proof-or-stop\n<!-- proof-or-stop:start -->\nold proof-or-stop section\n<!-- proof-or-stop:end -->\nafter-proof-or-stop\n');

    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);

    const agents = readFileSync(join(tempDir, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    const proofOrStop = readFileSync(join(tempDir, 'PROOF_OR_STOP.md'), 'utf8');
    assertIncludes(agents, 'before-agents', 'AGENTS.md prefix preservation');
    assertIncludes(agents, 'after-agents', 'AGENTS.md suffix preservation');
    assertManagedMarkerSync(agents, 'Codex / AGENTS', 'old agents section', 'AGENTS.md managed sync');
    assertNotIncludes(agents, '.claude/agents', 'AGENTS.md managed sync should not claim .claude/agents exists');
    assertIncludes(claude, 'before-claude', 'CLAUDE.md prefix preservation');
    assertIncludes(claude, 'after-claude', 'CLAUDE.md suffix preservation');
    assertManagedMarkerSync(claude, 'PROOF_OR_STOP.md', 'old claude section', 'CLAUDE.md managed sync');
    assertNotIncludes(claude, '正常通道：', 'CLAUDE.md managed sync should not copy root lifecycle table');
    assertIncludes(proofOrStop, 'before-proof-or-stop', 'PROOF_OR_STOP.md prefix preservation');
    assertIncludes(proofOrStop, 'after-proof-or-stop', 'PROOF_OR_STOP.md suffix preservation');
    assertManagedMarkerSync(proofOrStop, 'host-neutral', 'old proof-or-stop section', 'PROOF_OR_STOP.md managed sync');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-unmanaged-docs-'));
  try {
    const agentsOriginal = '# AGENTS.md\n\nuser-owned agents doc\n';
    const claudeOriginal = '# CLAUDE.md\n\nuser-owned claude doc\n';
    const proofOrStopOriginal = '# PROOF_OR_STOP.md\n\nuser-owned proof-or-stop doc\n';
    writeFileSync(join(tempDir, 'AGENTS.md'), agentsOriginal);
    writeFileSync(join(tempDir, 'CLAUDE.md'), claudeOriginal);
    writeFileSync(join(tempDir, 'PROOF_OR_STOP.md'), proofOrStopOriginal);

    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'AGENTS.md (exists, no Proof-or-Stop managed markers, skip)', 'AGENTS.md unmanaged preservation log');
    assertIncludes(initOut, 'CLAUDE.md (exists, no Proof-or-Stop managed markers, skip)', 'CLAUDE.md unmanaged preservation log');
    assertIncludes(initOut, 'PROOF_OR_STOP.md (exists, no Proof-or-Stop managed markers, skip)', 'PROOF_OR_STOP.md unmanaged preservation log');
    assert(readFileSync(join(tempDir, 'AGENTS.md'), 'utf8') === agentsOriginal, 'AGENTS.md without markers should be preserved');
    assert(readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8') === claudeOriginal, 'CLAUDE.md without markers should be preserved');
    assert(readFileSync(join(tempDir, 'PROOF_OR_STOP.md'), 'utf8') === proofOrStopOriginal, 'PROOF_OR_STOP.md without markers should be preserved');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-python-'));
  try {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "proof-or-stop-smoke"\nversion = "0.0.0"\n');
    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, '检测到 Python 项目', 'python no-src proof-or-stop init output');
    assertGlobalThinAssets(tempDir, 'core');

    const config = readJson(tempDir, PROOF_OR_STOP_CONFIG_FILENAME);
    assert(config.language === 'python', 'python no-src proof-or-stop init should set language=python');
    assert(config.scanRoot === '.', 'python no-src proof-or-stop init should set scanRoot=.');
    assertPathMissing(tempDir, 'src', 'python no-src proof-or-stop init src');
    assertPathMissing(tempDir, 'tests', 'python no-src proof-or-stop init tests');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  for (const profile of ['claude', 'core']) {
    const tempDir = mkdtempSync(join(tmpdir(), `proof-or-stop-entrypoints-verify-skip-${profile}-`));
    try {
      const out = run(process.execPath, [INIT_ENTRYPOINT, `--profile=${profile}`, '--asset-mode=full', '--verify-codex', tempDir]);
      assertIncludes(out, `Codex verification skipped: init profile ${profile} does not generate Codex adapter assets`, `${profile} verify-codex skip`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'proof-or-stop-entrypoints-minpath-'));
  const staleBin = join(tempDir, 'stale-bin');
  try {
    mkdirSync(staleBin);
    const staleCli = join(staleBin, 'proof-or-stop');
    writeFileSync(staleCli, '#!/bin/sh\necho "stale proof-or-stop without verify_codex"\nexit 0\n');
    chmodSync(staleCli, 0o755);
    const initOut = run(process.execPath, [CORE_ENTRYPOINT, 'init', '--profile=all', '--asset-mode=full', tempDir], {
      env: {
        ...process.env,
        PATH: `${staleBin}:/usr/bin:/bin`,
      },
    });
    assertIncludes(initOut, 'Selected init profile: all', 'fresh proof-or-stop init minimal PATH profile selection');
    const cleanupClaudeMirror = seedClaudeAgentMirror(tempDir);
    let verifyOut;
    try {
      const globalShimDir = installGlobalFallbackShim(tempDir);
      verifyOut = run(process.execPath, [join(tempDir, 'bin', 'proof-or-stop.js'), 'verify_codex'], {
        cwd: tempDir,
        env: { ...process.env, PATH: `${globalShimDir}:${process.env.PATH || ''}` },
      });
    } finally {
      cleanupClaudeMirror();
    }
    assertIncludes(verifyOut, 'Codex adapter checks passed', 'fresh proof-or-stop verify_codex minimal PATH output');
    assertIncludes(verifyOut, 'Local wrapper heartbeat: source=codex', 'fresh proof-or-stop verify_codex should execute generated wrapper heartbeat');
    // B-cdf6: same stale-literal defect already fixed above at the first mirror
    // assertion — this second site was missed. The registry has 17 roles, so the
    // pinned `16` fails regardless of whether the mirror itself is correct. Derive
    // it so adding or removing a role cannot rot either call site again.
    assertIncludes(
      verifyOut,
      `Codex agents mirror: ${readPromptRegistry().agents.length} prompt(s) mirrored`,
      'fresh proof-or-stop verify_codex should pass via generated local bootstrap',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const cleanupXstateStub = installTemporaryXstateStub();
try {
  for (const [index, check] of checks.entries()) {
    check();
    console.log(`ok ${index + 1}/${checks.length}`);
  }

  console.log('entrypoints verified');
} finally {
  cleanupXstateStub();
}
