import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  LATTICE_CODEX_ADAPTER_MANIFEST,
  CODEX_PRETOOL_SCOPE_HOOK_MATCHER,
  listAgentPromptFiles,
  renderCodexAgentContent,
  renderLatticeCodexAdapterManifest,
  type CodexPromptMode,
} from '../init-assets.js';
import { readActivityLogTail } from './activity-log.js';
import {
  resolveAgentAssetResolution,
  summarizeAgentAssetResolution,
  type AgentAssetResolution,
} from './agent-asset-resolution.js';
import {
  promptRegistryManifest,
  readPromptRegistry,
  renderPromptEntryForHost,
} from './prompt-registry.js';
import type { StoryStore } from './store.js';
import type { ProcessEvent } from './types.js';

export type CodexAdapterCheckStatus = 'pass' | 'warn' | 'fail';

export interface CodexAdapterCheck {
  id: string;
  label: string;
  status: CodexAdapterCheckStatus;
  hard: boolean;
  detail: string;
  command?: string;
}

export interface CodexAdapterCheckResult {
  ok: boolean;
  summary: string;
  checks: CodexAdapterCheck[];
  timestamp: string;
  materialSnapshot: CodexAdapterMaterialSnapshot;
}

export interface CodexAdapterMaterialSnapshot {
  headHash: string;
  materialHash: string;
  files: string[];
}

export const LOCAL_CODEX_VERIFY_COMMAND = 'node bin/lattice-codex.js verify_codex';
export const LOCAL_MAIN_VERIFY_COMMAND = 'node bin/lattice.js verify_codex';
export const GLOBAL_THIN_CODEX_VERIFY_COMMAND = 'lattice codex verify';
export const LOCAL_INIT_VERIFY_COMMAND = 'lattice init --verify-codex';
export const GLOBAL_CODEX_FALLBACK_COMMAND = 'LATTICE_ACTIVITY_SOURCE=codex LATTICE_ACTIVITY_RECORD_READONLY=1 LATTICE_CODEX_ENTRYPOINT=global-fallback lattice';

/**
 * Resolve the preferred verify_codex command from available local wrappers.
 * Falls back to the documented global-thin command when local wrappers are intentionally absent.
 */
export function resolveLocalCodexVerifyCommand(root: string): string {
  if (isGlobalThinProject(root)) return GLOBAL_THIN_CODEX_VERIFY_COMMAND;
  const candidates: Array<[string, string]> = [
    ['bin/lattice-codex.js', LOCAL_CODEX_VERIFY_COMMAND],
    ['bin/lattice.js',       LOCAL_MAIN_VERIFY_COMMAND],
  ];
  for (const [rel, cmd] of candidates) {
    if (existsSync(join(root, rel))) return cmd;
  }
  return LOCAL_CODEX_VERIFY_COMMAND;
}

export function resolveCodexSessionBriefCommand(root: string): string {
  if (isGlobalThinProject(root)) return `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`;
  const candidates: Array<[string, string]> = [
    ['bin/lattice-codex.js', 'node bin/lattice-codex.js session_brief'],
    ['bin/lattice.js',       'node bin/lattice.js session_brief'],
  ];
  for (const [rel, cmd] of candidates) {
    if (existsSync(join(root, rel))) return cmd;
  }
  return 'node bin/lattice-codex.js session_brief';
}

const CODEX_MATERIAL_PATHS = [
  '.lattice-codex/README.md',
  '.lattice-codex/lattice.json',
  '.lattice-codex/agents',
  '.codex/hooks.json',
  '.codex/hooks',
  '.claude/agents',
  'AGENTS.md',
  'README.md',
  'bin/lattice-codex.js',
  'bin/lattice.js',
  'bin/bootstrap-runner.js',
  'packages/main/templates/agents',
  'packages/main/src/init-assets.ts',
  'packages/main/src/cli-init.ts',
  'packages/main/src/core/codex-adapter-checks.ts',
  'packages/main/src/core/prompt-registry.ts',
  'packages/main/src/handlers/codex-adapter.ts',
  'packages/main/src/handlers/review-preflight.ts',
  'packages/main/src/handlers/story-advance.ts',
] as const;

interface RunCodexChecksOptions {
  executeHeartbeats?: boolean;
  executeLocalHeartbeat?: boolean;
  executeGlobalHeartbeat?: boolean;
  registryNames?: Set<string>;
  storyId?: string;
  store?: StoryStore;
  timeoutMs?: number;
}

function readText(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

function normalizeRel(path: string): string {
  return path.split('\\').join('/');
}

function collectMaterialFiles(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [normalizeRel(rel)];
  const stat = statSync(abs);
  if (!stat.isDirectory()) return [normalizeRel(rel)];
  return readdirSync(abs)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((child) => collectMaterialFiles(root, join(rel, child)));
}

function readGitHead(root: string): string {
  const gitCwd = root;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2_000,
    }).trim();
  } catch {
    // probe: temporary projects or unpacked packages may not be git worktrees.
    return 'unknown';
  }
}

export function computeCodexAdapterMaterialSnapshot(root: string): CodexAdapterMaterialSnapshot {
  const files = Array.from(new Set(CODEX_MATERIAL_PATHS.flatMap((rel) => collectMaterialFiles(root, rel))))
    .sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const rel of files) {
    const abs = join(root, rel);
    hash.update(`path:${normalizeRel(rel)}\n`);
    if (!existsSync(abs)) {
      hash.update('missing\n');
      continue;
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      hash.update('dir\n');
      continue;
    }
    hash.update(readFileSync(abs));
    hash.update('\n');
  }
  return {
    headHash: readGitHead(root),
    materialHash: hash.digest('hex'),
    files,
  };
}

function push(
  checks: CodexAdapterCheck[],
  id: string,
  label: string,
  status: CodexAdapterCheckStatus,
  hard: boolean,
  detail: string,
  command?: string,
): void {
  checks.push({ id, label, status, hard, detail, ...(command ? { command } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface CodexManifestSelection {
  relPath: '.lattice-codex/lattice.json';
  brand: 'lattice';
}

function isGlobalThinProject(root: string): boolean {
  try {
    const configPath = [
      join(root, '.lattice', 'lattice.json'),
      join(root, '.Lattice', 'lattice.json'),
    ].find(candidate => existsSync(candidate));
    if (!configPath) return false;
    const text = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(text);
    return isRecord(parsed) && parsed['assetMode'] === 'global-thin';
  } catch {
    return false;
  }
}

function resolveCodexManifest(root: string): CodexManifestSelection | null {
  if (existsSync(join(root, '.lattice-codex', 'lattice.json'))) {
    return { relPath: '.lattice-codex/lattice.json', brand: 'lattice' };
  }
  return null;
}

function checkAgentAssetResolution(resolution: AgentAssetResolution, checks: CodexAdapterCheck[]): void {
  const hasLocalIssues = resolution.projectPromptAssets.some(asset =>
    asset.status === 'stale' || asset.status === 'override');
  const status: CodexAdapterCheckStatus = hasLocalIssues ? 'warn' : 'pass';
  const detail = `${summarizeAgentAssetResolution(resolution)}; ${resolution.authorityBoundary.text}`;
  push(checks, 'agent-asset-resolution', 'Codex agent asset resolution', status, false, detail);
}

function checkManifest(root: string, checks: CodexAdapterCheck[], resolution: AgentAssetResolution): CodexPromptMode | null {
  // Resolver priority: canonical .lattice/lattice.json first; legacy
  // .Lattice/lattice.json remains read-only compatible.
  if (isGlobalThinProject(root)) {
    push(checks, 'manifest', 'Codex manifest', 'pass', true, 'global-thin project: Codex adapter behavior runs from global lattice CLI (.lattice/lattice.json present)');
    return 'registry';
  }
  const selection = resolveCodexManifest(root);
  if (!selection) {
    if (resolution.mode === 'runtime-owned') {
      push(
        checks,
        'manifest',
        'Codex manifest',
        'pass',
        true,
        `runtime-owned default: .lattice-codex/lattice.json not required for package prompt registry (hash=${resolution.promptRegistryHash.slice(0, 12)})`,
      );
      return 'registry';
    }
    push(checks, 'manifest', 'Codex manifest', 'fail', true, 'missing .lattice-codex/lattice.json', LOCAL_INIT_VERIFY_COMMAND);
    return null;
  }
  const manifestPath = join(root, selection.relPath);
  const actual = readText(manifestPath);
  const expected = renderLatticeCodexAdapterManifest();
  const expectedIdentity = LATTICE_CODEX_ADAPTER_MANIFEST;
  let parsed: unknown;
  try {
    parsed = JSON.parse(actual);
  } catch {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} is not valid JSON`, LOCAL_INIT_VERIFY_COMMAND);
    return null;
  }
  if (!isRecord(parsed)) {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} is not a JSON object`, LOCAL_INIT_VERIFY_COMMAND);
    return null;
  }
  if (
    parsed?.adapterOwner !== expectedIdentity.adapterOwner ||
    parsed?.adapterKind !== expectedIdentity.adapterKind ||
    parsed?.activitySource !== expectedIdentity.activitySource
  ) {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} has invalid adapter identity`, LOCAL_INIT_VERIFY_COMMAND);
    return null;
  }
  if (parsed.promptMode === 'registry') {
    const expectedRegistry = promptRegistryManifest();
    const actualRegistry = parsed.promptRegistry;
    if (!isRecord(actualRegistry)) {
      push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} registry mode is missing promptRegistry metadata`, LOCAL_INIT_VERIFY_COMMAND);
      return 'registry';
    }
    const mismatches = (['schemaVersion', 'source', 'agentCount', 'materialHash'] as const)
      .filter(key => actualRegistry[key] !== expectedRegistry[key]);
    if (mismatches.length > 0) {
      push(
        checks,
        'manifest',
        'Codex manifest',
        'fail',
        true,
        `${selection.relPath} promptRegistry mismatch: ${mismatches.join(', ')}`,
        LOCAL_INIT_VERIFY_COMMAND,
      );
      return 'registry';
    }
    const expectedRegistryManifest = renderLatticeCodexAdapterManifest({ promptMode: 'registry' });
    if (actual !== expectedRegistryManifest) {
      push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} drifted from Lattice registry template`, LOCAL_INIT_VERIFY_COMMAND);
      return 'registry';
    }
    push(checks, 'manifest', 'Codex manifest', 'pass', true, `${selection.relPath} uses registry prompt mode (${expectedRegistry.agentCount} prompt(s), hash=${expectedRegistry.materialHash.slice(0, 12)})`);
    return 'registry';
  }
  if (parsed.promptMode !== undefined && parsed.promptMode !== 'legacy-mirror') {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} has unsupported promptMode=${String(parsed.promptMode)}`, LOCAL_INIT_VERIFY_COMMAND);
    return null;
  }
  if (actual !== expected) {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} drifted from Lattice template`, LOCAL_INIT_VERIFY_COMMAND);
    return 'legacy-mirror';
  }
  push(checks, 'manifest', 'Codex manifest', 'pass', true, `${selection.relPath} matches Lattice template`);
  return 'legacy-mirror';
}

function checkAgentMirror(root: string, checks: CodexAdapterCheck[]): void {
  const claudeDir = join(root, '.claude', 'agents');
  const codexDir = join(root, '.lattice-codex', 'agents');
  if (!existsSync(claudeDir) || !existsSync(codexDir)) {
    push(checks, 'agents-mirror', 'Codex agents mirror', 'fail', true, 'missing .claude/agents or .lattice-codex/agents', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  const sourceFiles = listAgentPromptFiles(claudeDir);
  const targetFiles = listAgentPromptFiles(codexDir);
  const targetSet = new Set(targetFiles);
  const sourceSet = new Set(sourceFiles);
  const issues: string[] = [];
  for (const file of sourceFiles) {
    const targetPath = join(codexDir, file);
    if (!targetSet.has(file)) {
      issues.push(`missing .lattice-codex/agents/${file}`);
      continue;
    }
    const expected = renderCodexAgentContent(readText(join(claudeDir, file))).trim();
    const actual = readText(targetPath).trim();
    if (expected !== actual) issues.push(`drift .lattice-codex/agents/${file}`);
  }
  for (const file of targetFiles) {
    if (!sourceSet.has(file)) issues.push(`stale .lattice-codex/agents/${file}`);
  }
  if (issues.length > 0) {
    push(checks, 'agents-mirror', 'Codex agents mirror', 'fail', true, issues.slice(0, 6).join('; '), LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  push(checks, 'agents-mirror', 'Codex agents mirror', 'pass', true, `${sourceFiles.length} prompt(s) mirrored`);
}

function checkPromptRegistry(checks: CodexAdapterCheck[]): void {
  try {
    const registry = readPromptRegistry();
    if (registry.agentCount === 0) {
      push(checks, 'prompt-registry', 'Codex prompt registry', 'fail', true, 'package prompt registry has no agent prompts', LOCAL_INIT_VERIFY_COMMAND);
      return;
    }
    const unrenderable = registry.agents
      .filter(entry => renderPromptEntryForHost(entry, 'codex').trim().length === 0)
      .map(entry => entry.file);
    if (unrenderable.length > 0) {
      push(checks, 'prompt-registry', 'Codex prompt registry', 'fail', true, `empty Codex render(s): ${unrenderable.slice(0, 6).join(', ')}`, LOCAL_INIT_VERIFY_COMMAND);
      return;
    }
    push(checks, 'prompt-registry', 'Codex prompt registry', 'pass', true, `${registry.agentCount} prompt(s) render from package registry; hash=${registry.materialHash.slice(0, 12)}`);
  } catch (e: any) {
    push(checks, 'prompt-registry', 'Codex prompt registry', 'fail', true, `registry read/render failed: ${e?.message || e}`, LOCAL_INIT_VERIFY_COMMAND);
  }
}

function checkExcludedAssets(root: string, checks: CodexAdapterCheck[]): void {
  const offenders = LATTICE_CODEX_ADAPTER_MANIFEST.excludedRuntimeAssets.filter(asset => existsSync(join(root, asset)));
  const upperHooks = join(root, '.lattice-codex', 'hooks');
  const lowerHooks = join(root, '.codex', 'hooks');
  if (existsSync(upperHooks)) {
    let isLowercaseAlias = false;
    try {
      if (existsSync(lowerHooks)) {
        const upper = statSync(upperHooks);
        const lower = statSync(lowerHooks);
        isLowercaseAlias = upper.dev === lower.dev && upper.ino === lower.ino;
      }
    } catch {
      isLowercaseAlias = false;
    }
    if (!isLowercaseAlias) offenders.push('.lattice-codex/hooks');
  }
  if (offenders.length > 0) {
    push(checks, 'excluded-assets', 'Codex runtime exclusions', 'fail', true, `unexpected asset(s): ${offenders.join(', ')}`, `rm -rf ${offenders.join(' ')}`);
    return;
  }
  push(checks, 'excluded-assets', 'Codex runtime exclusions', 'pass', true, 'no uppercase-only .lattice-codex/hooks or .lattice-codex/settings.json');
}

function hookEntriesContainCommand(entries: unknown, commandNeedle: string): boolean {
  return Array.isArray(entries) && entries.some((entry: any) =>
    Array.isArray(entry?.hooks)
    && entry.hooks.some((hook: any) => hook?.type === 'command' && String(hook?.command || '').includes(commandNeedle)));
}

function checkCodexNativeHooks(root: string, checks: CodexAdapterCheck[]): void {
  const hooksJsonPath = join(root, '.codex', 'hooks.json');
  const hookScriptPath = join(root, '.codex', 'hooks', 'lattice-scope-pretool.cjs');
  if (!existsSync(hooksJsonPath)) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, 'missing .codex/hooks.json with Lattice PreToolUse hook', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  if (!existsSync(hookScriptPath)) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, 'missing .codex/hooks/lattice-scope-pretool.cjs', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(hooksJsonPath));
  } catch {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, '.codex/hooks.json is not valid JSON', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, '.codex/hooks.json is missing hooks object', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  const preToolUse = parsed.hooks.PreToolUse;
  if (!Array.isArray(preToolUse)) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, '.codex/hooks.json hooks.PreToolUse is missing or not an array', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  const hasMatcher = preToolUse.some((entry: any) => {
    const matcher = String(entry?.matcher || '');
    return matcher === CODEX_PRETOOL_SCOPE_HOOK_MATCHER
      || (/apply_patch/.test(matcher) && /Edit|Write/.test(matcher));
  });
  if (!hasMatcher || !hookEntriesContainCommand(preToolUse, '.codex/hooks/lattice-scope-pretool.cjs')) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, '.codex/hooks.json does not wire lattice-scope-pretool.cjs for apply_patch/Edit/Write', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }

  const hookScript = readText(hookScriptPath);
  if (!/provider:\s*['"]codex['"]/.test(hookScript) || !hookScript.includes('prewrite_guard_check')) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, '.codex/hooks/lattice-scope-pretool.cjs does not delegate to prewrite_guard_check as provider=codex', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }

  push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'pass', true, '.codex/hooks.json wires apply_patch/Edit/Write to lattice-scope-pretool.cjs');
}

function activityFor(root: string, session: string, tool: string): Record<string, unknown> | null {
  return readActivityLogTail(root, 200)
    .find(entry => entry.session === session && entry.tool === tool) || null;
}

function runHeartbeat(
  root: string,
  checks: CodexAdapterCheck[],
  id: string,
  label: string,
  command: string,
  args: string[],
  session: string,
  expectedEntrypoint: string,
  timeoutMs: number,
  displayCommand?: string,
): void {
  const retryCommand = displayCommand || (
    id === 'local-wrapper-heartbeat'
      ? 'node bin/lattice-codex.js session_brief'
      : `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`
  );
  try {
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...process.env,
        LATTICE_ACTIVITY_SOURCE: id === 'local-wrapper-heartbeat' ? 'not-codex' : 'codex',
        LATTICE_ACTIVITY_RECORD_READONLY: '1',
        LATTICE_ACTIVITY_SESSION: session,
        LATTICE_CODEX_ENTRYPOINT: expectedEntrypoint,
      },
    });
  } catch (e: any) {
    push(checks, id, label, 'fail', true, `heartbeat command failed: ${e?.stderr?.toString?.().trim() || e?.message || e}`, retryCommand);
    return;
  }

  const record = activityFor(root, session, 'session_brief');
  if (!record) {
    push(checks, id, label, 'fail', true, `no activity heartbeat for session ${session}`, retryCommand);
    return;
  }
  if (record.source !== 'codex') {
    push(checks, id, label, 'fail', true, `activity source=${String(record.source)} expected codex`, retryCommand);
    return;
  }
  if (!record.entrypoint && expectedEntrypoint === 'global-fallback') {
    push(checks, id, label, 'pass', true, `source=codex session=${session}; installed global CLI has no entrypoint field yet`);
    return;
  }
  if (record.entrypoint !== expectedEntrypoint) {
    push(checks, id, label, 'fail', true, `entrypoint=${String(record.entrypoint)} expected ${expectedEntrypoint}`, retryCommand);
    return;
  }
  push(checks, id, label, 'pass', true, `source=codex session=${session} entrypoint=${expectedEntrypoint}`);
}

function isPackagedDesktopRuntime(): boolean {
  return process.env.LATTICE_DESKTOP_PACKAGED_RUNTIME === '1'
    || Boolean((process as typeof process & { pkg?: unknown }).pkg);
}

function localWrapperHeartbeatCommand(wrapperRelPath: string): { command: string; args: string[]; displayCommand: string } {
  return {
    command: process.execPath,
    args: [wrapperRelPath, 'session_brief'],
    displayCommand: `node ${wrapperRelPath} session_brief`,
  };
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
}

function resolveLatticeCommandPath(root: string): string | null {
  const command = process.platform === 'win32' ? 'where' : 'sh';
  const args = process.platform === 'win32' ? ['lattice'] : ['-lc', 'command -v lattice'];
  try {
    const out = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2_000,
      env: process.env,
    }).trim();
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch {
    // probe: PATH may not expose a global lattice; heartbeat execution reports the real failure.
    return null;
  }
}

function checkLocalWrapper(root: string, checks: CodexAdapterCheck[], executeHeartbeats: boolean, timeoutMs: number): void {
  // Global-thin projects: executable Codex adapter behavior lives in the global lattice CLI.
  // Local wrapper is not required regardless of whether legacy bin/ files exist.
  if (isGlobalThinProject(root)) {
    push(checks, 'local-wrapper', 'Local Codex wrapper', 'pass', true, 'global-thin project: local wrapper not required; use global lattice codex verify / lattice codex doctor');
    return;
  }
  const wrapperRelPath = 'bin/lattice-codex.js';
  const bootstrapRelPath = 'bin/lattice.js';
  const wrapper = join(root, wrapperRelPath);
  const localBootstrap = join(root, bootstrapRelPath);
  if (!existsSync(wrapper)) {
    push(checks, 'local-wrapper', 'Local Codex wrapper', 'fail', true, 'missing bin/lattice-codex.js', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  const text = readText(wrapper);
  const required = ['LATTICE_ACTIVITY_SOURCE', 'codex', 'LATTICE_ACTIVITY_RECORD_READONLY', 'LATTICE_CODEX_ENTRYPOINT'];
  const missing = required.filter(piece => !text.includes(piece));
  if (missing.length > 0) {
    push(checks, 'local-wrapper', 'Local Codex wrapper', 'fail', true, `wrapper missing ${missing.join(', ')}`, LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  if (!existsSync(localBootstrap)) {
    push(checks, 'local-wrapper', 'Local Codex wrapper', 'fail', true, `missing sibling ${bootstrapRelPath} local bootstrap`, LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  push(checks, 'local-wrapper', 'Local Codex wrapper', 'pass', true, `${wrapperRelPath} sets Codex activity env`);
  if (executeHeartbeats) {
    if (isPackagedDesktopRuntime()) {
      // pkg spawns process.execPath in Node-script mode, so there is no safe
      // external-node-free subprocess path for the ESM wrapper inside desktop builds.
      push(
        checks,
        'local-wrapper-heartbeat',
        'Local wrapper heartbeat',
        'pass',
        true,
        'packaged runtime uses embedded Lattice CLI; wrapper env contract verified without external Node',
      );
      return;
    }
    const heartbeat = localWrapperHeartbeatCommand(wrapperRelPath);
    runHeartbeat(
      root,
      checks,
      'local-wrapper-heartbeat',
      'Local wrapper heartbeat',
      heartbeat.command,
      heartbeat.args,
      `codex-check-local-${Date.now()}`,
      'local-wrapper',
      timeoutMs,
      heartbeat.displayCommand,
    );
  } else {
    push(checks, 'local-wrapper-heartbeat', 'Local wrapper heartbeat', 'warn', false, 'not executed in this diagnostic mode', `node ${wrapperRelPath} verify_codex`);
  }
}

function checkGlobalFallback(root: string, checks: CodexAdapterCheck[], executeHeartbeats: boolean, timeoutMs: number): void {
  if (!executeHeartbeats) {
    push(checks, 'global-fallback-heartbeat', 'Global fallback heartbeat', 'warn', false, 'not executed in this diagnostic mode', `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`);
    return;
  }
  if (isPackagedDesktopRuntime()) {
    push(
      checks,
      'global-fallback-heartbeat',
      'Global fallback heartbeat',
      'warn',
      false,
      'skipped in packaged desktop runtime; standalone binaries do not require a global lattice command',
      `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`,
    );
    return;
  }
  const currentCore = join(root, 'packages', 'main');
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2_000,
    }).trim();
    const globalCoreCandidates = [
      { path: join(globalRoot, '@lattice-agent', 'core'), label: '@lattice-agent/core' },
    ];
    const globalCore = globalCoreCandidates.find(candidate => existsSync(candidate.path));
    if (existsSync(currentCore) && globalCore) {
      const currentReal = realpathSync(currentCore);
      const globalReal = realpathSync(globalCore.path);
      const latticeCommand = resolveLatticeCommandPath(root);
      const latticeReal = latticeCommand && existsSync(latticeCommand) ? realpathSync(latticeCommand) : '';
      const actualLatticeUsesGlobalCore = !!latticeReal && pathContains(globalReal, latticeReal);
      if (actualLatticeUsesGlobalCore && currentReal !== globalReal) {
        push(
          checks,
          'global-fallback-heartbeat',
          'Global fallback heartbeat',
          'warn',
          false,
          `global ${globalCore.label} resolves to ${globalReal}, not current worktree ${currentReal}; treat global lattice as heartbeat-only, not current-worktree gate/status evidence`,
          resolveCodexSessionBriefCommand(root),
        );
        return;
      }
    }
  } catch {
    // probe: npm/global package lookup is best-effort; heartbeat below is the real check.
  }
  runHeartbeat(
    root,
    checks,
    'global-fallback-heartbeat',
    'Global fallback heartbeat',
    resolveLatticeCommandPath(root) ?? 'lattice',
    ['session_brief'],
    `codex-check-global-${Date.now()}`,
    'global-fallback',
    timeoutMs,
  );
}

function checkAuxAvailability(checks: CodexAdapterCheck[], registryNames?: Set<string>): void {
  if (!registryNames) {
    push(checks, 'aux-availability', 'Aux command availability', 'warn', false, 'registry not provided; run through lattice doctor for live command inventory');
    return;
  }
  if (!registryNames.has('aux_doc_list')) {
    push(checks, 'aux-availability', 'Aux command availability', 'warn', false, 'aux_doc_list is not registered; use local bootstrap or shell search fallback');
    return;
  }
  push(checks, 'aux-availability', 'Aux command availability', 'pass', false, 'aux_doc_list registered');
}

export function runCodexAdapterChecks(root: string, options: RunCodexChecksOptions = {}): CodexAdapterCheckResult {
  const checks: CodexAdapterCheck[] = [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const executeLocalHeartbeat = options.executeLocalHeartbeat ?? options.executeHeartbeats === true;
  const executeGlobalHeartbeat = options.executeGlobalHeartbeat ?? options.executeHeartbeats === true;
  const agentAssetResolution = resolveAgentAssetResolution(root);
  checkAgentAssetResolution(agentAssetResolution, checks);
  const promptMode = checkManifest(root, checks, agentAssetResolution);
  if (promptMode === 'registry') {
    checkPromptRegistry(checks);
  } else {
    checkAgentMirror(root, checks);
  }
  checkExcludedAssets(root, checks);
  checkCodexNativeHooks(root, checks);
  checkLocalWrapper(root, checks, executeLocalHeartbeat, timeoutMs);
  checkGlobalFallback(root, checks, executeGlobalHeartbeat, timeoutMs);
  checkAuxAvailability(checks, options.registryNames);

  const hardFailures = checks.filter(check => check.hard && check.status === 'fail');
  const materialSnapshot = computeCodexAdapterMaterialSnapshot(root);
  return {
    ok: hardFailures.length === 0,
    summary: hardFailures.length === 0
      ? `Codex adapter checks passed (${checks.filter(c => c.status === 'pass').length}/${checks.length} pass)`
      : `Codex adapter checks failed (${hardFailures.length} hard failure(s))`,
    checks,
    timestamp: new Date().toISOString(),
    materialSnapshot,
  };
}

export function renderCodexAdapterChecks(result: CodexAdapterCheckResult): string {
  const icons: Record<CodexAdapterCheckStatus, string> = { pass: '✓', warn: '!', fail: '✗' };
  const lines = [`${result.ok ? '✓' : '✗'} ${result.summary}`];
  for (const check of result.checks) {
    lines.push(`  [${icons[check.status]}] ${check.label}: ${check.detail}`);
    if (check.status !== 'pass' && check.command) lines.push(`      → ${check.command}`);
  }
  return lines.join('\n');
}

export function storyRequiresCodexEvidence(store: StoryStore, storyId: string): boolean {
  try {
    const story = store.readStory(storyId);
    const checklist = store.readChecklist(storyId);
    const haystack = [
      story.title,
      story.description,
      ...(story.riskSignals || []).flatMap(signal => [signal.category, signal.matched]),
      ...checklist.items.flatMap(item => [item.title, item.context || '', ...(item.relatedDocs || [])]),
    ].join('\n');
    return /\bCodex\b|\.lattice-codex|lattice-codex|codex adapter|verify_codex/i.test(haystack);
  } catch {
    return false;
  }
}

export function latestCodexVerificationEvent(store: StoryStore, storyId: string): ProcessEvent | null {
  try {
    const events = store.readProcessEvents(storyId)
      .filter(event => event.type === 'codex_adapter_verification');
    return events[events.length - 1] || null;
  } catch {
    return null;
  }
}

export function summarizeCodexEvidence(store: StoryStore, storyId: string, root?: string): {
  status: 'not-required' | 'missing' | 'failing' | 'stale' | 'passing';
  detail: string;
  command?: string;
} {
  if (!storyRequiresCodexEvidence(store, storyId)) {
    return { status: 'not-required', detail: 'story does not touch Codex adapter surfaces' };
  }
  const resolvedCommand = root ? resolveLocalCodexVerifyCommand(root) : LOCAL_CODEX_VERIFY_COMMAND;
  const event = latestCodexVerificationEvent(store, storyId);
  if (!event) {
    return {
      status: 'missing',
      detail: 'no codex_adapter_verification process-event recorded',
      command: resolvedCommand,
    };
  }
  if (event.result !== 'pass') {
    return {
      status: 'failing',
      detail: String(event.summary || `latest ${resolvedCommand} failed`),
      command: resolvedCommand,
    };
  }
  if (root) {
    const current = computeCodexAdapterMaterialSnapshot(root);
    const eventMaterialHash = typeof event.materialHash === 'string' ? event.materialHash : '';
    if (!eventMaterialHash) {
      return {
        status: 'stale',
        detail: 'latest codex_adapter_verification lacks a material hash snapshot',
        command: resolvedCommand,
      };
    }
    if (eventMaterialHash !== current.materialHash) {
      return {
        status: 'stale',
        detail: `material changed since verification (${eventMaterialHash.slice(0, 12)} != ${current.materialHash.slice(0, 12)})`,
        command: resolvedCommand,
      };
    };
  }
  return {
    status: 'passing',
    detail: String(event.summary || `${resolvedCommand} passed at ${event.timestamp}`),
  };
}
