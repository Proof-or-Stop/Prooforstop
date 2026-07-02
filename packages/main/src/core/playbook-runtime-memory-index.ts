/**
 * @task B-ec3b
 * @checklist CHK-002
 * @title Derived runtime memory index
 * @type feature
 * @priority high
 * @description Rebuild a disposable, non-authoritative index for runtime memory
 * and playbook lookup. The index is a cache over source memory files, not proof.
 * @changes
 * - [CHK-002] Add atomic temp-build/validate/swap index rebuild semantics.
 * - [CHK-003] Provide indexed candidate selection for runtime pack parity.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { digestCanonicalJson, digestText } from './digest.js';
import {
  buildSupersessionProjection,
  getSupersessionStatus,
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  resolveGlobalMemoryReadPaths,
  resolveProjectMemoryReadPaths,
  type DevMemoryEntry,
} from './dev-memory.js';
import type { Playbook } from './experience-layer-types.js';
import {
  computePlaybookDigest,
  readPlaybooks,
  readSignatureRegistry,
  resolveLearningDir,
  resolvePlaybooksPath,
  resolveSignatureRegistryPath,
  validatePlaybook,
  type SignatureTagEntry,
} from './learning-store.js';

export const RUNTIME_MEMORY_INDEX_SCHEMA_VERSION = 'proofbound.runtime-memory-index.v1' as const;

export interface RuntimeMemoryIndexSourceDigests {
  projectDevMemoryDigest: string | null;
  globalDevMemoryDigest: string | null;
  playbookDigest: string | null;
  signatureRegistryDigest: string | null;
}

export interface RuntimeMemoryIndexManifest {
  schemaVersion: typeof RUNTIME_MEMORY_INDEX_SCHEMA_VERSION;
  builtAt: string;
  projectRoot: string;
  indexVersion: string;
  sourceDigests: RuntimeMemoryIndexSourceDigests;
  recordCounts: {
    devMemory: number;
    playbooks: number;
    signatureTags: number;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
  manifestDigest: string;
}

export interface RuntimeMemoryIndex {
  schemaVersion: typeof RUNTIME_MEMORY_INDEX_SCHEMA_VERSION;
  manifest: RuntimeMemoryIndexManifest;
  devMemoryEntries: DevMemoryEntry[];
  playbooks: Playbook[];
  signatureTags: SignatureTagEntry[];
  tokenToDevMemoryIds: Record<string, string[]>;
  tokenToPlaybookIds: Record<string, string[]>;
  playbookStatusIds: Record<string, string[]>;
  supersededByDevMemoryIds: Record<string, string[]>;
}

export interface RuntimeMemoryIndexCandidates {
  devMemoryEntries: DevMemoryEntry[];
  playbooks: Playbook[];
  signatureTags: SignatureTagEntry[];
}

export interface RuntimeMemoryIndexValidation {
  ok: boolean;
  reason?: string;
}

interface RuntimeMemoryIndexCandidateOptions {
  query?: string;
  consumer?: string;
  storyPhase?: string;
  touchedPaths?: string[];
  host?: string;
  maxEntries?: number;
  maxPlaybooks?: number;
  candidateLimit?: number;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort();
}

function uniqueInOrder(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function tokenize(text: string): string[] {
  return uniqueSorted((text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []));
}

function fileKind(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx + 1).toLowerCase() : 'noext';
}

function digestFiles(paths: string[]): string | null {
  const parts: string[] = [];
  for (const path of uniqueSorted(paths)) {
    if (!existsSync(path)) continue;
    try {
      parts.push(`${path}:${digestText(readFileSync(path, 'utf-8'))}`);
    } catch {
      parts.push(`${path}:unreadable`);
    }
  }
  return parts.length > 0 ? digestCanonicalJson(parts) : null;
}

export function readRuntimeMemorySourceDigests(projectRoot: string): RuntimeMemoryIndexSourceDigests {
  return {
    projectDevMemoryDigest: digestFiles(resolveProjectMemoryReadPaths(projectRoot)),
    globalDevMemoryDigest: digestFiles(resolveGlobalMemoryReadPaths()),
    playbookDigest: digestFiles([resolvePlaybooksPath(projectRoot)]),
    signatureRegistryDigest: digestFiles([resolveSignatureRegistryPath(projectRoot)]),
  };
}

function mergeEntries(projectEntries: DevMemoryEntry[], globalEntries: DevMemoryEntry[]): DevMemoryEntry[] {
  const seen = new Set<string>();
  const merged: DevMemoryEntry[] = [];
  for (const entry of [...projectEntries, ...globalEntries]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function playbookText(playbook: Playbook): string {
  return [
    playbook.id,
    playbook.title,
    playbook.check,
    ...playbook.pitfalls,
    ...playbook.verification,
    ...playbook.trigger.keywords,
    ...playbook.trigger.fileKinds,
    ...playbook.trigger.storyPhases,
    playbook.lineage.sourceStoryId,
    playbook.lineage.sourceFindingId,
    playbook.lineage.sourceSignature ?? '',
    playbook.status,
  ].join(' ');
}

function devMemoryText(entry: DevMemoryEntry): string {
  return [
    entry.id,
    entry.summary,
    entry.trigger,
    entry.lesson,
    entry.reusePrompt,
    ...(entry.tags ?? []),
    entry.category,
    entry.scope,
    entry.sourceStoryId ?? '',
    ...(entry.evidenceRefs ?? []),
  ].join(' ');
}

function signatureText(entry: SignatureTagEntry): string {
  return [
    entry.tag,
    entry.status,
    ...entry.aliases,
    entry.mergedInto ?? '',
  ].join(' ');
}

function addTokens(map: Record<string, string[]>, id: string, text: string): void {
  for (const token of tokenize(text)) {
    const list = map[token] ?? [];
    list.push(id);
    map[token] = list;
  }
}

function normalizeIdLists(map: Record<string, string[]>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const key of Object.keys(map).sort()) {
    normalized[key] = uniqueInOrder(map[key]);
  }
  return normalized;
}

function contentDomain(index: RuntimeMemoryIndex): object {
  return {
    schemaVersion: index.schemaVersion,
    sourceDigests: index.manifest.sourceDigests,
    devMemoryEntries: index.devMemoryEntries,
    playbooks: index.playbooks,
    signatureTags: index.signatureTags,
    tokenToDevMemoryIds: index.tokenToDevMemoryIds,
    tokenToPlaybookIds: index.tokenToPlaybookIds,
    playbookStatusIds: index.playbookStatusIds,
    supersededByDevMemoryIds: index.supersededByDevMemoryIds,
  };
}

function manifestDomain(manifest: RuntimeMemoryIndexManifest): object {
  const { manifestDigest: _manifestDigest, ...domain } = manifest;
  return domain;
}

function computeIndexVersion(index: RuntimeMemoryIndex): string {
  return digestCanonicalJson(contentDomain(index));
}

function computeManifestDigest(manifest: RuntimeMemoryIndexManifest): string {
  return digestCanonicalJson(manifestDomain(manifest));
}

export function resolveRuntimeMemoryIndexPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), 'runtime-memory-index', 'index.json');
}

export function buildRuntimeMemoryIndex(projectRoot: string, builtAt = new Date().toISOString()): RuntimeMemoryIndex {
  const devMemoryEntries = mergeEntries(readProjectMemoryEntries(projectRoot), readGlobalMemoryEntries());
  const playbooks: Playbook[] = [];
  for (const raw of readPlaybooks(projectRoot)) {
    const validation = validatePlaybook(raw);
    if (validation.ok) playbooks.push(validation.playbook);
  }
  const signatureTags = readSignatureRegistry(projectRoot).tags;
  const tokenToDevMemoryIds: Record<string, string[]> = {};
  const tokenToPlaybookIds: Record<string, string[]> = {};
  const playbookStatusIds: Record<string, string[]> = {};
  const projection = buildSupersessionProjection(devMemoryEntries);
  const supersededByDevMemoryIds: Record<string, string[]> = {};

  for (const entry of devMemoryEntries) {
    addTokens(tokenToDevMemoryIds, entry.id, devMemoryText(entry));
    const supersession = getSupersessionStatus(entry, projection);
    if (supersession.supersededBy.length > 0) {
      supersededByDevMemoryIds[entry.id] = uniqueSorted(supersession.supersededBy);
    }
  }
  for (const playbook of playbooks) {
    addTokens(tokenToPlaybookIds, playbook.id, playbookText(playbook));
    const statusIds = playbookStatusIds[playbook.status] ?? [];
    statusIds.push(playbook.id);
    playbookStatusIds[playbook.status] = statusIds;
  }
  for (const signature of signatureTags) {
    addTokens(tokenToDevMemoryIds, `signature:${signature.tag}`, signatureText(signature));
  }

  const index: RuntimeMemoryIndex = {
    schemaVersion: RUNTIME_MEMORY_INDEX_SCHEMA_VERSION,
    manifest: {
      schemaVersion: RUNTIME_MEMORY_INDEX_SCHEMA_VERSION,
      builtAt,
      projectRoot,
      indexVersion: '',
      sourceDigests: readRuntimeMemorySourceDigests(projectRoot),
      recordCounts: {
        devMemory: devMemoryEntries.length,
        playbooks: playbooks.length,
        signatureTags: signatureTags.length,
      },
      authority: 'non_authoritative',
      gateEvidence: false,
      manifestDigest: '',
    },
    devMemoryEntries,
    playbooks,
    signatureTags,
    tokenToDevMemoryIds: normalizeIdLists(tokenToDevMemoryIds),
    tokenToPlaybookIds: normalizeIdLists(tokenToPlaybookIds),
    playbookStatusIds: normalizeIdLists(playbookStatusIds),
    supersededByDevMemoryIds: normalizeIdLists(supersededByDevMemoryIds),
  };
  index.manifest.indexVersion = computeIndexVersion(index);
  index.manifest.manifestDigest = computeManifestDigest(index.manifest);
  return index;
}

export function validateRuntimeMemoryIndex(raw: unknown): RuntimeMemoryIndexValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_shape' };
  const index = raw as RuntimeMemoryIndex;
  if (index.schemaVersion !== RUNTIME_MEMORY_INDEX_SCHEMA_VERSION) return { ok: false, reason: 'unsupported_schema' };
  if (!index.manifest || typeof index.manifest !== 'object') return { ok: false, reason: 'missing_manifest' };
  if (index.manifest.authority !== 'non_authoritative' || index.manifest.gateEvidence !== false) {
    return { ok: false, reason: 'authoritative_index_rejected' };
  }
  if (!Array.isArray(index.devMemoryEntries) || !Array.isArray(index.playbooks) || !Array.isArray(index.signatureTags)) {
    return { ok: false, reason: 'missing_records' };
  }
  if (index.manifest.recordCounts.devMemory !== index.devMemoryEntries.length
    || index.manifest.recordCounts.playbooks !== index.playbooks.length
    || index.manifest.recordCounts.signatureTags !== index.signatureTags.length) {
    return { ok: false, reason: 'record_count_mismatch' };
  }
  const expectedIndexVersion = computeIndexVersion(index);
  if (index.manifest.indexVersion !== expectedIndexVersion) return { ok: false, reason: 'index_digest_mismatch' };
  const expectedManifestDigest = computeManifestDigest(index.manifest);
  if (index.manifest.manifestDigest !== expectedManifestDigest) return { ok: false, reason: 'manifest_digest_mismatch' };
  return { ok: true };
}

export function readRuntimeMemoryIndex(projectRoot: string): RuntimeMemoryIndex | null {
  const indexPath = resolveRuntimeMemoryIndexPath(projectRoot);
  if (!existsSync(indexPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as RuntimeMemoryIndex;
    return validateRuntimeMemoryIndex(parsed).ok ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRuntimeMemoryIndexAtomically(projectRoot: string, index: RuntimeMemoryIndex): string {
  const indexPath = resolveRuntimeMemoryIndexPath(projectRoot);
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
    const parsed = JSON.parse(readFileSync(tmpPath, 'utf-8')) as RuntimeMemoryIndex;
    const validation = validateRuntimeMemoryIndex(parsed);
    if (!validation.ok) throw new Error(`runtime memory index validation failed: ${validation.reason}`);
    renameSync(tmpPath, indexPath);
    return indexPath;
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function rebuildRuntimeMemoryIndex(projectRoot: string, builtAt?: string): RuntimeMemoryIndex {
  const index = buildRuntimeMemoryIndex(projectRoot, builtAt);
  writeRuntimeMemoryIndexAtomically(projectRoot, index);
  const active = readRuntimeMemoryIndex(projectRoot);
  if (!active) throw new Error('runtime memory index rebuild did not produce a readable active index');
  return active;
}

export function isRuntimeMemoryIndexFresh(index: RuntimeMemoryIndex, projectRoot: string): boolean {
  const current = readRuntimeMemorySourceDigests(projectRoot);
  return current.projectDevMemoryDigest === index.manifest.sourceDigests.projectDevMemoryDigest
    && current.globalDevMemoryDigest === index.manifest.sourceDigests.globalDevMemoryDigest
    && current.playbookDigest === index.manifest.sourceDigests.playbookDigest
    && current.signatureRegistryDigest === index.manifest.sourceDigests.signatureRegistryDigest;
}

function matchingIds(tokenMap: Record<string, string[]>, tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  const ids: string[] = [];
  for (const token of tokens) {
    for (const [indexedToken, indexedIds] of Object.entries(tokenMap)) {
      if (indexedToken === token || indexedToken.includes(token) || token.includes(indexedToken)) {
        ids.push(...indexedIds);
      }
    }
  }
  return uniqueInOrder(ids);
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function capFromOptions(options: RuntimeMemoryIndexCandidateOptions): number {
  return Math.max(50, Math.floor(options.candidateLimit ?? Math.max(
    (options.maxEntries ?? 5) * 40,
    (options.maxPlaybooks ?? 5) * 40,
    200,
  )));
}

export function selectRuntimeMemoryIndexCandidates(
  index: RuntimeMemoryIndex,
  options: RuntimeMemoryIndexCandidateOptions = {},
): RuntimeMemoryIndexCandidates {
  const candidateLimit = capFromOptions(options);
  const devById = byId(index.devMemoryEntries);
  const playbookById = byId(index.playbooks);
  const queryTokens = tokenize(options.query ?? '');
  const devIds = queryTokens.length === 0
    ? index.devMemoryEntries.slice(-candidateLimit).map((entry) => entry.id).reverse()
    : matchingIds(index.tokenToDevMemoryIds, queryTokens);
  const withSuperseding = uniqueInOrder([
    ...devIds,
    ...devIds.flatMap((id) => index.supersededByDevMemoryIds[id] ?? []),
  ]).slice(0, candidateLimit);

  const playbookTokens = tokenize([
    options.query ?? '',
    options.consumer ?? '',
    options.storyPhase ?? '',
    options.host ?? '',
    ...(options.touchedPaths ?? []).map(fileKind),
  ].join(' '));
  const activeIds = new Set(index.playbookStatusIds.active ?? []);
  const indexedPlaybookIds = playbookTokens.length === 0
    ? [...activeIds]
    : matchingIds(index.tokenToPlaybookIds, playbookTokens).filter((id) => activeIds.has(id));
  const playbooks = uniqueInOrder(indexedPlaybookIds)
    .slice(0, candidateLimit)
    .map((id) => playbookById.get(id))
    .filter((item): item is Playbook => Boolean(item));

  return {
    devMemoryEntries: withSuperseding
      .map((id) => devById.get(id))
      .filter((item): item is DevMemoryEntry => Boolean(item)),
    playbooks,
    signatureTags: index.signatureTags,
  };
}
