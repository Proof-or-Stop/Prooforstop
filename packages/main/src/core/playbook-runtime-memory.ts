import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { digestCanonicalJson, digestText } from './digest.js';
import {
  attachSupersessionStatus,
  buildSupersessionProjection,
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  resolveGlobalMemoryReadPaths,
  resolveProjectMemoryReadPaths,
  searchEntries,
  type DevMemoryEntry,
} from './dev-memory.js';
import {
  computePlaybookDigest,
  readPlaybooks,
  readSignatureRegistry,
  resolvePlaybooksPath,
  resolveSignatureRegistryPath,
  validatePlaybook,
  type SignatureTagEntry,
} from './learning-store.js';
import type { Playbook } from './experience-layer-types.js';
import {
  buildRuntimeMemoryIndex,
  isRuntimeMemoryIndexFresh,
  readRuntimeMemoryIndex,
  selectRuntimeMemoryIndexCandidates,
  type RuntimeMemoryIndex,
  type RuntimeMemoryIndexCandidates,
} from './playbook-runtime-memory-index.js';
import {
  buildRuntimeMemoryPackCacheContext,
  computeMemoryPackDigest,
  getRuntimeMemoryPackCacheHit,
  rememberRuntimeMemoryPackCache,
} from './playbook-runtime-memory-cache.js';

export type RuntimePlaybookStatus = 'proposed' | 'candidate' | 'active' | 'stale' | 'archived';
export type RuntimeSeverity = 'advisory' | 'warn' | 'blocking';
export type RuntimeConsumer =
  | 'session_brief'
  | 'dev_memory_start'
  | 'host_handoff'
  | 'story_create'
  | 'story_advance'
  | 'done_prepare'
  | 'done_closure'
  | 'final_response_check';

export type MemoryFreshnessClass = 'fresh' | 'stale-relevant' | 'stale-irrelevant';
export type RuntimeHostCanonicalLabel = 'codex-cli' | 'claude-cli' | 'antigravity';
export type RuntimeCapabilityHostId = 'codex' | 'claude-code' | 'antigravity';
export type RuntimeHostRole = 'primary' | 'fallback';
export type RuntimeMemoryRolloutMode = 'advisory' | 'warn' | 'enforce';
export type RuntimePrimaryFailureSignal =
  | 'unavailable'
  | 'quota-limited'
  | 'timed-out'
  | 'explicitly-substituted';

export interface MemoryFreshnessPack {
  schemaVersion: 'proofbound.memory-pack.v1';
  generatedAt: string;
  projectRoot: string;
  query: string;
  sourceDigests: {
    projectDevMemoryDigest: string | null;
    globalDevMemoryDigest: string | null;
    playbookDigest: string | null;
    signatureRegistryDigest: string | null;
  };
  results: {
    devMemoryEntryIds: string[];
    playbookIds: string[];
    suppressedSupersededIds: string[];
    deprecatedTermHits: string[];
    contributingSourceRefs: string[];
  };
  freshness: {
    stale: boolean;
    class: MemoryFreshnessClass;
    reason?: string;
  };
  render: {
    maxLines: 60;
    omittedCount: number;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
  packDigest: string;
  context: {
    consumer: RuntimeConsumer;
    storyPhase?: string;
    touchedPaths: string[];
    host?: string;
    maxEntries: number;
    maxPlaybooks: number;
    candidateLimit?: number;
  };
  items: {
    devMemory: Array<{
      id: string;
      category: string;
      scope: string;
      summary: string;
      lesson: string;
      reusePrompt: string;
      sourceRefs: string[];
    }>;
    playbooks: Array<{
      id: string;
      title: string;
      check: string;
      reasons: string[];
      confidence: 'high' | 'medium' | 'low';
      lineage: {
        sourceStoryId: string;
        sourceFindingId: string;
        sourceSignature?: string;
      };
    }>;
  };
}

export interface RuntimeMemoryTopHits {
  ids: string[];
  playbookIds: string[];
  devMemoryEntryIds: string[];
}

export interface RuntimeHostPolicyDecision {
  requestedHost: string;
  canonicalHost: RuntimeHostCanonicalLabel;
  capabilityHostId: RuntimeCapabilityHostId;
  displayHost: string;
  role: RuntimeHostRole;
  primaryHosts: readonly ['codex-cli', 'claude-cli'];
  allowed: boolean;
  primaryFailureSignal?: RuntimePrimaryFailureSignal;
  primaryFailureRaw?: string;
  reason: string;
}

export interface RuntimeMemoryConsumerPolicyDecision {
  consumer: RuntimeConsumer;
  rolloutMode: RuntimeMemoryRolloutMode;
  severity: RuntimeSeverity;
  registeredCriticalConsumer: boolean;
  baselineRequired: 'full-1m-correctness';
  baselinePassed: boolean;
  memoryAuthoritative: false;
  gateEvidence: false;
  reason: string;
}

export interface BuildMemoryFreshnessPackOptions {
  projectRoot: string;
  query?: string;
  consumer?: RuntimeConsumer;
  storyPhase?: string;
  touchedPaths?: string[];
  host?: string;
  maxEntries?: number;
  maxPlaybooks?: number;
  maxLines?: number;
  generatedAt?: string;
  useIndex?: boolean;
  useCache?: boolean;
  runtimeIndex?: RuntimeMemoryIndex;
  candidateLimit?: number;
}

interface PlaybookMatch {
  playbook: Playbook;
  reasons: string[];
  score: number;
  confidence: 'high' | 'medium' | 'low';
}

const SCHEMA_VERSION = 'proofbound.memory-pack.v1' as const;
const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_PLAYBOOKS = 5;
const RENDER_MAX_LINES = 60;

const TRIGGER_CLASSES = [
  'host-policy',
  'stale-doc',
  'truth-first',
  'repro-first',
  'intent-totality',
  'delivery',
  'review',
  'deprecated-term',
] as const;

export const RUNTIME_MEMORY_PRIMARY_HOSTS = ['codex-cli', 'claude-cli'] as const;
const RUNTIME_MEMORY_FALLBACK_HOST = 'antigravity' as const;

const REGISTERED_CRITICAL_RUNTIME_CONSUMERS = new Set<RuntimeConsumer>([
  'done_prepare',
  'done_closure',
]);

const ADVISORY_ONLY_RUNTIME_CONSUMERS = new Set<RuntimeConsumer>([
  'final_response_check',
]);

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((v) => v.trim().length > 0))].sort();
}

function tokenize(text: string): string[] {
  return uniqueSorted((text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []));
}

function containsTerm(text: string, term: string): boolean {
  const lhs = text.toLowerCase();
  const rhs = term.trim().toLowerCase();
  return rhs.length > 0 && lhs.includes(rhs);
}

function fileKind(path: string): string {
  const ext = extname(path).replace(/^\./, '').toLowerCase();
  return ext || 'noext';
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

function readSourceDigests(projectRoot: string): MemoryFreshnessPack['sourceDigests'] {
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

function entrySourceRef(entry: DevMemoryEntry): string {
  return `dev-memory:${entry.id}:${digestCanonicalJson(entry)}`;
}

function playbookSourceRef(playbook: Playbook): string {
  return `playbook:${playbook.id}:${computePlaybookDigest(playbook)}`;
}

function signatureSourceRef(entry: SignatureTagEntry): string {
  return `signature-registry:${entry.tag}:${digestCanonicalJson(entry)}`;
}

function selectDevMemoryEntries(
  entries: DevMemoryEntry[],
  query: string,
  maxEntries: number,
): {
  selected: DevMemoryEntry[];
  suppressed: DevMemoryEntry[];
} {
  const projection = buildSupersessionProjection(entries);
  const raw = query.trim()
    ? searchEntries(entries, { query, limit: Math.max(entries.length, maxEntries) })
    : entries.slice().reverse();
  const selected: DevMemoryEntry[] = [];
  const suppressed: DevMemoryEntry[] = [];
  const selectedIds = new Set<string>();
  const suppressedIds = new Set<string>();

  for (const entry of raw) {
    const view = attachSupersessionStatus(entry, projection);
    if (view.supersession.isSuperseded) {
      if (!suppressedIds.has(entry.id)) {
        suppressedIds.add(entry.id);
        suppressed.push(entry);
      }
      continue;
    }
    if (selected.length >= maxEntries || selectedIds.has(entry.id)) continue;
    selectedIds.add(entry.id);
    selected.push(entry);
  }

  return { selected, suppressed };
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
  ].join(' ').toLowerCase();
}

function keywordMatches(token: string, keyword: string): boolean {
  const a = token.toLowerCase();
  const b = keyword.toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

function matchActivePlaybook(
  playbook: Playbook,
  opts: Required<Pick<BuildMemoryFreshnessPackOptions, 'query' | 'consumer' | 'touchedPaths'>> & {
    storyPhase?: string;
    host?: string;
  },
): PlaybookMatch | null {
  if (playbook.status !== 'active') return null;

  const reasons: string[] = [];
  let score = 0;
  const text = playbookText(playbook);
  const queryTokens = tokenize(opts.query);
  const triggerKeywords = playbook.trigger.keywords.map((k) => k.toLowerCase());
  for (const token of queryTokens) {
    if (triggerKeywords.some((keyword) => keywordMatches(token, keyword)) || text.includes(token)) {
      score += 10;
      reasons.push(`query:${token}`);
    }
  }

  if (opts.storyPhase) {
    const phase = opts.storyPhase.toLowerCase();
    if (playbook.trigger.storyPhases.some((p) => p.toLowerCase() === phase)) {
      score += 8;
      reasons.push(`phase:${opts.storyPhase}`);
    }
  }

  const touchedKinds = uniqueSorted(opts.touchedPaths.map(fileKind));
  for (const kind of touchedKinds) {
    if (playbook.trigger.fileKinds.some((k) => k.toLowerCase() === kind)) {
      score += 6;
      reasons.push(`fileKind:${kind}`);
    }
  }

  if (opts.host && containsTerm(text, opts.host)) {
    score += 4;
    reasons.push(`host:${opts.host}`);
  }
  if (containsTerm(text, opts.consumer)) {
    score += 3;
    reasons.push(`consumer:${opts.consumer}`);
  }

  for (const triggerClass of TRIGGER_CLASSES) {
    if (triggerKeywords.includes(triggerClass) || containsTerm(text, triggerClass)) {
      reasons.push(`class:${triggerClass}`);
      break;
    }
  }

  if (score <= 0) return null;
  const confidence = score >= 14 ? 'high' : score >= 8 ? 'medium' : 'low';
  return { playbook, reasons: uniqueSorted(reasons), score, confidence };
}

export function matchRuntimePlaybooks(options: BuildMemoryFreshnessPackOptions, candidatePlaybooks?: Playbook[]): PlaybookMatch[] {
  const query = options.query ?? '';
  const consumer = options.consumer ?? 'session_brief';
  const touchedPaths = options.touchedPaths ?? [];
  const matches: PlaybookMatch[] = [];
  for (const raw of candidatePlaybooks ?? readPlaybooks(options.projectRoot)) {
    const validation = validatePlaybook(raw);
    if (!validation.ok) continue;
    const match = matchActivePlaybook(validation.playbook, {
      query,
      consumer,
      storyPhase: options.storyPhase,
      touchedPaths,
      host: options.host,
    });
    if (match) matches.push(match);
  }
  return matches.sort((a, b) => b.score - a.score || a.playbook.id.localeCompare(b.playbook.id));
}

function collectDeprecatedTermHits(projectRoot: string, query: string, signatureTags?: SignatureTagEntry[]): { hits: string[]; refs: string[] } {
  const tags = signatureTags ?? readSignatureRegistry(projectRoot).tags;
  const hits: string[] = [];
  const refs: string[] = [];
  for (const tag of tags) {
    if (tag.status !== 'deprecated') continue;
    const terms = [tag.tag, ...tag.aliases];
    if (terms.some((term) => containsTerm(query, term))) {
      hits.push(tag.tag);
      refs.push(signatureSourceRef(tag));
    }
  }
  return { hits: uniqueSorted(hits), refs: uniqueSorted(refs) };
}

export function runtimeMemoryTopHits(pack: MemoryFreshnessPack, limit = 8): RuntimeMemoryTopHits {
  const playbookIds = pack.results.playbookIds.slice(0, Math.max(0, limit));
  const devMemoryEntryIds = pack.results.devMemoryEntryIds.slice(0, Math.max(0, limit));
  return {
    ids: [...playbookIds, ...devMemoryEntryIds].slice(0, Math.max(0, limit)),
    playbookIds,
    devMemoryEntryIds,
  };
}

export function renderMemoryFreshnessPackSummary(pack: MemoryFreshnessPack): string {
  const hits = runtimeMemoryTopHits(pack);
  return [
    `memoryPackDigest: ${pack.packDigest}`,
    `memoryTopHitIds: ${hits.ids.join(', ') || 'none'}`,
    `memoryAuthority: ${pack.authority}`,
    `memoryGateEvidence: ${pack.gateEvidence}`,
  ].join('\n');
}

export function normalizeRuntimeHostLabel(host: string | undefined): RuntimeHostCanonicalLabel {
  const value = (host ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!value || value === 'codex' || value === 'codex-cli' || value === 'openai-codex') return 'codex-cli';
  if (value === 'claude' || value === 'claude-code' || value === 'claude-cli' || value === 'claude-code-cli') return 'claude-cli';
  if (value === 'agy' || value === 'agy-cli' || value === 'antigravity' || value === 'antigravity-cli') return RUNTIME_MEMORY_FALLBACK_HOST;
  return value.includes('claude') ? 'claude-cli'
    : value.includes('agy') || value.includes('antigravity') ? RUNTIME_MEMORY_FALLBACK_HOST
      : 'codex-cli';
}

export function runtimeHostLabelToCapabilityHostId(host: RuntimeHostCanonicalLabel): RuntimeCapabilityHostId {
  switch (host) {
    case 'codex-cli': return 'codex';
    case 'claude-cli': return 'claude-code';
    case 'antigravity': return 'antigravity';
  }
}

export function normalizeRuntimeHostAliasForCapabilityRegistry(host: string | undefined): string {
  const raw = host?.trim() ?? '';
  const value = raw.toLowerCase().replace(/_/g, '-');
  if (!value || value === 'codex' || value === 'codex-cli' || value === 'openai-codex') return 'codex';
  if (value === 'claude' || value === 'claude-code' || value === 'claude-cli' || value === 'claude-code-cli') return 'claude-code';
  if (value === 'agy' || value === 'agy-cli' || value === 'antigravity' || value === 'antigravity-cli') return RUNTIME_MEMORY_FALLBACK_HOST;
  return raw;
}

function displayRuntimeHost(host: RuntimeHostCanonicalLabel): string {
  switch (host) {
    case 'codex-cli': return 'Codex CLI';
    case 'claude-cli': return 'Claude Code CLI';
    case 'antigravity': return 'Antigravity (agy-cli)';
  }
}

function parsePrimaryFailureSignal(raw: string | undefined): RuntimePrimaryFailureSignal | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (/\b(unavailable|not available|missing|not found|cannot spawn|spawn failed)\b/.test(value)) return 'unavailable';
  if (/\b(quota[- ]?limited|quota|rate[- ]?limited|429)\b/.test(value)) return 'quota-limited';
  if (/\b(timed[- ]?out|timeout|deadline)\b/.test(value)) return 'timed-out';
  if (/\b(explicitly[- ]?substituted|substitute|standby|fallback requested)\b/.test(value)) return 'explicitly-substituted';
  return undefined;
}

export function evaluateRuntimeHostPolicy(args: {
  requestedHost?: string;
  primaryHostFailure?: string;
}): RuntimeHostPolicyDecision {
  const requestedHost = args.requestedHost?.trim() || 'codex-cli';
  const canonicalHost = normalizeRuntimeHostLabel(requestedHost);
  const capabilityHostId = runtimeHostLabelToCapabilityHostId(canonicalHost);
  const failureSignal = parsePrimaryFailureSignal(args.primaryHostFailure);
  if (canonicalHost !== RUNTIME_MEMORY_FALLBACK_HOST) {
    return {
      requestedHost,
      canonicalHost,
      capabilityHostId,
      displayHost: displayRuntimeHost(canonicalHost),
      role: 'primary',
      primaryHosts: RUNTIME_MEMORY_PRIMARY_HOSTS,
      allowed: true,
      ...(failureSignal ? { primaryFailureSignal: failureSignal, primaryFailureRaw: args.primaryHostFailure } : {}),
      reason: 'Codex CLI and Claude Code CLI are primary hosts for runtime-memory handoff and verification.',
    };
  }
  const allowed = Boolean(failureSignal);
  return {
    requestedHost,
    canonicalHost,
    capabilityHostId,
    displayHost: displayRuntimeHost(canonicalHost),
    role: 'fallback',
    primaryHosts: RUNTIME_MEMORY_PRIMARY_HOSTS,
    allowed,
    ...(failureSignal ? { primaryFailureSignal: failureSignal, primaryFailureRaw: args.primaryHostFailure } : {}),
    reason: allowed
      ? `agy-cli fallback accepted after concrete primary failure signal: ${failureSignal}.`
      : 'agy-cli/Antigravity is fallback-only; provide primaryHostFailure=unavailable|quota-limited|timed-out|explicitly-substituted after Codex CLI or Claude Code CLI cannot be used.',
  };
}

export function assertRuntimeHostPolicyAllowed(decision: RuntimeHostPolicyDecision, commandName: string): void {
  if (decision.allowed) return;
  throw new Error(`${commandName}: ${decision.reason}`);
}

export function evaluateRuntimeMemoryConsumerPolicy(args: {
  consumer: RuntimeConsumer;
  rolloutMode?: RuntimeMemoryRolloutMode;
  fullBaselinePassed?: boolean;
}): RuntimeMemoryConsumerPolicyDecision {
  const rolloutMode = args.rolloutMode ?? 'advisory';
  const advisoryOnlyConsumer = ADVISORY_ONLY_RUNTIME_CONSUMERS.has(args.consumer);
  const registeredCriticalConsumer = !advisoryOnlyConsumer && REGISTERED_CRITICAL_RUNTIME_CONSUMERS.has(args.consumer);
  const fullBaselinePassed = args.fullBaselinePassed === true;
  const canEscalate = registeredCriticalConsumer && fullBaselinePassed;
  const severity: RuntimeSeverity = rolloutMode === 'advisory'
    ? 'advisory'
    : canEscalate ? (rolloutMode === 'enforce' ? 'blocking' : 'warn')
      : 'advisory';
  return {
    consumer: args.consumer,
    rolloutMode,
    severity,
    registeredCriticalConsumer,
    baselineRequired: 'full-1m-correctness',
    baselinePassed: fullBaselinePassed,
    memoryAuthoritative: false,
    gateEvidence: false,
    reason: advisoryOnlyConsumer
      ? `${args.consumer} is advisory-only and cannot become blocking even when rollout enforcement and the full 1M baseline are enabled.`
      : severity === 'advisory'
      ? 'Runtime memory remains advisory unless the consumer is registered critical and the full 1M correctness baseline has passed.'
      : `Registered critical consumer ${args.consumer} may surface ${severity} runtime-memory diagnostics after the full 1M correctness baseline passed; memory still cannot satisfy gates.`,
  };
}

function buildRenderLines(pack: MemoryFreshnessPack): string[] {
  const hits = runtimeMemoryTopHits(pack);
  const lines: string[] = [
    '## Memory Runtime Preflight',
    `  authority=${pack.authority} gateEvidence=${pack.gateEvidence}`,
    `  packDigest: ${pack.packDigest}`,
    `  topHitIds: ${hits.ids.join(', ') || 'none'}`,
    `  freshness: ${pack.freshness.class}${pack.freshness.reason ? ` (${pack.freshness.reason})` : ''}`,
    `  sourceDigests: project=${pack.sourceDigests.projectDevMemoryDigest ?? 'none'} global=${pack.sourceDigests.globalDevMemoryDigest ?? 'none'} playbooks=${pack.sourceDigests.playbookDigest ?? 'none'} signatures=${pack.sourceDigests.signatureRegistryDigest ?? 'none'}`,
  ];

  if (pack.items.playbooks.length === 0 && pack.items.devMemory.length === 0) {
    lines.push('  empty: no relevant active playbooks or dev-memory entries surfaced');
  }

  if (pack.items.playbooks.length > 0) {
    lines.push(`  Active playbooks (${pack.items.playbooks.length}):`);
    for (const item of pack.items.playbooks) {
      lines.push(`    - ${item.id} ${item.title}`);
      lines.push(`      check: ${item.check}`);
      lines.push(`      reasons: ${item.reasons.join(', ') || 'matched'}`);
      lines.push(`      source: ${item.lineage.sourceStoryId} ${item.lineage.sourceFindingId}`);
    }
  }

  if (pack.items.devMemory.length > 0) {
    lines.push(`  Dev-memory (${pack.items.devMemory.length}):`);
    for (const item of pack.items.devMemory) {
      lines.push(`    - ${item.id} ${item.category}/${item.scope}: ${item.summary}`);
      lines.push(`      lesson: ${item.lesson}`);
      lines.push(`      reuse: ${item.reusePrompt}`);
    }
  }

  if (pack.results.suppressedSupersededIds.length > 0) {
    lines.push(`  suppressedSupersededIds: ${pack.results.suppressedSupersededIds.join(', ')}`);
  }
  if (pack.results.deprecatedTermHits.length > 0) {
    lines.push(`  deprecatedTermHits: ${pack.results.deprecatedTermHits.join(', ')}`);
  }

  lines.push(`  render: maxLines=${pack.render.maxLines} omittedCount=${pack.render.omittedCount}`);
  return lines;
}

function omittedCountFor(pack: MemoryFreshnessPack): number {
  const lineCount = buildRenderLines(pack).length;
  return lineCount > RENDER_MAX_LINES ? lineCount - RENDER_MAX_LINES + 1 : 0;
}

function resolveRuntimeIndexForPack(options: BuildMemoryFreshnessPackOptions): RuntimeMemoryIndex | null {
  if (options.useIndex === false) return null;
  if (options.runtimeIndex) {
    return isRuntimeMemoryIndexFresh(options.runtimeIndex, options.projectRoot) ? options.runtimeIndex : null;
  }
  const stored = readRuntimeMemoryIndex(options.projectRoot);
  if (stored && isRuntimeMemoryIndexFresh(stored, options.projectRoot)) return stored;
  try {
    return buildRuntimeMemoryIndex(options.projectRoot);
  } catch {
    return null;
  }
}

export function buildMemoryFreshnessPack(options: BuildMemoryFreshnessPackOptions): MemoryFreshnessPack {
  const query = options.query?.trim() ?? '';
  const maxEntries = Math.max(0, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxPlaybooks = Math.max(0, Math.floor(options.maxPlaybooks ?? DEFAULT_MAX_PLAYBOOKS));
  const candidateLimit = options.candidateLimit === undefined
    ? undefined
    : Math.max(0, Math.floor(options.candidateLimit));
  const maxLines: 60 = RENDER_MAX_LINES;
  const consumer = options.consumer ?? 'session_brief';
  const runtimeIndex = resolveRuntimeIndexForPack(options);
  const cacheContext = options.useIndex === false || options.useCache === false
    ? null
    : buildRuntimeMemoryPackCacheContext(options, {
      schemaVersion: SCHEMA_VERSION,
      query,
      consumer,
      maxEntries,
      maxPlaybooks,
      maxLines,
      candidateLimit,
      runtimeIndex,
    });
  if (cacheContext) {
    const cached = getRuntimeMemoryPackCacheHit(cacheContext);
    if (cached.hit) {
      return {
        ...cached.pack,
        generatedAt: options.generatedAt ?? cached.pack.generatedAt,
      };
    }
  }

  const indexedOptions = candidateLimit === undefined ? options : { ...options, candidateLimit };
  const indexed = resolveIndexedCandidates(indexedOptions, query, maxEntries, maxPlaybooks, runtimeIndex);
  const allEntries = indexed?.devMemoryEntries
    ?? mergeEntries(readProjectMemoryEntries(options.projectRoot), readGlobalMemoryEntries());
  const { selected, suppressed } = selectDevMemoryEntries(allEntries, query, maxEntries);
  const playbookMatches = matchRuntimePlaybooks({
    ...options,
    query,
    consumer,
    maxPlaybooks,
  }, indexed?.playbooks).slice(0, maxPlaybooks);
  const deprecated = collectDeprecatedTermHits(options.projectRoot, query, indexed?.signatureTags);

  const contributingSourceRefs = uniqueSorted([
    ...selected.map(entrySourceRef),
    ...suppressed.map(entrySourceRef),
    ...playbookMatches.map((match) => playbookSourceRef(match.playbook)),
    ...deprecated.refs,
  ]);

  const pack: MemoryFreshnessPack = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    projectRoot: options.projectRoot,
    query,
    sourceDigests: readSourceDigests(options.projectRoot),
    results: {
      devMemoryEntryIds: selected.map((entry) => entry.id),
      playbookIds: playbookMatches.map((match) => match.playbook.id),
      suppressedSupersededIds: suppressed.map((entry) => entry.id),
      deprecatedTermHits: deprecated.hits,
      contributingSourceRefs,
    },
    freshness: { stale: false, class: 'fresh' },
    render: { maxLines, omittedCount: 0 },
    authority: 'non_authoritative',
    gateEvidence: false,
    packDigest: '',
    context: {
      consumer: options.consumer ?? 'session_brief',
      storyPhase: options.storyPhase,
      touchedPaths: options.touchedPaths ?? [],
      host: options.host,
      maxEntries,
      maxPlaybooks,
      ...(candidateLimit !== undefined ? { candidateLimit } : {}),
    },
    items: {
      devMemory: selected.map((entry) => ({
        id: entry.id,
        category: entry.category,
        scope: entry.scope,
        summary: entry.summary,
        lesson: entry.lesson,
        reusePrompt: entry.reusePrompt,
        sourceRefs: entry.evidenceRefs ?? [],
      })),
      playbooks: playbookMatches.map((match) => ({
        id: match.playbook.id,
        title: match.playbook.title,
        check: match.playbook.check,
        reasons: match.reasons,
        confidence: match.confidence,
        lineage: match.playbook.lineage,
      })),
    },
  };
  pack.packDigest = computeMemoryPackDigest(pack);
  pack.render.omittedCount = omittedCountFor(pack);
  pack.packDigest = computeMemoryPackDigest(pack);
  if (cacheContext) rememberRuntimeMemoryPackCache(cacheContext, pack);
  return pack;
}

function resolveIndexedCandidates(
  options: BuildMemoryFreshnessPackOptions,
  query: string,
  maxEntries: number,
  maxPlaybooks: number,
  runtimeIndex?: RuntimeMemoryIndex | null,
): RuntimeMemoryIndexCandidates | null {
  if (options.useIndex === false) return null;
  const index = runtimeIndex ?? options.runtimeIndex ?? readRuntimeMemoryIndex(options.projectRoot);
  if (!index || !isRuntimeMemoryIndexFresh(index, options.projectRoot)) return null;
  return selectRuntimeMemoryIndexCandidates(index, {
    query,
    consumer: options.consumer ?? 'session_brief',
    storyPhase: options.storyPhase,
    touchedPaths: options.touchedPaths ?? [],
    host: options.host,
    maxEntries,
    maxPlaybooks,
    candidateLimit: options.candidateLimit,
  });
}

function sameValues(a: string[], b: string[]): boolean {
  const left = uniqueSorted(a);
  const right = uniqueSorted(b);
  return left.length === right.length && left.every((value, idx) => value === right[idx]);
}

function sameSourceDigests(a: MemoryFreshnessPack['sourceDigests'], b: MemoryFreshnessPack['sourceDigests']): boolean {
  return a.projectDevMemoryDigest === b.projectDevMemoryDigest
    && a.globalDevMemoryDigest === b.globalDevMemoryDigest
    && a.playbookDigest === b.playbookDigest
    && a.signatureRegistryDigest === b.signatureRegistryDigest;
}

function sameRelevantResults(a: MemoryFreshnessPack, b: MemoryFreshnessPack): boolean {
  return sameValues(a.results.devMemoryEntryIds, b.results.devMemoryEntryIds)
    && sameValues(a.results.playbookIds, b.results.playbookIds)
    && sameValues(a.results.suppressedSupersededIds, b.results.suppressedSupersededIds)
    && sameValues(a.results.deprecatedTermHits, b.results.deprecatedTermHits)
    && sameValues(a.results.contributingSourceRefs, b.results.contributingSourceRefs);
}

export function classifyMemoryFreshnessPack(
  pack: MemoryFreshnessPack,
  options: Partial<BuildMemoryFreshnessPackOptions> = {},
): MemoryFreshnessPack {
  const current = buildMemoryFreshnessPack({
    projectRoot: options.projectRoot ?? pack.projectRoot,
    query: options.query ?? pack.query,
    consumer: options.consumer ?? pack.context.consumer,
    storyPhase: options.storyPhase ?? pack.context.storyPhase,
    touchedPaths: options.touchedPaths ?? pack.context.touchedPaths,
    host: options.host ?? pack.context.host,
    maxEntries: options.maxEntries ?? pack.context.maxEntries,
    maxPlaybooks: options.maxPlaybooks ?? pack.context.maxPlaybooks,
    candidateLimit: options.candidateLimit ?? pack.context.candidateLimit,
    maxLines: options.maxLines ?? pack.render.maxLines,
    useCache: false,
    useIndex: options.useIndex ?? false,
    runtimeIndex: options.runtimeIndex,
  });

  if (sameSourceDigests(pack.sourceDigests, current.sourceDigests)) {
    const freshPack: MemoryFreshnessPack = {
      ...pack,
      freshness: { stale: false, class: 'fresh' },
    };
    return {
      ...freshPack,
      packDigest: computeMemoryPackDigest(freshPack),
    };
  }

  const relevant = !sameRelevantResults(pack, current);
  const stalePack: MemoryFreshnessPack = {
    ...pack,
    freshness: {
      stale: true,
      class: relevant ? 'stale-relevant' : 'stale-irrelevant',
      reason: relevant
        ? 'source digest changed and surfaced/suppressed/runtime refs changed'
        : 'source digest changed but surfaced runtime refs are unchanged',
    },
  };
  return {
    ...stalePack,
    packDigest: computeMemoryPackDigest(stalePack),
  };
}

export function renderMemoryFreshnessPack(pack: MemoryFreshnessPack): string {
  const lines = buildRenderLines(pack);
  const maxLines = Math.min(RENDER_MAX_LINES, Math.max(1, pack.render.maxLines));
  if (lines.length <= maxLines) return lines.join('\n');
  const omitted = lines.length - maxLines + 1;
  return [
    ...lines.slice(0, maxLines - 1),
    `  ... ${omitted} line(s) omitted by MemoryFreshnessPack render cap`,
  ].join('\n');
}
