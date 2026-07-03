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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { digestCanonicalJson } from './digest.js';
import type {
  FindingSignalsCache,
  NonDeducibleOverrideEvent,
  NonDeducibleSourceRecord,
  NonDeducibleSourcesRegistry,
  Playbook,
  PlaybookAutoActivationEvent,
  PlaybookLineage,
  PlaybookOutcomeEvent,
  PlaybookPromotionActionableRecommendation,
  PlaybookPromotionAggregate,
  PlaybookPromotionConfig,
  PlaybookPromotionDecisionAction,
  PlaybookPromotionDecisionRow,
  PlaybookPromotionEvaluation,
  PlaybookPromotionHealthEvent,
  PlaybookPromotionObserveReport,
  PlaybookPromotionObserveSinceWindow,
  PlaybookProposal,
  PlaybookSourceReference,
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
/** B-6241: append-only promotion sweep recommendation/decision rows. */
export const PLAYBOOK_PROMOTION_DECISIONS_FILENAME = 'playbook-promotion-decisions.jsonl';
/** B-7ee1: append-only evidence-activation rows for advisory playbooks. */
export const PLAYBOOK_AUTO_ACTIVATIONS_FILENAME = 'playbook-auto-activations.jsonl';
/** B-6241: source experiences judged unsuitable for repeated playbook distillation. */
export const NON_DEDUCIBLE_SOURCES_FILENAME = 'non-deducible-sources.json';
/** B-6241: advisory learning settlement/retention/validation health log. */
export const PLAYBOOK_PROMOTION_HEALTH_FILENAME = 'playbook-promotion-health.jsonl';
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

/** Absolute promotion decision log path under the shared learning root. */
export function resolvePlaybookPromotionDecisionsPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), PLAYBOOK_PROMOTION_DECISIONS_FILENAME);
}

/** Absolute evidence-activation audit log path under the shared learning root. */
export function resolvePlaybookAutoActivationsPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), PLAYBOOK_AUTO_ACTIVATIONS_FILENAME);
}

/** Absolute non-deducible source registry path under the shared learning root. */
export function resolveNonDeducibleSourcesPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), NON_DEDUCIBLE_SOURCES_FILENAME);
}

/** Absolute promotion settlement/health log path under the shared learning root. */
export function resolvePlaybookPromotionHealthPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), PLAYBOOK_PROMOTION_HEALTH_FILENAME);
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

function safeLockName(label: string): string {
  const safe = label.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'learning-store';
}

const heldLearningStoreLocks = new Map<string, number>();

/**
 * Dedicated learning-store serialization. It deliberately lives under
 * `.lattice/learning/` and does not acquire the lifecycle/main write lock.
 */
export function withLearningStoreLock<T>(
  projectRoot: string,
  label: string,
  fn: () => T,
  opts: { timeoutMs?: number } = {},
): T {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 2000);
  const locksDir = join(resolveLearningDir(projectRoot), '.locks');
  const lockDir = join(locksDir, `${safeLockName(label)}.lock`);
  const started = Date.now();
  const heldDepth = heldLearningStoreLocks.get(lockDir) ?? 0;
  if (heldDepth > 0) {
    heldLearningStoreLocks.set(lockDir, heldDepth + 1);
    try {
      return fn();
    } finally {
      const nextDepth = (heldLearningStoreLocks.get(lockDir) ?? 1) - 1;
      if (nextDepth > 0) heldLearningStoreLocks.set(lockDir, nextDepth);
      else heldLearningStoreLocks.delete(lockDir);
    }
  }
  mkdirSync(locksDir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST' || Date.now() - started >= timeoutMs) {
        throw new Error(`learning-store lock is held for ${label}; retry later`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  heldLearningStoreLocks.set(lockDir, 1);
  try {
    return fn();
  } finally {
    heldLearningStoreLocks.delete(lockDir);
    rmSync(lockDir, { recursive: true, force: true });
  }
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
    && event.outcome.verdictSource !== 'done-settlement'
    && STRUCTURED_VERDICT_SOURCE_RE.test(event.outcome.verdictSource);
}

export function isStructuredPlaybookOutcomeVerdictSource(value: string): boolean {
  return STRUCTURED_VERDICT_SOURCE_RE.test(value);
}

export function isCandidateConsumedPlaybookOutcome(event: PlaybookOutcomeEvent): boolean {
  return event.playbookStatusAtObservation === 'candidate'
    && event.exposureMode !== 'none'
    && event.outcome.verdictSource !== 'done-settlement'
    && isStructuredPlaybookOutcomeVerdictSource(event.outcome.verdictSource);
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
  if (readPlaybookOutcomeEvents(projectRoot).some((row) => row.idempotencyKey === validated.event.idempotencyKey)) {
    return resolvePlaybookOutcomesPath(projectRoot);
  }
  return atomicAppendCanonicalJsonLine(resolvePlaybookOutcomesPath(projectRoot), validated.event);
}

// ── B-6241 M3-M6: promotion worker learning metadata ────────────────────────

const PLAYBOOK_PROMOTION_DECISION_SCHEMA_VERSION = 'proofbound.playbook-promotion-decision.v1';
const PLAYBOOK_AUTO_ACTIVATION_SCHEMA_VERSION = 'proofbound.playbook-auto-activation.v1';
const NON_DEDUCIBLE_SOURCES_SCHEMA_VERSION = 'proofbound.non-deducible-sources.v1';
const PLAYBOOK_PROMOTION_HEALTH_SCHEMA_VERSION = 'proofbound.playbook-promotion-health.v1';
const NON_DEDUCIBLE_SOURCE_ROW_SCHEMA_VERSION = 'proofbound.non-deducible-source.v1';

const PLAYBOOK_PROMOTION_ACTIONS = new Set([
  'recommend_activate',
  'reject',
  'hold',
  'archive',
  'recommend_demote',
  'mark_non_deducible',
]);

const PLAYBOOK_PROMOTION_HEALTH_KINDS = new Set(['done-settlement', 'retention', 'validation']);
const PLAYBOOK_PROMOTION_SETTLEMENT_STATUSES = new Set(['disabled', 'recorded', 'failed']);

export const DEFAULT_PLAYBOOK_PROMOTION_CONFIG: PlaybookPromotionConfig = {
  minDecisiveSamples: 3,
  minHelpedCount: 2,
  minContextClasses: 2,
  maxDismissalRate: 0.30,
  maxHarmfulCount: 0,
  maxWrongClaimCount: 0,
  nonDeducibleRejectedSiblingThreshold: 3,
  retentionMaxBytes: 5 * 1024 * 1024,
};

function promotionConfig(config: Partial<PlaybookPromotionConfig> = {}): PlaybookPromotionConfig {
  return { ...DEFAULT_PLAYBOOK_PROMOTION_CONFIG, ...config };
}

function stringSet(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out].sort();
}

export function buildPlaybookSourceReference(lineage: PlaybookLineage): PlaybookSourceReference {
  const sourceStoryId = lineage.sourceStoryId.trim();
  const sourceFindingId = lineage.sourceFindingId.trim();
  const sourceSignature = lineage.sourceSignature?.trim() || undefined;
  const digest = digestCanonicalJson({ sourceFindingId, sourceSignature, sourceStoryId }).slice(0, 16);
  return {
    sourceKey: `PBSRC-${digest}`,
    sourceStoryId,
    sourceFindingId,
    ...(sourceSignature ? { sourceSignature } : {}),
  };
}

export function computeNonDeducibleOverrideReasonDigest(reason: string): string {
  return digestCanonicalJson({ nonDeducibleOverrideReason: reason.trim() });
}

function contextClass(event: PlaybookOutcomeEvent): string {
  return digestCanonicalJson({
    fileKinds: stringSet(event.context.fileKinds),
    host: event.context.host ?? '',
    hostCapabilityId: event.context.hostCapabilityId ?? '',
    hostProvider: event.context.hostProvider ?? '',
    triggerClasses: stringSet(event.context.triggerClasses),
  }).slice(0, 16);
}

function aggregateDigestDomain(aggregate: Omit<PlaybookPromotionAggregate, 'aggregateDigest'>): unknown {
  return aggregate;
}

function countRejectedSiblings(
  sourceKey: string,
  playbookId: string,
  decisions: PlaybookPromotionDecisionRow[],
): number {
  const siblings = new Set<string>();
  for (const row of decisions) {
    if (!row.applied) continue;
    if (row.action !== 'reject') continue;
    if (row.playbookId === playbookId) continue;
    if (row.before.sourceKey !== sourceKey) continue;
    siblings.add(row.playbookId);
  }
  return siblings.size;
}

export function aggregatePlaybookPromotion(
  playbook: Playbook,
  events: PlaybookOutcomeEvent[],
  priorDecisions: PlaybookPromotionDecisionRow[] = [],
): PlaybookPromotionAggregate {
  const source = buildPlaybookSourceReference(playbook.lineage);
  const seenOutcomeKeys = new Set<string>();
  const relevant = events.filter((event) => {
    if (event.playbookId !== playbook.id) return false;
    if (seenOutcomeKeys.has(event.idempotencyKey)) return false;
    seenOutcomeKeys.add(event.idempotencyKey);
    return true;
  });
  let helpedCount = 0;
  let dismissedCount = 0;
  let harmfulCount = 0;
  let wrongClaimCount = 0;
  let neutralCount = 0;
  let unknownCount = 0;
  const decisiveContextClasses = new Set<string>();

  for (const event of relevant) {
    const doneSettlement = event.outcome.verdictSource === 'done-settlement';
    if (!doneSettlement && event.outcome.causedWrongClaim) wrongClaimCount += 1;
    if (!doneSettlement && event.outcome.verdict === 'helped' && isPositiveHelpedPlaybookOutcome(event)) {
      helpedCount += 1;
      decisiveContextClasses.add(contextClass(event));
    } else if (!doneSettlement && event.outcome.verdict === 'dismissed') {
      dismissedCount += 1;
      decisiveContextClasses.add(contextClass(event));
    } else if (!doneSettlement && event.outcome.verdict === 'harmful') {
      harmfulCount += 1;
      decisiveContextClasses.add(contextClass(event));
    } else if (event.outcome.verdict === 'neutral') {
      neutralCount += 1;
    } else {
      unknownCount += 1;
    }
  }

  const decisiveSamples = helpedCount + dismissedCount + harmfulCount;
  const domain: Omit<PlaybookPromotionAggregate, 'aggregateDigest'> = {
    playbookId: playbook.id,
    status: playbook.status,
    decisiveSamples,
    helpedCount,
    dismissedCount,
    harmfulCount,
    wrongClaimCount,
    neutralCount,
    unknownCount,
    contextClassCount: decisiveContextClasses.size,
    sourceRejectedSiblingCount: countRejectedSiblings(source.sourceKey, playbook.id, priorDecisions),
    source,
  };
  return {
    ...domain,
    aggregateDigest: digestCanonicalJson(aggregateDigestDomain(domain)),
  };
}

export function evaluatePlaybookPromotion(
  aggregate: PlaybookPromotionAggregate,
  partialConfig: Partial<PlaybookPromotionConfig> = {},
): PlaybookPromotionEvaluation {
  const config = promotionConfig(partialConfig);
  const reasonCodes: string[] = [];
  const dismissalRate = aggregate.decisiveSamples > 0 ? aggregate.dismissedCount / aggregate.decisiveSamples : 0;

  if (aggregate.sourceRejectedSiblingCount >= config.nonDeducibleRejectedSiblingThreshold) {
    return {
      action: 'mark_non_deducible',
      reasonCodes: ['source_rejected_sibling_threshold'],
    };
  }

  if (aggregate.status === 'stale') {
    return {
      action: 'archive',
      reasonCodes: ['playbook_status_stale'],
    };
  }

  if (aggregate.status === 'active') {
    if (aggregate.harmfulCount > config.maxHarmfulCount || aggregate.wrongClaimCount > config.maxWrongClaimCount) {
      return {
        action: 'recommend_demote',
        reasonCodes: [
          ...(aggregate.harmfulCount > config.maxHarmfulCount ? ['harmful_outcome_present'] : []),
          ...(aggregate.wrongClaimCount > config.maxWrongClaimCount ? ['wrong_claim_present'] : []),
        ],
      };
    }
    if (aggregate.decisiveSamples >= config.minDecisiveSamples && dismissalRate > config.maxDismissalRate) {
      return {
        action: 'recommend_demote',
        reasonCodes: ['dismissal_rate_exceeded'],
      };
    }
    return {
      action: 'hold',
      reasonCodes: ['active_no_negative_threshold'],
    };
  }

  if (aggregate.status !== 'candidate') {
    return {
      action: 'hold',
      reasonCodes: [`status_${aggregate.status}_not_evaluated`],
    };
  }

  if (aggregate.harmfulCount > config.maxHarmfulCount || aggregate.wrongClaimCount > config.maxWrongClaimCount) {
    return {
      action: 'reject',
      reasonCodes: [
        ...(aggregate.harmfulCount > config.maxHarmfulCount ? ['harmful_outcome_present'] : []),
        ...(aggregate.wrongClaimCount > config.maxWrongClaimCount ? ['wrong_claim_present'] : []),
      ],
    };
  }

  if (aggregate.decisiveSamples >= config.minDecisiveSamples && dismissalRate > config.maxDismissalRate) {
    return {
      action: 'reject',
      reasonCodes: ['dismissal_rate_exceeded'],
    };
  }

  if (aggregate.decisiveSamples < config.minDecisiveSamples) reasonCodes.push('insufficient_decisive_samples');
  if (aggregate.helpedCount < config.minHelpedCount) reasonCodes.push('insufficient_helped_count');
  if (aggregate.contextClassCount < config.minContextClasses) reasonCodes.push('insufficient_context_diversity');
  if (reasonCodes.length > 0) {
    return { action: 'hold', reasonCodes };
  }

  return {
    action: 'recommend_activate',
    reasonCodes: ['activation_threshold_met'],
  };
}

export function readPlaybookOutcomeEventsWithDiagnostics(projectRoot: string): {
  events: PlaybookOutcomeEvent[];
  malformedCount: number;
} {
  const filePath = resolvePlaybookOutcomesPath(projectRoot);
  if (!existsSync(filePath)) return { events: [], malformedCount: 0 };
  const events: PlaybookOutcomeEvent[] = [];
  let malformedCount = 0;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const validated = validatePlaybookOutcomeEvent(JSON.parse(line));
      if (validated.ok) events.push(validated.event);
      else malformedCount += 1;
    } catch {
      malformedCount += 1;
    }
  }
  return { events, malformedCount };
}

function ownNumber(value: Record<string, unknown>, key: string): number | null {
  const raw = own(value, key);
  return isNonNegativeNumber(raw) ? raw : null;
}

function validateSourceReference(raw: unknown, label: string): { ok: true; source: PlaybookSourceReference } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `${label} must be an object` };
  const sourceKey = ownString(raw, 'sourceKey');
  const sourceStoryId = ownString(raw, 'sourceStoryId');
  const sourceFindingId = ownString(raw, 'sourceFindingId');
  if (!sourceKey) return { ok: false, error: `${label}.sourceKey must be a non-empty string` };
  if (!sourceStoryId) return { ok: false, error: `${label}.sourceStoryId must be a non-empty string` };
  if (!sourceFindingId) return { ok: false, error: `${label}.sourceFindingId must be a non-empty string` };
  const sourceSignature = optionalOwnString(raw, 'sourceSignature');
  if (sourceSignature === '') return { ok: false, error: `${label}.sourceSignature must be non-empty when present` };
  return {
    ok: true,
    source: {
      sourceKey,
      sourceStoryId,
      sourceFindingId,
      ...(sourceSignature ? { sourceSignature } : {}),
    },
  };
}

function validatePromotionAggregate(raw: unknown): { ok: true; aggregate: PlaybookPromotionAggregate } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'aggregate must be an object' };
  const playbookId = ownString(raw, 'playbookId');
  if (!playbookId) return { ok: false, error: 'aggregate.playbookId must be a non-empty string' };
  const status = ownString(raw, 'status');
  if (!PLAYBOOK_STATUSES.has(status)) return { ok: false, error: 'aggregate.status must be a valid playbook status' };
  const source = validateSourceReference(own(raw, 'source'), 'aggregate.source');
  if (!source.ok) return source;
  const fields = [
    'decisiveSamples',
    'helpedCount',
    'dismissedCount',
    'harmfulCount',
    'wrongClaimCount',
    'neutralCount',
    'unknownCount',
    'contextClassCount',
    'sourceRejectedSiblingCount',
  ];
  const numbers: Record<string, number> = {};
  for (const field of fields) {
    const value = ownNumber(raw, field);
    if (value === null) return { ok: false, error: `aggregate.${field} must be a non-negative number` };
    numbers[field] = value;
  }
  const aggregateDigest = ownString(raw, 'aggregateDigest');
  if (!aggregateDigest) return { ok: false, error: 'aggregate.aggregateDigest must be a non-empty string' };
  const aggregate: PlaybookPromotionAggregate = {
    playbookId,
    status: status as PlaybookPromotionAggregate['status'],
    decisiveSamples: numbers.decisiveSamples,
    helpedCount: numbers.helpedCount,
    dismissedCount: numbers.dismissedCount,
    harmfulCount: numbers.harmfulCount,
    wrongClaimCount: numbers.wrongClaimCount,
    neutralCount: numbers.neutralCount,
    unknownCount: numbers.unknownCount,
    contextClassCount: numbers.contextClassCount,
    sourceRejectedSiblingCount: numbers.sourceRejectedSiblingCount,
    source: source.source,
    aggregateDigest,
  };
  const { aggregateDigest: _aggregateDigest, ...domain } = aggregate;
  if (digestCanonicalJson(domain) !== aggregateDigest) {
    return { ok: false, error: 'aggregate.aggregateDigest is stale or inconsistent' };
  }
  return { ok: true, aggregate };
}

export function validatePlaybookPromotionDecisionRow(raw: unknown): { ok: true; decision: PlaybookPromotionDecisionRow } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'decision row must be an object' };
  if (ownString(raw, 'schemaVersion') !== PLAYBOOK_PROMOTION_DECISION_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion must be ${PLAYBOOK_PROMOTION_DECISION_SCHEMA_VERSION}` };
  }
  const decisionId = ownString(raw, 'decisionId');
  const idempotencyKey = ownString(raw, 'idempotencyKey');
  const decidedAt = ownString(raw, 'decidedAt');
  const playbookId = ownString(raw, 'playbookId');
  const evaluatedStatus = ownString(raw, 'evaluatedStatus');
  const action = ownString(raw, 'action');
  const aggregateDigest = ownString(raw, 'aggregateDigest');
  if (!decisionId) return { ok: false, error: 'decisionId must be a non-empty string' };
  if (!idempotencyKey) return { ok: false, error: 'idempotencyKey must be a non-empty string' };
  const decidedAtError = validateIsoTimestamp(decidedAt, 'decidedAt');
  if (decidedAtError) return { ok: false, error: decidedAtError };
  if (!playbookId) return { ok: false, error: 'playbookId must be a non-empty string' };
  if (!PLAYBOOK_STATUSES.has(evaluatedStatus)) return { ok: false, error: 'evaluatedStatus must be a valid playbook status' };
  if (!PLAYBOOK_PROMOTION_ACTIONS.has(action)) return { ok: false, error: 'action must be a valid promotion decision' };
  const reasonCodes = ownStringArray(raw, 'reasonCodes');
  if (!reasonCodes || reasonCodes.length === 0) return { ok: false, error: 'reasonCodes must be a non-empty string array' };
  const aggregate = validatePromotionAggregate(own(raw, 'aggregate'));
  if (!aggregate.ok) return aggregate;
  if (aggregate.aggregate.aggregateDigest !== aggregateDigest) return { ok: false, error: 'aggregateDigest must match aggregate.aggregateDigest' };

  const before = own(raw, 'before');
  if (!isRecord(before)) return { ok: false, error: 'before must be an object' };
  const beforeStatus = ownString(before, 'playbookStatus');
  const beforeDigest = ownString(before, 'playbookDigest');
  const beforeSourceKey = ownString(before, 'sourceKey');
  if (!PLAYBOOK_STATUSES.has(beforeStatus)) return { ok: false, error: 'before.playbookStatus must be valid' };
  if (!beforeDigest) return { ok: false, error: 'before.playbookDigest must be non-empty' };
  if (!beforeSourceKey) return { ok: false, error: 'before.sourceKey must be non-empty' };

  const after = own(raw, 'after');
  if (!isRecord(after)) return { ok: false, error: 'after must be an object' };
  const afterStatus = ownString(after, 'playbookStatus');
  const recommendation = ownString(after, 'recommendation');
  if (!PLAYBOOK_STATUSES.has(afterStatus)) return { ok: false, error: 'after.playbookStatus must be valid' };
  if (!PLAYBOOK_PROMOTION_ACTIONS.has(recommendation)) return { ok: false, error: 'after.recommendation must be a valid promotion decision' };
  const nonDeducibleSourceKey = optionalOwnString(after, 'nonDeducibleSourceKey');
  if (nonDeducibleSourceKey === '') return { ok: false, error: 'after.nonDeducibleSourceKey must be non-empty when present' };

  if (ownString(raw, 'workerVersion') !== 'playbook-promotion-worker-v1') {
    return { ok: false, error: 'workerVersion must be playbook-promotion-worker-v1' };
  }
  const dryRun = ownBoolean(raw, 'dryRun');
  if (dryRun === null) return { ok: false, error: 'dryRun must be a boolean' };
  const applied = ownBoolean(raw, 'applied');
  if (applied === null) return { ok: false, error: 'applied must be a boolean' };
  const alreadyApplied = ownBoolean(raw, 'alreadyApplied');
  if (alreadyApplied === null) return { ok: false, error: 'alreadyApplied must be a boolean' };
  if (ownString(raw, 'authority') !== 'non_authoritative') return { ok: false, error: 'authority must be non_authoritative' };
  if (own(raw, 'gateEvidence') !== false) return { ok: false, error: 'gateEvidence must be false' };

  return {
    ok: true,
    decision: {
      schemaVersion: PLAYBOOK_PROMOTION_DECISION_SCHEMA_VERSION,
      decisionId,
      idempotencyKey,
      decidedAt,
      playbookId,
      evaluatedStatus: evaluatedStatus as PlaybookPromotionDecisionRow['evaluatedStatus'],
      action: action as PlaybookPromotionDecisionAction,
      reasonCodes,
      aggregateDigest,
      aggregate: aggregate.aggregate,
      before: {
        playbookStatus: beforeStatus as PlaybookPromotionDecisionRow['before']['playbookStatus'],
        playbookDigest: beforeDigest,
        sourceKey: beforeSourceKey,
      },
      after: {
        playbookStatus: afterStatus as PlaybookPromotionDecisionRow['after']['playbookStatus'],
        recommendation: recommendation as PlaybookPromotionDecisionAction,
        ...(nonDeducibleSourceKey ? { nonDeducibleSourceKey } : {}),
      },
      workerVersion: 'playbook-promotion-worker-v1',
      dryRun,
      applied,
      alreadyApplied,
      authority: 'non_authoritative',
      gateEvidence: false,
    },
  };
}

export function readPlaybookPromotionDecisionRows(projectRoot: string): {
  decisions: PlaybookPromotionDecisionRow[];
  malformedCount: number;
} {
  const filePath = resolvePlaybookPromotionDecisionsPath(projectRoot);
  if (!existsSync(filePath)) return { decisions: [], malformedCount: 0 };
  const decisions: PlaybookPromotionDecisionRow[] = [];
  let malformedCount = 0;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const validated = validatePlaybookPromotionDecisionRow(JSON.parse(line));
      if (validated.ok) decisions.push(validated.decision);
      else malformedCount += 1;
    } catch {
      malformedCount += 1;
    }
  }
  return { decisions, malformedCount };
}

export function readPlaybookPromotionDecisions(projectRoot: string): PlaybookPromotionDecisionRow[] {
  return readPlaybookPromotionDecisionRows(projectRoot).decisions;
}

export function appendPlaybookPromotionDecision(projectRoot: string, decision: PlaybookPromotionDecisionRow): string {
  const validated = validatePlaybookPromotionDecisionRow(decision);
  if (!validated.ok) throw new Error(`appendPlaybookPromotionDecision: ${validated.error}`);
  return withLearningStoreLock(projectRoot, 'playbook-promotion-decisions', () => {
    const filePath = resolvePlaybookPromotionDecisionsPath(projectRoot);
    if (
      validated.decision.applied
      && readPlaybookPromotionDecisions(projectRoot).some((row) =>
        row.applied && row.idempotencyKey === validated.decision.idempotencyKey)
    ) {
      return filePath;
    }
    return atomicAppendCanonicalJsonLine(filePath, validated.decision);
  });
}

export function hasAppliedPlaybookPromotionDecision(projectRoot: string, idempotencyKey: string): boolean {
  return readPlaybookPromotionDecisions(projectRoot).some((row) => row.applied && row.idempotencyKey === idempotencyKey);
}

function validatePlaybookAutoActivationEvent(raw: unknown): {
  ok: true;
  event: PlaybookAutoActivationEvent;
} | {
  ok: false;
  error: string;
} {
  if (!isRecord(raw)) return { ok: false, error: 'event must be an object' };
  if (ownString(raw, 'schemaVersion') !== PLAYBOOK_AUTO_ACTIVATION_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion must be ${PLAYBOOK_AUTO_ACTIVATION_SCHEMA_VERSION}` };
  }
  const activationId = ownString(raw, 'activationId');
  const idempotencyKey = ownString(raw, 'idempotencyKey');
  const activatedAt = ownString(raw, 'activatedAt');
  const playbookId = ownString(raw, 'playbookId');
  if (!activationId) return { ok: false, error: 'activationId must be a non-empty string' };
  if (!idempotencyKey) return { ok: false, error: 'idempotencyKey must be a non-empty string' };
  if (!playbookId) return { ok: false, error: 'playbookId must be a non-empty string' };
  const tsError = validateIsoTimestamp(activatedAt, 'activatedAt');
  if (tsError) return { ok: false, error: tsError };
  if (raw.authority !== 'non_authoritative') return { ok: false, error: 'authority must be non_authoritative' };
  if (raw.gateEvidence !== false) return { ok: false, error: 'gateEvidence must be false' };
  const before = own(raw, 'before');
  const after = own(raw, 'after');
  const policy = own(raw, 'policy');
  const evidence = own(raw, 'evidence');
  if (!isRecord(before) || ownString(before, 'playbookStatus') !== 'candidate' || !ownString(before, 'playbookDigest')) {
    return { ok: false, error: 'before must bind candidate status and digest' };
  }
  if (!isRecord(after) || ownString(after, 'playbookStatus') !== 'active' || !ownString(after, 'playbookDigest')) {
    return { ok: false, error: 'after must bind active status and digest' };
  }
  if (!isRecord(policy) || !ownString(policy, 'policyId') || !ownString(policy, 'policyDigest') || !ownString(policy, 'reviewedBy')) {
    return { ok: false, error: 'policy must bind id, digest, and reviewer' };
  }
  if (!isRecord(evidence) || ownString(evidence, 'recommendation') !== 'recommend_activate') {
    return { ok: false, error: 'evidence must bind recommend_activate' };
  }
  for (const key of ['aggregateDigest', 'decisionId', 'decisionIdempotencyKey', 'decisionDigest', 'lineageCanonicalSourceKey']) {
    if (!ownString(evidence, key)) return { ok: false, error: `evidence.${key} must be a non-empty string` };
  }
  for (const key of ['decisiveSamples', 'helpedCount', 'dismissedCount', 'harmfulCount', 'wrongClaimCount', 'contextClassCount', 'realOutcomeCount', 'exposureCount']) {
    if (!isNonNegativeNumber(own(evidence, key))) return { ok: false, error: `evidence.${key} must be a non-negative number` };
  }
  const reasonCodes = own(evidence, 'reasonCodes');
  if (!isStringArray(reasonCodes)) return { ok: false, error: 'evidence.reasonCodes must be a string array' };
  return { ok: true, event: raw as unknown as PlaybookAutoActivationEvent };
}

export function readPlaybookAutoActivationEventsWithDiagnostics(projectRoot: string): {
  events: PlaybookAutoActivationEvent[];
  malformedCount: number;
} {
  const filePath = resolvePlaybookAutoActivationsPath(projectRoot);
  if (!existsSync(filePath)) return { events: [], malformedCount: 0 };
  const events: PlaybookAutoActivationEvent[] = [];
  let malformedCount = 0;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const validated = validatePlaybookAutoActivationEvent(JSON.parse(line));
      if (validated.ok) events.push(validated.event);
      else malformedCount += 1;
    } catch {
      malformedCount += 1;
    }
  }
  return { events, malformedCount };
}

export function readPlaybookAutoActivationEvents(projectRoot: string): PlaybookAutoActivationEvent[] {
  return readPlaybookAutoActivationEventsWithDiagnostics(projectRoot).events;
}

export function assertCanAppendPlaybookAutoActivationEvents(projectRoot: string, events: PlaybookAutoActivationEvent[]): void {
  const filePath = resolvePlaybookAutoActivationsPath(projectRoot);
  const existingKeys = new Set<string>();
  if (existsSync(filePath)) {
    readFileSync(filePath, 'utf8').split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new Error(`playbook-auto-activations row ${index + 1} is invalid JSON: ${(err as Error).message}`);
      }
      const validated = validatePlaybookAutoActivationEvent(parsed);
      if (!validated.ok) {
        throw new Error(`playbook-auto-activations row ${index + 1} is malformed: ${validated.error}`);
      }
      existingKeys.add(validated.event.idempotencyKey);
    });
  }

  const nextKeys = new Set<string>();
  for (const event of events) {
    const validated = validatePlaybookAutoActivationEvent(event);
    if (!validated.ok) throw new Error(`appendPlaybookAutoActivationEvent: ${validated.error}`);
    if (existingKeys.has(validated.event.idempotencyKey)) {
      throw new Error(`playbook-auto-activations already has idempotencyKey ${validated.event.idempotencyKey}`);
    }
    if (nextKeys.has(validated.event.idempotencyKey)) {
      throw new Error(`playbook-auto-activations batch repeats idempotencyKey ${validated.event.idempotencyKey}`);
    }
    nextKeys.add(validated.event.idempotencyKey);
  }
}

export function appendPlaybookAutoActivationEvent(projectRoot: string, event: PlaybookAutoActivationEvent): string {
  const validated = validatePlaybookAutoActivationEvent(event);
  if (!validated.ok) throw new Error(`appendPlaybookAutoActivationEvent: ${validated.error}`);
  if (readPlaybookAutoActivationEvents(projectRoot).some((row) => row.idempotencyKey === validated.event.idempotencyKey)) {
    return resolvePlaybookAutoActivationsPath(projectRoot);
  }
  return atomicAppendCanonicalJsonLine(resolvePlaybookAutoActivationsPath(projectRoot), validated.event);
}

const PLAYBOOK_PROMOTION_OBSERVE_SCHEMA_VERSION = 'proofbound.playbook-promotion-observe.v1';
const RELATIVE_OBSERVE_SINCE_RE = /^([1-9][0-9]*)([smhdw])$/i;
const RELATIVE_OBSERVE_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

function toDate(value: Date | string | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date();
}

export function parsePlaybookPromotionObserveSince(
  since?: string,
  nowInput?: Date | string,
): PlaybookPromotionObserveSinceWindow {
  const now = toDate(nowInput);
  const endMs = now.getTime();
  const end = now.toISOString();
  const input = typeof since === 'string' ? since.trim() : '';
  if (!input) return { mode: 'all', end };

  const relative = input.match(RELATIVE_OBSERVE_SINCE_RE);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = RELATIVE_OBSERVE_UNITS_MS[relative[2].toLowerCase()];
    const startMs = endMs - amount * unitMs;
    return { mode: 'relative', input, start: new Date(startMs).toISOString(), end };
  }

  const startMs = Date.parse(input);
  if (Number.isFinite(startMs)) {
    return { mode: 'iso', input, start: new Date(startMs).toISOString(), end };
  }

  throw new Error(`playbook_promotion_observe: since must be an ISO timestamp or relative duration like 14d: ${input}`);
}

function timestampInObserveWindow(timestamp: string, since: PlaybookPromotionObserveSinceWindow): boolean {
  if (!since.start) return true;
  const ts = Date.parse(timestamp);
  const start = Date.parse(since.start);
  return Number.isFinite(ts) && Number.isFinite(start) && ts >= start;
}

function isActionablePromotionRecommendation(action: PlaybookPromotionDecisionAction): action is PlaybookPromotionActionableRecommendation {
  return action === 'recommend_activate'
    || action === 'reject'
    || action === 'archive'
    || action === 'recommend_demote'
    || action === 'mark_non_deducible';
}

function classifyRecommendationHandling(
  row: PlaybookPromotionDecisionRow,
  current: Playbook | undefined,
  nonDeducibleSourceKeys: Set<string>,
): { handlingStatus: 'handled' | 'unhandled'; handledBy?: string; currentPlaybookStatus?: Playbook['status'] } {
  const currentPlaybookStatus = current?.status;
  if (row.action === 'recommend_activate') {
    if (!current) {
      return { handlingStatus: 'unhandled', handledBy: 'playbook_missing' };
    }
    if (current.status === 'active') {
      return { handlingStatus: 'handled', handledBy: 'current_status_active', currentPlaybookStatus: current.status };
    }
    if (current.status !== 'candidate') {
      return { handlingStatus: 'handled', handledBy: 'current_status_changed', currentPlaybookStatus: current.status };
    }
    return { handlingStatus: 'unhandled', handledBy: 'current_status_still_candidate', currentPlaybookStatus: current.status };
  }
  if (row.action === 'recommend_demote') {
    if (!current) {
      return { handlingStatus: 'unhandled', handledBy: 'playbook_missing' };
    }
    if (current.status !== 'active') {
      return { handlingStatus: 'handled', handledBy: 'current_status_changed', currentPlaybookStatus: current.status };
    }
    return { handlingStatus: 'unhandled', handledBy: 'current_status_still_active', currentPlaybookStatus: current.status };
  }
  if (row.action === 'reject') {
    if (!current) {
      return { handlingStatus: 'unhandled', handledBy: 'playbook_missing' };
    }
    if (current.status === 'archived') {
      return { handlingStatus: 'handled', handledBy: 'current_status_archived', currentPlaybookStatus: current.status };
    }
    if (current.status === 'stale') {
      return { handlingStatus: 'handled', handledBy: 'current_status_stale', currentPlaybookStatus: current.status };
    }
    return {
      handlingStatus: 'unhandled',
      handledBy: current.status === 'active'
        ? 'current_status_still_active'
        : current.status === 'candidate'
          ? 'current_status_still_candidate'
          : 'current_status_not_rejected',
      currentPlaybookStatus: current.status,
    };
  }
  if (row.action === 'archive') {
    if (!current) {
      return { handlingStatus: 'unhandled', handledBy: 'playbook_missing' };
    }
    if (current.status === 'archived') {
      return { handlingStatus: 'handled', handledBy: 'current_status_archived', currentPlaybookStatus: current.status };
    }
    return {
      handlingStatus: 'unhandled',
      handledBy: current.status === 'active'
        ? 'current_status_still_active'
        : current.status === 'candidate'
          ? 'current_status_still_candidate'
          : current.status === 'stale'
            ? 'current_status_still_stale'
            : 'current_status_not_archived',
      currentPlaybookStatus: current.status,
    };
  }
  if (row.action === 'mark_non_deducible') {
    const afterKey = row.after.nonDeducibleSourceKey;
    if (afterKey && nonDeducibleSourceKeys.has(afterKey)) {
      return { handlingStatus: 'handled', handledBy: 'non_deducible_after_source_key_present', currentPlaybookStatus };
    }
    if (nonDeducibleSourceKeys.has(row.before.sourceKey)) {
      return { handlingStatus: 'handled', handledBy: 'non_deducible_before_source_key_present', currentPlaybookStatus };
    }
    return { handlingStatus: 'unhandled', handledBy: 'non_deducible_source_missing', currentPlaybookStatus };
  }
  return { handlingStatus: 'unhandled', currentPlaybookStatus };
}

export function buildPlaybookPromotionObserveReport(
  projectRoot: string,
  opts: { since?: string; now?: Date | string } = {},
): PlaybookPromotionObserveReport {
  const since = parsePlaybookPromotionObserveSince(opts.since, opts.now);
  const observedAt = since.end;
  const rawPlaybooks = readPlaybooks(projectRoot);
  const playbookById = new Map<string, Playbook>();
  let malformedPlaybooks = 0;
  for (const raw of rawPlaybooks) {
    const validation = validatePlaybook(raw);
    if (!validation.ok) {
      malformedPlaybooks += 1;
      continue;
    }
    playbookById.set(validation.playbook.id, validation.playbook);
  }

  const candidates = [...playbookById.values()]
    .filter((playbook) => playbook.status === 'candidate')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((playbook) => ({
      playbookId: playbook.id,
      title: playbook.title,
      status: 'candidate' as const,
      playbookDigest: computePlaybookDigest(playbook),
      source: buildPlaybookSourceReference(playbook.lineage),
    }));

  const outcomeRows = readPlaybookOutcomeEventsWithDiagnostics(projectRoot);
  let consumedExposureModeNone = 0;
  let consumedNonCandidateStatus = 0;
  let consumedOutsideSince = 0;
  const consumedRows: PlaybookPromotionObserveReport['candidateConsumed']['rows'] = [];
  for (const event of outcomeRows.events) {
    if (event.playbookStatusAtObservation !== 'candidate') {
      consumedNonCandidateStatus += 1;
      continue;
    }
    if (event.exposureMode === 'none') {
      consumedExposureModeNone += 1;
      continue;
    }
    if (!isStructuredPlaybookOutcomeVerdictSource(event.outcome.verdictSource)) {
      continue;
    }
    if (!timestampInObserveWindow(event.observedAt, since)) {
      consumedOutsideSince += 1;
      continue;
    }
    consumedRows.push({
      eventId: event.eventId,
      observedAt: event.observedAt,
      storyId: event.storyId,
      playbookId: event.playbookId,
      ...(playbookById.get(event.playbookId) ? { currentPlaybookStatus: playbookById.get(event.playbookId)!.status } : {}),
      exposureMode: event.exposureMode,
      consumer: event.consumer,
      verdict: event.outcome.verdict,
      verdictSource: event.outcome.verdictSource,
    });
  }
  consumedRows.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.eventId.localeCompare(b.eventId));
  const consumedCandidateIds = new Set(consumedRows.map((row) => row.playbookId));
  const unconsumedCurrentCandidateIds = candidates
    .map((row) => row.playbookId)
    .filter((playbookId) => !consumedCandidateIds.has(playbookId))
    .sort((a, b) => a.localeCompare(b));

  const decisionRows = readPlaybookPromotionDecisionRows(projectRoot);
  const nonDeducibleSourceKeys = new Set(readNonDeducibleSourcesRegistry(projectRoot).sources.map((source) => source.source.sourceKey));
  let recommendationUnapplied = 0;
  let recommendationNonActionable = 0;
  let recommendationOutsideSince = 0;
  const recommendations: PlaybookPromotionObserveReport['recommendationHandling']['recommendations'] = [];
  for (const row of decisionRows.decisions) {
    if (!row.applied) {
      recommendationUnapplied += 1;
      continue;
    }
    if (!isActionablePromotionRecommendation(row.action)) {
      recommendationNonActionable += 1;
      continue;
    }
    if (!timestampInObserveWindow(row.decidedAt, since)) {
      recommendationOutsideSince += 1;
      continue;
    }
    const handling = classifyRecommendationHandling(row, playbookById.get(row.playbookId), nonDeducibleSourceKeys);
    recommendations.push({
      decisionId: row.decisionId,
      decidedAt: row.decidedAt,
      playbookId: row.playbookId,
      action: row.action,
      aggregateDigest: row.aggregateDigest,
      reasonCodes: row.reasonCodes,
      handlingStatus: handling.handlingStatus,
      ...(handling.handledBy ? { handledBy: handling.handledBy } : {}),
      ...(handling.currentPlaybookStatus ? { currentPlaybookStatus: handling.currentPlaybookStatus } : {}),
    });
  }
  recommendations.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.decisionId.localeCompare(b.decisionId));
  const handledCount = recommendations.filter((row) => row.handlingStatus === 'handled').length;

  return {
    schemaVersion: PLAYBOOK_PROMOTION_OBSERVE_SCHEMA_VERSION,
    observedAt,
    since,
    candidateGenerated: {
      currentCandidates: candidates.length,
      count: candidates.length,
      malformedPlaybooks,
      candidates,
    },
    candidateConsumed: {
      consumedCandidateCount: consumedRows.length,
      count: consumedRows.length,
      uniquePlaybookCount: new Set(consumedRows.map((row) => row.playbookId)).size,
      unconsumedCurrentCandidateIds,
      malformedOutcomeRows: outcomeRows.malformedCount,
      excluded: {
        exposureModeNone: consumedExposureModeNone,
        nonCandidateStatus: consumedNonCandidateStatus,
        outsideSince: consumedOutsideSince,
      },
      rows: consumedRows,
    },
    recommendationHandling: {
      actionableCount: recommendations.length,
      handledCount,
      unhandledCount: recommendations.length - handledCount,
      malformedDecisionRows: decisionRows.malformedCount,
      excluded: {
        unapplied: recommendationUnapplied,
        nonActionableAction: recommendationNonActionable,
        outsideSince: recommendationOutsideSince,
      },
      recommendations,
    },
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function emptyNonDeducibleRegistry(now = new Date().toISOString()): NonDeducibleSourcesRegistry {
  return {
    schemaVersion: NON_DEDUCIBLE_SOURCES_SCHEMA_VERSION,
    updatedAt: now,
    sources: [],
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function validateOverrideEvent(raw: unknown): { ok: true; event: NonDeducibleOverrideEvent } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'override event must be an object' };
  const overrideId = ownString(raw, 'overrideId');
  const acceptedAt = ownString(raw, 'acceptedAt');
  const sourceKey = ownString(raw, 'sourceKey');
  const sourceFindingId = ownString(raw, 'sourceFindingId');
  const reasonDigest = ownString(raw, 'reasonDigest');
  const reasonLength = ownNumber(raw, 'reasonLength');
  if (!overrideId) return { ok: false, error: 'overrideId must be non-empty' };
  const acceptedAtError = validateIsoTimestamp(acceptedAt, 'acceptedAt');
  if (acceptedAtError) return { ok: false, error: acceptedAtError };
  if (!sourceKey) return { ok: false, error: 'override sourceKey must be non-empty' };
  if (!sourceFindingId) return { ok: false, error: 'override sourceFindingId must be non-empty' };
  if (!reasonDigest) return { ok: false, error: 'override reasonDigest must be non-empty' };
  if (reasonLength === null) return { ok: false, error: 'override reasonLength must be non-negative number' };
  const proposalId = optionalOwnString(raw, 'proposalId');
  if (proposalId === '') return { ok: false, error: 'override proposalId must be non-empty when present' };
  return {
    ok: true,
    event: {
      overrideId,
      acceptedAt,
      sourceKey,
      sourceFindingId,
      reasonDigest,
      reasonLength,
      ...(proposalId ? { proposalId } : {}),
    },
  };
}

function validateNonDeducibleRecord(raw: unknown): { ok: true; record: NonDeducibleSourceRecord } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'source record must be an object' };
  if (ownString(raw, 'schemaVersion') !== NON_DEDUCIBLE_SOURCE_ROW_SCHEMA_VERSION) {
    return { ok: false, error: `source record schemaVersion must be ${NON_DEDUCIBLE_SOURCE_ROW_SCHEMA_VERSION}` };
  }
  const source = validateSourceReference(own(raw, 'source'), 'source');
  if (!source.ok) return source;
  const markedAt = ownString(raw, 'markedAt');
  const markedAtError = validateIsoTimestamp(markedAt, 'markedAt');
  if (markedAtError) return { ok: false, error: markedAtError };
  const reasonCodes = ownStringArray(raw, 'reasonCodes');
  if (!reasonCodes || reasonCodes.length === 0) return { ok: false, error: 'reasonCodes must be a non-empty string array' };
  const reason = ownString(raw, 'reason');
  if (!reason) return { ok: false, error: 'reason must be non-empty' };
  const sourceRejectedSiblingCount = ownNumber(raw, 'sourceRejectedSiblingCount');
  if (sourceRejectedSiblingCount === null) return { ok: false, error: 'sourceRejectedSiblingCount must be non-negative' };
  const aggregateDigest = optionalOwnString(raw, 'aggregateDigest');
  if (aggregateDigest === '') return { ok: false, error: 'aggregateDigest must be non-empty when present' };
  const latestDecisionId = optionalOwnString(raw, 'latestDecisionId');
  if (latestDecisionId === '') return { ok: false, error: 'latestDecisionId must be non-empty when present' };
  const overridesRaw = own(raw, 'overrideEvents');
  if (!Array.isArray(overridesRaw)) return { ok: false, error: 'overrideEvents must be an array' };
  const overrideEvents: NonDeducibleOverrideEvent[] = [];
  for (const entry of overridesRaw) {
    const validated = validateOverrideEvent(entry);
    if (!validated.ok) return validated;
    overrideEvents.push(validated.event);
  }
  if (ownString(raw, 'authority') !== 'non_authoritative') return { ok: false, error: 'source authority must be non_authoritative' };
  if (own(raw, 'gateEvidence') !== false) return { ok: false, error: 'source gateEvidence must be false' };
  return {
    ok: true,
    record: {
      schemaVersion: NON_DEDUCIBLE_SOURCE_ROW_SCHEMA_VERSION,
      source: source.source,
      markedAt,
      reasonCodes,
      reason,
      sourceRejectedSiblingCount,
      ...(aggregateDigest ? { aggregateDigest } : {}),
      ...(latestDecisionId ? { latestDecisionId } : {}),
      overrideEvents,
      authority: 'non_authoritative',
      gateEvidence: false,
    },
  };
}

export function validateNonDeducibleSourcesRegistry(raw: unknown): { ok: true; registry: NonDeducibleSourcesRegistry } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'non-deducible registry must be an object' };
  if (ownString(raw, 'schemaVersion') !== NON_DEDUCIBLE_SOURCES_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion must be ${NON_DEDUCIBLE_SOURCES_SCHEMA_VERSION}` };
  }
  const updatedAt = ownString(raw, 'updatedAt');
  const updatedAtError = validateIsoTimestamp(updatedAt, 'updatedAt');
  if (updatedAtError) return { ok: false, error: updatedAtError };
  const sourcesRaw = own(raw, 'sources');
  if (!Array.isArray(sourcesRaw)) return { ok: false, error: 'sources must be an array' };
  const sources: NonDeducibleSourceRecord[] = [];
  for (const source of sourcesRaw) {
    const validated = validateNonDeducibleRecord(source);
    if (!validated.ok) return validated;
    sources.push(validated.record);
  }
  if (ownString(raw, 'authority') !== 'non_authoritative') return { ok: false, error: 'authority must be non_authoritative' };
  if (own(raw, 'gateEvidence') !== false) return { ok: false, error: 'gateEvidence must be false' };
  return {
    ok: true,
    registry: {
      schemaVersion: NON_DEDUCIBLE_SOURCES_SCHEMA_VERSION,
      updatedAt,
      sources,
      authority: 'non_authoritative',
      gateEvidence: false,
    },
  };
}

export function readNonDeducibleSourcesRegistry(projectRoot: string): NonDeducibleSourcesRegistry {
  const filePath = resolveNonDeducibleSourcesPath(projectRoot);
  if (!existsSync(filePath)) return emptyNonDeducibleRegistry();
  try {
    const validated = validateNonDeducibleSourcesRegistry(JSON.parse(readFileSync(filePath, 'utf8')));
    return validated.ok ? validated.registry : emptyNonDeducibleRegistry();
  } catch {
    return emptyNonDeducibleRegistry();
  }
}

export function writeNonDeducibleSourcesRegistry(projectRoot: string, registry: NonDeducibleSourcesRegistry): string {
  const validated = validateNonDeducibleSourcesRegistry(registry);
  if (!validated.ok) throw new Error(`writeNonDeducibleSourcesRegistry: ${validated.error}`);
  return atomicWriteJson(resolveNonDeducibleSourcesPath(projectRoot), validated.registry);
}

export function findNonDeducibleSource(projectRoot: string, sourceKey: string): NonDeducibleSourceRecord | undefined {
  return readNonDeducibleSourcesRegistry(projectRoot).sources.find((source) => source.source.sourceKey === sourceKey);
}

export function markNonDeducibleSource(
  projectRoot: string,
  input: {
    source: PlaybookSourceReference;
    reasonCodes: string[];
    reason: string;
    sourceRejectedSiblingCount: number;
    aggregateDigest?: string;
    latestDecisionId?: string;
    markedAt?: string;
  },
): NonDeducibleSourceRecord {
  const now = input.markedAt ?? new Date().toISOString();
  const registry = readNonDeducibleSourcesRegistry(projectRoot);
  const existing = registry.sources.find((source) => source.source.sourceKey === input.source.sourceKey);
  if (existing) {
    existing.reasonCodes = stringSet([...existing.reasonCodes, ...input.reasonCodes]);
    existing.reason = input.reason || existing.reason;
    existing.sourceRejectedSiblingCount = Math.max(existing.sourceRejectedSiblingCount, input.sourceRejectedSiblingCount);
    if (input.aggregateDigest) existing.aggregateDigest = input.aggregateDigest;
    if (input.latestDecisionId) existing.latestDecisionId = input.latestDecisionId;
    registry.updatedAt = now;
    writeNonDeducibleSourcesRegistry(projectRoot, registry);
    return existing;
  }
  const record: NonDeducibleSourceRecord = {
    schemaVersion: NON_DEDUCIBLE_SOURCE_ROW_SCHEMA_VERSION,
    source: input.source,
    markedAt: now,
    reasonCodes: stringSet(input.reasonCodes),
    reason: input.reason,
    sourceRejectedSiblingCount: input.sourceRejectedSiblingCount,
    ...(input.aggregateDigest ? { aggregateDigest: input.aggregateDigest } : {}),
    ...(input.latestDecisionId ? { latestDecisionId: input.latestDecisionId } : {}),
    overrideEvents: [],
    authority: 'non_authoritative',
    gateEvidence: false,
  };
  registry.sources.push(record);
  registry.sources.sort((a, b) => a.source.sourceKey.localeCompare(b.source.sourceKey));
  registry.updatedAt = now;
  writeNonDeducibleSourcesRegistry(projectRoot, registry);
  return record;
}

export function recordNonDeducibleOverride(
  projectRoot: string,
  sourceKey: string,
  event: NonDeducibleOverrideEvent,
): NonDeducibleSourceRecord {
  const registry = readNonDeducibleSourcesRegistry(projectRoot);
  const record = registry.sources.find((source) => source.source.sourceKey === sourceKey);
  if (!record) throw new Error(`recordNonDeducibleOverride: source is not marked non_deducible: ${sourceKey}`);
  const validated = validateOverrideEvent(event);
  if (!validated.ok) throw new Error(`recordNonDeducibleOverride: ${validated.error}`);
  if (!record.overrideEvents.some((existing) => existing.overrideId === event.overrideId)) {
    record.overrideEvents.push(validated.event);
    registry.updatedAt = event.acceptedAt;
    writeNonDeducibleSourcesRegistry(projectRoot, registry);
  }
  return record;
}

export function validatePlaybookPromotionHealthEvent(raw: unknown): { ok: true; event: PlaybookPromotionHealthEvent } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'health event must be an object' };
  if (ownString(raw, 'schemaVersion') !== PLAYBOOK_PROMOTION_HEALTH_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion must be ${PLAYBOOK_PROMOTION_HEALTH_SCHEMA_VERSION}` };
  }
  const eventId = ownString(raw, 'eventId');
  const idempotencyKey = ownString(raw, 'idempotencyKey');
  const observedAt = ownString(raw, 'observedAt');
  const kind = ownString(raw, 'kind');
  const message = ownString(raw, 'message');
  if (!eventId) return { ok: false, error: 'eventId must be non-empty' };
  if (!idempotencyKey) return { ok: false, error: 'idempotencyKey must be non-empty' };
  const observedAtError = validateIsoTimestamp(observedAt, 'observedAt');
  if (observedAtError) return { ok: false, error: observedAtError };
  if (!PLAYBOOK_PROMOTION_HEALTH_KINDS.has(kind)) return { ok: false, error: 'kind must be a valid promotion health kind' };
  const settlementStatus = optionalOwnString(raw, 'settlementStatus');
  if (settlementStatus !== undefined && !PLAYBOOK_PROMOTION_SETTLEMENT_STATUSES.has(settlementStatus)) {
    return { ok: false, error: 'settlementStatus must be disabled|recorded|failed when present' };
  }
  const storyId = optionalOwnString(raw, 'storyId');
  if (storyId === '') return { ok: false, error: 'storyId must be non-empty when present' };
  if (!message) return { ok: false, error: 'message must be non-empty' };
  if (ownString(raw, 'authority') !== 'non_authoritative') return { ok: false, error: 'authority must be non_authoritative' };
  if (own(raw, 'gateEvidence') !== false) return { ok: false, error: 'gateEvidence must be false' };
  return {
    ok: true,
    event: {
      schemaVersion: PLAYBOOK_PROMOTION_HEALTH_SCHEMA_VERSION,
      eventId,
      idempotencyKey,
      observedAt,
      kind: kind as PlaybookPromotionHealthEvent['kind'],
      ...(settlementStatus ? { settlementStatus: settlementStatus as PlaybookPromotionHealthEvent['settlementStatus'] } : {}),
      ...(storyId ? { storyId } : {}),
      message,
      authority: 'non_authoritative',
      gateEvidence: false,
    },
  };
}

export function readPlaybookPromotionHealthEvents(projectRoot: string): {
  events: PlaybookPromotionHealthEvent[];
  malformedCount: number;
} {
  const filePath = resolvePlaybookPromotionHealthPath(projectRoot);
  if (!existsSync(filePath)) return { events: [], malformedCount: 0 };
  const events: PlaybookPromotionHealthEvent[] = [];
  let malformedCount = 0;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const validated = validatePlaybookPromotionHealthEvent(JSON.parse(line));
      if (validated.ok) events.push(validated.event);
      else malformedCount += 1;
    } catch {
      malformedCount += 1;
    }
  }
  return { events, malformedCount };
}

export function appendPlaybookPromotionHealthEvent(projectRoot: string, event: PlaybookPromotionHealthEvent): {
  path: string;
  alreadyApplied: boolean;
} {
  const validated = validatePlaybookPromotionHealthEvent(event);
  if (!validated.ok) throw new Error(`appendPlaybookPromotionHealthEvent: ${validated.error}`);
  const prior = readPlaybookPromotionHealthEvents(projectRoot).events;
  if (prior.some((row) => row.idempotencyKey === event.idempotencyKey)) {
    return { path: resolvePlaybookPromotionHealthPath(projectRoot), alreadyApplied: true };
  }
  return {
    path: atomicAppendCanonicalJsonLine(resolvePlaybookPromotionHealthPath(projectRoot), validated.event),
    alreadyApplied: false,
  };
}

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export function collectPlaybookPromotionLearningHealth(
  projectRoot: string,
  partialConfig: Partial<PlaybookPromotionConfig> = {},
): {
  warnings: string[];
  malformedOutcomeRows: number;
  malformedDecisionRows: number;
  malformedHealthRows: number;
  retentionWarnings: string[];
} {
  const config = promotionConfig(partialConfig);
  const outcomes = readPlaybookOutcomeEventsWithDiagnostics(projectRoot);
  const decisions = readPlaybookPromotionDecisionRows(projectRoot);
  const health = readPlaybookPromotionHealthEvents(projectRoot);
  const retentionWarnings: string[] = [];
  for (const [label, path] of [
    ['playbook-outcomes', resolvePlaybookOutcomesPath(projectRoot)],
    ['playbook-promotion-decisions', resolvePlaybookPromotionDecisionsPath(projectRoot)],
    ['playbook-promotion-health', resolvePlaybookPromotionHealthPath(projectRoot)],
  ] as const) {
    const size = fileSize(path);
    if (size > config.retentionMaxBytes) {
      retentionWarnings.push(`${label} exceeds retentionMaxBytes (${size} > ${config.retentionMaxBytes})`);
    }
  }
  const warnings = [
    outcomes.malformedCount > 0 ? `malformed outcome rows skipped: ${outcomes.malformedCount}` : '',
    decisions.malformedCount > 0 ? `malformed decision rows skipped: ${decisions.malformedCount}` : '',
    health.malformedCount > 0 ? `malformed health rows skipped: ${health.malformedCount}` : '',
    ...retentionWarnings,
  ].filter(Boolean);
  return {
    warnings,
    malformedOutcomeRows: outcomes.malformedCount,
    malformedDecisionRows: decisions.malformedCount,
    malformedHealthRows: health.malformedCount,
    retentionWarnings,
  };
}
