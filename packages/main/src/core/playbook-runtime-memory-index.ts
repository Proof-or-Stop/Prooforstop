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
import { createHash } from 'node:crypto';
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

export const RUNTIME_MEMORY_INDEX_SCHEMA_VERSION = 'proofbound.runtime-memory-index.v3' as const;
const RUNTIME_MEMORY_INDEX_TOKEN_ID_CAP = 4096;
const RUNTIME_MEMORY_INDEX_FUZZY_TOKEN_CAP = 4096;
const RUNTIME_MEMORY_INDEX_SUBSTRING_FALLBACK_CAP = 512;

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
  exactOverflowDevMemoryTokens: string[];
  exactOverflowPlaybookTokens: string[];
  fuzzyTokenToDevMemoryTokens: Record<string, string[]>;
  fuzzyTokenToPlaybookTokens: Record<string, string[]>;
  fuzzyOverflowDevMemoryTokens: string[];
  fuzzyOverflowPlaybookTokens: string[];
  playbookStatusIds: Record<string, string[]>;
  supersededByDevMemoryIds: Record<string, string[]>;
}

export interface RuntimeMemoryIndexCandidates {
  devMemoryEntries: DevMemoryEntry[];
  playbooks: Playbook[];
  signatureTags: SignatureTagEntry[];
  stats: RuntimeMemoryIndexCandidateStats;
}

export interface RuntimeMemoryIndexCandidateStats {
  queryTokenCount: number;
  exactFastPathHits: number;
  exactOverflowFallbacks: number;
  fuzzyIndexHits: number;
  fuzzyFallbacks: number;
  tokenScanFallbacks: number;
  tokenMapScannedEntries: number;
  devMemoryCandidateIds: number;
  playbookCandidateIds: number;
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

function appendValues<T>(target: T[], values: Iterable<T>): void {
  for (const value of values) target.push(value);
}

function tokenize(text: string): string[] {
  return uniqueSorted((text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []));
}

function emptyCandidateStats(): RuntimeMemoryIndexCandidateStats {
  return {
    queryTokenCount: 0,
    exactFastPathHits: 0,
    exactOverflowFallbacks: 0,
    fuzzyIndexHits: 0,
    fuzzyFallbacks: 0,
    tokenScanFallbacks: 0,
    tokenMapScannedEntries: 0,
    devMemoryCandidateIds: 0,
    playbookCandidateIds: 0,
  };
}

const RUNTIME_MEMORY_INDEX_STATS = emptyCandidateStats();

function addStats(target: RuntimeMemoryIndexCandidateStats, source: RuntimeMemoryIndexCandidateStats): void {
  target.queryTokenCount += source.queryTokenCount;
  target.exactFastPathHits += source.exactFastPathHits;
  target.exactOverflowFallbacks += source.exactOverflowFallbacks;
  target.fuzzyIndexHits += source.fuzzyIndexHits;
  target.fuzzyFallbacks += source.fuzzyFallbacks;
  target.tokenScanFallbacks += source.tokenScanFallbacks;
  target.tokenMapScannedEntries += source.tokenMapScannedEntries;
  target.devMemoryCandidateIds += source.devMemoryCandidateIds;
  target.playbookCandidateIds += source.playbookCandidateIds;
}

export function resetRuntimeMemoryIndexCandidateStats(): void {
  Object.assign(RUNTIME_MEMORY_INDEX_STATS, emptyCandidateStats());
}

export function getRuntimeMemoryIndexCandidateStats(): RuntimeMemoryIndexCandidateStats {
  return { ...RUNTIME_MEMORY_INDEX_STATS };
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

function addTokens(map: Record<string, string[]>, overflowTokens: Set<string>, id: string, text: string): void {
  for (const token of tokenize(text)) {
    const list = map[token] ?? [];
    if (list.length < RUNTIME_MEMORY_INDEX_TOKEN_ID_CAP) {
      list.push(id);
    } else {
      overflowTokens.add(token);
    }
    map[token] = list;
  }
}

function fuzzyNeedlesForToken(token: string): string[] {
  if (token.length < 2) return [];
  const needles = new Set<string>();
  for (const length of [2, 3]) {
    if (token.length < length) continue;
    for (let index = 0; index <= token.length - length; index += 1) {
      needles.add(token.slice(index, index + length));
    }
  }
  return [...needles].sort();
}

function buildFuzzyTokenIndex(tokenMap: Record<string, string[]>): {
  fuzzyTokenMap: Record<string, string[]>;
  overflowNeedles: string[];
} {
  const fuzzyTokenMap: Record<string, string[]> = {};
  const overflowNeedles = new Set<string>();
  for (const token of Object.keys(tokenMap).sort()) {
    for (const needle of fuzzyNeedlesForToken(token)) {
      const list = fuzzyTokenMap[needle] ?? [];
      if (list.length < RUNTIME_MEMORY_INDEX_FUZZY_TOKEN_CAP) {
        list.push(token);
      } else {
        overflowNeedles.add(needle);
      }
      fuzzyTokenMap[needle] = list;
    }
  }
  return {
    fuzzyTokenMap: normalizeIdLists(fuzzyTokenMap),
    overflowNeedles: uniqueSorted(overflowNeedles),
  };
}

function normalizeIdLists(map: Record<string, string[]>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const key of Object.keys(map).sort()) {
    normalized[key] = uniqueInOrder(map[key]);
  }
  return normalized;
}

function manifestDomain(manifest: RuntimeMemoryIndexManifest): object {
  const { manifestDigest: _manifestDigest, ...domain } = manifest;
  return domain;
}

function digestSequence(items: unknown[]): string {
  const hash = createHash('sha256');
  hash.update('[');
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) hash.update(',');
    hash.update(digestCanonicalJson(items[index]));
  }
  hash.update(']');
  return hash.digest('hex');
}

function digestIdMap(map: Record<string, string[]>): string {
  const hash = createHash('sha256');
  hash.update('{');
  const keys = Object.keys(map).sort();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (index > 0) hash.update(',');
    hash.update(JSON.stringify(key));
    hash.update(':');
    hash.update(digestCanonicalJson(map[key] ?? []));
  }
  hash.update('}');
  return hash.digest('hex');
}

function computeIndexVersion(index: RuntimeMemoryIndex): string {
  return digestCanonicalJson({
    schemaVersion: index.schemaVersion,
    sourceDigests: index.manifest.sourceDigests,
    devMemoryEntriesDigest: digestSequence(index.devMemoryEntries),
    playbooksDigest: digestSequence(index.playbooks),
    signatureTagsDigest: digestSequence(index.signatureTags),
    tokenToDevMemoryIdsDigest: digestIdMap(index.tokenToDevMemoryIds),
    tokenToPlaybookIdsDigest: digestIdMap(index.tokenToPlaybookIds),
    exactOverflowDevMemoryTokens: index.exactOverflowDevMemoryTokens,
    exactOverflowPlaybookTokens: index.exactOverflowPlaybookTokens,
    fuzzyTokenToDevMemoryTokensDigest: digestIdMap(index.fuzzyTokenToDevMemoryTokens),
    fuzzyTokenToPlaybookTokensDigest: digestIdMap(index.fuzzyTokenToPlaybookTokens),
    fuzzyOverflowDevMemoryTokens: index.fuzzyOverflowDevMemoryTokens,
    fuzzyOverflowPlaybookTokens: index.fuzzyOverflowPlaybookTokens,
    playbookStatusIdsDigest: digestIdMap(index.playbookStatusIds),
    supersededByDevMemoryIdsDigest: digestIdMap(index.supersededByDevMemoryIds),
  });
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
  const exactOverflowDevMemoryTokens = new Set<string>();
  const exactOverflowPlaybookTokens = new Set<string>();
  const playbookStatusIds: Record<string, string[]> = {};
  const projection = buildSupersessionProjection(devMemoryEntries);
  const supersededByDevMemoryIds: Record<string, string[]> = {};

  for (const entry of devMemoryEntries) {
    addTokens(tokenToDevMemoryIds, exactOverflowDevMemoryTokens, entry.id, devMemoryText(entry));
    const supersession = getSupersessionStatus(entry, projection);
    if (supersession.supersededBy.length > 0) {
      supersededByDevMemoryIds[entry.id] = uniqueSorted(supersession.supersededBy);
    }
  }
  for (const playbook of playbooks) {
    addTokens(tokenToPlaybookIds, exactOverflowPlaybookTokens, playbook.id, playbookText(playbook));
    const statusIds = playbookStatusIds[playbook.status] ?? [];
    statusIds.push(playbook.id);
    playbookStatusIds[playbook.status] = statusIds;
  }
  for (const signature of signatureTags) {
    addTokens(tokenToDevMemoryIds, exactOverflowDevMemoryTokens, `signature:${signature.tag}`, signatureText(signature));
  }
  const normalizedDevMemoryTokenIds = normalizeIdLists(tokenToDevMemoryIds);
  const normalizedPlaybookTokenIds = normalizeIdLists(tokenToPlaybookIds);
  const devMemoryFuzzy = buildFuzzyTokenIndex(normalizedDevMemoryTokenIds);
  const playbookFuzzy = buildFuzzyTokenIndex(normalizedPlaybookTokenIds);

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
    tokenToDevMemoryIds: normalizedDevMemoryTokenIds,
    tokenToPlaybookIds: normalizedPlaybookTokenIds,
    exactOverflowDevMemoryTokens: uniqueSorted(exactOverflowDevMemoryTokens),
    exactOverflowPlaybookTokens: uniqueSorted(exactOverflowPlaybookTokens),
    fuzzyTokenToDevMemoryTokens: devMemoryFuzzy.fuzzyTokenMap,
    fuzzyTokenToPlaybookTokens: playbookFuzzy.fuzzyTokenMap,
    fuzzyOverflowDevMemoryTokens: devMemoryFuzzy.overflowNeedles,
    fuzzyOverflowPlaybookTokens: playbookFuzzy.overflowNeedles,
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
  if (
    !index.tokenToDevMemoryIds || !index.tokenToPlaybookIds
    || !Array.isArray(index.exactOverflowDevMemoryTokens)
    || !Array.isArray(index.exactOverflowPlaybookTokens)
    || !index.fuzzyTokenToDevMemoryTokens || !index.fuzzyTokenToPlaybookTokens
    || !Array.isArray(index.fuzzyOverflowDevMemoryTokens)
    || !Array.isArray(index.fuzzyOverflowPlaybookTokens)
  ) {
    return { ok: false, reason: 'missing_index_maps' };
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

interface MatchingIdsResult {
  ids: string[];
  stats: RuntimeMemoryIndexCandidateStats;
}

function substringTokens(token: string, tokenMap: Record<string, string[]>): { tokens: string[]; overflow: boolean } {
  const matches: string[] = [];
  let visited = 0;
  for (let start = 0; start < token.length; start += 1) {
    for (let end = start + 2; end <= token.length; end += 1) {
      const substring = token.slice(start, end);
      if (substring === token) continue;
      visited += 1;
      if (visited > RUNTIME_MEMORY_INDEX_SUBSTRING_FALLBACK_CAP) return { tokens: [], overflow: true };
      if (tokenMap[substring]) matches.push(substring);
    }
  }
  return { tokens: uniqueInOrder(matches), overflow: false };
}

function rarestNeedleForToken(
  token: string,
  fuzzyTokenMap: Record<string, string[]>,
  overflowNeedles: Set<string>,
): { needle?: string; overflow: boolean } {
  const needles = token.length <= 3 ? [token] : uniqueSorted(
    Array.from({ length: token.length - 2 }, (_value, index) => token.slice(index, index + 3)),
  );
  let bestNeedle: string | undefined;
  let bestSize = Number.MAX_SAFE_INTEGER;
  let sawOverflow = false;
  for (const needle of needles) {
    const needleOverflow = overflowNeedles.has(needle);
    if (needleOverflow) sawOverflow = true;
    const list = fuzzyTokenMap[needle];
    if (!list || list.length === 0) continue;
    // A capped fuzzy bucket is incomplete by construction. Never use it as a
    // complete proof of membership; fall back to the token map if every usable
    // needle is overflowed.
    if (needleOverflow) continue;
    if (list.length < bestSize) {
      bestNeedle = needle;
      bestSize = list.length;
    }
  }
  return { needle: bestNeedle, overflow: bestNeedle === undefined && sawOverflow };
}

function fuzzyTokensContaining(
  token: string,
  fuzzyTokenMap: Record<string, string[]>,
  overflowNeedles: Set<string>,
): { tokens: string[]; fallback: boolean } {
  if (token.length < 2) return { tokens: [], fallback: false };
  const rarest = rarestNeedleForToken(token, fuzzyTokenMap, overflowNeedles);
  if (rarest.overflow) return { tokens: [], fallback: true };
  if (!rarest.needle) return { tokens: [], fallback: false };
  return {
    tokens: uniqueInOrder((fuzzyTokenMap[rarest.needle] ?? []).filter((indexedToken) => indexedToken.includes(token))),
    fallback: false,
  };
}

function tokenMatchesQuery(indexedToken: string, token: string): boolean {
  return indexedToken === token || indexedToken.includes(token) || token.includes(indexedToken);
}

function scanSourceMatchingIdsForToken<T extends { id: string }>(
  sourceItems: T[],
  textForItem: (item: T) => string,
  token: string,
): string[] {
  const ids: string[] = [];
  for (const item of sourceItems) {
    if (tokenize(textForItem(item)).some((indexedToken) => tokenMatchesQuery(indexedToken, token))) {
      ids.push(item.id);
    }
  }
  return uniqueInOrder(ids);
}

function appendIndexedTokenIds<T extends { id: string }>(
  ids: string[],
  stats: RuntimeMemoryIndexCandidateStats,
  tokenMap: Record<string, string[]>,
  overflowExactTokens: Set<string>,
  sourceItems: T[],
  textForItem: (item: T) => string,
  queryToken: string,
  indexedTokens: string[],
): void {
  const overflowedIndexedTokens: string[] = [];
  for (const indexedToken of indexedTokens) {
    if (overflowExactTokens.has(indexedToken)) {
      overflowedIndexedTokens.push(indexedToken);
    } else {
      appendValues(ids, tokenMap[indexedToken] ?? []);
    }
  }
  if (overflowedIndexedTokens.length === 0) return;

  stats.exactOverflowFallbacks += uniqueInOrder(overflowedIndexedTokens).length;
  stats.tokenScanFallbacks += 1;
  stats.tokenMapScannedEntries += sourceItems.length;
  appendValues(ids, scanSourceMatchingIdsForToken(sourceItems, textForItem, queryToken));
}

function matchingIds<T extends { id: string }>(
  tokenMap: Record<string, string[]>,
  exactOverflowTokens: string[],
  fuzzyTokenMap: Record<string, string[]>,
  fuzzyOverflowNeedles: string[],
  sourceItems: T[],
  textForItem: (item: T) => string,
  tokens: string[],
): MatchingIdsResult {
  const stats = emptyCandidateStats();
  stats.queryTokenCount = tokens.length;
  if (tokens.length === 0) return { ids: [], stats };

  const ids: string[] = [];
  const overflowExactTokens = new Set(exactOverflowTokens);
  const overflowNeedles = new Set(fuzzyOverflowNeedles);
  for (const token of tokens) {
    const exactIds = tokenMap[token] ?? [];
    if (exactIds.length > 0) {
      stats.exactFastPathHits += 1;
      appendValues(ids, exactIds);
    }
    if (overflowExactTokens.has(token)) {
      stats.exactOverflowFallbacks += 1;
      stats.tokenScanFallbacks += 1;
      stats.tokenMapScannedEntries += sourceItems.length;
      appendValues(ids, scanSourceMatchingIdsForToken(sourceItems, textForItem, token));
      continue;
    }

    const containingTokens = fuzzyTokensContaining(token, fuzzyTokenMap, overflowNeedles);
    if (containingTokens.fallback) {
      stats.fuzzyFallbacks += 1;
      stats.tokenScanFallbacks += 1;
      stats.tokenMapScannedEntries += sourceItems.length;
      appendValues(ids, scanSourceMatchingIdsForToken(sourceItems, textForItem, token));
      continue;
    }
    if (containingTokens.tokens.length > 0) {
      stats.fuzzyIndexHits += 1;
      appendIndexedTokenIds(
        ids,
        stats,
        tokenMap,
        overflowExactTokens,
        sourceItems,
        textForItem,
        token,
        containingTokens.tokens,
      );
    }

    const containedTokens = substringTokens(token, tokenMap);
    if (containedTokens.overflow) {
      stats.fuzzyFallbacks += 1;
      stats.tokenScanFallbacks += 1;
      stats.tokenMapScannedEntries += sourceItems.length;
      appendValues(ids, scanSourceMatchingIdsForToken(sourceItems, textForItem, token));
      continue;
    }
    if (containedTokens.tokens.length > 0) {
      stats.fuzzyIndexHits += 1;
      appendIndexedTokenIds(
        ids,
        stats,
        tokenMap,
        overflowExactTokens,
        sourceItems,
        textForItem,
        token,
        containedTokens.tokens,
      );
    }
  }
  return { ids: uniqueInOrder(ids), stats };
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function orderMap<T extends { id: string }>(items: T[]): Map<string, number> {
  return new Map(items.map((item, idx) => [item.id, idx]));
}

function byCorpusOrder(ids: string[], order: Map<string, number>): string[] {
  return ids.slice().sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
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
  const devOrder = orderMap(index.devMemoryEntries);
  const playbookById = byId(index.playbooks);
  const stats = emptyCandidateStats();
  const queryTokens = tokenize(options.query ?? '');
  let devIds: string[];
  if (queryTokens.length === 0) {
    devIds = index.devMemoryEntries.slice(-candidateLimit).map((entry) => entry.id).reverse();
  } else {
    const matched = matchingIds(
      index.tokenToDevMemoryIds,
      index.exactOverflowDevMemoryTokens,
      index.fuzzyTokenToDevMemoryTokens,
      index.fuzzyOverflowDevMemoryTokens,
      index.devMemoryEntries,
      devMemoryText,
      queryTokens,
    );
    devIds = matched.ids;
    addStats(stats, matched.stats);
  }
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
  let indexedPlaybookIds: string[];
  if (playbookTokens.length === 0) {
    indexedPlaybookIds = [...activeIds];
  } else {
    const matched = matchingIds(
      index.tokenToPlaybookIds,
      index.exactOverflowPlaybookTokens,
      index.fuzzyTokenToPlaybookTokens,
      index.fuzzyOverflowPlaybookTokens,
      index.playbooks,
      playbookText,
      playbookTokens,
    );
    addStats(stats, matched.stats);
    indexedPlaybookIds = matched.ids.filter((id) => activeIds.has(id));
  }
  const contextCanMatchActivePlaybooks = Boolean(options.storyPhase)
    || (options.touchedPaths?.length ?? 0) > 0;
  const contextActiveIds = contextCanMatchActivePlaybooks
    ? [...activeIds].sort((a, b) => a.localeCompare(b))
    : [];
  const playbookCandidateIds = uniqueInOrder([
    ...indexedPlaybookIds,
    ...contextActiveIds,
  ]);
  const playbooks = (contextCanMatchActivePlaybooks ? playbookCandidateIds : playbookCandidateIds.slice(0, candidateLimit))
    .map((id) => playbookById.get(id))
    .filter((item): item is Playbook => Boolean(item));
  stats.devMemoryCandidateIds = withSuperseding.length;
  stats.playbookCandidateIds = playbooks.length;
  addStats(RUNTIME_MEMORY_INDEX_STATS, stats);

  return {
    devMemoryEntries: byCorpusOrder(withSuperseding, devOrder)
      .map((id) => devById.get(id))
      .filter((item): item is DevMemoryEntry => Boolean(item)),
    playbooks,
    signatureTags: index.signatureTags,
    stats,
  };
}
