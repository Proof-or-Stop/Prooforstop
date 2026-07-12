import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';

export const CORPUS_INDEX_SCHEMA = 'proofbound.corpus-index.v1' as const;
export const KEYWORD_SEEDS_SCHEMA = 'proofbound.keyword-seeds.v1' as const;
export const HOST_PROPOSAL_SCHEMA = 'proofbound.keyword-proposal.v1' as const;
export const CANDIDATE_SET_SCHEMA = 'proofbound.candidate-spec-set.v1' as const;

export const DEFAULT_CANDIDATE_BUDGET = 8;
export const DEFAULT_QUERY_GROUP_BUDGET = 10;
export const DEFAULT_RAW_HITS_PER_GROUP = 50;
export const DEFAULT_HOST_TERM_BUDGET = 20;
export const DEFAULT_HOST_AMBIGUITY_BUDGET = 5;

const SHA256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const CONTROL = /[\u0000-\u001f\u007f]/;
const SECRET_VALUE = /(?:bearer\s+|api[_-]?key\s*[:=]\s*|password\s*[:=]\s*|secret\s*[:=]\s*|token\s*[:=]\s*)[^\s,;]+/gi;
const SECRET_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_.-]*(?:token|secret|password|credential|api[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*([^\s,;]+)/gi;

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
  host: 'codex-cli' | 'claude-cli' | 'agy-cli';
  proposalId: string;
  promptDigest: string;
  deterministicSeedDigest: string;
  terms: HostProposalTerm[];
  rejectedSeeds: Array<{ term: string; reason: string }>;
  ambiguitySignals: string[];
}

export interface CandidateReason {
  kind: 'related-doc' | 'path' | 'heading' | 'body' | 'host' | 'negative-control';
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
  candidates: CandidateSpec[];
  candidateSpecSet: string[];
  candidateBasis: Record<string, CandidateReason[]>;
  queryGroups: string[][];
  budgets: { candidates: number; queryGroups: number; rawHitsPerGroup: number };
  ambiguitySignals: string[];
  fullScan: boolean;
  scanEscalationReason: string | null;
  artifactDigest: string;
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
    .filter(term => term.length >= 3 && term.length <= 120);
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
  for (const [index, doc] of (input.relatedDocs ?? []).entries()) add(doc, 'relatedDoc', `relatedDocs[${index}]`, 100);
  add(input.title, 'story', 'story.title', 40);
  add(input.description, 'story', 'story.description', 25);
  for (const [index, term] of [...(input.keywords ?? []), ...(input.riskSignals ?? [])].entries()) add(term, 'story', `story.keyword[${index}]`, 35);
  for (const [index, item] of (input.checklist ?? []).entries()) {
    add(item.title, 'checklist', `checklist[${index}].title`, 30);
    add(item.userSees, 'checklist', `checklist[${index}].userSees`, 20);
    for (const doc of item.relatedDocs ?? []) add(doc, 'relatedDoc', `checklist[${index}].relatedDocs`, 100);
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

function searchable(entry: CorpusIndexEntry, body: string): string {
  return `${entry.path}\n${entry.headings.join('\n')}\n${body}`.toLowerCase();
}

export function buildQueryGroups(seeds: KeywordSeed[], proposals: HostKeywordProposal[] = [], budget = DEFAULT_QUERY_GROUP_BUDGET): string[][] {
  const terms = [...seeds.map(seed => seed.normalized), ...proposals.flatMap(proposal => proposal.terms.map(term => normalizeKeyword(term.term)))]
    .filter(term => term.length >= 3);
  const unique = [...new Set(terms)];
  const groups = unique.slice(0, budget).map(term => [term]);
  if (unique.length >= 2 && groups.length < budget) groups.push([unique[0], unique[1]]);
  return groups.slice(0, budget);
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
  forceFullScanReason?: string | null;
}): CandidateSpecSetArtifact {
  const candidateBudget = args.candidateBudget ?? DEFAULT_CANDIDATE_BUDGET;
  const queryGroupBudget = args.queryGroupBudget ?? DEFAULT_QUERY_GROUP_BUDGET;
  const rawHitsPerGroup = args.rawHitsPerGroup ?? DEFAULT_RAW_HITS_PER_GROUP;
  const proposals = args.proposals ?? [];
  const queryGroups = buildQueryGroups(args.seeds.seeds, proposals, queryGroupBudget);
  const reasonMap = new Map<string, CandidateReason[]>();
  const entryByPath = new Map(args.corpus.entries.map(entry => [entry.path, entry]));
  const related = new Set(args.seeds.seeds.filter(seed => seed.source === 'relatedDoc').map(seed => seed.term.split('#')[0]));
  let truncated = false;

  for (const entry of args.corpus.entries) {
    if (related.has(entry.path)) reasonMap.set(entry.path, [{ kind: 'related-doc', term: entry.path, source: 'relatedDoc', points: 100 }]);
  }
  for (const group of queryGroups) {
    const hits: Array<{ entry: CorpusIndexEntry; body: string }> = [];
    for (const entry of args.corpus.entries) {
      const body = readFileSync(join(args.projectRoot, entry.path), 'utf8');
      const haystack = searchable(entry, body);
      if (group.every(term => haystack.includes(term))) hits.push({ entry, body });
    }
    if (hits.length > rawHitsPerGroup) truncated = true;
    for (const { entry, body } of hits.slice(0, rawHitsPerGroup)) {
      const reasons = reasonMap.get(entry.path) ?? [];
      for (const term of group) {
        const pathHit = normalizeKeyword(entry.path).includes(term);
        const headingHit = entry.headings.some(heading => normalizeKeyword(heading).includes(term));
        const bodyHit = normalizeKeyword(body).includes(term);
        const kind: CandidateReason['kind'] = pathHit ? 'path' : headingHit ? 'heading' : 'body';
        const points = pathHit ? 20 : headingHit ? 15 : bodyHit ? 8 : 0;
        if (points > 0 && !reasons.some(reason => reason.kind === kind && reason.term === term)) reasons.push({ kind, term, source: group.join('+'), points });
      }
      reasonMap.set(entry.path, reasons);
    }
  }
  for (const proposal of proposals) {
    for (const term of proposal.terms) {
      const normalized = normalizeKeyword(term.term);
      for (const entry of args.corpus.entries) {
        if (!searchable(entry, readFileSync(join(args.projectRoot, entry.path), 'utf8')).includes(normalized)) continue;
        const reasons = reasonMap.get(entry.path) ?? [];
        reasons.push({ kind: term.kind === 'negative-control' ? 'negative-control' : 'host', term: normalized, source: proposal.host, points: term.kind === 'negative-control' ? -25 : 4 });
        reasonMap.set(entry.path, reasons);
      }
    }
  }
  const ranked = [...reasonMap.entries()].map(([path, reasons]) => ({
    path,
    contentHash: entryByPath.get(path)?.contentHash ?? '',
    score: reasons.reduce((sum, reason) => sum + reason.points, 0),
    reasons: reasons.sort((a, b) => b.points - a.points || a.kind.localeCompare(b.kind, 'en') || a.term.localeCompare(b.term, 'en')),
  })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en'));

  const ambiguitySignals: string[] = [];
  if (ranked.length === 0) ambiguitySignals.push('zero_candidates');
  if (ranked.length > 0 && new Set(ranked.flatMap(candidate => candidate.reasons.map(reason => reason.kind))).size < 2) ambiguitySignals.push('weak_source_class_coverage');
  if (truncated) ambiguitySignals.push('query_results_truncated');
  if (ranked.length > candidateBudget && ranked[candidateBudget - 1]?.score === ranked[candidateBudget]?.score) ambiguitySignals.push('candidate_cutoff_tie');
  const fullScan = Boolean(args.forceFullScanReason);
  const candidates = fullScan ? ranked : ranked.slice(0, candidateBudget);
  const base = {
    schemaVersion: CANDIDATE_SET_SCHEMA,
    storyId: args.storyId,
    corpusDigest: args.corpus.corpusDigest,
    seedDigest: args.seeds.seedDigest,
    promptDigests: proposals.map(proposal => proposal.promptDigest).sort(),
    candidates,
    candidateSpecSet: candidates.map(candidate => candidate.path),
    candidateBasis: Object.fromEntries(candidates.map(candidate => [candidate.path, candidate.reasons])),
    queryGroups,
    budgets: { candidates: candidateBudget, queryGroups: queryGroupBudget, rawHitsPerGroup },
    ambiguitySignals,
    fullScan,
    scanEscalationReason: args.forceFullScanReason?.trim() || null,
  };
  return { ...base, artifactDigest: digestCandidateRoutingValue(base) };
}

export function verifyCandidateSpecSet(artifact: CandidateSpecSetArtifact): boolean {
  const { artifactDigest, ...base } = artifact;
  if (artifact.schemaVersion !== CANDIDATE_SET_SCHEMA) return false;
  if (!artifact.fullScan && artifact.candidateSpecSet.length > artifact.budgets.candidates) return false;
  if (artifact.queryGroups.length > artifact.budgets.queryGroups) return false;
  if (artifact.fullScan !== Boolean(artifact.scanEscalationReason)) return false;
  return artifactDigest === digestCandidateRoutingValue(base);
}
