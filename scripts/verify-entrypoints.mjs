#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { runManagedAssetCheck } from '../packages/main/dist/core/managed-assets.js';
import {
  LATTICE_RUNTIME_IGNORE_BLOCK_END,
  LATTICE_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from '../packages/main/dist/core/runtime-artifact-registry.js';

const repoRoot = process.cwd();
const GLOBAL_CODEX_FALLBACK = 'LATTICE_ACTIVITY_SOURCE=codex LATTICE_ACTIVITY_RECORD_READONLY=1 LATTICE_CODEX_ENTRYPOINT=global-fallback lattice';
const INIT_ENTRYPOINT = 'packages/main/dist/cli-init.js';
const CORE_ENTRYPOINT = 'packages/main/dist/cli.js';
const MANAGED_GITIGNORE_BLOCK_START = LATTICE_RUNTIME_IGNORE_BLOCK_START;
const MANAGED_GITIGNORE_BLOCK_END = LATTICE_RUNTIME_IGNORE_BLOCK_END;
const REQUIRED_RUNTIME_IGNORE_LINES = listRuntimeArtifactIgnorePatterns();

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
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

function seedClaudeAgentMirror(tempDir) {
  const sourceDir = join(repoRoot, 'packages/main/templates/agents');
  const mirrorDir = join(tempDir, '.claude', 'agents');
  mkdirSync(mirrorDir, { recursive: true });
  for (const file of readdirSync(sourceDir).filter(name => name.endsWith('.md'))) {
    writeFileSync(join(mirrorDir, file), readFileSync(join(sourceDir, file), 'utf8'));
  }
  return () => rmSync(mirrorDir, { recursive: true, force: true });
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
  assertIncludes(help, '.lattice/Lattice.md', label);
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
  assertIncludes(content, '<!-- lattice:start -->', label);
  assertIncludes(content, '<!-- lattice:end -->', label);
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
  const present = ['LATTICE.md', 'bin/lattice.js', 'lattice.config.json'];
  const absent = [];

  if (profile === 'codex' || profile === 'all') {
    present.push(
      'AGENTS.md',
      'bin/lattice-codex.js',
      '.lattice-codex/README.md',
      '.lattice-codex/lattice.json',
      '.lattice-codex/agents/test-intent.md',
      '.lattice-codex/agents/test-case-reviewer.md',
      '.lattice-codex/agents/lattice-review-quality.md',
      '.lattice-codex/agents/lattice-implementer.md',
    );
  } else if (!opts.allowExistingCodex) {
    absent.push('AGENTS.md', 'bin/lattice-codex.js', '.lattice-codex');
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
  const present = ['.lattice/Lattice.md', '.lattice/lattice.json', 'lattice.config.json'];
  const absent = ['LATTICE.md', 'bin/lattice.js', 'bin/lattice-codex.js', '.lattice-codex'];

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
  const activityPath = [
    join(repoRoot, '.lattice', 'activity.jsonl'),
    join(repoRoot, '.koala', 'activity.jsonl'),
  ].find(existsSync);
  if (!activityPath) return null;
  const text = readFileSync(activityPath, 'utf8').trim();
  if (!text) return null;
  const entries = text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return entries.findLast(entry => entry.session === session && entry.tool === tool) || null;
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
  const storyDir = [
    join(repoRoot, '.lattice', 'story', 'actives', storyId),
    join(repoRoot, '.koala', 'story', 'actives', storyId),
  ].find(existsSync);
  if (!storyDir) return null;
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
    LATTICE_ACTIVITY_SOURCE: 'not-codex',
    LATTICE_ACTIVITY_SESSION: '',
    CODEX_SESSION_ID: '',
    OPENAI_SESSION_ID: '',
    TERM_SESSION_ID: '',
    [envName]: marker,
  };
  const out = run('node', ['bin/lattice-codex.js', 'session_brief'], { env });
  assert(
    /# lattice session brief/.test(out),
    `bin/lattice-codex.js ${envName} session_brief missing session_brief heading`,
  );

  const record = readActivityRecord(marker, 'session_brief');
  assert(record, `bin/lattice-codex.js should derive session from ${envName}`);
  assert(record.source === 'codex', 'bin/lattice-codex.js should force activity source=codex');
  assert(record.entrypoint === 'local-wrapper', 'bin/lattice-codex.js should mark entrypoint=local-wrapper');
  return marker;
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
  const out = run('node', ['bin/lattice.js', 'aux_doc_list', '--format=json']);
  assertIncludes(out, '"docs"', 'bin/lattice.js aux_doc_list');
  assertPathMissing(repoRoot, 'bin/koala.js', 'legacy local koala wrapper');
  assertPathMissing(repoRoot, 'bin/koala-codex.js', 'legacy local koala Codex wrapper');
  assertPathMissing(repoRoot, '.lattice-codex/koala.json', 'legacy Codex manifest');
});

checks.push(() => {
  const coreHelp = run('node', [CORE_ENTRYPOINT, 'init', '--help']);
  assertInitHelpDocumentsStarterAsOptional(coreHelp, 'repo-local core CLI init --help');

  const localWrapperHelp = run('node', ['bin/lattice.js', 'init', '--help']);
  assertInitHelpDocumentsStarterAsOptional(localWrapperHelp, 'repo-local bin/lattice.js init --help');
});

checks.push(() => {
  const marker = assertCodexWrapperSessionFrom('CODEX_SESSION_ID');
  if (currentStoryId()) {
    const event = readProcessEvent(marker, 'session_brief');
    assert(event, 'bin/lattice-codex.js should write codex_cli process-event in active story');
    assert(event.source === 'codex' && event.entrypoint === 'local-wrapper', 'codex_cli event should include source and local wrapper entrypoint');
  }
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
      LATTICE_ACTIVITY_SOURCE: 'codex',
      LATTICE_ACTIVITY_RECORD_READONLY: '1',
      LATTICE_ACTIVITY_SESSION: marker,
    },
  });
  assert(
    /# (?:lattice|koala) session brief/.test(out),
    'global Codex fallback core CLI session_brief missing session_brief heading',
  );

  const record = readActivityRecord(marker, 'session_brief');
  assert(record, 'global Codex fallback should write a session_brief activity record');
  assert(record.source === 'codex', 'global Codex fallback should write source=codex');
  assert(record.entrypoint === 'global-fallback', 'global Codex fallback should mark entrypoint=global-fallback');
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-default-fallback-'));
  try {
    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, 'Selected init profile: core', 'lattice init default fallback profile selection');
    assertIncludes(initOut, 'global-thin default', 'lattice init default fallback reason');
    assertGlobalThinAssets(tempDir, 'core');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-'));
  try {
    mkdirSync(join(tempDir, '.lattice-codex', 'agents'), { recursive: true });
    writeFileSync(join(tempDir, '.lattice-codex', 'agents', 'implementer.md'), 'old codex-only prompt\n');
    writeFileSync(join(tempDir, '.lattice-codex', 'agents', 'reviewer.md'), 'old codex-only prompt\n');

    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: all', 'lattice init explicit all profile selection');
    assertIncludes(initOut, 'explicit --profile=all', 'lattice init explicit all reason');
    assertIncludes(initOut, 'no per-project files', 'lattice init should advertise global thin-shim agent mode');
    assertIncludes(initOut, '.lattice-codex/README.md', 'lattice init output');
    assertProfileAssets(tempDir, 'all');

    const defaultConfig = readJson(tempDir, 'lattice.config.json');
    assert(defaultConfig.scanRoot === '.', 'default lattice init without preexisting src should set scanRoot=.');
    assertPathMissing(tempDir, 'src/core', 'default lattice init src/core');
    assertPathMissing(tempDir, 'src/shells', 'default lattice init src/shells');
    assertPathMissing(tempDir, 'tests', 'default lattice init tests');
    assertManagedMarkerSync(readFileSync(join(tempDir, 'LATTICE.md'), 'utf8'), 'host-neutral', null, 'LATTICE.md');
    const generatedClaude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    assertIncludes(generatedClaude, 'LATTICE.md', 'all profile CLAUDE.md should point to LATTICE.md');
    assertNotIncludes(generatedClaude, '正常通道：', 'all profile CLAUDE.md should not copy root lifecycle table');

    const codexReadme = readFileSync(join(tempDir, '.lattice-codex', 'README.md'), 'utf8');
    assertIncludes(codexReadme, 'node bin/lattice-codex.js session_brief', '.lattice-codex/README.md');
    assertIncludes(codexReadme, `${GLOBAL_CODEX_FALLBACK} session_brief`, '.lattice-codex/README.md');
    assertIncludes(codexReadme, '不要把 fallback 的 `status` / `next` / `validate` 输出当作 gate 证据', '.lattice-codex/README.md');
    assertIncludes(codexReadme, '.lattice-codex/lattice.json', '.lattice-codex/README.md');
    assertIncludes(codexReadme, 'Codex 官方 PreToolUse hook 使用小写 `.codex/hooks.json`', '.lattice-codex/README.md');

    const codexManifest = readJson(tempDir, '.lattice-codex/lattice.json');
    assert(codexManifest.adapterOwner === 'lattice', 'adapter manifest should be owned by lattice');
    assert(codexManifest.activitySource === 'codex', 'adapter manifest should declare activitySource=codex');
    assert(
      codexManifest.recommendedEntrypoints.some(entry => entry.command === 'node bin/lattice-codex.js'),
      'adapter manifest should recommend the local Codex wrapper',
    );
    assert(
      codexManifest.recommendedEntrypoints[0]?.command === 'node bin/lattice-codex.js',
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
      codexManifest.sessionEnv.sessionCandidates.includes('CODEX_SESSION_ID')
        && codexManifest.sessionEnv.sessionCandidates.includes('OPENAI_SESSION_ID')
        && codexManifest.sessionEnv.sessionCandidates.includes('TERM_SESSION_ID'),
      'adapter manifest should document Codex/OpenAI/terminal session env candidates',
    );
    assert(codexManifest.sessionEnv.recordReadOnly === 'LATTICE_ACTIVITY_RECORD_READONLY', 'adapter manifest should document read-only activity opt-in');
    assert(!codexManifest.excludedRuntimeAssets.includes('.lattice-codex/hooks'), 'adapter manifest should allow managed Codex native hooks');
    assert(codexManifest.excludedRuntimeAssets.includes('.lattice-codex/settings.json'), 'adapter manifest should exclude .lattice-codex/settings.json');
    assertPathExists(tempDir, '.codex/hooks', 'lattice init .codex/hooks');
    assertPathExists(tempDir, '.codex/hooks.json', 'lattice init .codex/hooks.json');
    assertPathMissing(tempDir, '.lattice-codex/settings.json', 'lattice init .lattice-codex/settings.json');

    const codexAgents = readdirSync(join(tempDir, '.lattice-codex', 'agents'));
    assert(!codexAgents.includes('implementer.md'), 'lattice init should not keep stale Codex-only implementer.md');
    assert(!codexAgents.includes('reviewer.md'), 'lattice init should not keep stale Codex-only reviewer.md');

    const generatedWrapper = readFileSync(join(tempDir, 'bin', 'lattice-codex.js'), 'utf8');
    const generatedBootstrap = readFileSync(join(tempDir, 'bin', 'lattice.js'), 'utf8');
    assert(existsSync(join(tempDir, 'bin', 'lattice.js')), 'lattice init should generate sibling bin/lattice.js');
    assertIncludes(generatedWrapper, "join(binDir, 'lattice.js')", 'generated Codex wrapper local bootstrap check');
    assertNotIncludes(generatedWrapper, "spawnSync('koala'", 'generated Codex wrapper should not delegate directly to global koala');
    assertIncludes(generatedWrapper, 'lattice init --verify-codex', 'generated Codex wrapper recovery hint');
    assertIncludes(generatedBootstrap, 'coreCliEngineCandidates', 'generated local bootstrap candidate list');
    assertIncludes(generatedBootstrap, "node_modules', '@lattice-agent', 'core'", 'generated local bootstrap should search local @lattice-agent/core first');
    assertNotIncludes(generatedBootstrap, "@koala-agent", 'generated local bootstrap should not search @koala-agent/core fallback');
    assertNotIncludes(generatedBootstrap, 'bin/koala.js', 'generated local bootstrap should not mention bin/koala.js');
    assertNotIncludes(generatedBootstrap, "spawnSync('koala'", 'generated local bootstrap should not delegate to global koala');
    assertIncludes(generatedBootstrap, "typeof mod.runCli", 'generated local bootstrap should execute a local CLI engine');
    assertIncludes(generatedBootstrap, "!help.includes('aux_doc_list') || !help.includes('verify_codex')", 'generated local bootstrap should reject stale global fallback');
    assertPathMissing(tempDir, 'bin/koala.js', 'full init should not generate bin/koala.js');
    assertPathMissing(tempDir, 'bin/koala-codex.js', 'full init should not generate bin/koala-codex.js');
    assertPathMissing(tempDir, '.lattice-codex/koala.json', 'full init should not generate .lattice-codex/koala.json');

    const cleanupClaudeMirror = seedClaudeAgentMirror(tempDir);
    const verifyInitOut = run(process.execPath, [join(tempDir, 'bin', 'lattice.js'), 'verify_codex'], { cwd: tempDir });
    assertIncludes(verifyInitOut, 'Codex adapter checks passed', 'lattice verify_codex output');
    assertIncludes(verifyInitOut, 'Codex agents mirror: 16 prompt(s) mirrored', 'lattice verify_codex mirror check');
    assertPathMissing(tempDir, 'src/core', 'lattice verify_codex src/core');
    assertPathMissing(tempDir, 'src/shells', 'lattice verify_codex src/shells');
    assertPathMissing(tempDir, 'tests', 'lattice verify_codex tests');

    const staleBin = join(tempDir, 'stale-bin');
    mkdirSync(staleBin);
    const staleLattice = join(staleBin, 'lattice');
    writeFileSync(staleLattice, '#!/bin/sh\necho "stale lattice without Codex adapter commands"\nexit 0\n');
    chmodSync(staleLattice, 0o755);
    const minimalEnv = {
      ...process.env,
      PATH: `${staleBin}:/usr/bin:/bin`,
      LATTICE_ACTIVITY_SOURCE: 'not-codex',
      LATTICE_ACTIVITY_SESSION: `fresh-init-wrapper-${Date.now()}`,
    };
    const freshWrapperOut = run(process.execPath, [join(tempDir, 'bin', 'lattice-codex.js'), 'session_brief'], { cwd: tempDir, env: minimalEnv });
    assertIncludes(freshWrapperOut, '# lattice session brief', 'fresh generated wrapper should run with stale global lattice on PATH');

    const checkOk = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    assert(checkOk.ok === true, 'lattice check should pass immediately after init');
    assert(checkOk.profile === 'all', 'lattice check should detect all profile after all init');

    writeFileSync(join(tempDir, '.lattice-codex', 'lattice.json'), '{}\n');
    const checkDrift = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    assert(checkDrift.ok === false, 'lattice check should report drift after managed manifest edit');
    assert(
      checkDrift.items.some(item => item.relPath === '.lattice-codex/lattice.json' && item.status === 'STALE_SAFE'),
      'lattice check should classify generated Codex manifest drift as STALE_SAFE',
    );

    const checkApply = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--apply', '--json'], { cwd: tempDir }));
    assert(checkApply.ok === true, 'lattice check --apply should repair safe managed drift');
    assert(checkApply.applied.includes('.lattice-codex/lattice.json'), 'lattice check --apply should report applied managed manifest');
    assert(readJson(tempDir, '.lattice-codex/lattice.json').adapterOwner === 'lattice', 'lattice check --apply should restore Codex manifest');
    assertPathExists(tempDir, '.lattice/managed-assets.json', 'lattice check --apply manifest');

    run('git', ['init'], { cwd: tempDir });
    writeFileSync(join(tempDir, 'lattice-user-note.txt'), 'uncommitted local work\n');
    writeFileSync(join(tempDir, '.lattice-codex', 'lattice.json'), '{}\n');
    const checkUpgrade = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--upgrade', '--json'], { cwd: tempDir }));
    assert(checkUpgrade.ok === true, 'lattice check --upgrade should repair safe managed drift');
    assert(checkUpgrade.mode === 'upgrade', 'lattice check --upgrade should report upgrade mode');
    assert(checkUpgrade.applied.includes('.lattice-codex/lattice.json'), 'lattice check --upgrade should report applied managed manifest');
    assert(
      checkUpgrade.warnings.some(warning => warning.includes('working tree already has')),
      'lattice check --upgrade should warn before syncing into a dirty worktree',
    );

    const originalClaude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(tempDir, 'CLAUDE.md'), [
      '# CLAUDE.md',
      '',
      '<!-- lattice:start -->',
      '## Local Project Rule',
      '',
      'Preserve this locally edited Claude instruction.',
      '<!-- lattice:end -->',
      '',
    ].join('\n'));
    const checkLocalReview = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--review-local-edits', '--json'], { cwd: tempDir }));
    const claudeReview = checkLocalReview.localEditReviews.find(review => review.relPath === 'CLAUDE.md');
    assert(checkLocalReview.ok === false, 'lattice check --review-local-edits should preserve STALE_LOCAL_EDIT status');
    assert(claudeReview, 'lattice check --review-local-edits should report CLAUDE.md review data');
    assert(
      claudeReview.localOnlyHeadings.includes('Local Project Rule'),
      'lattice check --review-local-edits should surface local-only headings',
    );
    writeFileSync(join(tempDir, 'CLAUDE.md'), originalClaude);

    mkdirSync(join(tempDir, '.lattice-codex', 'settings.json'), { recursive: true });
    const checkExcludedDirectory = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    const excludedDirectoryItem = checkExcludedDirectory.items.find(item => item.relPath === '.lattice-codex/settings.json');
    assert(checkExcludedDirectory.ok === false, 'lattice check should report excluded directory drift');
    assert(
      excludedDirectoryItem?.status === 'INCOMPATIBLE' && excludedDirectoryItem.reason.includes('directory'),
      'lattice check should classify directory at excluded asset path without throwing EISDIR',
    );
    rmSync(join(tempDir, '.lattice-codex', 'settings.json'), { recursive: true, force: true });

    rmSync(join(tempDir, '.lattice-codex', 'README.md'), { force: true });
    mkdirSync(join(tempDir, '.lattice-codex', 'README.md'));
    const checkManagedFileDirectory = JSON.parse(run(process.execPath, [join(repoRoot, CORE_ENTRYPOINT), 'check', '--json'], { cwd: tempDir }));
    const managedFileDirectoryItem = checkManagedFileDirectory.items.find(item => item.relPath === '.lattice-codex/README.md');
    assert(
      managedFileDirectoryItem?.status === 'INCOMPATIBLE' && managedFileDirectoryItem.reason.includes('expected a file'),
      'lattice check should classify directory at managed file path without throwing EISDIR',
    );

    cleanupClaudeMirror();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-case-mismatch-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    rmSync(join(tempDir, 'LATTICE.md'), { force: true });
    writeFileSync(join(tempDir, 'Lattice.md'), '# Lattice.md\n\nmixed-case Lattice guide\n');
    const result = runManagedAssetCheck(tempDir, { profile: 'all' });
    const item = result.items.find(asset => asset.relPath === 'LATTICE.md');
    assert(item?.status === 'CASE_MISMATCH', 'lattice check should classify LATTICE.md casing drift as CASE_MISMATCH');
    assert(item.actualRelPath === 'Lattice.md', 'lattice check should report the mixed-case actual path');
    assert(item.reason.includes('different case'), 'lattice check should explain path casing drift');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tracked = new Set(run('git', ['ls-files']).trim().split(/\r?\n/).filter(Boolean));
  const required = [
    '.lattice/Lattice.md',
    '.lattice/lattice.json',
    '.codex/hooks.json',
    '.codex/hooks/lattice-scope-pretool.cjs',
  ];
  const forbidden = [
    '.Lattice/Lattice.md',
    '.Lattice/lattice.json',
    '.lattice-codex/hooks.json',
    '.lattice-codex/hooks/lattice-scope-pretool.cjs',
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
  const result = runManagedAssetCheck(repoRoot, { profile: 'all', assetMode: 'full' });
  const item = result.items.find(asset => asset.relPath === 'bin/lattice.js');
  assert(item?.status === 'OK', 'self-repo local wrapper should be accepted as Lattice-owned compatibility asset');
  assert(item.reason.includes('recognized Lattice compatibility contract'), 'self-repo local wrapper should explain alternate contract');
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-existing-src-'));
  try {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const alreadyHere = true;\n');

    run('node', [INIT_ENTRYPOINT, tempDir]);
    assertGlobalThinAssets(tempDir, 'core');

    const config = readJson(tempDir, 'lattice.config.json');
    assert(config.scanRoot === 'src', 'default lattice init with preexisting src should keep scanRoot=src');
    assertPathExists(tempDir, 'src/index.ts', 'preexisting src/index.ts');
    assertPathMissing(tempDir, 'src/core/app.ts', 'default lattice init with preexisting src src/core/app.ts');
    assertPathMissing(tempDir, 'src/shells/cli/main.ts', 'default lattice init with preexisting src cli shell');
    assertPathMissing(tempDir, 'tests', 'default lattice init with preexisting src tests');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-gitignore-merge-'));
  try {
    const existingGitignoreLines = [
      'node_modules/',
      'custom-cache/',
      '**/activity.jsonl',
      '',
    ];
    writeFileSync(join(tempDir, '.gitignore'), existingGitignoreLines.join('\n'));

    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, '.gitignore (merged Lattice runtime ignores)', 'lattice init existing .gitignore merge output');

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf8');
    assertIncludes(gitignore, 'custom-cache/', 'existing .gitignore merge should preserve user content');
    assertGitignoreBlock(gitignore, missingRuntimeIgnoreLines(existingGitignoreLines), 'merged .gitignore');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-gitignore-no-churn-'));
  try {
    const gitignoreBefore = `${REQUIRED_RUNTIME_IGNORE_LINES.join('\n')}\n`;
    writeFileSync(join(tempDir, '.gitignore'), gitignoreBefore);

    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, '.gitignore (runtime ignores already present)', 'lattice init existing .gitignore no-churn output');
    const gitignoreAfter = readFileSync(join(tempDir, '.gitignore'), 'utf8');
    assert(gitignoreAfter === gitignoreBefore, 'lattice init should not churn .gitignore when runtime ignores are already present');
    assertNotIncludes(gitignoreAfter, MANAGED_GITIGNORE_BLOCK_START, 'no-churn .gitignore should not add a managed block');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  for (const flag of ['--starter', '--with-template']) {
    const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-starter-'));
    try {
      const initOut = run('node', [INIT_ENTRYPOINT, flag, tempDir]);
      assertIncludes(initOut, 'src/core/app.ts', `lattice init ${flag} output`);
      assertGlobalThinAssets(tempDir, 'core');

      const config = readJson(tempDir, 'lattice.config.json');
      assert(config.scanRoot === 'src', `lattice init ${flag} should set scanRoot=src`);
      assertPathExists(tempDir, 'src/core/app.ts', `lattice init ${flag} src/core/app.ts`);
      assertPathExists(tempDir, 'src/core/debug.ts', `lattice init ${flag} src/core/debug.ts`);
      assertPathExists(tempDir, 'src/core/machines/game/bridge.ts', `lattice init ${flag} bridge.ts`);
      assertPathExists(tempDir, 'src/shells/cli/main.ts', `lattice init ${flag} cli shell`);
      assertPathExists(tempDir, 'src/shells/web', `lattice init ${flag} web shell dir`);
      assertPathExists(tempDir, 'tests', `lattice init ${flag} tests dir`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

checks.push(() => {
  for (const profile of ['codex', 'claude', 'core']) {
    const tempDir = mkdtempSync(join(tmpdir(), `lattice-entrypoints-profile-${profile}-`));
    try {
      const initOut = run('node', [INIT_ENTRYPOINT, `--profile=${profile}`, '--asset-mode=full', tempDir]);
      assertIncludes(initOut, `Selected init profile: ${profile}`, `${profile} init profile selection`);
      assertIncludes(initOut, `explicit --profile=${profile}`, `${profile} init explicit reason`);
      assertProfileAssets(tempDir, profile);
      if (profile === 'codex') {
        const agents = readFileSync(join(tempDir, 'AGENTS.md'), 'utf8');
        assertIncludes(agents, 'LATTICE.md', 'codex AGENTS should point to LATTICE.md');
        assertNotIncludes(agents, '.claude/agents', 'codex AGENTS should not claim .claude/agents exists');
      }
      if (profile === 'claude') {
        const claude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
        assertIncludes(claude, 'LATTICE.md', 'claude CLAUDE.md should point to LATTICE.md');
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
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-explicit-override-'));
  try {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# AGENTS.md\n\nexisting codex marker\n');
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile', 'claude', '--asset-mode=full', '--verify-codex', tempDir]);
    assertIncludes(initOut, 'Selected init profile: claude', 'explicit profile override should select claude');
    assertIncludes(initOut, 'explicit --profile=claude', 'explicit profile override reason');
    assertIncludes(initOut, 'Codex verification skipped: init profile claude does not generate Codex adapter assets', 'explicit claude verify-codex skip');
    assertProfileAssets(tempDir, 'claude', { allowExistingCodex: true });
    assertPathMissing(tempDir, 'bin/lattice-codex.js', 'explicit claude profile should not create codex wrapper');
    assertPathMissing(tempDir, '.lattice-codex', 'explicit claude profile should not create .lattice-codex');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-transition-all-codex-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=codex', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: codex', 'all -> codex profile selection');
    assertPathExists(tempDir, 'AGENTS.md', 'all -> codex AGENTS.md');
    assertPathExists(tempDir, '.lattice-codex/README.md', 'all -> codex .lattice-codex/README.md');
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
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-transition-codex-claude-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=codex', '--asset-mode=full', tempDir]);
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=claude', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: claude', 'codex -> claude profile selection');
    assertPathExists(tempDir, 'CLAUDE.md', 'codex -> claude CLAUDE.md');
    assertPathMissing(tempDir, '.claude/agents', 'codex -> claude should keep project-local .claude/agents uncreated');
    assertPathMissing(tempDir, 'AGENTS.md', 'codex -> claude should remove managed AGENTS.md');
    assertPathMissing(tempDir, '.lattice-codex', 'codex -> claude should remove .lattice-codex');
    assertPathMissing(tempDir, 'bin/lattice-codex.js', 'codex -> claude should remove generated codex wrapper');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-transition-all-core-'));
  try {
    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=core', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'Selected init profile: core', 'all -> core profile selection');
    assertPathExists(tempDir, 'LATTICE.md', 'all -> core LATTICE.md');
    assertPathExists(tempDir, 'bin/lattice.js', 'all -> core bin/lattice.js');
    assertPathMissing(tempDir, 'AGENTS.md', 'all -> core should remove managed AGENTS.md');
    assertPathMissing(tempDir, 'CLAUDE.md', 'all -> core should remove managed CLAUDE.md');
    assertPathMissing(tempDir, '.lattice-codex', 'all -> core should remove .lattice-codex');
    assertPathMissing(tempDir, '.claude/agents', 'all -> core should remove .claude/agents');
    assertPathMissing(tempDir, '.claude/hooks', 'all -> core should remove .claude/hooks');
    assertPathMissing(tempDir, '.claude/skills/koala', 'all -> core should remove .claude/skills/koala');
    assertPathMissing(tempDir, '.claude/settings.json', 'all -> core should remove managed settings');
    assertPathMissing(tempDir, 'bin/lattice-codex.js', 'all -> core should remove generated codex wrapper');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-cleanup-preserve-unmarked-'));
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
    assertPathMissing(tempDir, '.lattice-codex', 'core cleanup should still remove managed .lattice-codex');
    assertPathMissing(tempDir, '.claude/agents', 'core cleanup should still remove managed .claude/agents');
    assertPathMissing(tempDir, '.claude/hooks', 'core cleanup should still remove managed .claude/hooks');
    assertPathMissing(tempDir, '.claude/skills/koala', 'core cleanup should still remove managed .claude/skills/koala');
    assertPathMissing(tempDir, '.claude/settings.json', 'core cleanup should still remove managed settings');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-managed-sync-'));
  try {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# AGENTS.md\n\nbefore-agents\n<!-- lattice:start -->\nold agents section\n<!-- lattice:end -->\nafter-agents\n');
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# CLAUDE.md\n\nbefore-claude\n<!-- lattice:start -->\nold claude section\n<!-- lattice:end -->\nafter-claude\n');
    writeFileSync(join(tempDir, 'LATTICE.md'), '# LATTICE.md\n\nbefore-lattice\n<!-- lattice:start -->\nold lattice section\n<!-- lattice:end -->\nafter-lattice\n');

    run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);

    const agents = readFileSync(join(tempDir, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    const lattice = readFileSync(join(tempDir, 'LATTICE.md'), 'utf8');
    assertIncludes(agents, 'before-agents', 'AGENTS.md prefix preservation');
    assertIncludes(agents, 'after-agents', 'AGENTS.md suffix preservation');
    assertManagedMarkerSync(agents, 'Codex / AGENTS', 'old agents section', 'AGENTS.md managed sync');
    assertNotIncludes(agents, '.claude/agents', 'AGENTS.md managed sync should not claim .claude/agents exists');
    assertIncludes(claude, 'before-claude', 'CLAUDE.md prefix preservation');
    assertIncludes(claude, 'after-claude', 'CLAUDE.md suffix preservation');
    assertManagedMarkerSync(claude, 'LATTICE.md', 'old claude section', 'CLAUDE.md managed sync');
    assertNotIncludes(claude, '正常通道：', 'CLAUDE.md managed sync should not copy root lifecycle table');
    assertIncludes(lattice, 'before-lattice', 'LATTICE.md prefix preservation');
    assertIncludes(lattice, 'after-lattice', 'LATTICE.md suffix preservation');
    assertManagedMarkerSync(lattice, 'host-neutral', 'old lattice section', 'LATTICE.md managed sync');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-unmanaged-docs-'));
  try {
    const agentsOriginal = '# AGENTS.md\n\nuser-owned agents doc\n';
    const claudeOriginal = '# CLAUDE.md\n\nuser-owned claude doc\n';
    const latticeOriginal = '# LATTICE.md\n\nuser-owned lattice doc\n';
    writeFileSync(join(tempDir, 'AGENTS.md'), agentsOriginal);
    writeFileSync(join(tempDir, 'CLAUDE.md'), claudeOriginal);
    writeFileSync(join(tempDir, 'LATTICE.md'), latticeOriginal);

    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=all', '--asset-mode=full', tempDir]);
    assertIncludes(initOut, 'AGENTS.md (exists, no Lattice managed markers, skip)', 'AGENTS.md unmanaged preservation log');
    assertIncludes(initOut, 'CLAUDE.md (exists, no Lattice managed markers, skip)', 'CLAUDE.md unmanaged preservation log');
    assertIncludes(initOut, 'LATTICE.md (exists, no Lattice managed markers, skip)', 'LATTICE.md unmanaged preservation log');
    assert(readFileSync(join(tempDir, 'AGENTS.md'), 'utf8') === agentsOriginal, 'AGENTS.md without markers should be preserved');
    assert(readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8') === claudeOriginal, 'CLAUDE.md without markers should be preserved');
    assert(readFileSync(join(tempDir, 'LATTICE.md'), 'utf8') === latticeOriginal, 'LATTICE.md without markers should be preserved');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-python-'));
  try {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "lattice-smoke"\nversion = "0.0.0"\n');
    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, '检测到 Python 项目', 'python no-src lattice init output');
    assertGlobalThinAssets(tempDir, 'core');

    const config = readJson(tempDir, 'lattice.config.json');
    assert(config.language === 'python', 'python no-src lattice init should set language=python');
    assert(config.scanRoot === '.', 'python no-src lattice init should set scanRoot=.');
    assertPathMissing(tempDir, 'src', 'python no-src lattice init src');
    assertPathMissing(tempDir, 'tests', 'python no-src lattice init tests');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  for (const profile of ['claude', 'core']) {
    const tempDir = mkdtempSync(join(tmpdir(), `lattice-entrypoints-verify-skip-${profile}-`));
    try {
      const out = run(process.execPath, [INIT_ENTRYPOINT, `--profile=${profile}`, '--asset-mode=full', '--verify-codex', tempDir]);
      assertIncludes(out, `Codex verification skipped: init profile ${profile} does not generate Codex adapter assets`, `${profile} verify-codex skip`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lattice-entrypoints-minpath-'));
  const staleBin = join(tempDir, 'stale-bin');
  try {
    mkdirSync(staleBin);
    const staleCli = join(staleBin, 'lattice');
    writeFileSync(staleCli, '#!/bin/sh\necho "stale lattice without verify_codex"\nexit 0\n');
    chmodSync(staleCli, 0o755);
    const initOut = run(process.execPath, [CORE_ENTRYPOINT, 'init', '--profile=all', '--asset-mode=full', tempDir], {
      env: {
        ...process.env,
        PATH: `${staleBin}:/usr/bin:/bin`,
      },
    });
    assertIncludes(initOut, 'Selected init profile: all', 'fresh lattice init minimal PATH profile selection');
    const cleanupClaudeMirror = seedClaudeAgentMirror(tempDir);
    let verifyOut;
    try {
      verifyOut = run(process.execPath, [join(tempDir, 'bin', 'lattice.js'), 'verify_codex'], {
        cwd: tempDir,
      });
    } finally {
      cleanupClaudeMirror();
    }
    assertIncludes(verifyOut, 'Codex adapter checks passed', 'fresh lattice verify_codex minimal PATH output');
    assertIncludes(verifyOut, 'Local wrapper heartbeat: source=codex', 'fresh lattice verify_codex should execute generated wrapper heartbeat');
    assertIncludes(verifyOut, 'Codex agents mirror: 16 prompt(s) mirrored', 'fresh lattice verify_codex should pass via generated local bootstrap');
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
