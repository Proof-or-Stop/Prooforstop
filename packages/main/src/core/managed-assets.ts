import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_MD_GLOBAL_THIN_TEMPLATE,
  AGENTS_MD_TEMPLATE,
  CLAUDE_MD_TEMPLATE,
  LATTICE_DOT_DIR_MD_TEMPLATE,
  LATTICE_MD_TEMPLATE,
  getCodexHooks,
  getClaudeHooks,
  codexHookCommand,
  hookCommand,
  LEGACY_SCOPE_PRETOOL_HOOK_FILE,
  LATTICE_SCOPE_PRETOOL_HOOK_FILE,
  listAgentPromptFiles,
  migrateHookCommandEntries,
  renderCodexAgentContent,
  renderCodexHooksJson,
  renderCodexPretoolScopeHookScript,
  renderCodexReadmeTemplate,
  renderLatticeBootstrapScript,
  renderLatticeCodexAdapterManifest,
  renderLatticeCodexWrapperScript,
  renderLatticeProjectConfig,
  type InitAssetMode,
  type InitProfile,
} from '../init-assets.js';
import {
  LATTICE_RUNTIME_IGNORE_BLOCK_END,
  LATTICE_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from './runtime-artifact-registry.js';
import { listManagedAgentBasenames, resolveAgentTemplateDir } from './global-agents.js';

export type ManagedAssetStatus =
  | 'OK'
  | 'MISSING'
  | 'CASE_MISMATCH'
  | 'STALE_SAFE'
  | 'STALE_LOCAL_EDIT'
  | 'INCOMPATIBLE';

export type ManagedAssetKind =
  | 'managed-block'
  | 'whole-file'
  | 'gitignore-runtime'
  | 'claude-settings'
  | 'codex-hooks'
  | 'excluded-path'
  | 'remove-extra';

export interface ManagedAssetCheckOptions {
  apply?: boolean;
  upgrade?: boolean;
  reviewLocalEdits?: boolean;
  profile?: InitProfile;
  assetMode?: InitAssetMode;
}

export interface ManagedAssetCheckItem {
  id: string;
  relPath: string;
  kind: ManagedAssetKind;
  status: ManagedAssetStatus;
  expectedHash?: string;
  actualHash?: string;
  actualRelPath?: string;
  reason: string;
  action: string;
  applied?: boolean;
}

export interface ManagedAssetCheckResult {
  ok: boolean;
  profile: InitProfile;
  assetMode: InitAssetMode;
  mode: 'check' | 'apply' | 'upgrade';
  applied: string[];
  warnings: string[];
  summary: Record<ManagedAssetStatus, number>;
  items: ManagedAssetCheckItem[];
  localEditReviews?: ManagedAssetLocalEditReview[];
  manifestPath: string;
}

export interface ManagedAssetLocalEditReview {
  relPath: string;
  kind: ManagedAssetKind;
  status: 'STALE_LOCAL_EDIT';
  currentLines: number;
  expectedLines: number;
  currentHeadings: string[];
  expectedHeadings: string[];
  localOnlyHeadings: string[];
  templateOnlyHeadings: string[];
  recommendation: string;
}

export interface ManagedAssetDefinition {
  id: string;
  relPath: string;
  kind: ManagedAssetKind;
  expectedContent?: string;
  executable?: boolean;
  ownedWhen?: (actual: string) => boolean;
  okWhen?: (actual: string, root: string) => boolean;
}

interface ManagedAssetManifest {
  version: 1;
  profile: InitProfile;
  assetMode?: InitAssetMode;
  generatedAt: string;
  assets: Record<string, {
    relPath: string;
    templateHash?: string;
    contentHash?: string;
    updatedAt: string;
  }>;
}

type ManagedAssetPathKind = 'missing' | 'file' | 'directory' | 'other' | 'case-mismatch';
interface ManagedAssetPathInfo {
  kind: ManagedAssetPathKind;
  actualRelPath?: string;
}

const MANIFEST_REL_PATH = '.lattice/managed-assets.json';
const INIT_DOC_SECTION_RE = /<!--\s*(?:koala|lattice):start\s*-->[\s\S]*?<!--\s*(?:koala|lattice):end\s*-->/;
const LEGACY_INTERNAL_SECTION_RE = /<!--\s*koala:internal:start\s*-->[\s\S]*?<!--\s*koala:internal:end\s*-->\n?/g;

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function agentTemplateDir(root = packageRoot()): string | null {
  return [
    join(root, 'templates', 'agents'),
    join(root, '..', '..', '.claude', 'agents'),
  ].find(existsSync) ?? null;
}

function hookTemplateDir(root = packageRoot()): string | null {
  const dir = join(root, '..', '..', '.claude', 'hooks');
  return existsSync(dir) ? dir : null;
}

function normalizeContent(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function findCaseVariant(root: string, relPath: string): string | null {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  let current = root;
  const actualParts: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      // PROBE: missing or unreadable parent means there is no reliable case variant.
      return null;
    }
    if (entries.includes(part)) {
      actualParts.push(part);
      current = join(current, part);
      continue;
    }
    const variant = entries.find(entry => entry.toLowerCase() === part.toLowerCase());
    if (!variant) return null;
    return [...actualParts, variant, ...parts.slice(index + 1)].join('/');
  }
  return null;
}

function managedAssetPathInfo(root: string, relPath: string): ManagedAssetPathInfo {
  const caseVariant = findCaseVariant(root, relPath);
  if (caseVariant && existsSync(join(root, caseVariant))) {
    return { kind: 'case-mismatch', actualRelPath: caseVariant };
  }
  const full = join(root, relPath);
  if (!existsSync(full)) return { kind: 'missing' };
  try {
    const entry = lstatSync(full);
    const stats = entry.isSymbolicLink() ? statSync(full) : entry;
    if (stats.isFile()) return { kind: 'file' };
    if (stats.isDirectory()) return { kind: 'directory' };
    return { kind: 'other' };
  } catch {
    // PROBE: filesystem races should be reported as missing/other by the next check run.
    return { kind: 'other' };
  }
}

function managedAssetPathKind(root: string, relPath: string): ManagedAssetPathKind {
  return managedAssetPathInfo(root, relPath).kind;
}

function isCodexCaseInsensitiveAlias(root: string, relPath: string, actualRelPath?: string): boolean {
  if (!relPath.startsWith('.codex/') || !actualRelPath?.startsWith('.Codex/')) return false;
  try {
    const lower = statSync(join(root, relPath));
    const upper = statSync(join(root, actualRelPath));
    return lower.dev === upper.dev && lower.ino === upper.ino;
  } catch {
    return false;
  }
}

function readText(root: string, relPath: string): string | null {
  const full = join(root, relPath);
  const pathInfo = managedAssetPathInfo(root, relPath);
  if (pathInfo.kind !== 'file') {
    const actualRelPath = pathInfo.actualRelPath;
    if (pathInfo.kind === 'case-mismatch' && actualRelPath && isCodexCaseInsensitiveAlias(root, relPath, actualRelPath)) {
      const aliasFull = join(root, actualRelPath);
      try {
        if (statSync(aliasFull).isFile()) return readFileSync(aliasFull, 'utf-8');
      } catch {
        return null;
      }
    }
    return null;
  }
  return readFileSync(full, 'utf-8');
}

function writeText(root: string, relPath: string, content: string, executable = false): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, normalizeContent(content));
  if (executable) chmodSync(full, 0o755);
}

function removeGeneratedFileIfExact(root: string, relPath: string, expectedContent: string, ownedWhen?: (actual: string) => boolean): void {
  const actual = readText(root, relPath);
  if (actual === null) return;
  if (normalizeContent(actual) !== normalizeContent(expectedContent) && !ownedWhen?.(actual)) return;
  unlinkSync(join(root, relPath));
}

function removeLegacyScopePretoolHookIfGenerated(root: string, host: 'claude' | 'codex'): void {
  if (host === 'codex') {
    removeGeneratedFileIfExact(
      root,
      `.codex/hooks/${LEGACY_SCOPE_PRETOOL_HOOK_FILE}`,
      renderCodexPretoolScopeHookScript(),
      actual => actual.includes("provider: 'codex'") && actual.includes('prewrite_guard_check'),
    );
    return;
  }

  const hooks = hookTemplateDir();
  const template = hooks ? join(hooks, LATTICE_SCOPE_PRETOOL_HOOK_FILE) : '';
  if (!template || !existsSync(template)) return;
  removeGeneratedFileIfExact(
    root,
    `.claude/hooks/${LEGACY_SCOPE_PRETOOL_HOOK_FILE}`,
    readFileSync(template, 'utf-8'),
    actual => actual.includes("provider: 'claude'") && actual.includes('prewrite_guard_check'),
  );
}

function extractManagedSection(content: string): string {
  const match = content.match(INIT_DOC_SECTION_RE);
  if (!match) return normalizeContent(content);
  return match[0].replace(LEGACY_INTERNAL_SECTION_RE, '');
}

function hasManagedMarkers(content: string): boolean {
  return INIT_DOC_SECTION_RE.test(content);
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { /* PROBE: malformed JSON means this asset cannot prove managed ownership. */ return null; }
}

function gitLines(root: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    // PROBE: non-git projects or unavailable git should not block managed asset checks.
    return [];
  }
}

function collectApplyWarnings(root: string): string[] {
  const warnings: string[] = [];
  const dirty = gitLines(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (dirty.length > 0) {
    const sample = dirty.slice(0, 5).map(line => line.replace(/\s+/g, ' ')).join('; ');
    const suffix = dirty.length > 5 ? '; ...' : '';
    warnings.push(`working tree already has ${dirty.length} dirty path(s); managed asset sync will be mixed into the existing diff (${sample}${suffix})`);
  }

  const branch = gitLines(root, ['rev-parse', '--abbrev-ref', 'HEAD'])[0] ?? '';
  if (branch.startsWith('story/')) {
    warnings.push(`current branch is ${branch}; prefer syncing managed assets in a dedicated maintenance commit before REVIEW/TEST/DONE gates`);
  }

  const worktreeLines = gitLines(root, ['worktree', 'list', '--porcelain']);
  const storyBranches = worktreeLines
    .filter(line => line.startsWith('branch refs/heads/story/'))
    .map(line => line.slice('branch refs/heads/'.length));
  if (storyBranches.length > 0) {
    warnings.push(`registered active story worktree(s) detected: ${storyBranches.join(', ')}; new agents will see upgraded prompts after sync, already-running agents will not`);
  }

  return warnings;
}

function isManagedPrompt(actual: string, file: string): boolean {
  const base = file.replace(/\.md$/, '');
  return actual.includes('<!-- lattice:start -->')
    || actual.includes(`name: ${base}`)
    || actual.includes('name: koala-')
    || actual.includes('Koala');
}

function isGeneratedLegacyKoalaAgentPrompt(actual: string, file: string): boolean {
  return /^koala-[^/\\]+\.md$/.test(file)
    && (actual.includes('<!-- lattice:start -->')
      || actual.includes('<!-- lattice:start-slot -->')
      || /^\s*name:\s*koala-/m.test(actual));
}

function hasHookCommand(entries: unknown, command: string): boolean {
  return Array.isArray(entries) && entries.some((entry: any) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook: any) => hook?.type === 'command' && hook?.command === command));
}

function mergeClaudeHooks(existing: any): { updated: any; changed: boolean; incompatible: string[] } {
  const claudeHooks = getClaudeHooks();
  const updated = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const hooks = updated.hooks && typeof updated.hooks === 'object' && !Array.isArray(updated.hooks)
    ? { ...updated.hooks }
    : {};
  const incompatible: string[] = [];
  let changed = !updated.hooks;

  for (const [event, eventHooks] of Object.entries(claudeHooks)) {
    const command = eventHooks[0]?.hooks?.[0]?.command;
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
      hookCommand(LEGACY_SCOPE_PRETOOL_HOOK_FILE),
      command || '',
    );
    if (migrated.changed) {
      hooks[event] = migrated.entries;
      changed = true;
    }
    if (command && !hasHookCommand(hooks[event], command)) {
      hooks[event] = [...hooks[event], ...eventHooks];
      changed = true;
    }
  }
  updated.hooks = hooks;
  return { updated, changed, incompatible };
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
    const command = eventHooks[0]?.hooks?.[0]?.command;
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
      command || '',
    );
    if (migrated.changed) {
      hooks[event] = migrated.entries;
      changed = true;
    }
    if (command && !hasHookCommand(hooks[event], command)) {
      hooks[event] = [...hooks[event], ...eventHooks];
      changed = true;
    }
  }
  updated.hooks = hooks;
  return { updated, changed, incompatible };
}

function runtimeIgnoreMissing(existing: string | null): string[] {
  if (!existing) return listRuntimeArtifactIgnorePatterns();
  const present = new Set(existing.split('\n').map(line => line.trim()).filter(Boolean));
  return listRuntimeArtifactIgnorePatterns().filter(line => !present.has(line));
}

function renderManagedRuntimeIgnoreBlock(lines: string[]): string {
  return [
    LATTICE_RUNTIME_IGNORE_BLOCK_START,
    ...lines,
    LATTICE_RUNTIME_IGNORE_BLOCK_END,
  ].join('\n');
}

// B-854c CHK-003: exported so `lattice doctor --repair` can reuse the SAME
// idempotent append-only allowlist merge (BLOCK_START/END markers, dedupes via
// runtimeIgnoreMissing) instead of hand-rolling a second allowlist. A second
// merge over already-merged content is a no-op (missing.length === 0).
export function mergeRuntimeGitignore(existing: string | null): string {
  const missing = runtimeIgnoreMissing(existing);
  if (missing.length === 0) return existing ?? '';
  const base = (existing ?? '').replace(/\s+$/, '');
  const separator = base.length === 0 ? '' : '\n\n';
  return `${base}${separator}${renderManagedRuntimeIgnoreBlock(missing)}\n`;
}

// B-854c CHK-003: exported so doctor can detect whether the managed allowlist is
// already fully present (missing.length === 0 → safe, repair is a no-op).
export { runtimeIgnoreMissing };

export function detectManagedAssetProfile(root: string): InitProfile {
  const agents = readText(root, 'AGENTS.md');
  const claude = readText(root, 'CLAUDE.md');
  const hasCodex = Boolean(
    (agents && hasManagedMarkers(agents))
      || existsSync(join(root, '.Codex', 'lattice.json'))
      || existsSync(join(root, '.Codex', 'agents'))
      || existsSync(join(root, 'bin', 'lattice-codex.js'))
  );
  const hasClaude = Boolean(
    (claude && hasManagedMarkers(claude))
      || existsSync(join(root, '.claude', 'agents'))
      || existsSync(join(root, '.claude', 'hooks'))
      || existsSync(join(root, '.claude', 'skills', 'koala')),
  );
  if (hasCodex && hasClaude) return 'all';
  if (hasCodex) return 'codex';
  if (hasClaude) return 'claude';
  return 'core';
}

export function detectManagedAssetMode(root: string): InitAssetMode {
  const globalThinConfig = ['.lattice/lattice.json', '.Lattice/lattice.json']
    .find(relPath => existsSync(join(root, relPath)));
  if (globalThinConfig) {
    const text = readText(root, globalThinConfig);
    if (text?.includes('global-thin')) return 'global-thin';
  }
  if (existsSync(join(root, '.Codex', 'lattice.json')) || existsSync(join(root, '.Codex', 'agents'))) {
    return 'full';
  }
  if (existsSync(join(root, 'bin', 'lattice.js'))) {
    return 'full';
  }
  // Legacy full-mode: KOALA.md or LATTICE.md presence (any casing) implies non-global-thin project
  try {
    const lcNames = readdirSync(root).map(e => e.toLowerCase());
    if (lcNames.includes('koala.md') || lcNames.includes('lattice.md')) return 'full';
  } catch {}
  return 'global-thin';
}

function loadManifest(root: string): ManagedAssetManifest | null {
  const text = readText(root, MANIFEST_REL_PATH);
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as ManagedAssetManifest;
}

function managedDoc(
  id: string,
  relPath: string,
  expectedContent: string,
  ownedWhen: (actual: string) => boolean,
  okWhen?: (actual: string, root: string) => boolean,
): ManagedAssetDefinition {
  return { id, relPath, kind: 'managed-block', expectedContent, ownedWhen, okWhen };
}

function wholeFile(
  id: string,
  relPath: string,
  expectedContent: string,
  ownedWhen: (actual: string) => boolean,
  executable = false,
  okWhen?: (actual: string, root: string) => boolean,
): ManagedAssetDefinition {
  return { id, relPath, kind: 'whole-file', expectedContent, ownedWhen, executable, okWhen };
}

function isKoalaSelfRepoBootstrap(actual: string, root: string): boolean {
  if (!actual.includes("import { runLocalBootstrap } from './bootstrap-runner.js'")) return false;
  if (!actual.includes('runLocalBootstrap();')) return false;
  const bootstrap = readText(root, 'bin/bootstrap-runner.js');
  if (!bootstrap?.includes('export async function runLocalBootstrap()')) return false;
  return managedAssetPathKind(root, 'packages/main/src/init-assets.ts') === 'file'
    && managedAssetPathKind(root, 'packages/main/src/core/managed-assets.ts') === 'file';
}

function isExpandedLatticeAgentsGuide(actual: string): boolean {
  const currentLattice = actual.includes('# AGENTS.md')
    && actual.includes('Current lifecycle override')
    && actual.includes('lattice session_brief')
    && actual.includes('\u6d41\u7a0b\u4e8b\u5b9e\u53cc\u5c42\u5951\u7ea6')
    && actual.includes('Story \u9636\u6bb5\u6d41\u8f6c')
    && actual.includes('Fail-fast policy');
  const english = actual.includes('# AGENTS.md')
    && actual.includes('Current lifecycle override')
    && actual.includes('lattice session_brief')
    && actual.includes('Two-Layer Process Fact Contract')
    && actual.includes('Story Phase Transitions')
    && actual.includes('Fail-fast policy');
  const legacyChinese = actual.includes('# AGENTS.md')
    && actual.includes('lattice session_brief')
    && actual.includes('\u6d41\u7a0b\u4e8b\u5b9e\u53cc\u5c42\u5951\u7ea6')
    && actual.includes('Story \u9636\u6bb5\u6d41\u8f6c')
    && actual.includes('Fail-fast policy');
  return currentLattice || english || legacyChinese;
}

function isExpandedLatticeOverview(actual: string): boolean {
  const english = actual.includes('# Koala Module Classification and Flow')
    && actual.includes('project execution and verification substrate')
    && actual.includes('verificationIntent')
    && actual.includes('verificationEvidence')
    && actual.includes('Story Flow Master Table')
    && actual.includes('Definition of Done');
  const legacyChinese = actual.includes('# Koala \u6a21\u5757\u5206\u7c7b\u4e0e\u6d41\u7a0b')
    && actual.includes('project execution and verification substrate')
    && actual.includes('verificationIntent')
    && actual.includes('verificationEvidence')
    && actual.includes('Story \u6d41\u7a0b\u603b\u8868')
    && actual.includes('\u5b8c\u6210\u5b9a\u4e49');
  return english || legacyChinese;
}

function isExpandedLatticeClaudeGuide(actual: string): boolean {
  const english = actual.includes('# CLAUDE.md')
    && actual.includes('lattice session_brief')
    && actual.includes('REVIEW→TEST')
    && actual.includes('Claude Prompt Hook')
    && actual.includes('Reviewer opt-in')
    && actual.includes('Framework Introspection audit Configuration');
  const legacyChinese = actual.includes('# CLAUDE.md')
    && actual.includes('lattice session_brief')
    && actual.includes('REVIEW→TEST')
    && actual.includes('Claude Prompt Hook')
    && actual.includes('Reviewer opt-in')
    && actual.includes('\u6846\u67b6\u81ea\u7701 audit \u914d\u7f6e');
  return english || legacyChinese;
}

function appendLegacyRuntimeExclusions(defs: ManagedAssetDefinition[]): void {
  defs.push(
    { id: 'excluded:bin/koala.js', relPath: 'bin/koala.js', kind: 'excluded-path' },
    { id: 'excluded:bin/koala-codex.js', relPath: 'bin/koala-codex.js', kind: 'excluded-path' },
    { id: 'excluded:.Codex/koala.json', relPath: '.Codex/koala.json', kind: 'excluded-path' },
    { id: 'excluded:.codex/koala.json', relPath: '.codex/koala.json', kind: 'excluded-path' },
  );
}

export function listManagedAssetDefinitions(
  profile: InitProfile,
  root = packageRoot(),
  projectRoot = process.cwd(),
  assetMode: InitAssetMode = 'full',
): ManagedAssetDefinition[] {
  const isGlobalThin = assetMode === 'global-thin';
  // Global-thin: canonical assets live in .lattice/. No local bin shims.
  if (isGlobalThin) {
    const defs: ManagedAssetDefinition[] = [
      managedDoc(
        'doc:.lattice/Lattice.md',
        '.lattice/Lattice.md',
        LATTICE_DOT_DIR_MD_TEMPLATE,
        actual => actual.includes('.lattice/Lattice.md') || actual.includes('lattice codex verify'),
      ),
      wholeFile(
        '.lattice:lattice.json',
        '.lattice/lattice.json',
        renderLatticeProjectConfig(),
        actual => actual.includes('"assetMode"') && actual.includes('global-thin'),
        false,
        actual => {
          try {
            const parsed = safeJsonParse(actual);
            return Boolean(
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              && (parsed as Record<string, unknown>)['assetMode'] === 'global-thin'
              && (parsed as Record<string, unknown>)['latticeVersion'] === 1,
            );
          } catch { return false; }
        },
      ),
      { id: 'gitignore:runtime-artifacts', relPath: '.gitignore', kind: 'gitignore-runtime' },
    ];
    const wantsCodex = profile === 'codex' || profile === 'all';
    const wantsClaude = profile === 'claude' || profile === 'all';
    if (wantsCodex || profile === 'core') {
      defs.push(
        managedDoc(
          'doc:AGENTS.md',
          'AGENTS.md',
          AGENTS_MD_GLOBAL_THIN_TEMPLATE,
          actual => actual.includes('.lattice/Lattice.md') || actual.includes('lattice codex verify'),
        ),
      );
    }
    if (wantsCodex) {
      defs.push(
        { id: '.codex:hooks.json', relPath: '.codex/hooks.json', kind: 'codex-hooks' },
        wholeFile(
          '.codex/hooks:lattice-scope-pretool.cjs',
          '.codex/hooks/lattice-scope-pretool.cjs',
          renderCodexPretoolScopeHookScript(),
          actual => actual.includes('Codex PreToolUse hook') && actual.includes('prewrite_guard_check'),
          true,
        ),
      );
    }
    if (wantsClaude) {
      defs.push(
        managedDoc(
          'doc:CLAUDE.md',
          'CLAUDE.md',
          CLAUDE_MD_TEMPLATE,
          actual => actual.includes('Koala For Claude Code') || actual.includes('Claude Code subagents 位于'),
          actual => isExpandedLatticeClaudeGuide(actual),
        ),
        { id: '.claude:settings.json', relPath: '.claude/settings.json', kind: 'claude-settings' },
      );
    }
    appendLegacyRuntimeExclusions(defs);
    return defs;
  }

  const defs: ManagedAssetDefinition[] = [
    managedDoc(
      'doc:LATTICE.md',
      'LATTICE.md',
      LATTICE_MD_TEMPLATE,
      actual => actual.includes('canonical, host-neutral') || actual.includes('New init profile'),
      actual => isExpandedLatticeOverview(actual),
    ),
    wholeFile(
      'bin:lattice.js',
      'bin/lattice.js',
      renderLatticeBootstrapScript(root),
      actual => actual.includes('coreCliEngineCandidates') && actual.includes('runCli'),
      true,
      isKoalaSelfRepoBootstrap,
    ),
    { id: 'gitignore:runtime-artifacts', relPath: '.gitignore', kind: 'gitignore-runtime' },
  ];
  appendLegacyRuntimeExclusions(defs);

  const wantsCodex = profile === 'codex' || profile === 'all';
  const wantsClaude = profile === 'claude' || profile === 'all';
  const templates = agentTemplateDir(root);

  if (wantsCodex) {
    defs.push(
      managedDoc(
        'doc:AGENTS.md',
        'AGENTS.md',
        AGENTS_MD_TEMPLATE,
        actual => actual.includes('Codex / AGENTS') || actual.includes('Codex subagent prompts are located at'),
        actual => isExpandedLatticeAgentsGuide(actual),
      ),
      wholeFile(
        'bin:lattice-codex.js',
        'bin/lattice-codex.js',
        renderLatticeCodexWrapperScript(),
        actual => actual.includes('LATTICE_ACTIVITY_SOURCE') && actual.includes('local-wrapper'),
        true,
      ),
      wholeFile(
        '.Codex:README.md',
        '.Codex/README.md',
        renderCodexReadmeTemplate(assetMode, 'lattice'),
        actual => actual.includes('Codex + Koala') || actual.includes('Codex + Lattice'),
      ),
      wholeFile(
        '.Codex:lattice.json',
        '.Codex/lattice.json',
        renderLatticeCodexAdapterManifest(assetMode === 'thin' ? { promptMode: 'registry' } : {}),
        () => true,
      ),
      { id: '.codex:hooks.json', relPath: '.codex/hooks.json', kind: 'codex-hooks' },
      wholeFile(
        '.codex/hooks:lattice-scope-pretool.cjs',
        '.codex/hooks/lattice-scope-pretool.cjs',
        renderCodexPretoolScopeHookScript(),
        actual => actual.includes('Codex PreToolUse hook') && actual.includes('prewrite_guard_check'),
        true,
      ),
      { id: 'excluded:.Codex/settings.json', relPath: '.Codex/settings.json', kind: 'excluded-path' },
    );
    if (assetMode === 'full' && templates) {
      const files = listAgentPromptFiles(templates);
      for (const file of files) {
        const content = readFileSync(join(templates, file), 'utf-8');
        defs.push(wholeFile(
          `.Codex/agents:${file}`,
          `.Codex/agents/${file}`,
          renderCodexAgentContent(content),
          actual => isManagedPrompt(actual, file),
        ));
      }
    }
  }

  if (wantsClaude) {
    defs.push(
      managedDoc(
        'doc:CLAUDE.md',
        'CLAUDE.md',
        CLAUDE_MD_TEMPLATE,
        actual => actual.includes('Koala For Claude Code') || actual.includes('Claude Code subagents are located at'),
        actual => isExpandedLatticeClaudeGuide(actual),
      ),
      { id: '.claude:settings.json', relPath: '.claude/settings.json', kind: 'claude-settings' },
    );
    if (templates) {
      const expected = new Set(listAgentPromptFiles(templates));
      for (const file of expected) {
        const content = readFileSync(join(templates, file), 'utf-8');
        defs.push(wholeFile(
          `.claude/agents:${file}`,
          `.claude/agents/${file}`,
          content,
          actual => isManagedPrompt(actual, file),
        ));
      }
      if (existsSync(join(projectRoot, '.claude', 'agents'))) {
        for (const file of listAgentPromptFiles(join(projectRoot, '.claude', 'agents'))) {
          if (expected.has(file) || !/^koala-[^/\\]+\.md$/.test(file)) continue;
          defs.push({
            id: `.claude/agents:legacy-koala-extra:${file}`,
            relPath: `.claude/agents/${file}`,
            kind: 'remove-extra',
            ownedWhen: actual => isGeneratedLegacyKoalaAgentPrompt(actual, file),
          });
        }
      }
    }
    const hooks = hookTemplateDir(root);
    if (hooks) {
      for (const file of readdirSync(hooks).filter(file => file.endsWith('.cjs')).sort()) {
        const content = readFileSync(join(hooks, file), 'utf-8');
        defs.push(wholeFile(
          `.claude/hooks:${file}`,
          `.claude/hooks/${file}`,
          content,
          actual => actual.includes('koala') || actual.includes('KOALA'),
        ));
      }
    }
  }

  if (wantsCodex && assetMode === 'full' && templates && existsSync(join(projectRoot, '.Codex', 'agents'))) {
    const expected = new Set(listAgentPromptFiles(templates));
    for (const file of listAgentPromptFiles(join(projectRoot, '.Codex', 'agents'))) {
      if (!expected.has(file)) {
        defs.push({ id: `.Codex/agents:extra:${file}`, relPath: `.Codex/agents/${file}`, kind: 'remove-extra' });
      }
    }
  }

  return defs;
}

function evaluateDefinition(root: string, def: ManagedAssetDefinition, manifest: ManagedAssetManifest | null): ManagedAssetCheckItem {
  const pathInfo = managedAssetPathInfo(root, def.relPath);
  const pathKind = pathInfo.kind;
  const actual = readText(root, def.relPath);
  const expected = def.expectedContent ? normalizeContent(def.expectedContent) : undefined;
  const expectedHash = expected ? sha256(expected) : undefined;
  const actualHash = actual === null ? undefined : sha256(actual);
  const manifestEntry = manifest?.assets?.[def.id];

  const codexCaseAlias = pathKind === 'case-mismatch'
    && isCodexCaseInsensitiveAlias(root, def.relPath, pathInfo.actualRelPath);
  if (pathKind === 'case-mismatch' && !codexCaseAlias) {
    return {
      id: def.id,
      relPath: def.relPath,
      kind: def.kind,
      status: 'CASE_MISMATCH',
      expectedHash,
      actualRelPath: pathInfo.actualRelPath,
      reason: `managed asset path exists with different case (${pathInfo.actualRelPath}), expected exact path ${def.relPath}`,
      action: 'rename the path with exact casing or merge it manually before running lattice check --apply/--upgrade',
    };
  }

  if (def.kind === 'excluded-path') {
    if (pathKind === 'missing') {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', reason: 'excluded runtime asset is absent', action: 'none' };
    }
    const found = pathKind === 'file' ? 'file' : pathKind === 'directory' ? 'directory' : 'non-file path';
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: `Lattice runtime must not use this excluded asset path (found ${found})`, action: 'fix manually: remove it if it is not user-owned' };
  }

  if (def.kind === 'remove-extra') {
    if (pathKind === 'missing') {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', reason: 'extra generated prompt already absent', action: 'none' };
    }
    if (pathKind !== 'file') {
      const found = pathKind === 'directory' ? 'directory' : 'non-file path';
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', reason: `stale generated prompt path is a ${found}`, action: 'fix manually: remove it if it is generated by Lattice' };
    }
    if (def.ownedWhen && actual !== null && !def.ownedWhen(actual)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'legacy Koala-named prompt is not recognized as generated by Lattice; preserving it', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Codex agent mirror contains a prompt no longer present in managed templates', action: 'remove generated stale prompt' };
  }

  if (pathKind === 'directory' || pathKind === 'other') {
    const found = pathKind === 'directory' ? 'directory' : 'non-file path';
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', expectedHash, reason: `managed asset path is a ${found}, expected a file`, action: 'fix manually: replace or remove the path before running lattice check --apply/--upgrade' };
  }

  if (def.kind === 'gitignore-runtime') {
    const missing = runtimeIgnoreMissing(actual);
    if (missing.length === 0) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'runtime artifact ignore policy is present', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: `missing runtime ignore pattern(s): ${missing.join(', ')}`, action: 'merge managed runtime ignore block' };
  }

  if (def.kind === 'claude-settings') {
    if (actual === null) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', reason: 'Claude hook settings are missing', action: 'create settings with Lattice hooks' };
    }
    const parsed = safeJsonParse(actual);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: 'settings.json is not a JSON object', action: 'fix manually: repair settings.json as a JSON object' };
    }
    const merged = mergeClaudeHooks(parsed);
    if (merged.incompatible.length > 0) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: `hook event(s) have incompatible shape: ${merged.incompatible.join(', ')}`, action: 'fix manually: repair hook array shape' };
    }
    if (!merged.changed) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'Lattice Claude hooks are present', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Lattice Claude hooks are missing from settings.json', action: 'merge missing Lattice hook commands' };
  }

  if (def.kind === 'codex-hooks') {
    if (actual === null) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', reason: 'Codex hooks.json is missing', action: 'create hooks.json with Lattice PreToolUse hook' };
    }
    const parsed = safeJsonParse(actual);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: 'hooks.json is not a JSON object', action: 'fix manually: repair hooks.json as a JSON object' };
    }
    const merged = mergeCodexHooks(parsed);
    if (merged.incompatible.length > 0) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: `hook event(s) have incompatible shape: ${merged.incompatible.join(', ')}`, action: 'fix manually: repair hook array shape' };
    }
    if (!merged.changed) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'Lattice Codex PreToolUse hook is present', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Lattice Codex PreToolUse hook is missing from hooks.json', action: 'merge missing Lattice hook command' };
  }

  if (actual === null) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', expectedHash, reason: 'managed asset is missing', action: 'create from managed template' };
  }

  if (def.kind === 'managed-block') {
    const desiredSection = extractManagedSection(expected ?? '');
    const manifestUnchanged = Boolean(manifestEntry?.contentHash && manifestEntry.contentHash === actualHash);
    if (!hasManagedMarkers(actual)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', expectedHash: sha256(desiredSection), actualHash, reason: 'file exists without Lattice managed markers', action: 'fix manually: add markers or merge the managed section' };
    }
    const actualSection = actual.match(INIT_DOC_SECTION_RE)?.[0] ?? '';
    if (sha256(actualSection) === sha256(desiredSection)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section matches template', action: 'none' };
    }
    if (def.okWhen?.(actualSection, root)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section matches a recognized Lattice compatibility contract', action: 'none' };
    }
    if (!manifestUnchanged && !def.ownedWhen?.(actualSection)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_LOCAL_EDIT', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section differs and is not recognized as the generated init block', action: 'review local doc edits before replacing the section' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', expectedHash: sha256(desiredSection), actualHash, reason: 'Lattice managed section differs from template', action: 'replace managed section only' };
  }

  if (expected && actual === expected) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash, actualHash, reason: 'managed file matches template', action: 'none' };
  }

  if (actual !== null && def.okWhen?.(actual, root)) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash, actualHash, reason: 'managed file matches a recognized Lattice compatibility contract', action: 'none' };
  }

  const unchangedSinceManifest = Boolean(manifestEntry?.contentHash && manifestEntry.contentHash === actualHash);
  if (unchangedSinceManifest || def.ownedWhen?.(actual)) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', expectedHash, actualHash, reason: unchangedSinceManifest ? 'managed template changed since last sync' : 'file has managed generated signature', action: 'replace generated file from template' };
  }

  return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_LOCAL_EDIT', expectedHash, actualHash, reason: 'file differs and is not known to be unchanged/generated', action: 'review local edits before overwriting' };
}

function applyDefinition(root: string, def: ManagedAssetDefinition, item: ManagedAssetCheckItem): boolean {
  if (item.status !== 'MISSING' && item.status !== 'STALE_SAFE') return false;

  if (def.kind === 'remove-extra') {
    unlinkSync(join(root, def.relPath));
    return true;
  }
  if (def.kind === 'gitignore-runtime') {
    writeText(root, def.relPath, mergeRuntimeGitignore(readText(root, def.relPath)));
    return true;
  }
  if (def.kind === 'claude-settings') {
    const existing = readText(root, def.relPath);
    const parsed = existing ? safeJsonParse(existing) : {};
    const merged = mergeClaudeHooks(parsed && typeof parsed === 'object' ? parsed : {});
    writeText(root, def.relPath, JSON.stringify(merged.updated, null, 2));
    removeLegacyScopePretoolHookIfGenerated(root, 'claude');
    return true;
  }
  if (def.kind === 'codex-hooks') {
    const existing = readText(root, def.relPath);
    const parsed = existing ? safeJsonParse(existing) : {};
    const merged = mergeCodexHooks(parsed && typeof parsed === 'object' ? parsed : {});
    writeText(root, def.relPath, JSON.stringify(merged.updated, null, 2));
    removeLegacyScopePretoolHookIfGenerated(root, 'codex');
    return true;
  }
  if (def.kind === 'managed-block') {
    const expected = normalizeContent(def.expectedContent ?? '');
    const full = join(root, def.relPath);
    mkdirSync(dirname(full), { recursive: true });
    const actual = readText(root, def.relPath);
    if (actual === null) {
      writeFileSync(full, expected);
    } else {
      writeFileSync(full, actual.replace(INIT_DOC_SECTION_RE, extractManagedSection(expected)));
    }
    return true;
  }
  if (def.kind === 'whole-file') {
    const full = join(root, def.relPath);
    if (existsSync(full)) {
      try {
        if (lstatSync(full).isSymbolicLink()) unlinkSync(full);
      } catch { /* PROBE: best effort before replacing generated file */ }
    }
    writeText(root, def.relPath, def.expectedContent ?? '', def.executable);
    return true;
  }
  return false;
}

function writeManifest(root: string, profile: InitProfile, assetMode: InitAssetMode, items: ManagedAssetCheckItem[]): void {
  const assets: ManagedAssetManifest['assets'] = {};
  const now = new Date().toISOString();
  for (const item of items) {
    if (item.status !== 'OK') continue;
    assets[item.id] = {
      relPath: item.relPath,
      templateHash: item.expectedHash,
      contentHash: item.actualHash,
      updatedAt: now,
    };
  }
  writeText(root, MANIFEST_REL_PATH, JSON.stringify({
    version: 1,
    profile,
    assetMode,
    generatedAt: now,
    assets,
  } satisfies ManagedAssetManifest, null, 2));
}

function summarize(items: ManagedAssetCheckItem[]): Record<ManagedAssetStatus, number> {
  const summary: Record<ManagedAssetStatus, number> = {
    OK: 0,
    MISSING: 0,
    CASE_MISMATCH: 0,
    STALE_SAFE: 0,
    STALE_LOCAL_EDIT: 0,
    INCOMPATIBLE: 0,
  };
  for (const item of items) summary[item.status] += 1;
  return summary;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, '').split(/\r?\n/).length;
}

function markdownHeadings(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((heading): heading is string => Boolean(heading));
}

function stringDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter(item => !rightSet.has(item));
}

function reviewLocalEdit(root: string, def: ManagedAssetDefinition): ManagedAssetLocalEditReview | null {
  const actual = readText(root, def.relPath);
  if (actual === null) return null;
  const expected = normalizeContent(def.expectedContent ?? '');
  const actualReviewText = def.kind === 'managed-block' ? extractManagedSection(actual) : actual;
  const expectedReviewText = def.kind === 'managed-block' ? extractManagedSection(expected) : expected;
  const currentHeadings = markdownHeadings(actualReviewText);
  const expectedHeadings = markdownHeadings(expectedReviewText);
  const localOnlyHeadings = stringDifference(currentHeadings, expectedHeadings);
  const templateOnlyHeadings = stringDifference(expectedHeadings, currentHeadings);
  const recommendation = localOnlyHeadings.length > 0
    ? `manual review required: preserve or migrate local heading(s): ${localOnlyHeadings.join(', ')}`
    : 'manual review required: no unique local headings detected, compare text/body edits before replacing';

  return {
    relPath: def.relPath,
    kind: def.kind,
    status: 'STALE_LOCAL_EDIT',
    currentLines: countLines(actualReviewText),
    expectedLines: countLines(expectedReviewText),
    currentHeadings,
    expectedHeadings,
    localOnlyHeadings,
    templateOnlyHeadings,
    recommendation,
  };
}

function collectLocalEditReviews(
  root: string,
  defs: ManagedAssetDefinition[],
  items: ManagedAssetCheckItem[],
): ManagedAssetLocalEditReview[] {
  const staleLocalIds = new Set(items.filter(item => item.status === 'STALE_LOCAL_EDIT').map(item => item.id));
  return defs
    .filter(def => staleLocalIds.has(def.id))
    .map(def => reviewLocalEdit(root, def))
    .filter((review): review is ManagedAssetLocalEditReview => Boolean(review));
}

export function runManagedAssetCheck(root: string, options: ManagedAssetCheckOptions = {}): ManagedAssetCheckResult {
  const profile = options.profile ?? detectManagedAssetProfile(root);
  const assetMode = options.assetMode ?? detectManagedAssetMode(root);
  const mode: ManagedAssetCheckResult['mode'] = options.upgrade ? 'upgrade' : options.apply ? 'apply' : 'check';
  const shouldApply = mode === 'apply' || mode === 'upgrade';
  const warnings = shouldApply ? collectApplyWarnings(root) : [];
  const defs = listManagedAssetDefinitions(profile, packageRoot(), root, assetMode);
  const manifest = loadManifest(root);
  let items = defs.map(def => evaluateDefinition(root, def, manifest));
  const applied: string[] = [];

  if (shouldApply) {
    for (const def of defs) {
      const item = items.find(item => item.id === def.id);
      if (!item) continue;
      if (applyDefinition(root, def, item)) {
        applied.push(def.relPath);
        item.applied = true;
      }
    }
    const afterManifest = loadManifest(root);
    items = defs.map(def => evaluateDefinition(root, def, afterManifest));
    writeManifest(root, profile, assetMode, items);
  }

  const summary = summarize(items);
  const localEditReviews = options.reviewLocalEdits ? collectLocalEditReviews(root, defs, items) : undefined;
  return {
    ok: summary.MISSING === 0 && summary.CASE_MISMATCH === 0 && summary.STALE_SAFE === 0 && summary.STALE_LOCAL_EDIT === 0 && summary.INCOMPATIBLE === 0,
    profile,
    assetMode,
    mode,
    applied,
    warnings,
    summary,
    items,
    ...(localEditReviews ? { localEditReviews } : {}),
    manifestPath: MANIFEST_REL_PATH,
  };
}

export function renderManagedAssetCheck(result: ManagedAssetCheckResult): string {
  const lines = [
    `Lattice managed asset check: ${result.ok ? 'OK' : 'DRIFT'} (profile=${result.profile}, assetMode=${result.assetMode})`,
    `Summary: OK=${result.summary.OK}, MISSING=${result.summary.MISSING}, CASE_MISMATCH=${result.summary.CASE_MISMATCH}, STALE_SAFE=${result.summary.STALE_SAFE}, STALE_LOCAL_EDIT=${result.summary.STALE_LOCAL_EDIT}, INCOMPATIBLE=${result.summary.INCOMPATIBLE}`,
  ];
  if (result.applied.length > 0) {
    lines.push(`Applied: ${result.applied.join(', ')}`);
  }
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  const drift = result.items.filter(item => item.status !== 'OK');
  if (drift.length > 0) {
    lines.push('', 'Drift:');
    for (const item of drift) {
      lines.push(`  - ${item.status} ${item.relPath}: ${item.reason}`);
      lines.push(`    action: ${item.action}`);
    }
    if (result.localEditReviews?.length) {
      lines.push('', 'Local edit review:');
      for (const review of result.localEditReviews) {
        lines.push(`  - ${review.relPath}: current ${review.currentLines} line(s), template ${review.expectedLines} line(s)`);
        if (review.localOnlyHeadings.length > 0) {
          lines.push(`    local-only headings: ${review.localOnlyHeadings.join(', ')}`);
        }
        if (review.templateOnlyHeadings.length > 0) {
          lines.push(`    template-only headings: ${review.templateOnlyHeadings.join(', ')}`);
        }
        lines.push(`    recommendation: ${review.recommendation}`);
      }
    }
    lines.push('', 'Run `lattice check --apply` or `lattice check --upgrade` to sync MISSING/STALE_SAFE assets. CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE require manual review.');
  } else {
    lines.push(`Manifest: ${result.manifestPath}`);
  }
  return lines.join('\n');
}

export function managedAssetNextAction(result: ManagedAssetCheckResult): string {
  const unsafe = result.summary.CASE_MISMATCH + result.summary.STALE_LOCAL_EDIT + result.summary.INCOMPATIBLE;
  const safe = result.summary.MISSING + result.summary.STALE_SAFE;
  if (unsafe > 0) return 'review unsafe managed assets manually';
  if (safe > 0) return 'run lattice check --apply to sync MISSING/STALE_SAFE assets';
  if (result.applied.length > 0) return 'safe managed asset drift repaired';
  return 'no managed asset drift';
}

// B-097f: Claude agent prompts are runtime-owned and resolve from the global
// ~/.claude/agents single source. The observable mode string surfaced by
// `lattice doctor` and the init migration flow.
export const AGENT_ASSET_MODE_RUNTIME_OWNED = 'runtime-owned' as const;

export interface ProjectLocalAgentScan {
  /** Absolute project .claude/agents dir scanned. */
  agentsDir: string;
  /** The managed template basename set used for the exact-match comparison. */
  managedBasenames: string[];
  /** Project-local *.md files whose basename exactly matches a managed template. */
  managedFiles: string[];
  /** Project-local *.md files NOT in the managed set (user-authored — preserved). */
  userFiles: string[];
}

/**
 * Scan a project's `.claude/agents` for project-local managed agent files.
 *
 * "Managed" = basename exactly matches one of the running CLI package's
 * `templates/agents/*.md`. This is the precise set the explicit `--upgrade`
 * migration is allowed to delete; everything else is user-authored and
 * preserved. Returns empty sets when the dir or template source is absent.
 */
export function scanProjectLocalManagedAgents(
  projectRoot: string,
  templateDir: string | null = resolveAgentTemplateDir(),
): ProjectLocalAgentScan {
  const agentsDir = join(projectRoot, '.claude', 'agents');
  const managedBasenames = templateDir && existsSync(templateDir)
    ? listManagedAgentBasenames(templateDir)
    : [];
  const managedSet = new Set(managedBasenames);
  const managedFiles: string[] = [];
  const userFiles: string[] = [];
  if (existsSync(agentsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(agentsDir).filter(file => file.endsWith('.md')).sort((a, b) => a.localeCompare(b));
    } catch {
      // PROBE: unreadable dir reports as empty; next run re-scans.
      entries = [];
    }
    for (const file of entries) {
      if (managedSet.has(file)) managedFiles.push(file);
      else userFiles.push(file);
    }
  }
  return { agentsDir, managedBasenames, managedFiles, userFiles };
}

export interface MigrateProjectLocalAgentsResult {
  agentsDir: string;
  removed: string[];
  preserved: string[];
  dirRemoved: boolean;
}

/**
 * Migrate (delete) ONLY the exact managed agent basenames from a project's
 * `.claude/agents`. NEVER wildcard-deletes; user-authored files are preserved.
 * Removes the dir only if it becomes empty. Idempotent: no managed files → no-op.
 *
 * This is the explicit `--upgrade` migration. Callers must ensure the global
 * single source is ready first (see syncGlobalAgents).
 */
export function migrateProjectLocalManagedAgents(
  projectRoot: string,
  templateDir: string | null = resolveAgentTemplateDir(),
  log: (relPath: string) => void = () => {},
): MigrateProjectLocalAgentsResult {
  const scan = scanProjectLocalManagedAgents(projectRoot, templateDir);
  const removed: string[] = [];
  for (const file of scan.managedFiles) {
    const full = join(scan.agentsDir, file);
    try {
      unlinkSync(full);
      removed.push(file);
      log(`.claude/agents/${file}`);
    } catch {
      // PROBE: a concurrent removal leaves nothing to migrate; treat as done.
    }
  }
  // Remove the dir only if it is now empty (no user files, nothing left).
  let dirRemoved = false;
  if (existsSync(scan.agentsDir)) {
    let remaining: string[] = [];
    try {
      remaining = readdirSync(scan.agentsDir);
    } catch {
      remaining = [];
    }
    if (remaining.length === 0) {
      try {
        rmSync(scan.agentsDir, { recursive: false, force: true });
        dirRemoved = true;
      } catch {
        // PROBE: best-effort empty-dir cleanup.
      }
    }
  }
  return { agentsDir: scan.agentsDir, removed, preserved: scan.userFiles, dirRemoved };
}
