#!/usr/bin/env node

import { canonicalAgentRoleId } from './core/agent-role-identity.js';
import { extractManagedBlock, hasManagedBlock, inspectManagedBlock, replaceManagedBlock } from './core/managed-markers.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, lstatSync, unlinkSync, chmodSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  AGENTS_MD_GLOBAL_THIN_TEMPLATE,
  AGENTS_MD_TEMPLATE,
  CLAUDE_MD_TEMPLATE,
  PROOF_OR_STOP_DOT_DIR_MD_TEMPLATE,
  PROOF_OR_STOP_MD_TEMPLATE,
  SUPPORTED_INIT_ASSET_MODES,
  SUPPORTED_INIT_PROFILES,
  listAgentPromptFiles,
  renderCodexAgentContent,
  renderCodexReadmeTemplate,
  renderProofOrStopBootstrapScript,
  renderProofOrStopCodexAdapterManifest,
  renderProofOrStopCodexWrapperScript,
  renderProofOrStopProjectConfig,
  renderCodexHooksJson,
  renderCodexPretoolScopeHookScript,
  renderCodexEvidencePretoolHookScript,
  codexHookCommand,
  getCodexHooks,
  getClaudeHooks,
  hookCommand,
  LEGACY_SCOPE_PRETOOL_HOOK_FILE,
  PROOF_OR_STOP_SCOPE_PRETOOL_HOOK_FILE,
  ENGLISH_ONLY_GUARD_HOOK_FILE,
  EVIDENCE_PRETOOL_HOOK_FILE,
  migrateHookCommandEntries,
} from './init-assets.js';
import type { InitAssetMode, InitProfile } from './init-assets.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from './core/codex-adapter-checks.js';
import {
  migrateProjectLocalManagedAgents,
  renderManagedAssetCheck,
  runManagedAssetCheck,
  scanProjectLocalManagedAgents,
} from './core/managed-assets.js';
import {
  resolveAgentTemplateDir,
  syncGlobalAgents,
} from './core/global-agents.js';
import {
  readPromptRegistry,
  renderPromptEntryForHost,
} from './core/prompt-registry.js';
import {
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END,
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from './core/runtime-artifact-registry.js';
import { PROOF_OR_STOP_STORY_DIR, PROOF_OR_STOP_DIR } from './core/proof-or-stop-paths.js';
// B-cc10 CHK-002: `init` is a WRITER, so it uses the CANONICAL names only — the
// read-both contract resolves deprecated spellings for reads but never writes
// them, otherwise two on-disk copies of the same state would diverge.
import { PROOF_OR_STOP_ADAPTER_DIR, PROOF_OR_STOP_MANIFEST_FILENAME, PROOF_OR_STOP_CONFIG_FILENAME, CONFIG_FILENAMES, adapterManifestCandidates, ADAPTER_DIR_NAMES } from './core/brand-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..'); // @proof-or-stop/core package root
const agentTemplateDir = [
  resolveAgentTemplateDir(),
  join(packageRoot, 'templates', 'agents'),
  join(packageRoot, '..', '..', '.claude', 'agents'),
].find(existsSync);
const hookSrcDir = join(packageRoot, '..', '..', '.claude', 'hooks');
const HOOK_FILES = ['log-tools.cjs', PROOF_OR_STOP_SCOPE_PRETOOL_HOOK_FILE, ENGLISH_ONLY_GUARD_HOOK_FILE, EVIDENCE_PRETOOL_HOOK_FILE, 'session-brief-reminder.cjs'] as const;

// 通过 proof-or-stop init 调用时 argv[2]='init'，跳过；直接运行 init entrypoint 时 argv[2] 是目标目录
const initArgs = process.argv[2] === 'init' ? process.argv.slice(3) : process.argv.slice(2);

const GITIGNORE_RUNTIME_BLOCK_RE = new RegExp(
  `${escapeRegExp(PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START)}[\\s\\S]*?${escapeRegExp(PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END)}`,
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
    PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START,
    ...lines,
    PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END,
  ].join('\n');
}

function mergeProofOrStopRuntimeIgnores(existingContent: string): { content: string; changed: boolean } {
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
  // B-cc10 F-004: probe BOTH adapter-dir spellings so a canonical-only project is
  // still detected as Codex-enabled (read-both; ADAPTER_DIR_NAMES is canonical-first).
  const hasCodexMarkers = existsSync(join(root, 'AGENTS.md'))
    || ADAPTER_DIR_NAMES.some((dir) => existsSync(join(root, dir)));
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
    profile: 'core',
    reason: 'no host markers found; using core (global-thin default)',
  };
}

const verifyCodex = initArgs.includes('--verify-codex');
const upgradeManagedAssets = initArgs.includes('--upgrade');
const withStarter = initArgs.includes('--starter') || initArgs.includes('--with-template');
const explicitProfile = parseExplicitProfile(initArgs);
const arg = parseTargetDir(initArgs);

if (initArgs.includes('--help') || initArgs.includes('-h') || initArgs.includes('help')) {
  console.log(`
proof-or-stop init — 初始化 Proof-or-Stop 开发框架

用法:
  proof-or-stop init [目标目录]                    在指定目录初始化（默认当前目录）
  proof-or-stop init --profile <profile> [目标目录]
                                        选择 init profile: codex | claude | all | core
  proof-or-stop init --asset-mode <mode> [目标目录]
                                        选择资产模式: global-thin（默认）| full | thin
  proof-or-stop init --starter [目标目录]          额外生成旧版 starter 业务模板
  proof-or-stop init --with-template [目标目录]    --starter 的同义 alias
  proof-or-stop init --upgrade [目标目录]          同步 Proof-or-Stop 管理资产到当前版本
  proof-or-stop init --verify-codex [目标目录]     初始化后校验 Codex adapter 资产
  proof-or-stop init --help                        显示帮助

默认初始化（global-thin mode）:
  ${PROOF_OR_STOP_DIR}/Proof-or-Stop.md           canonical host-neutral Proof-or-Stop 指南（新目录）
  ${PROOF_OR_STOP_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}   项目 Proof-or-Stop 配置（global-thin）
  AGENTS.md                     薄 Codex/AGENTS 指南（引用全局 Proof-or-Stop CLI）
  ${PROOF_OR_STOP_CONFIG_FILENAME}      项目配置（canonical）
  ${PROOF_OR_STOP_STORY_DIR}/       Story 数据目录
  docs/requirements/            真相源目录

full/thin asset mode（显式 --asset-mode=full 或 --asset-mode=thin）:
  PROOF_OR_STOP.md                    canonical host-neutral Proof-or-Stop 指南（旧位置）
  bin/proof-or-stop.js          本地 Proof-or-Stop bootstrap（仅 full/thin）
  ${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}   Codex adapter manifest（仅 full/thin + codex profile）
  ${PROOF_OR_STOP_ADAPTER_DIR}/agents                 agent prompt copies（仅 full mode + codex profile）

可选 starter 内容（仅 --starter / --with-template）:
  src/core/app.ts               应用组装（平台无关）
  src/core/debug.ts             调试入口（devHost）
  src/core/machines/game/bridge.ts  Bridge 接口模板
  src/shells/cli/main.ts        CLI shell 模板
  src/shells/web/               Web shell 目录
  tests/                        测试目录

初始化后（global-thin）:
  1. 阅读 ${PROOF_OR_STOP_DIR}/Proof-or-Stop.md
  2. 使用全局 Proof-or-Stop CLI：proof-or-stop session_brief、proof-or-stop codex verify、proof-or-stop codex doctor
  3. 可选: 编辑 ${PROOF_OR_STOP_CONFIG_FILENAME} 调整 scanRoot 等路径
  4. 可选: proof-or-stop validate 跑项目验证
`);
  process.exit(0);
}

const targetDir = arg || process.cwd();
const selectedProfileInfo = explicitProfile
  ? { profile: explicitProfile, reason: `explicit --profile=${explicitProfile}` }
  : detectInitProfile(targetDir);
const selectedProfile = selectedProfileInfo.profile;
const selectedAssetMode = parseExplicitAssetMode(initArgs) ?? 'global-thin';
const isGlobalThin = selectedAssetMode === 'global-thin';
const wantsCodex = selectedProfile === 'codex' || selectedProfile === 'all';
const wantsClaude = selectedProfile === 'claude' || selectedProfile === 'all';
const hadSrcBeforeInit = existsSync(join(targetDir, 'src'));
const isPython = existsSync(join(targetDir, 'requirements.txt'))
  || existsSync(join(targetDir, 'pyproject.toml'))
  || existsSync(join(targetDir, 'setup.py'));

console.log(`\nInitializing Proof-or-Stop in ${targetDir}\n`);
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

function extractManagedSection(content: string): string {
  return extractManagedBlock(content, 'document');
}

function hasManagedMarkers(content: string): boolean {
  return hasManagedBlock(content, 'document');
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
  const inspection = inspectManagedBlock(existing, 'document');
  if (inspection.status === 'missing') {
    console.log(`  - ${label} (exists, no Proof-or-Stop managed markers, skip)`);
    return;
  }
  if (inspection.status === 'malformed') {
    console.log(`  - ${label} (malformed Proof-or-Stop managed markers, skip)`);
    return;
  }

  const updated = replaceManagedBlock(existing, extractManagedSection(desiredContent), 'document');
  if (updated === null) {
    console.log(`  - ${label} (managed markers became ambiguous, skip)`);
    return;
  }
  if (updated !== existing) {
    writeFileSync(full, updated);
    console.log(`  ✓ ${label} (Proof-or-Stop section synced)`);
  } else {
    console.log(`  - ${label} (Proof-or-Stop section up to date)`);
  }
}

function hasHookCommand(entries: any, command: string): boolean {
  return Array.isArray(entries) && entries.some((entry: any) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook: any) => hook?.type === 'command' && hook?.command === command));
}

function mergeCodexHooks(existing: any): { updated: any; changed: boolean; incompatible: string[] } {
  const codexHooks = getCodexHooks();
  const updated = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const hooks = updated.hooks && typeof updated.hooks === 'object' && !Array.isArray(updated.hooks)
    ? { ...updated.hooks }
    : {};
  const incompatible: string[] = [];
  let changed = !updated.hooks;

  for (const [event, eventHooks] of Object.entries(codexHooks)) {
    // B-1507 CHK-003: an event can declare MULTIPLE managed entries (PreToolUse
    // now has both the scope guard AND the evidence-pin seatbelt). The legacy
    // scope-pretool command migrates onto the FIRST managed entry's command;
    // each entry must then be merged independently — only checking eventHooks[0]
    // would silently drop every entry after the first.
    const migrationTarget = eventHooks[0]?.hooks?.[0]?.command;
    if (!hooks[event]) {
      hooks[event] = eventHooks;
      changed = true;
      continue;
    }
    if (!Array.isArray(hooks[event])) {
      incompatible.push(event);
      continue;
    }
    const migrated = migrateHookCommandEntries(
      hooks[event],
      codexHookCommand(LEGACY_SCOPE_PRETOOL_HOOK_FILE),
      migrationTarget || '',
    );
    if (migrated.changed) {
      hooks[event] = migrated.entries;
      changed = true;
    }
    for (const entry of eventHooks) {
      const command = entry?.hooks?.[0]?.command;
      if (command && !hasHookCommand(hooks[event], command)) {
        hooks[event] = [...hooks[event], entry];
        changed = true;
      }
    }
  }

  updated.hooks = hooks;
  return { updated, changed, incompatible };
}

function removeIfManagedDoc(relPath: string, label: string) {
  const full = join(targetDir, relPath);
  if (!existsSync(full)) return;
  const content = readFileSync(full, 'utf-8');
  if (!hasManagedMarkers(content)) return;
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
    const legacyHooks = JSON.parse(JSON.stringify(getClaudeHooks()));
    legacyHooks.PreToolUse[0].hooks[0].command = hookCommand(LEGACY_SCOPE_PRETOOL_HOOK_FILE);
    const managedSettings = [
      { hooks: getClaudeHooks() },
      { hooks: legacyHooks },
    ];
    if (!managedSettings.some(settings => JSON.stringify(parsed) === JSON.stringify(settings))) return;
    unlinkSync(settingsPath);
    console.log('  ↻ .claude/settings.json (removed managed settings for profile cleanup)');
    cleanupEmptyDirChain('.claude');
  } catch {
    // preserve user-owned or malformed settings
  }
}

function removeCodexWrapperIfManaged() {
  const rel = 'bin/proof-or-stop-codex.js';
  removeWholeFileIfGenerated(rel, rel, [renderProofOrStopCodexWrapperScript()]);
}

function removeCodexManifestIfManaged() {
  // B-cc10 CHK-004: profile cleanup must consider BOTH manifest filenames, same
  // reasoning as removeCodexWrapperIfManaged above. A cleanup pinned to one
  // spelling would strand a managed manifest written under the other name, which
  // `verify_codex` would then keep discovering after the profile said to remove it.
  // adapterManifestCandidates() is the dir x filename cross product, so cleanup
  // also covers a half-migrated checkout (canonical dir, deprecated filename).
  for (const rel of adapterManifestCandidates()) {
    removeWholeFileIfGenerated(rel, rel, [
      renderProofOrStopCodexAdapterManifest(),
      renderProofOrStopCodexAdapterManifest({ promptMode: 'registry' }),
    ]);
  }
}

function removeCodexNativeHooksIfManaged() {
  removeWholeFileIfGenerated('.codex/hooks.json', '.codex/hooks.json', [renderCodexHooksJson()]);
  removeWholeFileIfGenerated('.codex/hooks/proof-or-stop-scope-pretool.cjs', '.codex/hooks/proof-or-stop-scope-pretool.cjs', [renderCodexPretoolScopeHookScript()]);
  removeWholeFileIfGenerated('.codex/hooks/scope-pretool.cjs', '.codex/hooks/scope-pretool.cjs', [renderCodexPretoolScopeHookScript()]);
  cleanupEmptyDirChain('.codex/hooks');
}

function cleanupClaudeAssets() {
  removeIfManagedDoc('CLAUDE.md', 'CLAUDE.md');
  removePathIfExists('.claude/agents', '.claude/agents');
  removePathIfExists('.claude/hooks', '.claude/hooks');
  removeClaudeSettingsIfManaged();
  cleanupEmptyDirChain('.claude/skills');
  cleanupEmptyDirChain('.claude');
}

function cleanupCodexAssets() {
  removeIfManagedDoc('AGENTS.md', 'AGENTS.md');
  // B-cc10 F-026: sweep EVERY accepted adapter-dir spelling. This only removed the
  // deprecated dir, so profile cleanup on a migrated project orphaned
  // .proof-or-stop-codex/agents and README.md. ADAPTER_DIR_NAMES is already imported
  // and used correctly by removeCodexManifestIfManaged / removeCodexWrapperIfManaged.
  for (const dir of ADAPTER_DIR_NAMES) {
    removePathIfExists(`${dir}/agents`, `${dir}/agents`);
    removePathIfExists(`${dir}/README.md`, `${dir}/README.md`);
  }
  removeCodexManifestIfManaged();
  for (const dir of ADAPTER_DIR_NAMES) cleanupEmptyDirChain(dir);
  removeCodexWrapperIfManaged();
  removeCodexNativeHooksIfManaged();
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
console.log('[1/5] 创建目录...');
const dirs = [
  'docs/story/actives',
  'docs/requirements/decisions',
  'docs/requirements/extracted',
];
if (isGlobalThin) dirs.push(PROOF_OR_STOP_DIR);
// B-097f: do NOT create project .claude/agents — agent prompts resolve from the
// user-global ~/.claude/agents single source. `.claude` (for hooks/settings) is
// created on demand by the [5/5] block when wantsClaude.
if (wantsCodex && selectedAssetMode === 'full') dirs.push(`${PROOF_OR_STOP_ADAPTER_DIR}/agents`);
for (const d of dirs) {
  const full = join(targetDir, d);
  if (!existsSync(full)) {
    mkdirSync(full, { recursive: true });
    console.log(`  ✓ ${d}/`);
  }
}

// 1.5 .gitignore（同步 Proof-or-Stop runtime ignore 模板）
const giPath = join(targetDir, '.gitignore');
const giSrc = join(packageRoot, '..', '..', '.gitignore');
if (!existsSync(giPath)) {
  if (existsSync(giSrc)) {
    cpSync(giSrc, giPath);
    // The template .gitignore can lag the runtime-artifact registry (e.g. a new
    // ignorePattern added after the template was last synced). Re-merge from the
    // registry so the copy path is registry-synced just like the existing-file
    // branch below — keeps the registry the single source of truth (B-4fd3).
    const merged = mergeProofOrStopRuntimeIgnores(readFileSync(giPath, 'utf8'));
    if (merged.changed) {
      writeFileSync(giPath, merged.content);
      console.log('  ✓ .gitignore (copied from Proof-or-Stop template, runtime ignores synced)');
    } else {
      console.log('  ✓ .gitignore (copied from Proof-or-Stop template)');
    }
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
  const mergeResult = mergeProofOrStopRuntimeIgnores(readFileSync(giPath, 'utf8'));
  if (mergeResult.changed) {
    writeFileSync(giPath, mergeResult.content);
    console.log('  ✓ .gitignore (merged Proof-or-Stop runtime ignores)');
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

const CANONICAL_BOOTSTRAP_REL = 'bin/proof-or-stop.js';
const CANONICAL_CODEX_WRAPPER_REL = 'bin/proof-or-stop-codex.js';

const existingCodexWrapperRel = existsSync(join(targetDir, CANONICAL_CODEX_WRAPPER_REL))
  ? CANONICAL_CODEX_WRAPPER_REL
  : undefined;

if (!isGlobalThin) {
  writeExecutable(CANONICAL_BOOTSTRAP_REL, renderProofOrStopBootstrapScript(packageRoot));
} else {
  console.log(`  - ${CANONICAL_BOOTSTRAP_REL} (global-thin mode; use global proof-or-stop CLI)`);
}

if (!isGlobalThin && wantsCodex && !existingCodexWrapperRel) {
  writeExecutable(CANONICAL_CODEX_WRAPPER_REL, renderProofOrStopCodexWrapperScript());
  console.log(`  ✓ ${CANONICAL_CODEX_WRAPPER_REL} (Codex wrapper)`);
} else if (!isGlobalThin && wantsCodex) {
  console.log(`  - ${existingCodexWrapperRel} (exists, skip)`);
} else if (isGlobalThin) {
  console.log(`  - ${CANONICAL_CODEX_WRAPPER_REL} (global-thin mode; use proof-or-stop codex verify)`);
} else {
  console.log(`  - ${CANONICAL_CODEX_WRAPPER_REL} (profile skip)`);
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
// 框架的 devHost() 负责：WS server + .proof-or-stop-serve.json + cleanup

import { devHost } from '@proof-or-stop/core/dev-host';
import { createApp } from './app.js';
import { readBrandEnv } from './core/brand-env.js';
// import { GameMachine } from './machines/game/machine.js';

// const app = await devHost(createApp, GameMachine);

// if (readBrandEnv('SHELL') === 'cli') {
//   const { startCliShell } = await import('../shells/cli/main.js');
//   startCliShell(app.bridge);
// }
`);
  console.log('  ✓ src/core/debug.ts (调试入口模板)');
}

// 2. project config (canonical filename only)
console.log(`\n[2/5] 生成 ${PROOF_OR_STOP_CONFIG_FILENAME}...`);
const proofOrStopConfig: Record<string, unknown> = {
  scanRoot: withStarter || hadSrcBeforeInit ? 'src' : '.',
  testsDir: 'tests',
  storyDir: PROOF_OR_STOP_STORY_DIR,
  requirementsDir: 'docs/requirements',
  storyPrefix: 'S',
};
if (isPython) {
  proofOrStopConfig.language = 'python';
  proofOrStopConfig.scanRoot = withStarter || hadSrcBeforeInit ? 'src' : '.';
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
      proofOrStopConfig.browser = { devCommand: devCmd };
      console.log(`  ✓ 检测到浏览器项目，browser.devCommand = "${devCmd}"`);
    }
  } catch { /* ignore */ }
}
// B-cc10 CHK-004: the SKIP test is read-both, the WRITE is canonical-only. If the
// existence test only looked for the canonical name, `init` on an unmigrated
// project would write a SECOND config file next to the deprecated one — two
// on-disk copies of the same state, with the canonical one silently winning and
// the user's real settings ignored.
const existingConfigFilename = CONFIG_FILENAMES.find((name) => existsSync(join(targetDir, name)));
if (existingConfigFilename) {
  console.log(`  - ${existingConfigFilename} (exists, skip)`);
} else {
  write(PROOF_OR_STOP_CONFIG_FILENAME, JSON.stringify(proofOrStopConfig, null, 2) + '\n');
}

// 3. 文档入口
console.log('\n[3/5] 配置 Proof-or-Stop / host 文档...');
if (isGlobalThin) {
  // B-cc10 CHK-007 (F-004): this was a hardcoded `.proof-or-stop/Proof-or-Stop.md` while the
  // manifest three lines below already went to PROOF_OR_STOP_DIR, so a single
  // `init` STRADDLED two state directories and created a stray legacy directory
  // on every fresh init. Derived now, so the guide lands beside the manifest.
  const dotDirGuidePath = `${PROOF_OR_STOP_DIR}/Proof-or-Stop.md`;
  writeManagedMarkdown(dotDirGuidePath, PROOF_OR_STOP_DOT_DIR_MD_TEMPLATE, dotDirGuidePath);
  const proofOrStopConfigPath = join(targetDir, PROOF_OR_STOP_DIR, PROOF_OR_STOP_MANIFEST_FILENAME);
  // B-cc10 CHK-004: report the path actually written rather than a hardcoded
  // spelling, so the console never claims a filename that is not on disk.
  const proofOrStopConfigLabel = `${PROOF_OR_STOP_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;
  if (!existsSync(proofOrStopConfigPath)) {
    writeFileSync(proofOrStopConfigPath, renderProofOrStopProjectConfig());
    console.log(`  ✓ ${proofOrStopConfigLabel}`);
  } else {
    console.log(`  - ${proofOrStopConfigLabel} (exists, skip)`);
  }
  console.log(`  - PROOF_OR_STOP.md (global-thin mode; canonical guide is ${dotDirGuidePath})`);
} else {
  writeManagedMarkdown('PROOF_OR_STOP.md', PROOF_OR_STOP_MD_TEMPLATE, 'PROOF_OR_STOP.md');
}

if (wantsClaude) {
  writeManagedMarkdown('CLAUDE.md', CLAUDE_MD_TEMPLATE, 'CLAUDE.md');
} else {
  console.log('  - CLAUDE.md (profile skip)');
}

if (isGlobalThin) {
  writeManagedMarkdown('AGENTS.md', AGENTS_MD_GLOBAL_THIN_TEMPLATE, 'AGENTS.md');
} else if (wantsCodex) {
  writeManagedMarkdown('AGENTS.md', AGENTS_MD_TEMPLATE, 'AGENTS.md');
} else {
  console.log('  - AGENTS.md (profile skip)');
}

// 4. agent 适配器 → 全局单一源 ~/.claude/agents thin-shim（B-097f）
// Claude Code 从磁盘解析 canonical proof-or-stop-* subagent_type。用户级全局
// ~/.claude/agents 对所有项目生效，project-level 会 shadow user-level。
// prompt 正文绝不物化进宿主目录（symlink 也算暴露）；每个角色只放一个
// thin-shim（frontmatter + tools + "从 CLI 取指令" body），正文由
// `proof-or-stop agent_prompt --role=<name>` 从包内 registry 现取。
console.log('\n[4/5] 同步 agent 适配器（全局 thin-shim 单一源）...');
const agentDstDir = join(targetDir, '.claude', 'agents');
if (wantsClaude && agentTemplateDir) {
  // 确保全局源就绪：为 CLI 包 templates/agents 下每个 *.md 在 ~/.claude/agents
  // 生成 thin-shim（保留 tools 沙箱、不含正文）。全局不可写时抛明确错误，
  // 不静默回退 project-local。
  const sync = syncGlobalAgents({ templateDir: agentTemplateDir });
  console.log(
    `  ✓ ${sync.globalDir} (synced=${sync.synced}, ok=${sync.skipped}, replaced=${sync.replaced} → ${sync.templateDir})`,
  );
  console.log('  - .claude/agents (resolved from global ~/.claude/agents thin-shims; no per-project files)');

  // B-097f CHK-004: project-local .claude/agents shadows the global single
  // source. Migrate ONLY the exact managed basenames, and ONLY under the
  // explicit --upgrade flow. A normal init MUST NOT delete project files.
  const projectScan = scanProjectLocalManagedAgents(targetDir, agentTemplateDir);
  if (projectScan.managedFiles.length > 0) {
    if (upgradeManagedAssets) {
      const migration = migrateProjectLocalManagedAgents(
        targetDir,
        agentTemplateDir,
        relPath => console.log(`  ↻ ${relPath} (migrated to global)`),
      );
      console.log(
        `  ✓ migrated ${migration.removed.length} managed agent file(s) to global` +
          (migration.preserved.length > 0 ? `; preserved ${migration.preserved.length} user file(s)` : '') +
          (migration.dirRemoved ? '; removed empty .claude/agents' : ''),
      );
    } else {
      console.log(
        `  ⚠ ${projectScan.managedFiles.length} managed agent files found in .claude/agents; ` +
          `run proof-or-stop init --upgrade to migrate to global`,
      );
    }
  }
} else if (wantsClaude) {
  console.log('  - agent 模板目录不存在, skip');
} else {
  console.log('  - .claude/agents (profile skip)');
}

// B-cc10 CHK-007: the adapter-dir README/agents writers below were hardcoded to the
// DEPRECATED adapter directory while the MANIFEST already used the resolver, so
// full-mode `init` created BOTH directories — measured on a fresh init:
// `.proof-or-stop-codex/{README.md,agents}` plus `.proof-or-stop-codex/proof-or-stop.json`.
// Same straddle class as the state-dir F-004 defect, on the adapter identity.
const codexReadmeRel = `${PROOF_OR_STOP_ADAPTER_DIR}/README.md`;
const codexAgentsRel = `${PROOF_OR_STOP_ADAPTER_DIR}/agents`;

if (!isGlobalThin && wantsCodex) {
  const codexReadmePath = join(targetDir, PROOF_OR_STOP_ADAPTER_DIR, 'README.md');
  if (!existsSync(dirname(codexReadmePath))) mkdirSync(dirname(codexReadmePath), { recursive: true });
  writeFileSync(codexReadmePath, renderCodexReadmeTemplate(selectedAssetMode));
  console.log(`  ✓ ${codexReadmeRel}`);

  // B-cc10 CHK-004: the manifest FILENAME comes from the resolver (canonical
  // only — `init` is a writer). Both halves are resolver-derived now.
  const codexManifestLabel = `${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;
  const codexManifestPath = join(targetDir, PROOF_OR_STOP_ADAPTER_DIR, PROOF_OR_STOP_MANIFEST_FILENAME);
  writeFileSync(codexManifestPath, renderProofOrStopCodexAdapterManifest(selectedAssetMode === 'thin' ? { promptMode: 'registry' } : {}));
  console.log(`  ✓ ${codexManifestLabel}`);
} else if (isGlobalThin) {
  console.log(`  - ${codexReadmeRel} (global-thin mode; Codex adapter runs from global Proof-or-Stop CLI)`);
  console.log(`  - ${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME} (global-thin mode; use proof-or-stop codex verify)`);
} else {
  console.log(`  - ${codexReadmeRel} (profile skip)`);
  console.log(`  - ${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME} (profile skip)`);
}

if (!isGlobalThin && wantsCodex && selectedAssetMode === 'thin') {
  console.log(`  - ${codexAgentsRel} (thin asset mode; prompts resolve from registry)`);
} else if (!isGlobalThin && wantsCodex && agentTemplateDir) {
  const codexAgentDir = join(targetDir, PROOF_OR_STOP_ADAPTER_DIR, 'agents');
  if (!existsSync(codexAgentDir)) mkdirSync(codexAgentDir, { recursive: true });
  const agentPromptFiles = listAgentPromptFiles(agentTemplateDir);
  const agentPromptFileSet = new Set(agentPromptFiles);
  for (const file of listAgentPromptFiles(codexAgentDir)) {
    if (agentPromptFileSet.has(file)) continue;
    unlinkSync(join(codexAgentDir, file));
    console.log(`  - ${codexAgentsRel}/${file} (removed stale prompt)`);
  }
  for (const file of agentPromptFiles) {
    const src = join(agentTemplateDir, file);
    const dst = join(codexAgentDir, file);
    const roleId = file.replace(/\.md$/, '');
    // Active mirrors are always rendered from the canonical package template.
    // renderPromptEntryForHost applies only the host-specific transformation and
    // reviewer bootstrap; no retired prompt mode is accepted at this writer.
    const registryEntry = readPromptRegistry(agentTemplateDir).agents
      .find(entry => entry.agentId === roleId);
    const content = registryEntry
      ? renderPromptEntryForHost(registryEntry, 'codex')
      : renderCodexAgentContent(readFileSync(src, 'utf-8'));
    if (existsSync(dst)) {
      try {
        const stat = lstatSync(dst);
        if (stat.isSymbolicLink()) unlinkSync(dst);
      } catch {
        try { unlinkSync(dst); } catch {}
      }
    }
    writeFileSync(dst, content);
    console.log(`  ✓ ${codexAgentsRel}/${file}`);
  }
} else if (!isGlobalThin && wantsCodex) {
  console.log(`  - ${codexAgentsRel} template source missing, skip`);
} else if (isGlobalThin) {
  console.log(`  - ${codexAgentsRel} (global-thin mode; Codex prompts resolve from global Proof-or-Stop registry)`);
}

// 6. hooks + settings.json
console.log('\n[5/5] 配置 hooks...');
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
  const newPretoolHookSrc = join(hookSrcDir, PROOF_OR_STOP_SCOPE_PRETOOL_HOOK_FILE);
  if (existsSync(newPretoolHookSrc)) {
    removeWholeFileIfGenerated(
      `.claude/hooks/${LEGACY_SCOPE_PRETOOL_HOOK_FILE}`,
      `.claude/hooks/${LEGACY_SCOPE_PRETOOL_HOOK_FILE}`,
      [readFileSync(newPretoolHookSrc, 'utf-8')],
    );
  }
  
  // 合并 settings.json（不覆盖已有配置）
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  const claudeHooks = getClaudeHooks();
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (!existing.hooks) existing.hooks = {};
      // 只添加缺失的 Proof-or-Stop hook，不覆盖用户已有配置。
      for (const [event, hooks] of Object.entries(claudeHooks)) {
        if (!existing.hooks[event]) {
          existing.hooks[event] = hooks;
          console.log(`  ✓ settings.json: 添加 ${event} hook`);
          continue;
        }
        if (!Array.isArray(existing.hooks[event])) {
          console.log(`  - settings.json: ${event} hook 已存在但格式不兼容, skip`);
          continue;
        }
        // B-5f42: an event can declare MULTIPLE managed entries (e.g. PreToolUse
        // now has both the scope guard AND the english-only guard). Mirror
        // managed-assets.ts mergeClaudeHooks and merge each entry independently —
        // only inspecting hooks[0] silently drops every entry after the first
        // (and would push the whole array, duplicating the scope guard).
        const migrationTarget = hooks[0]?.hooks?.[0]?.command;
        const migrated = migrateHookCommandEntries(
          existing.hooks[event],
          hookCommand(LEGACY_SCOPE_PRETOOL_HOOK_FILE),
          migrationTarget || '',
        );
        if (migrated.changed) {
          existing.hooks[event] = migrated.entries;
          console.log(`  ✓ settings.json: 迁移 ${event} Proof-or-Stop hook 名称`);
        }
        let mergedAny = false;
        for (const entry of hooks) {
          const command = entry?.hooks?.[0]?.command;
          if (command && !hasHookCommand(existing.hooks[event], command)) {
            existing.hooks[event].push(entry);
            mergedAny = true;
          }
        }
        if (mergedAny) {
          console.log(`  ✓ settings.json: 合并 ${event} Proof-or-Stop hook`);
        } else {
          console.log(`  - settings.json: ${event} hook 已存在, skip`);
        }
      }
      writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
    } catch (e: any) {
      console.log(`  ⚠ settings.json 合并失败: ${e.message}`);
    }
  } else {
    // B-097f: .claude/agents is no longer pre-created, so ensure .claude exists
    // before writing settings.json (hooks may have been skipped when absent).
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: claudeHooks }, null, 2) + '\n');
    console.log('  ✓ .claude/settings.json (created)');
  }
} else {
  console.log('  - .claude/hooks (profile skip)');
  console.log('  - .claude/settings.json (profile skip)');
}

if (wantsCodex || isGlobalThin) {
  writeExecutable('.codex/hooks/proof-or-stop-scope-pretool.cjs', renderCodexPretoolScopeHookScript());
  removeWholeFileIfGenerated('.codex/hooks/scope-pretool.cjs', '.codex/hooks/scope-pretool.cjs', [renderCodexPretoolScopeHookScript()]);
  // B-1507 CHK-003: fail-open evidence-pin seatbelt on the Codex shell tool.
  writeExecutable('.codex/hooks/proof-or-stop-evidence-pretool.cjs', renderCodexEvidencePretoolHookScript());

  const codexHooksPath = join(targetDir, '.codex', 'hooks.json');
  const codexHooks = getCodexHooks();
  if (existsSync(codexHooksPath)) {
    try {
      const existing = JSON.parse(readFileSync(codexHooksPath, 'utf-8'));
      const merged = mergeCodexHooks(existing);
      if (merged.incompatible.length > 0) {
        console.log(`  - .codex/hooks.json: ${merged.incompatible.join(', ')} hook shape incompatible, skip`);
      } else if (merged.changed) {
        writeFileSync(codexHooksPath, JSON.stringify(merged.updated, null, 2) + '\n');
        console.log('  ✓ .codex/hooks.json: merged Proof-or-Stop PreToolUse hook');
      } else {
        console.log('  - .codex/hooks.json: PreToolUse hook exists, skip');
      }
    } catch (e: any) {
      console.log(`  ⚠ .codex/hooks.json merge failed: ${e.message}`);
    }
  } else {
    writeFileSync(codexHooksPath, JSON.stringify({ hooks: codexHooks }, null, 2) + '\n');
    console.log('  ✓ .codex/hooks.json (created)');
  }
} else {
  console.log('  - .codex/hooks (profile skip)');
  console.log('  - .codex/hooks.json (profile skip)');
}

if (upgradeManagedAssets) {
  console.log('\n[upgrade] 同步 Proof-or-Stop 管理资产...');
  const result = runManagedAssetCheck(targetDir, { apply: true, profile: selectedProfile, assetMode: selectedAssetMode });
  console.log(renderManagedAssetCheck(result));
  if (!result.ok) process.exit(1);
}

console.log(`
✓ 初始化完成

Next steps:
${isGlobalThin ? `  1. Read ${PROOF_OR_STOP_DIR}/Proof-or-Stop.md
  2. Use the global proof-or-stop CLI: proof-or-stop session_brief
  3. For Codex adapter: proof-or-stop codex verify / proof-or-stop codex doctor
  4. Optional: proof-or-stop validate to verify project` : `  1. Read PROOF_OR_STOP.md, then use the entrypoints generated for profile ${selectedProfile}
  2. Optional: edit ${PROOF_OR_STOP_CONFIG_FILENAME} to adjust scanRoot
  3. Optional: proof-or-stop validate to verify project`}
`);

if (verifyCodex) {
  if (isGlobalThin || wantsCodex) {
    console.log('Codex verification:');
    const result = runCodexAdapterChecks(targetDir, { executeLocalHeartbeat: !isGlobalThin });
    console.log(renderCodexAdapterChecks(result));
    if (!result.ok) process.exit(1);
  } else {
    console.log(`Codex verification skipped: init profile ${selectedProfile} does not generate Codex adapter assets`);
  }
}

// NOTE: generateProfileSection / syncProfileSection were previously defined here.
// They now live in claude-md-sync.ts (no side effects) to avoid triggering this
// self-executing init script when imported by other modules (e.g. workflow.ts).
