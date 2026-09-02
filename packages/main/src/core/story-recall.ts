/**
 * B-7561 (Experience Layer Phase 3, FINAL slice): Story Recall — structured-field
 * similarity over the existing `story_list` scan.
 *
 * This module is PURE and READ-ONLY by construction:
 *   • `buildStoryProfile(meta)` distils one story's metadata into a comparable
 *     `StoryProfile`. It is defensive on every field — a story missing its
 *     understanding / decision / findings still produces a valid profile with
 *     empty arrays (never throws).
 *   • `scoreSimilarity(a, b)` is a MULTI-FIELD structured similarity: a weighted
 *     blend of Jaccard over keyword / fileKind / touchpoint sets plus small
 *     same-type / same-phase boosts. It is symmetric, deterministic, and never
 *     NaN (Jaccard(∅, ∅) is defined as 0). The multi-field blend means a single
 *     shared keyword cannot outrank a profile that overlaps on several
 *     dimensions.
 *   • `recallSimilarStories(target, candidates, topN)` ranks injected candidate
 *     profiles, EXCLUDES the target's own storyId, drops zero-score hits, sorts
 *     by score desc (stable tiebreak by storyId), and returns the top-N with
 *     reasons.
 *
 * HARD ISOLATION BAR (load-bearing — enforced by the smoke import-fence + grep):
 *   This module imports ONLY `./experience-layer-types.js` and `node:` builtins.
 *   It has NO store/handler/gate coupling: the handler supplies the candidate
 *   profiles (built from the StoryStore enumeration). There is NO FTS, NO derived
 *   index, and NO embedding — recall is a scan-only projection.
 */

import type { RecallMatch, StoryProfile } from './experience-layer-types.js';

/**
 * The loose, structural metadata shape `buildStoryProfile` reads. Mirrors the
 * narrowed projection of a story's index.json + understanding + decision +
 * findings, but is declared LOCALLY (not imported from `types.js`) to keep the
 * import fence at exactly `experience-layer-types.js` + `node:`. Every field is
 * optional so legacy / sparse / unexpected metadata is tolerated without
 * throwing (forward-compatible: extra fields are simply ignored).
 */
export interface StoryProfileInput {
  storyId?: string;
  title?: string;
  name?: string;
  type?: string;
  phase?: string;
  priority?: string;
  keywords?: unknown;
  riskSignals?: unknown;
  /** The understanding snapshot (task / outcome / touchpoints). */
  understanding?: {
    task?: string;
    outcome?: string;
    touchpoints?: unknown;
    facts?: unknown;
    constraints?: unknown;
  } | null;
  /** The structured decision (chosen option + rationale). */
  decision?: {
    chosen?: string;
    rationale?: string;
    principles?: unknown;
  } | null;
  /** Reviewer findings (narrowed: desc / signatureTag / files / category). */
  findings?: unknown;
}

/** A loose finding projection used only inside this module's profile builder. */
interface FindingLike {
  desc?: string;
  signatureTag?: string;
  files?: unknown;
  category?: string;
}

/** Stop-words excluded from keyword seeding so generic tokens never dominate. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'over', 'when',
  'while', 'should', 'must', 'will', 'does', 'used', 'using', 'than', 'then',
  'there', 'their', 'have', 'been', 'were', 'where', 'which', 'what', 'before',
  'after', 'story', 'stories', 'proof-or-stop',
]);

/** Lower-cased, deduped, sorted token list (drops blanks). Stable + idempotent. */
function uniqSorted(values: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const t = (typeof v === 'string' ? v : '').trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Coerce an unknown value into an array of trimmed strings (defensive). */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Alnum keyword tokens (>=4 chars), lower-cased, minus stop-words. */
function tokenize(text: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  const words = text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return words.filter((w) => !STOP_WORDS.has(w));
}

/** Coarse file-kind bucket for a path: extension (no dot), or a top-dir tag. */
function fileKindsFromPath(path: string): string[] {
  const clean = path.trim();
  if (!clean) return [];
  const norm = clean.replace(/\\/g, '/');
  const out: string[] = [];

  // Extension bucket (e.g. `ts`, `md`, `json`); `noext` when there is none.
  const base = norm.split('/').pop() ?? norm;
  const dot = base.lastIndexOf('.');
  out.push(dot > 0 ? `ext:${base.slice(dot + 1).toLowerCase()}` : 'ext:noext');

  // Top-two directory segments as a coarse area bucket (e.g. `dir:src`,
  // `dir:src/handlers`). Two stories touching the same area should share a
  // fileKind even when the exact filenames differ.
  const segments = norm.split('/').filter((s) => s && s !== '.' && s !== '..');
  if (segments.length >= 2) {
    out.push(`dir:${segments[0]}`);
    out.push(`dir:${segments[0]}/${segments[1]}`);
  } else if (segments.length === 1 && norm.includes('/')) {
    out.push(`dir:${segments[0]}`);
  }
  return out;
}

/** Read the (optional) findings list off the loose input as FindingLike[]. */
function findingsOf(input: StoryProfileInput): FindingLike[] {
  if (!Array.isArray(input.findings)) return [];
  return input.findings.filter((f): f is FindingLike => typeof f === 'object' && f !== null);
}

/**
 * Build a comparable `StoryProfile` from one story's loose metadata. Pure and
 * defensive: any missing / malformed field degrades to an empty array (or '').
 */
export function buildStoryProfile(input: StoryProfileInput): StoryProfile {
  const safe = (input && typeof input === 'object') ? input : {};
  const title = (safe.title ?? safe.name ?? '').trim();
  const understanding = (safe.understanding && typeof safe.understanding === 'object')
    ? safe.understanding
    : null;
  const decision = (safe.decision && typeof safe.decision === 'object') ? safe.decision : null;
  const findings = findingsOf(safe);

  // ── keywords: title + explicit story keywords + understanding task/outcome +
  //    finding signatures/desc. Multi-source so a single field never dominates.
  const keywordTokens: string[] = [];
  keywordTokens.push(...tokenize(title));
  keywordTokens.push(...asStringArray(safe.keywords).flatMap((k) => tokenize(k)));
  if (understanding) {
    keywordTokens.push(...tokenize(understanding.task ?? ''));
    keywordTokens.push(...tokenize(understanding.outcome ?? ''));
  }
  for (const f of findings) {
    if (typeof f.signatureTag === 'string') keywordTokens.push(...tokenize(f.signatureTag));
    if (typeof f.desc === 'string') keywordTokens.push(...tokenize(f.desc));
  }

  // ── touchpoints: understanding touchpoints + finding file paths.
  const touchpointPaths: string[] = [];
  if (understanding) touchpointPaths.push(...asStringArray(understanding.touchpoints));
  for (const f of findings) touchpointPaths.push(...asStringArray(f.files));

  // ── fileKinds: derived from every touchpoint path.
  const fileKindTokens: string[] = [];
  for (const p of touchpointPaths) fileKindTokens.push(...fileKindsFromPath(p));

  // ── riskSignals: support both the structured {category,matched}[] shape and a
  //    plain string[] shape; project to the category token.
  const riskTokens: string[] = [];
  if (Array.isArray(safe.riskSignals)) {
    for (const r of safe.riskSignals) {
      if (typeof r === 'string') riskTokens.push(r);
      else if (r && typeof r === 'object' && typeof (r as { category?: unknown }).category === 'string') {
        riskTokens.push((r as { category: string }).category);
      }
    }
  }

  // ── notableFindings: a short signature/desc projection per finding.
  const notableFindings: string[] = [];
  for (const f of findings) {
    const tag = typeof f.signatureTag === 'string' ? f.signatureTag.trim() : '';
    const desc = typeof f.desc === 'string' ? f.desc.trim() : '';
    const text = tag && desc ? `${tag}: ${desc}` : (tag || desc);
    if (text) notableFindings.push(text.length > 120 ? `${text.slice(0, 117)}...` : text);
  }

  // ── notableDecisions: the chosen option + a rationale gist.
  const notableDecisions: string[] = [];
  if (decision) {
    const chosen = typeof decision.chosen === 'string' ? decision.chosen.trim() : '';
    const rationale = typeof decision.rationale === 'string' ? decision.rationale.trim() : '';
    const text = chosen && rationale ? `${chosen} — ${rationale}` : (chosen || rationale);
    if (text) notableDecisions.push(text.length > 160 ? `${text.slice(0, 157)}...` : text);
  }

  const outcome = understanding && typeof understanding.outcome === 'string'
    ? understanding.outcome.trim()
    : '';

  return {
    storyId: (safe.storyId ?? '').trim(),
    title,
    type: (safe.type ?? '').trim(),
    phase: (safe.phase ?? '').trim(),
    priority: (safe.priority ?? '').trim(),
    keywords: uniqSorted(keywordTokens),
    fileKinds: uniqSorted(fileKindTokens),
    touchpoints: uniqSorted(touchpointPaths),
    riskSignals: uniqSorted(riskTokens),
    notableFindings: uniqSorted(notableFindings),
    notableDecisions: uniqSorted(notableDecisions),
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * Build an ad-hoc `StoryProfile` from a free-text query (the `recall --query`
 * mode). Keywords are tokenized from the query; structural fields are empty so
 * the query matches purely on keyword overlap. Pure + deterministic.
 */
export function buildQueryProfile(query: string): StoryProfile {
  return {
    storyId: '',
    title: typeof query === 'string' ? query.trim() : '',
    type: '',
    phase: '',
    priority: '',
    keywords: uniqSorted(tokenize(typeof query === 'string' ? query : '')),
    fileKinds: [],
    touchpoints: [],
    riskSignals: [],
    notableFindings: [],
    notableDecisions: [],
  };
}

/**
 * Jaccard index over two string sets: |A ∩ B| / |A ∪ B|. DEFINED as 0 when both
 * sets are empty (never NaN). Order-independent (symmetric) and deterministic.
 */
function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0; // Jaccard(∅, ∅) := 0 (no NaN)
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Field weights. Keywords carry the most signal; fileKinds + touchpoints add the
// structural dimension; same-type / same-phase are small boosts. The blend is
// MULTI-FIELD so a single shared keyword (one of three weighted Jaccard terms)
// cannot outrank a profile overlapping on keywords + fileKinds + touchpoints.
const W_KEYWORD = 0.45;
const W_FILEKIND = 0.30;
const W_TOUCHPOINT = 0.15;
const W_TYPE = 0.05;
const W_PHASE = 0.05;

/**
 * Multi-field structured similarity between two profiles. SYMMETRIC
 * (score(a,b)===score(b,a)) and DETERMINISTIC (pure over the two inputs). Never
 * NaN: all Jaccard terms guard the empty-set case. Returns the score plus the
 * human-readable reasons describing which dimensions overlapped.
 */
export function scoreSimilarity(
  a: StoryProfile,
  b: StoryProfile,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];

  const kw = jaccard(a.keywords, b.keywords);
  const fk = jaccard(a.fileKinds, b.fileKinds);
  const tp = jaccard(a.touchpoints, b.touchpoints);
  const sameType = a.type && b.type && a.type === b.type ? 1 : 0;
  const samePhase = a.phase && b.phase && a.phase === b.phase ? 1 : 0;

  let score = 0;
  score += W_KEYWORD * kw;
  score += W_FILEKIND * fk;
  score += W_TOUCHPOINT * tp;
  score += W_TYPE * sameType;
  score += W_PHASE * samePhase;

  // Reasons (symmetric: computed from set intersections, not order).
  const sharedKeywords = a.keywords.filter((k) => b.keywords.includes(k));
  if (sharedKeywords.length > 0) {
    reasons.push(`shared keywords: ${sharedKeywords.slice(0, 6).join(', ')}`);
  }
  const sharedFileKinds = a.fileKinds.filter((k) => b.fileKinds.includes(k));
  if (sharedFileKinds.length > 0) {
    reasons.push(`shared file areas: ${sharedFileKinds.slice(0, 6).join(', ')}`);
  }
  const sharedTouchpoints = a.touchpoints.filter((k) => b.touchpoints.includes(k));
  if (sharedTouchpoints.length > 0) {
    reasons.push(`shared touchpoints: ${sharedTouchpoints.slice(0, 4).join(', ')}`);
  }
  if (sameType) reasons.push(`same type: ${a.type}`);
  if (samePhase) reasons.push(`same phase: ${a.phase}`);

  return { score, reasons };
}

/**
 * Rank `candidates` by similarity to `target`. EXCLUDES the target's own storyId
 * (a story never recalls itself), drops zero-score hits, sorts by score desc
 * with a stable storyId tiebreak, and returns the top-N matches with reasons.
 *
 * Pure over the injected candidates (the handler supplies them from the store
 * enumeration). `topN <= 0` returns []. Empty candidates returns [].
 */
export function recallSimilarStories(
  target: StoryProfile,
  candidates: StoryProfile[],
  topN: number,
): RecallMatch[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const limit = Number.isFinite(topN) ? Math.floor(topN) : 0;
  if (limit <= 0) return [];

  const targetId = (target.storyId ?? '').trim();
  const matches: RecallMatch[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const candidateId = (candidate.storyId ?? '').trim();
    if (candidateId && targetId && candidateId === targetId) continue; // self-exclusion
    const { score, reasons } = scoreSimilarity(target, candidate);
    if (score <= 0) continue; // drop zero-score
    matches.push({
      storyId: candidateId,
      title: candidate.title,
      score,
      reasons,
      profile: candidate,
    });
  }

  matches.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score; // score desc
    return x.storyId < y.storyId ? -1 : x.storyId > y.storyId ? 1 : 0; // stable storyId tiebreak
  });

  return matches.slice(0, limit);
}
