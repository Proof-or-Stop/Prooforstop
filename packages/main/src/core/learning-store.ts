/**
 * B-000c CHK-001: Experience Layer Phase 1a — the minimal learning-store.
 *
 * The ONLY code that touches `.lattice/learning/`. It ensures the directory,
 * resolves paths, and reads/writes the finding-signals cache with an atomic
 * write (temp file + rename) and a stable/canonical key order so re-writing
 * identical data is byte-identical (idempotent on disk; never a spurious diff).
 *
 * Isolation bar: imports ONLY `node:` builtins and the leaf
 * `./experience-layer-types.js`. NO outward imports (no `../`, no `../../`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FindingSignalsCache } from './experience-layer-types.js';

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

/** Absolute learning directory under a project root. */
export function resolveLearningDir(projectRoot: string): string {
  return join(projectRoot, LEARNING_DIR);
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
