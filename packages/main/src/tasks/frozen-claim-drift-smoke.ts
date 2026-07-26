#!/usr/bin/env node
/**
 * B-2296 (evidence-integrity §5 follow-on, Phase 1 of 2) — deterministic, OFFLINE
 * smoke for the frozen-claim drift foundation. No git, no network, no fs, no
 * `claude -p`: pure-Fn assertions over normalizeClaim / claimDigest.
 *
 * CHK-001 scope: normalization determinism + the two digest invariants
 * (whitespace-only edit → same digest; one non-whitespace char → different digest)
 * + empty/whitespace-only safety.
 *
 * Prints `frozen-claim-drift-smoke: PASS` on success; throws (non-zero exit) on any
 * failed assertion.
 */

import { strict as assert } from 'node:assert';
import { normalizeClaim, claimDigest, detectDrift } from '../core/frozen-claim-drift.js';
import type { FrozenClaimSnapshot } from '../core/types.js';

// ── 1. normalizeClaim collapses arbitrary whitespace deterministically. ─────────
{
  assert.equal(normalizeClaim('  a\t\n b  '), 'a b', 'trim + collapse mixed whitespace runs to a single space');
  assert.equal(normalizeClaim('a   b'), 'a b', 'internal space run collapses');
  assert.equal(normalizeClaim('a\t\t\tb'), 'a b', 'internal tab run collapses');
  assert.equal(normalizeClaim('a\n\nb'), 'a b', 'internal newline run collapses');
  assert.equal(normalizeClaim('a \t\n\r b'), 'a b', 'mixed space/tab/newline/CR run collapses to one space');
  assert.equal(normalizeClaim('\n  leading'), 'leading', 'leading whitespace stripped');
  assert.equal(normalizeClaim('trailing \t\n'), 'trailing', 'trailing whitespace stripped');
  // Determinism: same input → same output, repeatedly.
  const messy = '  the\tfile\n\nwas   created  ';
  assert.equal(normalizeClaim(messy), normalizeClaim(messy), 'deterministic: identical output on repeat');
  assert.equal(normalizeClaim(normalizeClaim(messy)), normalizeClaim(messy), 'idempotent: normalizing an already-normal string is a no-op');
  console.log('✓ normalizeClaim collapses arbitrary whitespace deterministically');
}

// ── 2. Two strings differing ONLY in whitespace → identical claimDigest. ─────────
{
  const a = 'the file was created';
  const b = '  the\tfile\n was    created  ';
  assert.equal(normalizeClaim(a), normalizeClaim(b), 'whitespace-only variants normalize identically');
  assert.equal(claimDigest(a), claimDigest(b), 'whitespace-only variants share a digest (false-positive guard)');
  assert.match(claimDigest(a), /^[0-9a-f]{64}$/, 'claimDigest is sha256 hex');
  console.log('✓ whitespace-only difference → identical claimDigest');
}

// ── 3. Two strings differing by ONE non-whitespace char → different claimDigest. ─
{
  const a = 'the file was created';
  const b = 'the file was crested'; // one letter changed (a → e)
  assert.notEqual(normalizeClaim(a), normalizeClaim(b), 'a real char change survives normalization');
  assert.notEqual(claimDigest(a), claimDigest(b), 'a one-char non-whitespace edit changes the digest');
  console.log('✓ one non-whitespace char difference → different claimDigest');
}

// ── 4. Empty / whitespace-only input → normalizes to '' and digests without throwing. ─
{
  assert.equal(normalizeClaim(''), '', 'empty string normalizes to empty');
  assert.equal(normalizeClaim('   \t\n  '), '', 'whitespace-only string normalizes to empty');
  // Digest must be computable (no throw) and the empty and whitespace-only forms agree.
  const emptyDigest = claimDigest('');
  const wsDigest = claimDigest('   \t\n  ');
  assert.match(emptyDigest, /^[0-9a-f]{64}$/, 'empty-string digest is sha256 hex');
  assert.equal(emptyDigest, wsDigest, 'empty and whitespace-only inputs share a digest');
  console.log('✓ empty / whitespace-only string normalizes to "" and digests without throwing');
}

// ── CHK-002: detectDrift is a PURE, bidirectional drift verdict. ────────────────
// Deterministic + offline: construct the snapshot + current inputs directly (no real
// git). storyFilesHash strings are opaque here — a plain string compare IS the
// story-diff-scoped, rename-aware material signal.
{
  const CLAIM = 'the file hello.txt was created';
  const SFH_A = 'a'.repeat(64); // story-owned material hash at attestation time
  const SFH_B = 'b'.repeat(64); // story-owned material moved (a story-owned file changed)
  const baseSnapshot: FrozenClaimSnapshot = {
    normalizedClaimDigest: claimDigest(CLAIM),
    storyFilesHash: SFH_A,
    headHash: 'deadbeef'.repeat(5),
    attestedAt: '2026-07-26T00:00:00.000Z',
    materialHash: 'c'.repeat(64),
  };

  // 5a. Material drift: same claim digest, DIFFERENT storyFilesHash → 'material'.
  {
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(CLAIM), currentStoryFilesHash: SFH_B });
    assert.equal(v.driftKind, 'material', 'story-owned material moved → material drift');
    assert.equal(v.classification, 'bound', 'a snapshot-bound claim is classified bound');
    assert.equal(v.materialDrifted, true, 'materialDrifted flag set');
    assert.equal(v.claimDrifted, false, 'claim text unchanged → claimDrifted false');
    console.log('✓ material drift (same digest, different storyFilesHash) → driftKind=material');
  }

  // 5b. Claim edit: DIFFERENT claim digest, same storyFilesHash → 'claim'.
  {
    const edited = 'the file hello.txt was DELETED'; // a real, non-whitespace text edit
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(edited), currentStoryFilesHash: SFH_A });
    assert.equal(v.driftKind, 'claim', 'userSees text edited → claim drift (bidirectional binding)');
    assert.equal(v.classification, 'bound', 'still bound');
    assert.equal(v.claimDrifted, true, 'claimDrifted flag set');
    assert.equal(v.materialDrifted, false, 'material unchanged → materialDrifted false');
    console.log('✓ claim edit (different digest, same storyFilesHash) → driftKind=claim');
  }

  // 5c. Both changed → 'both'.
  {
    const edited = 'a completely different promise';
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(edited), currentStoryFilesHash: SFH_B });
    assert.equal(v.driftKind, 'both', 'claim AND material moved → both');
    assert.equal(v.claimDrifted, true, 'claimDrifted set');
    assert.equal(v.materialDrifted, true, 'materialDrifted set');
    console.log('✓ both claim + material changed → driftKind=both');
  }

  // 5d. Unchanged → 'none'. This is the "unrelated change → NO drift" guard at the pure
  // level: an unrelated (non-story-owned) file does not move storyFilesHash, so the
  // current storyFilesHash equals the snapshot's and no drift fires.
  {
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(CLAIM), currentStoryFilesHash: SFH_A });
    assert.equal(v.driftKind, 'none', 'identical digest + identical storyFilesHash → no drift');
    assert.equal(v.classification, 'bound', 'still bound');
    assert.equal(v.claimDrifted, false, 'no claim drift');
    assert.equal(v.materialDrifted, false, 'no material drift (unrelated churn excluded by construction)');
    console.log('✓ unchanged (same digest, same storyFilesHash) → driftKind=none (unrelated change → NO drift)');
  }

  // 5e. Undefined snapshot → legacy-unbound (grandfathered, never an error).
  {
    const v = detectDrift(undefined, { currentNormalizedDigest: claimDigest(CLAIM), currentStoryFilesHash: SFH_A });
    assert.equal(v.classification, 'legacy-unbound', 'a userSees with no snapshot is legacy-unbound');
    assert.equal(v.driftKind, 'none', 'legacy-unbound never reports drift');
    assert.equal(v.claimDrifted, false, 'no claim drift on legacy-unbound');
    assert.equal(v.materialDrifted, false, 'no material drift on legacy-unbound');
    console.log('✓ undefined snapshot → classification=legacy-unbound');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER for CHK-003 / CHK-004 to extend:
//   - CHK-003 CLI-level case: frozen_claim_drift_check prints the structured advisory.
//   - CHK-004 assert the advisory is NON-blocking (changes no gate verdict) + add the
//     whitespace-only userSees edit → NO drift false-positive guard case.
// Do NOT delete this marker; append the new blocks above the final PASS line.
// ─────────────────────────────────────────────────────────────────────────────

console.log('frozen-claim-drift-smoke: PASS');
