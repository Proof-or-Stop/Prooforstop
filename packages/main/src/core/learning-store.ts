/**
 * B-000c CHK-001: Experience Layer Phase 1a — the minimal learning-store.
 *
 * The ONLY code that touches `.lattice/learning/`. It ensures the directory,
 * resolves paths, and reads/writes the finding-signals cache with an atomic
 * write (temp file + rename) and a stable/canonical key order so re-writing
 * identical data is byte-identical (idempotent on disk; never a spurious diff).
 *
 * Isolation bar: imports ONLY `node:` builtins, the leaf
 * `./experience-layer-types.js`, and `./digest.js` (itself a leaf importing only
 * `node:crypto`). NO other outward imports (no `../`, no `../../`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { digestCanonicalJson } from './digest.js';
import type {
  FindingSignalsCache,
  Playbook,
  PlaybookOutcomeEvent,
  PlaybookProposal,
} from './experience-layer-types.js';

/** Relative learning directory from the project root. */
export const LEARNING_DIR = join('.lattice', 'learning');
/** Derived finding-signals cache filename. */
export const FINDING_SIGNALS_FILENAME = 'finding-signals.json';
/** Append-only learning log filename (reserved; written by future phases). */
export const LEARNING_LOG_FILENAME = 'learning-log.jsonl';
/**
 * B-4f46 CHK-003: signature-registry filename.
 *
 * This file lives under `.lattice/learning/`, which is already materialHash-EXCLUDED
 * by the `experience-layer-learning-cache` runtime-artifact-registry entry
 * (it carries a `{ kind: 'prefix', value: '.lattice/learning/' }` matcher), so
 * writing it never makes evidence stale and never enters any gate's material hash.
 */
export const SIGNATURE_REGISTRY_FILENAME = 'signature-registry.json';

/**
 * B-8387 (Experience Layer Phase 2): approved-playbooks store filename. Lives
 * under `.lattice/learning/` (materialHash-EXCLUDED prefix — see the
 * SIGNATURE_REGISTRY_FILENAME note), so writing it never makes evidence stale.
 */
export const PLAYBOOKS_FILENAME = 'playbooks.json';
/** B-dddd: append-only explicit playbook outcome observations. */
export const PLAYBOOK_OUTCOMES_FILENAME = 'playbook-outcomes.jsonl';
/** B-8387: directory holding one staged proposal file per `<id>.json`. */
export const PROPOSALS_DIRNAME = 'proposals';

/**
 * Resolve the canonical MAIN-repo root that OWNS `.lattice/learning/`, even when
 * called from a linked git worktree.
 *
 * The Experience Layer's derived caches (finding-signals, signature-registry,
 * playbooks, proposals) are gitignored and live ONLY in the main checkout, but
 * story DEV/REVIEW runs in linked worktrees where those files are absent. If the
 * learning dir were resolved relative to the worktree root, every read would miss
 * the single shared cache and the Experience Layer would stay dormant (hints never
 * surface). Routing every worktree at the one main-checkout root makes reads and
 * writes always agree.
 *
 * Resolution prefers `git worktree list --porcelain`, whose FIRST `worktree <path>`
 * entry is the main (primary) worktree — the single root every linked worktree must
 * share — and falls back to `git rev-parse --show-toplevel` (this checkout's actual
 * working tree) for the layouts where `worktree list` does not report a real
 * working tree. Across the layouts that matter:
 *   - normal main checkout   => `worktree list` first entry === the checkout root
 *                               (byte-identical to the pre-fix non-worktree behavior)
 *   - linked worktree        => `worktree list` first entry === the MAIN checkout
 *                               root (so all linked worktrees share one cache)
 *   - `git init --separate-git-dir` / bare-backed worktree => `worktree list`
 *                               reports the EXTERNAL git storage dir (no distinct
 *                               main working tree), which equals --git-common-dir;
 *                               we detect that and use --show-toplevel (the actual
 *                               checkout root, NOT the external git storage)
 *
 * B-37b3 F-001 (Codex host-2, medium): the prior approach took
 * `dirname(resolve(origin, --git-common-dir))`. That equals the checkout root only
 * when the common dir is `<main>/.git`. For `separate-git-dir` and bare-backed
 * layouts the common dir points at EXTERNAL storage, so `dirname(commonDir)` was
 * the storage parent — NOT the checkout — a correctness regression. Note that for
 * those same layouts `git worktree list` ALSO reports the external storage dir (it
 * equals --git-common-dir), so we additionally fall back to --show-toplevel there.
 *
 * NEVER throws: any failure (non-git temp dir, missing git, empty output) falls
 * back to the passed origin unchanged, so the existing experience-layer smokes
 * (which use non-git temp roots) keep working.
 *
 * GIT-CWD CONTRACT NOTE: this is a self-bootstrap, NO-STORY-CONTEXT git probe —
 * the cwd `searchOrigin` IS the discovery origin (the same shape as
 * `worktree.ts` getRepoRoot / `rollout-check.ts` isGitRepo), so it intentionally
 * does NOT route through the story-keyed `resolveGitCwd` (there is no store /
 * storyId here, and threading one would be circular). The parameter is named
 * `searchOrigin` (not a bare `root`/`projectRoot`/`metadataRoot`) so the
 * gitroot-cwd-contract reads it as a resolved search origin, not a laundered
 * metadataRoot. Leaf-isolation is preserved: node builtins only.
 */
function gitProbe(searchOrigin: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: searchOrigin,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function resolveLearningRoot(searchOrigin: string): string {
  try {
    // The main (primary) worktree root is the FIRST `worktree <path>` entry.
    let mainWorktree = '';
    try {
      const out = gitProbe(searchOrigin, ['worktree', 'list', '--porcelain']);
      for (const line of out.split('\n')) {
        const m = line.match(/^worktree (.+)$/);
        if (m) { mainWorktree = m[1].trim(); break; }
      }
    } catch { /* fall through to --show-toplevel */ }

    if (mainWorktree) {
      // For separate-git-dir / bare-backed layouts git reports the EXTERNAL git
      // storage dir here (it equals --git-common-dir), not a real working tree. A
      // genuine main-worktree entry differs from the storage dir; only then is it
      // the root to use (normal + linked-worktree). Otherwise prefer the checkout's
      // own working tree below.
      let commonDir = '';
      try {
        commonDir = resolve(searchOrigin, gitProbe(searchOrigin, ['rev-parse', '--git-common-dir']).trim());
      } catch { /* leave commonDir empty => treat the worktree entry as genuine */ }
      if (!commonDir || resolve(mainWorktree) !== commonDir) return mainWorktree;
    }

    // separate-git-dir / bare-backed: the actual working tree of THIS checkout.
    const top = gitProbe(searchOrigin, ['rev-parse', '--show-toplevel']).trim();
    if (top) return top;
    return mainWorktree || searchOrigin;
  } catch {
    return searchOrigin;
  }
}

/** The repository root that owns the shared `.lattice/learning/` store. */
export function resolveLearningOwnerRoot(searchOrigin: string): string {
  return resolveLearningRoot(searchOrigin);
}

/**
 * Absolute learning directory under a project root. The root is first resolved to
 * the canonical main-repo root (see {@link resolveLearningRoot}) so a linked
 * worktree reaches the single shared `.lattice/learning/` cache. Every read and
 * write path funnels through this one function, so they can never disagree.
 */
export function resolveLearningDir(projectRoot: string): string {
  return join(resolveLearningRoot(projectRoot), LEARNING_DIR);
}

/** Absolute path of the approved-playbooks store under a project root. */
export function resolvePlaybooksPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), PLAYBOOKS_FILENAME);
}

/** Absolute playbook outcome ledger path under the shared learning root. */
export function resolvePlaybookOutcomesPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), PLAYBOOK_OUTCOMES_FILENAME);
}

/** Absolute proposals directory (`.lattice/learning/proposals/`) under a root. */
export function resolveProposalsDir(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), PROPOSALS_DIRNAME);
}

/** Absolute path of the finding-signals cache under a project root. */
export function resolveFindingSignalsPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), FINDING_SIGNALS_FILENAME);
}

/** Absolute path of the learning log under a project root. */
export function resolveLearningLogPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), LEARNING_LOG_FILENAME);
}

/** Absolute path of the signature-registry under a project root. */
export function resolveSignatureRegistryPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), SIGNATURE_REGISTRY_FILENAME);
}

/** Idempotently create `.lattice/learning/`. Returns the absolute directory. */
export function ensureLearningDir(projectRoot: string): string {
  const dir = resolveLearningDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Canonical JSON serialization for the cache: keys sorted recursively,
 * `undefined` omitted, JSON `null` preserved. Self-contained (no outward import)
 * so re-writing identical data yields byte-identical output regardless of key
 * insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  return value;
}

/**
 * Read the finding-signals cache. Returns `null` when the file is absent (fresh
 * project) or when its contents are malformed JSON — graceful degradation: a
 * hand-edited or truncated cache never crashes the process or corrupts state.
 */
export function readFindingSignals(projectRoot: string): FindingSignalsCache | null {
  const filePath = resolveFindingSignalsPath(projectRoot);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as FindingSignalsCache;
  } catch {
    return null;
  }
}

/**
 * Atomically write the finding-signals cache. Auto-creates the learning
 * directory, writes a temp file, validates it parses, then renames into place
 * (atomic replace). Canonical key order makes identical data byte-identical on
 * re-write. A failed write leaves the prior cache untouched and removes the temp.
 */
export function writeFindingSignals(projectRoot: string, cache: FindingSignalsCache): string {
  const filePath = resolveFindingSignalsPath(projectRoot);
  return atomicWriteJson(filePath, cache);
}

/**
 * Shared atomic JSON writer: canonical key order, temp file + post-write parse
 * validation + rename (atomic replace). A failed write leaves the prior file
 * untouched and removes the temp.
 */
function atomicWriteJson(filePath: string, value: unknown): string {
  const serialized = `${JSON.stringify(canonicalize(value), null, 2)}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, serialized, 'utf8');
    JSON.parse(readFileSync(tmpPath, 'utf8')); // post-write validation
    renameSync(tmpPath, filePath); // atomic replace
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return filePath;
}

function atomicAppendCanonicalJsonLine(filePath: string, value: unknown): string {
  const prior = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const prefix = prior && !prior.endsWith('\n') ? `${prior}\n` : prior;
  const next = `${prefix}${JSON.stringify(canonicalize(value))}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, next, 'utf8');
    for (const line of readFileSync(tmpPath, 'utf8').split('\n')) {
      if (line.trim()) JSON.parse(line);
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return filePath;
}

// ── B-4f46 CHK-003: Experience Layer Phase 1b — signature-registry ────────────
//
// A small, audit-only catalog of finding `signatureTag`s and their lifecycle
// status. Lives under `.lattice/learning/` (materialHash-EXCLUDED — see
// SIGNATURE_REGISTRY_FILENAME). NO gate reads it; it only catalogs/folds tags so
// the Phase-1a finding-signals become more meaningful over time.

/** Lifecycle status of a signature tag. */
export type SignatureTagStatus = 'active' | 'proposed' | 'deprecated';

/** A single registered signature tag. */
export interface SignatureTagEntry {
  tag: string;
  status: SignatureTagStatus;
  /** Synonyms that fold to this canonical tag. */
  aliases: string[];
  /** When deprecated/merged, the canonical tag this folds into; else null. */
  mergedInto: string | null;
  /** Audit trace: who proposed/created it. */
  createdBy: string;
  /** Audit trace: who approved it (only set once it became active); else null. */
  approvedBy: string | null;
}

/** The signature-registry file envelope. */
export interface SignatureRegistryData {
  tags: SignatureTagEntry[];
}

function emptyRegistry(): SignatureRegistryData {
  return { tags: [] };
}

function normalizeTag(tag: unknown): string {
  return typeof tag === 'string' ? tag.trim() : '';
}

/**
 * Read the signature-registry. Returns an empty `{ tags: [] }` when the file is
 * absent (fresh project) or malformed (graceful degradation — never throws).
 */
export function readSignatureRegistry(projectRoot: string): SignatureRegistryData {
  const filePath = resolveSignatureRegistryPath(projectRoot);
  if (!existsSync(filePath)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as SignatureRegistryData;
    if (!parsed || !Array.isArray(parsed.tags)) return emptyRegistry();
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

/** Atomically write the signature-registry (canonical key order; idempotent on disk). */
export function writeSignatureRegistry(projectRoot: string, data: SignatureRegistryData): string {
  return atomicWriteJson(resolveSignatureRegistryPath(projectRoot), data);
}

/** List all registered signature tags. */
export function listSignatureTags(projectRoot: string): SignatureTagEntry[] {
  return readSignatureRegistry(projectRoot).tags;
}

function findTag(data: SignatureRegistryData, tag: string): SignatureTagEntry | undefined {
  return data.tags.find((t) => t.tag === tag);
}

/**
 * Propose a new tag as `status='proposed'`. Idempotent: if the tag already
 * exists (any status) it is returned unchanged. Returns the resulting entry.
 */
export function proposeSignatureTag(projectRoot: string, tag: string, by: string): SignatureTagEntry {
  const canonical = normalizeTag(tag);
  if (!canonical) throw new Error('proposeSignatureTag: tag must be a non-empty string');
  const data = readSignatureRegistry(projectRoot);
  const existing = findTag(data, canonical);
  if (existing) return existing;
  const entry: SignatureTagEntry = {
    tag: canonical,
    status: 'proposed',
    aliases: [],
    mergedInto: null,
    createdBy: by || 'unknown',
    approvedBy: null,
  };
  data.tags.push(entry);
  writeSignatureRegistry(projectRoot, data);
  return entry;
}

/**
 * Approve a tag: flips an existing `proposed` (or any non-active) entry to
 * `active`. Returns the resulting entry.
 *
 * B-4f46 F-001 (CHK-003:adversarial:0): approve must NOT auto-create a never-
 * proposed tag — the propose step cannot be skipped. Approving a tag that does
 * not already exist in the registry is REJECTED with a clear error. Approving an
 * already-active tag is idempotent (no error; it stays active — CHK-003:edge:1).
 */
export function approveSignatureTag(projectRoot: string, tag: string, by: string): SignatureTagEntry {
  const canonical = normalizeTag(tag);
  if (!canonical) throw new Error('approveSignatureTag: tag must be a non-empty string');
  const data = readSignatureRegistry(projectRoot);
  const entry = findTag(data, canonical);
  if (!entry) {
    throw new Error(
      `approveSignatureTag: tag "${canonical}" has not been proposed; ` +
      'propose it first (signature_registry_set action=propose) before approving',
    );
  }
  entry.status = 'active';
  entry.mergedInto = null;
  entry.approvedBy = by || entry.approvedBy || 'unknown';
  writeSignatureRegistry(projectRoot, data);
  return entry;
}

/**
 * Add `alias` as a synonym of the canonical `tag` (auto-creating `tag` as
 * proposed if absent). Deduped. Returns the resulting canonical entry.
 */
export function aliasSignatureTag(projectRoot: string, tag: string, alias: string, by = 'unknown'): SignatureTagEntry {
  const canonical = normalizeTag(tag);
  const synonym = normalizeTag(alias);
  if (!canonical) throw new Error('aliasSignatureTag: tag must be a non-empty string');
  if (!synonym) throw new Error('aliasSignatureTag: alias must be a non-empty string');
  if (synonym === canonical) throw new Error('aliasSignatureTag: alias must differ from the canonical tag');
  const data = readSignatureRegistry(projectRoot);
  let entry = findTag(data, canonical);
  if (!entry) {
    entry = {
      tag: canonical,
      status: 'proposed',
      aliases: [],
      mergedInto: null,
      createdBy: by || 'unknown',
      approvedBy: null,
    };
    data.tags.push(entry);
  }
  if (!entry.aliases.includes(synonym)) entry.aliases.push(synonym);
  writeSignatureRegistry(projectRoot, data);
  return entry;
}

/**
 * Deprecate a tag, optionally folding it into another canonical tag
 * (`mergedInto`). Auto-creates the tag if absent. Returns the resulting entry.
 */
export function deprecateSignatureTag(projectRoot: string, tag: string, mergedInto?: string, by = 'unknown'): SignatureTagEntry {
  const canonical = normalizeTag(tag);
  if (!canonical) throw new Error('deprecateSignatureTag: tag must be a non-empty string');
  const target = normalizeTag(mergedInto) || null;
  const data = readSignatureRegistry(projectRoot);
  let entry = findTag(data, canonical);
  if (!entry) {
    entry = {
      tag: canonical,
      status: 'deprecated',
      aliases: [],
      mergedInto: target,
      createdBy: by || 'unknown',
      approvedBy: null,
    };
    data.tags.push(entry);
  } else {
    entry.status = 'deprecated';
    entry.mergedInto = target;
  }
  writeSignatureRegistry(projectRoot, data);
  return entry;
}

/**
 * Fold a raw tag to its canonical active tag: follows aliases (a synonym resolves
 * to the entry that lists it) and `mergedInto` chains (bounded to avoid cycles).
 * Returns the canonical tag string, or the input (trimmed) when no fold applies.
 */
export function resolveTag(projectRoot: string, tag: string): string {
  const data = readSignatureRegistry(projectRoot);
  let current = normalizeTag(tag);
  if (!current) return current;
  const seen = new Set<string>();
  // Bound the walk by the number of entries to guarantee termination on cycles.
  for (let i = 0; i <= data.tags.length; i += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    // Direct entry whose own tag matches.
    const direct = data.tags.find((t) => t.tag === current);
    if (direct) {
      if (direct.mergedInto && direct.mergedInto !== current) {
        current = direct.mergedInto;
        continue;
      }
      return direct.tag;
    }
    // Otherwise, an alias on some entry.
    const byAlias = data.tags.find((t) => t.aliases.includes(current));
    if (byAlias) {
      if (byAlias.mergedInto && byAlias.mergedInto !== byAlias.tag) {
        current = byAlias.mergedInto;
        continue;
      }
      return byAlias.tag;
    }
    // No match anywhere: the tag is unknown; return as-is.
    return current;
  }
  return current;
}

/** Whether a tag is already an active or proposed (non-deprecated) entry. */
export function hasActiveOrProposedTag(projectRoot: string, tag: string): boolean {
  const canonical = normalizeTag(tag);
  if (!canonical) return false;
  const data = readSignatureRegistry(projectRoot);
  return data.tags.some(
    (t) => (t.tag === canonical || t.aliases.includes(canonical)) && t.status !== 'deprecated',
  );
}

/**
 * Suggest a near-match active tag for a not-yet-registered `tag` (cheap
 * normalized similarity: case-insensitive substring / shared-prefix). Returns
 * the canonical tag string of the best active candidate, or undefined.
 */
export function suggestNearActiveTag(projectRoot: string, tag: string): string | undefined {
  const canonical = normalizeTag(tag).toLowerCase();
  if (!canonical) return undefined;
  const active = readSignatureRegistry(projectRoot).tags.filter((t) => t.status === 'active');
  for (const t of active) {
    const lower = t.tag.toLowerCase();
    if (lower === canonical) return undefined; // exact match is not a near-miss
    if (lower.includes(canonical) || canonical.includes(lower)) return t.tag;
  }
  return undefined;
}

// ── B-8387 (Experience Layer Phase 2): playbooks + staged proposals ───────────
//
// Two file shapes under `.lattice/learning/`:
//   • playbooks.json — a flat array of approved Playbooks (status candidate+).
//   • proposals/<id>.json — one staged PlaybookProposal per file.
// Both use the same atomic writer (temp + post-write parse + rename) and
// canonical key order so re-writing identical data is byte-identical on disk.
// This module imports ONLY `node:` builtins, `./digest.js`, and the leaf
// `./experience-layer-types.js` — no outward coupling into handlers/gates.

/**
 * Validate a proposal id is a safe single path segment (no traversal / no
 * separators / no NUL). Returns the trimmed id. Throws a clear error otherwise,
 * so a hostile or malformed id can never escape the proposals/ directory.
 */
function safeProposalId(id: unknown): string {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) throw new Error('proposal id must be a non-empty string');
  if (value.includes('/') || value.includes('\\') || value.includes('\0') || value === '.' || value === '..' || value.includes('..')) {
    throw new Error(`proposal id contains illegal path characters: ${value}`);
  }
  return value;
}

/** Absolute path of a single proposal file under a project root. */
export function resolveProposalPath(projectRoot: string, id: string): string {
  return join(resolveProposalsDir(projectRoot), `${safeProposalId(id)}.json`);
}

/**
 * The digest domain of a proposal: the proposal MINUS its own `proposalDigest`
 * field (cloning the decision-doc digest-domain exclusion — a digest can never
 * cover itself). digestCanonicalJson handles recursive key sorting.
 */
function proposalDigestDomain(proposal: PlaybookProposal): Omit<PlaybookProposal, 'proposalDigest'> {
  const { proposalDigest: _proposalDigest, ...domain } = proposal;
  return domain;
}

/** Stable sha256 over the canonical proposal domain (excluding proposalDigest). */
export function computePlaybookProposalDigest(proposal: PlaybookProposal): string {
  return digestCanonicalJson(proposalDigestDomain(proposal));
}

/** Stable sha256 over one approved playbook row as persisted in playbooks.json. */
export function computePlaybookDigest(playbook: Playbook): string {
  return digestCanonicalJson(playbook);
}

const PLAYBOOK_STATUSES = new Set(['proposed', 'candidate', 'active', 'stale', 'archived']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Runtime shape check for persisted playbook rows. */
export function validatePlaybook(raw: unknown): { ok: true; playbook: Playbook } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'expected object' };
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!id) return { ok: false, error: 'id must be a non-empty string' };
  if (typeof obj.title !== 'string' || !obj.title.trim()) return { ok: false, error: `playbook ${id}: title must be a non-empty string` };
  if (typeof obj.check !== 'string' || !obj.check.trim()) return { ok: false, error: `playbook ${id}: check must be a non-empty string` };
  if (!isStringArray(obj.pitfalls)) return { ok: false, error: `playbook ${id}: pitfalls must be a string array` };
  if (!isStringArray(obj.verification)) return { ok: false, error: `playbook ${id}: verification must be a string array` };
  if (typeof obj.status !== 'string' || !PLAYBOOK_STATUSES.has(obj.status)) {
    return { ok: false, error: `playbook ${id}: status must be proposed|candidate|active|stale|archived` };
  }

  const trigger = obj.trigger as Record<string, unknown> | null;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return { ok: false, error: `playbook ${id}: trigger must be an object` };
  if (!isStringArray(trigger.keywords)) return { ok: false, error: `playbook ${id}: trigger.keywords must be a string array` };
  if (!isStringArray(trigger.fileKinds)) return { ok: false, error: `playbook ${id}: trigger.fileKinds must be a string array` };
  if (!isStringArray(trigger.storyPhases)) return { ok: false, error: `playbook ${id}: trigger.storyPhases must be a string array` };

  const lineage = obj.lineage as Record<string, unknown> | null;
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) return { ok: false, error: `playbook ${id}: lineage must be an object` };
  if (typeof lineage.sourceStoryId !== 'string' || !lineage.sourceStoryId.trim()) return { ok: false, error: `playbook ${id}: lineage.sourceStoryId must be a non-empty string` };
  if (typeof lineage.sourceFindingId !== 'string' || !lineage.sourceFindingId.trim()) return { ok: false, error: `playbook ${id}: lineage.sourceFindingId must be a non-empty string` };
  if (lineage.sourceSignature !== undefined && typeof lineage.sourceSignature !== 'string') return { ok: false, error: `playbook ${id}: lineage.sourceSignature must be a string when present` };

  const usage = obj.usage as Record<string, unknown> | null;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return { ok: false, error: `playbook ${id}: usage must be an object` };
  if (!isNonNegativeNumber(usage.surfacedCount)) return { ok: false, error: `playbook ${id}: usage.surfacedCount must be a non-negative number` };
  if (!isNonNegativeNumber(usage.resolvedHits)) return { ok: false, error: `playbook ${id}: usage.resolvedHits must be a non-negative number` };
  if (!isNonNegativeNumber(usage.dismissedHits)) return { ok: false, error: `playbook ${id}: usage.dismissedHits must be a non-negative number` };

  return { ok: true, playbook: raw as Playbook };
}

/**
 * Read all approved playbooks. Returns `[]` when the file is absent (cold start)
 * or malformed (graceful degradation — never throws / never corrupts state).
 */
export function readPlaybooks(projectRoot: string): Playbook[] {
  const filePath = resolvePlaybooksPath(projectRoot);
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as Playbook[]) : [];
  } catch {
    return [];
  }
}

/** Atomically write the full playbooks array (canonical key order; idempotent). */
export function writePlaybooks(projectRoot: string, playbooks: Playbook[]): string {
  return atomicWriteJson(resolvePlaybooksPath(projectRoot), playbooks);
}

/** Append one playbook to playbooks.json (read-modify-write). Returns the path. */
export function appendPlaybook(projectRoot: string, playbook: Playbook): string {
  const playbooks = readPlaybooks(projectRoot);
  playbooks.push(playbook);
  return writePlaybooks(projectRoot, playbooks);
}

/**
 * Read one staged proposal. Returns `null` when absent or malformed (graceful
 * degradation — callers surface a clear not-found error of their own).
 */
export function readProposal(projectRoot: string, id: string): PlaybookProposal | null {
  const filePath = resolveProposalPath(projectRoot, id);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as PlaybookProposal;
  } catch {
    return null;
  }
}

/** List all staged proposals (sorted by id). Tolerates missing dir / bad files. */
export function listProposals(projectRoot: string): PlaybookProposal[] {
  const dir = resolveProposalsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: PlaybookProposal[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const proposal = readProposal(projectRoot, name.slice(0, -'.json'.length));
    if (proposal) out.push(proposal);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Atomically write one staged proposal to proposals/<id>.json. Returns path. */
export function writeProposal(projectRoot: string, proposal: PlaybookProposal): string {
  const id = safeProposalId(proposal.id);
  return atomicWriteJson(resolveProposalPath(projectRoot, id), proposal);
}

/**
 * Delete one staged proposal. Returns `true` if a file was removed, `false` if
 * it was already absent (idempotent — never throws on a missing file).
 */
export function deleteProposal(projectRoot: string, id: string): boolean {
  const filePath = resolveProposalPath(projectRoot, id);
  if (!existsSync(filePath)) return false;
  rmSync(filePath, { force: true });
  return true;
}

// ── B-dddd M0-M2: playbook outcome ledger ────────────────────────────────────

const PLAYBOOK_OUTCOME_SCHEMA_VERSION = 'proofbound.playbook-outcome.v1';
const PLAYBOOK_EXPOSURE_MODES = new Set(['candidate-inspection', 'active-advisory', 'none']);
const PLAYBOOK_OUTCOME_VERDICTS = new Set(['helped', 'neutral', 'dismissed', 'harmful', 'unknown']);
const STRUCTURED_VERDICT_SOURCE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{1,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function ownString(value: Record<string, unknown>, key: string): string {
  const raw = own(value, key);
  return typeof raw === 'string' ? raw.trim() : '';
}

function ownBoolean(value: Record<string, unknown>, key: string): boolean | null {
  const raw = own(value, key);
  return typeof raw === 'boolean' ? raw : null;
}

function ownStringArray(value: Record<string, unknown>, key: string): string[] | null {
  const raw = own(value, key);
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return null;
  return raw.map((item) => item.trim()).filter(Boolean);
}

function optionalOwnString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = own(value, key);
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? raw.trim() : '';
}

function validateOptionalStringFields(value: Record<string, unknown>, fields: string[], label: string): string | null {
  for (const field of fields) {
    const raw = own(value, field);
    if (raw !== undefined && typeof raw !== 'string') return `${label}.${field} must be a string when present`;
  }
  return null;
}

function validateIsoTimestamp(value: string, label: string): string | null {
  if (!value) return `${label} must be a non-empty ISO timestamp`;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return `${label} must be a valid ISO timestamp`;
  return null;
}

export function isPositiveHelpedPlaybookOutcome(event: PlaybookOutcomeEvent): boolean {
  return event.outcome.verdict === 'helped'
    && event.exposureMode !== 'none'
    && STRUCTURED_VERDICT_SOURCE_RE.test(event.outcome.verdictSource);
}

export function validatePlaybookOutcomeEvent(raw: unknown): { ok: true; event: PlaybookOutcomeEvent } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'event must be an object' };

  if (ownString(raw, 'schemaVersion') !== PLAYBOOK_OUTCOME_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion must be ${PLAYBOOK_OUTCOME_SCHEMA_VERSION}` };
  }
  const eventId = ownString(raw, 'eventId');
  if (!eventId) return { ok: false, error: 'eventId must be a non-empty string' };
  const idempotencyKey = ownString(raw, 'idempotencyKey');
  if (!idempotencyKey) return { ok: false, error: 'idempotencyKey must be a non-empty string' };
  const observedAt = ownString(raw, 'observedAt');
  const observedAtError = validateIsoTimestamp(observedAt, 'observedAt');
  if (observedAtError) return { ok: false, error: observedAtError };
  const storyId = ownString(raw, 'storyId');
  if (!storyId) return { ok: false, error: 'storyId must be a non-empty string' };
  const playbookId = ownString(raw, 'playbookId');
  if (!playbookId) return { ok: false, error: 'playbookId must be a non-empty string' };
  const playbookStatusAtObservation = ownString(raw, 'playbookStatusAtObservation');
  if (playbookStatusAtObservation !== 'candidate' && playbookStatusAtObservation !== 'active') {
    return { ok: false, error: 'playbookStatusAtObservation must be candidate|active' };
  }
  const exposureMode = ownString(raw, 'exposureMode');
  if (!PLAYBOOK_EXPOSURE_MODES.has(exposureMode)) {
    return { ok: false, error: 'exposureMode must be candidate-inspection|active-advisory|none' };
  }
  const consumer = ownString(raw, 'consumer');
  if (!consumer) return { ok: false, error: 'consumer must be a non-empty string' };

  const context = own(raw, 'context');
  if (!isRecord(context)) return { ok: false, error: 'context must be an object' };
  const fileKinds = ownStringArray(context, 'fileKinds');
  if (!fileKinds) return { ok: false, error: 'context.fileKinds must be a string array' };
  const triggerClasses = ownStringArray(context, 'triggerClasses');
  if (!triggerClasses) return { ok: false, error: 'context.triggerClasses must be a string array' };
  const contextOptionalError = validateOptionalStringFields(context, ['storyPhase', 'storyType', 'host', 'hostProvider', 'hostCapabilityId'], 'context');
  if (contextOptionalError) return { ok: false, error: contextOptionalError };

  const outcome = own(raw, 'outcome');
  if (!isRecord(outcome)) return { ok: false, error: 'outcome must be an object' };
  const verdict = ownString(outcome, 'verdict');
  if (!PLAYBOOK_OUTCOME_VERDICTS.has(verdict)) {
    return { ok: false, error: 'outcome.verdict must be helped|neutral|dismissed|harmful|unknown' };
  }
  const verdictSource = ownString(outcome, 'verdictSource');
  if (!STRUCTURED_VERDICT_SOURCE_RE.test(verdictSource)) {
    return { ok: false, error: 'outcome.verdictSource must be a structured non-empty source token' };
  }
  const causedNoise = ownBoolean(outcome, 'causedNoise');
  if (causedNoise === null) return { ok: false, error: 'outcome.causedNoise must be a boolean' };
  const causedWrongClaim = ownBoolean(outcome, 'causedWrongClaim');
  if (causedWrongClaim === null) return { ok: false, error: 'outcome.causedWrongClaim must be a boolean' };
  const preventedRepeatFinding = ownBoolean(outcome, 'preventedRepeatFinding');
  if (preventedRepeatFinding === null) return { ok: false, error: 'outcome.preventedRepeatFinding must be a boolean' };
  const note = optionalOwnString(outcome, 'note');
  if (note === '') return { ok: false, error: 'outcome.note must be non-empty when present' };
  if (verdict === 'helped' && exposureMode === 'none') {
    return { ok: false, error: 'helped outcomes require exposureMode other than none' };
  }

  const bindings = own(raw, 'bindings');
  if (!isRecord(bindings)) return { ok: false, error: 'bindings must be an object' };
  const bindingError = validateOptionalStringFields(bindings, ['headHash', 'storyFilesHash', 'materialHash', 'summaryDigest', 'deliveryCheckDigest'], 'bindings');
  if (bindingError) return { ok: false, error: bindingError };

  if (ownString(raw, 'authority') !== 'non_authoritative') {
    return { ok: false, error: 'authority must be non_authoritative' };
  }
  if (own(raw, 'gateEvidence') !== false) {
    return { ok: false, error: 'gateEvidence must be false' };
  }

  const event: PlaybookOutcomeEvent = {
    schemaVersion: PLAYBOOK_OUTCOME_SCHEMA_VERSION,
    eventId,
    idempotencyKey,
    observedAt,
    storyId,
    playbookId,
    playbookStatusAtObservation: playbookStatusAtObservation as PlaybookOutcomeEvent['playbookStatusAtObservation'],
    exposureMode: exposureMode as PlaybookOutcomeEvent['exposureMode'],
    consumer,
    context: {
      ...(optionalOwnString(context, 'storyPhase') ? { storyPhase: optionalOwnString(context, 'storyPhase') } : {}),
      ...(optionalOwnString(context, 'storyType') ? { storyType: optionalOwnString(context, 'storyType') } : {}),
      fileKinds,
      triggerClasses,
      ...(optionalOwnString(context, 'host') ? { host: optionalOwnString(context, 'host') } : {}),
      ...(optionalOwnString(context, 'hostProvider') ? { hostProvider: optionalOwnString(context, 'hostProvider') } : {}),
      ...(optionalOwnString(context, 'hostCapabilityId') ? { hostCapabilityId: optionalOwnString(context, 'hostCapabilityId') } : {}),
    },
    outcome: {
      verdict: verdict as PlaybookOutcomeEvent['outcome']['verdict'],
      verdictSource,
      causedNoise,
      causedWrongClaim,
      preventedRepeatFinding,
      ...(note ? { note } : {}),
    },
    bindings: {
      ...(optionalOwnString(bindings, 'headHash') ? { headHash: optionalOwnString(bindings, 'headHash') } : {}),
      ...(optionalOwnString(bindings, 'storyFilesHash') ? { storyFilesHash: optionalOwnString(bindings, 'storyFilesHash') } : {}),
      ...(optionalOwnString(bindings, 'materialHash') ? { materialHash: optionalOwnString(bindings, 'materialHash') } : {}),
      ...(optionalOwnString(bindings, 'summaryDigest') ? { summaryDigest: optionalOwnString(bindings, 'summaryDigest') } : {}),
      ...(optionalOwnString(bindings, 'deliveryCheckDigest') ? { deliveryCheckDigest: optionalOwnString(bindings, 'deliveryCheckDigest') } : {}),
    },
    authority: 'non_authoritative',
    gateEvidence: false,
  };
  return { ok: true, event };
}

/** Read valid playbook outcome rows. Missing or malformed rows degrade to skip. */
export function readPlaybookOutcomeEvents(projectRoot: string): PlaybookOutcomeEvent[] {
  const filePath = resolvePlaybookOutcomesPath(projectRoot);
  if (!existsSync(filePath)) return [];
  const out: PlaybookOutcomeEvent[] = [];
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const validated = validatePlaybookOutcomeEvent(JSON.parse(line));
      if (validated.ok) out.push(validated.event);
    } catch {
      // Malformed/truncated rows are ignored by readers; appends still fail closed.
    }
  }
  return out;
}

/** Append one validated, canonical JSONL outcome row under `.lattice/learning/`. */
export function appendPlaybookOutcomeEvent(projectRoot: string, event: PlaybookOutcomeEvent): string {
  const validated = validatePlaybookOutcomeEvent(event);
  if (!validated.ok) throw new Error(`appendPlaybookOutcomeEvent: ${validated.error}`);
  return atomicAppendCanonicalJsonLine(resolvePlaybookOutcomesPath(projectRoot), validated.event);
}
