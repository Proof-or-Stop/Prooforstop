/**
 * dev-memory — lightweight experience capture outside Proofbound story gates
 *
 * Design constraints (B-ad2c):
 *   - Storage: file-backed JSONL, never SQLite or binary blobs
 *   - Paths: project  → <projectRoot>/.lattice/dev-memory/experience.jsonl
 *            global   → ~/.lattice/dev-memory/experience.jsonl
 *            story    → <storyDir>/<storyId>/dev-memory-candidates.jsonl
 *   - Non-authoritative: entries CANNOT satisfy Proofbound gate evidence
 *   - No structured schema that looks like gate artifacts
 *   - Deterministic: path resolution works without a Proofbound daemon running
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { hasProjectConfigFile } from './config.js';
import { LATTICE_DIR } from './lattice-paths.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type ExperienceCategory =
  | 'failure-mode'
  | 'pattern'
  | 'anti-pattern'
  | 'workflow'
  | 'tool-quirk'
  | 'guard-bypass'
  | 'debugging'
  | 'communication'
  | 'other';

export type ExperienceScope = 'project' | 'global' | 'story-candidate';

export interface DevMemoryEntry {
  /** Unique id: sha7 of content + timestamp */
  id: string;
  /** ISO-8601 created time */
  createdAt: string;
  /** Who/what agent captured this */
  sourceAgent: string;
  /** One of the canonical categories */
  category: ExperienceCategory;
  /** project | global | story-candidate */
  scope: ExperienceScope;
  /** Short summary ≥ 10 chars */
  summary: string;
  /** What triggered the need for this memory */
  trigger: string;
  /** The reusable lesson learned */
  lesson: string;
  /** Suggested reuse prompt — how to surface this lesson */
  reusePrompt: string;
  /** Optional keyword tags for search */
  tags?: string[];
  /** Optional story ID the entry originated from */
  sourceStoryId?: string;
  /** Optional evidence references (file paths, commit shas) */
  evidenceRefs?: string[];
  /**
   * NON-AUTHORITATIVE marker — this entry cannot satisfy Proofbound DONE gates.
   * Always written as false. Presence of this field is a reminder to consumers.
   */
  gateEvidence: false;
  /**
   * Authority class — always "non_authoritative".
   * Mirrors the delivery-check authority model but explicitly opts out.
   */
  authority: 'non_authoritative';
}

export interface DevMemorySupersessionStatus {
  supersedes: string[];
  supersededBy: string[];
  isSuperseding: boolean;
  isSuperseded: boolean;
}

export type DevMemorySupersessionProjection = Map<string, DevMemorySupersessionStatus>;

export interface DevMemoryEntryView extends DevMemoryEntry {
  supersession: DevMemorySupersessionStatus;
}

const EMPTY_SUPERSESSION_STATUS: DevMemorySupersessionStatus = {
  supersedes: [],
  supersededBy: [],
  isSuperseding: false,
  isSuperseded: false,
};

const SUPERSEDES_TAG_PREFIX = 'supersedes-';
const DEV_MEMORY_REF_PREFIX = 'dev-memory:';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  'failure-mode',
  'pattern',
  'anti-pattern',
  'workflow',
  'tool-quirk',
  'guard-bypass',
  'debugging',
  'communication',
  'other',
]);

const VALID_SCOPES: ReadonlySet<string> = new Set([
  'project',
  'global',
  'story-candidate',
]);

export function validateEntry(raw: unknown): { ok: true; entry: DevMemoryEntry } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Invalid dev-memory experience: expected object' };
  }
  const obj = raw as Record<string, unknown>;

  const required: Array<[keyof DevMemoryEntry, string, ((v: unknown) => boolean)]> = [
    ['id', 'string', v => typeof v === 'string' && v.length >= 7],
    ['createdAt', 'ISO-8601 string', v => typeof v === 'string' && v.length > 0],
    ['sourceAgent', 'string', v => typeof v === 'string' && v.length > 0],
    ['category', `one of ${[...VALID_CATEGORIES].join('|')}`, v => typeof v === 'string' && VALID_CATEGORIES.has(v)],
    ['scope', `one of ${[...VALID_SCOPES].join('|')}`, v => typeof v === 'string' && VALID_SCOPES.has(v)],
    ['summary', 'string ≥10 chars', v => typeof v === 'string' && v.trim().length >= 10],
    ['trigger', 'string ≥5 chars', v => typeof v === 'string' && v.trim().length >= 5],
    ['lesson', 'string ≥10 chars', v => typeof v === 'string' && v.trim().length >= 10],
    ['reusePrompt', 'string ≥5 chars', v => typeof v === 'string' && v.trim().length >= 5],
    ['gateEvidence', 'false', v => v === false],
    ['authority', '"non_authoritative"', v => v === 'non_authoritative'],
  ];

  for (const [field, desc, check] of required) {
    if (!check(obj[field])) {
      return {
        ok: false,
        error: `Invalid dev-memory experience: field "${field}" must be ${desc}, got ${JSON.stringify(obj[field])}`,
      };
    }
  }

  return { ok: true, entry: obj as unknown as DevMemoryEntry };
}

// ---------------------------------------------------------------------------
// Storage path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the project-scoped experience file path.
 * Uses LATTICE_PROJECT_ROOT env or walks upward to find lattice.config.json.
 * Deterministic — no Proofbound daemon required.
 */
export function resolveProjectMemoryPath(projectRoot?: string): string {
  const root = projectRoot || resolveProjectRoot();
  return join(root, LATTICE_DIR, 'dev-memory', 'experience.jsonl');
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function resolveProjectMemoryReadPaths(projectRoot?: string): string[] {
  return uniquePaths([
    resolveProjectMemoryPath(projectRoot),
  ]);
}

/**
 * Resolve the global experience file path.
 * Uses LATTICE_GLOBAL_MEMORY_DIR env override (useful in tests).
 */
export function resolveGlobalMemoryPath(): string {
  const override = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  if (override) return join(override, 'experience.jsonl');
  return join(homedir(), LATTICE_DIR, 'dev-memory', 'experience.jsonl');
}

export function resolveGlobalMemoryReadPaths(): string[] {
  if (process.env.LATTICE_GLOBAL_MEMORY_DIR) return [resolveGlobalMemoryPath()];
  return uniquePaths([
    resolveGlobalMemoryPath(),
  ]);
}

/**
 * Resolve the story-scoped candidate path.
 * Only valid when storyDir is known (i.e. inside a Proofbound project).
 */
export function resolveStoryCandidatePath(storyDir: string, storyId: string): string {
  return join(storyDir, storyId, 'dev-memory-candidates.jsonl');
}

function resolveProjectRoot(): string {
  if (process.env.LATTICE_PROJECT_ROOT) return process.env.LATTICE_PROJECT_ROOT;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (hasProjectConfigFile(dir)) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// JSONL I/O helpers
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  const dir = resolve(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readEntries(filePath: string): DevMemoryEntry[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
  const results: DevMemoryEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const validated = validateEntry(parsed);
      if (validated.ok) results.push(validated.entry);
      // silently skip invalid lines (schema evolution tolerance)
    } catch {
      // skip unparseable lines
    }
  }
  return results;
}

export function readEntriesFromPaths(filePaths: string[]): DevMemoryEntry[] {
  const seen = new Set<string>();
  const entries: DevMemoryEntry[] = [];
  for (const filePath of filePaths) {
    for (const entry of readEntries(filePath)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return entries;
}

export function readProjectMemoryEntries(projectRoot?: string): DevMemoryEntry[] {
  return readEntriesFromPaths(resolveProjectMemoryReadPaths(projectRoot));
}

export function readGlobalMemoryEntries(): DevMemoryEntry[] {
  return readEntriesFromPaths(resolveGlobalMemoryReadPaths());
}

export function appendEntry(filePath: string, entry: DevMemoryEntry): void {
  ensureDir(filePath);
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

export function writeEntries(filePath: string, entries: DevMemoryEntry[]): void {
  ensureDir(filePath);
  writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf-8');
}

// ---------------------------------------------------------------------------
// Supersession projection
// ---------------------------------------------------------------------------

function uniqueValues(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(v => v.trim().length > 0))].sort();
}

export function getSupersededIds(entry: DevMemoryEntry): string[] {
  const ids: string[] = [];
  for (const tag of entry.tags || []) {
    if (tag.startsWith(SUPERSEDES_TAG_PREFIX)) {
      const id = tag.slice(SUPERSEDES_TAG_PREFIX.length).trim();
      if (id.length > 0) ids.push(id);
    }
  }
  for (const ref of entry.evidenceRefs || []) {
    if (ref.startsWith(DEV_MEMORY_REF_PREFIX)) {
      const id = ref.slice(DEV_MEMORY_REF_PREFIX.length).trim();
      if (id.length > 0) ids.push(id);
    }
  }
  return uniqueValues(ids);
}

export function buildSupersessionProjection(entries: DevMemoryEntry[]): DevMemorySupersessionProjection {
  const projection: DevMemorySupersessionProjection = new Map();
  const ensure = (id: string): DevMemorySupersessionStatus => {
    const existing = projection.get(id);
    if (existing) return existing;
    const created: DevMemorySupersessionStatus = {
      supersedes: [],
      supersededBy: [],
      isSuperseding: false,
      isSuperseded: false,
    };
    projection.set(id, created);
    return created;
  };

  for (const entry of entries) {
    ensure(entry.id);
  }

  for (const entry of entries) {
    const status = ensure(entry.id);
    status.supersedes = uniqueValues([...status.supersedes, ...getSupersededIds(entry)]);
    status.isSuperseding = status.supersedes.length > 0;
    for (const supersededId of status.supersedes) {
      const supersededStatus = ensure(supersededId);
      supersededStatus.supersededBy = uniqueValues([...supersededStatus.supersededBy, entry.id]);
      supersededStatus.isSuperseded = supersededStatus.supersededBy.length > 0;
    }
  }

  return projection;
}

export function getSupersessionStatus(
  entryOrId: DevMemoryEntry | string,
  projection: DevMemorySupersessionProjection,
): DevMemorySupersessionStatus {
  const id = typeof entryOrId === 'string' ? entryOrId : entryOrId.id;
  return projection.get(id) || EMPTY_SUPERSESSION_STATUS;
}

export function attachSupersessionStatus(
  entry: DevMemoryEntry,
  projection: DevMemorySupersessionProjection,
): DevMemoryEntryView {
  return {
    ...entry,
    supersession: getSupersessionStatus(entry, projection),
  };
}

function directlySupersedes(
  projection: DevMemorySupersessionProjection,
  supersedingId: string,
  supersededId: string,
): boolean {
  return getSupersessionStatus(supersedingId, projection).supersedes.includes(supersededId);
}

// ---------------------------------------------------------------------------
// Entry creation
// ---------------------------------------------------------------------------

export interface CaptureInput {
  category: ExperienceCategory;
  scope: ExperienceScope;
  summary: string;
  trigger: string;
  lesson: string;
  reusePrompt: string;
  tags?: string[];
  sourceAgent?: string;
  sourceStoryId?: string;
  evidenceRefs?: string[];
}

function generateId(input: CaptureInput, now: string): string {
  const raw = `${input.category}:${input.summary}:${input.trigger}:${now}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 7);
}

export function createEntry(input: CaptureInput): DevMemoryEntry {
  const now = new Date().toISOString();
  const id = generateId(input, now);
  return {
    id,
    createdAt: now,
    sourceAgent: input.sourceAgent || 'unknown',
    category: input.category,
    scope: input.scope,
    summary: input.summary,
    trigger: input.trigger,
    lesson: input.lesson,
    reusePrompt: input.reusePrompt,
    tags: input.tags,
    sourceStoryId: input.sourceStoryId,
    evidenceRefs: input.evidenceRefs,
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query?: string;
  category?: string;
  agent?: string;
  tags?: string[];
  limit?: number;
}

function buildSearchText(entry: DevMemoryEntry): string {
  return [
    entry.summary,
    entry.trigger,
    entry.lesson,
    entry.reusePrompt,
    ...(entry.tags || []),
    entry.category,
    entry.sourceStoryId || '',
    ...(entry.evidenceRefs || []),
  ].join(' ').toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreEntry(entry: DevMemoryEntry, opts: SearchOptions): number {
  let score = 0;
  const q = (opts.query || '').trim().toLowerCase();

  if (q) {
    const text = buildSearchText(entry);
    // Token-aware: split on whitespace so "authority reviewer" finds entries
    // matching either "authority" or "reviewer" independently.
    const tokens = q.split(/\s+/).filter(t => t.length > 0);
    for (const token of tokens) {
      const hits = (text.match(new RegExp(escapeRegex(token), 'gi')) || []).length;
      score += hits * 10;
    }
  }

  if (opts.category && entry.category === opts.category) score += 5;
  if (opts.agent && entry.sourceAgent === opts.agent) score += 3;
  if (opts.tags && opts.tags.length > 0) {
    const entryTags = entry.tags || [];
    for (const t of opts.tags) {
      if (entryTags.includes(t)) score += 2;
    }
  }

  return score;
}

interface SupersessionAwareScore {
  entry: DevMemoryEntry;
  score: number;
  baseScore: number;
  inheritedScore: number;
}

function scoreEntryWithSupersession(
  entry: DevMemoryEntry,
  opts: SearchOptions,
  byId: Map<string, DevMemoryEntry>,
  projection: DevMemorySupersessionProjection,
): SupersessionAwareScore {
  const baseScore = scoreEntry(entry, opts);
  let inheritedScore = 0;
  const q = (opts.query || '').trim();

  if (q.length > 0) {
    for (const supersededId of getSupersessionStatus(entry, projection).supersedes) {
      const superseded = byId.get(supersededId);
      if (!superseded) continue;
      inheritedScore = Math.max(inheritedScore, scoreEntry(superseded, { query: opts.query }));
    }
  }

  const score = Math.max(baseScore, inheritedScore);
  return { entry, score, baseScore, inheritedScore };
}

export function searchEntries(entries: DevMemoryEntry[], opts: SearchOptions): DevMemoryEntry[] {
  const byId = new Map(entries.map(e => [e.id, e]));
  const projection = buildSupersessionProjection(entries);
  const scored = entries
    .map(e => scoreEntryWithSupersession(e, opts, byId, projection))
    .filter(({ score }) => !opts.query && !opts.category && !opts.agent && !opts.tags?.length ? true : score > 0)
    .sort((a, b) => {
      const aSupersedesB = directlySupersedes(projection, a.entry.id, b.entry.id);
      const bSupersedesA = directlySupersedes(projection, b.entry.id, a.entry.id);
      if (aSupersedesB !== bSupersedesA) return aSupersedesB ? -1 : 1;
      return b.score - a.score
        || b.inheritedScore - a.inheritedScore
        || b.baseScore - a.baseScore
        || b.entry.createdAt.localeCompare(a.entry.createdAt);
    });
  const limit = opts.limit ?? 20;
  return scored.slice(0, limit).map(s => s.entry);
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export function findSimilar(entries: DevMemoryEntry[], candidate: CaptureInput): DevMemoryEntry[] {
  const summaryLower = candidate.summary.toLowerCase();
  const triggerLower = candidate.trigger.toLowerCase();
  return entries.filter(e => {
    const sLower = e.summary.toLowerCase();
    const tLower = e.trigger.toLowerCase();
    // Simple similarity: same category + significant overlap in summary or trigger
    if (e.category !== candidate.category) return false;
    const summaryOverlap = summaryLower.split(' ').filter(w => w.length > 3 && sLower.includes(w)).length;
    const triggerOverlap = triggerLower.split(' ').filter(w => w.length > 3 && tLower.includes(w)).length;
    return summaryOverlap >= 2 || triggerOverlap >= 2;
  });
}

// ---------------------------------------------------------------------------
// Preflight context pack
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  query?: string;
  projectRoot?: string;
  maxEntries?: number;
  maxLines?: number;
}

export interface PreflightResult {
  entries: DevMemoryEntry[];
  lineCount: number;
  truncated: boolean;
  supersessionProjection: DevMemorySupersessionProjection;
}

export function buildPreflightPack(opts: PreflightOptions): PreflightResult {
  const projectEntries = readProjectMemoryEntries(opts.projectRoot);
  const globalEntries = readGlobalMemoryEntries();

  // Merge, project-scoped first, global next; deduplicate by id
  const seen = new Set<string>();
  const allEntries: DevMemoryEntry[] = [];
  for (const e of [...projectEntries, ...globalEntries]) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      allEntries.push(e);
    }
  }

  const searchOpts: SearchOptions = {
    query: opts.query,
    limit: opts.maxEntries ?? 5,
  };

  const relevant = opts.query
    ? searchEntries(allEntries, searchOpts)
    : allEntries.slice(-Math.min(opts.maxEntries ?? 5, allEntries.length)).reverse();

  // Estimate line count: header(2) + per-entry(~5 lines) + footer(1)
  const estimatedLines = 2 + relevant.length * 5 + 1;
  const maxLines = opts.maxLines ?? 60;
  const truncated = estimatedLines > maxLines;

  return {
    entries: relevant,
    lineCount: estimatedLines,
    truncated,
    supersessionProjection: buildSupersessionProjection(allEntries),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSupersessionStatus(status: DevMemorySupersessionStatus): string | null {
  const parts: string[] = [];
  if (status.isSuperseding) parts.push(`supersedes ${status.supersedes.join(', ')}`);
  if (status.isSuperseded) {
    parts.push(`superseded / legacy-readable (superseded by ${status.supersededBy.join(', ')})`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

export function formatEntryShort(
  e: DevMemoryEntry,
  projection?: DevMemorySupersessionProjection,
): string {
  const tags = e.tags && e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
  const status = projection ? formatSupersessionStatus(getSupersessionStatus(e, projection)) : null;
  const lines = [
    `[${e.id}] ${e.category} | ${e.scope} | agent: ${e.sourceAgent}${tags}`,
  ];
  if (status) lines.push(`  Status  : ${status}`);
  lines.push(
    `  Summary : ${e.summary}`,
    `  Lesson  : ${e.lesson}`,
    `  Reuse   : ${e.reusePrompt}`,
    `  Authority: gateEvidence=false, authority=non_authoritative`,
  );
  if (e.sourceStoryId) lines.push(`  Source  : ${e.sourceStoryId} (non_authoritative)`);
  if (e.evidenceRefs && e.evidenceRefs.length > 0) {
    lines.push(`  Refs    : ${e.evidenceRefs.join(', ')}`);
  }
  return lines.join('\n');
}

export function formatPreflightPack(result: PreflightResult, query?: string): string {
  if (result.entries.length === 0) {
    return 'Dev Memory Preflight\n  (no relevant entries found)\n';
  }
  const lines: string[] = ['Dev Memory Preflight'];
  if (query) lines.push(`  query: "${query}"`);
  lines.push('');
  for (const e of result.entries) {
    lines.push(formatEntryShort(e, result.supersessionProjection));
    lines.push('');
  }
  if (result.truncated) {
    lines.push('  [output truncated to stay within line budget]');
  }
  lines.push(`  (${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}, ~${result.lineCount} lines)`);
  return lines.join('\n');
}
