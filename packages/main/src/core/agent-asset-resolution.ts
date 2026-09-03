import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILENAMES, adapterManifestCandidates, stateDirCandidates, ADAPTER_DIR_NAMES } from './brand-paths.js';
import {
  readPromptRegistry,
  renderPromptEntryForHost,
  type PromptHost,
  type PromptRegistryEntry,
  type PromptRegistrySnapshot,
} from './prompt-registry.js';
import { legacyAgentRoleIds } from './agent-role-identity.js';
import { isCodexAdapterManifestOwner } from '../init-assets.js';
import { AGENT_ASSET_RESOLUTION_SCHEMA } from './artifact-schema.js';

export type AgentAssetResolutionMode = 'runtime-owned' | 'pinned-runtime' | 'full-asset' | 'debug-override';
export type AgentAssetStatus = 'absent' | 'matches-runtime' | 'stale' | 'override';

export interface AgentAssetResolutionAsset {
  path: string;
  host: PromptHost;
  status: AgentAssetStatus;
  expectedHash?: string;
  actualHash?: string;
  agentId?: string;
}

export interface AgentAssetResolutionBoundary {
  kind: 'localNonAuthorityAudit';
  text: string;
}

export interface AgentAssetResolution {
  schemaVersion: typeof AGENT_ASSET_RESOLUTION_SCHEMA;
  projectRoot: string;
  runtimeCliPath: string;
  runtimePackageRoot: string;
  promptRegistryHash: string;
  mode: AgentAssetResolutionMode;
  projectPromptAssets: AgentAssetResolutionAsset[];
  blockingIssues: string[];
  warnings: string[];
  authorityBoundary: AgentAssetResolutionBoundary;
}

interface LocalAssetModeHint {
  mode: AgentAssetResolutionMode | null;
  source: string | null;
}

// B-cc10 F-022: the codex entry hardcoded the DEPRECATED adapter dir, so on a migrated
// project (canonical .proof-or-stop-codex only) inspectHostAssets always reported codex
// prompt assets as ABSENT — which is what doctor's agentAssetMode reads. Enumerate every
// accepted spelling, canonical first, the same way localAssetModeHint already does.
const HOST_ASSET_DIRS: Array<{ host: PromptHost; relDir: string }> = [
  { host: 'claude', relDir: '.claude/agents' },
  ...ADAPTER_DIR_NAMES.map((dir) => ({ host: 'codex' as PromptHost, relDir: `${dir}/agents` })),
];

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeMode(value: unknown): AgentAssetResolutionMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'runtime-owned' || normalized === 'global-thin' || normalized === 'thin' || normalized === 'registry') {
    return 'runtime-owned';
  }
  if (normalized === 'pinned-runtime' || normalized === 'pinned') return 'pinned-runtime';
  if (normalized === 'full-asset' || normalized === 'full' || normalized === 'legacy-mirror' || normalized === 'local') {
    return 'full-asset';
  }
  if (normalized === 'debug-override' || normalized === 'debug' || normalized === 'override') return 'debug-override';
  return null;
}

function localAssetModeHint(projectRoot: string): LocalAssetModeHint {
  // B-cc10 CHK-002: probe every accepted state-dir / adapter-dir / manifest
  // spelling, canonical first, so the asset-mode hint still resolves across the
  // rename. `.proof-or-stop` stays explicit — a case variant, not a brand identity.
  const candidates = [
    ...MANIFEST_FILENAMES.flatMap(file =>
      stateDirCandidates(file).map(rel => join(projectRoot, rel))),
    // B-cc10 CHK-004: the `.proof-or-stop` case variant must accept BOTH manifest
    // filenames. Pinning the deprecated one meant a `.proof-or-stop` root whose
    // manifest HAD been migrated stopped resolving — the rename breaking the
    // newer layout while the older kept working (backwards B-cdf6 direction).
    ...MANIFEST_FILENAMES.map(file => join(projectRoot, '.proof-or-stop', file)),
    ...adapterManifestCandidates().map(rel => join(projectRoot, rel)),
  ].filter((value, index, all) => all.indexOf(value) === index);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = readJson(candidate);
    if (!parsed) continue;
    const mode = normalizeMode(parsed.agentAssetMode)
      ?? normalizeMode(parsed.assetMode)
      ?? normalizeMode(parsed.promptMode);
    if (mode) {
      return { mode, source: normalizeRel(relative(projectRoot, candidate)) };
    }
    if (
      // B-cc10 CHK-002: match against EVERY accepted adapter-manifest spelling.
      // A hardcoded deprecated path here is the B-cdf6 F-068 shape: the CANONICAL
      // spelling would silently fail this branch and fall through to the wrong
      // asset mode.
      adapterManifestCandidates().includes(normalizeRel(relative(projectRoot, candidate))) &&
      parsed.adapterOwner === 'proof-or-stop' &&
      parsed.adapterKind === 'codex' &&
      parsed.promptMode === undefined
    ) {
      return { mode: 'full-asset', source: normalizeRel(relative(projectRoot, candidate)) };
    }
    if (parsed.debugOverride === true || parsed.promptOverride === true) {
      return { mode: 'debug-override', source: normalizeRel(relative(projectRoot, candidate)) };
    }
  }
  return { mode: null, source: null };
}

function normalizeRel(path: string): string {
  return path.split('\\').join('/');
}

function listMarkdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(file => file.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function expectedByFile(registry: PromptRegistrySnapshot, host: PromptHost): Map<string, { entry: PromptRegistryEntry; content: string; hash: string }> {
  const result = new Map<string, { entry: PromptRegistryEntry; content: string; hash: string }>();
  for (const entry of registry.agents) {
    const content = renderPromptEntryForHost(entry, host);
    const expected = { entry, content, hash: sha256(content) };
    result.set(entry.file, expected);
    for (const legacyRole of legacyAgentRoleIds(entry.agentId)) {
      result.set(`${legacyRole}.md`, expected);
    }
  }
  return result;
}

function inspectHostAssets(
  projectRoot: string,
  registry: PromptRegistrySnapshot,
  host: PromptHost,
  relDir: string,
  modeHint: LocalAssetModeHint,
): AgentAssetResolutionAsset[] {
  const dir = join(projectRoot, relDir);
  if (!existsSync(dir)) {
    return [{ path: relDir, host, status: 'absent' }];
  }
  try {
    if (!statSync(dir).isDirectory()) {
      return [{ path: relDir, host, status: 'override', actualHash: sha256(readFileSync(dir, 'utf8')) }];
    }
  } catch {
    return [{ path: relDir, host, status: 'override' }];
  }

  const expected = expectedByFile(registry, host);
  const files = listMarkdownFiles(dir);
  if (files.length === 0) return [{ path: relDir, host, status: 'absent' }];

  return files.map((file): AgentAssetResolutionAsset => {
    const relPath = `${relDir}/${file}`;
    const actual = readFileSync(join(dir, file), 'utf8');
    const actualHash = sha256(actual);
    const expectedAsset = expected.get(file);
    if (!expectedAsset) {
      return { path: relPath, host, status: 'override', actualHash };
    }
    if (actualHash === expectedAsset.hash) {
      return {
        path: relPath,
        host,
        status: 'matches-runtime',
        agentId: expectedAsset.entry.agentId,
        expectedHash: expectedAsset.hash,
        actualHash,
      };
    }
    return {
      path: relPath,
      host,
      status: modeHint.mode === 'debug-override' ? 'override' : 'stale',
      agentId: expectedAsset.entry.agentId,
      expectedHash: expectedAsset.hash,
      actualHash,
    };
  });
}

function hasMaterialPromptAssets(assets: AgentAssetResolutionAsset[]): boolean {
  return assets.some(asset => asset.status !== 'absent');
}

function resolveMode(assets: AgentAssetResolutionAsset[], modeHint: LocalAssetModeHint): AgentAssetResolutionMode {
  if (modeHint.mode === 'debug-override' || modeHint.mode === 'pinned-runtime') return modeHint.mode;
  if (modeHint.mode === 'full-asset') return 'full-asset';
  if (hasMaterialPromptAssets(assets)) return 'full-asset';
  return 'runtime-owned';
}

export function resolveAgentAssetResolution(projectRoot: string): AgentAssetResolution {
  const root = join(projectRoot);
  const runtimePackageRoot = packageRoot();
  const registry = readPromptRegistry();
  const modeHint = localAssetModeHint(root);
  const projectPromptAssets = HOST_ASSET_DIRS.flatMap(({ host, relDir }) =>
    inspectHostAssets(root, registry, host, relDir, modeHint));
  const mode = resolveMode(projectPromptAssets, modeHint);
  const staleAssets = projectPromptAssets.filter(asset => asset.status === 'stale');
  const overrideAssets = projectPromptAssets.filter(asset => asset.status === 'override');
  const duplicateAssets = projectPromptAssets.filter(asset => asset.status === 'matches-runtime');
  const warnings: string[] = [];

  if (modeHint.source && modeHint.mode && modeHint.mode !== 'runtime-owned') {
    warnings.push(`explicit ${mode} prompt asset mode from ${modeHint.source}`);
  }
  if (staleAssets.length > 0) {
    warnings.push(`${staleAssets.length} project-local prompt asset(s) differ from the runtime registry`);
  }
  if (overrideAssets.length > 0) {
    warnings.push(`${overrideAssets.length} project-local prompt asset override(s) are not generated from the runtime registry`);
  }
  if (mode === 'runtime-owned' && duplicateAssets.length > 0) {
    warnings.push(`${duplicateAssets.length} matching prompt asset copy/copies duplicate the runtime registry`);
  }

  return {
    schemaVersion: AGENT_ASSET_RESOLUTION_SCHEMA,
    projectRoot: root,
    runtimeCliPath: join(runtimePackageRoot, 'dist', 'cli.js'),
    runtimePackageRoot,
    promptRegistryHash: registry.materialHash,
    mode,
    projectPromptAssets,
    blockingIssues: [],
    warnings,
    authorityBoundary: {
      kind: 'localNonAuthorityAudit',
      text: 'This projection is a local admissibility audit of prompt asset ownership; lifecycle completion stays with local gate evidence, receipt bundles, and review quorum.',
    },
  };
}

export function summarizeAgentAssetResolution(resolution: AgentAssetResolution): string {
  const counts = resolution.projectPromptAssets.reduce<Record<AgentAssetStatus, number>>((acc, asset) => {
    acc[asset.status] += 1;
    return acc;
  }, { absent: 0, 'matches-runtime': 0, stale: 0, override: 0 });
  return [
    `mode=${resolution.mode}`,
    `promptRegistryHash=${resolution.promptRegistryHash.slice(0, 12)}`,
    `assets absent=${counts.absent} matches-runtime=${counts['matches-runtime']} stale=${counts.stale} override=${counts.override}`,
    `authorityBoundary=${resolution.authorityBoundary.kind}`,
  ].join('; ');
}
