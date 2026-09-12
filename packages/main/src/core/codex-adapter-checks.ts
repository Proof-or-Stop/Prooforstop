import { rethrowIntentAmendmentIntegrityError } from './verification-intent-amendment.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  PROOF_OR_STOP_CODEX_ADAPTER_MANIFEST,
  CODEX_PRETOOL_SCOPE_HOOK_MATCHER,
  isCodexAdapterManifestOwner,
  listAgentPromptFiles,
  renderProofOrStopCodexAdapterManifest,
  type CodexPromptMode,
} from '../init-assets.js';
import { readActivityLogTail } from './activity-log.js';
import {
  resolveAgentAssetResolution,
  summarizeAgentAssetResolution,
  type AgentAssetResolution,
} from './agent-asset-resolution.js';
import { isManagedGlobalThinRoot, loadConfig } from './config.js';
import { PROOF_OR_STOP_PRIMARY_BIN } from './proof-or-stop-brand.js';
import { resolveProjectGitCwd } from './story-signed-workspace-resolution.js';
import {
  canonicalPromptRegistrySchemaVersion,
  normalizePromptRegistryManifest,
  promptRegistryManifest,
  readPromptRegistry,
  renderPromptEntryForHost,
} from './prompt-registry.js';
import type { StoryStore } from './store.js';
import type { ProcessEvent } from './types.js';
import { applyBrandEnv, readBrandEnv } from './brand-env.js';

import { ADAPTER_DIR_NAMES, PROOF_OR_STOP_ADAPTER_DIR, PROOF_OR_STOP_MANIFEST_FILENAME, adapterDirCandidates, adapterManifestCandidates, PROOF_OR_STOP_STATE_DIR } from './brand-paths.js';

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

/**
 * Local wrapper basenames (B-cdf6 rename; B-cc10 CHK-006 alias removal).
 *
 * B-cdf6 kept the deprecated `bin/proof-or-stop-codex.js` / `bin/proofOrStop.js` aliases as
 * additional accepted entries. B-cc10 CHK-006 REMOVED both aliases from the repository,
 * so they are removed from these lists too: a name that can no longer exist would only
 * widen the accepted set without ever matching, and would keep teaching the dead name to
 * the next maintainer. Consumers still resolve by first-existing rather than asserting a
 * single name, so this stays a list rather than a scalar.
 */
export const LOCAL_CODEX_WRAPPERS: readonly string[] = [
  'bin/proof-or-stop-codex.js',
];
export const LOCAL_BOOTSTRAP_WRAPPERS: readonly string[] = [
  'bin/proof-or-stop.js',
];

/** First existing candidate, or the canonical name when none is present. */
function resolveWrapperRelPath(root: string, candidates: readonly string[]): string {
  return candidates.find(rel => existsSync(join(root, rel))) ?? candidates[0];
}

export const LOCAL_CODEX_VERIFY_COMMAND = 'node bin/proof-or-stop-codex.js verify_codex';
export const LOCAL_MAIN_VERIFY_COMMAND = 'node bin/proof-or-stop.js verify_codex';
export const GLOBAL_THIN_CODEX_VERIFY_COMMAND = 'proof-or-stop codex verify';
export const LOCAL_INIT_VERIFY_COMMAND = 'proof-or-stop init --verify-codex';
export const GLOBAL_CODEX_FALLBACK_COMMAND = 'PROOF_OR_STOP_ACTIVITY_SOURCE=codex PROOF_OR_STOP_ACTIVITY_RECORD_READONLY=1 PROOF_OR_STOP_CODEX_ENTRYPOINT=global-fallback proof-or-stop';
export const DEFAULT_CODEX_HEARTBEAT_TIMEOUT_MS = 10_000;
// The global fallback runs the real installed `proof-or-stop session_brief`, which can
// traverse a large repo before writing its heartbeat. Keep local wrapper probes
// conservative, but give this fallback enough budget for real-world repos.
export const DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * B-cdf6 (B-META F-013): hard cap for a global-fallback heartbeat timeout override.
 *
 * `session_brief` aggregates every active story before it writes its heartbeat, so its
 * cost scales with repository size: on this repo (319 entries under the active story
 * dir) it needs ~101s and cannot finish inside the 30s default, which made the check
 * fail on any sufficiently large repo with no way for an operator to pass it honestly.
 *
 * The cap is 10 minutes: one order of magnitude above the default, which is ample for a
 * single `session_brief` on a very large repo while still bounding a diagnostic that an
 * operator waits on interactively. A request ABOVE the cap is REFUSED, never silently
 * clamped (same rule as {@link EVIDENCE_COMMAND_TIMEOUT_CAP_MS} for F-012).
 *
 * Canonical single source of truth: the CLI schema (`command-catalog.ts`) and the
 * runtime re-validation in {@link resolveGlobalFallbackHeartbeatTimeoutMs} both use THIS
 * constant, so the Zod bound and the handler enforcement can never drift apart.
 */
export const GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS = 600_000;

/**
 * B-cdf6 (B-META F-013): minimum characters for `heartbeatTimeoutReason`.
 * Mirrors the F-012 `commandTimeoutReason` bar so a raised budget always explains itself.
 */
export const HEARTBEAT_TIMEOUT_REASON_MIN_CHARS = 30;

/**
 * B-cdf6 (B-META F-013): the audited override block for the global-fallback heartbeat.
 * Supplying `timeoutMs` REQUIRES a `reason`; both are echoed into the check detail so a
 * reviewer sees the budget the pass was earned under.
 */
export interface GlobalFallbackHeartbeatTimeoutOverride {
  timeoutMs: number;
  reason: string;
}

/**
 * B-cdf6 (B-META F-013): resolve + BOUND the global-fallback heartbeat budget.
 *
 * Per the Handler 编码约定 this is the runtime re-validation layer: the Zod bound in
 * `command-catalog.ts` is only the first line of defence, and this function is called at
 * the `runCodexAdapterChecks` entry so any Zod-bypassing path (internal fn call, stale
 * JSON, direct core import) is rejected on exactly the same terms.
 *
 * Rules (all REFUSALS, never a silent clamp or a silent downgrade to the default):
 * - non-finite / non-integer / non-positive `timeoutMs` → throw
 * - `timeoutMs` above {@link GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS} → throw
 * - `timeoutMs` without a `reason` of >= {@link HEARTBEAT_TIMEOUT_REASON_MIN_CHARS}
 *   trimmed chars → throw
 * - a `reason` with no `timeoutMs` → throw (a reason alone raises nothing, so accepting
 *   it silently would let an operator believe a budget was armed when it was not)
 *
 * With no override supplied the result is byte-identical to the pre-F-013 default.
 */
export function resolveGlobalFallbackHeartbeatTimeoutMs(
  override?: Partial<GlobalFallbackHeartbeatTimeoutOverride>,
  legacyTimeoutMs?: number,
): { timeoutMs: number; override?: GlobalFallbackHeartbeatTimeoutOverride } {
  const rawTimeout = override?.timeoutMs;
  const rawReason = override?.reason;
  const hasTimeout = rawTimeout !== undefined && rawTimeout !== null;
  const trimmedReason = typeof rawReason === 'string' ? rawReason.trim() : '';

  if (!hasTimeout) {
    if (trimmedReason.length > 0) {
      throw new Error(
        '[heartbeat_timeout_reason_without_override] heartbeatTimeoutReason was supplied without heartbeatTimeoutMs; '
        + 'a reason alone raises no budget. Pass both, or neither.',
      );
    }
    // No override: preserve the legacy single-knob behaviour exactly.
    return { timeoutMs: legacyTimeoutMs ?? DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS };
  }

  if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || !Number.isInteger(rawTimeout) || rawTimeout <= 0) {
    throw new Error(
      `[heartbeat_timeout_invalid] heartbeatTimeoutMs must be a positive integer number of milliseconds, got ${JSON.stringify(rawTimeout)}.`,
    );
  }
  if (rawTimeout > GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS) {
    throw new Error(
      `[heartbeat_timeout_above_cap] heartbeatTimeoutMs=${rawTimeout}ms exceeds the cap `
      + `${GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS}ms. This is REFUSED, not clamped: if a single session_brief truly `
      + 'needs longer than the cap, the repository scale itself is the defect to fix.',
    );
  }
  if (trimmedReason.length < HEARTBEAT_TIMEOUT_REASON_MIN_CHARS) {
    throw new Error(
      `[heartbeat_timeout_reason_too_short] heartbeatTimeoutReason must be >= ${HEARTBEAT_TIMEOUT_REASON_MIN_CHARS} `
      + `characters after trimming (got ${trimmedReason.length}); a raised heartbeat budget must be attributable.`,
    );
  }
  return { timeoutMs: rawTimeout, override: { timeoutMs: rawTimeout, reason: trimmedReason } };
}

/**
 * Resolve the preferred verify_codex command from available local wrappers.
 * Falls back to the documented global-thin command when local wrappers are intentionally absent.
 */
export function resolveLocalCodexVerifyCommand(root: string): string {
  if (isGlobalThinProject(root)) return GLOBAL_THIN_CODEX_VERIFY_COMMAND;
  // Canonical codex wrapper, then canonical bootstrap: whichever this checkout
  // actually has is what the operator is told to run. B-cc10 CHK-006 dropped the
  // deprecated-alias rows — telling an operator to run a deleted file would hand
  // them a command that cannot work.
  const candidates: Array<[string, string]> = [
    ['bin/proof-or-stop-codex.js', LOCAL_CODEX_VERIFY_COMMAND],
    ['bin/proof-or-stop.js',       LOCAL_MAIN_VERIFY_COMMAND],
  ];
  for (const [rel, cmd] of candidates) {
    if (existsSync(join(root, rel))) return cmd;
  }
  return LOCAL_CODEX_VERIFY_COMMAND;
}

export function resolveCodexSessionBriefCommand(root: string): string {
  if (isGlobalThinProject(root)) return `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`;
  const candidates: readonly string[] = [...LOCAL_CODEX_WRAPPERS, ...LOCAL_BOOTSTRAP_WRAPPERS];
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) return `node ${rel} session_brief`;
  }
  return `node ${LOCAL_CODEX_WRAPPERS[0]} session_brief`;
}

const CODEX_MATERIAL_PATHS = [
  // B-cc10 CHK-002: adapter material under BOTH dir spellings and BOTH manifest
  // filenames. This is a staleness-detection set, so a one-sided list would let
  // an edit to a deprecated-spelled adapter asset leave a stale verification
  // standing — the failure would be silent, which is why it is derived rather
  // than typed out.
  ...adapterDirCandidates('README.md'),
  ...adapterManifestCandidates(),
  ...adapterDirCandidates('agents'),
  '.codex/hooks.json',
  '.codex/hooks',
  '.claude/agents',
  'AGENTS.md',
  'README.md',
  // The canonical wrappers are adapter material: editing either changes what a Codex
  // session actually executes, so a stale verification must not survive a change to
  // them. B-cc10 CHK-006 removed the two deprecated alias entries along with the files
  // themselves — a path that cannot exist contributes nothing to staleness detection.
  'bin/proof-or-stop-codex.js',
  'bin/proof-or-stop.js',
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
  /**
   * B-cdf6 (B-META F-013): bounded audited override for the GLOBAL-FALLBACK heartbeat
   * budget only. Requires {@link heartbeatTimeoutReason}; validated (and REFUSED above
   * the cap) by {@link resolveGlobalFallbackHeartbeatTimeoutMs} at this entry, so a
   * Zod-bypassing internal caller is held to the same bounds as the CLI.
   *
   * Deliberately separate from the legacy `timeoutMs`, which collapses the local-wrapper
   * and global-fallback budgets into one knob: raising the global budget must not also
   * loosen the deliberately conservative 10s local wrapper probe.
   */
  heartbeatTimeoutMs?: number;
  heartbeatTimeoutReason?: string;
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

// B-75f0 CHK-002: `gitCwd` is the resolved git working dir (the caller computes
// it via resolveProjectGitCwd). On a wrapper-root layout it is the real gitRoot
// subdir so the snapshot's head hash reflects the actual repo; on a plain repo
// (or when no gitRoot resolves) it is the passed root verbatim. The `'unknown'`
// fallback on any git failure is preserved (temporary projects / unpacked
// packages that are not git worktrees still degrade gracefully).
function readGitHead(gitCwd: string): string {
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
  // B-75f0 CHK-002: this snapshot is id-independent (no storyId in scope), so
  // resolve the git cwd with the id-independent project-level resolver. On a
  // wrapper-root layout it resolves the REAL gitRoot (configured-gitRoot subdir
  // or metadata git toplevel — config is loaded so a configured subdir is
  // honored) so the head hash reflects the actual repo; on a plain repo (or when
  // no gitRoot resolves) it returns `root` verbatim, byte-identical to before.
  let gitCwd: string;
  try {
    gitCwd = resolveProjectGitCwd(root, root, loadConfig(root));
  } catch {
    gitCwd = root;
  }
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
    headHash: readGitHead(gitCwd),
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
  relPath: string;
}

const isGlobalThinProject = isManagedGlobalThinRoot;

/** Canonical adapter manifest relative path — the only one ever WRITTEN. */
const CANONICAL_CODEX_MANIFEST_REL = `${PROOF_OR_STOP_ADAPTER_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;
/** B-cc10 F-019: canonical state-dir manifest path for user-facing check messages. */
const CANONICAL_STATE_MANIFEST_REL = `${PROOF_OR_STOP_STATE_DIR}/${PROOF_OR_STOP_MANIFEST_FILENAME}`;

/** Resolve the canonical Codex adapter manifest. */
function resolveCodexManifest(root: string): CodexManifestSelection | null {
  for (const relPath of adapterManifestCandidates()) {
    if (!existsSync(join(root, relPath))) continue;
    return { relPath };
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
  // User-facing messages name the same canonical paths the resolver accepts.
  if (isGlobalThinProject(root)) {
    push(checks, 'manifest', 'Codex manifest', 'pass', true, `global-thin project: Codex adapter behavior runs from the global proof-or-stop CLI (${CANONICAL_STATE_MANIFEST_REL} present)`);
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
        `runtime-owned default: ${CANONICAL_CODEX_MANIFEST_REL} not required for package prompt registry (hash=${resolution.promptRegistryHash.slice(0, 12)})`,
      );
      return 'registry';
    }
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `missing ${CANONICAL_CODEX_MANIFEST_REL}`, LOCAL_INIT_VERIFY_COMMAND);
    return null;
  }
  const manifestPath = join(root, selection.relPath);
  const actual = readText(manifestPath);
  const expected = renderProofOrStopCodexAdapterManifest();
  const expectedIdentity = PROOF_OR_STOP_CODEX_ADAPTER_MANIFEST;
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
    !isCodexAdapterManifestOwner(parsed?.adapterOwner) ||
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
    const normalizedActualRegistry = normalizePromptRegistryManifest(actualRegistry);
    const actualSchemaVersion = canonicalPromptRegistrySchemaVersion(actualRegistry.schemaVersion);
    const mismatches = (['schemaVersion', 'source', 'agentCount', 'materialHash'] as const)
      .filter(key => (key === 'schemaVersion' ? actualSchemaVersion : normalizedActualRegistry?.[key]) !== expectedRegistry[key]);
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
    const expectedRegistryManifest = renderProofOrStopCodexAdapterManifest({ promptMode: 'registry' });
    const normalizedManifest = {
      ...parsed,
      promptRegistry: normalizedActualRegistry,
    };
    if (`${JSON.stringify(normalizedManifest, null, 2)}\n` !== expectedRegistryManifest) {
      push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} drifted from Proof-or-Stop registry template`, LOCAL_INIT_VERIFY_COMMAND);
      return 'registry';
    }
    push(checks, 'manifest', 'Codex manifest', 'pass', true, `${selection.relPath} uses registry prompt mode (${expectedRegistry.agentCount} prompt(s), hash=${expectedRegistry.materialHash.slice(0, 12)})`);
    return 'registry';
  }
  if (parsed.promptMode !== undefined && parsed.promptMode !== 'legacy-mirror') {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} has unsupported promptMode=${String(parsed.promptMode)}`, LOCAL_INIT_VERIFY_COMMAND);
    return null;
  }
  if (`${JSON.stringify(parsed, null, 2)}\n` !== expected) {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, `${selection.relPath} drifted from Proof-or-Stop template`, LOCAL_INIT_VERIFY_COMMAND);
    return 'legacy-mirror';
  }
  push(checks, 'manifest', 'Codex manifest', 'pass', true, `${selection.relPath} matches Proof-or-Stop template`);
  return 'legacy-mirror';
}

function checkAgentMirror(root: string, checks: CodexAdapterCheck[]): void {
  const claudeDir = join(root, '.claude', 'agents');
  // B-cc10 CHK-007: this READ was pinned to the deprecated adapter directory, so once
  // `init` was unified onto the canonical one this check reported "missing
  // .claude/agents or .proof-or-stop-codex/agents" on a freshly-inited project — a
  // fresh init failing its own verify_codex. Read-both: canonical first, deprecated
  // as the fallback, so an unmigrated project still verifies.
  const agentsRelDir = `${PROOF_OR_STOP_ADAPTER_DIR}/agents`;
  const codexDir = ADAPTER_DIR_NAMES
    .map((dir) => join(root, dir, 'agents'))
    .find((candidate) => existsSync(candidate))
    ?? join(root, PROOF_OR_STOP_ADAPTER_DIR, 'agents');
  if (!existsSync(claudeDir) || !existsSync(codexDir)) {
    push(checks, 'agents-mirror', 'Codex agents mirror', 'fail', true, `missing .claude/agents or ${agentsRelDir}`, LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  const sourceFiles = listAgentPromptFiles(claudeDir);
  const targetFiles = listAgentPromptFiles(codexDir);
  const targetSet = new Set(targetFiles);
  const sourceSet = new Set(sourceFiles);
  const issues: string[] = [];
  const registry = readPromptRegistry();
  const registryByFile = new Map(registry.agents.map(entry => [entry.file, entry]));
  for (const file of sourceFiles) {
    const registryEntry = registryByFile.get(file);
    if (!registryEntry) {
      issues.push(`unregistered .claude/agents/${file}`);
      continue;
    }
    const claudePrompt = readText(join(claudeDir, file));
    const expectedClaude = renderPromptEntryForHost(registryEntry, 'claude');
    if (expectedClaude !== claudePrompt) {
      issues.push(`package/Claude drift ${file}`);
      continue;
    }
    const targetPath = join(codexDir, file);
    if (!targetSet.has(file)) {
      issues.push(`missing ${agentsRelDir}/${file}`);
      continue;
    }
    const expected = renderPromptEntryForHost(registryEntry, 'codex');
    const actual = readText(targetPath);
    if (expected !== actual) issues.push(`drift ${agentsRelDir}/${file}`);
  }
  for (const file of registryByFile.keys()) {
    if (!sourceSet.has(file)) issues.push(`missing .claude/agents/${file}`);
  }
  for (const file of targetFiles) {
    if (!sourceSet.has(file)) issues.push(`stale ${agentsRelDir}/${file}`);
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
  const offenders = PROOF_OR_STOP_CODEX_ADAPTER_MANIFEST.excludedRuntimeAssets.filter(asset => existsSync(join(root, asset)));
  const lowerHooks = join(root, '.codex', 'hooks');
  // B-cc10 CHK-002: check the hooks-alias exclusion under EVERY accepted adapter
  // dir spelling. Checking one spelling would let the offending directory hide
  // under the other name and report a false 'pass'.
  for (const hooksRel of adapterDirCandidates('hooks')) {
    const upperHooks = join(root, hooksRel);
    if (!existsSync(upperHooks)) continue;
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
    if (!isLowercaseAlias) offenders.push(hooksRel);
  }
  if (offenders.length > 0) {
    push(checks, 'excluded-assets', 'Codex runtime exclusions', 'fail', true, `unexpected asset(s): ${offenders.join(', ')}`, `rm -rf ${offenders.join(' ')}`);
    return;
  }
  push(checks, 'excluded-assets', 'Codex runtime exclusions', 'pass', true, `no uppercase-only ${PROOF_OR_STOP_ADAPTER_DIR}/hooks or ${PROOF_OR_STOP_ADAPTER_DIR}/settings.json`);
}

function hookEntriesContainCommand(entries: unknown, commandNeedle: string): boolean {
  return Array.isArray(entries) && entries.some((entry: any) =>
    Array.isArray(entry?.hooks)
    && entry.hooks.some((hook: any) => hook?.type === 'command' && String(hook?.command || '').includes(commandNeedle)));
}

function checkCodexNativeHooks(root: string, checks: CodexAdapterCheck[]): void {
  const hooksJsonPath = join(root, '.codex', 'hooks.json');
  const hookScriptPath = join(root, '.codex', 'hooks', 'proof-or-stop-scope-pretool.cjs');
  if (!existsSync(hooksJsonPath)) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, 'missing .codex/hooks.json with Proof-or-Stop PreToolUse hook', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }
  if (!existsSync(hookScriptPath)) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, 'missing .codex/hooks/proof-or-stop-scope-pretool.cjs', LOCAL_INIT_VERIFY_COMMAND);
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
  if (!hasMatcher || !hookEntriesContainCommand(preToolUse, '.codex/hooks/proof-or-stop-scope-pretool.cjs')) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, '.codex/hooks.json does not wire proof-or-stop-scope-pretool.cjs for apply_patch/Edit/Write', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }

  const hookScript = readText(hookScriptPath);
  if (!/provider:\s*['"]codex['"]/.test(hookScript) || !hookScript.includes('prewrite_guard_check')) {
    push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'fail', true, '.codex/hooks/proof-or-stop-scope-pretool.cjs does not delegate to prewrite_guard_check as provider=codex', LOCAL_INIT_VERIFY_COMMAND);
    return;
  }

  push(checks, 'codex-native-hooks', 'Codex native PreToolUse hook', 'pass', true, '.codex/hooks.json wires apply_patch/Edit/Write to proof-or-stop-scope-pretool.cjs');
}

function activityForEntrypoint(root: string, tool: string, entrypoint: string): Record<string, unknown> | null {
  return [...readActivityLogTail(root, 200)]
    .reverse()
    .find(entry => entry.tool === tool && entry.entrypoint === entrypoint) || null;
}

/**
 * B-cdf6 (B-META F-013): did the child get KILLED by our own timeout, rather than
 * exiting on its own with a real error?
 *
 * `execFileSync` surfaces a timeout kill as `code === 'ETIMEDOUT'`; Node also sets
 * `signal` to the kill signal (SIGTERM by default) and may set `killed`. Any one of
 * those is sufficient evidence, so all three are accepted: a heartbeat that was killed
 * has no chance to print its verdict, so reporting it as a generic "command failed" (the
 * F-013 misdiagnosis: the stderr progress line `[0.1s] running session_brief...` was
 * shown as if it were the failure reason) actively misleads the operator into hunting a
 * brand/adapter defect instead of raising the budget.
 */
function isTimeoutKill(e: any): boolean {
  return e?.code === 'ETIMEDOUT'
    || e?.signal === 'SIGTERM'
    || e?.signal === 'SIGKILL'
    || e?.killed === true;
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
  timeoutOverride?: GlobalFallbackHeartbeatTimeoutOverride,
): void {
  // B-cdf6:F-039 — this fallback hardcoded the deprecated `bin/proof-or-stop-codex.js`,
  // against the canonical-name-first convention the rest of this file follows. It is
  // currently unreachable (every call site for this id supplies displayCommand), but
  // an unreachable string that teaches the old bin name is still a trap for the next
  // maintainer and for anyone grepping for remaining aliases. Derived from
  // LOCAL_CODEX_WRAPPERS[0] so it tracks the canonical wrapper automatically.
  const retryCommand = displayCommand || (
    id === 'local-wrapper-heartbeat'
      ? `node ${LOCAL_CODEX_WRAPPERS[0]} session_brief`
      : `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`
  );
  const startedAt = Date.now();
  try {
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: applyBrandEnv({
        ...process.env,
        CODEX_THREAD_ID: id === 'local-wrapper-heartbeat' ? session : '',
        PROOF_OR_STOP_AGENT: 'main',
      }, {
        ACTIVITY_SOURCE: id === 'local-wrapper-heartbeat' ? 'not-codex' : 'codex',
        ACTIVITY_RECORD_READONLY: '1',
        ACTIVITY_SESSION: session,
        CODEX_ENTRYPOINT: expectedEntrypoint,
      }),
    });
  } catch (e: any) {
    // B-cdf6 (B-META F-013): a KILLED heartbeat is a distinct failure from a heartbeat
    // that ran and reported an error. Name the budget it was killed at and the remedy,
    // instead of printing the truncated progress line as if it were the cause.
    if (isTimeoutKill(e)) {
      const elapsedMs = Date.now() - startedAt;
      const isGlobalFallback = id === 'global-fallback-heartbeat';
      const remedy = isGlobalFallback
        ? ` Raise the budget for this run with --heartbeatTimeoutMs=<ms> (cap ${GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_CAP_MS}ms) plus `
          + `--heartbeatTimeoutReason='<>= ${HEARTBEAT_TIMEOUT_REASON_MIN_CHARS} chars explaining why this repo needs longer>'.`
        : '';
      push(
        checks,
        id,
        label,
        'fail',
        true,
        `[heartbeat_command_timeout] heartbeat did not finish within the armed budget of ${timeoutMs}ms `
        + `(killed after ~${elapsedMs}ms). The command was killed before it could print a verdict, so this is a BUDGET `
        + `outcome, not evidence that the entrypoint is broken. On a large repository session_brief aggregates every `
        + `active story before writing its heartbeat, so its cost scales with repository size.${remedy}`,
        retryCommand,
      );
      return;
    }
    const stderr = e?.stderr?.toString?.().trim() || '';
    if (/^(?:Error:[ \t]*)?CLI_RUNTIME_VERSION_(?:MISMATCH|METADATA_INVALID):/m.test(stderr)) {
      push(checks, id, label, 'fail', true,
        `[heartbeat_runtime_version_mismatch] Repair the CLI installation identified below before retrying heartbeat; see docs/cli-runtime-sync.md. This failure does not establish a Codex adapter defect.\n${stderr}`,
        retryCommand);
      return;
    }
    push(checks, id, label, 'fail', true, `heartbeat command failed: ${stderr || e?.message || e}`, retryCommand);
    return;
  }

  // B-cdf6 (B-META F-013): a raised budget is an exceptional act, so every verdict earned
  // under one says so. Appended to the DETAIL (not swapped in) so the existing assertions
  // on these strings keep matching, and empty when no override was armed.
  const armedSuffix = timeoutOverride
    ? ` (heartbeatTimeoutMs=${timeoutOverride.timeoutMs}ms override armed, default `
      + `${DEFAULT_GLOBAL_FALLBACK_HEARTBEAT_TIMEOUT_MS}ms; reason: ${timeoutOverride.reason})`
    : '';

  const record = activityForEntrypoint(root, 'session_brief', expectedEntrypoint);
  if (!record) {
    push(checks, id, label, 'fail', true, 'no activity heartbeat with the expected entrypoint', retryCommand);
    return;
  }
  const opaqueSession = typeof record.session === 'string' ? record.session : '';
  if (!/^sess-[a-f0-9]+$/.test(opaqueSession) || opaqueSession === session) {
    if (id === 'global-fallback-heartbeat') {
      push(
        checks,
        id,
        label,
        'warn',
        false,
        'installed global proof-or-stop still reports a legacy raw heartbeat identity; upgrade the global CLI before using it for owner coordination',
        retryCommand,
      );
      return;
    }
    push(checks, id, label, 'fail', true, 'activity heartbeat did not redact the raw host task/session token', retryCommand);
    return;
  }
  if (JSON.stringify(readActivityLogTail(root, 20)).includes(session)) {
    push(checks, id, label, 'fail', true, 'raw host task/session token leaked into recent activity events', retryCommand);
    return;
  }
  if (record.source !== 'codex') {
    push(checks, id, label, 'fail', true, `activity source=${String(record.source)} expected codex`, retryCommand);
    return;
  }
  if (!record.entrypoint && expectedEntrypoint === 'global-fallback') {
    push(checks, id, label, 'pass', true, `source=codex session=${opaqueSession}; installed global CLI has no entrypoint field yet${armedSuffix}`);
    return;
  }
  if (record.entrypoint !== expectedEntrypoint) {
    push(checks, id, label, 'fail', true, `entrypoint=${String(record.entrypoint)} expected ${expectedEntrypoint}`, retryCommand);
    return;
  }
  push(checks, id, label, 'pass', true, `source=codex session=${opaqueSession} entrypoint=${expectedEntrypoint}${armedSuffix}`);
}

function isPackagedDesktopRuntime(): boolean {
  return readBrandEnv('DESKTOP_PACKAGED_RUNTIME') === '1'
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

/**
 * Locate the canonical globally installed CLI on PATH.
 */
function resolveGlobalCliCommandPath(root: string): string | null {
  const command = process.platform === 'win32' ? 'where' : 'sh';
  const args = process.platform === 'win32'
    ? [PROOF_OR_STOP_PRIMARY_BIN]
    : ['-c', `command -v ${PROOF_OR_STOP_PRIMARY_BIN}`];
  try {
    const out = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2_000,
      env: process.env,
    }).trim();
    return out.split(/\r?\n/).find(Boolean) ?? null;
  } catch {
    // Probe: the canonical global CLI is not on PATH.
  }
  // No canonical global CLI on PATH; heartbeat execution reports the real failure.
  return null;
}

/**
 * Read a wrapper's text, concatenating any sibling wrapper it re-exports.
 *
 * A wrapper may hold no behaviour of its own and simply `import` a canonical sibling,
 * in which case the env contract lives one hop away. (B-cdf6's `bin/proof-or-stop-codex.js`
 * alias was exactly that shape; B-cc10 CHK-006 removed it, but the delegation-following
 * remains correct for any future thin wrapper.) Only relative sibling imports inside
 * `bin/` are followed, and only one hop, so this cannot be used to satisfy the check
 * from an arbitrary file.
 */
function readWrapperTextFollowingDelegation(root: string, wrapperRelPath: string): string {
  const wrapperAbs = join(root, wrapperRelPath);
  let text = readText(wrapperAbs);
  const delegated = new Set<string>();
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+['"]\.\/([A-Za-z0-9._-]+\.[cm]?js)['"]/g)) {
    delegated.add(match[1]);
  }
  const binDir = wrapperRelPath.split('/').slice(0, -1).join('/');
  for (const sibling of delegated) {
    const siblingAbs = join(root, binDir, sibling);
    if (!existsSync(siblingAbs)) continue;
    try {
      text += `\n${readText(siblingAbs)}`;
    } catch {
      // probe: unreadable sibling just means no extra evidence; the base text still applies.
    }
  }
  return text;
}

function checkLocalWrapper(root: string, checks: CodexAdapterCheck[], executeHeartbeats: boolean, timeoutMs: number): void {
  // Global-thin projects: executable Codex adapter behavior lives in the global proofOrStop CLI.
  // Local wrapper is not required regardless of whether legacy bin/ files exist.
  if (isGlobalThinProject(root)) {
    push(checks, 'local-wrapper', 'Local Codex wrapper', 'pass', true, 'global-thin project: local wrapper not required; use global proof-or-stop codex verify / proof-or-stop codex doctor');
    return;
  }
  // Resolve whichever wrapper name this checkout has, canonical preferred, and verify
  // against the file it actually executes. B-cc10 CHK-006 removed the deprecated alias,
  // so the canonical name is now the only accepted one.
  const wrapperRelPath = resolveWrapperRelPath(root, LOCAL_CODEX_WRAPPERS);
  const bootstrapRelPath = resolveWrapperRelPath(root, LOCAL_BOOTSTRAP_WRAPPERS);
  const wrapper = join(root, wrapperRelPath);
  const localBootstrap = join(root, bootstrapRelPath);
  if (!existsSync(wrapper)) {
    push(
      checks,
      'local-wrapper',
      'Local Codex wrapper',
      'fail',
      true,
      `missing local Codex wrapper (looked for: ${LOCAL_CODEX_WRAPPERS.join(', ')})`,
      LOCAL_INIT_VERIFY_COMMAND,
    );
    return;
  }
  // A retained deprecated alias may hold no behaviour of its own and simply
  // `import` its canonical sibling (that is how B-cdf6 keeps the two from drifting).
  // Verify the env contract on whichever file actually sets it, so a thin alias is
  // not reported as a wrapper "missing PROOF_OR_STOP_ACTIVITY_SOURCE".
  const text = readWrapperTextFollowingDelegation(root, wrapperRelPath);
  // B-cdf6: this is a STATIC text check over generated wrapper source, so it must
  // accept both the pre-rename literal spelling AND the post-rename composed form.
  // The generated wrapper no longer contains the literal `PROOF_OR_STOP_ACTIVITY_SOURCE`:
  // it emits `setEnv('ACTIVITY_SOURCE', 'codex')`, whose helper writes BOTH brand
  // prefixes at runtime. Grepping only the old literal reported a wrapper that is
  // functionally correct as "missing PROOF_OR_STOP_ACTIVITY_SOURCE". Each entry below is
  // satisfied by ANY of its accepted spellings; a wrapper that sets none of them
  // still fails, so the contract is unchanged — only its spelling tolerance widened.
  const required: ReadonlyArray<readonly string[]> = [
    ['PROOF_OR_STOP_ACTIVITY_SOURCE', 'PROOF_OR_STOP_ACTIVITY_SOURCE', "setEnv('ACTIVITY_SOURCE'"],
    ['codex'],
    ['PROOF_OR_STOP_ACTIVITY_RECORD_READONLY', 'PROOF_OR_STOP_ACTIVITY_RECORD_READONLY', "setEnv('ACTIVITY_RECORD_READONLY'"],
    ['PROOF_OR_STOP_CODEX_ENTRYPOINT', 'PROOF_OR_STOP_CODEX_ENTRYPOINT', "setEnv('CODEX_ENTRYPOINT'"],
  ];
  const missing = required
    .filter(accepted => !accepted.some(piece => text.includes(piece)))
    .map(accepted => accepted[0]);
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
        'packaged runtime uses embedded Proof-or-Stop; wrapper env contract verified without external Node',
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

function checkGlobalFallback(
  root: string,
  checks: CodexAdapterCheck[],
  executeHeartbeats: boolean,
  timeoutMs: number,
  timeoutOverride?: GlobalFallbackHeartbeatTimeoutOverride,
): void {
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
      'skipped in packaged desktop runtime; standalone binaries do not require a global proof-or-stop command',
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
      { path: join(globalRoot, '@proof-or-stop', 'core'), label: '@proof-or-stop/core' },
    ];
    const globalCore = globalCoreCandidates.find(candidate => existsSync(candidate.path));
    if (existsSync(currentCore) && globalCore) {
      const currentReal = realpathSync(currentCore);
      const globalReal = realpathSync(globalCore.path);
      const proofOrStopCommand = resolveGlobalCliCommandPath(root);
      const proofOrStopReal = proofOrStopCommand && existsSync(proofOrStopCommand) ? realpathSync(proofOrStopCommand) : '';
      const actualProofOrStopUsesGlobalCore = !!proofOrStopReal && pathContains(globalReal, proofOrStopReal);
      if (actualProofOrStopUsesGlobalCore && currentReal !== globalReal) {
        push(
          checks,
          'global-fallback-heartbeat',
          'Global fallback heartbeat',
          'warn',
          false,
          `global ${globalCore.label} resolves to ${globalReal}, not current worktree ${currentReal}; treat global proof-or-stop as heartbeat-only, not current-worktree gate/status evidence`,
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
    // B-cc10 F-057: fall back to the CANONICAL bin. This fell back to executing 'proof-or-stop',
    // which CHK-006 deleted, so on a machine whose global shim still points at a migrated
    // checkout the heartbeat probe fails with 'Cannot find module .../bin/proofOrStop.js'. Line
    // 814 above legitimately probes BOTH names when DISCOVERING an installed CLI; this site
    // is different — it picks the command to EXECUTE, so it must name the one that exists.
    resolveGlobalCliCommandPath(root) ?? PROOF_OR_STOP_PRIMARY_BIN,
    ['session_brief'],
    `codex-check-global-${Date.now()}`,
    'global-fallback',
    timeoutMs,
    undefined,
    timeoutOverride,
  );
}

function checkAuxAvailability(checks: CodexAdapterCheck[], registryNames?: Set<string>): void {
  if (!registryNames) {
    push(checks, 'aux-availability', 'Aux command availability', 'warn', false, 'registry not provided; run through proof-or-stop doctor for live command inventory');
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
  const localHeartbeatTimeoutMs = options.timeoutMs ?? DEFAULT_CODEX_HEARTBEAT_TIMEOUT_MS;
  // B-cdf6 (B-META F-013): runtime re-validation boundary. Throws (never clamps) on an
  // out-of-bounds / unattributed override, including on paths that never touched Zod.
  const resolvedGlobalHeartbeat = resolveGlobalFallbackHeartbeatTimeoutMs(
    { timeoutMs: options.heartbeatTimeoutMs, reason: options.heartbeatTimeoutReason },
    options.timeoutMs,
  );
  const globalFallbackHeartbeatTimeoutMs = resolvedGlobalHeartbeat.timeoutMs;
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
  checkLocalWrapper(root, checks, executeLocalHeartbeat, localHeartbeatTimeoutMs);
  checkGlobalFallback(
    root,
    checks,
    executeGlobalHeartbeat,
    globalFallbackHeartbeatTimeoutMs,
    resolvedGlobalHeartbeat.override,
  );
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

/** Escape a literal for safe interpolation into a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which story text counts as "touches the Codex adapter", and therefore requires
 * Codex adapter evidence at the REVIEW->TEST gate.
 *
 * B-cc10 CHK-002: built from {@link ADAPTER_DIR_NAMES} rather than hardcoding the
 * adapter directory spelling. This is a GATE-ARMING decision, and a brand literal
 * inside a regex is the exact B-cdf6 F-062 regression shape: with the old spelling
 * hardcoded, a story naming the CANONICAL directory would silently fail to match,
 * so the codex-adapter gate would quietly stop arming for precisely the stories
 * that migrate the adapter. Failing that way is invisible — the gate reports
 * nothing rather than reporting a miss.
 */
function codexTouchpointPattern(): RegExp {
  const dirAlternatives = ADAPTER_DIR_NAMES.flatMap((dir) => {
    const bare = dir.replace(/^\./, '');
    return [escapeRegExp(dir), escapeRegExp(bare)];
  });
  const binAlternatives = ADAPTER_DIR_NAMES.map((dir) =>
    escapeRegExp(`bin/${dir.replace(/^\./, '')}.js`),
  );
  const alternatives = [
    ...dirAlternatives,
    ...binAlternatives,
    'codex adapter',
    'verify_codex',
    '\\.codex\\/hooks(?:\\.json)?',
    'proof-or-stop codex (?:verify|doctor)',
  ];
  return new RegExp(`(?:${alternatives.join('|')})`, 'i');
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
    return codexTouchpointPattern().test(haystack);
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
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
