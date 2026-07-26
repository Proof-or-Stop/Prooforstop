/**
 * B-2296 (evidence-integrity §5 follow-on, Phase 1 of 2) — frozen-claim drift Fn foundation.
 *
 * PURE Fn module: no I/O, no fs, no git, no side effects. Just deterministic,
 * byte-level claim normalization + a claim digest. It intentionally performs NO
 * semantic interpretation of the claim — meaning-preserving-vs-changing judgment
 * is the primary false-positive engine and belongs only to Phase-2 human
 * re-attestation (see background.md / decision.json principle 2).
 *
 * The drift-detection logic (detectDrift) arrives in CHK-002; the read-only CLI
 * handler in CHK-003. This module is the shared foundation both build on.
 */

import { digestText } from './digest.js';

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
