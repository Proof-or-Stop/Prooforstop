#!/usr/bin/env node

import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, chmodSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  AGENTS_MD_TEMPLATE,
  CLAUDE_MD_TEMPLATE,
  LATTICE_MD_TEMPLATE,
  SUPPORTED_INIT_ASSET_MODES,
  SUPPORTED_INIT_PROFILES,
  listAgentPromptFiles,
  renderCodexAdapterManifest,
  renderCodexAgentContent,
  renderCodexReadmeTemplate,
  renderCodexWrapperScript,
  renderLatticeBootstrapScript,
  renderLatticeCodexAdapterManifest,
  renderLatticeCodexWrapperScript,
  getKoalaHooks,
} from './init-assets.js';
import type { InitAssetMode, InitProfile } from './init-assets.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from './core/codex-adapter-checks.js';
import { renderManagedAssetCheck, runManagedAssetCheck } from './core/managed-assets.js';
import {
  KOALA_RUNTIME_IGNORE_BLOCK_END,
  KOALA_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from './core/runtime-artifact-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..'); // Root directory of @koala/main
const agentTemplateDir = [
  join(packageRoot, 'templates', 'agents'),
  join(packageRoot, '..', '..', '.claude', 'agents'),
].find(existsSync);
const skillSrc = join(packageRoot, '..', '..', '.claude', 'skills', 'koala');
const hookSrcDir = join(packageRoot, '..', '..', '.claude', 'hooks');
const HOOK_FILES = ['log-tools.cjs', 'session-brief-reminder.cjs'] as const;
const KOALA_SKILL_FALLBACK = `# /koala — Project management entry

You are the project management engine. Execute /koala to understand the project overview and start working.

See @koala/main documentation for detailed usage.
`;

// When invoked via koala init, argv[2]='init', skip; when running npx koala-init directly, argv[2] is the target directory
const initArgs = process.argv[2] === 'init' ? process.argv.slice(3) : process.argv.slice(2);
const INIT_DOC_SECTION_RE = /<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/;
const GITIGNORE_RUNTIME_BLOCK_RE = new RegExp(
  `${escapeRegExp(KOALA_RUNTIME_IGNORE_BLOCK_START)}[\\s\\S]*?${escapeRegExp(KOALA_RUNTIME_IGNORE_BLOCK_END)}`,
);

function isSupportedInitProfile(value: string): value is InitProfile {
  return SUPPORTED_INIT_PROFILES.includes(value as InitProfile);
}

function isSupportedInitAssetMode(value: string): value is InitAssetMode {
  return SUPPORTED_INIT_ASSET_MODES.includes(value as InitAssetMode);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeGitignoreLine(line: string): string {
  return line.trim();
}

function renderManagedRuntimeIgnoreBlock(lines: string[]): string {
  return [
    KOALA_RUNTIME_IGNORE_BLOCK_START,
    ...lines,
    KOALA_RUNTIME_IGNORE_BLOCK_END,
  ].join('\n');
}

function mergeKoalaRuntimeIgnores(existingContent: string): { content: string; changed: boolean } {
  const required = listRuntimeArtifactIgnorePatterns();
  const blockMatch = existingContent.match(GITIGNORE_RUNTIME_BLOCK_RE);
  const blockText = blockMatch?.[0] ?? null;
  const contentWithoutBlock = blockText ? existingContent.replace(GITIGNORE_RUNTIME_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n') : existingContent;
  const presentOutsideBlock = new Set(
    contentWithoutBlock
      .split('\n')
      .map(normalizeGitignoreLine)
      .filter(Boolean),
  );
  const desiredBlockLines = required.filter(line => !presentOutsideBlock.has(line));
  if (desiredBlockLines.length === 0) {
    return { content: existingContent, changed: false };
  }

  const renderedBlock = renderManagedRuntimeIgnoreBlock(desiredBlockLines);
  if (blockText) {
    if (blockText === renderedBlock) return { content: existingContent, changed: false };
    return {
      content: existingContent.replace(GITIGNORE_RUNTIME_BLOCK_RE, renderedBlock),
      changed: true,
    };
  }

  const base = existingContent.replace(/\s+$/, '');
  const separator = base.length === 0 ? '' : '\n\n';
  return {
    content: `${base}${separator}${renderedBlock}\n`,
    changed: true,
  };
}

function parseExplicitProfile(args: string[]): InitProfile | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (!isSupportedInitProfile(value)) {
        console.error(`Unsupported init profile: ${value}`);
        console.error(`Supported profiles: ${SUPPORTED_INIT_PROFILES.join(', ')}`);
        process.exit(1);
      }
      return value;
    }
    if (arg === '--profile') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        console.error('Missing value for --profile');
        console.error(`Supported profiles: ${SUPPORTED_INIT_PROFILES.join(', ')}`);
        process.exit(1);
      }
      if (!isSupportedInitProfile(value)) {
        console.error(`Unsupported init profile: ${value}`);
        console.error(`Supported profiles: ${SUPPORTED_INIT_PROFILES.join(', ')}`);
        process.exit(1);
      }
      return value;
    }
  }
  return null;
}

function parseExplicitAssetMode(args: string[]): InitAssetMode | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--asset-mode=')) {
      const value = arg.slice('--asset-mode='.length);
      if (!isSupportedInitAssetMode(value)) {
        console.error(`Unsupported init asset mode: ${value}`);
        console.error(`Supported asset modes: ${SUPPORTED_INIT_ASSET_MODES.join(', ')}`);
        process.exit(1);
      }
      return value;
    }
    if (arg === '--asset-mode') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        console.error('Missing value for --asset-mode');
        console.error(`Supported asset modes: ${SUPPORTED_INIT_ASSET_MODES.join(', ')}`);
        process.exit(1);
      }
      if (!isSupportedInitAssetMode(value)) {
        console.error(`Unsupported init asset mode: ${value}`);
        console.error(`Supported asset modes: ${SUPPORTED_INIT_ASSET_MODES.join(', ')}`);
        process.exit(1);
      }
      return value;
    }
  }
  return null;
}

function parseTargetDir(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--profile' || arg === '--asset-mode') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) continue;
    if (arg.startsWith('--asset-mode=')) continue;
    if (!arg.startsWith('--')) return arg;
  }
  return null;
}

function detectInitProfile(root: string): { profile: InitProfile; reason: string; compatibilityNote?: string } {
  const hasCodexMarkers = existsSync(join(root, 'AGENTS.md')) || existsSync(join(root, '.Codex'));
  const hasClaudeMarkers = existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, '.claude'));
  if (hasCodexMarkers && hasClaudeMarkers) {
    return {
      profile: 'all',
      reason: 'auto-detected both Codex and Claude markers',
    };
  }
  if (hasCodexMarkers) {
    return {
      profile: 'codex',
      reason: 'auto-detected Codex markers (AGENTS.md or .Codex)',
    };
  }
  if (hasClaudeMarkers) {
    return {
      profile: 'claude',
      reason: 'auto-detected Claude markers (CLAUDE.md or .claude)',
    };
  }
  return {
    profile: 'all',
    reason: 'no host markers found; using all for backward compatibility',
    compatibilityNote: 'Compatibility note: no AGENTS.md/.Codex/CLAUDE.md/.claude markers found, defaulting to profile all for backward compatibility.',
  };
}

const verifyCodex = initArgs.includes('--verify-codex');
const upgradeManagedAssets = initArgs.includes('--upgrade');
const withStarter = initArgs.includes('--starter') || initArgs.includes('--with-template');
const explicitProfile = parseExplicitProfile(initArgs);
const arg = parseTargetDir(initArgs);

if (initArgs.includes('--help') || initArgs.includes('-h') || initArgs.includes('help')) {
  console.log(`
lattice init — Initialize the Lattice/Koala development framework

Usage:
  lattice init [target directory]                    Initialize in the specified directory (defaults to current directory)
  lattice init --profile <profile> [target directory]
                                        Select init profile: codex | claude | all | core
  lattice init --asset-mode <mode> [target directory]
                                        Select Codex prompt asset mode: full | thin (default full)
  lattice init --starter [target directory]          Additionally generate legacy starter business template
  lattice init --with-template [target directory]    Synonym alias for --starter
  lattice init --upgrade [target directory]          Sync Lattice management assets to the current version
  lattice init --verify-codex [target directory]     Verify Codex adapter assets after initialization
  lattice init --help                        Show help

Legacy npm package entrypoint \`npx koala-init\` remains accepted as an alias.

Initialized contents:
  koala.config.json             Project configuration (scan paths, Story prefix)
  LATTICE.md                    canonical host-neutral Lattice guide
  bin/lattice.js                Local Lattice bootstrap
  host adapter assets           Controlled by --profile (codex / claude / all / core)
  Codex prompt assets           Controlled by --asset-mode (full generates .Codex/agents; thin uses registry)
  .claude/skills/koala/         /koala skill files
  docs/story/actives/           Story data directory
  docs/requirements/            Source-of-truth directory

Optional starter contents (only with --starter / --with-template):
  src/core/app.ts               Application assembly (platform-neutral)
  src/core/debug.ts             Debug entry (devHost)
  src/core/machines/game/bridge.ts  Bridge interface template
  src/shells/cli/main.ts        CLI shell template
  src/shells/web/               Web shell directory
  tests/                        Tests directory

After initialization:
  1. Read LATTICE.md and use the entry generated by the profile
  2. Edit koala.config.json to adjust scanRoot and other paths
  3. Optional: lattice validate to run project validation
`);
  process.exit(0);
}

const targetDir = arg || process.cwd();
const selectedProfileInfo = explicitProfile
  ? { profile: explicitProfile, reason: `explicit --profile=${explicitProfile}` }
  : detectInitProfile(targetDir);
const selectedProfile = selectedProfileInfo.profile;
const selectedAssetMode = parseExplicitAssetMode(initArgs) ?? 'full';
const wantsCodex = selectedProfile === 'codex' || selectedProfile === 'all';
const wantsClaude = selectedProfile === 'claude' || selectedProfile === 'all';
const hadSrcBeforeInit = existsSync(join(targetDir, 'src'));
const isPython = existsSync(join(targetDir, 'requirements.txt'))
  || existsSync(join(targetDir, 'pyproject.toml'))
  || existsSync(join(targetDir, 'setup.py'));

console.log(`\nInitializing Lattice in ${targetDir}\n`);
console.log(`Selected init profile: ${selectedProfile}`);
console.log(`Profile reason: ${selectedProfileInfo.reason}`);
console.log(`Codex asset mode: ${selectedAssetMode}`);
if ('compatibilityNote' in selectedProfileInfo && selectedProfileInfo.compatibilityNote) {
  console.log(selectedProfileInfo.compatibilityNote);
}
console.log('');
if (withStarter) {
  console.log('Starter template: enabled (--starter / --with-template)\n');
}

function write(relPath: string, content: string) {
  const full = join(targetDir, relPath);
  if (existsSync(full)) {
    console.log(`  - ${relPath} (exists, skip)`);
    return false;
  }
  const dir = dirname(full);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
  console.log(`  ✓ ${relPath}`);
  return true;
}

function writeExecutable(relPath: string, content: string): boolean {
  const created = write(relPath, content);
  if (created) chmodSync(join(targetDir, relPath), 0o755);
  return created;
}

function extractKoalaSection(content: string): string {
  const match = content.match(INIT_DOC_SECTION_RE);
  if (!match) return content;
  return match[0].replace(/<!--\s*koala:internal:start\s*-->[\s\S]*?<!--\s*koala:internal:end\s*-->\n?/g, '');
}

function hasKoalaMarkers(content: string): boolean {
  return INIT_DOC_SECTION_RE.test(content);
}

function writeManagedMarkdown(relPath: string, desiredContent: string, label: string) {
  const full = join(targetDir, relPath);
  if (!existsSync(full)) {
    const dir = dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, desiredContent.endsWith('\n') ? desiredContent : `${desiredContent}\n`);
    console.log(`  ✓ ${label} (created)`);
    return;
  }

  const existing = readFileSync(full, 'utf-8');
  if (!INIT_DOC_SECTION_RE.test(existing)) {
    console.log(`  - ${label} (exists, no koala markers, skip)`);
    return;
  }

  const updated = existing.replace(INIT_DOC_SECTION_RE, extractKoalaSection(desiredContent));
  if (updated !== existing) {
    writeFileSync(full, updated);
    console.log(`  ✓ ${label} (koala section synced)`);
  } else {
    console.log(`  - ${label} (koala section up to date)`);
  }
}

function hasHookCommand(entries: any, command: string): boolean {
  return Array.isArray(entries) && entries.some((entry: any) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook: any) => hook?.type === 'command' && hook?.command === command));
}

function removeIfManagedDoc(relPath: string, label: string) {
  const full = join(targetDir, relPath);
  if (!existsSync(full)) return;
  const content = readFileSync(full, 'utf-8');
  if (!hasKoalaMarkers(content)) return;
  unlinkSync(full);
  console.log(`  ↻ ${label} (removed managed doc for profile cleanup)`);
}

function removePathIfExists(relPath: string, label: string) {
  const full = join(targetDir, relPath);
  if (!existsSync(full)) return;
  rmSync(full, { recursive: true, force: true });
  console.log(`  ↻ ${label} (removed for profile cleanup)`);
}

function removeWholeFileIfGenerated(relPath: string, label: string, expectedContents: string[]) {
  const full = join(targetDir, relPath);
  if (!existsSync(full)) return;
  const actual = readFileSync(full, 'utf-8');
  if (!expectedContents.some(expected => actual === (expected.endsWith('\n') ? expected : `${expected}\n`))) return;
  unlinkSync(full);
  console.log(`  ↻ ${label} (removed generated file for profile cleanup)`);
}

function cleanupEmptyDirChain(relDir: string) {
  let current = relDir;
  while (current && current !== '.') {
    const abs = join(targetDir, current);
    if (!existsSync(abs)) {
      current = dirname(current);
      continue;
    }
    if (readdirSync(abs).length > 0) break;
    rmSync(abs, { recursive: true, force: true });
    current = dirname(current);
  }
}

function removeClaudeSettingsIfManaged() {
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (JSON.stringify(parsed) !== JSON.stringify({ hooks: getKoalaHooks() })) return;
    unlinkSync(settingsPath);
    console.log('  ↻ .claude/settings.json (removed managed settings for profile cleanup)');
    cleanupEmptyDirChain('.claude');
  } catch {
    // preserve user-owned or malformed settings
  }
}

function removeCodexWrapperIfManaged() {
  removeWholeFileIfGenerated('bin/lattice-codex.js', 'bin/lattice-codex.js', [renderLatticeCodexWrapperScript()]);
  removeWholeFileIfGenerated('bin/koala-codex.js', 'bin/koala-codex.js', [renderCodexWrapperScript()]);
}

function removeCodexManifestIfManaged() {
  removeWholeFileIfGenerated('.Codex/lattice.json', '.Codex/lattice.json', [
    renderLatticeCodexAdapterManifest(),
    renderLatticeCodexAdapterManifest({ promptMode: 'registry' }),
  ]);
  removeWholeFileIfGenerated('.Codex/koala.json', '.Codex/koala.json', [
    renderCodexAdapterManifest(),
    renderCodexAdapterManifest({ promptMode: 'registry' }),
  ]);
}

function cleanupClaudeAssets() {
  removeIfManagedDoc('CLAUDE.md', 'CLAUDE.md');
  removePathIfExists('.claude/agents', '.claude/agents');
  removePathIfExists('.claude/hooks', '.claude/hooks');
  removePathIfExists('.claude/skills/koala', '.claude/skills/koala');
  removeClaudeSettingsIfManaged();
  cleanupEmptyDirChain('.claude/skills');
  cleanupEmptyDirChain('.claude');
}

function cleanupCodexAssets() {
  removeIfManagedDoc('AGENTS.md', 'AGENTS.md');
  removePathIfExists('.Codex/agents', '.Codex/agents');
  removePathIfExists('.Codex/README.md', '.Codex/README.md');
  removeCodexManifestIfManaged();
  cleanupEmptyDirChain('.Codex');
  removeCodexWrapperIfManaged();
}

function enforceProfileCleanup(profile: InitProfile) {
  if (profile === 'all') return;
  if (profile === 'codex') {
    cleanupClaudeAssets();
    return;
  }
  if (profile === 'claude') {
    cleanupCodexAssets();
    return;
  }
  cleanupClaudeAssets();
  cleanupCodexAssets();
}

enforceProfileCleanup(selectedProfile);

// 1. Directories
console.log('[1/6] Creating directories...');
const dirs = [
  'docs/story/actives',
  'docs/requirements/decisions',
  'docs/requirements/extracted',
];
if (wantsClaude) dirs.push('.claude/skills/koala', '.claude/agents');
if (wantsCodex && selectedAssetMode === 'full') dirs.push('.Codex/agents');
for (const d of dirs) {
  const full = join(targetDir, d);
  if (!existsSync(full)) {
    mkdirSync(full, { recursive: true });
    console.log(`  ✓ ${d}/`);
  }
}

// 1.5 .gitignore (copied from the koala project)
const giPath = join(targetDir, '.gitignore');
const giSrc = join(packageRoot, '..', '..', '.gitignore');
if (!existsSync(giPath)) {
  if (existsSync(giSrc)) {
    cpSync(giSrc, giPath);
    console.log('  ✓ .gitignore (copied from koala)');
  } else {
    const minimalGitignore = [
      'node_modules',
      'dist',
      '__pycache__/',
      '*.pyc',
      '.worktrees/',
      'tmp/*',
      '!tmp/.gitkeep',
      '',
      renderManagedRuntimeIgnoreBlock(listRuntimeArtifactIgnorePatterns()),
      '',
    ].join('\n');
    // B-5010 CHK-005: ignore the entire tmp/ to prevent agent-written one-off helper scripts from being picked up by git add
    writeFileSync(giPath, minimalGitignore);
    console.log('  ✓ .gitignore (created minimal)');
  }
} else {
  const mergeResult = mergeKoalaRuntimeIgnores(readFileSync(giPath, 'utf8'));
  if (mergeResult.changed) {
    writeFileSync(giPath, mergeResult.content);
    console.log('  ✓ .gitignore (merged koala runtime ignores)');
  } else {
    console.log('  - .gitignore (runtime ignores already present)');
  }
}

// 1.6 Optional starter project code directories (src/core + src/shells)
if (withStarter) {
  const codeDirs = [
    'src/core/machines/game',
    'src/core/io',
    'src/shells/cli',
    'src/shells/web',
    'tests',
  ];
  for (const d of codeDirs) {
    const full = join(targetDir, d);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      console.log(`  ✓ ${d}/`);
    }
  }
}

const codexWrapperPath = join(targetDir, 'bin', 'lattice-codex.js');
writeExecutable('bin/lattice.js', renderLatticeBootstrapScript(packageRoot));

if (wantsCodex && !existsSync(codexWrapperPath)) {
  writeExecutable('bin/lattice-codex.js', renderLatticeCodexWrapperScript());
  console.log('  ✓ bin/lattice-codex.js (Codex wrapper)');
} else if (wantsCodex) {
  console.log('  - bin/lattice-codex.js (exists, skip)');
} else {
  console.log('  - bin/lattice-codex.js (profile skip)');
}

// Generate CLI shell template
const cliMainPath = join(targetDir, 'src', 'shells', 'cli', 'main.ts');
if (withStarter && !existsSync(cliMainPath)) {
  const dir = dirname(cliMainPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cliMainPath, `// CLI shell — full-fledged interactive entry
// The CLI is not a degraded version; it is the full version. Covers all machine transitions.
// Interacts only via bridge, does not directly import fn.ts.

import * as readline from 'readline';
import { createLocalBridge } from '../../core/machines/game/bridge.js';

const bridge = createLocalBridge();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

bridge.onStateChange((state) => {
  // TODO: render CLI output based on state
  console.log(JSON.stringify(state, null, 2));
});

function prompt() {
  rl.question('> ', (input) => {
    const trimmed = input.trim();
    if (trimmed === 'quit' || trimmed === 'exit') {
      rl.close();
      return;
    }
    // TODO: parse user input and call bridge.sendEvent(event, input)
    bridge.sendEvent(trimmed, {});
    prompt();
  });
}

prompt();
`);
  console.log('  ✓ src/shells/cli/main.ts (CLI shell template)');
}

// Generate bridge template
const bridgePath = join(targetDir, 'src', 'core', 'machines', 'game', 'bridge.ts');
if (withStarter && !existsSync(bridgePath)) {
  const dir = dirname(bridgePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(bridgePath, `// Bridge — isolation interface between logic layer and UI layer
// Shells (CLI/Browser) only import bridge.ts, not fn.ts.

// import type { GameState } from './data.js';
// import { GameMachine } from './machine.js';
// import { parseInput } from './fn.js';

export interface GameBridge {
  sendEvent(event: string, input: any): boolean;
  onStateChange(cb: (state: any) => void): () => void;
  getState(): any;
  getMachineState(): string;
  reset(): void;
}

// LocalBridge: in-process direct connection
export function createLocalBridge(): GameBridge {
  // TODO: import machine + fn, implement event dispatch
  let state: any = {};
  const listeners = new Set<(state: any) => void>();

  function notify() {
    for (const cb of listeners) cb(state);
  }

  return {
    sendEvent(event: string, input: any): boolean {
      // TODO: find transition from machine, invoke guard + action
      console.log(\`[bridge] event: \${event}\`, input);
      return false;
    },
    onStateChange(cb: (state: any) => void) {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
    getState() { return state; },
    getMachineState() { return 'initial'; },
    reset() {
      state = {};
      notify();
    },
  };
}

// WSBridge: connect to core process via WS during development
export function createWSBridge(wsUrl: string): GameBridge {
  const WS = typeof WebSocket !== 'undefined' ? WebSocket : (globalThis as any).WebSocket;
  const ws = new WS(wsUrl);
  let state: any = {};
  let machineState = 'unknown';
  const listeners = new Set<(state: any) => void>();

  ws.onmessage = (e: any) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'stateChange' || msg.type === 'init') {
        state = msg.state;
        machineState = msg.machineState || machineState;
        for (const cb of listeners) cb(state);
      }
    } catch {}
  };

  return {
    sendEvent(event: string, input: any): boolean {
      ws.send(JSON.stringify({ type: 'event', event, input }));
      return true;
    },
    onStateChange(cb: (state: any) => void) {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
    getState() { return state; },
    getMachineState() { return machineState; },
    reset() { ws.send(JSON.stringify({ type: 'reset' })); },
  };
}
`);
  console.log('  ✓ src/core/machines/game/bridge.ts (Bridge template)');
}

// Generate app.ts template
const appPath = join(targetDir, 'src', 'core', 'app.ts');
if (withStarter && !existsSync(appPath)) {
  const dir = dirname(appPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(appPath, `// app.ts — application composition (platform-agnostic)
// Runs in both browser and Node.js. Does not depend on fs/ws/process.

import { createLocalBridge } from './machines/game/bridge.js';

export async function createApp() {
  const bridge = createLocalBridge();

  // IO dispatch example:
  // bridge.onStateChange((state) => {
  //   if (needsAI(state)) {
  //     getAIMove(state).then(move => bridge.sendEvent('MOVE', move));
  //   }
  // });

  return { bridge };
}
`);
  console.log('  ✓ src/core/app.ts (application composition template)');
}

// Generate debug.ts template
const debugPath = join(targetDir, 'src', 'core', 'debug.ts');
if (withStarter && !existsSync(debugPath)) {
  const dir = dirname(debugPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(debugPath, `// debug.ts — debug entry point
// The framework's devHost() handles: WS server + .koala-serve.json + cleanup

import { devHost } from '@koala-agent/core/dev-host';
import { createApp } from './app.js';
// import { GameMachine } from './machines/game/machine.js';

// const app = await devHost(createApp, GameMachine);

// if (process.env.KOALA_SHELL === 'cli') {
//   const { startCliShell } = await import('../shells/cli/main.js');
//   startCliShell(app.bridge);
// }
`);
  console.log('  ✓ src/core/debug.ts (debug entry template)');
}

// 2. koala.config.json
console.log('\n[2/6] Generating koala.config.json...');
const koalaConfig: Record<string, unknown> = {
  scanRoot: withStarter || hadSrcBeforeInit ? 'src' : '.',
  testsDir: 'tests',
  storyDir: 'docs/story/actives',
  requirementsDir: 'docs/requirements',
  storyPrefix: 'S',
};
if (isPython) {
  koalaConfig.language = 'python';
  koalaConfig.scanRoot = withStarter || hadSrcBeforeInit ? 'src' : '.';
  console.log('  ✓ Detected Python project');
}

// Auto-detect browser project
const pkgPath = join(targetDir, 'package.json');
if (existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasHtml = existsSync(join(targetDir, 'index.html')) || existsSync(join(targetDir, 'public', 'index.html'));
    if (hasHtml || deps?.vite || deps?.webpack || deps?.next) {
      const devCmd = deps?.vite ? 'npx vite' : deps?.next ? 'npx next dev' : deps?.webpack ? 'npx webpack serve' : 'npx serve';
      koalaConfig.browser = { devCommand: devCmd };
      console.log(`  ✓ Detected browser project, browser.devCommand = "${devCmd}"`);
    }
  } catch { /* ignore */ }
}
write('koala.config.json', JSON.stringify(koalaConfig, null, 2) + '\n');

// 3. Documentation entry point
console.log('\n[3/6] Configuring Lattice / host documentation...');
writeManagedMarkdown('LATTICE.md', LATTICE_MD_TEMPLATE, 'LATTICE.md');

if (wantsClaude) {
  writeManagedMarkdown('CLAUDE.md', CLAUDE_MD_TEMPLATE, 'CLAUDE.md');
} else {
  console.log('  - CLAUDE.md (profile skip)');
}

if (wantsCodex) {
  writeManagedMarkdown('AGENTS.md', AGENTS_MD_TEMPLATE, 'AGENTS.md');
} else {
  console.log('  - AGENTS.md (profile skip)');
}

// 4. Copy skill
console.log('\n[4/6] Copying /koala skill...');
const skillDst = join(targetDir, '.claude', 'skills', 'koala');
if (wantsClaude && existsSync(skillSrc)) {
  const skillFile = join(skillSrc, 'skill.md');
  const dstFile = join(skillDst, 'skill.md');
  if (!existsSync(dstFile)) {
    if (!existsSync(skillDst)) mkdirSync(skillDst, { recursive: true });
    cpSync(skillFile, dstFile);
    console.log('  ✓ .claude/skills/koala/skill.md');
  } else {
    console.log('  - .claude/skills/koala/skill.md (exists, skip)');
  }
} else if (wantsClaude) {
  // Generate minimal skill from template
  write('.claude/skills/koala/skill.md', KOALA_SKILL_FALLBACK);
} else {
  console.log('  - .claude/skills/koala/skill.md (profile skip)');
}

// 5. agent templates → symlink/copy (templates bundled in the published package)
console.log('\n[5/6] Syncing agent templates...');
const agentDstDir = join(targetDir, '.claude', 'agents');
if (wantsClaude && agentTemplateDir) {
  for (const file of readdirSync(agentTemplateDir)) {
    if (!file.endsWith('.md')) continue;
    const src = join(agentTemplateDir, file);
    const dst = join(agentDstDir, file);
    const linkTarget = src;

    // Already a correct symlink → skip
    if (existsSync(dst)) {
      try {
        const stat = lstatSync(dst);
        if (stat.isSymbolicLink() && readlinkSync(dst) === linkTarget) {
          console.log(`  - .claude/agents/${file} (symlink ok)`);
          continue;
        }
        // Old copy or incorrect symlink → replace
        unlinkSync(dst);
        console.log(`  ↻ .claude/agents/${file} (replacing copy with symlink)`);
      } catch {
        // lstat failed (broken link, etc.) → delete and recreate
        try { unlinkSync(dst); } catch {}
      }
    }

    symlinkSync(linkTarget, dst);
    console.log(`  ✓ .claude/agents/${file} → ${linkTarget}`);
  }
} else if (wantsClaude) {
  console.log('  - agent template directory does not exist, skip');
} else {
  console.log('  - .claude/agents (profile skip)');
}

if (wantsCodex) {
  const codexReadmePath = join(targetDir, '.Codex', 'README.md');
  if (!existsSync(dirname(codexReadmePath))) mkdirSync(dirname(codexReadmePath), { recursive: true });
  writeFileSync(codexReadmePath, renderCodexReadmeTemplate(selectedAssetMode));
  console.log('  ✓ .Codex/README.md');

  const codexManifestPath = join(targetDir, '.Codex', 'lattice.json');
  writeFileSync(codexManifestPath, renderLatticeCodexAdapterManifest(selectedAssetMode === 'thin' ? { promptMode: 'registry' } : {}));
  console.log('  ✓ .Codex/lattice.json');
} else {
  console.log('  - .Codex/README.md (profile skip)');
  console.log('  - .Codex/lattice.json (profile skip)');
}

if (wantsCodex && selectedAssetMode === 'thin') {
  console.log('  - .Codex/agents (thin asset mode; prompts resolve from registry)');
} else if (wantsCodex && agentTemplateDir) {
  const codexAgentDir = join(targetDir, '.Codex', 'agents');
  if (!existsSync(codexAgentDir)) mkdirSync(codexAgentDir, { recursive: true });
  const agentPromptFiles = listAgentPromptFiles(agentTemplateDir);
  const agentPromptFileSet = new Set(agentPromptFiles);
  for (const file of listAgentPromptFiles(codexAgentDir)) {
    if (agentPromptFileSet.has(file)) continue;
    unlinkSync(join(codexAgentDir, file));
    console.log(`  - .Codex/agents/${file} (removed stale prompt)`);
  }
  for (const file of agentPromptFiles) {
    const src = join(agentTemplateDir, file);
    const dst = join(codexAgentDir, file);
    const content = renderCodexAgentContent(readFileSync(src, 'utf-8'));
    if (existsSync(dst)) {
      try {
        const stat = lstatSync(dst);
        if (stat.isSymbolicLink()) unlinkSync(dst);
      } catch {
        try { unlinkSync(dst); } catch {}
      }
    }
    writeFileSync(dst, content);
    console.log(`  ✓ .Codex/agents/${file}`);
  }
} else if (wantsCodex) {
  console.log('  - .Codex/agents template source missing, skip');
}

// 6. hooks + settings.json
console.log('\n[6/6] Configuring hooks...');
const hooksDir = join(targetDir, '.claude', 'hooks');
if (wantsClaude) {
  for (const hookFile of HOOK_FILES) {
    const hookSrc = join(hookSrcDir, hookFile);
    const hookDst = join(hooksDir, hookFile);
    if (existsSync(hookSrc) && !existsSync(hookDst)) {
      if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
      cpSync(hookSrc, hookDst);
      console.log(`  ✓ .claude/hooks/${hookFile}`);
    } else if (existsSync(hookDst)) {
      console.log(`  - .claude/hooks/${hookFile} (exists, skip)`);
    }
  }
  
  // Merge settings.json (do not overwrite existing configuration)
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  const koalaHooks = getKoalaHooks();
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (!existing.hooks) existing.hooks = {};
      // Only add missing koala hook, do not overwrite user's existing configuration.
      for (const [event, hooks] of Object.entries(koalaHooks)) {
        const command = hooks[0]?.hooks?.[0]?.command;
        if (!existing.hooks[event]) {
          existing.hooks[event] = hooks;
          console.log(`  ✓ settings.json: added ${event} hook`);
        } else if (!Array.isArray(existing.hooks[event])) {
          console.log(`  - settings.json: ${event} hook already exists but format is incompatible, skip`);
        } else if (command && !hasHookCommand(existing.hooks[event], command)) {
          existing.hooks[event].push(...hooks);
          console.log(`  ✓ settings.json: merged ${event} koala hook`);
        } else {
          console.log(`  - settings.json: ${event} hook already exists, skip`);
        }
      }
      writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
    } catch (e: any) {
      console.log(`  ⚠ settings.json merge failed: ${e.message}`);
    }
  } else {
    writeFileSync(settingsPath, JSON.stringify({ hooks: koalaHooks }, null, 2) + '\n');
    console.log('  ✓ .claude/settings.json (created)');
  }
} else {
  console.log('  - .claude/hooks (profile skip)');
  console.log('  - .claude/settings.json (profile skip)');
}

if (upgradeManagedAssets) {
  console.log('\n[upgrade] Syncing Lattice managed assets...');
  const result = runManagedAssetCheck(targetDir, { apply: true, profile: selectedProfile, assetMode: selectedAssetMode });
  console.log(renderManagedAssetCheck(result));
  if (!result.ok) process.exit(1);
}

console.log(`
✓ Initialization complete

Next steps:
  1. Read LATTICE.md, then use the entrypoints generated for profile ${selectedProfile}
  2. Optional: edit koala.config.json to adjust scanRoot
  3. Optional: lattice validate to verify project
`);

if (verifyCodex) {
  if (wantsCodex) {
    console.log('Codex verification:');
    const result = runCodexAdapterChecks(targetDir, { executeLocalHeartbeat: true });
    console.log(renderCodexAdapterChecks(result));
    if (!result.ok) process.exit(1);
  } else {
    console.log(`Codex verification skipped: init profile ${selectedProfile} does not generate Codex adapter assets`);
  }
}

// NOTE: generateProfileSection / syncProfileSection were previously defined here.
// They now live in claude-md-sync.ts (no side effects) to avoid triggering this
// self-executing init script when imported by other modules (e.g. workflow.ts).
