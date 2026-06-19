/**
 * parallel-decomposition-overlap — Story 1 (B-4033) of the parallel-decomposition gate.
 *
 * Implements the conservative, two-tier static glob-overlap engine (spec
 * docs/parallel-decomposition-spec.md §4.2): tier-1 literal-path intersection
 * (zero false positives) + tier-2 shared-directory-prefix heuristic (may over-flag,
 * never under-flags within the prefix), plus a NARROW/BROAD classifier and a
 * write-set grammar validator. There is no minimatch in the project; this is the
 * hand-rolled engine the gate verdict (Story 2) calls.
 *
 * Pure functions, no I/O. Types are imported from the frozen Story-0 contract.
 */

import type { GlobOverlapResult } from './parallel-decomposition.js';
import type { ScopeContractData } from './types.js';

/** Supported write-set grammar entry kinds (§4.2): literal | dir/* | dir/**. */
type EntryKind = 'literal' | 'children' | 'subtree';

interface ParsedEntry {
  raw: string;
  kind: EntryKind;
  /** Directory part for wildcard kinds; the full path for a literal. */
  dir: string;
}

/**
 * Normalize a path entry to a canonical form so semantically-equal paths compare equal.
 * Splits on `/` and drops every empty segment (from `//`, leading/trailing `/`) and every
 * same-directory `.` segment (including repeated/leading `./`), then rejoins. So
 * `src/./a.ts`, `src//a.ts` → `src/a.ts`; `./src/**`, `././src/**` → `src/**`; and a
 * disguised root wildcard like `././*` collapses to the bare `*` the grammar validator
 * then rejects — the overlap/broadness checks can never miss a redundant-but-equal path.
 */
function normalizeEntry(entry: string): string {
  return entry
    .trim()
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

/**
 * Validate a write-set against the supported grammar (§4.2). The engine only
 * understands literal | `dir/*` | `dir/**`; a mid-path double-star segment and a
 * bare top-level `*` are NOT supported and must be rejected at scope_contract_set time
 * so `pathMatchesPattern` never mis-handles them.
 */
export function validateWriteSetGrammar(entries: string[]): {
  ok: boolean;
  invalid: Array<{ entry: string; reason: string }>;
} {
  const invalid: Array<{ entry: string; reason: string }> = [];
  for (const raw of entries) {
    const e = normalizeEntry(raw);
    if (e === '' ) {
      invalid.push({ entry: raw, reason: 'empty entry' });
      continue;
    }
    if (e === '*' || e === '**') {
      invalid.push({ entry: raw, reason: 'bare top-level wildcard is not supported' });
      continue;
    }
    if (e.split('/').includes('..')) {
      invalid.push({ entry: raw, reason: 'parent-directory ".." segments are not allowed' });
      continue;
    }
    const starCount = (e.match(/\*/g) ?? []).length;
    if (starCount === 0) continue; // literal — always valid
    if (e.endsWith('/**')) {
      const dir = e.slice(0, -3);
      if (dir === '' || dir.includes('*')) {
        invalid.push({ entry: raw, reason: 'a `/**` entry needs a real directory prefix (e.g. `dir/**`)' });
      }
      continue;
    }
    if (e.endsWith('/*')) {
      const dir = e.slice(0, -2);
      if (dir === '' || dir.includes('*')) {
        invalid.push({ entry: raw, reason: 'a `/*` entry needs a real directory prefix (e.g. `dir/*`)' });
      }
      continue;
    }
    // Anything else with a `*` (mid-path **, *.ext suffix, etc.) is unsupported.
    invalid.push({
      entry: raw,
      reason: 'unsupported pattern: only a literal path, `dir/*`, or `dir/**` are allowed',
    });
  }
  return { ok: invalid.length === 0, invalid };
}

function parseEntry(raw: string): ParsedEntry {
  const e = normalizeEntry(raw);
  if (e.endsWith('/**')) return { raw, kind: 'subtree', dir: e.slice(0, -3) };
  if (e.endsWith('/*')) return { raw, kind: 'children', dir: e.slice(0, -2) };
  return { raw, kind: 'literal', dir: e };
}

/** True when `child` equals `parent` or is nested under `parent/`. */
function isUnderOrEqual(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + '/');
}

/**
 * Whether two parsed entries can both write the same path.
 * - literal vs literal → tier-1 exact equality (zero false positives).
 * - any wildcard involved → tier-2 shared-directory-prefix (§4.2): flag when the two
 *   entries' regions nest either way. The region is `e.dir`, which for a literal is its
 *   FULL path (so single-segment root literals participate: `docs` vs `docs/*` overlaps)
 *   and for a wildcard is its directory. Deliberately conservative — MAY over-flag (e.g.
 *   `src/*` vs a deep literal) but NEVER under-flags a real prefix collision
 *   (`src/*` vs `src/csv/*`, `src/csv/*` vs `src/csv/impl/parser.ts`, `docs` vs `docs/*`).
 *   `README.md` vs `README/*` correctly stays disjoint (no shared directory prefix). The
 *   gate (§4.3) hard-blocks only on tier-1 literal pairs; tier-2 flags are advisory.
 */
function entriesOverlap(x: ParsedEntry, y: ParsedEntry): boolean {
  if (x.kind === 'literal' && y.kind === 'literal') return x.dir === y.dir;
  return isUnderOrEqual(x.dir, y.dir) || isUnderOrEqual(y.dir, x.dir);
}

/**
 * Classify a single entry's breadth (§4.2). BROAD = a `dir/**` whose directory is at or
 * near the repo/package root (fewer than two path segments), which makes independence
 * unprovable; NARROW = a literal or a wildcard rooted below the package root.
 */
export function classifyBroadness(entry: string): 'narrow' | 'broad' {
  const parsed = parseEntry(entry);
  if (parsed.kind === 'literal') return 'narrow';
  const segments = parsed.dir.split('/').filter(Boolean);
  // An empty / root-level wildcard directory is effectively repo-wide → always broad.
  if (segments.length === 0) return 'broad';
  // A subtree (`dir/**`) at/near the root is broad; `dir/*` (direct children only) is
  // bounded, so it stays narrow even near the root.
  if (parsed.kind === 'subtree' && segments.length < 2) return 'broad';
  return 'narrow';
}

function hasBroad(entries: string[]): boolean {
  return entries.some((e) => classifyBroadness(e) === 'broad');
}

/**
 * Compute the write-set of a scope contract: the union of paths the story may create or
 * modify (`allowedModify` ∪ `allowedCreate`). `allowedTest` is a broader "allowed to
 * touch" permission, not a declared write target, so it is intentionally excluded.
 * Deduped, order-stable.
 */
export function computeWriteSet(contract: ScopeContractData): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [
    ...(contract.allowedModify ?? []),
    ...(contract.allowedCreate ?? []),
  ]) {
    const n = normalizeEntry(e);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Static, tiered glob overlap between two write-sets (§4.2). Returns the colliding
 * entry pairs and which operand carried a BROAD glob (for §4.3 block messages).
 * Conservative: it may over-flag via the tier-2 directory-prefix heuristic, but never
 * under-flags a literal-path collision.
 */
export function globsOverlap(a: string[], b: string[]): GlobOverlapResult {
  const pa = a.map(parseEntry);
  const pb = b.map(parseEntry);
  const pairs: Array<[string, string]> = [];
  for (const x of pa) {
    for (const y of pb) {
      if (entriesOverlap(x, y)) pairs.push([x.raw, y.raw]);
    }
  }
  const aBroad = hasBroad(a);
  const bBroad = hasBroad(b);
  const broadSide: GlobOverlapResult['broadSide'] =
    aBroad && bBroad ? 'both' : aBroad ? 'a' : bBroad ? 'b' : null;
  return { overlap: pairs.length > 0, pairs, broadSide };
}
