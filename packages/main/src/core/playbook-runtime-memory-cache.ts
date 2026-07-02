import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LATTICE_CONFIG_FILENAME } from './config.js';
import {
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  type DevMemoryEntry,
} from './dev-memory.js';
import { digestCanonicalJson, digestText } from './digest.js';
import type { Playbook } from './experience-layer-types.js';
import {
  computePlaybookDigest,
  resolveLearningDir,
  readPlaybooks,
  readSignatureRegistry,
  validatePlaybook,
  type SignatureTagEntry,
} from './learning-store.js';
import {
  readRuntimeMemorySourceDigests,
  selectRuntimeMemoryIndexCandidates,
  type RuntimeMemoryIndex,
  type RuntimeMemoryIndexSourceDigests,
} from './playbook-runtime-memory-index.js';
import type {
  BuildMemoryFreshnessPackOptions,
  MemoryFreshnessPack,
  RuntimeConsumer,
} from './playbook-runtime-memory.js';

export const RUNTIME_MEMORY_PACK_CACHE_POLICY_VERSION = 'proofbound.runtime-memory-pack-cache.v1' as const;

type SourceKind = 'dev-memory' | 'playbook' | 'signature-registry';

export interface RuntimeMemoryPackCacheContext {
  projectRoot: string;
  schemaVersion: MemoryFreshnessPack['schemaVersion'];
  query: string;
  consumer: RuntimeConsumer;
  storyPhase?: string;
  touchedPaths: string[];
  host?: string;
  maxEntries: number;
  maxPlaybooks: number;
  maxLines: number;
  candidateLimit?: number;
  runtimeIndex?: RuntimeMemoryIndex | null;
  currentSourceDigests?: RuntimeMemoryIndexSourceDigests;
}

export interface RuntimeMemoryPackContributionDigest {
  kind: SourceKind;
  id: string;
  expectedDigest: string;
  currentDigest: string | null;
}

export interface RuntimeMemoryPackCacheKey {
  projectRoot: string;
  schemaVersion: MemoryFreshnessPack['schemaVersion'];
  consumer: RuntimeConsumer;
  normalizedQuery: string;
  normalizedContext: {
    storyPhase?: string;
    touchedPaths: string[];
    host?: string;
  };
  contributingSourceDigestTuple: RuntimeMemoryPackContributionDigest[];
  runtimeConfigDigest: string | null;
  consumerPolicyVersion: typeof RUNTIME_MEMORY_PACK_CACHE_POLICY_VERSION;
  limits: {
    maxEntries: number;
    maxPlaybooks: number;
    maxLines: number;
    candidateLimit?: number;
  };
  indexVersion: string | null;
  cacheKeyDigest: string;
  lookupDigest: string;
}

export interface RuntimeMemoryPackCacheStats {
  entries: number;
  hits: number;
  misses: number;
  staleIrrelevantHits: number;
  contributingMisses: number;
  durableHits: number;
  durableWrites: number;
  lastCacheKeyDigest?: string;
  lastLookupDigest?: string;
  lastHitClass?: 'fresh' | 'stale-irrelevant';
  lastMissReason?: string;
}

type RuntimeMemoryPackCacheHit =
  | { hit: true; pack: MemoryFreshnessPack; cacheKey: RuntimeMemoryPackCacheKey; hitClass: 'fresh' | 'stale-irrelevant' }
  | { hit: false; reason: string };

interface RuntimeMemoryPackCacheEntry {
  lookupDigest: string;
  cacheKey: RuntimeMemoryPackCacheKey;
  pack: MemoryFreshnessPack;
  sourceDigests: RuntimeMemoryIndexSourceDigests;
  candidateProjectionDigest: string | null;
}

const CACHE = new Map<string, RuntimeMemoryPackCacheEntry>();
const STATS = {
  hits: 0,
  misses: 0,
  staleIrrelevantHits: 0,
  contributingMisses: 0,
  durableHits: 0,
  durableWrites: 0,
  lastCacheKeyDigest: undefined as string | undefined,
  lastLookupDigest: undefined as string | undefined,
  lastHitClass: undefined as 'fresh' | 'stale-irrelevant' | undefined,
  lastMissReason: undefined as string | undefined,
};

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort();
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function runtimeConfigDigest(projectRoot: string): string | null {
  const path = join(projectRoot, LATTICE_CONFIG_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return digestText(readFileSync(path, 'utf-8'));
  } catch {
    return 'unreadable';
  }
}

function clonePack(pack: MemoryFreshnessPack): MemoryFreshnessPack {
  return JSON.parse(JSON.stringify(pack)) as MemoryFreshnessPack;
}

function cacheDir(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), 'runtime-memory-pack-cache');
}

function cachePath(projectRoot: string, lookupDigest: string): string {
  return join(cacheDir(projectRoot), `${lookupDigest}.json`);
}

function validCacheEntryShape(value: unknown): value is RuntimeMemoryPackCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<RuntimeMemoryPackCacheEntry>;
  return typeof entry.lookupDigest === 'string'
    && Boolean(entry.cacheKey)
    && Boolean(entry.pack)
    && Boolean(entry.sourceDigests);
}

function rememberStatsHit(entry: RuntimeMemoryPackCacheEntry, hitClass: 'fresh' | 'stale-irrelevant'): void {
  STATS.hits += 1;
  STATS.lastCacheKeyDigest = entry.cacheKey.cacheKeyDigest;
  STATS.lastLookupDigest = entry.cacheKey.lookupDigest;
  STATS.lastHitClass = hitClass;
  STATS.lastMissReason = undefined;
}

function rememberStatsMiss(reason: string, lookupDigest?: string): void {
  STATS.misses += 1;
  STATS.lastLookupDigest = lookupDigest;
  STATS.lastMissReason = reason;
  STATS.lastHitClass = undefined;
}

function readDurableCacheEntry(projectRoot: string, lookupDigest: string): RuntimeMemoryPackCacheEntry | null {
  const path = cachePath(projectRoot, lookupDigest);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!validCacheEntryShape(parsed)) return null;
    if (parsed.lookupDigest !== lookupDigest || parsed.cacheKey.lookupDigest !== lookupDigest) return null;
    if (parsed.cacheKey.projectRoot !== projectRoot) return null;
    CACHE.set(lookupDigest, parsed);
    STATS.durableHits += 1;
    return parsed;
  } catch {
    return null;
  }
}

function writeDurableCacheEntry(projectRoot: string, entry: RuntimeMemoryPackCacheEntry): void {
  const dir = cacheDir(projectRoot);
  const path = cachePath(projectRoot, entry.lookupDigest);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    renameSync(tmpPath, path);
    STATS.durableWrites += 1;
  } catch {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

export function computeMemoryPackDigest(pack: MemoryFreshnessPack): string {
  const { packDigest: _packDigest, generatedAt: _generatedAt, ...domain } = pack;
  return digestCanonicalJson(domain);
}

function clonePackWithFreshness(
  pack: MemoryFreshnessPack,
  freshness: MemoryFreshnessPack['freshness'],
): MemoryFreshnessPack {
  const next = clonePack(pack);
  next.freshness = freshness;
  next.packDigest = computeMemoryPackDigest(next);
  return next;
}

function sourceDigestsFor(context: RuntimeMemoryPackCacheContext): RuntimeMemoryIndexSourceDigests {
  return context.currentSourceDigests ?? readRuntimeMemorySourceDigests(context.projectRoot);
}

function sameSourceDigests(a: RuntimeMemoryIndexSourceDigests, b: RuntimeMemoryIndexSourceDigests): boolean {
  return a.projectDevMemoryDigest === b.projectDevMemoryDigest
    && a.globalDevMemoryDigest === b.globalDevMemoryDigest
    && a.playbookDigest === b.playbookDigest
    && a.signatureRegistryDigest === b.signatureRegistryDigest;
}

function parseSourceRef(ref: string): { kind: SourceKind; id: string; digest: string } | null {
  const first = ref.indexOf(':');
  const second = first >= 0 ? ref.indexOf(':', first + 1) : -1;
  if (first <= 0 || second <= first + 1) return null;
  const kind = ref.slice(0, first);
  if (kind !== 'dev-memory' && kind !== 'playbook' && kind !== 'signature-registry') return null;
  return {
    kind,
    id: ref.slice(first + 1, second),
    digest: ref.slice(second + 1),
  };
}

function memoryById(context: RuntimeMemoryPackCacheContext): Map<string, DevMemoryEntry> {
  if (context.runtimeIndex) {
    return new Map(context.runtimeIndex.devMemoryEntries.map((entry) => [entry.id, entry]));
  }
  const seen = new Set<string>();
  const entries: DevMemoryEntry[] = [];
  for (const entry of [...readProjectMemoryEntries(context.projectRoot), ...readGlobalMemoryEntries()]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function playbookById(context: RuntimeMemoryPackCacheContext): Map<string, Playbook> {
  if (context.runtimeIndex) {
    return new Map(context.runtimeIndex.playbooks.map((playbook) => [playbook.id, playbook]));
  }
  const playbooks: Playbook[] = [];
  for (const raw of readPlaybooks(context.projectRoot)) {
    const validation = validatePlaybook(raw);
    if (validation.ok) playbooks.push(validation.playbook);
  }
  return new Map(playbooks.map((playbook) => [playbook.id, playbook]));
}

function signatureByTag(context: RuntimeMemoryPackCacheContext): Map<string, SignatureTagEntry> {
  const tags = context.runtimeIndex?.signatureTags ?? readSignatureRegistry(context.projectRoot).tags;
  return new Map(tags.map((tag) => [tag.tag, tag]));
}

function currentDigestForRef(
  context: RuntimeMemoryPackCacheContext,
  parsed: { kind: SourceKind; id: string },
  indexes?: {
    memories: Map<string, DevMemoryEntry>;
    playbooks: Map<string, Playbook>;
    signatures: Map<string, SignatureTagEntry>;
  },
): string | null {
  if (parsed.kind === 'dev-memory') {
    const entry = (indexes?.memories ?? memoryById(context)).get(parsed.id);
    return entry ? digestCanonicalJson(entry) : null;
  }
  if (parsed.kind === 'playbook') {
    const playbook = (indexes?.playbooks ?? playbookById(context)).get(parsed.id);
    return playbook ? computePlaybookDigest(playbook) : null;
  }
  const signature = (indexes?.signatures ?? signatureByTag(context)).get(parsed.id);
  return signature ? digestCanonicalJson(signature) : null;
}

function contributionTupleFromRefs(
  refs: string[],
  context: RuntimeMemoryPackCacheContext,
): RuntimeMemoryPackContributionDigest[] {
  const parsedRefs = uniqueSorted(refs).map(parseSourceRef).filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
  if (parsedRefs.length === 0) return [];
  const indexes = {
    memories: memoryById(context),
    playbooks: playbookById(context),
    signatures: signatureByTag(context),
  };
  return parsedRefs.map((ref) => ({
    kind: ref.kind,
    id: ref.id,
    expectedDigest: ref.digest,
    currentDigest: currentDigestForRef(context, ref, indexes),
  })).sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.expectedDigest.localeCompare(b.expectedDigest));
}

function sameContributionTuple(a: RuntimeMemoryPackContributionDigest[], b: RuntimeMemoryPackContributionDigest[]): boolean {
  return digestCanonicalJson(a) === digestCanonicalJson(b);
}

function containsTerm(text: string, term: string): boolean {
  const lhs = text.toLowerCase();
  const rhs = term.trim().toLowerCase();
  return rhs.length > 0 && lhs.includes(rhs);
}

function signatureMatchesQuery(tag: SignatureTagEntry, query: string): boolean {
  if (tag.status !== 'deprecated') return false;
  const terms = [tag.tag, ...tag.aliases];
  return terms.some((term) => containsTerm(query, term));
}

function candidateProjectionDigest(context: RuntimeMemoryPackCacheContext): string | null {
  if (!context.runtimeIndex) return null;
  const candidates = selectRuntimeMemoryIndexCandidates(context.runtimeIndex, {
    query: context.query,
    consumer: context.consumer,
    storyPhase: context.storyPhase,
    touchedPaths: context.touchedPaths,
    host: context.host,
    maxEntries: context.maxEntries,
    maxPlaybooks: context.maxPlaybooks,
    ...(context.candidateLimit !== undefined ? { candidateLimit: context.candidateLimit } : {}),
  });
  const refs = [
    ...candidates.devMemoryEntries.map((entry) => `dev-memory:${entry.id}:${digestCanonicalJson(entry)}`),
    ...candidates.playbooks.map((playbook) => `playbook:${playbook.id}:${computePlaybookDigest(playbook)}`),
    ...candidates.signatureTags
      .filter((tag) => signatureMatchesQuery(tag, context.query))
      .map((tag) => `signature-registry:${tag.tag}:${digestCanonicalJson(tag)}`),
  ];
  return digestCanonicalJson(uniqueSorted(refs));
}

function keyDomain(
  context: RuntimeMemoryPackCacheContext,
  contributionTuple: RuntimeMemoryPackContributionDigest[],
): Omit<RuntimeMemoryPackCacheKey, 'cacheKeyDigest' | 'lookupDigest'> {
  return {
    projectRoot: context.projectRoot,
    schemaVersion: context.schemaVersion,
    consumer: context.consumer,
    normalizedQuery: normalizeText(context.query),
    normalizedContext: {
      storyPhase: normalizeOptionalText(context.storyPhase),
      touchedPaths: uniqueSorted(context.touchedPaths.map(normalizeText)),
      host: normalizeOptionalText(context.host),
    },
    contributingSourceDigestTuple: contributionTuple,
    runtimeConfigDigest: runtimeConfigDigest(context.projectRoot),
    consumerPolicyVersion: RUNTIME_MEMORY_PACK_CACHE_POLICY_VERSION,
    limits: {
      maxEntries: context.maxEntries,
      maxPlaybooks: context.maxPlaybooks,
      maxLines: context.maxLines,
      ...(context.candidateLimit !== undefined ? { candidateLimit: context.candidateLimit } : {}),
    },
    indexVersion: context.runtimeIndex?.manifest.indexVersion ?? null,
  };
}

function lookupDomain(domain: Omit<RuntimeMemoryPackCacheKey, 'cacheKeyDigest' | 'lookupDigest'>): object {
  return {
    schemaVersion: domain.schemaVersion,
    projectRoot: domain.projectRoot,
    consumer: domain.consumer,
    normalizedQuery: domain.normalizedQuery,
    normalizedContext: domain.normalizedContext,
    runtimeConfigDigest: domain.runtimeConfigDigest,
    consumerPolicyVersion: domain.consumerPolicyVersion,
    limits: domain.limits,
  };
}

export function buildRuntimeMemoryPackCacheKey(
  context: RuntimeMemoryPackCacheContext,
  contributionTuple: RuntimeMemoryPackContributionDigest[],
): RuntimeMemoryPackCacheKey {
  const domain = keyDomain(context, contributionTuple);
  const cacheKeyDigest = digestCanonicalJson(domain);
  const lookupDigest = digestCanonicalJson(lookupDomain(domain));
  return {
    ...domain,
    cacheKeyDigest,
    lookupDigest,
  };
}

function currentLookupDigest(context: RuntimeMemoryPackCacheContext): string {
  return buildRuntimeMemoryPackCacheKey(context, []).lookupDigest;
}

export function getRuntimeMemoryPackCacheHit(context: RuntimeMemoryPackCacheContext): RuntimeMemoryPackCacheHit {
  const lookupDigest = currentLookupDigest(context);
  const entry = CACHE.get(lookupDigest) ?? readDurableCacheEntry(context.projectRoot, lookupDigest);
  if (!entry) {
    rememberStatsMiss('empty', lookupDigest);
    return { hit: false, reason: 'empty' };
  }

  const currentIndexVersion = context.runtimeIndex?.manifest.indexVersion ?? null;
  const currentSourceDigests = sourceDigestsFor(context);
  const indexVersionMatches = entry.cacheKey.indexVersion === currentIndexVersion;
  if (indexVersionMatches && sameSourceDigests(entry.sourceDigests, currentSourceDigests)) {
    rememberStatsHit(entry, 'fresh');
    return {
      hit: true,
      pack: clonePackWithFreshness(entry.pack, { stale: false, class: 'fresh' }),
      cacheKey: entry.cacheKey,
      hitClass: 'fresh',
    };
  }

  const currentTuple = contributionTupleFromRefs(entry.pack.results.contributingSourceRefs, context);
  if (!sameContributionTuple(entry.cacheKey.contributingSourceDigestTuple, currentTuple)) {
    rememberStatsMiss('contributing_source_changed', lookupDigest);
    STATS.contributingMisses += 1;
    return { hit: false, reason: 'contributing_source_changed' };
  }

  const currentCandidateProjectionDigest = candidateProjectionDigest(context);
  if (currentCandidateProjectionDigest && currentCandidateProjectionDigest === entry.candidateProjectionDigest) {
    rememberStatsHit(entry, 'stale-irrelevant');
    STATS.staleIrrelevantHits += 1;
    return {
      hit: true,
      pack: clonePackWithFreshness(entry.pack, {
        stale: true,
        class: 'stale-irrelevant',
        reason: 'source/index digest changed but indexed candidate and contributing refs are unchanged',
      }),
      cacheKey: entry.cacheKey,
      hitClass: 'stale-irrelevant',
    };
  }

  const reason = currentCandidateProjectionDigest ? 'candidate_projection_changed' : 'source_digest_changed';
  rememberStatsMiss(reason, lookupDigest);
  return { hit: false, reason };
}

export function rememberRuntimeMemoryPackCache(
  context: RuntimeMemoryPackCacheContext,
  pack: MemoryFreshnessPack,
): RuntimeMemoryPackCacheKey {
  const contributionTuple = contributionTupleFromRefs(pack.results.contributingSourceRefs, context);
  const cacheKey = buildRuntimeMemoryPackCacheKey(context, contributionTuple);
  const entry: RuntimeMemoryPackCacheEntry = {
    lookupDigest: cacheKey.lookupDigest,
    cacheKey,
    pack: clonePack(pack),
    sourceDigests: sourceDigestsFor(context),
    candidateProjectionDigest: candidateProjectionDigest(context),
  };
  CACHE.set(cacheKey.lookupDigest, entry);
  STATS.lastCacheKeyDigest = cacheKey.cacheKeyDigest;
  STATS.lastLookupDigest = cacheKey.lookupDigest;
  STATS.lastMissReason = undefined;
  writeDurableCacheEntry(context.projectRoot, entry);
  return cacheKey;
}

export function clearRuntimeMemoryPackCache(): void {
  CACHE.clear();
  STATS.hits = 0;
  STATS.misses = 0;
  STATS.staleIrrelevantHits = 0;
  STATS.contributingMisses = 0;
  STATS.durableHits = 0;
  STATS.durableWrites = 0;
  STATS.lastCacheKeyDigest = undefined;
  STATS.lastLookupDigest = undefined;
  STATS.lastHitClass = undefined;
  STATS.lastMissReason = undefined;
}

export function getRuntimeMemoryPackCacheStats(): RuntimeMemoryPackCacheStats {
  return {
    entries: CACHE.size,
    hits: STATS.hits,
    misses: STATS.misses,
    staleIrrelevantHits: STATS.staleIrrelevantHits,
    contributingMisses: STATS.contributingMisses,
    durableHits: STATS.durableHits,
    durableWrites: STATS.durableWrites,
    ...(STATS.lastCacheKeyDigest ? { lastCacheKeyDigest: STATS.lastCacheKeyDigest } : {}),
    ...(STATS.lastLookupDigest ? { lastLookupDigest: STATS.lastLookupDigest } : {}),
    ...(STATS.lastHitClass ? { lastHitClass: STATS.lastHitClass } : {}),
    ...(STATS.lastMissReason ? { lastMissReason: STATS.lastMissReason } : {}),
  };
}

export function buildRuntimeMemoryPackCacheContext(
  options: BuildMemoryFreshnessPackOptions,
  normalized: {
    schemaVersion: MemoryFreshnessPack['schemaVersion'];
    query: string;
    consumer: RuntimeConsumer;
    maxEntries: number;
    maxPlaybooks: number;
    maxLines: number;
    candidateLimit?: number;
    runtimeIndex?: RuntimeMemoryIndex | null;
    currentSourceDigests?: RuntimeMemoryIndexSourceDigests;
  },
): RuntimeMemoryPackCacheContext {
  return {
    projectRoot: options.projectRoot,
    schemaVersion: normalized.schemaVersion,
    query: normalized.query,
    consumer: normalized.consumer,
    storyPhase: options.storyPhase,
    touchedPaths: options.touchedPaths ?? [],
    host: options.host,
    maxEntries: normalized.maxEntries,
    maxPlaybooks: normalized.maxPlaybooks,
    maxLines: normalized.maxLines,
    ...(normalized.candidateLimit !== undefined ? { candidateLimit: normalized.candidateLimit } : {}),
    runtimeIndex: normalized.runtimeIndex ?? null,
    ...(normalized.currentSourceDigests ? { currentSourceDigests: normalized.currentSourceDigests } : {}),
  };
}
