/**
 * @task B-5155
 * @checklist CHK-003
 * @title Map future-blocked key-ref boundary without implementing locked suite
 * @type chore
 * @priority high
 * @description
 *   Pure INIT→INIT_CHECK scope anti-expansion evaluator.
 *   The existing excluded-keyword boundary keeps `customerKeyRef` future/blocked,
 *   `redacted`, and `non-secret`; it does not implement customerKeyRef and must
 *   not be read as current support.
 * @changes
 *   - Preserve the current `DEFAULT_CORRECTNESS_FIX_EXCLUDED_KEYWORDS`
 *     boundary and expose a truthful anchor for `customerKeyRef` as
 *     future/blocked.
 *
 * Handlers are expected to pass a bounded projection of story title/description,
 * checklist title/context/excludes, scope boundary, execution boundary, and any
 * discard digest entries. This module performs no filesystem or store reads.
 */

import { canonicalDigest } from './authority-signing.js';
import type {
  ExecutionBoundaryData,
  ScopeBoundaryData,
  ScopeBoundaryMode,
  ScopeDiscardDigestData,
  ScopeDiscardDigestEntry,
  ScopeExtensionDecision,
  ScopeExtensionDecisionRecord,
  ScopeExtensionDecisionValue,
  ScopeExtensionPatch,
  ScopeExtensionProposal,
  ScopeFreezeCheckData,
  ScopeFreezeDiscardOverlap,
  ScopeFreezeIssue,
  ScopeFreezeKeywordHit,
  ScopeFreezeTextSource,
} from './types.js';

export const SCOPE_ANTI_EXPANSION_SCHEMA_VERSION = 'lattice.scope_anti_expansion.v1';
export const SCOPE_BOUNDARY_FILE = 'scope-boundary.json';
export const EXECUTION_BOUNDARY_FILE = 'execution-boundary.json';
export const SCOPE_FREEZE_CHECK_FILE = 'scope-freeze-check.json';
export const SCOPE_EXTENSION_PROPOSALS_FILE = 'scope-extension-proposals.json';
export const SCOPE_EXTENSION_DECISIONS_FILE = 'scope-extension-decisions.json';

export const DEFAULT_CORRECTNESS_FIX_EXCLUDED_KEYWORDS = [
  'repair UX',
  'Authority',
  'Layer4',
  'customerKeyRef',
] as const;

const REPEAT_DISCARD_OVERLAP_THRESHOLD = 0.5;

export interface ScopeFreezeChecklistProjection {
  id: string;
  title: string;
  context?: string;
  excludes?: string[];
}

export interface ScopeFreezeStoryProjection {
  title?: string;
  description?: string;
  background?: string;
}

export interface ScopeFreezeEvaluationInput {
  storyId: string;
  mode?: ScopeBoundaryMode;
  scopeBoundary?: ScopeBoundaryData | null;
  executionBoundary?: ExecutionBoundaryData | null;
  story?: ScopeFreezeStoryProjection;
  checklist?: ScopeFreezeChecklistProjection[];
  discardDigest?: ScopeDiscardDigestData | null;
  repeatDiscardMitigation?: string;
  repeatDiscardMitigations?: readonly ScopeFreezeDiscardMitigation[];
  now?: string;
}

export interface ScopeFreezeEvaluationResult {
  check: ScopeFreezeCheckData;
  normalizedScopeBoundary: ScopeBoundaryData | null;
  normalizedExecutionBoundary: ExecutionBoundaryData | null;
  currentDiscardDigest: string;
}

export interface ScopeFreezeDiscardMitigation {
  digest: string;
  overlapTerms: string[];
  mitigation: string;
  previousStoryId?: string;
}

export interface BuildScopeBoundaryInput {
  storyId: string;
  mode: ScopeBoundaryMode;
  allowed?: string[];
  excluded?: string[];
  confirmedBy?: string;
  confirmationNote?: string;
  now?: string;
}

export interface BuildExecutionBoundaryInput {
  storyId: string;
  allowedCommands?: string[];
  allowedTools?: string[];
  allowedPaths?: string[];
  excludedCommands?: string[];
  excludedTools?: string[];
  excludedPaths?: string[];
  confirmedBy?: string;
  confirmationNote?: string;
  now?: string;
}

export interface BuildScopeExtensionProposalInput {
  proposalId: string;
  storyId: string;
  proposedBy: string;
  proposal?: string;
  reason: string;
  patch: ScopeExtensionPatch;
  reviewerRunId?: string;
  proposedAt?: string;
}

export interface BuildScopeExtensionDecisionInput {
  proposalId: string;
  decision: ScopeExtensionDecisionValue;
  decidedBy: string;
  rationale: string;
  decidedAt?: string;
}

interface HandlerScopeBoundaryArgs {
  storyId: string;
  allowedScope: string[];
  excludedScope?: string[];
  userConfirmed?: boolean;
  confirmation?: string;
  actor?: string;
  mode?: ScopeBoundaryMode;
}

interface HandlerExecutionBoundaryArgs {
  storyId: string;
  allowedCommands?: string[];
  blockedCommands?: string[];
  excludedCommands?: string[];
  allowedPaths?: string[];
  blockedPaths?: string[];
  excludedPaths?: string[];
  allowedTools?: string[];
  blockedTools?: string[];
  excludedTools?: string[];
  notes?: string;
  actor?: string;
}

interface HandlerScopeFreezeCheckArgs {
  storyId: string;
  status?: 'PASS' | 'FAIL' | 'pass' | 'fail';
  checks?: Array<{ id: string; status: 'PASS' | 'FAIL' | 'pass' | 'fail'; note?: string }>;
  note?: string;
  actor?: string;
}

interface HandlerScopeExtensionProposalArgs {
  storyId: string;
  proposal: string;
  reason?: string;
  reviewer?: string;
  findingId?: string;
  evidenceRefs?: string[];
}

interface HandlerScopeExtensionDecideArgs {
  storyId: string;
  proposalId: string;
  decision: 'accepted' | 'rejected';
  reason: string;
  decider?: string;
}

type JsonObject = Record<string, unknown>;

function normalizeTerm(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function termKey(value: string): string {
  return normalizeTerm(value).toLowerCase();
}

function matchKey(value: string): string {
  return termKey(value).replace(/[\s_-]+/g, '');
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && normalizeTerm(value).length > 0;
}

export function scopeFreezeBackgroundTerms(value: string | null | undefined): string[] {
  const text = typeof value === 'string' ? value : undefined;
  if (!nonEmpty(text)) return [];
  const chunks = text
    .split(/\n\s*\n/g)
    .map(chunk => normalizeTerm(chunk))
    .filter(chunk => chunk.length > 0);
  return normalizeBoundaryArray([text, ...chunks]);
}

function digest(value: unknown): string {
  return canonicalDigest(value);
}

export function normalizeBoundaryArray(values: readonly string[] | null | undefined, fieldName = 'boundary array'): string[] {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  const byKey = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    const normalized = normalizeTerm(value);
    if (normalized.length === 0) continue;
    const key = normalized.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, normalized);
  }
  return [...byKey.values()].sort((a, b) => termKey(a).localeCompare(termKey(b)));
}

function normalizeStrictBoundaryArray(values: readonly string[] | null | undefined, fieldName: string): string[] {
  if (values == null) return [];
  const normalized = normalizeBoundaryArray(values, fieldName);
  if (Array.isArray(values) && values.some(value => normalizeTerm(value).length === 0)) {
    throw new Error(`${fieldName} cannot include blank entries`);
  }
  return normalized;
}

function normalizeBoundaryPathArray(values: readonly string[] | null | undefined, fieldName: string): string[] {
  const paths = normalizeStrictBoundaryArray(values, fieldName);
  for (const path of paths) {
    const segments = path.split(/[\\/]+/);
    const unsafe =
      path.includes('\0') ||
      path.startsWith('/') ||
      path.startsWith('~') ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      segments.includes('..');
    if (unsafe) {
      throw new Error(`${fieldName} must contain safe relative paths without absolute, home, drive, NUL, or traversal segments`);
    }
  }
  return paths;
}

export function normalizeScopeBoundary(boundary: ScopeBoundaryData): ScopeBoundaryData {
  const normalized: ScopeBoundaryData = {
    ...boundary,
    allowed: normalizeBoundaryArray(boundary.allowed),
    excluded: normalizeBoundaryArray(boundary.excluded),
  };
  return { ...normalized, _hash: digestScopeBoundary(normalized) };
}

export function normalizeExecutionBoundary(boundary: ExecutionBoundaryData): ExecutionBoundaryData {
  const normalized: ExecutionBoundaryData = {
    ...boundary,
    allowedCommands: normalizeBoundaryArray(boundary.allowedCommands),
    allowedTools: normalizeBoundaryArray(boundary.allowedTools),
    allowedPaths: normalizeBoundaryArray(boundary.allowedPaths),
    excludedCommands: normalizeBoundaryArray(boundary.excludedCommands),
    excludedTools: normalizeBoundaryArray(boundary.excludedTools),
    excludedPaths: normalizeBoundaryArray(boundary.excludedPaths),
  };
  return { ...normalized, _hash: digestExecutionBoundary(normalized) };
}

export function digestScopeBoundary(boundary: ScopeBoundaryData): string {
  return digest({
    schemaVersion: boundary.schemaVersion,
    storyId: boundary.storyId,
    mode: boundary.mode,
    allowed: normalizeBoundaryArray(boundary.allowed),
    excluded: normalizeBoundaryArray(boundary.excluded),
    confirmationNote: nonEmpty(boundary.confirmationNote) ? normalizeTerm(boundary.confirmationNote) : undefined,
  });
}

export function digestExecutionBoundary(boundary: ExecutionBoundaryData): string {
  return digest({
    schemaVersion: boundary.schemaVersion,
    storyId: boundary.storyId,
    allowedCommands: normalizeBoundaryArray(boundary.allowedCommands),
    allowedTools: normalizeBoundaryArray(boundary.allowedTools),
    allowedPaths: normalizeBoundaryArray(boundary.allowedPaths),
    excludedCommands: normalizeBoundaryArray(boundary.excludedCommands),
    excludedTools: normalizeBoundaryArray(boundary.excludedTools),
    excludedPaths: normalizeBoundaryArray(boundary.excludedPaths),
    confirmationNote: nonEmpty(boundary.confirmationNote) ? normalizeTerm(boundary.confirmationNote) : undefined,
  });
}

export function buildScopeBoundary(input: BuildScopeBoundaryInput): ScopeBoundaryData {
  const now = input.now ?? new Date().toISOString();
  const allowed = normalizeStrictBoundaryArray(input.allowed, 'scopeBoundary.allowed');
  if (allowed.length === 0) {
    throw new Error('scopeBoundary.allowed must include at least one non-empty entry');
  }
  const boundary: ScopeBoundaryData = {
    schemaVersion: 'lattice.scope_boundary.v1',
    storyId: input.storyId,
    mode: input.mode,
    allowed,
    excluded: normalizeStrictBoundaryArray(input.excluded, 'scopeBoundary.excluded'),
    ...(nonEmpty(input.confirmedBy) ? { confirmedBy: normalizeTerm(input.confirmedBy) } : {}),
    ...(nonEmpty(input.confirmationNote) ? { confirmationNote: normalizeTerm(input.confirmationNote) } : {}),
    createdAt: now,
    updatedAt: now,
    _hash: '',
  };
  return { ...boundary, _hash: digestScopeBoundary(boundary) };
}

export function buildExecutionBoundary(input: BuildExecutionBoundaryInput): ExecutionBoundaryData {
  const now = input.now ?? new Date().toISOString();
  const allowedCommands = normalizeStrictBoundaryArray(input.allowedCommands, 'executionBoundary.allowedCommands');
  const allowedTools = normalizeStrictBoundaryArray(input.allowedTools, 'executionBoundary.allowedTools');
  const allowedPaths = normalizeBoundaryPathArray(input.allowedPaths, 'executionBoundary.allowedPaths');
  const excludedCommands = normalizeStrictBoundaryArray(input.excludedCommands, 'executionBoundary.excludedCommands');
  const excludedTools = normalizeStrictBoundaryArray(input.excludedTools, 'executionBoundary.excludedTools');
  const excludedPaths = normalizeBoundaryPathArray(input.excludedPaths, 'executionBoundary.excludedPaths');
  if (
    allowedCommands.length === 0 &&
    allowedTools.length === 0 &&
    allowedPaths.length === 0 &&
    excludedCommands.length === 0 &&
    excludedTools.length === 0 &&
    excludedPaths.length === 0
  ) {
    throw new Error('executionBoundary must include at least one allowed or excluded command/tool/path entry');
  }
  const boundary: ExecutionBoundaryData = {
    schemaVersion: 'lattice.execution_boundary.v1',
    storyId: input.storyId,
    allowedCommands,
    allowedTools,
    allowedPaths,
    excludedCommands,
    excludedTools,
    excludedPaths,
    ...(nonEmpty(input.confirmedBy) ? { confirmedBy: normalizeTerm(input.confirmedBy) } : {}),
    ...(nonEmpty(input.confirmationNote) ? { confirmationNote: normalizeTerm(input.confirmationNote) } : {}),
    createdAt: now,
    updatedAt: now,
    _hash: '',
  };
  return { ...boundary, _hash: digestExecutionBoundary(boundary) };
}

export function scopeBoundaryHashIsFresh(boundary: ScopeBoundaryData | null | undefined): boolean {
  return !!boundary && boundary._hash === digestScopeBoundary(boundary);
}

export function executionBoundaryHashIsFresh(boundary: ExecutionBoundaryData | null | undefined): boolean {
  return !!boundary && boundary._hash === digestExecutionBoundary(boundary);
}

export function effectiveExcludedKeywords(
  boundary: ScopeBoundaryData | null | undefined,
  mode: ScopeBoundaryMode,
): string[] {
  const defaults = mode === 'correctness_fix'
    ? [...DEFAULT_CORRECTNESS_FIX_EXCLUDED_KEYWORDS]
    : [];
  return normalizeBoundaryArray([...(boundary?.excluded ?? []), ...defaults]);
}

function textSource(source: ScopeFreezeTextSource['source'], text: string | undefined, opts: {
  itemId?: string;
  excluded?: boolean;
} = {}): ScopeFreezeTextSource | null {
  if (!nonEmpty(text)) return null;
  return {
    source,
    text: normalizeTerm(text),
    ...(opts.itemId ? { itemId: opts.itemId } : {}),
    ...(opts.excluded ? { excluded: true } : {}),
  };
}

function boundedTextSources(
  input: ScopeFreezeEvaluationInput,
  boundary: ScopeBoundaryData | null,
): ScopeFreezeTextSource[] {
  const sources: ScopeFreezeTextSource[] = [];
  const storyTitle = textSource('story.title', input.story?.title);
  const storyDescription = textSource('story.description', input.story?.description);
  const storyBackground = textSource('story.background', input.story?.background);
  if (storyTitle) sources.push(storyTitle);
  if (storyDescription) sources.push(storyDescription);
  if (storyBackground) sources.push(storyBackground);
  for (const item of input.checklist ?? []) {
    const title = textSource('checklist.title', item.title, { itemId: item.id });
    const context = textSource('checklist.context', item.context, { itemId: item.id });
    if (title) sources.push(title);
    if (context) sources.push(context);
    for (const excluded of item.excludes ?? []) {
      const source = textSource('checklist.excludes', excluded, { itemId: item.id, excluded: true });
      if (source) sources.push(source);
    }
  }
  for (const allowed of boundary?.allowed ?? []) {
    const source = textSource('scopeBoundary.allowed', allowed);
    if (source) sources.push(source);
  }
  for (const excluded of boundary?.excluded ?? []) {
    const source = textSource('scopeBoundary.excluded', excluded, { excluded: true });
    if (source) sources.push(source);
  }
  return sources;
}

export function scanExcludedKeywordHits(
  sources: readonly ScopeFreezeTextSource[],
  keywords: readonly string[],
): ScopeFreezeKeywordHit[] {
  const hits: ScopeFreezeKeywordHit[] = [];
  const seen = new Set<string>();
  for (const keyword of normalizeBoundaryArray(keywords)) {
    const needle = matchKey(keyword);
    if (needle.length === 0) continue;
    for (const source of sources) {
      if (!matchKey(source.text).includes(needle)) continue;
      const key = `${keyword}::${source.source}::${source.itemId ?? ''}::${source.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        keyword,
        source: source.source,
        text: source.text,
        ...(source.itemId ? { itemId: source.itemId } : {}),
        excluded: source.excluded === true,
      });
    }
  }
  return hits;
}

function sourceTerms(input: ScopeFreezeEvaluationInput, boundary: ScopeBoundaryData | null): string[] {
  const terms: string[] = [
    input.story?.title ?? '',
    input.story?.description ?? '',
    ...scopeFreezeBackgroundTerms(input.story?.background),
    ...(boundary?.allowed ?? []),
  ];
  for (const item of input.checklist ?? []) {
    terms.push(item.title, item.context ?? '');
  }
  return normalizeBoundaryArray(terms);
}

export function computeDiscardDirectionDigest(terms: readonly string[]): string {
  return digest({
    schemaVersion: SCOPE_ANTI_EXPANSION_SCHEMA_VERSION,
    kind: 'discard_direction',
    terms: normalizeBoundaryArray(terms),
  });
}

function overlapRatio(a: readonly string[], b: readonly string[]): { terms: string[]; ratio: number } {
  const left = new Set(normalizeBoundaryArray(a).map(termKey));
  const rightByKey = new Map(normalizeBoundaryArray(b).map(value => [termKey(value), value] as const));
  const overlap: string[] = [];
  for (const key of left) {
    const original = rightByKey.get(key);
    if (original) overlap.push(original);
  }
  const denominator = Math.min(left.size, rightByKey.size);
  return {
    terms: overlap.sort((x, y) => termKey(x).localeCompare(termKey(y))),
    ratio: denominator === 0 ? 0 : overlap.length / denominator,
  };
}

export function findRepeatDiscardOverlaps(args: {
  currentTerms: readonly string[];
  currentDigest: string;
  discardDigest?: ScopeDiscardDigestData | null;
  mitigation?: string;
  mitigations?: readonly ScopeFreezeDiscardMitigation[];
}): ScopeFreezeDiscardOverlap[] {
  const mitigation = nonEmpty(args.mitigation) ? normalizeTerm(args.mitigation) : undefined;
  const mitigationByOverlap = new Map<string, string>();
  for (const item of args.mitigations ?? []) {
    if (!nonEmpty(item.mitigation)) continue;
    mitigationByOverlap.set(scopeFreezeDiscardOverlapKey(item), normalizeTerm(item.mitigation));
  }
  const overlaps: ScopeFreezeDiscardOverlap[] = [];
  const seen = new Set<string>();
  for (const entry of args.discardDigest?.entries ?? []) {
    const entryTerms = normalizeBoundaryArray(entry.terms);
    const ratio = overlapRatio(args.currentTerms, entryTerms);
    const digestMatches = entry.digest === args.currentDigest;
    const overlapsEnough = digestMatches || ratio.ratio >= REPEAT_DISCARD_OVERLAP_THRESHOLD;
    if (!overlapsEnough) continue;
    const overlapTerms = digestMatches && ratio.terms.length === 0 ? entryTerms : ratio.terms;
    const key = scopeFreezeDiscardOverlapKey({
      digest: entry.digest,
      overlapTerms,
      previousStoryId: entry.storyId,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    const targetedMitigation = mitigationByOverlap.get(key);
    overlaps.push({
      digest: entry.digest,
      overlapTerms,
      overlapRatio: digestMatches ? 1 : ratio.ratio,
      ...(entry.storyId ? { previousStoryId: entry.storyId } : {}),
      ...(entry.reason ? { previousReason: entry.reason } : {}),
      ...(entry.discardedAt ? { previousDiscardedAt: entry.discardedAt } : {}),
      ...(mitigation ?? targetedMitigation ?? entry.mitigation ? { mitigation: mitigation ?? targetedMitigation ?? entry.mitigation } : {}),
    });
  }
  return overlaps;
}

export function scopeFreezeDiscardOverlapKey(overlap: {
  digest: string;
  overlapTerms: readonly string[];
  previousStoryId?: string;
}): string {
  return digest({
    kind: 'scope_freeze_discard_overlap_identity',
    digest: normalizeTerm(overlap.digest),
    previousStoryId: nonEmpty(overlap.previousStoryId) ? normalizeTerm(overlap.previousStoryId) : undefined,
    overlapTerms: normalizeBoundaryArray(overlap.overlapTerms),
  });
}

function discardCorpusIdentity(discardDigest: ScopeDiscardDigestData | null | undefined): unknown {
  const entries = (discardDigest?.entries ?? []).map(entry => ({
    digest: normalizeTerm(entry.digest),
    storyId: nonEmpty(entry.storyId) ? normalizeTerm(entry.storyId) : undefined,
    terms: normalizeBoundaryArray(entry.terms),
  }));
  entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    entryCount: entries.length,
    entries,
  };
}

function repeatDiscardOverlapIdentity(overlaps: readonly ScopeFreezeDiscardOverlap[]): unknown {
  const identities = overlaps.map(overlap => ({
    key: scopeFreezeDiscardOverlapKey(overlap),
    digest: normalizeTerm(overlap.digest),
    previousStoryId: nonEmpty(overlap.previousStoryId) ? normalizeTerm(overlap.previousStoryId) : undefined,
    overlapTerms: normalizeBoundaryArray(overlap.overlapTerms),
  }));
  identities.sort((a, b) => a.key.localeCompare(b.key));
  return {
    count: identities.length,
    identities,
  };
}

export function storedScopeFreezeDiscardMitigations(check: ScopeFreezeCheckData | null | undefined): ScopeFreezeDiscardMitigation[] {
  const mitigations: ScopeFreezeDiscardMitigation[] = [];
  for (const overlap of check?.repeatDiscardOverlaps ?? []) {
    if (!nonEmpty(overlap.mitigation)) continue;
    mitigations.push({
      digest: overlap.digest,
      overlapTerms: normalizeBoundaryArray(overlap.overlapTerms),
      mitigation: normalizeTerm(overlap.mitigation),
      ...(overlap.previousStoryId ? { previousStoryId: overlap.previousStoryId } : {}),
    });
  }
  return mitigations;
}

function freezeFreshnessPayload(args: {
  storyId: string;
  mode: ScopeBoundaryMode;
  scopeBoundaryHash?: string;
  executionBoundaryHash?: string;
  story?: ScopeFreezeStoryProjection;
  checklist?: ScopeFreezeChecklistProjection[];
  effectiveExcludedKeywords: string[];
  currentDiscardDigest: string;
  discardDigest?: ScopeDiscardDigestData | null;
  repeatDiscardOverlaps?: readonly ScopeFreezeDiscardOverlap[];
}): unknown {
  return {
    schemaVersion: SCOPE_ANTI_EXPANSION_SCHEMA_VERSION,
    kind: 'scope_freeze_freshness',
    storyId: args.storyId,
    mode: args.mode,
    scopeBoundaryHash: args.scopeBoundaryHash,
    executionBoundaryHash: args.executionBoundaryHash,
    story: {
      title: nonEmpty(args.story?.title) ? normalizeTerm(args.story.title) : undefined,
      description: nonEmpty(args.story?.description) ? normalizeTerm(args.story.description) : undefined,
      background: nonEmpty(args.story?.background) ? normalizeTerm(args.story.background) : undefined,
    },
    checklist: (args.checklist ?? []).map(item => ({
      id: item.id,
      title: normalizeTerm(item.title),
      context: nonEmpty(item.context) ? normalizeTerm(item.context) : undefined,
      excludes: normalizeBoundaryArray(item.excludes),
    })),
    effectiveExcludedKeywords: normalizeBoundaryArray(args.effectiveExcludedKeywords),
    currentDiscardDigest: args.currentDiscardDigest,
    discardCorpus: discardCorpusIdentity(args.discardDigest),
    repeatDiscardOverlapIdentity: repeatDiscardOverlapIdentity(args.repeatDiscardOverlaps ?? []),
  };
}

export function computeScopeFreezeFreshnessHash(args: {
  storyId: string;
  mode: ScopeBoundaryMode;
  scopeBoundaryHash?: string;
  executionBoundaryHash?: string;
  story?: ScopeFreezeStoryProjection;
  checklist?: ScopeFreezeChecklistProjection[];
  effectiveExcludedKeywords: string[];
  currentDiscardDigest: string;
  discardDigest?: ScopeDiscardDigestData | null;
  repeatDiscardOverlaps?: readonly ScopeFreezeDiscardOverlap[];
}): string {
  return digest(freezeFreshnessPayload(args));
}

export function digestScopeFreezeCheck(check: ScopeFreezeCheckData): string {
  return digest({
    schemaVersion: check.schemaVersion,
    storyId: check.storyId,
    checkedAt: check.checkedAt,
    mode: check.mode,
    status: check.status,
    scopeBoundaryHash: check.scopeBoundaryHash,
    executionBoundaryHash: check.executionBoundaryHash,
    freshnessHash: check.freshnessHash,
    effectiveExcludedKeywords: normalizeBoundaryArray(check.effectiveExcludedKeywords),
    keywordHits: check.keywordHits,
    repeatDiscardOverlaps: check.repeatDiscardOverlaps,
    issues: check.issues,
  });
}

function issue(input: ScopeFreezeIssue): ScopeFreezeIssue {
  return input;
}

export function evaluateScopeFreeze(input: ScopeFreezeEvaluationInput): ScopeFreezeEvaluationResult {
  const now = input.now ?? new Date().toISOString();
  const normalizedScopeBoundary = input.scopeBoundary ? normalizeScopeBoundary(input.scopeBoundary) : null;
  const normalizedExecutionBoundary = input.executionBoundary ? normalizeExecutionBoundary(input.executionBoundary) : null;
  const mode = input.mode ?? normalizedScopeBoundary?.mode ?? 'custom';
  const effectiveExcluded = effectiveExcludedKeywords(normalizedScopeBoundary, mode);
  const sources = boundedTextSources(input, normalizedScopeBoundary);
  const keywordHits = scanExcludedKeywordHits(sources, effectiveExcluded);
  const currentTerms = sourceTerms(input, normalizedScopeBoundary);
  const currentDiscardDigest = computeDiscardDirectionDigest(currentTerms);
  const repeatDiscardOverlaps = findRepeatDiscardOverlaps({
    currentTerms,
    currentDigest: currentDiscardDigest,
    discardDigest: input.discardDigest,
    mitigation: input.repeatDiscardMitigation,
    mitigations: input.repeatDiscardMitigations,
  });

  const issues: ScopeFreezeIssue[] = [];
  if (!normalizedScopeBoundary) {
    issues.push(issue({
      code: 'missing_scope_boundary',
      severity: 'hard',
      message: 'INIT_CHECK scope anti-expansion requires a scope-boundary artifact before worktree creation.',
    }));
  }
  if (!normalizedExecutionBoundary) {
    issues.push(issue({
      code: 'missing_execution_boundary',
      severity: 'hard',
      message: 'INIT_CHECK scope anti-expansion requires an execution-boundary artifact before worktree creation.',
    }));
  }
  for (const hit of keywordHits) {
    if (hit.excluded) continue;
    issues.push(issue({
      code: 'future_capability_keyword',
      severity: 'hard',
      message: `Excluded scope keyword "${hit.keyword}" appears in ${hit.source}.`,
      keyword: hit.keyword,
      source: hit.source,
      ...(hit.itemId ? { itemId: hit.itemId } : {}),
    }));
  }
  for (const overlap of repeatDiscardOverlaps) {
    if (nonEmpty(overlap.mitigation)) continue;
    issues.push(issue({
      code: 'repeat_discard_without_mitigation',
      severity: 'hard',
      message: `Current direction overlaps discarded digest ${overlap.digest} without mitigation.`,
      digest: overlap.digest,
      overlapTerms: overlap.overlapTerms,
    }));
  }

  const scopeBoundaryHash = normalizedScopeBoundary?._hash;
  const executionBoundaryHash = normalizedExecutionBoundary?._hash;
  const freshnessHash = computeScopeFreezeFreshnessHash({
    storyId: input.storyId,
    mode,
    scopeBoundaryHash,
    executionBoundaryHash,
    story: input.story,
    checklist: input.checklist,
    effectiveExcludedKeywords: effectiveExcluded,
    currentDiscardDigest,
    discardDigest: input.discardDigest,
    repeatDiscardOverlaps,
  });

  const checkBase: ScopeFreezeCheckData = {
    schemaVersion: 'lattice.scope_freeze_check.v1',
    storyId: input.storyId,
    checkedAt: now,
    mode,
    status: issues.some(item => item.severity === 'hard') ? 'fail' : 'pass',
    ...(scopeBoundaryHash ? { scopeBoundaryHash } : {}),
    ...(executionBoundaryHash ? { executionBoundaryHash } : {}),
    freshnessHash,
    effectiveExcludedKeywords: effectiveExcluded,
    keywordHits,
    repeatDiscardOverlaps,
    issues,
    _hash: '',
  };

  return {
    check: { ...checkBase, _hash: digestScopeFreezeCheck(checkBase) },
    normalizedScopeBoundary,
    normalizedExecutionBoundary,
    currentDiscardDigest,
  };
}

export function buildScopeExtensionDecision(input: BuildScopeExtensionDecisionInput): ScopeExtensionDecision {
  const decidedAt = input.decidedAt ?? new Date().toISOString();
  const decision: ScopeExtensionDecision = {
    decision: input.decision,
    decidedBy: normalizeTerm(input.decidedBy),
    decidedAt,
    rationale: normalizeTerm(input.rationale),
    _hash: '',
  };
  return { ...decision, _hash: digestScopeExtensionDecision(input.proposalId, decision) };
}

export function digestScopeExtensionDecision(proposalId: string, decision: ScopeExtensionDecision): string {
  return digest({
    proposalId,
    decision: decision.decision,
    decidedBy: normalizeTerm(decision.decidedBy),
    decidedAt: decision.decidedAt,
    rationale: normalizeTerm(decision.rationale),
  });
}

function normalizePatch(patch: ScopeExtensionPatch): ScopeExtensionPatch {
  return {
    allowed: normalizeBoundaryArray(patch.allowed),
    excluded: normalizeBoundaryArray(patch.excluded),
    executionAllowedCommands: normalizeBoundaryArray(patch.executionAllowedCommands),
    executionAllowedTools: normalizeBoundaryArray(patch.executionAllowedTools),
    executionExcludedCommands: normalizeBoundaryArray(patch.executionExcludedCommands),
    executionExcludedTools: normalizeBoundaryArray(patch.executionExcludedTools),
  };
}

export function buildScopeExtensionProposal(input: BuildScopeExtensionProposalInput): ScopeExtensionProposal {
  const proposedAt = input.proposedAt ?? new Date().toISOString();
  const proposalText = normalizeTerm(input.proposal ?? input.reason);
  const proposal: ScopeExtensionProposal = {
    proposalId: normalizeTerm(input.proposalId),
    storyId: input.storyId,
    proposedBy: normalizeTerm(input.proposedBy),
    proposedAt,
    proposal: proposalText,
    proposalTextHash: proposalTextDigest(proposalText),
    reason: normalizeTerm(input.reason),
    patch: normalizePatch(input.patch),
    ...(nonEmpty(input.reviewerRunId) ? { reviewerRunId: normalizeTerm(input.reviewerRunId) } : {}),
    status: 'pending',
    _hash: '',
  };
  return { ...proposal, _hash: digestScopeExtensionProposal(proposal) };
}

export function digestScopeExtensionProposal(proposal: ScopeExtensionProposal): string {
  return digest({
    id: proposal.id,
    proposalId: proposal.proposalId,
    storyId: proposal.storyId,
    proposedBy: proposal.proposedBy,
    proposedAt: proposal.proposedAt,
    proposal: proposal.proposal,
    proposalTextHash: proposal.proposalTextHash,
    reason: proposal.reason,
    patch: normalizePatch(proposal.patch),
    reviewerRunId: proposal.reviewerRunId,
    findingId: proposal.findingId,
    evidenceRefs: normalizeBoundaryArray(proposal.evidenceRefs),
    rejectedDirectionCount: proposal.rejectedDirectionCount,
    status: proposal.status,
    decidedAt: proposal.decidedAt,
    decisionHash: proposal.decision?._hash,
  });
}

export function buildScopeDiscardDigestEntry(args: {
  terms: string[];
  reason: string;
  discardedAt?: string;
  storyId?: string;
  mitigation?: string;
}): ScopeDiscardDigestEntry {
  const terms = normalizeBoundaryArray(args.terms);
  return {
    digest: computeDiscardDirectionDigest(terms),
    terms,
    reason: normalizeTerm(args.reason),
    discardedAt: args.discardedAt ?? new Date().toISOString(),
    ...(args.storyId ? { storyId: args.storyId } : {}),
    ...(nonEmpty(args.mitigation) ? { mitigation: normalizeTerm(args.mitigation) } : {}),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && normalizeTerm(value).length > 0
    ? normalizeTerm(value)
    : undefined;
}

function artifactHashField(value: unknown): string | undefined {
  if (!isJsonObject(value)) return undefined;
  return optionalStringField(value._hash) ?? optionalStringField(value.hash);
}

function withoutCompatibilityHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCompatibilityHash);
  if (!isJsonObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'hash' || key === '_hash') continue;
    out[key] = withoutCompatibilityHash(nested);
  }
  return out;
}

export function hashScopeAntiExpansionArtifact(value: unknown): string {
  return artifactHashField(value) ?? digest(withoutCompatibilityHash(value));
}

function scopeModeFrom(value: unknown): ScopeBoundaryMode | undefined {
  return value === 'correctness_fix' || value === 'feature' || value === 'maintenance' || value === 'custom'
    ? value
    : undefined;
}

function statusFromHandler(value: HandlerScopeFreezeCheckArgs['status']): 'pass' | 'fail' {
  return value && value.toLowerCase() === 'fail' ? 'fail' : 'pass';
}

function proposalTextDigest(text: string): string {
  return digest({ kind: 'scope_extension_proposal_text', text: normalizeTerm(text).toLowerCase() });
}

function makeAdapterId(prefix: string, storyId: string, seed: unknown): string {
  return `${prefix}-${digest({ storyId, seed }).slice(0, 10)}`;
}

function normalizeScopeBoundaryArtifact(value: JsonObject | null): ScopeBoundaryData | null {
  if (!value) return null;
  const mode = scopeModeFrom(value.mode) ?? 'correctness_fix';
  const boundary = buildScopeBoundary({
    storyId: optionalStringField(value.storyId) ?? '',
    mode,
    allowed: stringArrayField(value.allowed).length > 0 ? stringArrayField(value.allowed) : stringArrayField(value.allowedScope),
    excluded: stringArrayField(value.excluded).length > 0 ? stringArrayField(value.excluded) : stringArrayField(value.excludedScope),
    confirmedBy: optionalStringField(value.confirmedBy) ?? optionalStringField(value.actor),
    confirmationNote: optionalStringField(value.confirmationNote) ?? optionalStringField(value.confirmation),
    now: optionalStringField(value.createdAt) ?? optionalStringField(value.updatedAt),
  });
  return {
    ...boundary,
    createdAt: optionalStringField(value.createdAt) ?? boundary.createdAt,
    updatedAt: optionalStringField(value.updatedAt) ?? boundary.updatedAt,
  };
}

function normalizeExecutionBoundaryArtifact(value: JsonObject | null): ExecutionBoundaryData | null {
  if (!value) return null;
  const boundary = buildExecutionBoundary({
    storyId: optionalStringField(value.storyId) ?? '',
    allowedCommands: stringArrayField(value.allowedCommands),
    allowedTools: stringArrayField(value.allowedTools),
    allowedPaths: stringArrayField(value.allowedPaths),
    excludedCommands: stringArrayField(value.excludedCommands).length > 0
      ? stringArrayField(value.excludedCommands)
      : stringArrayField(value.blockedCommands),
    excludedTools: stringArrayField(value.excludedTools).length > 0
      ? stringArrayField(value.excludedTools)
      : stringArrayField(value.blockedTools),
    excludedPaths: stringArrayField(value.excludedPaths).length > 0
      ? stringArrayField(value.excludedPaths)
      : stringArrayField(value.blockedPaths),
    confirmedBy: optionalStringField(value.confirmedBy) ?? optionalStringField(value.actor),
    confirmationNote: optionalStringField(value.confirmationNote) ?? optionalStringField(value.notes),
    now: optionalStringField(value.createdAt) ?? optionalStringField(value.updatedAt),
  });
  return {
    ...boundary,
    createdAt: optionalStringField(value.createdAt) ?? boundary.createdAt,
    updatedAt: optionalStringField(value.updatedAt) ?? boundary.updatedAt,
  };
}

export function buildScopeBoundaryArtifact(input: {
  args: HandlerScopeBoundaryArgs;
  previous: JsonObject | null;
  now: string;
  actor: string;
}): ScopeBoundaryData {
  const allowed = normalizeBoundaryArray(input.args.allowedScope);
  if (allowed.length === 0) throw new Error('allowedScope must include at least one non-empty entry');
  if (input.args.userConfirmed !== true) {
    throw new Error('userConfirmed must be true before the INIT scope boundary can be saved');
  }
  const previous = normalizeScopeBoundaryArtifact(input.previous);
  const boundary = buildScopeBoundary({
    storyId: input.args.storyId,
    mode: input.args.mode ?? previous?.mode ?? 'correctness_fix',
    allowed,
    excluded: input.args.excludedScope,
    confirmedBy: input.args.actor ?? input.actor,
    confirmationNote: input.args.confirmation ?? 'User confirmed allowed/excluded scope before INIT_CHECK.',
    now: previous?.createdAt ?? input.now,
  });
  return {
    ...boundary,
    createdAt: previous?.createdAt ?? input.now,
    updatedAt: input.now,
    _hash: digestScopeBoundary({
      ...boundary,
      createdAt: previous?.createdAt ?? input.now,
      updatedAt: input.now,
    }),
  };
}

export function buildExecutionBoundaryArtifact(input: {
  args: HandlerExecutionBoundaryArgs;
  previous: JsonObject | null;
  now: string;
  actor: string;
}): ExecutionBoundaryData {
  const previous = normalizeExecutionBoundaryArtifact(input.previous);
  const boundary = buildExecutionBoundary({
    storyId: input.args.storyId,
    allowedCommands: input.args.allowedCommands,
    allowedTools: input.args.allowedTools,
    allowedPaths: input.args.allowedPaths,
    excludedCommands: [...normalizeBoundaryArray(input.args.blockedCommands), ...normalizeBoundaryArray(input.args.excludedCommands)],
    excludedTools: [...normalizeBoundaryArray(input.args.blockedTools), ...normalizeBoundaryArray(input.args.excludedTools)],
    excludedPaths: [...normalizeBoundaryArray(input.args.blockedPaths), ...normalizeBoundaryArray(input.args.excludedPaths)],
    confirmedBy: input.args.actor ?? input.actor,
    confirmationNote: input.args.notes,
    now: previous?.createdAt ?? input.now,
  });
  return {
    ...boundary,
    createdAt: previous?.createdAt ?? input.now,
    updatedAt: input.now,
    _hash: digestExecutionBoundary({
      ...boundary,
      createdAt: previous?.createdAt ?? input.now,
      updatedAt: input.now,
    }),
  };
}

export function buildScopeFreezeCheckArtifact(input: {
  args: HandlerScopeFreezeCheckArgs;
  scopeBoundary: JsonObject | null;
  executionBoundary: JsonObject | null;
  extensionDecisions: JsonObject | null;
  now: string;
  actor: string;
}): ScopeFreezeCheckData {
  const scopeBoundary = normalizeScopeBoundaryArtifact(input.scopeBoundary);
  const executionBoundary = normalizeExecutionBoundaryArtifact(input.executionBoundary);
  const issues: ScopeFreezeIssue[] = [];
  if (!scopeBoundary) {
    issues.push({
      code: 'missing_scope_boundary',
      severity: 'hard',
      message: `${SCOPE_BOUNDARY_FILE} is required before scope freeze can pass.`,
    });
  }
  if (!executionBoundary) {
    issues.push({
      code: 'missing_execution_boundary',
      severity: 'hard',
      message: `${EXECUTION_BOUNDARY_FILE} is required before scope freeze can pass.`,
    });
  }
  for (const check of input.args.checks ?? []) {
    if (check.status.toLowerCase() !== 'fail') continue;
    issues.push({
      code: 'future_capability_keyword',
      severity: 'hard',
      message: check.note ? `${check.id}: ${check.note}` : `${check.id}: freeze check failed`,
    });
  }

  const requestedStatus = statusFromHandler(input.args.status);
  if (requestedStatus === 'pass' && issues.length > 0) {
    throw new Error(`scope_freeze_check cannot save PASS while ${issues.map(item => item.code).join(', ')} is present`);
  }

  const mode = scopeBoundary?.mode ?? 'custom';
  const effectiveExcluded = effectiveExcludedKeywords(scopeBoundary, mode);
  const extensionDecisionsHash = hashScopeAntiExpansionArtifact(input.extensionDecisions ?? { decisions: [] });
  const freshnessHash = computeScopeFreezeFreshnessHash({
    storyId: input.args.storyId,
    mode,
    scopeBoundaryHash: scopeBoundary?._hash,
    executionBoundaryHash: executionBoundary?._hash,
    effectiveExcludedKeywords: effectiveExcluded,
    currentDiscardDigest: extensionDecisionsHash,
  });

  const checkBase: ScopeFreezeCheckData = {
    schemaVersion: 'lattice.scope_freeze_check.v1',
    storyId: input.args.storyId,
    checkedAt: input.now,
    mode,
    status: issues.length > 0 || requestedStatus === 'fail' ? 'fail' : 'pass',
    ...(scopeBoundary?._hash ? { scopeBoundaryHash: scopeBoundary._hash } : {}),
    ...(executionBoundary?._hash ? { executionBoundaryHash: executionBoundary._hash } : {}),
    freshnessHash,
    effectiveExcludedKeywords: effectiveExcluded,
    keywordHits: [],
    repeatDiscardOverlaps: [],
    issues,
    _hash: '',
  };
  return { ...checkBase, _hash: digestScopeFreezeCheck(checkBase) };
}

export function buildScopeExtensionProposalArtifact(input: {
  args: HandlerScopeExtensionProposalArgs;
  proposalId: string;
  previous: JsonObject | null;
  now: string;
  actor: string;
  rejectedDirectionCount: number;
}): ScopeExtensionProposal {
  void input.previous;
  const proposalText = normalizeTerm(input.args.proposal);
  if (proposalText.length < 10) throw new Error('proposal must be at least 10 characters');
  const proposal: ScopeExtensionProposal = {
    id: input.proposalId,
    proposalId: input.proposalId,
    storyId: input.args.storyId,
    proposedBy: optionalStringField(input.args.reviewer) ?? input.actor,
    proposedAt: input.now,
    proposal: proposalText,
    proposalTextHash: proposalTextDigest(proposalText),
    reason: optionalStringField(input.args.reason) ?? 'Reviewer proposed scope extension.',
    patch: {},
    ...(optionalStringField(input.args.findingId) ? { findingId: optionalStringField(input.args.findingId) } : {}),
    evidenceRefs: normalizeBoundaryArray(input.args.evidenceRefs),
    rejectedDirectionCount: input.rejectedDirectionCount,
    status: 'pending',
    _hash: '',
  };
  return { ...proposal, _hash: digestScopeExtensionProposal(proposal) };
}

export function buildScopeExtensionDecisionArtifact(input: {
  args: HandlerScopeExtensionDecideArgs;
  proposal: JsonObject;
  previous: JsonObject | null;
  freezeCheck: JsonObject | null;
  now: string;
  actor: string;
}): ScopeExtensionDecisionRecord {
  void input.previous;
  const proposalTextHash = optionalStringField(input.proposal.proposalTextHash) ?? null;
  const recordBase: ScopeExtensionDecisionRecord = {
    id: makeAdapterId('SED', input.args.storyId, {
      proposalId: input.args.proposalId,
      decision: input.args.decision,
      at: input.now,
    }),
    storyId: input.args.storyId,
    proposalId: input.args.proposalId,
    proposalTextHash,
    decision: input.args.decision,
    reason: normalizeTerm(input.args.reason),
    decider: optionalStringField(input.args.decider) ?? input.actor,
    invalidatesFreezeCheckHash: input.args.decision === 'accepted'
      ? artifactHashField(input.freezeCheck) ?? null
      : null,
    priorFreezeCheckStatus: isJsonObject(input.freezeCheck) && typeof input.freezeCheck.status === 'string'
      ? input.freezeCheck.status
      : null,
    createdAt: input.now,
    actor: input.actor,
    _hash: '',
  };
  return { ...recordBase, _hash: hashScopeAntiExpansionArtifact(recordBase) };
}
