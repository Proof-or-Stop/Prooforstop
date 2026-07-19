import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPromptRegistry,
  renderPromptEntryForHost,
  type PromptHost,
  type PromptRegistryEntry,
  type PromptRegistrySnapshot,
} from './prompt-registry.js';

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
  schemaVersion: 'lattice.agent_asset_resolution.v1';
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

const HOST_ASSET_DIRS: Array<{ host: PromptHost; relDir: string }> = [
  { host: 'claude', relDir: '.claude/agents' },
  { host: 'codex', relDir: '.lattice-codex/agents' },
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
  const candidates = [
    join(projectRoot, '.lattice', 'lattice.json'),
    join(projectRoot, '.Lattice', 'lattice.json'),
    join(projectRoot, '.lattice-codex', 'lattice.json'),
  ];
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
      normalizeRel(relative(projectRoot, candidate)) === '.lattice-codex/lattice.json' &&
      parsed.adapterOwner === 'lattice' &&
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
    result.set(entry.file, { entry, content, hash: sha256(content) });
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
    schemaVersion: 'lattice.agent_asset_resolution.v1',
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
