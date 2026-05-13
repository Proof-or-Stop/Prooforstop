#!/usr/bin/env node

import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, chmodSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  AGENTS_MD_TEMPLATE,
  CLAUDE_MD_TEMPLATE,
  CODEX_README_TEMPLATE,
  KOALA_MD_TEMPLATE,
  SUPPORTED_INIT_PROFILES,
  listAgentPromptFiles,
  renderCodexAdapterManifest,
  renderCodexAgentContent,
} from './init-assets.js';
import type { InitProfile } from './init-assets.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from './core/codex-adapter-checks.js';
import {
  KOALA_RUNTIME_IGNORE_BLOCK_END,
  KOALA_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from './core/runtime-artifact-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..'); // @koala/main 的根目录
const agentTemplateDir = [
  join(packageRoot, 'templates', 'agents'),
  join(packageRoot, '..', '..', '.claude', 'agents'),
].find(existsSync);
const skillSrc = join(packageRoot, '..', '..', '.claude', 'skills', 'koala');
const hookSrcDir = join(packageRoot, '..', '..', '.claude', 'hooks');
const HOOK_FILES = ['log-tools.cjs', 'session-brief-reminder.cjs'] as const;
const KOALA_SKILL_FALLBACK = `# /koala — 项目管理入口

你是项目管理引擎。执行 /koala 了解项目全貌并开始工作。

详细用法参考 @koala/main 文档。
`;

// 通过 koala init 调用时 argv[2]='init'，跳过；直接 npx koala-init 时 argv[2] 是目标目录
const initArgs = process.argv[2] === 'init' ? process.argv.slice(3) : process.argv.slice(2);
const INIT_DOC_SECTION_RE = /<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/;
const GITIGNORE_RUNTIME_BLOCK_RE = new RegExp(
  `${escapeRegExp(KOALA_RUNTIME_IGNORE_BLOCK_START)}[\\s\\S]*?${escapeRegExp(KOALA_RUNTIME_IGNORE_BLOCK_END)}`,
);

function isSupportedInitProfile(value: string): value is InitProfile {
  return SUPPORTED_INIT_PROFILES.includes(value as InitProfile);
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

function parseTargetDir(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--profile') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) continue;
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
const withStarter = initArgs.includes('--starter') || initArgs.includes('--with-template');
const explicitProfile = parseExplicitProfile(initArgs);
const arg = parseTargetDir(initArgs);

if (initArgs.includes('--help') || initArgs.includes('-h') || initArgs.includes('help')) {
  console.log(`
koala-init — 初始化 koala 开发框架

用法:
  npx koala-init [目标目录]                  在指定目录初始化（默认当前目录）
  npx koala-init --profile <profile> [目标目录]
                                        选择 init profile: codex | claude | all | core
  npx koala-init --starter [目标目录]        额外生成旧版 starter 业务模板
  npx koala-init --with-template [目标目录]  --starter 的同义 alias
  npx koala-init --verify-codex [目标目录]   初始化后校验 Codex adapter 资产
  npx koala-init --help                      显示帮助

初始化内容:
  koala.config.json             项目配置（扫描路径、Story 前缀）
  KOALA.md                      canonical host-neutral Koala 指南
  bin/koala.js                  本地 koala bootstrap
  host adapter assets           由 --profile 控制（codex / claude / all / core）
  .claude/skills/koala/         /koala skill 文件
  docs/story/actives/           Story 数据目录
  docs/requirements/            真相源目录

可选 starter 内容（仅 --starter / --with-template）:
  src/core/app.ts               应用组装（平台无关）
  src/core/debug.ts             调试入口（devHost）
  src/core/machines/game/bridge.ts  Bridge 接口模板
  src/shells/cli/main.ts        CLI shell 模板
  src/shells/web/               Web shell 目录
  tests/                        测试目录

初始化后:
  1. 阅读 KOALA.md，并使用 profile 生成的入口
  2. 编辑 koala.config.json 调整 scanRoot 等路径
  3. 可选: koala validate 跑项目验证
`);
  process.exit(0);
}

const targetDir = arg || process.cwd();
const selectedProfileInfo = explicitProfile
  ? { profile: explicitProfile, reason: `explicit --profile=${explicitProfile}` }
  : detectInitProfile(targetDir);
const selectedProfile = selectedProfileInfo.profile;
const wantsCodex = selectedProfile === 'codex' || selectedProfile === 'all';
const wantsClaude = selectedProfile === 'claude' || selectedProfile === 'all';
const hadSrcBeforeInit = existsSync(join(targetDir, 'src'));
const isPython = existsSync(join(targetDir, 'requirements.txt'))
  || existsSync(join(targetDir, 'pyproject.toml'))
  || existsSync(join(targetDir, 'setup.py'));

console.log(`\nInitializing koala in ${targetDir}\n`);
console.log(`Selected init profile: ${selectedProfile}`);
console.log(`Profile reason: ${selectedProfileInfo.reason}`);
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

function jsString(value: string): string {
  return JSON.stringify(value);
}

function writeExecutable(relPath: string, content: string): boolean {
  const created = write(relPath, content);
  if (created) chmodSync(join(targetDir, relPath), 0o755);
  return created;
}

function renderKoalaBootstrapScript(packageRootAbs: string): string {
  return `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const binDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(binDir);
const coreCliEngineCandidates = [
  join(projectRoot, 'packages', 'main', 'dist', 'cli-engine.js'),
  join(projectRoot, 'node_modules', '@koala-agent', 'core', 'dist', 'cli-engine.js'),
  join(${jsString(packageRootAbs)}, 'dist', 'cli-engine.js'),
];

for (const candidate of coreCliEngineCandidates) {
  if (!existsSync(candidate)) continue;
  const mod = await import(pathToFileURL(candidate).href);
  if (typeof mod.runCli !== 'function') {
    console.error(\`koala local bootstrap candidate has no runCli export: \${candidate}\`);
    process.exit(1);
  }
  await mod.runCli();
  process.exit(0);
}

const probe = spawnSync('koala', ['help'], {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});
const help = String(probe.stdout || '') + String(probe.stderr || '');
if (probe.status !== 0 || !help.includes('aux_doc_list') || !help.includes('verify_codex')) {
  console.error('bin/koala.js could not find a local @koala-agent/core CLI engine or a capable global koala.');
  console.error('');
  console.error('Checked local candidates:');
  for (const candidate of coreCliEngineCandidates) console.error(\`  - \${candidate}\`);
  console.error('');
  console.error('Recovery:');
  console.error('  - Install or update @koala-agent/core, then rerun: npx koala-init --verify-codex');
  console.error('  - In the Koala repository, run: npm run build');
  process.exit(1);
}

const result = spawnSync('koala', process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
`;
}

function renderCodexWrapperScript(): string {
  return `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.KOALA_ACTIVITY_SOURCE = 'codex';
process.env.KOALA_ACTIVITY_RECORD_READONLY = '1';
process.env.KOALA_CODEX_ENTRYPOINT = 'local-wrapper';

if (!process.env.KOALA_ACTIVITY_SESSION) {
  process.env.KOALA_ACTIVITY_SESSION =
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}

const binDir = dirname(fileURLToPath(import.meta.url));
const localKoala = join(binDir, 'koala.js');
if (existsSync(localKoala)) {
  await import(pathToFileURL(localKoala).href);
} else {
  console.error('bin/koala-codex.js did not find a sibling bin/koala.js local bootstrap.');
  console.error('');
  console.error('Recovery:');
  console.error('  - Rerun: npx koala-init --verify-codex');
  console.error('  - If this is the Koala repository, run: npm run build');
  process.exit(1);
}
`;
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

function hookCommand(hookFile: string): string {
  return `node "$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$CLAUDE_PROJECT_DIR")/.claude/hooks/${hookFile}"`;
}

function getKoalaHooks() {
  return {
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('session-brief-reminder.cjs') }] }],
    PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('log-tools.cjs') }] }],
    PostToolUseFailure: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('log-tools.cjs') }] }],
  };
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
  const wrapperPath = join(targetDir, 'bin', 'koala-codex.js');
  if (!existsSync(wrapperPath)) return;
  const actual = readFileSync(wrapperPath, 'utf-8');
  if (actual !== renderCodexWrapperScript()) return;
  unlinkSync(wrapperPath);
  console.log('  ↻ bin/koala-codex.js (removed generated Codex wrapper for profile cleanup)');
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
  removePathIfExists('.Codex/koala.json', '.Codex/koala.json');
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

// 1. 目录
console.log('[1/6] 创建目录...');
const dirs = [
  'docs/story/actives',
  'docs/requirements/decisions',
  'docs/requirements/extracted',
];
if (wantsClaude) dirs.push('.claude/skills/koala', '.claude/agents');
if (wantsCodex) dirs.push('.Codex/agents');
for (const d of dirs) {
  const full = join(targetDir, d);
  if (!existsSync(full)) {
    mkdirSync(full, { recursive: true });
    console.log(`  ✓ ${d}/`);
  }
}

// 1.5 .gitignore（从 koala 项目复制）
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
    // B-5010 CHK-005: tmp/ 要整个 ignore，避免 agent 写一次性 helper 脚本被 git add 收进去
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

// 1.6 可选 starter 项目代码目录（src/core + src/shells）
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

const codexWrapperPath = join(targetDir, 'bin', 'koala-codex.js');
writeExecutable('bin/koala.js', renderKoalaBootstrapScript(packageRoot));

if (wantsCodex && !existsSync(codexWrapperPath)) {
  writeExecutable('bin/koala-codex.js', renderCodexWrapperScript());
  console.log('  ✓ bin/koala-codex.js (Codex wrapper)');
} else if (wantsCodex) {
  console.log('  - bin/koala-codex.js (exists, skip)');
} else {
  console.log('  - bin/koala-codex.js (profile skip)');
}

// 生成 CLI shell 模板
const cliMainPath = join(targetDir, 'src', 'shells', 'cli', 'main.ts');
if (withStarter && !existsSync(cliMainPath)) {
  const dir = dirname(cliMainPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cliMainPath, `// CLI shell — 完整版交互入口
// CLI 不是降级版，是完整版。覆盖所有 machine transitions。
// 只通过 bridge 交互，不直接 import fn.ts。

import * as readline from 'readline';
import { createLocalBridge } from '../../core/machines/game/bridge.js';

const bridge = createLocalBridge();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

bridge.onStateChange((state) => {
  // TODO: 根据 state 渲染 CLI 输出
  console.log(JSON.stringify(state, null, 2));
});

function prompt() {
  rl.question('> ', (input) => {
    const trimmed = input.trim();
    if (trimmed === 'quit' || trimmed === 'exit') {
      rl.close();
      return;
    }
    // TODO: 解析用户输入，调用 bridge.sendEvent(event, input)
    bridge.sendEvent(trimmed, {});
    prompt();
  });
}

prompt();
`);
  console.log('  ✓ src/shells/cli/main.ts (CLI shell 模板)');
}

// 生成 bridge 模板
const bridgePath = join(targetDir, 'src', 'core', 'machines', 'game', 'bridge.ts');
if (withStarter && !existsSync(bridgePath)) {
  const dir = dirname(bridgePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(bridgePath, `// Bridge — 逻辑层与 UI 层的隔离接口
// Shell（CLI/Browser）只 import bridge.ts，不 import fn.ts。

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

// LocalBridge：同进程直连
export function createLocalBridge(): GameBridge {
  // TODO: import machine + fn，实现事件分发
  let state: any = {};
  const listeners = new Set<(state: any) => void>();

  function notify() {
    for (const cb of listeners) cb(state);
  }

  return {
    sendEvent(event: string, input: any): boolean {
      // TODO: 从 machine 找 transition，调 guard + action
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

// WSBridge：开发时通过 WS 连 core 进程
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
  console.log('  ✓ src/core/machines/game/bridge.ts (Bridge 模板)');
}

// 生成 app.ts 模板
const appPath = join(targetDir, 'src', 'core', 'app.ts');
if (withStarter && !existsSync(appPath)) {
  const dir = dirname(appPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(appPath, `// app.ts — 应用组装（平台无关）
// 浏览器和 Node.js 都能运行。不依赖 fs/ws/process。

import { createLocalBridge } from './machines/game/bridge.js';

export async function createApp() {
  const bridge = createLocalBridge();

  // IO 调度示例：
  // bridge.onStateChange((state) => {
  //   if (needsAI(state)) {
  //     getAIMove(state).then(move => bridge.sendEvent('MOVE', move));
  //   }
  // });

  return { bridge };
}
`);
  console.log('  ✓ src/core/app.ts (应用组装模板)');
}

// 生成 debug.ts 模板
const debugPath = join(targetDir, 'src', 'core', 'debug.ts');
if (withStarter && !existsSync(debugPath)) {
  const dir = dirname(debugPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(debugPath, `// debug.ts — 调试入口
// 框架的 devHost() 负责：WS server + .koala-serve.json + cleanup

import { devHost } from '@koala-agent/core/dev-host';
import { createApp } from './app.js';
// import { GameMachine } from './machines/game/machine.js';

// const app = await devHost(createApp, GameMachine);

// if (process.env.KOALA_SHELL === 'cli') {
//   const { startCliShell } = await import('../shells/cli/main.js');
//   startCliShell(app.bridge);
// }
`);
  console.log('  ✓ src/core/debug.ts (调试入口模板)');
}

// 2. koala.config.json
console.log('\n[2/6] 生成 koala.config.json...');
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
  console.log('  ✓ 检测到 Python 项目');
}

// 自动检测浏览器项目
const pkgPath = join(targetDir, 'package.json');
if (existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasHtml = existsSync(join(targetDir, 'index.html')) || existsSync(join(targetDir, 'public', 'index.html'));
    if (hasHtml || deps?.vite || deps?.webpack || deps?.next) {
      const devCmd = deps?.vite ? 'npx vite' : deps?.next ? 'npx next dev' : deps?.webpack ? 'npx webpack serve' : 'npx serve';
      koalaConfig.browser = { devCommand: devCmd };
      console.log(`  ✓ 检测到浏览器项目，browser.devCommand = "${devCmd}"`);
    }
  } catch { /* ignore */ }
}
write('koala.config.json', JSON.stringify(koalaConfig, null, 2) + '\n');

// 3. 文档入口
console.log('\n[3/6] 配置 Koala / host 文档...');
writeManagedMarkdown('KOALA.md', KOALA_MD_TEMPLATE, 'KOALA.md');

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

// 4. 复制 skill
console.log('\n[4/6] 复制 /koala skill...');
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
  // 从模板生成最小 skill
  write('.claude/skills/koala/skill.md', KOALA_SKILL_FALLBACK);
} else {
  console.log('  - .claude/skills/koala/skill.md (profile skip)');
}

// 5. agent 模板 → symlink/copy（发布包内置模板）
console.log('\n[5/6] 同步 agent 模板...');
const agentDstDir = join(targetDir, '.claude', 'agents');
if (wantsClaude && agentTemplateDir) {
  for (const file of readdirSync(agentTemplateDir)) {
    if (!file.endsWith('.md')) continue;
    const src = join(agentTemplateDir, file);
    const dst = join(agentDstDir, file);
    const linkTarget = src;

    // 已是正确 symlink → skip
    if (existsSync(dst)) {
      try {
        const stat = lstatSync(dst);
        if (stat.isSymbolicLink() && readlinkSync(dst) === linkTarget) {
          console.log(`  - .claude/agents/${file} (symlink ok)`);
          continue;
        }
        // 旧 copy 或错误 symlink → 替换
        unlinkSync(dst);
        console.log(`  ↻ .claude/agents/${file} (replacing copy with symlink)`);
      } catch {
        // lstat 失败（断链等）→ 删除重建
        try { unlinkSync(dst); } catch {}
      }
    }

    symlinkSync(linkTarget, dst);
    console.log(`  ✓ .claude/agents/${file} → ${linkTarget}`);
  }
} else if (wantsClaude) {
  console.log('  - agent 模板目录不存在, skip');
} else {
  console.log('  - .claude/agents (profile skip)');
}

if (wantsCodex) {
  const codexReadmePath = join(targetDir, '.Codex', 'README.md');
  if (!existsSync(dirname(codexReadmePath))) mkdirSync(dirname(codexReadmePath), { recursive: true });
  writeFileSync(codexReadmePath, CODEX_README_TEMPLATE);
  console.log('  ✓ .Codex/README.md');

  const codexManifestPath = join(targetDir, '.Codex', 'koala.json');
  writeFileSync(codexManifestPath, renderCodexAdapterManifest());
  console.log('  ✓ .Codex/koala.json');
} else {
  console.log('  - .Codex/README.md (profile skip)');
  console.log('  - .Codex/koala.json (profile skip)');
}

if (wantsCodex && agentTemplateDir) {
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
console.log('\n[6/6] 配置 hooks...');
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
  
  // 合并 settings.json（不覆盖已有配置）
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  const koalaHooks = getKoalaHooks();
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (!existing.hooks) existing.hooks = {};
      // 只添加缺失的 koala hook，不覆盖用户已有配置。
      for (const [event, hooks] of Object.entries(koalaHooks)) {
        const command = hooks[0]?.hooks?.[0]?.command;
        if (!existing.hooks[event]) {
          existing.hooks[event] = hooks;
          console.log(`  ✓ settings.json: 添加 ${event} hook`);
        } else if (!Array.isArray(existing.hooks[event])) {
          console.log(`  - settings.json: ${event} hook 已存在但格式不兼容, skip`);
        } else if (command && !hasHookCommand(existing.hooks[event], command)) {
          existing.hooks[event].push(...hooks);
          console.log(`  ✓ settings.json: 合并 ${event} koala hook`);
        } else {
          console.log(`  - settings.json: ${event} hook 已存在, skip`);
        }
      }
      writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
    } catch (e: any) {
      console.log(`  ⚠ settings.json 合并失败: ${e.message}`);
    }
  } else {
    writeFileSync(settingsPath, JSON.stringify({ hooks: koalaHooks }, null, 2) + '\n');
    console.log('  ✓ .claude/settings.json (created)');
  }
} else {
  console.log('  - .claude/hooks (profile skip)');
  console.log('  - .claude/settings.json (profile skip)');
}

console.log(`
✓ 初始化完成

Next steps:
  1. Read KOALA.md, then use the entrypoints generated for profile ${selectedProfile}
  2. Optional: edit koala.config.json to adjust scanRoot
  3. Optional: koala validate to verify project
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
