#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const repoRoot = process.cwd();
const GLOBAL_CODEX_FALLBACK = 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback koala';
const INIT_ENTRYPOINT = 'packages/main/dist/cli-init.js';
const CORE_ENTRYPOINT = 'packages/main/dist/cli.js';

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

function assertPathMissing(root, relPath, label = relPath) {
  assert(!existsSync(join(root, relPath)), `${label} should not exist`);
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
  assertIncludes(help, 'KOALA.md', label);
  assertIncludes(help, '--starter', label);
  assertIncludes(help, '--with-template', label);
  assertIncludes(help, '可选 starter 内容（仅 --starter / --with-template）', label);

  const defaultInitSection = sectionBetween(help, '初始化内容:', '可选 starter 内容', label);
  assertNotIncludes(defaultInitSection, 'src/core/app.ts', `${label} default init section`);
  assertNotIncludes(defaultInitSection, 'src/shells/cli/main.ts', `${label} default init section`);
  assertNotIncludes(defaultInitSection, 'tests/', `${label} default init section`);

  const optionalStarterSection = sectionBetween(help, '可选 starter 内容', '初始化后:', label);
  assertIncludes(optionalStarterSection, 'src/core/app.ts', `${label} optional starter section`);
  assertIncludes(optionalStarterSection, 'src/shells/cli/main.ts', `${label} optional starter section`);
  assertIncludes(optionalStarterSection, 'tests/', `${label} optional starter section`);
}

function assertManagedMarkerSync(content, expectedNeedle, staleNeedle, label) {
  assertIncludes(content, '<!-- koala:start -->', label);
  assertIncludes(content, '<!-- koala:end -->', label);
  assertIncludes(content, expectedNeedle, label);
  if (staleNeedle) assertNotIncludes(content, staleNeedle, label);
}

function assertProfileAssets(tempDir, profile, opts = {}) {
  const present = ['KOALA.md', 'bin/koala.js'];
  const absent = [];

  if (profile === 'codex' || profile === 'all') {
    present.push(
      'AGENTS.md',
      'bin/koala-codex.js',
      '.Codex/README.md',
      '.Codex/koala.json',
      '.Codex/agents/test-intent.md',
      '.Codex/agents/test-case-reviewer.md',
      '.Codex/agents/koala-review-quality.md',
      '.Codex/agents/koala-implementer.md',
    );
  } else if (!opts.allowExistingCodex) {
    absent.push('AGENTS.md', 'bin/koala-codex.js', '.Codex');
  }

  if (profile === 'claude' || profile === 'all') {
    present.push(
      'CLAUDE.md',
      '.claude/agents/koala-implementer.md',
      '.claude/skills/koala/skill.md',
      '.claude/hooks/log-tools.cjs',
      '.claude/hooks/session-brief-reminder.cjs',
      '.claude/settings.json',
    );
  } else if (!opts.allowExistingClaude) {
    absent.push('CLAUDE.md', '.claude');
  }

  for (const rel of present) {
    assertPathExists(tempDir, rel, `${profile} init ${rel}`);
  }
  for (const rel of absent) {
    assertPathMissing(tempDir, rel, `${profile} init ${rel}`);
  }
}

function readActivityRecord(session, tool) {
  const activityPath = join(repoRoot, '.koala', 'activity.jsonl');
  const text = readFileSync(activityPath, 'utf8').trim();
  if (!text) return null;
  const entries = text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return entries.findLast(entry => entry.session === session && entry.tool === tool) || null;
}

function readProcessEvent(session, command) {
  let storyId = '';
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (branch.startsWith('story/')) storyId = branch.slice('story/'.length);
  } catch {}
  if (!storyId) return null;
  const storyDir = join(repoRoot, '.koala', 'story', 'actives', storyId);
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
    KOALA_ACTIVITY_SOURCE: 'not-codex',
    KOALA_ACTIVITY_SESSION: '',
    CODEX_SESSION_ID: '',
    OPENAI_SESSION_ID: '',
    TERM_SESSION_ID: '',
    [envName]: marker,
  };
  const out = run('node', ['bin/koala-codex.js', 'session_brief'], { env });
  assertIncludes(out, '# koala session brief', `bin/koala-codex.js ${envName} session_brief`);

  const record = readActivityRecord(marker, 'session_brief');
  assert(record, `bin/koala-codex.js should derive session from ${envName}`);
  assert(record.source === 'codex', 'bin/koala-codex.js should force activity source=codex');
  assert(record.entrypoint === 'local-wrapper', 'bin/koala-codex.js should mark entrypoint=local-wrapper');
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
  const out = run('node', ['bin/koala.js', 'aux_doc_list', '--format=json']);
  assertIncludes(out, '"docs"', 'bin/koala.js aux_doc_list');
});

checks.push(() => {
  const coreHelp = run('node', [CORE_ENTRYPOINT, 'init', '--help']);
  assertInitHelpDocumentsStarterAsOptional(coreHelp, 'repo-local core CLI init --help');

  const localWrapperHelp = run('node', ['bin/koala.js', 'init', '--help']);
  assertInitHelpDocumentsStarterAsOptional(localWrapperHelp, 'repo-local bin/koala.js init --help');
});

checks.push(() => {
  const marker = assertCodexWrapperSessionFrom('CODEX_SESSION_ID');
  const event = readProcessEvent(marker, 'session_brief');
  assert(event, 'bin/koala-codex.js should write codex_cli process-event in active story');
  assert(event.source === 'codex' && event.entrypoint === 'local-wrapper', 'codex_cli event should include source and local wrapper entrypoint');
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
      KOALA_ACTIVITY_SOURCE: 'codex',
      KOALA_ACTIVITY_RECORD_READONLY: '1',
      KOALA_ACTIVITY_SESSION: marker,
    },
  });
  assertIncludes(out, '# koala session brief', 'global Codex fallback core CLI session_brief');

  const record = readActivityRecord(marker, 'session_brief');
  assert(record, 'global Codex fallback should write a session_brief activity record');
  assert(record.source === 'codex', 'global Codex fallback should write source=codex');
  assert(record.entrypoint === 'global-fallback', 'global Codex fallback should mark entrypoint=global-fallback');
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-default-fallback-'));
  try {
    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, 'Selected init profile: all', 'koala init default fallback profile selection');
    assertIncludes(initOut, 'backward compatibility', 'koala init default fallback compatibility note');
    assertProfileAssets(tempDir, 'all');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-'));
  try {
    mkdirSync(join(tempDir, '.Codex', 'agents'), { recursive: true });
    writeFileSync(join(tempDir, '.Codex', 'agents', 'implementer.md'), 'old codex-only prompt\n');
    writeFileSync(join(tempDir, '.Codex', 'agents', 'reviewer.md'), 'old codex-only prompt\n');

    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=all', tempDir]);
    assertIncludes(initOut, 'Selected init profile: all', 'koala init explicit all profile selection');
    assertIncludes(initOut, 'explicit --profile=all', 'koala init explicit all reason');
    assertIncludes(initOut, '.Codex/README.md', 'koala init output');
    assertProfileAssets(tempDir, 'all');

    const defaultConfig = readJson(tempDir, 'koala.config.json');
    assert(defaultConfig.scanRoot === '.', 'default koala init without preexisting src should set scanRoot=.');
    assertPathMissing(tempDir, 'src/core', 'default koala init src/core');
    assertPathMissing(tempDir, 'src/shells', 'default koala init src/shells');
    assertPathMissing(tempDir, 'tests', 'default koala init tests');
    assertManagedMarkerSync(readFileSync(join(tempDir, 'KOALA.md'), 'utf8'), 'canonical、host-neutral', null, 'KOALA.md');
    const generatedClaude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    assertIncludes(generatedClaude, 'KOALA.md', 'all profile CLAUDE.md should point to KOALA.md');
    assertNotIncludes(generatedClaude, '正常通道：', 'all profile CLAUDE.md should not copy root lifecycle table');

    const codexReadme = readFileSync(join(tempDir, '.Codex', 'README.md'), 'utf8');
    assertIncludes(codexReadme, 'node bin/koala-codex.js session_brief', '.Codex/README.md');
    assertIncludes(codexReadme, `${GLOBAL_CODEX_FALLBACK} session_brief`, '.Codex/README.md');
    assertIncludes(codexReadme, '不要把 fallback 的 `status` / `next` / `validate` 输出当作 gate 证据', '.Codex/README.md');
    assertIncludes(codexReadme, '.Codex/koala.json', '.Codex/README.md');
    assertIncludes(codexReadme, '不创建 `.Codex/hooks`', '.Codex/README.md');

    const codexManifest = readJson(tempDir, '.Codex/koala.json');
    assert(codexManifest.adapterOwner === 'koala', 'adapter manifest should be owned by koala');
    assert(codexManifest.activitySource === 'codex', 'adapter manifest should declare activitySource=codex');
    assert(
      codexManifest.recommendedEntrypoints.some(entry => entry.command === 'node bin/koala-codex.js'),
      'adapter manifest should recommend the local Codex wrapper',
    );
    assert(
      codexManifest.recommendedEntrypoints[0]?.command === 'node bin/koala-codex.js',
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
    assert(codexManifest.sessionEnv.recordReadOnly === 'KOALA_ACTIVITY_RECORD_READONLY', 'adapter manifest should document read-only activity opt-in');
    assert(codexManifest.excludedRuntimeAssets.includes('.Codex/hooks'), 'adapter manifest should exclude .Codex/hooks');
    assert(codexManifest.excludedRuntimeAssets.includes('.Codex/settings.json'), 'adapter manifest should exclude .Codex/settings.json');
    assertPathMissing(tempDir, '.Codex/hooks', 'koala init .Codex/hooks');
    assertPathMissing(tempDir, '.Codex/settings.json', 'koala init .Codex/settings.json');

    const codexAgents = readdirSync(join(tempDir, '.Codex', 'agents'));
    assert(!codexAgents.includes('implementer.md'), 'koala init should not keep stale Codex-only implementer.md');
    assert(!codexAgents.includes('reviewer.md'), 'koala init should not keep stale Codex-only reviewer.md');

    const generatedWrapper = readFileSync(join(tempDir, 'bin', 'koala-codex.js'), 'utf8');
    const generatedBootstrap = readFileSync(join(tempDir, 'bin', 'koala.js'), 'utf8');
    assert(existsSync(join(tempDir, 'bin', 'koala.js')), 'koala init should generate sibling bin/koala.js');
    assertIncludes(generatedWrapper, "join(binDir, 'koala.js')", 'generated Codex wrapper local bootstrap check');
    assertNotIncludes(generatedWrapper, "spawnSync('koala'", 'generated Codex wrapper should not delegate directly to global koala');
    assertIncludes(generatedWrapper, 'npx koala-init --verify-codex', 'generated Codex wrapper recovery hint');
    assertIncludes(generatedBootstrap, 'coreCliEngineCandidates', 'generated local bootstrap candidate list');
    assertIncludes(generatedBootstrap, "node_modules', '@koala-agent', 'core'", 'generated local bootstrap should search local @koala-agent/core');
    assertIncludes(generatedBootstrap, "typeof mod.runCli", 'generated local bootstrap should execute a local CLI engine');
    assertIncludes(generatedBootstrap, "!help.includes('aux_doc_list') || !help.includes('verify_codex')", 'generated local bootstrap should reject stale global fallback');

    const verifyInitOut = run('node', [CORE_ENTRYPOINT, 'init', '--verify-codex', tempDir]);
    assertIncludes(verifyInitOut, 'Codex verification:', 'koala init --verify-codex output');
    assertIncludes(verifyInitOut, 'Codex adapter checks passed', 'koala init --verify-codex checks');
    assertPathMissing(tempDir, 'src/core', 'koala init --verify-codex src/core');
    assertPathMissing(tempDir, 'src/shells', 'koala init --verify-codex src/shells');
    assertPathMissing(tempDir, 'tests', 'koala init --verify-codex tests');

    const staleBin = join(tempDir, 'stale-bin');
    mkdirSync(staleBin);
    const staleKoala = join(staleBin, 'koala');
    writeFileSync(staleKoala, '#!/bin/sh\necho "stale koala without Codex adapter commands"\nexit 0\n');
    chmodSync(staleKoala, 0o755);
    const minimalEnv = {
      ...process.env,
      PATH: `${staleBin}:/usr/bin:/bin`,
      KOALA_ACTIVITY_SOURCE: 'not-codex',
      KOALA_ACTIVITY_SESSION: `fresh-init-wrapper-${Date.now()}`,
    };
    const freshWrapperOut = run(process.execPath, [join(tempDir, 'bin', 'koala-codex.js'), 'session_brief'], { cwd: tempDir, env: minimalEnv });
    assertIncludes(freshWrapperOut, '# koala session brief', 'fresh generated wrapper should run with stale global koala on PATH');

  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-existing-src-'));
  try {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const alreadyHere = true;\n');

    run('node', [INIT_ENTRYPOINT, tempDir]);
    assertProfileAssets(tempDir, 'all');

    const config = readJson(tempDir, 'koala.config.json');
    assert(config.scanRoot === 'src', 'default koala init with preexisting src should keep scanRoot=src');
    assertPathExists(tempDir, 'src/index.ts', 'preexisting src/index.ts');
    assertPathMissing(tempDir, 'src/core/app.ts', 'default koala init with preexisting src src/core/app.ts');
    assertPathMissing(tempDir, 'src/shells/cli/main.ts', 'default koala init with preexisting src cli shell');
    assertPathMissing(tempDir, 'tests', 'default koala init with preexisting src tests');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  for (const flag of ['--starter', '--with-template']) {
    const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-starter-'));
    try {
      const initOut = run('node', [INIT_ENTRYPOINT, flag, tempDir]);
      assertIncludes(initOut, 'src/core/app.ts', `koala init ${flag} output`);
      assertProfileAssets(tempDir, 'all');

      const config = readJson(tempDir, 'koala.config.json');
      assert(config.scanRoot === 'src', `koala init ${flag} should set scanRoot=src`);
      assertPathExists(tempDir, 'src/core/app.ts', `koala init ${flag} src/core/app.ts`);
      assertPathExists(tempDir, 'src/core/debug.ts', `koala init ${flag} src/core/debug.ts`);
      assertPathExists(tempDir, 'src/core/machines/game/bridge.ts', `koala init ${flag} bridge.ts`);
      assertPathExists(tempDir, 'src/shells/cli/main.ts', `koala init ${flag} cli shell`);
      assertPathExists(tempDir, 'src/shells/web', `koala init ${flag} web shell dir`);
      assertPathExists(tempDir, 'tests', `koala init ${flag} tests dir`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

checks.push(() => {
  for (const profile of ['codex', 'claude', 'core']) {
    const tempDir = mkdtempSync(join(tmpdir(), `koala-entrypoints-profile-${profile}-`));
    try {
      const initOut = run('node', [INIT_ENTRYPOINT, `--profile=${profile}`, tempDir]);
      assertIncludes(initOut, `Selected init profile: ${profile}`, `${profile} init profile selection`);
      assertIncludes(initOut, `explicit --profile=${profile}`, `${profile} init explicit reason`);
      assertProfileAssets(tempDir, profile);
      if (profile === 'codex') {
        const agents = readFileSync(join(tempDir, 'AGENTS.md'), 'utf8');
        assertIncludes(agents, 'KOALA.md', 'codex AGENTS should point to KOALA.md');
        assertNotIncludes(agents, '.claude/agents', 'codex AGENTS should not claim .claude/agents exists');
      }
      if (profile === 'claude') {
        const claude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
        assertIncludes(claude, 'KOALA.md', 'claude CLAUDE.md should point to KOALA.md');
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
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-codex-verify-'));
  try {
    const claudeSeedDir = join(tempDir, '.claude', 'agents');
    mkdirSync(claudeSeedDir, { recursive: true });
    for (const file of readdirSync(join(repoRoot, '.claude', 'agents'))) {
      if (!file.endsWith('.md')) continue;
      writeFileSync(join(claudeSeedDir, file), readFileSync(join(repoRoot, '.claude', 'agents', file), 'utf8'));
    }
    const out = run(process.execPath, [INIT_ENTRYPOINT, '--profile=codex', '--verify-codex', tempDir]);
    assertIncludes(out, 'Codex verification:', 'codex profile verify-codex output');
    assertIncludes(out, 'Codex adapter checks passed', 'codex profile verify-codex checks');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-explicit-override-'));
  try {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# AGENTS.md\n\nexisting codex marker\n');
    const initOut = run('node', [INIT_ENTRYPOINT, '--profile', 'claude', '--verify-codex', tempDir]);
    assertIncludes(initOut, 'Selected init profile: claude', 'explicit profile override should select claude');
    assertIncludes(initOut, 'explicit --profile=claude', 'explicit profile override reason');
    assertIncludes(initOut, 'Codex verification skipped: init profile claude does not generate Codex adapter assets', 'explicit claude verify-codex skip');
    assertProfileAssets(tempDir, 'claude', { allowExistingCodex: true });
    assertPathMissing(tempDir, 'bin/koala-codex.js', 'explicit claude profile should not create codex wrapper');
    assertPathMissing(tempDir, '.Codex', 'explicit claude profile should not create .Codex');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-managed-sync-'));
  try {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# AGENTS.md\n\nbefore-agents\n<!-- koala:start -->\nold agents section\n<!-- koala:end -->\nafter-agents\n');
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# CLAUDE.md\n\nbefore-claude\n<!-- koala:start -->\nold claude section\n<!-- koala:end -->\nafter-claude\n');
    writeFileSync(join(tempDir, 'KOALA.md'), '# KOALA.md\n\nbefore-koala\n<!-- koala:start -->\nold koala section\n<!-- koala:end -->\nafter-koala\n');

    run('node', [INIT_ENTRYPOINT, '--profile=all', tempDir]);

    const agents = readFileSync(join(tempDir, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8');
    const koala = readFileSync(join(tempDir, 'KOALA.md'), 'utf8');
    assertIncludes(agents, 'before-agents', 'AGENTS.md prefix preservation');
    assertIncludes(agents, 'after-agents', 'AGENTS.md suffix preservation');
    assertManagedMarkerSync(agents, 'Codex / AGENTS', 'old agents section', 'AGENTS.md managed sync');
    assertNotIncludes(agents, '.claude/agents', 'AGENTS.md managed sync should not claim .claude/agents exists');
    assertIncludes(claude, 'before-claude', 'CLAUDE.md prefix preservation');
    assertIncludes(claude, 'after-claude', 'CLAUDE.md suffix preservation');
    assertManagedMarkerSync(claude, 'KOALA.md', 'old claude section', 'CLAUDE.md managed sync');
    assertNotIncludes(claude, '正常通道：', 'CLAUDE.md managed sync should not copy root lifecycle table');
    assertIncludes(koala, 'before-koala', 'KOALA.md prefix preservation');
    assertIncludes(koala, 'after-koala', 'KOALA.md suffix preservation');
    assertManagedMarkerSync(koala, 'host-neutral', 'old koala section', 'KOALA.md managed sync');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-unmanaged-docs-'));
  try {
    const agentsOriginal = '# AGENTS.md\n\nuser-owned agents doc\n';
    const claudeOriginal = '# CLAUDE.md\n\nuser-owned claude doc\n';
    const koalaOriginal = '# KOALA.md\n\nuser-owned koala doc\n';
    writeFileSync(join(tempDir, 'AGENTS.md'), agentsOriginal);
    writeFileSync(join(tempDir, 'CLAUDE.md'), claudeOriginal);
    writeFileSync(join(tempDir, 'KOALA.md'), koalaOriginal);

    const initOut = run('node', [INIT_ENTRYPOINT, '--profile=all', tempDir]);
    assertIncludes(initOut, 'AGENTS.md (exists, no koala markers, skip)', 'AGENTS.md unmanaged preservation log');
    assertIncludes(initOut, 'CLAUDE.md (exists, no koala markers, skip)', 'CLAUDE.md unmanaged preservation log');
    assertIncludes(initOut, 'KOALA.md (exists, no koala markers, skip)', 'KOALA.md unmanaged preservation log');
    assert(readFileSync(join(tempDir, 'AGENTS.md'), 'utf8') === agentsOriginal, 'AGENTS.md without markers should be preserved');
    assert(readFileSync(join(tempDir, 'CLAUDE.md'), 'utf8') === claudeOriginal, 'CLAUDE.md without markers should be preserved');
    assert(readFileSync(join(tempDir, 'KOALA.md'), 'utf8') === koalaOriginal, 'KOALA.md without markers should be preserved');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-python-'));
  try {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "koala-smoke"\nversion = "0.0.0"\n');
    const initOut = run('node', [INIT_ENTRYPOINT, tempDir]);
    assertIncludes(initOut, '检测到 Python 项目', 'python no-src koala init output');
    assertProfileAssets(tempDir, 'all');

    const config = readJson(tempDir, 'koala.config.json');
    assert(config.language === 'python', 'python no-src koala init should set language=python');
    assert(config.scanRoot === '.', 'python no-src koala init should set scanRoot=.');
    assertPathMissing(tempDir, 'src', 'python no-src koala init src');
    assertPathMissing(tempDir, 'tests', 'python no-src koala init tests');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

checks.push(() => {
  for (const profile of ['claude', 'core']) {
    const tempDir = mkdtempSync(join(tmpdir(), `koala-entrypoints-verify-skip-${profile}-`));
    try {
      const out = run(process.execPath, [INIT_ENTRYPOINT, `--profile=${profile}`, '--verify-codex', tempDir]);
      assertIncludes(out, `Codex verification skipped: init profile ${profile} does not generate Codex adapter assets`, `${profile} verify-codex skip`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-minpath-'));
  const staleBin = join(tempDir, 'stale-bin');
  try {
    mkdirSync(staleBin);
    const staleKoala = join(staleBin, 'koala');
    writeFileSync(staleKoala, '#!/bin/sh\necho "stale koala without verify_codex"\nexit 0\n');
    chmodSync(staleKoala, 0o755);
    const out = run(process.execPath, [CORE_ENTRYPOINT, 'init', '--verify-codex', tempDir], {
      env: {
        ...process.env,
        PATH: `${staleBin}:/usr/bin:/bin`,
      },
    });
    assertIncludes(out, 'Codex verification:', 'fresh koala init --verify-codex minimal PATH output');
    assertIncludes(out, 'Local wrapper heartbeat: source=codex', 'fresh koala init --verify-codex should execute generated wrapper heartbeat');
    assertIncludes(out, 'Codex adapter checks passed', 'fresh koala init --verify-codex should pass via generated local bootstrap');
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
