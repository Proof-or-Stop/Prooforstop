#!/usr/bin/env node
/**
 * Lab sealed-scan-reason: in run 6 (2026-09-29) a complete test-coverage review
 * was discarded because the reviewer paraphrased the long full-scan reason the
 * controller had sealed into the run spec. The value is controller-owned and the
 * reviewer copying it proves nothing, so the sealed proposal must carry the
 * sealed reason instead of refusing the review.
 */
import assert from 'node:assert/strict';
import { withSealedFullScanReason } from '../core/managed-host-run.js';

const sealed = 'Managed review was blocked on a missing candidate-spec route; deterministic local routing covers the enforced scope contract.';
const manifest = { filesReadFully: ['a.go'], filesTriagedByName: [], scanEscalationReason: 'Blocked on a missing route, so a full scan was used.', candidateSpecSetDigest: 'a'.repeat(64), corpusDigest: 'b'.repeat(64) };
let normalized: typeof manifest;
try {
  normalized = withSealedFullScanReason(manifest, sealed);
} catch (error) {
  assert.fail(`paraphrased full-scan reason discarded the review: ${(error as Error).message}`);
}
assert.equal(normalized.scanEscalationReason, sealed, 'the sealed proposal carries the controller-sealed reason');
assert.deepEqual({ ...normalized, scanEscalationReason: null }, { ...manifest, scanEscalationReason: null }, 'nothing else changes');
assert.equal(withSealedFullScanReason(manifest, undefined), manifest, 'no full-scan binding leaves the manifest untouched');
console.log('sealed-scan-reason-smoke: PASS');
