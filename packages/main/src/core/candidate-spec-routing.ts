import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import type { ReviewerReadManifest } from './types.js';

export const CORPUS_INDEX_SCHEMA = 'proof-or-stop.corpus-index.v1' as const;
export const KEYWORD_SEEDS_SCHEMA = 'proof-or-stop.keyword-seeds.v1' as const;
export const HOST_PROPOSAL_SCHEMA = 'proof-or-stop.keyword-proposal.v1' as const;
export const CANDIDATE_SET_SCHEMA = 'proof-or-stop.candidate-spec-set.v1' as const;

export const DEFAULT_CANDIDATE_BUDGET = 8;
export const DEFAULT_QUERY_GROUP_BUDGET = 10;
export const DEFAULT_RAW_HITS_PER_GROUP = 50;
export const DEFAULT_HOST_TERM_BUDGET = 20;
export const DEFAULT_HOST_AMBIGUITY_BUDGET = 5;
/**
 * Terms present in more than this share of the requirements corpus are not
 * useful ranking signals. They are recorded in the artifact, but excluded
 * from bounded queries so generic repository/path vocabulary cannot force a
 * full-corpus escalation. Exact relatedDocs remain direct candidates.
 */
export const DEFAULT_MAX_QUERY_DOCUMENT_FREQUENCY_RATIO = 0.4;
/** A body-only match scores 8; only heading-or-stronger ties can change a high-confidence routing decision. */
export const MIN_RANKING_AFFECTING_CUTOFF_SCORE = 15;

const SHA256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const CONTROL = /[\u0000-\u001f\u007f]/;
const SECRET_VALUE = /(?:bearer\s+|api[_-]?key\s*[:=]\s*|password\s*[:=]\s*|secret\s*[:=]\s*|token\s*[:=]\s*)[^\s,;]+/gi;
const SECRET_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_.-]*(?:token|secret|password|credential|api[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*([^\s,;]+)/gi;
const SEED_STOPWORDS = new Set(['docs', 'requirements', 'decisions', 'actives', 'story', 'checklist', 'implement', 'implementation', 'current', 'complete', 'through', 'without', 'runtime']);

export type SeedSource = 'relatedDoc' | 'story' | 'checklist' | 'understanding' | 'changedPath' | 'identifier' | 'memory';

export interface CorpusIndexEntry {
  path: string;
  headings: string[];
  byteSize: number;
  contentHash: string;
  title: string | null;
  statusHints: string[];
}

export interface CorpusIndexArtifact {
  schemaVersion: typeof CORPUS_INDEX_SCHEMA;
  requirementsDir: string;
  entries: CorpusIndexEntry[];
  corpusDigest: string;
}

export interface KeywordSeed {
  term: string;
  normalized: string;
  source: SeedSource;
  sourceRef: string;
  weight: number;
}

export interface KeywordSeedsArtifact {
  schemaVersion: typeof KEYWORD_SEEDS_SCHEMA;
  seeds: KeywordSeed[];
  seedDigest: string;
}

export interface StoryRoutingInput {
  storyId: string;
  title?: string;
  description?: string;
  keywords?: string[];
  riskSignals?: string[];
  relatedDocs?: string[];
  checklist?: Array<{ id?: string; title?: string; userSees?: string; excludes?: string[]; relatedDocs?: string[] }>;
  understanding?: { touchpoints?: string[]; facts?: string[]; constraints?: string[] } | null;
  changedPaths?: string[];
  memoryTerms?: string[];
  /** Structured exact-path authorities. Narrative prose must never populate this field. */
  protectedSources?: Array<{
    kind: 'related-doc' | 'exact-path' | 'registry-ref' | 'typed-risk' | 'reviewer-evidence';
    path: string;
    sourceRef: string;
  }>;
}

export interface SanitizedHostPayload {
  safe: boolean;
  value: unknown;
  redactionCount: number;
  localProvenance: Record<string, string>;
  digest: string;
  reason: string | null;
}

export interface HostProposalTerm {
  term: string;
  rationale: string;
  kind: 'synonym' | 'legacy-term' | 'domain-term' | 'behavior' | 'failure-mode' | 'command-config' | 'negative-control';
  derivedFrom: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface HostKeywordProposal {
  schemaVersion: typeof HOST_PROPOSAL_SCHEMA;
  storyId: string;
  // B-137a:F-122 — the retired third-host proposal lane has no remaining
  // construction site. It stays documented only as a playbook fallback host
  // (playbook-runtime-memory.ts), which is separate from this two-host
  // keyword-routing proposal union.
  host: 'codex-cli' | 'claude-cli';
  proposalId: string;
  promptDigest: string;
  deterministicSeedDigest: string;
  terms: HostProposalTerm[];
  rejectedSeeds: Array<{ term: string; reason: string }>;
  ambiguitySignals: string[];
}

export interface HostProposalAttempt {
  host: HostKeywordProposal['host'];
  status: 'accepted' | 'unavailable' | 'timeout' | 'quota-limited' | 'rejected' | 'skipped-unsafe';
  proposal: HostKeywordProposal | null;
  reason: string | null;
}

export type CandidateHostExecutor = (args: {
  host: HostKeywordProposal['host'];
  storyId: string;
  sanitizedPayload: unknown;
  promptDigest: string;
  seedDigest: string;
}) => Promise<unknown>;

export interface CandidateReason {
  kind: 'related-doc' | 'exact-path' | 'registry-ref' | 'typed-risk' | 'reviewer-evidence' | 'path' | 'heading' | 'body' | 'host' | 'negative-control';
  term: string;
  source: string;
  points: number;
}

export interface CandidateSpec {
  path: string;
  contentHash: string;
  score: number;
  reasons: CandidateReason[];
}

export interface CandidateSpecSetArtifact {
  schemaVersion: typeof CANDIDATE_SET_SCHEMA;
  storyId: string;
  corpusDigest: string;
  seedDigest: string;
  promptDigests: string[];
  mode: 'shadow' | 'warn' | 'enforce';
  candidates: CandidateSpec[];
  candidateSpecSet: string[];
  candidateBasis: Record<string, CandidateReason[]>;
  queryGroups: string[][];
  queryFiltering: {
    maxDocumentFrequencyRatio: number;
    filteredTerms: Array<{ term: string; documentCount: number; documentFrequencyRatio: number; reason: 'overbroad' | 'zero_hits' }>;
  };
  queryTruncation: Array<{
    queryGroup: string[];
    totalHits: number;
    retainedHits: number;
    omittedHits: number;
    omittedMaxScore: number | null;
    selectedCutoffScore: number | null;
    classification: 'safe_below_cutoff' | 'ranking_affecting';
  }>;
  protectedRouting: {
    selectedPaths: string[];
    missing: Array<{
      kind: NonNullable<StoryRoutingInput['protectedSources']>[number]['kind'];
      path: string;
      sourceRef: string;
      reason: 'unsafe_path' | 'missing' | 'not_regular_file';
    }>;
    ordinaryBudget: number;
    protectedCount: number;
    exceedsOrdinaryBudget: boolean;
  };
  rankingPolicy: { minRankingAffectingCutoffScore: number };
  budgets: { candidates: number; queryGroups: number; rawHitsPerGroup: number };
  ambiguitySignals: string[];
  requiresEscalation: boolean;
  escalationReasons: string[];
  fullScan: boolean;
  scanEscalationReason: string | null;
  storyInputDigest: string;
  headHash: string;
  materialHash: string;
  storyFilesHash?: string;
  /**
   * Readiness-only diagnostic for the retired agy candidate lane. It is
   * persisted for operator routing visibility but never produces a host launch.
   */
  agyReadinessDiagnostic?: {
    launcherSupport: string;
    launcherOk: boolean;
    executionReady: boolean;
    reviewReady: boolean;
    failureKind: string;
    progressMode: string;
    diagnostic: string | null;
    remediation: string | null;
  };
  artifactDigest: string;
}

export interface CandidateRoutingEvaluationWindow {
  id: string;
  criticalHighRecall: number;
  overallRecall: number;
  findingEquivalent: boolean;
  promptByteReduction: number;
  p95LatencyMs: number;
  readMismatchCount: number;
  unjustifiedFullScanCount: number;
}

export interface CandidateRoutingPromotionVerdict {
  allowed: boolean;
  from: 'shadow' | 'warn' | 'enforce';
  to: 'shadow' | 'warn' | 'enforce';
  evaluatedWindowIds: string[];
  blockers: string[];
  rollback: 'tool-driven-broad-review-with-recorded-escalation';
  corpusPromptInjectionAllowed: false;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function digestCandidateRoutingValue(value: unknown): string {
  return SHA256(canonicalJson(value));
}

function safeRelativePath(value: string, label: string): string {
  const raw = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || CONTROL.test(raw) || isAbsolute(raw) || raw.startsWith('~')) throw new Error(`${label}: unsafe path`);
  const normalized = posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`${label}: traversal is not allowed`);
  return normalized;
}

function walkMarkdown(root: string, dir: string): string[] {
  const absolute = resolve(root, dir);
  const rootReal = realpathSync(root);
  const dirReal = realpathSync(absolute);
  if (relative(rootReal, dirReal).startsWith('..')) throw new Error('requirementsDir escapes project root');
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort((a, b) => a.localeCompare(b, 'en'))) {
      const file = join(current, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(file);
        if (relative(rootReal, target).startsWith('..')) throw new Error(`requirements symlink escapes project root: ${file}`);
        continue;
      }
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile() && name.toLowerCase().endsWith('.md')) result.push(relative(rootReal, file).replace(/\\/g, '/'));
    }
  };
  visit(dirReal);
  return result.sort((a, b) => a.localeCompare(b, 'en'));
}

function headingsOf(text: string): string[] {
  return text.split(/\r?\n/)
    .map(line => /^(#{1,2})\s+(.+?)\s*$/.exec(line)?.[2]?.trim() ?? '')
    .filter(Boolean)
    .slice(0, 64);
}

function statusHints(path: string, headings: string[]): string[] {
  const haystack = `${path} ${headings.join(' ')}`.toLowerCase();
  return ['execution plan', 'canonical', 'decision', 'legacy', 'superseded']
    .filter(value => haystack.includes(value.replace(' ', '-')) || haystack.includes(value));
}

export function buildCorpusIndex(projectRoot: string, requirementsDir = 'docs/requirements'): CorpusIndexArtifact {
  const normalizedDir = safeRelativePath(requirementsDir, 'requirementsDir');
  const entries = walkMarkdown(projectRoot, normalizedDir).map(path => {
    const bytes = readFileSync(join(projectRoot, path));
    const text = bytes.toString('utf8');
    const headings = headingsOf(text);
    return {
      path,
      headings,
      byteSize: statSync(join(projectRoot, path)).size,
      contentHash: SHA256(bytes),
      title: headings[0] ?? null,
      statusHints: statusHints(path, headings),
    } satisfies CorpusIndexEntry;
  });
  return {
    schemaVersion: CORPUS_INDEX_SCHEMA,
    requirementsDir: normalizedDir,
    entries,
    corpusDigest: digestCandidateRoutingValue(entries),
  };
}

export function normalizeKeyword(term: string): string {
  return term
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_/.-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractedTerms(value: string): string[] {
  const exact = [...value.matchAll(/`([^`\n]{1,120})`|(--?[A-Za-z0-9][\w-]*)|\b([A-Z][A-Z0-9_]{2,}|[A-Za-z][\w.-]{2,})\b/g)]
    .map(match => (match[1] || match[2] || match[3] || '').trim())
    .filter(term => term.length >= 3 && term.length <= 120 && !SEED_STOPWORDS.has(normalizeKeyword(term)));
  return [...new Set(exact)];
}

export function buildKeywordSeeds(input: StoryRoutingInput): KeywordSeedsArtifact {
  const rows: KeywordSeed[] = [];
  const add = (value: unknown, source: SeedSource, sourceRef: string, weight: number): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    for (const term of extractedTerms(value)) {
      const normalized = normalizeKeyword(term);
      if (normalized.length < 3) continue;
      rows.push({ term, normalized, source, sourceRef, weight });
    }
  };
  const addRelated = (doc: string, sourceRef: string): void => {
    const term = doc.split('#')[0].trim();
    if (!term) return;
    rows.push({ term, normalized: normalizeKeyword(term), source: 'relatedDoc', sourceRef, weight: 100 });
  };
  for (const [index, doc] of (input.relatedDocs ?? []).entries()) addRelated(doc, `relatedDocs[${index}]`);
  add(input.title, 'story', 'story.title', 40);
  add(input.description, 'story', 'story.description', 25);
  for (const [index, term] of [...(input.keywords ?? []), ...(input.riskSignals ?? [])].entries()) add(term, 'story', `story.keyword[${index}]`, 35);
  for (const [index, item] of (input.checklist ?? []).entries()) {
    add(item.title, 'checklist', `checklist[${index}].title`, 30);
    add(item.userSees, 'checklist', `checklist[${index}].userSees`, 20);
    for (const doc of item.relatedDocs ?? []) addRelated(doc, `checklist[${index}].relatedDocs`);
    for (const excluded of item.excludes ?? []) add(excluded, 'checklist', `checklist[${index}].excludes`, 10);
  }
  for (const [index, touchpoint] of (input.understanding?.touchpoints ?? []).entries()) add(touchpoint, 'understanding', `understanding.touchpoints[${index}]`, 45);
  for (const [index, path] of (input.changedPaths ?? []).entries()) add(path, 'changedPath', `changedPaths[${index}]`, 50);
  for (const [index, term] of (input.memoryTerms ?? []).entries()) add(term, 'memory', `memory[${index}]`, 5);

  const best = new Map<string, KeywordSeed>();
  for (const row of rows) {
    const key = `${row.normalized}\u0000${row.sourceRef}`;
    const current = best.get(key);
    if (!current || row.weight > current.weight || row.term.localeCompare(current.term, 'en') < 0) best.set(key, row);
  }
  const seeds = [...best.values()].sort((a, b) =>
    b.weight - a.weight || a.normalized.localeCompare(b.normalized, 'en') || a.term.localeCompare(b.term, 'en') || a.sourceRef.localeCompare(b.sourceRef, 'en'));
  return { schemaVersion: KEYWORD_SEEDS_SCHEMA, seeds, seedDigest: digestCandidateRoutingValue(seeds) };
}

function sanitizeString(value: string, local: Record<string, string>): { value: string; redactions: number; uncertain: boolean } {
  let redactions = 0;
  let uncertain = false;
  let safe = value.replace(SECRET_ASSIGNMENT, (_match, name: string, secret: string) => {
    const ref = `sha256:${SHA256(secret)}`;
    local[ref] = secret;
    redactions += 1;
    return `${name}=<redacted:${ref.slice(7, 19)}>`;
  });
  safe = safe.replace(SECRET_VALUE, match => {
    const ref = `sha256:${SHA256(match)}`;
    local[ref] = match;
    redactions += 1;
    return `<redacted:${ref.slice(7, 19)}>`;
  });
  if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\b(?:sk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/.test(safe)) uncertain = true;
  return { value: safe, redactions, uncertain };
}

export function sanitizeHostPayload(input: unknown): SanitizedHostPayload {
  const localProvenance: Record<string, string> = {};
  let redactionCount = 0;
  let uncertain = false;
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const sanitized = sanitizeString(value, localProvenance);
      redactionCount += sanitized.redactions;
      uncertain ||= sanitized.uncertain;
      return sanitized.value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, visit(child)]));
    }
    return value;
  };
  const value = visit(input);
  return {
    safe: !uncertain,
    value,
    redactionCount,
    localProvenance,
    digest: digestCandidateRoutingValue(value),
    reason: uncertain ? 'uncertain_secret_classification' : null,
  };
}

export function normalizeHostProposal(input: unknown, expected: { storyId: string; host: HostKeywordProposal['host']; seedDigest: string }): HostKeywordProposal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('host proposal must be an object');
  const proposal = input as Partial<HostKeywordProposal>;
  if (proposal.schemaVersion !== HOST_PROPOSAL_SCHEMA || proposal.storyId !== expected.storyId || proposal.host !== expected.host) throw new Error('host proposal identity mismatch');
  if (proposal.deterministicSeedDigest !== expected.seedDigest) throw new Error('host proposal seed digest mismatch');
  if (!Array.isArray(proposal.terms) || proposal.terms.length > DEFAULT_HOST_TERM_BUDGET) throw new Error('host proposal term budget exceeded');
  if (!Array.isArray(proposal.ambiguitySignals) || proposal.ambiguitySignals.length > DEFAULT_HOST_AMBIGUITY_BUDGET) throw new Error('host proposal ambiguity budget exceeded');
  const terms = proposal.terms.map((term, index) => {
    if (!term || typeof term.term !== 'string' || typeof term.rationale !== 'string' || term.rationale.length > 160) throw new Error(`host proposal term ${index} malformed`);
    if (sanitizeHostPayload(term).redactionCount > 0 || !sanitizeHostPayload(term).safe) throw new Error(`host proposal term ${index} contains secret-like material`);
    return term;
  });
  return { ...(proposal as HostKeywordProposal), terms };
}

function proposalTermSet(proposal: HostKeywordProposal): Set<string> {
  return new Set(proposal.terms.map(term => normalizeKeyword(term.term)));
}

function proposalOverlap(a: HostKeywordProposal, b: HostKeywordProposal): number {
  const left = proposalTermSet(a);
  const right = proposalTermSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = [...left].filter(term => right.has(term)).length;
  return intersection / Math.max(left.size, right.size, 1);
}

export async function collectHostKeywordProposals(args: {
  storyId: string;
  payload: unknown;
  seeds: KeywordSeedsArtifact;
  execute: CandidateHostExecutor;
  minimumPrimaryOverlap?: number;
}): Promise<{ attempts: HostProposalAttempt[]; accepted: HostKeywordProposal[]; sanitizedDigest: string; hostDisagreement: boolean }> {
  const sanitized = sanitizeHostPayload(args.payload);
  if (!sanitized.safe) {
    return {
      attempts: [
        { host: 'codex-cli', status: 'skipped-unsafe', proposal: null, reason: sanitized.reason },
        { host: 'claude-cli', status: 'skipped-unsafe', proposal: null, reason: sanitized.reason },
      ],
      accepted: [],
      sanitizedDigest: sanitized.digest,
      hostDisagreement: false,
    };
  }
  const run = async (host: HostKeywordProposal['host']): Promise<HostProposalAttempt> => {
    const promptDigest = digestCandidateRoutingValue({ host, payload: sanitized.value, seedDigest: args.seeds.seedDigest });
    try {
      const raw = await args.execute({ host, storyId: args.storyId, sanitizedPayload: sanitized.value, promptDigest, seedDigest: args.seeds.seedDigest });
      const proposal = normalizeHostProposal(raw, { storyId: args.storyId, host, seedDigest: args.seeds.seedDigest });
      if (proposal.promptDigest !== promptDigest) throw new Error('host proposal prompt digest mismatch');
      return { host, status: 'accepted', proposal, reason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const status: HostProposalAttempt['status'] = lower.includes('timeout')
        ? 'timeout'
        : lower.includes('quota') || lower.includes('rate limit')
          ? 'quota-limited'
          : lower.includes('unavailable') || lower.includes('enoent')
            ? 'unavailable'
            : 'rejected';
      return { host, status, proposal: null, reason: message.slice(0, 240) };
    }
  };
  // Promise.all preserves input order. Never let host latency determine proposal,
  // query-group, candidate, or artifact ordering.
  const attempts = await Promise.all([run('codex-cli'), run('claude-cli')]);
  const primary = attempts.flatMap(attempt => attempt.proposal ? [attempt.proposal] : []);
  const minimumOverlap = args.minimumPrimaryOverlap ?? 0.2;
  const disagree = primary.length === 2 && proposalOverlap(primary[0], primary[1]) < minimumOverlap;
  const accepted = attempts.flatMap(attempt => attempt.proposal ? [attempt.proposal] : []);
  return { attempts, accepted, sanitizedDigest: sanitized.digest, hostDisagreement: disagree };
}

function searchable(entry: CorpusIndexEntry, body: string): string {
  return `${entry.path}\n${entry.headings.join('\n')}\n${body}`.toLowerCase();
}

function orderedQueryTerms(seeds: KeywordSeed[], proposals: HostKeywordProposal[] = []): string[] {
  const terms = [...seeds.filter(seed => seed.source !== 'relatedDoc').map(seed => seed.normalized), ...proposals.flatMap(proposal => proposal.terms.map(term => normalizeKeyword(term.term)))]
    .filter(term => term.length >= 3);
  return [...new Set(terms)];
}

function queryGroupsFromTerms(unique: string[], budget: number): string[][] {
  const groups = unique.slice(0, budget).map(term => [term]);
  if (unique.length >= 2 && groups.length < budget) groups.push([unique[0], unique[1]]);
  return groups.slice(0, budget);
}

export function buildQueryGroups(seeds: KeywordSeed[], proposals: HostKeywordProposal[] = [], budget = DEFAULT_QUERY_GROUP_BUDGET): string[][] {
  return queryGroupsFromTerms(orderedQueryTerms(seeds, proposals), budget);
}

export function routeCandidateSpecs(args: {
  projectRoot: string;
  storyId: string;
  corpus: CorpusIndexArtifact;
  seeds: KeywordSeedsArtifact;
  proposals?: HostKeywordProposal[];
  candidateBudget?: number;
  queryGroupBudget?: number;
  rawHitsPerGroup?: number;
  maxDocumentFrequencyRatio?: number;
  forceFullScanReason?: string | null;
  hostDisagreement?: boolean;
  riskSignals?: string[];
  protectedSources?: StoryRoutingInput['protectedSources'];
  mode?: 'shadow' | 'warn' | 'enforce';
  storyInputDigest?: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  agyReadinessDiagnostic?: CandidateSpecSetArtifact['agyReadinessDiagnostic'];
}): CandidateSpecSetArtifact {
  const candidateBudget = args.candidateBudget ?? DEFAULT_CANDIDATE_BUDGET;
  const queryGroupBudget = args.queryGroupBudget ?? DEFAULT_QUERY_GROUP_BUDGET;
  const rawHitsPerGroup = args.rawHitsPerGroup ?? DEFAULT_RAW_HITS_PER_GROUP;
  const configuredDocumentFrequencyRatio = args.maxDocumentFrequencyRatio;
  const maxDocumentFrequencyRatio = typeof configuredDocumentFrequencyRatio === 'number'
    && Number.isFinite(configuredDocumentFrequencyRatio)
    && configuredDocumentFrequencyRatio > 0
    && configuredDocumentFrequencyRatio <= 1
    ? configuredDocumentFrequencyRatio
    : DEFAULT_MAX_QUERY_DOCUMENT_FREQUENCY_RATIO;
  const proposals = args.proposals ?? [];
  // Compute document frequency for every ordered term before spending the
  // query-group budget. Otherwise generic terms at the front can consume the
  // entire budget and starve a later specific term that would survive DF.
  const unfilteredQueryTerms = orderedQueryTerms(args.seeds.seeds, proposals);
  const reasonMap = new Map<string, CandidateReason[]>();
  const entryByPath = new Map(args.corpus.entries.map(entry => [entry.path, entry]));
  const searchableByPath = new Map(args.corpus.entries.map(entry => [
    entry.path,
    searchable(entry, readFileSync(join(args.projectRoot, entry.path), 'utf8')),
  ]));
  const queryTerms = [...new Set([
    ...unfilteredQueryTerms,
  ])].sort((left, right) => left.localeCompare(right, 'en'));
  const documentCounts = new Map(queryTerms.map(term => [
    term,
    args.corpus.entries.filter(entry => searchableByPath.get(entry.path)?.includes(term)).length,
  ]));
  const isOverbroadTerm = (term: string): boolean => {
    if (args.corpus.entries.length === 0) return false;
    return (documentCounts.get(term) ?? 0) / args.corpus.entries.length > maxDocumentFrequencyRatio;
  };
  const filteredTerms = queryTerms
    .filter(term => isOverbroadTerm(term) || (documentCounts.get(term) ?? 0) === 0)
    .map(term => ({
      term,
      documentCount: documentCounts.get(term) ?? 0,
      documentFrequencyRatio: (documentCounts.get(term) ?? 0) / Math.max(args.corpus.entries.length, 1),
      reason: isOverbroadTerm(term) ? 'overbroad' as const : 'zero_hits' as const,
    }));
  const queryGroups = queryGroupsFromTerms(
    unfilteredQueryTerms.filter(term => !isOverbroadTerm(term) && (documentCounts.get(term) ?? 0) > 0),
    queryGroupBudget,
  ).filter(group => args.corpus.entries.some(entry => {
    const haystack = searchableByPath.get(entry.path) ?? '';
    return group.every(term => haystack.includes(term));
  }));
  const relatedSources: NonNullable<StoryRoutingInput['protectedSources']> = args.seeds.seeds
    .filter(seed => seed.source === 'relatedDoc')
    .map(seed => ({ kind: 'related-doc', path: seed.term.split('#')[0], sourceRef: seed.sourceRef }));
  const completeReasonMap = new Map<string, CandidateReason[]>();
  const truncatedGroups: Array<{ queryGroup: string[]; totalHits: number; retainedHits: number; omittedPaths: string[] }> = [];

  const addReason = (map: Map<string, CandidateReason[]>, path: string, reason: CandidateReason): void => {
    const reasons = map.get(path) ?? [];
    if (!reasons.some(existing => existing.kind === reason.kind && existing.term === reason.term && existing.source === reason.source)) {
      reasons.push(reason);
    }
    map.set(path, reasons);
  };

  const protectedMissing: CandidateSpecSetArtifact['protectedRouting']['missing'] = [];
  const rootReal = realpathSync(args.projectRoot);
  const protectedInputs = [...relatedSources, ...(args.protectedSources ?? [])]
    .sort((a, b) => a.path.localeCompare(b.path, 'en') || a.kind.localeCompare(b.kind, 'en') || a.sourceRef.localeCompare(b.sourceRef, 'en'));
  for (const source of protectedInputs) {
    const rawPath = source.path.split('#')[0].replace(/\\/g, '/');
    const path = posix.normalize(rawPath).replace(/^\.\//, '');
    if (!path || isAbsolute(rawPath) || path === '..' || path.startsWith('../')) {
      protectedMissing.push({ ...source, path: rawPath, reason: 'unsafe_path' });
      continue;
    }
    let contentHash = entryByPath.get(path)?.contentHash;
    if (!contentHash) {
      const absolute = resolve(args.projectRoot, path);
      let fileReal: string;
      try {
        fileReal = realpathSync(absolute);
      } catch {
        protectedMissing.push({ ...source, path, reason: 'missing' });
        continue;
      }
      if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}/`)) {
        protectedMissing.push({ ...source, path, reason: 'unsafe_path' });
        continue;
      }
      if (!lstatSync(fileReal).isFile()) {
        protectedMissing.push({ ...source, path, reason: 'not_regular_file' });
        continue;
      }
      contentHash = SHA256(readFileSync(fileReal));
      entryByPath.set(path, { path, headings: [], byteSize: statSync(fileReal).size, contentHash, title: null, statusHints: [] });
    }
    const reason: CandidateReason = { kind: source.kind, term: path, source: source.sourceRef, points: 100 };
    addReason(reasonMap, path, reason);
    addReason(completeReasonMap, path, reason);
  }
  for (const group of queryGroups) {
    const hits: Array<{ entry: CorpusIndexEntry; body: string }> = [];
    for (const entry of args.corpus.entries) {
      const body = readFileSync(join(args.projectRoot, entry.path), 'utf8');
      const haystack = searchableByPath.get(entry.path) ?? searchable(entry, body);
      if (group.every(term => haystack.includes(term))) hits.push({ entry, body });
    }
    const retained = hits.slice(0, rawHitsPerGroup);
    if (hits.length > retained.length) truncatedGroups.push({
      queryGroup: [...group],
      totalHits: hits.length,
      retainedHits: retained.length,
      omittedPaths: hits.slice(retained.length).map(hit => hit.entry.path),
    });
    for (const { entry, body } of hits) {
      for (const term of group) {
        const pathHit = normalizeKeyword(entry.path).includes(term);
        const headingHit = entry.headings.some(heading => normalizeKeyword(heading).includes(term));
        const bodyHit = normalizeKeyword(body).includes(term);
        const kind: CandidateReason['kind'] = pathHit ? 'path' : headingHit ? 'heading' : 'body';
        const points = pathHit ? 20 : headingHit ? 15 : bodyHit ? 8 : 0;
        if (points > 0) {
          const reason: CandidateReason = { kind, term, source: group.join('+'), points };
          addReason(completeReasonMap, entry.path, reason);
          if (retained.some(hit => hit.entry.path === entry.path)) addReason(reasonMap, entry.path, reason);
        }
      }
    }
  }
  for (const proposal of proposals) {
    for (const term of proposal.terms) {
      const normalized = normalizeKeyword(term.term);
      if (isOverbroadTerm(normalized)) continue;
      for (const entry of args.corpus.entries) {
        if (!searchableByPath.get(entry.path)?.includes(normalized)) continue;
        const reason: CandidateReason = { kind: term.kind === 'negative-control' ? 'negative-control' : 'host', term: normalized, source: proposal.host, points: term.kind === 'negative-control' ? -25 : 4 };
        addReason(reasonMap, entry.path, reason);
        addReason(completeReasonMap, entry.path, reason);
      }
    }
  }
  const ranked = [...reasonMap.entries()].map(([path, reasons]) => ({
    path,
    contentHash: entryByPath.get(path)?.contentHash ?? '',
    score: reasons.reduce((sum, reason) => sum + reason.points, 0),
    reasons: reasons.sort((a, b) => b.points - a.points || a.kind.localeCompare(b.kind, 'en') || a.term.localeCompare(b.term, 'en')),
  })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en'));
  const protectedKinds = new Set<CandidateReason['kind']>(['related-doc', 'exact-path', 'registry-ref', 'typed-risk', 'reviewer-evidence']);
  const protectedRanked = ranked.filter(candidate => candidate.reasons.some(reason => protectedKinds.has(reason.kind)));
  const ordinaryRanked = ranked.filter(candidate => !candidate.reasons.some(reason => protectedKinds.has(reason.kind)));
  const completeScores = new Map([...completeReasonMap.entries()].map(([path, reasons]) => [
    path,
    reasons.reduce((sum, reason) => sum + reason.points, 0),
  ]));
  const selectedCutoffScore = ordinaryRanked.length === 0
    ? null
    : ordinaryRanked[Math.min(candidateBudget, ordinaryRanked.length) - 1]?.score ?? null;
  const queryTruncation = truncatedGroups.map(group => {
    // A path found through another retained group is not omitted from the final ranking.
    const omittedScores = group.omittedPaths
      .filter(path => !reasonMap.has(path))
      .map(path => completeScores.get(path))
      .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
    const omittedMaxScore = omittedScores.length > 0 ? Math.max(...omittedScores) : null;
    const affectsRanking = omittedMaxScore !== null
      && (selectedCutoffScore === null || ordinaryRanked.length < candidateBudget || omittedMaxScore >= selectedCutoffScore);
    return {
      queryGroup: group.queryGroup,
      totalHits: group.totalHits,
      retainedHits: group.retainedHits,
      omittedHits: group.totalHits - group.retainedHits,
      omittedMaxScore,
      selectedCutoffScore,
      classification: affectsRanking ? 'ranking_affecting' as const : 'safe_below_cutoff' as const,
    };
  });
  const rankingAffectingTruncation = queryTruncation.some(row => row.classification === 'ranking_affecting');

  const ambiguitySignals: string[] = [];
  const genericOnlyFiltered = ranked.length === 0 && filteredTerms.some(term => term.reason === 'overbroad') && queryGroups.length === 0;
  if (ranked.length === 0 && !genericOnlyFiltered) ambiguitySignals.push('zero_candidates');
  if (genericOnlyFiltered) ambiguitySignals.push('generic_only_filtered_bounded');
  const ordinaryReasonKinds = new Set(ordinaryRanked.flatMap(candidate => candidate.reasons.map(reason => reason.kind)));
  if (ordinaryRanked.length > 0 && ordinaryReasonKinds.size < 2 && protectedRanked.length === 0) ambiguitySignals.push('weak_source_class_coverage');
  if (queryTruncation.length > 0) ambiguitySignals.push('query_results_truncated');
  const cutoffScore = ordinaryRanked[candidateBudget - 1]?.score;
  const cutoffTie = ordinaryRanked.length > candidateBudget
    && cutoffScore === ordinaryRanked[candidateBudget]?.score
    && typeof cutoffScore === 'number'
    && cutoffScore >= MIN_RANKING_AFFECTING_CUTOFF_SCORE;
  if (cutoffTie) ambiguitySignals.push('candidate_cutoff_tie');
  const unmatchedHighConfidenceLegacyTerms = proposals.flatMap(proposal => proposal.terms)
    .filter(term => term.kind === 'legacy-term' && term.confidence === 'high')
    .map(term => normalizeKeyword(term.term))
    .filter(term => !args.corpus.entries.some(entry => searchable(entry, readFileSync(join(args.projectRoot, entry.path), 'utf8')).includes(term)));
  const highRiskRouting = (args.riskSignals ?? []).some(signal => /lifecycle|state.?machine|guard|gate|process.?fact|global.?rename|breaking.?rename|security|credential|\bauth\b|production|emergency/i.test(signal));
  const escalationReasons = [
    ...(ambiguitySignals.includes('zero_candidates') ? ['zero_candidates'] : []),
    ...(rankingAffectingTruncation ? ['ranking_affecting_query_truncation'] : []),
    ...(cutoffTie ? ['candidate_cutoff_tie'] : []),
    ...(ambiguitySignals.includes('weak_source_class_coverage') ? ['weak_source_class_coverage'] : []),
    ...(args.hostDisagreement ? ['primary_host_disagreement'] : []),
    ...(highRiskRouting ? ['high_risk_structured_signal'] : []),
    ...protectedMissing.map(source => `missing_protected_source:${source.reason}:${source.path}`),
    ...unmatchedHighConfidenceLegacyTerms.map(term => `unmatched_high_confidence_legacy_term:${term}`),
  ];
  const requiresEscalation = escalationReasons.length > 0;
  const scanEscalationReason = args.forceFullScanReason?.trim() || null;
  const fullScan = Boolean(args.forceFullScanReason?.trim());
  // Full scan means every indexed document, including zero-score entries. It is
  // still path/hash metadata only; reviewers read bodies with tools.
  const candidates = fullScan
    ? [...protectedRanked, ...args.corpus.entries.map(entry => {
        const rankedCandidate = ranked.find(candidate => candidate.path === entry.path);
        return rankedCandidate ?? { path: entry.path, contentHash: entry.contentHash, score: 0, reasons: [] };
      }).filter((candidate, index, all) => all.findIndex(other => other.path === candidate.path) === index)]
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en'))
    : [...protectedRanked, ...ordinaryRanked.slice(0, candidateBudget)];
  const base = {
    schemaVersion: CANDIDATE_SET_SCHEMA,
    storyId: args.storyId,
    corpusDigest: args.corpus.corpusDigest,
    seedDigest: args.seeds.seedDigest,
    promptDigests: proposals.map(proposal => proposal.promptDigest).sort(),
    mode: args.mode ?? 'enforce',
    candidates,
    candidateSpecSet: candidates.map(candidate => candidate.path),
    candidateBasis: Object.fromEntries(candidates.map(candidate => [candidate.path, candidate.reasons])),
    queryGroups,
    queryFiltering: { maxDocumentFrequencyRatio, filteredTerms },
    queryTruncation,
    protectedRouting: {
      selectedPaths: protectedRanked.map(candidate => candidate.path),
      missing: protectedMissing,
      ordinaryBudget: candidateBudget,
      protectedCount: protectedRanked.length,
      exceedsOrdinaryBudget: protectedRanked.length > candidateBudget,
    },
    rankingPolicy: { minRankingAffectingCutoffScore: MIN_RANKING_AFFECTING_CUTOFF_SCORE },
    budgets: { candidates: candidateBudget, queryGroups: queryGroupBudget, rawHitsPerGroup },
    ambiguitySignals,
    requiresEscalation,
    escalationReasons,
    fullScan,
    scanEscalationReason,
    storyInputDigest: args.storyInputDigest ?? digestCandidateRoutingValue({ storyId: args.storyId, seedDigest: args.seeds.seedDigest }),
    headHash: args.headHash ?? 'unbound',
    materialHash: args.materialHash ?? 'unbound',
    ...(args.storyFilesHash ? { storyFilesHash: args.storyFilesHash } : {}),
    ...(args.agyReadinessDiagnostic ? { agyReadinessDiagnostic: args.agyReadinessDiagnostic } : {}),
  };
  return { ...base, artifactDigest: digestCandidateRoutingValue(base) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isCandidateReason(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'related-doc' || value.kind === 'exact-path' || value.kind === 'registry-ref'
      || value.kind === 'typed-risk' || value.kind === 'reviewer-evidence' || value.kind === 'path'
      || value.kind === 'heading' || value.kind === 'body' || value.kind === 'host' || value.kind === 'negative-control')
    && typeof value.term === 'string'
    && typeof value.source === 'string'
    && Number.isFinite(value.points)
  );
}

/**
 * Validate an untrusted persisted candidate-routing artifact before any consumer
 * reads its nested arrays. The artifact is JSON on disk, so the static store type
 * is not a runtime guarantee: malformed `candidates` used to reach consumers as
 * a truthy value and could either throw or be mistaken for an absent artifact.
 */
export function verifyCandidateSpecSet(value: unknown): value is CandidateSpecSetArtifact {
  if (!isRecord(value)) return false;
  const artifact = value as unknown as CandidateSpecSetArtifact;
  if (!Array.isArray(artifact.candidates) || !artifact.candidates.every(candidate => (
    isRecord(candidate)
    && typeof candidate.path === 'string'
    && typeof candidate.contentHash === 'string'
    && Number.isFinite(candidate.score)
    && Array.isArray(candidate.reasons)
    && candidate.reasons.every(isCandidateReason)
  ))) return false;
  if (!isStringArray(artifact.candidateSpecSet)
    || artifact.candidateSpecSet.length !== artifact.candidates.length
    || !artifact.candidates.every((candidate, index) => candidate.path === artifact.candidateSpecSet[index])) return false;
  if (!isRecord(artifact.candidateBasis)
    || !artifact.candidates.every(candidate => Array.isArray(artifact.candidateBasis[candidate.path])
      && artifact.candidateBasis[candidate.path].every(isCandidateReason))) return false;
  if (!Array.isArray(artifact.queryGroups) || !artifact.queryGroups.every(isStringArray)) return false;
  if (!isRecord(artifact.budgets)
    || !isNonNegativeInteger(artifact.budgets.candidates)
    || !isNonNegativeInteger(artifact.budgets.queryGroups)
    || !isNonNegativeInteger(artifact.budgets.rawHitsPerGroup)) return false;
  if (!isRecord(artifact.rankingPolicy) || !Number.isFinite(artifact.rankingPolicy.minRankingAffectingCutoffScore)) return false;
  if (!isStringArray(artifact.promptDigests) || !isStringArray(artifact.ambiguitySignals) || !isStringArray(artifact.escalationReasons)) return false;
  if (typeof artifact.storyId !== 'string' || typeof artifact.corpusDigest !== 'string'
    || typeof artifact.seedDigest !== 'string' || typeof artifact.storyInputDigest !== 'string'
    || typeof artifact.headHash !== 'string' || typeof artifact.materialHash !== 'string'
    || typeof artifact.artifactDigest !== 'string'
    || (artifact.storyFilesHash !== undefined && typeof artifact.storyFilesHash !== 'string')) return false;
  if (typeof artifact.requiresEscalation !== 'boolean' || typeof artifact.fullScan !== 'boolean'
    || (artifact.scanEscalationReason !== null && typeof artifact.scanEscalationReason !== 'string')) return false;
  const { artifactDigest, ...base } = artifact;
  if (artifact.schemaVersion !== CANDIDATE_SET_SCHEMA) return false;
  if (artifact.mode !== 'shadow' && artifact.mode !== 'warn' && artifact.mode !== 'enforce') return false;
  if (!isRecord(artifact.queryFiltering) || !Number.isFinite(artifact.queryFiltering.maxDocumentFrequencyRatio)
    || artifact.queryFiltering.maxDocumentFrequencyRatio < 0 || artifact.queryFiltering.maxDocumentFrequencyRatio > 1
    || !Array.isArray(artifact.queryFiltering.filteredTerms)) return false;
  if (artifact.agyReadinessDiagnostic !== undefined) {
    const diagnostic = artifact.agyReadinessDiagnostic;
    if (!diagnostic
      || typeof diagnostic.launcherSupport !== 'string'
      || typeof diagnostic.launcherOk !== 'boolean'
      || typeof diagnostic.executionReady !== 'boolean'
      || typeof diagnostic.reviewReady !== 'boolean'
      || typeof diagnostic.failureKind !== 'string'
      || typeof diagnostic.progressMode !== 'string'
      || (diagnostic.diagnostic !== null && typeof diagnostic.diagnostic !== 'string')
      || (diagnostic.remediation !== null && typeof diagnostic.remediation !== 'string')) return false;
  }
  for (const term of artifact.queryFiltering.filteredTerms) {
    if (!term || typeof term.term !== 'string' || !Number.isInteger(term.documentCount) || term.documentCount < 0) return false;
    if (!Number.isFinite(term.documentFrequencyRatio) || term.documentFrequencyRatio < 0 || term.documentFrequencyRatio > 1) return false;
    if (term.reason !== 'overbroad' && term.reason !== 'zero_hits') return false;
    if ((term.reason === 'zero_hits') !== (term.documentCount === 0)) return false;
  }
  if (!isRecord(artifact.protectedRouting) || !isStringArray(artifact.protectedRouting.selectedPaths)
    || !Array.isArray(artifact.protectedRouting.missing)
    || !artifact.protectedRouting.missing.every(row => isRecord(row)
      && (row.kind === 'related-doc' || row.kind === 'exact-path' || row.kind === 'registry-ref'
        || row.kind === 'typed-risk' || row.kind === 'reviewer-evidence')
      && typeof row.path === 'string' && typeof row.sourceRef === 'string'
      && (row.reason === 'unsafe_path' || row.reason === 'missing' || row.reason === 'not_regular_file'))
    || !isNonNegativeInteger(artifact.protectedRouting.ordinaryBudget)
    || !isNonNegativeInteger(artifact.protectedRouting.protectedCount)
    || typeof artifact.protectedRouting.exceedsOrdinaryBudget !== 'boolean') return false;
  if (!Array.isArray(artifact.queryTruncation)) return false;
  for (const row of artifact.queryTruncation) {
    if (!row || !Array.isArray(row.queryGroup) || !row.queryGroup.every(term => typeof term === 'string')) return false;
    if (![row.totalHits, row.retainedHits, row.omittedHits].every(value => Number.isInteger(value) && value >= 0)) return false;
    if (row.retainedHits > row.totalHits || row.omittedHits !== row.totalHits - row.retainedHits) return false;
    if (row.omittedMaxScore !== null && !Number.isFinite(row.omittedMaxScore)) return false;
    if (row.selectedCutoffScore !== null && !Number.isFinite(row.selectedCutoffScore)) return false;
    if (row.classification !== 'safe_below_cutoff' && row.classification !== 'ranking_affecting') return false;
    const mechanicallyAffects = row.omittedMaxScore !== null && (
      row.selectedCutoffScore === null
      || artifact.candidateSpecSet.length - artifact.protectedRouting.protectedCount < artifact.budgets.candidates
      || row.omittedMaxScore >= row.selectedCutoffScore
    );
    if ((row.classification === 'ranking_affecting') !== mechanicallyAffects) return false;
  }
  const hasRankingTruncationReason = artifact.escalationReasons.includes('ranking_affecting_query_truncation');
  if (hasRankingTruncationReason !== artifact.queryTruncation.some(row => row.classification === 'ranking_affecting')) return false;
  if (!artifact.fullScan && artifact.candidateSpecSet.length > artifact.protectedRouting.protectedCount + artifact.budgets.candidates) return false;
  if (artifact.protectedRouting.protectedCount !== artifact.protectedRouting.selectedPaths.length) return false;
  if (artifact.protectedRouting.exceedsOrdinaryBudget !== (artifact.protectedRouting.protectedCount > artifact.budgets.candidates)) return false;
  if (!artifact.protectedRouting.selectedPaths.every(path => artifact.candidateSpecSet.includes(path))) return false;
  if (artifact.queryGroups.length > artifact.budgets.queryGroups) return false;
  if (artifact.fullScan !== Boolean(artifact.scanEscalationReason)) return false;
  if (artifact.requiresEscalation !== (artifact.escalationReasons.length > 0)) return false;
  return artifactDigest === digestCandidateRoutingValue(base);
}

export interface CandidateReadBindingDiagnostic {
  code: string;
  message: string;
  blocking: boolean;
}

export function candidateReadBindingDiagnostics(args: {
  manifest: ReviewerReadManifest;
  artifact: CandidateSpecSetArtifact | null;
  mode: 'shadow' | 'warn' | 'enforce';
  /** Formal managed evidence is strict even while routing rollout is shadow. */
  strict?: boolean;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
  currentStoryInputDigest?: string;
}): CandidateReadBindingDiagnostic[] {
  const diagnostics: CandidateReadBindingDiagnostic[] = [];
  const add = (code: string, message: string): void => {
    // Shadow-mode managed evidence still requires an authentic candidate/corpus
    // artifact binding, but rollout policy keeps candidate-coverage expansion
    // advisory until candidate routing itself reaches enforce.
    const strictBindingFailure = args.strict === true
      && code !== 'missing_candidate_reads'
      // A prior, mechanically-proven receipt importer changes this bookkeeping
      // input before the remaining same-round lanes import. Material freshness
      // and the managed importer-lineage rule still protect the reviewed tree.
      && code !== 'stale_story_input';
    diagnostics.push({ code, message, blocking: args.mode === 'enforce' || strictBindingFailure });
  };
  const digest = args.manifest.candidateSpecSetDigest;
  if (args.artifact && args.artifact.mode !== args.mode) {
    add('mode_mismatch', `candidate artifact mode=${args.artifact.mode} does not match configured mode=${args.mode}; rerun candidate_spec_route`);
  }
  if (!digest) {
    if (args.mode === 'enforce' || args.strict) add('missing_digest', 'candidateSpecSetDigest is required for formal managed review evidence');
    return diagnostics;
  }
  if (!args.artifact) {
    add('missing_artifact', 'candidate-spec-set.json is missing');
    return diagnostics;
  }
  if (!verifyCandidateSpecSet(args.artifact)) add('invalid_artifact', 'candidate artifact signature/digest is invalid');
  if (args.artifact.requiresEscalation && !args.artifact.fullScan) {
    add('unresolved_escalation', `candidate routing escalation is unresolved: ${args.artifact.escalationReasons.join(', ')}; Story owner must rerun candidate_spec_route with a nonblank forceFullScanReason before scope/review evidence can be accepted`);
  }
  if (digest !== args.artifact.artifactDigest) add('digest_mismatch', 'candidateSpecSetDigest does not match current artifact');
  if (args.manifest.corpusDigest !== args.artifact.corpusDigest) add('corpus_mismatch', 'read manifest corpusDigest does not match current artifact');
  const fullyRead = new Set(args.manifest.filesReadFully);
  const missingCandidateReads = args.artifact.candidateSpecSet.filter(path => !fullyRead.has(path));
  if (missingCandidateReads.length > 0) add('missing_candidate_reads', `read manifest is missing candidate full reads: ${missingCandidateReads.join(', ')}`);
  if (args.artifact.fullScan && args.manifest.scanEscalationReason !== args.artifact.scanEscalationReason) add('scan_reason_mismatch', 'read manifest scanEscalationReason does not match full-scan artifact');
  if (args.currentMaterialHash && args.artifact.materialHash !== args.currentMaterialHash) add('stale_material', 'candidate artifact materialHash is stale');
  if (args.currentStoryFilesHash && args.artifact.storyFilesHash && args.artifact.storyFilesHash !== args.currentStoryFilesHash) add('stale_story_files', 'candidate artifact storyFilesHash is stale');
  if (args.currentStoryInputDigest && args.artifact.storyInputDigest !== args.currentStoryInputDigest) add('stale_story_input', 'candidate artifact storyInputDigest is stale');
  return diagnostics;
}

export function candidateReadBindingErrors(args: {
  manifest: ReviewerReadManifest;
  artifact: CandidateSpecSetArtifact | null;
  mode: 'shadow' | 'warn' | 'enforce';
  strict?: boolean;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
  currentStoryInputDigest?: string;
}): string[] {
  return candidateReadBindingDiagnostics(args).filter(diagnostic => diagnostic.blocking).map(diagnostic => diagnostic.message);
}

export function assertCandidateReadBinding(args: Parameters<typeof candidateReadBindingErrors>[0]): void {
  const errors = candidateReadBindingErrors(args);
  if (errors.length > 0) throw new Error(`candidate routing evidence rejected: ${errors.join('; ')}`);
}

export function evaluateCandidateRoutingPromotion(args: {
  from: CandidateRoutingPromotionVerdict['from'];
  to: CandidateRoutingPromotionVerdict['to'];
  windows: CandidateRoutingEvaluationWindow[];
  maxP95LatencyMs?: number;
}): CandidateRoutingPromotionVerdict {
  const order = { shadow: 0, warn: 1, enforce: 2 } as const;
  const blockers: string[] = [];
  if (order[args.to] > order[args.from] + 1) blockers.push('rollout modes cannot be skipped');
  if (order[args.to] < order[args.from]) {
    return {
      allowed: true,
      from: args.from,
      to: args.to,
      evaluatedWindowIds: [],
      blockers: [],
      rollback: 'tool-driven-broad-review-with-recorded-escalation',
      corpusPromptInjectionAllowed: false,
    };
  }
  const windows = args.windows.slice(-2);
  if (windows.length < 2) blockers.push('two consecutive evaluation windows are required');
  const maxLatency = args.maxP95LatencyMs ?? 30_000;
  for (const window of windows) {
    if (window.criticalHighRecall < 1) blockers.push(`${window.id}: critical/high recall below 100%`);
    if (window.overallRecall < 0.98) blockers.push(`${window.id}: overall recall below 98%`);
    if (!window.findingEquivalent) blockers.push(`${window.id}: finding equivalence failed`);
    if (window.promptByteReduction < 0.9) blockers.push(`${window.id}: prompt-byte reduction below 90%`);
    if (window.p95LatencyMs > maxLatency) blockers.push(`${window.id}: p95 latency above threshold`);
    if (window.readMismatchCount !== 0) blockers.push(`${window.id}: read evidence mismatch detected`);
    if (window.unjustifiedFullScanCount !== 0) blockers.push(`${window.id}: unjustified full scan detected`);
  }
  return {
    allowed: blockers.length === 0,
    from: args.from,
    to: args.to,
    evaluatedWindowIds: windows.map(window => window.id),
    blockers,
    rollback: 'tool-driven-broad-review-with-recorded-escalation',
    corpusPromptInjectionAllowed: false,
  };
}
