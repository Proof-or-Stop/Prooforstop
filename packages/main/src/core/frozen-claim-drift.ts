/**
 * B-2296 (evidence-integrity §5 follow-on, Phase 1 of 2) — frozen-claim drift Fn foundation.
 *
 * PURE Fn module: no I/O, no fs, no git, no side effects. Just deterministic,
 * byte-level claim normalization + a claim digest. It intentionally performs NO
 * semantic interpretation of the claim — meaning-preserving-vs-changing judgment
 * is the primary false-positive engine and belongs only to Phase-2 human
 * re-attestation (see background.md / decision.json principle 2).
 *
 * CHK-002 adds the pure drift-detection Fn (detectDrift); the read-only CLI
 * handler arrives in CHK-003. This module is the shared foundation both build on.
 */

import { digestText } from './digest.js';
import type { FrozenClaimSnapshot } from './types.js';

/**
 * Deterministically normalize a claim string for digesting:
 *   - trim leading/trailing whitespace
 *   - collapse every run of internal whitespace (spaces, tabs, newlines) to a
 *     single ASCII space
 *
 * Purely mechanical. `normalizeClaim('  a\t\n b  ') === 'a b'`. An empty or
 * whitespace-only input normalizes to `''`. No semantic interpretation.
 */
export function normalizeClaim(s: string): string {
  // `\s+` matches any run of whitespace (spaces/tabs/newlines/CR); replacing with
  // a single space collapses internal runs AND leading/trailing runs, then trim()
  // strips the single leading/trailing space those edge runs leave behind.
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * sha256 hex digest over the NORMALIZED claim. Two claims that differ only in
 * whitespace share a digest; any non-whitespace difference changes it. Reuses the
 * leaf `digestText` (imports only node:crypto) — no new dependency.
 */
export function claimDigest(s: string): string {
  return digestText(normalizeClaim(s));
}

/**
 * B-2296 CHK-002: the bidirectional drift verdict for one frozen claim.
 *
 * - `driftKind` reports WHAT moved: `claim` (the normalized claim digest changed),
 *   `material` (the story-owned storyFilesHash moved), `both`, or `none`.
 * - `classification` distinguishes a snapshot-bound claim (`bound`) from a
 *   pre-feature claim with no snapshot (`legacy-unbound`, never an error — grandfathered).
 */
export interface FrozenClaimDriftVerdict {
  driftKind: 'claim' | 'material' | 'both' | 'none';
  classification: 'bound' | 'legacy-unbound';
  claimDrifted: boolean;
  materialDrifted: boolean;
}

/**
 * B-2296 CHK-002: PURE Fn — no I/O, no git, no fs. It takes PRE-COMPUTED inputs
 * (the snapshot pinned at attestation time + the freshly measured current digest
 * and storyFilesHash) and returns a bidirectional drift verdict.
 *
 * Bidirectional binding (decision B): drift in EITHER the normalized claim text OR
 * the story-owned material voids the attestation.
 *   - `claimDrifted` = snapshot.normalizedClaimDigest !== current.currentNormalizedDigest
 *   - `materialDrifted` = snapshot.storyFilesHash !== current.currentStoryFilesHash
 *
 * The material comparison is a plain storyFilesHash string compare — that IS the
 * rename-aware, story-diff-scoped signal: storyFilesHash already encodes the content
 * of the story-owned files (unrelated main-merge / whole-tree churn is excluded by
 * construction), so an unrelated file change never moves it and never fires drift.
 *
 * A missing snapshot (`!snapshot`) is `legacy-unbound` — a grandfathered claim with
 * no attestation to drift against, NEVER an error.
 */
export function detectDrift(
  snapshot: FrozenClaimSnapshot | undefined,
  current: { currentNormalizedDigest: string; currentStoryFilesHash: string },
): FrozenClaimDriftVerdict {
  if (!snapshot) {
    return { classification: 'legacy-unbound', driftKind: 'none', claimDrifted: false, materialDrifted: false };
  }
  const claimDrifted = snapshot.normalizedClaimDigest !== current.currentNormalizedDigest;
  const materialDrifted = snapshot.storyFilesHash !== current.currentStoryFilesHash;
  const driftKind: FrozenClaimDriftVerdict['driftKind'] =
    claimDrifted && materialDrifted ? 'both'
      : claimDrifted ? 'claim'
        : materialDrifted ? 'material'
          : 'none';
  return { driftKind, classification: 'bound', claimDrifted, materialDrifted };
}
