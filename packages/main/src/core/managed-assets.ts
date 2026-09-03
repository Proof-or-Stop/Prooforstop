import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROOF_OR_STOP_BIN_NAMES } from './proof-or-stop-brand.js';
import {
  ADAPTER_DIR_NAMES,
  MANIFEST_FILENAMES,
  PROOF_OR_STOP_ADAPTER_DIR,
  PROOF_OR_STOP_MANIFEST_FILENAME,
  PROOF_OR_STOP_STATE_DIR,
  STATE_DIR_NAMES,
  adapterDirCandidates,
  adapterManifestCandidates,
  stateDirCandidates,
} from './brand-paths.js';
import {
  AGENTS_MD_GLOBAL_THIN_TEMPLATE,
  AGENTS_MD_TEMPLATE,
  CLAUDE_MD_TEMPLATE,
  PROOF_OR_STOP_DOT_DIR_MD_TEMPLATE,
  PROOF_OR_STOP_MD_TEMPLATE,
  getCodexHooks,
  getClaudeHooks,
  codexHookCommand,
  hookCommand,
  LEGACY_SCOPE_PRETOOL_HOOK_FILE,
  PROOF_OR_STOP_SCOPE_PRETOOL_HOOK_FILE,
  listAgentPromptFiles,
  migrateHookCommandEntries,
  renderCodexAgentContent,
  renderCodexHooksJson,
  renderCodexPretoolScopeHookScript,
  renderCodexEvidencePretoolHookScript,
  renderCodexReadmeTemplate,
  renderProofOrStopBootstrapScript,
  renderProofOrStopCodexAdapterManifest,
  renderProofOrStopCodexWrapperScript,
  renderProofOrStopProjectConfig,
  type InitAssetMode,
  type InitProfile,
} from '../init-assets.js';
import {
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END,
  PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from './runtime-artifact-registry.js';
import {
  listManagedAgentBasenames,
  resolveAgentTemplateDir,
} from './global-agents.js';
import {
  readPromptRegistry,
  renderPromptEntryForHost,
} from './prompt-registry.js';
import { canonicalAgentRoleId, legacyAgentRoleIds } from './agent-role-identity.js';
import { loadConfig } from './config.js';
import { resolveProjectGitRoot } from './story-signed-workspace-resolution.js';
import {
  containsManagedMarker,
  extractManagedBlock,
  hasManagedBlock,
  inspectManagedBlock,
  replaceManagedBlock,
} from './managed-markers.js';

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

/**
 * Canonical runtime list of every `ManagedAssetKind`. Single source of truth for
 * any consumer that must re-validate kinds at runtime (Handler Encoding
 * Convention) — e.g. validate-docs-drift's managed-asset contradiction guard.
 *
 * Two compile-time guards keep this list honest:
 *   1. `as const satisfies readonly ManagedAssetKind[]` — every LISTED value must
 *      be a valid kind (rejects typos / removed kinds).
 *   2. `_AssertAllKinds` below — every UNION member must appear here, so adding a
 *      new `ManagedAssetKind` without listing it is a TYPE ERROR (no silent drift).
 */
export const ALL_MANAGED_ASSET_KINDS = [
  'managed-block',
  'whole-file',
  'gitignore-runtime',
  'claude-settings',
  'codex-hooks',
  'excluded-path',
  'remove-extra',
] as const satisfies readonly ManagedAssetKind[];

// Compile-time exhaustiveness: if a new ManagedAssetKind is added to the union
// but NOT to ALL_MANAGED_ASSET_KINDS above, `Exclude<...>` is the missing kind
// (not `never`), so this type resolves to the error tuple and the assignment
// below fails to compile. Adding the kind to the array restores it to `never`.
type _AssertAllKinds = Exclude<ManagedAssetKind, typeof ALL_MANAGED_ASSET_KINDS[number]> extends never
  ? true
  : ['MISSING_KIND', Exclude<ManagedAssetKind, typeof ALL_MANAGED_ASSET_KINDS[number]>];
const _allKindsCovered: _AssertAllKinds = true;
void _allKindsCovered;

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
  metadataRoot: string;
  assetRoot: string;
  gitRoot: string | null;
  pathsRelativeTo: 'assetRoot';
  assetRootGitRootSplit: boolean;
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

// B-cc10: was hardcoded '.proof-or-stop/managed-assets.json', so the runtime kept
// recreating the DEPRECATED state dir after CHK-003's move — the directory
// reappeared on every CLI invocation and repeatedly tripped the half-done
// detector. Route it through the resolver like every other state path.
const MANIFEST_REL_PATH = `${PROOF_OR_STOP_STATE_DIR}/managed-assets.json`;


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
  // B-cc10 CHK-002: accept EITHER adapter-dir spelling as the alias target.
  // Hardcoding one spelling here would make the alias go unrecognized under the
  // other name, and the caller would then read the wrong file (or none).
  if (!relPath.startsWith('.codex/') || actualRelPath === undefined) return false;
  const aliasTarget = actualRelPath;
  if (!ADAPTER_DIR_NAMES.some((dir) => aliasTarget.startsWith(`${dir}/`))) return false;
  try {
    const lower = statSync(join(root, relPath));
    const upper = statSync(join(root, aliasTarget));
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
  const template = hooks ? join(hooks, PROOF_OR_STOP_SCOPE_PRETOOL_HOOK_FILE) : '';
  if (!template || !existsSync(template)) return;
  removeGeneratedFileIfExact(
    root,
    `.claude/hooks/${LEGACY_SCOPE_PRETOOL_HOOK_FILE}`,
    readFileSync(template, 'utf-8'),
    actual => actual.includes("provider: 'claude'") && actual.includes('prewrite_guard_check'),
  );
}

function extractManagedSection(content: string): string {
  return extractManagedBlock(content, 'document');
}

function hasManagedMarkers(content: string): boolean {
  return hasManagedBlock(content, 'document');
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { /* PROBE: malformed JSON means this asset cannot prove managed ownership. */ return null; }
}

function gitLines(gitCwd: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, {
      cwd: gitCwd,
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
  return containsManagedMarker(actual, 'document')
    || actual.includes(`name: ${base}`)
    || actual.includes('name: proof-or-stop-');
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
    // The legacy scope-pretool command migrates onto the FIRST managed entry's
    // command (the scope guard). B-5f42: an event can now declare MULTIPLE
    // managed entries (e.g. PreToolUse has both the scope guard and the
    // english-only guard), so each entry must be merged independently — only
    // checking eventHooks[0] would silently drop every entry after the first.
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
      hookCommand(LEGACY_SCOPE_PRETOOL_HOOK_FILE),
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

function mergeCodexHooks(existing: any): { updated: any; changed: boolean; incompatible: string[] } {
  const codexHooks = getCodexHooks();
  const updated = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const hooks = updated.hooks && typeof updated.hooks === 'object' && !Array.isArray(updated.hooks)
    ? { ...updated.hooks }
    : {};
  const incompatible: string[] = [];
  let changed = !updated.hooks;

  for (const [event, eventHooks] of Object.entries(codexHooks)) {
    // B-1507 CHK-003: PreToolUse now declares MULTIPLE managed entries (scope
    // guard + evidence-pin seatbelt). The legacy scope-pretool command migrates
    // onto the FIRST managed entry's command; each entry is then merged
    // independently — checking only eventHooks[0] would drop later entries.
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

function runtimeIgnoreMissing(existing: string | null): string[] {
  if (!existing) return listRuntimeArtifactIgnorePatterns();
  const present = new Set(existing.split('\n').map(line => line.trim()).filter(Boolean));
  return listRuntimeArtifactIgnorePatterns().filter(line => !present.has(line));
}

function renderManagedRuntimeIgnoreBlock(lines: string[]): string {
  return [
    PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START,
    ...lines,
    PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END,
  ].join('\n');
}

// B-854c CHK-003: exported so `proof-or-stop doctor --repair` can reuse the SAME
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
  // B-cc10 CHK-002: probe every accepted adapter-dir / manifest spelling, so a
  // project that has not been migrated is still detected as a Codex project.
  // Detecting 'core' instead of 'codex' here would silently stop managing the
  // adapter assets rather than reporting an error.
  const hasCodex = Boolean(
    (agents && hasManagedMarkers(agents))
      || adapterManifestCandidates().some(rel => existsSync(join(root, rel)))
      || adapterDirCandidates('agents').some(rel => existsSync(join(root, rel)))
      || existsSync(join(root, 'bin', 'proof-or-stop-codex.js'))
  );
  const hasClaude = Boolean(
    (claude && hasManagedMarkers(claude))
      || existsSync(join(root, '.claude', 'agents'))
      || existsSync(join(root, '.claude', 'hooks')),
  );
  if (hasCodex && hasClaude) return 'all';
  if (hasCodex) return 'codex';
  if (hasClaude) return 'claude';
  return 'core';
}

export function detectManagedAssetMode(root: string): InitAssetMode {
  // B-cc10 CHK-002: read-both state-dir + manifest spellings, canonical first.
  // `.proof-or-stop` stays an explicit extra entry — it is a case variant, not a brand
  // identity the resolver owns.
  const globalThinConfig = [
    ...MANIFEST_FILENAMES.flatMap(file => stateDirCandidates(file)),
    // B-cc10 CHK-004: the `.proof-or-stop` case variant accepts BOTH manifest
    // filenames; pinning the deprecated one made a migrated `.proof-or-stop` root stop
    // being detected as global-thin.
    ...MANIFEST_FILENAMES.map(file => `.proof-or-stop/${file}`),
  ].find(relPath => existsSync(join(root, relPath)));
  if (globalThinConfig) {
    const text = readText(root, globalThinConfig);
    if (text?.includes('global-thin')) return 'global-thin';
  }
  if (
    adapterManifestCandidates().some(rel => existsSync(join(root, rel)))
    || adapterDirCandidates('agents').some(rel => existsSync(join(root, rel)))
  ) {
    return 'full';
  }
  if (existsSync(join(root, 'bin', 'proof-or-stop.js'))) {
    return 'full';
  }
  // Full-mode: PROOF_OR_STOP.md presence (any casing) implies non-global-thin project
  try {
    const lcNames = readdirSync(root).map(e => e.toLowerCase());
    if (lcNames.includes('proof_or_stop.md')) return 'full';
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

function isProofOrStopSelfRepoBootstrap(actual: string, root: string): boolean {
  if (!actual.includes("import { runLocalBootstrap } from './bootstrap-runner.js'")) return false;
  if (!actual.includes('runLocalBootstrap();')) return false;
  const bootstrap = readText(root, 'bin/bootstrap-runner.js');
  if (!bootstrap?.includes('export async function runLocalBootstrap()')) return false;
  return managedAssetPathKind(root, 'packages/main/src/init-assets.ts') === 'file'
    && managedAssetPathKind(root, 'packages/main/src/core/managed-assets.ts') === 'file';
}

/**
 * True when the guide teaches the `session_brief` entry command under ANY bin token the CLI
 * answers to.
 *
 * B-cdf6 CHK-005: these ownership recognizers used to require the literal `proof-or-stop session_brief`.
 * After the bin rename rewrote the active guides to `proof-or-stop session_brief`, the recognizer
 * stopped identifying the repo's own CLAUDE.md as a Proof-or-Stop-owned expanded guide, so the
 * managed-asset check reported STALE_LOCAL_EDIT \u2014 i.e. "a human hand-edited this, refuse to
 * touch it" \u2014 for a doc the rename legitimately updated. Accepting every bin token keeps the
 * recognizer's strength identical (the guide must still teach session_brief plus all the other
 * required section markers) while making it survive the transition in both directions.
 */
function mentionsSessionBriefCommand(actual: string): boolean {
  return PROOF_OR_STOP_BIN_NAMES.some(bin => actual.includes(`${bin} session_brief`));
}

function isExpandedProofOrStopAgentsGuide(actual: string): boolean {
  const currentProofOrStop = actual.includes('# AGENTS.md')
    && actual.includes('Current lifecycle override')
    && mentionsSessionBriefCommand(actual)
    && actual.includes('\u6d41\u7a0b\u4e8b\u5b9e\u53cc\u5c42\u5951\u7ea6')
    && actual.includes('Story \u9636\u6bb5\u6d41\u8f6c')
    && actual.includes('Fail-fast policy');
  const english = actual.includes('# AGENTS.md')
    && actual.includes('Current lifecycle override')
    && mentionsSessionBriefCommand(actual)
    && actual.includes('Two-Layer Process Fact Contract')
    && actual.includes('Story Phase Transitions')
    && actual.includes('Fail-fast policy');
  const legacyChinese = actual.includes('# AGENTS.md')
    && mentionsSessionBriefCommand(actual)
    && actual.includes('\u6d41\u7a0b\u4e8b\u5b9e\u53cc\u5c42\u5951\u7ea6')
    && actual.includes('Story \u9636\u6bb5\u6d41\u8f6c')
    && actual.includes('Fail-fast policy');
  return currentProofOrStop || english || legacyChinese;
}

function isExpandedProofOrStopOverview(actual: string): boolean {
  const english = actual.includes('# Proof-or-Stop Module Classification and Flow')
    && actual.includes('project execution and verification substrate')
    && actual.includes('verificationIntent')
    && actual.includes('verificationEvidence')
    && actual.includes('Story Flow Master Table')
    && actual.includes('Definition of Done');
  const chinese = actual.includes('# Proof-or-Stop \u6a21\u5757\u5206\u7c7b\u4e0e\u6d41\u7a0b')
    && actual.includes('project execution and verification substrate')
    && actual.includes('verificationIntent')
    && actual.includes('verificationEvidence')
    && actual.includes('Story \u6d41\u7a0b\u603b\u8868')
    && actual.includes('\u5b8c\u6210\u5b9a\u4e49');
  return english || chinese;
}

function isExpandedProofOrStopClaudeGuide(actual: string): boolean {
  const english = actual.includes('# CLAUDE.md')
    && mentionsSessionBriefCommand(actual)
    && actual.includes('REVIEW→TEST')
    && actual.includes('Claude Prompt Hook')
    && actual.includes('Reviewer opt-in')
    && actual.includes('Framework Introspection audit Configuration');
  const legacyChinese = actual.includes('# CLAUDE.md')
    && mentionsSessionBriefCommand(actual)
    && actual.includes('REVIEW→TEST')
    && actual.includes('Claude Prompt Hook')
    && actual.includes('Reviewer opt-in')
    && actual.includes('\u6846\u67b6\u81ea\u7701 audit \u914d\u7f6e');
  return english || legacyChinese;
}

export function listManagedAssetDefinitions(
  profile: InitProfile,
  root = packageRoot(),
  projectRoot = process.cwd(),
  assetMode: InitAssetMode = 'full',
): ManagedAssetDefinition[] {
  const isGlobalThin = assetMode === 'global-thin';
  // Global-thin: canonical assets live in the state directory. No local bin shims.
  //
  // B-cc10 CHK-007 (F-004): the guide + manifest relPaths are DERIVED from the
  // resolver. They were hardcoded to the deprecated state directory even after
  // CHK-003 moved it (the stale comment below used to say the state-dir component
  // was "CHK-003's to move" — it moved, this did not follow), so `init` wrote the
  // guide into a stray legacy directory while writing the manifest to the
  // canonical one. WRITES use the canonical name only; the ownership recognizers
  // still accept BOTH spellings so an already-installed project is classified as
  // syncable rather than STALE_LOCAL_EDIT.
  const dotDirGuideRel = `${PROOF_OR_STOP_STATE_DIR}/Proof-or-Stop.md`;
  const guideMentionsAnyStateDir = (actual: string): boolean =>
    STATE_DIR_NAMES.some((dir) => actual.includes(`${dir}/Proof-or-Stop.md`));
  if (isGlobalThin) {
    const defs: ManagedAssetDefinition[] = [
      managedDoc(
        `doc:${dotDirGuideRel}`,
        dotDirGuideRel,
        PROOF_OR_STOP_DOT_DIR_MD_TEMPLATE,
        actual => guideMentionsAnyStateDir(actual)
          // Read-both ownership recognition (B-cdf6 CHK-006): an ALREADY-INSTALLED
          // guide doc still carries the pre-rename `proof-or-stop codex verify` literal.
          // Recognizing only the canonical spelling would reclassify every existing
          // install as STALE_LOCAL_EDIT and refuse to sync it.
          || actual.includes('proof-or-stop codex verify')
          || actual.includes('proof-or-stop codex verify'),
      ),
      wholeFile(
        // B-cc10 CHK-004 + CHK-007: BOTH components now come from the resolver, so
        // init writes the canonical manifest name inside the canonical state dir.
        `${PROOF_OR_STOP_STATE_DIR}:${PROOF_OR_STOP_MANIFEST_FILENAME}`,
        `${PROOF_OR_STOP_STATE_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`,
        renderProofOrStopProjectConfig(),
        actual => actual.includes('"assetMode"') && actual.includes('global-thin'),
        false,
        actual => {
          try {
            const parsed = safeJsonParse(actual);
            return Boolean(
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              && (parsed as Record<string, unknown>)['assetMode'] === 'global-thin'
              && ((parsed as Record<string, unknown>)['proofOrStopVersion'] === 1
                || (parsed as Record<string, unknown>)['latticeVersion'] === 1),
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
          actual => guideMentionsAnyStateDir(actual)
          // Read-both ownership recognition (B-cdf6 CHK-006): an ALREADY-INSTALLED
          // guide doc still carries the pre-rename `proof-or-stop codex verify` literal.
          // Recognizing only the canonical spelling would reclassify every existing
          // install as STALE_LOCAL_EDIT and refuse to sync it.
          || actual.includes('proof-or-stop codex verify')
          || actual.includes('proof-or-stop codex verify'),
        ),
      );
    }
    if (wantsCodex) {
      defs.push(
        { id: '.codex:hooks.json', relPath: '.codex/hooks.json', kind: 'codex-hooks' },
        wholeFile(
          '.codex/hooks:proof-or-stop-scope-pretool.cjs',
          '.codex/hooks/proof-or-stop-scope-pretool.cjs',
          renderCodexPretoolScopeHookScript(),
          actual => actual.includes('Codex PreToolUse hook') && actual.includes('prewrite_guard_check'),
          true,
        ),
        wholeFile(
          '.codex/hooks:proof-or-stop-evidence-pretool.cjs',
          '.codex/hooks/proof-or-stop-evidence-pretool.cjs',
          renderCodexEvidencePretoolHookScript(),
          actual => actual.includes('evidence-pin seatbelt') && actual.includes('verification_pin_guard_check'),
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
          actual => actual.includes('Proof-or-Stop For Claude Code') || actual.includes('Claude Code subagents 位于'),
          actual => isExpandedProofOrStopClaudeGuide(actual),
        ),
        { id: '.claude:settings.json', relPath: '.claude/settings.json', kind: 'claude-settings' },
      );
    }
    return defs;
  }

  const defs: ManagedAssetDefinition[] = [
    managedDoc(
      'doc:PROOF_OR_STOP.md',
      'PROOF_OR_STOP.md',
      PROOF_OR_STOP_MD_TEMPLATE,
      actual => actual.includes('canonical, host-neutral') || actual.includes('New init profile'),
      actual => isExpandedProofOrStopOverview(actual),
    ),
    // B-cdf6: `bin/proof-or-stop.js` is the canonical bootstrap that init writes, so it is
    // registered unconditionally and reported MISSING when absent, exactly as the old
    // `bin/proofOrStop.js` entry used to be.
    wholeFile(
      'bin:proof-or-stop.js',
      'bin/proof-or-stop.js',
      renderProofOrStopBootstrapScript(root),
      actual => actual.includes('coreCliEngineCandidates') && actual.includes('runCli'),
      true,
      isProofOrStopSelfRepoBootstrap,
    ),
    { id: 'gitignore:runtime-artifacts', relPath: '.gitignore', kind: 'gitignore-runtime' },
  ];

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
        actual => isExpandedProofOrStopAgentsGuide(actual),
      ),
      // B-cdf6: canonical Codex wrapper is required; the deprecated alias is drift-checked
      // only when present (same contract as the bootstrap pair above).
      wholeFile(
        'bin:proof-or-stop-codex.js',
        'bin/proof-or-stop-codex.js',
        renderProofOrStopCodexWrapperScript(),
        // B-cdf6:F-066 — this previously required the literal
        // `PROOF_OR_STOP_ACTIVITY_SOURCE`, which the generator NEVER emits: it builds env
        // names by concatenation (`'PROOF_OR_STOP_' + suffix`), so the full token
        // does not appear in the rendered text and the predicate was dead for its
        // stated purpose. Match the fragments the generator actually emits.
        actual => actual.includes(`setEnv('ACTIVITY_SOURCE'`) && actual.includes('local-wrapper'),
        true,
      ),
      // B-cc10 CHK-007: adapter-dir components are resolver-derived, matching the
      // `init` writers. They were literal DEPRECATED spellings while the manifest
      // filename already came from the resolver, so `check` tracked a directory
      // full-mode `init` no longer writes.
      wholeFile(
        `${PROOF_OR_STOP_ADAPTER_DIR}:README.md`,
        `${PROOF_OR_STOP_ADAPTER_DIR}/README.md`,
        renderCodexReadmeTemplate(assetMode, 'proof-or-stop'),
        actual => actual.includes('Codex + Proof-or-Stop'),
      ),
      wholeFile(
        // B-cc10 CHK-004 + CHK-007: both components from the resolver.
        `${PROOF_OR_STOP_ADAPTER_DIR}:${PROOF_OR_STOP_MANIFEST_FILENAME}`,
        `${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`,
        renderProofOrStopCodexAdapterManifest(assetMode === 'thin' ? { promptMode: 'registry' } : {}),
        () => true,
      ),
      { id: '.codex:hooks.json', relPath: '.codex/hooks.json', kind: 'codex-hooks' },
      wholeFile(
        '.codex/hooks:proof-or-stop-scope-pretool.cjs',
        '.codex/hooks/proof-or-stop-scope-pretool.cjs',
        renderCodexPretoolScopeHookScript(),
        actual => actual.includes('Codex PreToolUse hook') && actual.includes('prewrite_guard_check'),
        true,
      ),
      wholeFile(
        '.codex/hooks:proof-or-stop-evidence-pretool.cjs',
        '.codex/hooks/proof-or-stop-evidence-pretool.cjs',
        renderCodexEvidencePretoolHookScript(),
        actual => actual.includes('evidence-pin seatbelt') && actual.includes('verification_pin_guard_check'),
        true,
      ),
      { id: `excluded:${PROOF_OR_STOP_ADAPTER_DIR}/settings.json`, relPath: `${PROOF_OR_STOP_ADAPTER_DIR}/settings.json`, kind: 'excluded-path' },
    );
    if (assetMode === 'full' && templates) {
      const files = listAgentPromptFiles(templates);
      // B-META-framework-audit:F-005 — a MODULAR COMPLEX role is materialized as its
      // digest-pinned legacy-full-context reconstruction, not the raw modular
      // template, or every freshly-init-ed project reports STALE_SAFE for those 5
      // files. Delegated to renderPromptEntryForHost rather than re-deriving the rule
      // here: that helper IS the rule, it is what verify_codex compares against, and
      // hand-rolling it in parallel places is exactly how F-034 (a third divergent
      // copy) happened. Verified byte-identical to the previous hand-rolled output
      // for all 17 roles.
      const registryEntries = readPromptRegistry(templates).agents;
      for (const file of files) {
        const roleId = canonicalAgentRoleId(file.replace(/\.md$/, ''));
        const entry = registryEntries.find(candidate => candidate.agentId === roleId);
        defs.push(wholeFile(
          `${PROOF_OR_STOP_ADAPTER_DIR}/agents:${file}`,
          `${PROOF_OR_STOP_ADAPTER_DIR}/agents/${file}`,
          entry
            ? renderPromptEntryForHost(entry, 'codex')
            : renderCodexAgentContent(readFileSync(join(templates, file), 'utf-8')),
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
        actual => actual.includes('Proof-or-Stop For Claude Code') || actual.includes('Claude Code subagents are located at'),
        actual => isExpandedProofOrStopClaudeGuide(actual),
      ),
      { id: '.claude:settings.json', relPath: '.claude/settings.json', kind: 'claude-settings' },
    );
    if (templates) {
      const expected = new Set(listAgentPromptFiles(templates));
      // B-cdf6:F-034 — this was the THIRD hand-rolled copy of the same rule
      // (complex role -> digest-pinned legacy reconstruction -> host render ->
      // reviewer bootstrap). cli-init.ts and the codex mirror above were fixed by
      // hand while this sibling block a dozen lines below kept the raw template, so
      // a seeded `.claude/agents` reported STALE_SAFE for exactly the 5
      // MODULAR_COMPLEX_ROLE_IDS. Hand-synchronising three copies demonstrably does
      // not hold, so all three now call the single helper the rest of the codebase
      // already uses — renderPromptEntryForHost — which encapsulates the whole rule
      // and is the same function verify_codex compares against. Verified
      // byte-identical to the hand-rolled output for all 17 roles on both hosts.
      const registryEntries = readPromptRegistry(templates).agents;
      for (const file of expected) {
        const roleId = canonicalAgentRoleId(file.replace(/\.md$/, ''));
        const entry = registryEntries.find(candidate => candidate.agentId === roleId);
        defs.push(wholeFile(
          `.claude/agents:${file}`,
          `.claude/agents/${file}`,
          entry
            ? renderPromptEntryForHost(entry, 'claude')
            : readFileSync(join(templates, file), 'utf-8'),
          actual => isManagedPrompt(actual, file),
        ));
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
          actual => actual.includes('proof-or-stop') || actual.includes('PROOF_OR_STOP'),
        ));
      }
    }
  }

  // B-cc10 CHK-007: this stale-prompt sweep scans EVERY accepted adapter-dir
  // spelling, not just one. It is a cleanup READ, so the read-both rule applies:
  // pinning it to a single spelling would either miss a legacy install's stale
  // prompts (old name) or miss the ones init writes today (new name).
  if (wantsCodex && assetMode === 'full' && templates) {
    const expected = new Set(listAgentPromptFiles(templates));
    for (const adapterDir of ADAPTER_DIR_NAMES) {
      const agentsDir = join(projectRoot, adapterDir, 'agents');
      if (!existsSync(agentsDir)) continue;
      for (const file of listAgentPromptFiles(agentsDir)) {
        if (!expected.has(file)) {
          defs.push({ id: `${adapterDir}/agents:extra:${file}`, relPath: `${adapterDir}/agents/${file}`, kind: 'remove-extra' });
        }
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
      action: 'rename the path with exact casing or merge it manually before running proof-or-stop check --apply/--upgrade',
    };
  }

  if (def.kind === 'excluded-path') {
    if (pathKind === 'missing') {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', reason: 'excluded runtime asset is absent', action: 'none' };
    }
    const found = pathKind === 'file' ? 'file' : pathKind === 'directory' ? 'directory' : 'non-file path';
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: `Proof-or-Stop runtime must not use this excluded asset path (found ${found})`, action: 'fix manually: remove it if it is not user-owned' };
  }

  if (def.kind === 'remove-extra') {
    if (pathKind === 'missing') {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', reason: 'extra generated prompt already absent', action: 'none' };
    }
    if (pathKind !== 'file') {
      const found = pathKind === 'directory' ? 'directory' : 'non-file path';
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', reason: `stale generated prompt path is a ${found}`, action: 'fix manually: remove it if it is generated by Proof-or-Stop' };
    }
    if (def.ownedWhen && actual !== null && !def.ownedWhen(actual)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'unrecognized prompt is not recognized as generated by Proof-or-Stop; preserving it', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Codex agent mirror contains a prompt no longer present in managed templates', action: 'remove generated stale prompt' };
  }

  if (pathKind === 'directory' || pathKind === 'other') {
    const found = pathKind === 'directory' ? 'directory' : 'non-file path';
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', expectedHash, reason: `managed asset path is a ${found}, expected a file`, action: 'fix manually: replace or remove the path before running proof-or-stop check --apply/--upgrade' };
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
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', reason: 'Claude hook settings are missing', action: 'create settings with Proof-or-Stop hooks' };
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
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'Proof-or-Stop Claude hooks are present', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Proof-or-Stop Claude hooks are missing from settings.json', action: 'merge missing Proof-or-Stop hook commands' };
  }

  if (def.kind === 'codex-hooks') {
    if (actual === null) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', reason: 'Codex hooks.json is missing', action: 'create hooks.json with Proof-or-Stop PreToolUse hook' };
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
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'Proof-or-Stop Codex PreToolUse hook is present', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Proof-or-Stop Codex PreToolUse hook is missing from hooks.json', action: 'merge missing Proof-or-Stop hook command' };
  }

  if (actual === null) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', expectedHash, reason: 'managed asset is missing', action: 'create from managed template' };
  }

  if (def.kind === 'managed-block') {
    const desiredSection = extractManagedSection(expected ?? '');
    const manifestUnchanged = Boolean(manifestEntry?.contentHash && manifestEntry.contentHash === actualHash);
    const inspection = inspectManagedBlock(actual, 'document');
    if (inspection.status !== 'valid') {
      const reason = inspection.status === 'missing'
        ? 'file exists without Proof-or-Stop managed markers'
        : `managed block markers are malformed: ${inspection.reason}`;
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', expectedHash: sha256(desiredSection), actualHash, reason, action: 'fix manually: add one complete, non-nested managed block before syncing' };
    }
    const actualSection = inspection.block.text;
    if (sha256(actualSection) === sha256(desiredSection)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section matches template', action: 'none' };
    }
    if (def.okWhen?.(actualSection, root)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section matches a recognized Proof-or-Stop compatibility contract', action: 'none' };
    }
    if (!manifestUnchanged && !def.ownedWhen?.(actualSection)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_LOCAL_EDIT', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section differs and is not recognized as the generated init block', action: 'review local doc edits before replacing the section' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', expectedHash: sha256(desiredSection), actualHash, reason: 'Proof-or-Stop managed section differs from template', action: 'replace managed section only' };
  }

  if (expected && actual === expected) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash, actualHash, reason: 'managed file matches template', action: 'none' };
  }

  if (actual !== null && def.okWhen?.(actual, root)) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash, actualHash, reason: 'managed file matches a recognized Proof-or-Stop compatibility contract', action: 'none' };
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
      const updated = replaceManagedBlock(actual, extractManagedSection(expected), 'document');
      if (updated === null) return false;
      writeFileSync(full, updated);
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

function canonicalRootPath(root: string): string {
  const absolute = resolvePath(root);
  try {
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  } catch {
    return absolute;
  }
}

function managedAssetRootDiagnostics(root: string): Pick<
  ManagedAssetCheckResult,
  'metadataRoot' | 'assetRoot' | 'gitRoot' | 'pathsRelativeTo' | 'assetRootGitRootSplit'
> {
  const metadataRoot = canonicalRootPath(root);
  const assetRoot = metadataRoot;
  const gitRoot = resolveProjectGitRoot(metadataRoot, loadConfig(metadataRoot).gitRoot);
  return {
    metadataRoot,
    assetRoot,
    gitRoot,
    pathsRelativeTo: 'assetRoot',
    assetRootGitRootSplit: Boolean(gitRoot && canonicalRootPath(gitRoot) !== assetRoot),
  };
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
    ...managedAssetRootDiagnostics(root),
    applied,
    warnings,
    summary,
    items,
    ...(localEditReviews ? { localEditReviews } : {}),
    manifestPath: MANIFEST_REL_PATH,
  };
}

function renderManagedAssetRootGuidance(result: ManagedAssetCheckResult): string[] {
  const lines = [
    'Paths: managed asset relPath/applied/manifestPath values are relative to assetRoot.',
    `  metadataRoot: ${result.metadataRoot}`,
    `  assetRoot: ${result.assetRoot}`,
  ];
  if (result.gitRoot) {
    const suffix = result.assetRootGitRootSplit
      ? ' (separate from assetRoot; managed assets are not rooted here)'
      : ' (same as assetRoot)';
    lines.push(`  gitRoot: ${result.gitRoot}${suffix}`);
  } else {
    lines.push('  gitRoot: unresolved');
  }
  return lines;
}

export function renderManagedAssetCheck(result: ManagedAssetCheckResult): string {
  const lines = [
    `Proof-or-Stop managed asset check: ${result.ok ? 'OK' : 'DRIFT'} (profile=${result.profile}, assetMode=${result.assetMode})`,
    `Summary: OK=${result.summary.OK}, MISSING=${result.summary.MISSING}, CASE_MISMATCH=${result.summary.CASE_MISMATCH}, STALE_SAFE=${result.summary.STALE_SAFE}, STALE_LOCAL_EDIT=${result.summary.STALE_LOCAL_EDIT}, INCOMPATIBLE=${result.summary.INCOMPATIBLE}`,
    ...renderManagedAssetRootGuidance(result),
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
    lines.push('', 'Run `proof-or-stop check --apply` or `proof-or-stop check --upgrade` to sync MISSING/STALE_SAFE assets. CASE_MISMATCH/STALE_LOCAL_EDIT/INCOMPATIBLE require manual review.');
  } else {
    lines.push(`Manifest: ${result.manifestPath}`);
  }
  return lines.join('\n');
}

export function managedAssetNextAction(result: ManagedAssetCheckResult): string {
  const unsafe = result.summary.CASE_MISMATCH + result.summary.STALE_LOCAL_EDIT + result.summary.INCOMPATIBLE;
  const safe = result.summary.MISSING + result.summary.STALE_SAFE;
  if (unsafe > 0) return 'review unsafe managed assets manually';
  if (safe > 0) return 'run proof-or-stop check --apply to sync MISSING/STALE_SAFE assets';
  if (result.applied.length > 0) return 'safe managed asset drift repaired';
  return 'no managed asset drift';
}

// B-097f: Claude agent prompts are runtime-owned and resolve from the global
// ~/.claude/agents single source. The observable mode string surfaced by
// `proof-or-stop doctor` and the init migration flow.
export const AGENT_ASSET_MODE_RUNTIME_OWNED = 'runtime-owned' as const;

export interface ProjectLocalAgentScan {
  /** Absolute project .claude/agents dir scanned. */
  agentsDir: string;
  /** The canonical and exact legacy-alias basename set used for comparison. */
  managedBasenames: string[];
  /** Project-local *.md files whose basename exactly matches a managed role or alias. */
  managedFiles: string[];
  /** Project-local *.md files NOT in the managed set (user-authored — preserved). */
  userFiles: string[];
}

/**
 * Scan a project's `.claude/agents` for project-local managed agent files.
 *
 * "Managed" = basename exactly matches one of the running CLI package's
 * `templates/agents/*.md`, or an exact legacy alias for one of those canonical
 * roles from the shared role identity mapping. This is the precise set the
 * explicit `--upgrade` migration is allowed to delete; everything else is
 * user-authored and preserved. Returns empty sets when the dir or template
 * source is absent.
 */
export function scanProjectLocalManagedAgents(
  projectRoot: string,
  templateDir: string | null = resolveAgentTemplateDir(),
): ProjectLocalAgentScan {
  const agentsDir = join(projectRoot, '.claude', 'agents');
  const managedBasenames = templateDir && existsSync(templateDir)
    ? [...new Set(listManagedAgentBasenames(templateDir).flatMap((file) => {
      const roleId = canonicalAgentRoleId(file.replace(/\.md$/, ''));
      return [file, ...legacyAgentRoleIds(roleId).map(alias => `${alias}.md`)];
    }))].sort((a, b) => a.localeCompare(b))
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
 * Migrate (delete) ONLY the exact managed agent or known legacy-alias basenames
 * from a project's `.claude/agents`. NEVER wildcard-deletes; user-authored
 * files are preserved. Removes the dir only if it becomes empty. Idempotent:
 * no managed files → no-op.
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
